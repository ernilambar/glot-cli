import type { GlossaryTerm, TermMatch } from "./glossary.ts";

export interface BatchItem {
  msgId: string;
  matches: TermMatch[];
}

const FORMAT_INSTRUCTION =
  'Return ONLY a JSON object mapping number strings to translations: {"1": "...", "2": "..."}. No explanation, no extra text.';

export function buildBatchPrompt(items: BatchItem[], targetLang: string, systemPrompt: string): string {
  // Deduplicate glossary terms while preserving first-seen order.
  const seenOrder: string[] = [];
  const seenInfo: Record<string, GlossaryTerm> = {};
  for (const it of items) {
    for (const m of it.matches) {
      if (!(m.term in seenInfo)) {
        seenOrder.push(m.term);
        seenInfo[m.term] = m.info;
      }
    }
  }

  const numbered = items.map((it, i) => `${i + 1}. ${it.msgId}`).join("\n");

  if (systemPrompt !== "") {
    let glossaryBlock = "";
    if (seenOrder.length > 0) {
      const lines = seenOrder.map((t) => `${t} = ${seenInfo[t]!.translation}`);
      glossaryBlock = `Approved terms:\n${lines.join("\n")}\n\n`;
    }
    return `${glossaryBlock}Translate each numbered string:\n${numbered}\n\n${FORMAT_INSTRUCTION}`;
  }

  let glossaryBlock = "";
  if (seenOrder.length > 0) {
    const lines = seenOrder.map((t) => {
      const info = seenInfo[t]!;
      let line = `- ${JSON.stringify(t)} -> ${JSON.stringify(info.translation)}`;
      if (info.note !== "") {
        line += ` (${info.note})`;
      }
      return line;
    });
    glossaryBlock = `\n\nUse these exact terms where they apply:\n${lines.join("\n")}`;
  }

  const rules =
    "Follow these rules strictly:\n" +
    "1. Passthrough: if the entire string is a URL, email, file path, or version number, return it unchanged.\n" +
    "2. String type: commands/buttons → imperative verb form; labels/statuses/nouns → concise word or phrase, no added verb; sentences → natural sentence.\n" +
    "3. Placeholders: keep exactly as-is — printf variables (%s, %d, %1$s), template variables ({{name}}, {{{{email}}}}), HTML tags, HTML entities (&amp;, &lt;, &gt;, &quot;), WordPress shortcodes, plugin/theme names, URLs.\n" +
    "4. Glossary: if approved terms are listed, copy them exactly — no synonyms, no alternatives.\n";

  return `Translate each numbered English WordPress UI string into ${targetLang}. ${rules}${FORMAT_INSTRUCTION}${glossaryBlock}\n\n${numbered}`;
}

export function buildReviewPrompt(msgids: string[]): string {
  const numbered = msgids.map((m, i) => `${i + 1}. ${m}`).join("\n");

  return (
    "You are a WordPress i18n quality reviewer. Analyze each numbered English string for i18n violations.\n\n" +
    "Flag only these issues:\n" +
    '1. Hardcoded numeric literal that should use %d — e.g., "Showing 5 results", "1 item found", "3 comments". Do NOT flag strings without a digit or without a runtime-variable count (e.g., "No results found", "Delete items", "Add new", "Recent posts" are fine).\n' +
    "2. Hardcoded version number, date, or date format that should use %s\n" +
    "3. Hardcoded file name or file path that should use %s; or a URL/email embedded within other text — do NOT flag a string whose entire content is a URL or email\n" +
    "4. String that is clearly not user-facing (raw error codes, debug output, code snippets)\n" +
    "5. String starts with a lowercase letter and is not a continuation, code value, or proper noun — likely a concatenated fragment\n" +
    "6. HTML tags inside the string — HTML markup should be outside the translatable string or needs a /* translators: */ comment explaining the tags\n" +
    "7. Leading or trailing whitespace — padding inside translatable strings causes translation mismatches\n" +
    "8. Ambiguous string that needs _x() with context — e.g., a single word that could be a verb or noun, or a question used as a UI label\n" +
    '9. Hardcoded ordinal suffix (e.g., "1st", "2nd", "3rd") — ordinals are not universal and should use %s\n\n' +
    "Return ONLY a JSON object mapping string numbers (as strings) to a short issue description. " +
    "Include only strings with issues. Return {} if all strings are fine. No explanation outside the JSON.\n\n" +
    numbered
  );
}

export function stripCodeFences(s: string): string {
  let out = s.trim();
  if (out.startsWith("```")) {
    const nl = out.indexOf("\n");
    if (nl >= 0) {
      out = out.slice(nl + 1);
    } else {
      out = out.slice(3);
    }
  }
  out = out.trim();
  if (out.endsWith("```")) {
    out = out.slice(0, -3);
  }
  return out.trim();
}

function stringifyValue(v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  if (v === null || v === undefined) {
    return "";
  }
  return String(v);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  return data as Record<string, unknown>;
}

export function parseBatchResponse(response: string, count: number): string[] {
  const results: string[] = new Array(count).fill("");

  const data = parseJsonObject(stripCodeFences(response));
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      const idx = Number(k);
      if (!Number.isInteger(idx)) {
        continue;
      }
      const i = idx - 1;
      if (i >= 0 && i < count) {
        results[i] = stringifyValue(v).trim();
      }
    }
    return results;
  }

  const re = /^(\d+)\.\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < count) {
      results[idx] = m[2]!.trim();
    }
  }
  return results;
}

export function parseReviewResponse(response: string): Record<string, string> {
  const data = parseJsonObject(stripCodeFences(response));
  if (!data) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) {
      continue;
    }
    const s = stringifyValue(v).trim();
    if (s === "") {
      continue;
    }
    out[k] = s;
  }
  return out;
}
