import { copyFileSync, existsSync } from "node:fs";
import pLimit from "p-limit";
import type { UsageInfo } from "../ai-client.ts";
import type { GlotConfig } from "../config.ts";
import { deps } from "../deps.ts";
import { GlotRuntimeError, GlotValidationError } from "../errors.ts";
import { buildGlossaryIndex, loadGlossary, matchingGlossaryTerms } from "../glossary.ts";
import { validateLang } from "../languages.ts";
import { coreCacheKey, isTranslated } from "../po/entry.ts";
import { PoFile } from "../po/poFile.ts";
import type { Entry } from "../po/types.ts";
import { buildBatchPrompt, parseBatchResponse } from "../prompts.ts";
import { loadSystemPrompt } from "../core-translations.ts";

export interface FailedEntry {
  msgId: string;
  error: string;
}

export type TranslateEvent =
  | { type: "backupCreated"; path: string }
  | { type: "found"; count: number }
  | { type: "coreMatches"; count: number }
  | { type: "glossaryLoaded"; count: number; lang: string }
  | { type: "customSystemPromptLoaded" }
  | { type: "translating"; totalStrings: number; totalBatches: number; batchSize: number; concurrency: number }
  | { type: "batchOk"; index: number; totalBatches: number; ok: number; chunkSize: number; doneStrings: number; totalStrings: number }
  | { type: "batchFailed"; index: number; totalBatches: number; error: string; doneStrings: number; totalStrings: number };

export type TranslateResult =
  | { outcome: "alreadyTranslated" }
  | {
      outcome: "translated";
      savedPath: string;
      translated: number;
      failed: FailedEntry[];
      usage: UsageInfo | null;
      capped: boolean;
      remaining: number;
    };

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function runTranslate(
  config: GlotConfig,
  input: string,
  lang: string,
  limit: number,
  onEvent?: (event: TranslateEvent) => void,
): Promise<TranslateResult> {
  const missingEnv: string[] = [];
  if (config.endpointUrl === "") {
    missingEnv.push("GLOT_ENDPOINT_URL");
  }
  if (config.modelId === "") {
    missingEnv.push("GLOT_MODEL_ID");
  }
  if (missingEnv.length > 0) {
    throw new GlotValidationError(`required environment variable(s) not set: ${missingEnv.join(", ")}`);
  }

  validateLang(lang, deps.loadValidLanguages());

  if (!existsSync(input)) {
    throw new GlotValidationError(`file not found: ${input}`);
  }

  const glossary = loadGlossary(config.glossaryDir, lang);
  const glossaryIdx = buildGlossaryIndex(glossary);
  const systemPrompt = loadSystemPrompt(config, lang);
  const core = deps.loadCoreTranslations(config, lang);

  let pf: PoFile;
  try {
    pf = PoFile.parseFile(input);
  } catch (err) {
    throw new GlotValidationError(`cannot read file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const translatable = pf.translatableEntries();
  let missingEntries = translatable.filter((e) => !isTranslated(e));

  if (missingEntries.length === 0) {
    return { outcome: "alreadyTranslated" };
  }

  let coreHits = 0;
  if (Object.keys(core).length > 0) {
    const remaining: Entry[] = [];
    for (const e of missingEntries) {
      const v = core[coreCacheKey(e)];
      if (v) {
        e.msgStr = v;
        coreHits++;
      } else {
        remaining.push(e);
      }
    }
    missingEntries = remaining;
  }

  onEvent?.({ type: "found", count: missingEntries.length + coreHits });
  if (coreHits > 0) {
    onEvent?.({ type: "coreMatches", count: coreHits });
  }
  if (Object.keys(glossary).length > 0) {
    onEvent?.({ type: "glossaryLoaded", count: Object.keys(glossary).length, lang });
  }
  if (systemPrompt !== "") {
    onEvent?.({ type: "customSystemPromptLoaded" });
  }

  if (missingEntries.length === 0) {
    try {
      pf.save(input);
    } catch (err) {
      throw new GlotRuntimeError(`cannot write file: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      outcome: "translated",
      savedPath: input,
      translated: coreHits,
      failed: [],
      usage: null,
      capped: false,
      remaining: 0,
    };
  }

  const backupPath = `${input}.bak`;
  if (!existsSync(backupPath)) {
    try {
      copyFileSync(input, backupPath);
      onEvent?.({ type: "backupCreated", path: backupPath });
    } catch {
      // Backup failures are silently ignored — translation proceeds either way.
    }
  }

  if (limit < 0) {
    throw new GlotValidationError("--limit must be a non-negative integer");
  }
  const effectiveLimit = limit === 0 ? config.maxStrings : limit;
  const capped = missingEntries.length > effectiveLimit;
  const batch = capped ? missingEntries.slice(0, effectiveLimit) : missingEntries;

  const chunks = chunk(batch, config.batchSize);

  onEvent?.({
    type: "translating",
    totalStrings: batch.length,
    totalBatches: chunks.length,
    batchSize: config.batchSize,
    concurrency: config.concurrency,
  });

  const failed: FailedEntry[] = [];
  const totalUsage: UsageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let usageComplete = true;
  let doneStrings = 0;

  const limiter = pLimit(config.concurrency);
  await Promise.all(
    chunks.map((c, idx) =>
      limiter(async () => {
        const items = c.map((e) => ({
          msgId: e.msgId,
          matches: matchingGlossaryTerms(e.msgId, glossary, glossaryIdx),
        }));
        const prompt = buildBatchPrompt(items, lang, systemPrompt);

        let translations: string[];
        let usage: UsageInfo | null;
        try {
          const result = await deps.callAI(config, prompt, systemPrompt, 0.1);
          translations = parseBatchResponse(result.content, c.length);
          usage = result.usage;
        } catch (err) {
          usageComplete = false;
          doneStrings += c.length;
          const message = err instanceof Error ? err.message : String(err);
          for (const e of c) {
            failed.push({ msgId: e.msgId, error: message });
          }
          onEvent?.({
            type: "batchFailed",
            index: idx,
            totalBatches: chunks.length,
            error: message,
            doneStrings,
            totalStrings: batch.length,
          });
          return;
        }

        if (usage === null) {
          usageComplete = false;
        } else {
          totalUsage.promptTokens += usage.promptTokens;
          totalUsage.completionTokens += usage.completionTokens;
          totalUsage.totalTokens += usage.totalTokens;
        }

        let ok = 0;
        c.forEach((e, i) => {
          const tr = translations[i] ?? "";
          if (tr !== "") {
            e.msgStr = tr;
            ok++;
          } else {
            failed.push({ msgId: e.msgId, error: "missing from response" });
          }
        });
        doneStrings += c.length;
        onEvent?.({
          type: "batchOk",
          index: idx,
          totalBatches: chunks.length,
          ok,
          chunkSize: c.length,
          doneStrings,
          totalStrings: batch.length,
        });
      }),
    ),
  );

  try {
    pf.save(input);
  } catch (err) {
    throw new GlotRuntimeError(`cannot write file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const translated = batch.length - failed.length + coreHits;
  const usage = usageComplete && totalUsage.totalTokens > 0 ? totalUsage : null;

  return {
    outcome: "translated",
    savedPath: input,
    translated,
    failed,
    usage,
    capped,
    remaining: capped ? missingEntries.length - effectiveLimit : 0,
  };
}
