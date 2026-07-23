import type { Entry } from "./types.ts";

export function isFuzzy(e: Entry): boolean {
  return e.flags.includes("fuzzy");
}

export function isTranslated(e: Entry): boolean {
  if (isFuzzy(e)) {
    return false;
  }
  if (e.msgIdPlural !== "") {
    const values = Object.values(e.msgStrPlural);
    if (values.length === 0) {
      return false;
    }
    return values.every((v) => v !== "");
  }
  return e.msgStr !== "";
}

export function occurrences(e: Entry): [string, string][] {
  const out: [string, string][] = [];
  for (const ref of e.references) {
    for (const part of ref.split(/\s+/).filter(Boolean)) {
      const i = part.lastIndexOf(":");
      if (i > 0) {
        out.push([part.slice(0, i), part.slice(i + 1)]);
      } else {
        out.push([part, ""]);
      }
    }
  }
  return out;
}

export function hasTranslatorComment(e: Entry): boolean {
  return e.translatorComments.length > 0 || e.extractedComments.length > 0;
}

// Reads "Plural-Forms: nplurals=N; ..." from the header entry's msgstr; 2 if absent.
export function detectPluralCount(entries: Entry[]): number {
  const header = entries.find((e) => e.isHeader);
  if (!header) {
    return 2;
  }
  const m = header.msgStr.match(/nplurals\s*=\s*(\d+)/);
  return m ? Number(m[1]) : 2;
}

// Core-translation-cache key: msgctxt and msgid joined by ASCII EOT (\x04) when
// a context is present, used by translate/status/corePull to disambiguate
// same-msgid entries in different contexts.
export function coreCacheKey(e: Pick<Entry, "msgCtxt" | "msgId">): string {
  return e.msgCtxt !== "" ? `${e.msgCtxt}\x04${e.msgId}` : e.msgId;
}
