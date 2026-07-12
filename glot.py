#!/usr/bin/env python3
# PYTHON_ARGCOMPLETE_OK
"""
glot - CLI tool for translating WordPress .po files using any OpenAI-compatible backend.

Author: Nilambar Sharma
Repo:   https://github.com/ernilambar/glot-cli
"""

import argparse
import csv
from importlib.metadata import version, PackageNotFoundError
import json
import os
import re
import shutil
import sys
import tempfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import polib
from tabulate import tabulate

try:
    import argcomplete
except ImportError:
    argcomplete = None

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
GLOT_REQUEST_TIMEOUT = int(_timeout_env) if _timeout_env is not None else 120

_default_data_dir = os.path.join(os.path.expanduser("~"), ".config", "glot-cli")
GLOT_DATA_DIR = os.environ.get("GLOT_DATA_DIR", _default_data_dir)
GLOSSARY_DIR  = os.path.join(GLOT_DATA_DIR, "glossary")
PROMPTS_DIR   = os.path.join(GLOT_DATA_DIR, "prompts")
CORE_DIR      = os.path.join(GLOT_DATA_DIR, "core")

CORE_PROJECTS = [
    "wp/dev/{slug}/default",
    "wp/dev/admin/{slug}/default",
    "wp/dev/admin/network/{slug}/default",
]


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
# Language list
# ---------------------------------------------------------------------------

_LANGUAGES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "languages.json")


def load_valid_languages() -> dict:
    if not os.path.exists(_LANGUAGES_FILE):
        return {}
    with open(_LANGUAGES_FILE, encoding="utf-8") as f:
        return json.load(f)


def validate_lang(lang: str) -> None:
    languages = load_valid_languages()
    if languages and lang not in languages:
        print(f"Error: unknown locale '{lang}'.", file=sys.stderr)
        sys.exit(1)


# Core translations
# ---------------------------------------------------------------------------

def load_core_translations(locale: str) -> dict:
    path = os.path.join(CORE_DIR, f"{locale}.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


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
            f"3. Placeholders: keep exactly as-is — printf variables (%s, %d, %1$s), template variables ({{name}}, {{{{email}}}}), HTML tags, HTML entities (&amp;, &lt;, &gt;, &quot;), WordPress shortcodes, plugin/theme names, URLs.\n"
            f"4. Glossary: if approved terms are listed, copy them exactly — no synonyms, no alternatives.\n"
            f"Return ONLY a JSON object mapping number strings to translations: {{\"1\": \"...\", \"2\": \"...\"}}. "
            f"No explanation, no extra text.{glossary_block}\n\n{numbered}"
        )


def build_review_prompt(msgids: list) -> str:
    numbered = "\n".join(f"{i + 1}. {msgid}" for i, msgid in enumerate(msgids))
    return (
        "You are a WordPress i18n quality reviewer. Analyze each numbered English string for i18n violations.\n\n"
        "Flag only these issues:\n"
        "1. Hardcoded number/count that should use %d, or implicit singular/plural without _n() — e.g., \"Showing 5 results\", \"1 item found\", \"Delete items\" (when a count is implied)\n"
        "2. Hardcoded version number, date, or date format that should use %s\n"
        "3. Hardcoded file name or file path that should use %s; or a URL/email embedded within other text — do NOT flag a string whose entire content is a URL or email\n"
        "4. String that is clearly not user-facing (raw error codes, debug output, code snippets)\n"
        "5. String starts with a lowercase letter and is not a continuation, code value, or proper noun — likely a concatenated fragment\n"
        "6. HTML tags inside the string — HTML markup should be outside the translatable string or needs a /* translators: */ comment explaining the tags\n"
        "7. Leading or trailing whitespace — padding inside translatable strings causes translation mismatches\n"
        "8. Ambiguous string that needs _x() with context — e.g., a single word that could be a verb or noun, or a question used as a UI label\n"
        "9. Hardcoded ordinal suffix (e.g., \"1st\", \"2nd\", \"3rd\") — ordinals are not universal and should use %s\n\n"
        "Return ONLY a JSON object mapping string numbers (as strings) to a short issue description. "
        "Include only strings with issues. Return {} if all strings are fine. No explanation outside the JSON.\n\n"
        f"{numbered}"
    )


