import type { GlotConfig } from "../config.ts";
import { deps } from "../deps.ts";
import { GlotRuntimeError } from "../errors.ts";
import { buildGlossaryIndex, loadGlossary, matchingGlossaryTerms } from "../glossary.ts";
import { loadSystemPrompt } from "../core-translations.ts";
import { isFuzzy, isTranslated } from "../po/entry.ts";
import type { PoFile } from "../po/poFile.ts";
import type { Entry } from "../po/types.ts";
import { buildBatchPrompt, parseBatchResponse } from "../prompts.ts";

export type EntryStatus = "translated" | "untranslated" | "fuzzy";

export interface EditorRow {
  displayPos: number;
  entry: Entry;
  status: EntryStatus;
  // Approved translations for this row's msgid, pulled from the core cache —
  // attached by the caller (buildEditorView leaves this unset), since it
  // needs config/lang that buildEditorView doesn't take.
  coreMatches?: string[];
}

function entryStatus(e: Entry): EntryStatus {
  if (isFuzzy(e)) {
    return "fuzzy";
  }
  return isTranslated(e) ? "translated" : "untranslated";
}

export function buildEditorView(pf: PoFile): EditorRow[] {
  return pf.translatableEntries().map((entry, displayPos) => ({
    displayPos,
    entry,
    status: entryStatus(entry),
  }));
}

// Core-cache keys are "ctxt\x04msgid" or bare "msgid" (see coreCacheKey). A
// single msgid can carry several distinct approved translations across
// WordPress core's catalogs when the same English string is used under
// different contexts — this surfaces all of them, ignoring ctxt, so the
// editor can show every officially-approved candidate for a row.
export function findCoreMatches(core: Record<string, string>, msgId: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [key, value] of Object.entries(core)) {
    const keyMsgId = key.includes("\x04") ? key.slice(key.indexOf("\x04") + 1) : key;
    if (keyMsgId === msgId && value !== "" && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

const PLAIN_FIELD_RE = /^entry_(\d+)_msgstr$/;
const PLURAL_FIELD_RE = /^entry_(\d+)_msgstr_plural_(\d+)$/;

export function applyEditorEdits(rows: EditorRow[], posted: Record<string, string>): void {
  const byPos = new Map(rows.map((r) => [r.displayPos, r.entry]));

  for (const [key, value] of Object.entries(posted)) {
    const plural = key.match(PLURAL_FIELD_RE);
    if (plural) {
      const entry = byPos.get(Number(plural[1]));
      if (entry && entry.msgIdPlural !== "") {
        entry.msgStrPlural[Number(plural[2])] = value;
      }
      continue;
    }
    const plain = key.match(PLAIN_FIELD_RE);
    if (plain) {
      const entry = byPos.get(Number(plain[1]));
      if (entry && entry.msgIdPlural === "") {
        entry.msgStr = value;
      }
    }
  }
}

export interface TranslateSingleResult {
  translation: string;
}

// Single-string counterpart to runTranslate's batch AI path — same
// glossary-aware AI call, but for one on-demand string per button click
// rather than a whole file's worth of batches. Always calls the AI: the
// core-cache candidates for a msgid are already surfaced as "Core" chips
// at page load (see findCoreMatches), so this button is specifically the
// "ask the AI" action rather than a core-cache shortcut.
export async function translateSingle(config: GlotConfig, msgId: string, lang: string): Promise<TranslateSingleResult> {
  const glossary = loadGlossary(config.glossaryDir, lang);
  const glossaryIdx = buildGlossaryIndex(glossary);
  const systemPrompt = loadSystemPrompt(config, lang);
  const matches = matchingGlossaryTerms(msgId, glossary, glossaryIdx);

  const prompt = buildBatchPrompt([{ msgId, matches }], lang, systemPrompt);
  const result = await deps.callAI(config, prompt, systemPrompt, 0.1);
  const [translation] = parseBatchResponse(result.content, 1);

  if (!translation) {
    throw new GlotRuntimeError("AI did not return a translation");
  }

  return { translation };
}
