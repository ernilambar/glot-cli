import { callAI as defaultCallAI } from "./ai-client.ts";
import { loadCoreTranslations as defaultLoadCoreTranslations } from "./core-translations.ts";
import { loadValidLanguages as defaultLoadValidLanguages } from "./languages.ts";

// Mutable swap-point object: production code calls deps.callAI(...), never
// the underlying function directly, so tests can substitute mocks — ES export
// bindings can't be reassigned directly, so this uses one mutable object
// instead of separate module-level vars.
export const deps = {
  callAI: defaultCallAI,
  loadCoreTranslations: defaultLoadCoreTranslations,
  loadValidLanguages: defaultLoadValidLanguages,
};