def parse_review_response(response: str) -> dict:
    try:
        text = re.sub(r'^```(?:json)?\s*|\s*```$', '', response.strip(), flags=re.DOTALL).strip()
        data = json.loads(text)
        return {k: str(v).strip() for k, v in data.items() if v}
    except (json.JSONDecodeError, AttributeError):
        return {}


def parse_batch_response(response: str, count: int) -> list:
    # Try JSON first (strip optional markdown code fences)
    try:
        text = re.sub(r'^```(?:json)?\s*|\s*```$', '', response.strip(), flags=re.DOTALL).strip()
        data = json.loads(text)
        results = {}
        for k, v in data.items():
            try:
                idx = int(k) - 1
                if 0 <= idx < count:
                    results[idx] = str(v).strip()
            except (ValueError, TypeError):
                pass
        return [results.get(i, "") for i in range(count)]
    except (json.JSONDecodeError, AttributeError):
        pass

    # Fall back to numbered list (e.g. custom system prompt output)
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

    validate_lang(args.lang)

    if not os.path.exists(args.input):
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    glossary       = load_glossary(args.lang)
    glossary_index = build_glossary_index(glossary)
    system_prompt  = load_system_prompt(args.lang)
    core           = load_core_translations(args.lang)

    try:
        po = polib.pofile(args.input)
    except OSError as e:
        print(f"Error: cannot read file: {e}", file=sys.stderr)
        sys.exit(1)
    missing = [e for e in po if not e.translated()]

    if not missing:
        print("Nothing to do. File is already fully translated.")
        return

    core_hits = 0
    if core:
        for entry in missing:
            key = f"{entry.msgctxt}\x04{entry.msgid}" if entry.msgctxt else entry.msgid
            if key in core:
                entry.msgstr = core[key]
                core_hits += 1
        missing = [e for e in missing if not e.translated()]

    print(f"Found {len(missing) + core_hits} untranslated string(s).")
    if core_hits:
        print(f"Core matches: {core_hits} (skipped AI)")
    if glossary:
        print(f"Glossary loaded: {len(glossary)} terms ({args.lang})")
    if system_prompt:
        print("Custom system prompt loaded.")

    if not missing:
        po.save(args.input)
        print(f"\nSaved: {args.input}")
        print(f"Translated: {core_hits}  Failed: 0")
        return

    backup_path = args.input + ".bak"
    if not os.path.exists(backup_path):
        shutil.copy(args.input, backup_path)
        print(f"Backup created: {backup_path}")

    if args.limit < 0:
        print("Error: --limit must be a non-negative integer", file=sys.stderr)
        sys.exit(1)
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

    failed       = []
    results      = {}
    done_strings = 0

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
                done_strings += len(chunk)
                completed += 1
                print(f"  Batch {idx + 1}/{len(chunks)}: {ok}/{len(chunk)} ok  [{done_strings}/{len(batch)}]")
            except Exception as e:
                chunk = chunks[future_map[future]]
                done_strings += len(chunk)
                for entry in chunk:
                    failed.append({"msgid": entry.msgid, "error": str(e)})
                completed += 1
                print(f"  Batch {future_map[future] + 1}/{len(chunks)}: FAILED — {e}  [{done_strings}/{len(batch)}]")

    for entry, translation in results.values():
        entry.msgstr = translation

    try:
        po.save(args.input)
    except OSError as e:
        print(f"Error: cannot write file: {e}", file=sys.stderr)
        sys.exit(1)

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


