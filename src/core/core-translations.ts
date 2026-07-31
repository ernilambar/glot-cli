import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GlotConfig } from "./config.ts";
import { deps } from "./deps.ts";

function loadCacheFile(dir: string, locale: string): Record<string, string | string[]> {
  const path = join(dir, `${locale}.json`);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, string | string[]>;
    }
    return {};
  } catch {
    return {};
  }
}

export function loadCoreTranslations(config: GlotConfig, locale: string): Record<string, string | string[]> {
  return loadCacheFile(config.coreDir, locale);
}

export function loadTranslationsCache(config: GlotConfig, locale: string): Record<string, string | string[]> {
  return loadCacheFile(config.translationsDir, locale);
}

export function loadMergedCoreCache(config: GlotConfig, locale: string): Record<string, string | string[]> {
  return {
    ...deps.loadCoreTranslations(config, locale),
    ...deps.loadTranslationsCache(config, locale),
  };
}

// Lowercased-key index over a merged cache, for case-insensitive fallback
// lookups. First entry wins on a lowercase collision — this index only
// backs a "no exact match" fallback, so it never needs to represent both.
export function buildCoreCacheFold(core: Record<string, string | string[]>): Record<string, string | string[]> {
  const fold: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(core)) {
    const folded = key.toLowerCase();
    if (!(folded in fold)) {
      fold[folded] = value;
    }
  }
  return fold;
}

export function loadSystemPrompt(config: GlotConfig, targetLang: string): string {
  const path = join(config.promptsDir, `${targetLang}.md`);
  if (!existsSync(path)) {
    return "";
  }
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
