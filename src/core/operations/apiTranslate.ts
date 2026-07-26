import type { GlotConfig } from "../config.ts";
import { deps } from "../deps.ts";
import { loadSystemPrompt } from "../core-translations.ts";
import { GlotNotFoundError, GlotRuntimeError, GlotValidationError } from "../errors.ts";
import { buildGlossaryIndex, loadGlossary, matchingGlossaryTerms } from "../glossary.ts";
import { validateLang } from "../languages.ts";
import { coreCacheKey } from "../po/entry.ts";
import { buildBatchPrompt, buildPluralPrompt, parseBatchResponse, parsePluralResponse } from "../prompts.ts";

export type TranslateMode = "cache" | "cache-then-ai" | "ai";

export interface ApiTranslateInput {
  msgId: string;
  msgCtxt: string;
  lang: string;
  mode: TranslateMode;
  msgIdPlural?: string;
  nplurals?: number;
  // Optional translator note (PO `#.` comment), forwarded raw to the prompt.
  comment?: string;
}

export type ApiTranslateResult =
  | { kind: "singular"; translation: string; source: "core" | "ai" }
  | { kind: "plural"; translations: string[]; source: "core" | "ai" };

export async function runApiTranslate(config: GlotConfig, input: ApiTranslateInput): Promise<ApiTranslateResult> {
  validateLang(input.lang, deps.loadValidLanguages());

  const isPlural = input.msgIdPlural !== undefined;
  if (isPlural && input.nplurals === undefined) {
    throw new GlotValidationError("nplurals is required when msgid_plural is present");
  }

  if (input.mode !== "cache") {
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
  }

  if (input.mode !== "ai") {
    const core = deps.loadCoreTranslations(config, input.lang);
    const cached = core[coreCacheKey({ msgCtxt: input.msgCtxt, msgId: input.msgId })];

    // A shape mismatch (array cached for a singular request, or vice versa)
    // is treated as a miss rather than an error — same rule as the CLI's
    // core-hit loop in translate.ts.
    if (isPlural && Array.isArray(cached)) {
      return { kind: "plural", translations: cached, source: "core" };
    }
    if (!isPlural && typeof cached === "string" && cached !== "") {
      return { kind: "singular", translation: cached, source: "core" };
    }

    if (input.mode === "cache") {
      throw new GlotNotFoundError(`no cached translation for '${input.msgId}'`);
    }
  }

  const glossary = loadGlossary(config.glossaryDir, input.lang);
  const glossaryIdx = buildGlossaryIndex(glossary);
  const systemPrompt = loadSystemPrompt(config, input.lang);
  const matches = matchingGlossaryTerms(input.msgId, glossary, glossaryIdx);

  if (isPlural) {
    const prompt = buildPluralPrompt(
      input.msgId,
      input.msgIdPlural!,
      input.nplurals!,
      matches,
      input.lang,
      systemPrompt,
      input.msgCtxt,
      input.comment ?? "",
    );
    const result = await deps.callAI(config, prompt, systemPrompt, 0.1);
    const translations = parsePluralResponse(result.content, input.nplurals!);
    if (translations.every((t) => t === "")) {
      throw new GlotRuntimeError("AI did not return any translations");
    }
    return { kind: "plural", translations, source: "ai" };
  }

  const prompt = buildBatchPrompt(
    [{ msgId: input.msgId, matches, msgCtxt: input.msgCtxt, comment: input.comment ?? "" }],
    input.lang,
    systemPrompt,
  );
  const result = await deps.callAI(config, prompt, systemPrompt, 0.1);
  const [translation] = parseBatchResponse(result.content, 1);
  if (!translation) {
    throw new GlotRuntimeError("AI did not return a translation");
  }
  return { kind: "singular", translation, source: "ai" };
}