def _output_review_report(report: list, total: int, fmt: str) -> None:
    if fmt == "json":
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    if fmt == "markdown":
        print("| # | String | Location | Issue |")
        print("|---|--------|----------|-------|")
        for item in report:
            preview = item["msgid"][:60] + ("..." if len(item["msgid"]) > 60 else "")
            locations = ", ".join(item["occurrences"]) if item["occurrences"] else "—"
            print(f"| {item['num']} | {preview} | {locations} | {item['issue']} |")
        return

    if fmt == "csv":
        writer = csv.DictWriter(sys.stdout, fieldnames=["num", "msgid", "occurrences", "issue"])
        writer.writeheader()
        for item in report:
            writer.writerow({**item, "occurrences": "; ".join(item["occurrences"])})
        return

    if fmt == "table":
        if not report:
            print("\nNo issues found.")
            return
        rows = [
            [
                item["num"],
                item["msgid"][:80] + ("..." if len(item["msgid"]) > 80 else ""),
                "\n".join(item["occurrences"]) if item["occurrences"] else "—",
                item["issue"],
            ]
            for item in report
        ]
        print(tabulate(rows, headers=["#", "String", "Location", "Issue"], tablefmt="simple"))
        print(f"\nTotal: {len(report)} issue(s) in {total} string(s)")
        return

    # text (default)
    if not report:
        print("\nNo issues found.")
        return
    print(f"\nFound {len(report)} issue(s):\n")
    for item in report:
        preview = item["msgid"][:80] + ("..." if len(item["msgid"]) > 80 else "")
        print(f"  String: \"{preview}\"")
        for occ in item["occurrences"]:
            print(f"  {occ}")
        print(f"  Issue: {item['issue']}\n")
    print(f"Total: {len(report)} issue(s) in {total} string(s)")


