#!/usr/bin/env python3
"""
glot - CLI tool for translating .po files using any OpenAI-compatible backend.

Author: Nilambar Sharma
Repo:   https://github.com/ernilambar/glot-cli
"""

import argparse
import csv
import os
import re
import shutil
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import polib

# ---------------------------------------------------------------------------
# Configuration (override via environment variables)
# ---------------------------------------------------------------------------

GLOT_ENDPOINT_URL = os.environ.get("GLOT_ENDPOINT_URL")
GLOT_MODEL_ID     = os.environ.get("GLOT_MODEL_ID")
GLOT_API_KEY      = os.environ.get("GLOT_API_KEY", "")

MAX_STRINGS_PER_RUN  = int(os.environ.get("GLOT_MAX_STRINGS", "200"))
GLOT_BATCH_SIZE      = int(os.environ.get("GLOT_BATCH_SIZE", "10"))
GLOT_CONCURRENCY     = int(os.environ.get("GLOT_CONCURRENCY", "1"))
_timeout_env         = os.environ.get("GLOT_REQUEST_TIMEOUT")
GLOT_REQUEST_TIMEOUT = int(_timeout_env) if _timeout_env else None  # None = wait forever

_default_data_dir = os.path.join(os.path.expanduser("~"), ".config", "glot-cli")
GLOT_DATA_DIR = os.environ.get("GLOT_DATA_DIR", _default_data_dir)
GLOSSARY_DIR  = os.path.join(GLOT_DATA_DIR, "glossary")
PROMPTS_DIR   = os.path.join(GLOT_DATA_DIR, "prompts")


# ---------------------------------------------------------------------------
# Glossary
# ---------------------------------------------------------------------------

