import { existsSync } from "node:fs";
import type { GlotConfig } from "../config.ts";
import { deps } from "../deps.ts";
import { GlotValidationError } from "../errors.ts";
import { validateLang } from "../languages.ts";
import { coreCacheKey, isTranslated } from "../po/entry.ts";
import { PoFile } from "../po/poFile.ts";

export interface CoreCacheStatus {
  lang: string;
  hits: number;
  untranslated: number;
}

export interface StatusResult {
  input: string;
  total: number;
  translated: number;
  untranslated: number;
  fuzzy: number;
  percentage: number;
  coreCache: CoreCacheStatus | null;
}

export function runStatus(config: GlotConfig, input: string, lang: string): StatusResult {
  if (lang !== "") {
    validateLang(lang, deps.loadValidLanguages());
  }

  if (!existsSync(input)) {
    throw new GlotValidationError(`file not found: ${input}`);
  }

  let pf: PoFile;
  try {
    pf = PoFile.parseFile(input);
  } catch (err) {
    throw new GlotValidationError(`cannot read file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const total = pf.total();
  const translated = pf.translatedCount();
  const untranslated = pf.untranslatedCount();
  const fuzzy = pf.fuzzyCount();
  const percentage = total > 0 ? (translated / total) * 100 : 0;

  let coreCache: CoreCacheStatus | null = null;
  if (lang !== "") {
    const core = deps.loadCoreTranslations(config, lang);
    if (Object.keys(core).length > 0) {
      let hits = 0;
      for (const e of pf.translatableEntries()) {
        if (isTranslated(e)) {
          continue;
        }
        if (coreCacheKey(e) in core) {
          hits++;
        }
      }
      coreCache = { lang, hits, untranslated };
    }
  }

  return { input, total, translated, untranslated, fuzzy, percentage, coreCache };
}
