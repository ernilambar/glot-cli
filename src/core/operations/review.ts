import pLimit from "p-limit";
import type { UsageInfo } from "../ai-client.ts";
import type { GlotConfig } from "../config.ts";
import { deps } from "../deps.ts";
import { GlotValidationError } from "../errors.ts";
import { hasTranslatorComment, occurrences } from "../po/entry.ts";
import { PoFile } from "../po/poFile.ts";
import { buildReviewPrompt, parseReviewResponse } from "../prompts.ts";

export interface ReviewItem {
  num: number;
  msgId: string;
  occurrences: string[];
  staticIssue: string;
  aiIssue: string;
}

export type ReviewEvent =
  | { type: "reviewing"; count: number; input: string }
  | { type: "batchDone"; index: number; totalBatches: number; completed: number }
  | { type: "batchFailed"; index: number; totalBatches: number; error: string; completed: number };

export type ReviewResult =
  | { outcome: "noStrings" }
  | { outcome: "reviewed"; report: ReviewItem[]; total: number; usage: UsageInfo | null };

const PLACEHOLDER_RE = /%(\d+\$)?[sd]/;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

const MACHINE_FORMATS = new Set(["json", "csv", "markdown"]);

export async function runReview(
  config: GlotConfig,
  input: string,
  format: string,
  onEvent?: (event: ReviewEvent) => void,
): Promise<ReviewResult> {
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

  let pf: PoFile;
  try {
    pf = PoFile.parseFile(input);
  } catch (err) {
    throw new GlotValidationError(`cannot read file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const entries = pf.translatableEntries();
  if (entries.length === 0) {
    return { outcome: "noStrings" };
  }

  const machineFmt = MACHINE_FORMATS.has(format);
  if (!machineFmt) {
    onEvent?.({ type: "reviewing", count: entries.length, input });
  }

  const staticIssues: Record<number, string> = {};
  entries.forEach((e, i) => {
    if (PLACEHOLDER_RE.test(e.msgId) && !hasTranslatorComment(e)) {
      staticIssues[i] = "Has %s/%d placeholder but no /* translators: */ comment";
    }
  });

  const chunks = chunk(entries, config.batchSize);
  const aiIssues: Record<number, string> = {};
  const totalUsage: UsageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let usageComplete = true;
  let completed = 0;

  const limiter = pLimit(config.concurrency);
  await Promise.all(
    chunks.map((c, idx) =>
      limiter(async () => {
        const msgids = c.map((e) => e.msgId);
        const prompt = buildReviewPrompt(msgids);

        try {
          const result = await deps.callAI(config, prompt, "", 0.0);
          completed++;
          const issues = parseReviewResponse(result.content);
          if (result.usage === null) {
            usageComplete = false;
          } else {
            totalUsage.promptTokens += result.usage.promptTokens;
            totalUsage.completionTokens += result.usage.completionTokens;
            totalUsage.totalTokens += result.usage.totalTokens;
          }
          const offset = idx * config.batchSize;
          for (const [k, v] of Object.entries(issues)) {
            const localIdx = Number(k) - 1;
            if (Number.isInteger(localIdx) && localIdx >= 0 && localIdx < c.length) {
              aiIssues[offset + localIdx] = v;
            }
          }
          if (!machineFmt) {
            onEvent?.({ type: "batchDone", index: idx, totalBatches: chunks.length, completed });
          }
        } catch (err) {
          completed++;
          usageComplete = false;
          const message = err instanceof Error ? err.message : String(err);
          if (!machineFmt) {
            onEvent?.({ type: "batchFailed", index: idx, totalBatches: chunks.length, error: message, completed });
          }
        }
      }),
    ),
  );

  const indices = new Set<number>([...Object.keys(staticIssues), ...Object.keys(aiIssues)].map(Number));
  const sorted = [...indices].sort((a, b) => a - b);

  const report: ReviewItem[] = sorted.map((idx) => {
    const e = entries[idx]!;
    const occs = occurrences(e).map(([file, line]) => (line !== "" ? `${file}:${line}` : file));
    return {
      num: idx + 1,
      msgId: e.msgId,
      occurrences: occs,
      staticIssue: staticIssues[idx] ?? "",
      aiIssue: aiIssues[idx] ?? "",
    };
  });

  const usage = usageComplete && totalUsage.totalTokens > 0 ? totalUsage : null;

  return { outcome: "reviewed", report, total: entries.length, usage };
}
