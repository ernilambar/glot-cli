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