def cmd_review(args):
    missing_env = [n for n, v in [("GLOT_ENDPOINT_URL", GLOT_ENDPOINT_URL), ("GLOT_MODEL_ID", GLOT_MODEL_ID)] if not v]
    if missing_env:
        print(f"Error: required environment variable(s) not set: {', '.join(missing_env)}", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(args.input):
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    try:
        po = polib.pofile(args.input)
    except OSError as e:
        print(f"Error: cannot read file: {e}", file=sys.stderr)
        sys.exit(1)

    entries = list(po)

    if not entries:
        print("No strings found.", file=sys.stderr)
        return

    machine_fmt = args.format in ("json", "csv", "markdown")

    if not machine_fmt:
        print(f"Reviewing {len(entries)} string(s) in {args.input} ...\n", file=sys.stderr)

    # Static check: placeholder without translator comment
    placeholder_re = re.compile(r'%(\d+\$)?[sd]')
    static_issues = {
        i: "Has %s/%d placeholder but no /* translators: */ comment"
        for i, entry in enumerate(entries)
        if placeholder_re.search(entry.msgid) and not entry.comment
    }

    chunks = [entries[i:i + GLOT_BATCH_SIZE] for i in range(0, len(entries), GLOT_BATCH_SIZE)]
    ai_issues = {}

    def review_chunk(idx_chunk):
        idx, chunk = idx_chunk
        prompt = build_review_prompt([e.msgid for e in chunk])
        response = call_ai_translate(prompt)
        return idx, chunk, parse_review_response(response)

    completed = 0
    with ThreadPoolExecutor(max_workers=GLOT_CONCURRENCY) as executor:
        future_map = {executor.submit(review_chunk, (i, chunk)): i for i, chunk in enumerate(chunks)}
        for future in as_completed(future_map):
            completed += 1
            batch_idx = future_map[future]
            try:
                idx, chunk, issues = future.result()
                offset = idx * GLOT_BATCH_SIZE
                for k, v in issues.items():
                    try:
                        local_idx = int(k) - 1
                        if 0 <= local_idx < len(chunk):
                            ai_issues[offset + local_idx] = v
                    except (ValueError, TypeError):
                        pass
                if not machine_fmt:
                    print(f"  Batch {batch_idx + 1}/{len(chunks)}: done  [{completed}/{len(chunks)}]", file=sys.stderr)
            except Exception as e:
                if not machine_fmt:
                    print(f"  Batch {batch_idx + 1}/{len(chunks)}: FAILED — {e}  [{completed}/{len(chunks)}]", file=sys.stderr)

    all_issues = {**static_issues}
    for idx, issue in ai_issues.items():
        if idx in all_issues:
            all_issues[idx] += f"; {issue}"
        else:
            all_issues[idx] = issue

    report = [
        {
            "num": idx + 1,
            "msgid": entries[idx].msgid,
            "occurrences": [f"{f}:{l}" for f, l in entries[idx].occurrences],
            "issue": issue,
        }
        for idx, issue in sorted(all_issues.items())
    ]

    _output_review_report(report, len(entries), args.format)


def cmd_status(args):
    if args.lang:
        validate_lang(args.lang)

    if not os.path.exists(args.input):
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    try:
        po = polib.pofile(args.input)
    except OSError as e:
        print(f"Error: cannot read file: {e}", file=sys.stderr)
        sys.exit(1)
    total        = len(po)
    translated   = len(po.translated_entries())
    untranslated = len(po.untranslated_entries())
    fuzzy        = len(po.fuzzy_entries())
    pct          = (translated / total * 100) if total else 0.0

    print(f"File: {args.input}\n")
    print(f"  {'Total':<14} {total}")
    print(f"  {'Translated':<14} {translated}  ({pct:.1f}%)")
    print(f"  {'Untranslated':<14} {untranslated}")
    print(f"  {'Fuzzy':<14} {fuzzy}")

    if args.lang:
        core = load_core_translations(args.lang)
        if core:
            cache_hits = sum(
                1 for e in po.untranslated_entries()
                if (f"{e.msgctxt}\x04{e.msgid}" if e.msgctxt else e.msgid) in core
            )
            print(f"\n  Core cache ({args.lang}): {cache_hits} of {untranslated} untranslated string(s) have cached translations")


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
    if not args.locale:
        print("Error: locale is required (or set GLOT_LANG env variable)", file=sys.stderr)
        sys.exit(1)
    validate_lang(args.locale)
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
# Core commands
# ---------------------------------------------------------------------------

def cmd_core_pull(args):
    if not args.locale:
        print("Error: locale is required (or set GLOT_LANG env variable)", file=sys.stderr)
        sys.exit(1)
    validate_lang(args.locale)
    locale = args.locale
    parts  = locale.split("_")
    full_slug = locale.replace("_", "-").lower()
    lang_only = parts[0].lower()
    slug_candidates = [full_slug] if full_slug == lang_only else [full_slug, lang_only]

    base = "https://translate.wordpress.org/projects"

    # detect working slug using the first project
    first_text  = None
    working_slug = None
    for slug in slug_candidates:
        url = f"{base}/{CORE_PROJECTS[0].format(slug=slug)}/export-translations/?format=po"
        print(f"Trying: {url}")
        r = requests.get(url, timeout=60, headers={"User-Agent": "glot-cli/1.0"})
        if r.status_code == 200:
            working_slug = slug
            first_text   = r.text
            break

    if not working_slug:
        print(f"Error: could not fetch core translations for '{locale}'.", file=sys.stderr)
        sys.exit(1)

    def fetch_po_text(url):
        r = requests.get(url, timeout=60, headers={"User-Agent": "glot-cli/1.0"})
        if r.status_code != 200:
            return None
        return r.text

    remaining_urls = [
        f"{base}/{t.format(slug=working_slug)}/export-translations/?format=po"
        for t in CORE_PROJECTS[1:]
    ]
    po_texts = [first_text]
    with ThreadPoolExecutor(max_workers=2) as ex:
        for text in ex.map(fetch_po_text, remaining_urls):
            po_texts.append(text)

    def parse_po_text(text):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".po", delete=False, encoding="utf-8") as tmp:
            tmp.write(text)
            tmp_path = tmp.name
        try:
            return polib.pofile(tmp_path)
        finally:
            os.unlink(tmp_path)

    labels = ["wp/dev", "wp/dev/admin", "wp/dev/admin/network"]
    index  = {}
    for label, text in zip(labels, po_texts):
        if text is None:
            print(f"  {label}: skipped (not available)")
            continue
        po    = parse_po_text(text)
        count = 0
        for e in po:
            if not e.translated():
                continue
            key = f"{e.msgctxt}\x04{e.msgid}" if e.msgctxt else e.msgid
            index[key] = e.msgstr
            count += 1
        print(f"  {label}: {count} strings")

    os.makedirs(CORE_DIR, exist_ok=True)
    dest = os.path.join(CORE_DIR, f"{locale}.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)

    print(f"Saved {len(index)} entries to {dest}")


def cmd_core_list(args):
    import glob
    import datetime

    if not os.path.isdir(CORE_DIR):
        print(f"Core directory not found: {CORE_DIR}")
        return

    files = sorted(glob.glob(os.path.join(CORE_DIR, "*.json")))
    if not files:
        print("No core translation files found.")
        return

    print(f"Data dir: {GLOT_DATA_DIR}\n")
    print(f"{'LOCALE':<12}  {'LAST UPDATED':<12}  ENTRIES")
    print(f"{'------------':<12}  {'------------':<12}  -------")

    for f in files:
        locale = os.path.splitext(os.path.basename(f))[0]
        mtime  = datetime.datetime.fromtimestamp(os.path.getmtime(f))
        with open(f, encoding="utf-8") as fh:
            data = json.load(fh)
        print(f"{locale:<12}  {mtime.strftime('%Y-%m-%d'):<12}  {len(data)}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        prog="glot",
        description="Translate WordPress .po files using any OpenAI-compatible backend.",
    )
    try:
        _version = version("glot-cli")
    except PackageNotFoundError:
        _version = "unknown"
    parser.add_argument("-V", "--version", action="version", version=f"%(prog)s {_version}")
    sub = parser.add_subparsers(dest="command", required=True)

    # translate
    p_tr = sub.add_parser("translate", help="Translate missing entries in a .po file.")
    p_tr.add_argument("input", help="Path to the .po file.")
    p_tr.add_argument("--lang", default=os.environ.get("GLOT_LANG"), help="Target language code, e.g. ne_NP. Overrides GLOT_LANG.")
    p_tr.add_argument("--limit", type=int, default=0, help="Max strings to translate this run (0 = use GLOT_MAX_STRINGS).")

    # review
    p_rv = sub.add_parser("review", help="Review strings in a .po/.pot file for i18n issues.")
    p_rv.add_argument("input", help="Path to the .po or .pot file.")
    p_rv.add_argument("--format", choices=["text", "table", "json", "csv", "markdown"], default="text", help="Output format (default: text).")

    # status
    p_st = sub.add_parser("status", help="Show translation progress for a .po file.")
    p_st.add_argument("input", help="Path to the .po file.")
    p_st.add_argument("--lang", default=os.environ.get("GLOT_LANG"), help="Locale code for core cache check, e.g. ne_NP.")

    # glossary
    p_gl = sub.add_parser("glossary", help="Manage glossary files.")
    gl_sub = p_gl.add_subparsers(dest="glossary_command", required=True)

    gl_sub.add_parser("list", help="List available glossary files.")

    p_pull = gl_sub.add_parser("pull", help="Download a glossary from translate.wordpress.org.")
    p_pull.add_argument("locale", nargs="?", default=os.environ.get("GLOT_LANG"), help="Locale code, e.g. ne_NP. Defaults to GLOT_LANG.")

    # core
    p_core = sub.add_parser("core", help="Manage core translation cache.")
    core_sub = p_core.add_subparsers(dest="core_command", required=True)

    core_sub.add_parser("list", help="List available core translation files.")

    p_core_pull = core_sub.add_parser("pull", help="Download core translations from translate.wordpress.org.")
    p_core_pull.add_argument("locale", nargs="?", default=os.environ.get("GLOT_LANG"), help="Locale code, e.g. ne_NP. Defaults to GLOT_LANG.")

    if argcomplete:
        argcomplete.autocomplete(parser)

    args = parser.parse_args()

    if args.command == "review":
        cmd_review(args)
    elif args.command == "translate":
        if not args.lang:
            parser.error("--lang is required (or set GLOT_LANG env variable)")
        cmd_translate(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "glossary":
        if args.glossary_command == "list":
            cmd_glossary_list(args)
        elif args.glossary_command == "pull":
            cmd_glossary_pull(args)
    elif args.command == "core":
        if args.core_command == "list":
            cmd_core_list(args)
        elif args.core_command == "pull":
            cmd_core_pull(args)


if __name__ == "__main__":
    main()
