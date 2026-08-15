import languages from "../../data/languages.json" with { type: "json" };
import { GlotValidationError } from "./errors.ts";

export function loadValidLanguages(): Record<string, string> {
  return languages as Record<string, string>;
}

export function validateLang(lang: string, langs: Record<string, string>): void {
  if (Object.keys(langs).length > 0 && !(lang in langs)) {
    throw new GlotValidationError(`unknown locale '${lang}'.`);
  }
}

// Human-readable name for a locale code (e.g. "ne_NP" -> "Nepali") — for AI
// prompts, where a name is more reliably understood than a WP-convention
// locale code. Falls back to the code itself if unknown.
export function languageName(lang: string, langs: Record<string, string>): string {
  return langs[lang] ?? lang;
}
