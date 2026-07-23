import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GlotConfig } from "./config.ts";

export function loadCoreTranslations(config: GlotConfig, locale: string): Record<string, string> {
  const path = join(config.coreDir, `${locale}.json`);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
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