def load_glossary(target_lang: str) -> dict:
    glossary_path = os.path.join(GLOSSARY_DIR, f"{target_lang}.tsv")
    if not os.path.exists(glossary_path):
        return {}

    glossary = {}
    with open(glossary_path, encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        lang_column = None
        for row in reader:
            if lang_column is None:
                cols = list(row.keys())
                lang_column = cols[1] if len(cols) > 1 else None

            term = (row.get("en") or "").strip().lower()
            if not term:
                continue

            raw = (row.get(lang_column) or "").strip() if lang_column else ""
            glossary[term] = {
                "translation": raw.split(",")[0].strip(),
                "pos":  (row.get("pos") or "").strip(),
                "note": (row.get("description") or "").strip(),
            }
    return glossary


def build_glossary_index(glossary: dict) -> dict:
    index = defaultdict(list)
    for term in glossary:
        index[term.split()[0]].append(term)
    return index


def tokenize(text: str) -> list:
    return re.findall(r"\b\w+\b", text.lower())


def matching_glossary_terms(text: str, glossary: dict, index: dict) -> list:
    if not glossary:
        return []
    words = tokenize(text)
    matched = set()
    for i, word in enumerate(words):
        for term in index.get(word, []):
            term_words = term.split()
            if words[i:i + len(term_words)] == term_words:
                matched.add(term)
    return [(term, glossary[term]) for term in matched]


# ---------------------------------------------------------------------------
# Prompt building + AI call
# ---------------------------------------------------------------------------

def load_system_prompt(target_lang: str) -> str | None:
    prompt_path = os.path.join(PROMPTS_DIR, f"{target_lang}.md")
    if not os.path.exists(prompt_path):
        return None
    with open(prompt_path, encoding="utf-8") as f:
        return f.read().strip()


def build_batch_prompt(items: list, target_lang: str, system_prompt: str | None) -> str:
    seen_terms = {}
    for _, matches in items:
        for term, info in matches:
            if term not in seen_terms:
                seen_terms[term] = info

    numbered = "\n".join(f"{i + 1}. {msgid}" for i, (msgid, _) in enumerate(items))

    if system_prompt:
        glossary_block = ""
        if seen_terms:
            lines = [f"{term} = {info['translation']}" for term, info in seen_terms.items()]
            glossary_block = "Approved terms:\n" + "\n".join(lines) + "\n\n"
        return f"{glossary_block}Translate each numbered string:\n{numbered}"
    else:
        glossary_block = ""
        if seen_terms:
            lines = []
            for term, info in seen_terms.items():
                line = f'- "{term}" -> "{info["translation"]}"'
                if info["note"]:
                    line += f" ({info['note']})"
                lines.append(line)
            glossary_block = "\n\nUse these exact terms where they apply:\n" + "\n".join(lines)

        return (
            f"Translate each numbered English WordPress UI string into {target_lang}. "
            f"Follow these rules strictly:\n"
            f"1. Passthrough: if the entire string is a URL, email, file path, or version number, return it unchanged.\n"
            f"2. String type: commands/buttons → imperative verb form; labels/statuses/nouns → concise word or phrase, no added verb; sentences → natural sentence.\n"
            f"3. Placeholders: keep exactly as-is — printf variables (%s, %d, %1$s), template variables ({{name}}, {{{{email}}}}), HTML tags, WordPress shortcodes, plugin/theme names, URLs.\n"
            f"4. Glossary: if approved terms are listed, copy them exactly — no synonyms, no alternatives.\n"
            f"Return ONLY a numbered list with translations, one per line, "
            f"with no explanation or extra text.{glossary_block}\n\n{numbered}"
        )


def parse_batch_response(response: str, count: int) -> list:
    results = {}
    for line in response.splitlines():
        m = re.match(r'^(\d+)\.\s*(.+)$', line.strip())
        if m:
            idx = int(m.group(1)) - 1
            if 0 <= idx < count:
                results[idx] = m.group(2).strip()
    return [results.get(i, "") for i in range(count)]


def call_ai_translate(prompt: str, system_prompt: str | None = None) -> str:
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    headers = {"Content-Type": "application/json"}
    if GLOT_API_KEY:
        headers["Authorization"] = f"Bearer {GLOT_API_KEY}"

    for attempt in range(3):
        response = requests.post(
            GLOT_ENDPOINT_URL,
            headers=headers,
            json={
                "model": GLOT_MODEL_ID,
                "messages": messages,
                "temperature": 0.2,
            },
            timeout=GLOT_REQUEST_TIMEOUT,
        )
        if response.status_code == 429:
            import time
            time.sleep(2 ** attempt)
            continue
        response.raise_for_status()
        break

    return response.json()["choices"][0]["message"]["content"].strip()


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_translate(args):
    missing_env = [n for n, v in [("GLOT_ENDPOINT_URL", GLOT_ENDPOINT_URL), ("GLOT_MODEL_ID", GLOT_MODEL_ID)] if not v]
    if missing_env:
        print(f"Error: required environment variable(s) not set: {', '.join(missing_env)}", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(args.input):
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    glossary       = load_glossary(args.lang)
    glossary_index = build_glossary_index(glossary)
    system_prompt  = load_system_prompt(args.lang)

    po      = polib.pofile(args.input)
    missing = [e for e in po if not e.translated()]

    if not missing:
        print("Nothing to do. File is already fully translated.")
        return

    print(f"Found {len(missing)} untranslated string(s).")
    if glossary:
        print(f"Glossary loaded: {len(glossary)} terms ({args.lang})")
    if system_prompt:
        print("Custom system prompt loaded.")

    backup_path = args.input + ".bak"
    if not os.path.exists(backup_path):
        shutil.copy(args.input, backup_path)
        print(f"Backup created: {backup_path}")

    limit = args.limit or MAX_STRINGS_PER_RUN
    capped = len(missing) > limit
    batch  = missing[:limit]

    chunks = [batch[i:i + GLOT_BATCH_SIZE] for i in range(0, len(batch), GLOT_BATCH_SIZE)]
    print(f"Translating {len(batch)} string(s) in {len(chunks)} batch(es) "
          f"(batch size: {GLOT_BATCH_SIZE}, concurrency: {GLOT_CONCURRENCY}) ...\n")

    def translate_chunk(idx_chunk):
        idx, chunk = idx_chunk
        items = [
            (e.msgid, matching_glossary_terms(e.msgid, glossary, glossary_index))
            for e in chunk
        ]
        prompt   = build_batch_prompt(items, args.lang, system_prompt)
        response = call_ai_translate(prompt, system_prompt)
        return idx, chunk, parse_batch_response(response, len(chunk))

    failed  = []
    results = {}

    with ThreadPoolExecutor(max_workers=GLOT_CONCURRENCY) as executor:
        future_map = {executor.submit(translate_chunk, (i, chunk)): i for i, chunk in enumerate(chunks)}
        completed  = 0
        for future in as_completed(future_map):
            try:
                idx, chunk, translations = future.result()
                ok = 0
                for entry, translation in zip(chunk, translations):
                    if translation:
                        results[id(entry)] = (entry, translation)
                        ok += 1
                    else:
                        failed.append({"msgid": entry.msgid, "error": "missing from response"})
                completed += 1
                print(f"  Batch {idx + 1}/{len(chunks)}: {ok}/{len(chunk)} translated")
            except Exception as e:
                chunk = chunks[future_map[future]]
                for entry in chunk:
                    failed.append({"msgid": entry.msgid, "error": str(e)})
                completed += 1
                print(f"  Batch {future_map[future] + 1}/{len(chunks)}: FAILED — {e}")

    for entry, translation in results.values():
        entry.msgstr = translation

    po.save(args.input)

    translated = len(batch) - len(failed)
    print(f"\nSaved: {args.input}")
    print(f"Translated: {translated}  Failed: {len(failed)}")

    if failed:
        print("\nFailed entries:")
        for f in failed[:10]:
            print(f"  [{f['error']}] {f['msgid'][:80]}")

    if capped:
        remaining = len(missing) - limit
        print(f"\nNote: {remaining} string(s) remain. Run again to continue.")


def cmd_glossary_list(args):
    if not os.path.isdir(GLOSSARY_DIR):
        print(f"Glossary directory not found: {GLOSSARY_DIR}")
        return

    import glob
    files = sorted(glob.glob(os.path.join(GLOSSARY_DIR, "*.tsv")))
    if not files:
        print("No glossary files found.")
        return

    print(f"Data dir: {GLOT_DATA_DIR}\n")
    print(f"{'LOCALE':<12}  {'LAST UPDATED':<12}  ENTRIES")
    print(f"{'------------':<12}  {'------------':<12}  -------")

    import datetime
    for f in files:
        locale  = os.path.splitext(os.path.basename(f))[0]
        mtime   = datetime.datetime.fromtimestamp(os.path.getmtime(f))
        entries = max(0, sum(1 for _ in open(f, encoding="utf-8")) - 1)
        print(f"{locale:<12}  {mtime.strftime('%Y-%m-%d'):<12}  {entries}")


def cmd_glossary_pull(args):
    locale = args.locale
    parts  = locale.split("_")

    base_url = "https://translate.wordpress.org/locale"
    dest     = os.path.join(GLOSSARY_DIR, f"{locale}.tsv")

    def try_url(url):
        print(f"Trying: {url}")
        r = requests.get(url, timeout=30, headers={"User-Agent": "glot-cli/1.0"})
        if r.status_code == 200 and r.text.startswith("en,"):
            return r.text
        return None

    csv_text = None

    if len(parts) >= 3:
        lang    = parts[0].lower()
        variant = parts[2].lower()
        csv_text = try_url(f"{base_url}/{lang}/{variant}/glossary/-export/")
        if not csv_text:
            print(f"Error: could not fetch glossary for '{locale}'.", file=sys.stderr)
            sys.exit(1)
    else:
        full_slug = locale.replace("_", "-").lower()
        lang_only = parts[0].lower()
        for slug in [full_slug, lang_only]:
            csv_text = try_url(f"{base_url}/{slug}/default/glossary/-export/")
            if csv_text:
                break

        if not csv_text:
            print(f"Error: could not fetch glossary for '{locale}'.", file=sys.stderr)
            sys.exit(1)

    os.makedirs(GLOSSARY_DIR, exist_ok=True)

    import io
    rows = 0
    with open(dest, "w", encoding="utf-8") as fout:
        reader = csv.reader(io.StringIO(csv_text))
        for row in reader:
            if len(row) < 4:
                continue
            fout.write("\t".join(f.replace("\t", " ") for f in row) + "\n")
            rows += 1

    entries = rows - 1
    print(f"Saved {entries} entries to {dest}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        prog="glot",
        description="Translate .po files using any OpenAI-compatible backend.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # translate
    p_tr = sub.add_parser("translate", help="Translate missing entries in a .po file.")
    p_tr.add_argument("input", help="Path to the .po file.")
    p_tr.add_argument("--lang",  default="ne_NP", help="Target language code (default: ne_NP).")
    p_tr.add_argument("--limit", type=int, default=0, help="Max strings to translate this run (0 = use GLOT_MAX_STRINGS).")

    # glossary
    p_gl = sub.add_parser("glossary", help="Manage glossary files.")
    gl_sub = p_gl.add_subparsers(dest="glossary_command", required=True)

    gl_sub.add_parser("list", help="List available glossary files.")

    p_pull = gl_sub.add_parser("pull", help="Download a glossary from translate.wordpress.org.")
    p_pull.add_argument("locale", help="Locale code, e.g. ne_NP.")

    args = parser.parse_args()

    if args.command == "translate":
        cmd_translate(args)
    elif args.command == "glossary":
        if args.glossary_command == "list":
            cmd_glossary_list(args)
        elif args.glossary_command == "pull":
            cmd_glossary_pull(args)


if __name__ == "__main__":
    main()
