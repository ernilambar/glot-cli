import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GlossaryTerm {
  translation: string;
  pos: string;
  note: string;
}

export interface TermMatch {
  term: string;
  info: GlossaryTerm;
}

function parseTsvLine(line: string): string[] {
  return line.split("\t");
}

// A single English term can appear on multiple rows with different `pos`
// (e.g. WordPress core ships "post" as both noun and verb). Each term maps to
// the list of its variants in file order — collapsing them to one would drop
// every reading but the last, which is exactly what defeats msgctxt-based
// disambiguation at match time.
export function loadGlossary(glossaryDir: string, targetLang: string): Record<string, GlossaryTerm[]> {
  const path = join(glossaryDir, `${targetLang}.tsv`);
  if (!existsSync(path)) {
    return {};
  }

  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l !== "");
  if (lines.length === 0) {
    return {};
  }

  const header = parseTsvLine(lines[0]!);
  const colEN = header.indexOf("en");
  const colPos = header.indexOf("pos");
  const colDesc = header.indexOf("description");
  // The lang column is the second column per Python behavior.
  const langCol = header.length > 1 ? 1 : -1;

  const out: Record<string, GlossaryTerm[]> = {};
  for (const line of lines.slice(1)) {
    const row = parseTsvLine(line);
    if (colEN < 0 || colEN >= row.length) {
      continue;
    }
    const term = row[colEN]!.trim().toLowerCase();
    if (term === "") {
      continue;
    }
    const raw = langCol >= 0 && langCol < row.length ? row[langCol]!.trim() : "";
    const translation = raw !== "" ? raw.split(",")[0]!.trim() : "";
    const pos = colPos >= 0 && colPos < row.length ? row[colPos]!.trim() : "";
    const note = colDesc >= 0 && colDesc < row.length ? row[colDesc]!.trim() : "";
    (out[term] ??= []).push({ translation, pos, note });
  }
  return out;
}

export function buildGlossaryIndex(glossary: Record<string, GlossaryTerm[]>): Record<string, string[]> {
  const idx: Record<string, string[]> = {};
  for (const term of Object.keys(glossary)) {
    const first = term.split(" ")[0] ?? term;
    (idx[first] ??= []).push(term);
  }
  return idx;
}

const WORD_RE = /[A-Za-z0-9_]+/g;

export function tokenize(text: string): string[] {
  const matches = text.match(WORD_RE) ?? [];
  return matches.map((t) => t.toLowerCase());
}

// Pick the glossary variant to apply for a matched term. When the string's
// msgctxt names a part of speech (e.g. "noun" / "verb"), prefer the variant
// whose `pos` matches it — this is what lets "Post" [noun] and "Post" [verb]
// resolve to different glossary translations. Otherwise fall back to the first
// variant in file order.
function pickVariant(variants: GlossaryTerm[], msgCtxt: string): GlossaryTerm {
  const ctx = msgCtxt.trim().toLowerCase();
  if (ctx !== "") {
    const byPos = variants.find((v) => v.pos.trim().toLowerCase() === ctx);
    if (byPos) {
      return byPos;
    }
  }
  return variants[0]!;
}

export function matchingGlossaryTerms(
  text: string,
  glossary: Record<string, GlossaryTerm[]>,
  index: Record<string, string[]>,
  msgCtxt = "",
): TermMatch[] {
  if (Object.keys(glossary).length === 0) {
    return [];
  }
  const words = tokenize(text);
  const seen = new Set<string>();
  const out: TermMatch[] = [];
  for (let i = 0; i < words.length; i++) {
    for (const term of index[words[i]!] ?? []) {
      const tw = term.split(/\s+/).filter(Boolean);
      if (i + tw.length > words.length) {
        continue;
      }
      let match = true;
      for (let k = 0; k < tw.length; k++) {
        if (words[i + k] !== tw[k]) {
          match = false;
          break;
        }
      }
      if (match && !seen.has(term)) {
        seen.add(term);
        out.push({ term, info: pickVariant(glossary[term]!, msgCtxt) });
      }
    }
  }
  return out;
}
