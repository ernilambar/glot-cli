import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_STRINGS,
  DEFAULT_REQUEST_TIMEOUT,
} from "../core/config.ts";
import type { GlotConfig } from "../core/config.ts";

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

// The only place in the CLI layer that reads process.env, per the core/cli
// boundary: core/ takes GlotConfig as an explicit parameter and never reads
// the environment itself.
export function loadConfigFromEnv(): GlotConfig {
  const dataDir = process.env.GLOT_DATA_DIR || join(homedir(), ".config", "glot-cli");

  return {
    endpointUrl: process.env.GLOT_ENDPOINT_URL ?? "",
    modelId: process.env.GLOT_MODEL_ID ?? "",
    apiKey: process.env.GLOT_API_KEY ?? "",
    lang: process.env.GLOT_LANG ?? "",
    dataDir,
    glossaryDir: join(dataDir, "glossary"),
    promptsDir: join(dataDir, "prompts"),
    coreDir: join(dataDir, "core"),
    maxStrings: parseIntEnv(process.env.GLOT_MAX_STRINGS, DEFAULT_MAX_STRINGS),
    batchSize: parseIntEnv(process.env.GLOT_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    concurrency: parseIntEnv(process.env.GLOT_CONCURRENCY, DEFAULT_CONCURRENCY),
    requestTimeout: parseIntEnv(process.env.GLOT_REQUEST_TIMEOUT, DEFAULT_REQUEST_TIMEOUT),
    debug: false,
  };
}
