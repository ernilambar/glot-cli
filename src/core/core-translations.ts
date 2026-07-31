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
