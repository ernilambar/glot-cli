import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GlotConfig } from "../../src/core/config.ts";
import { deps } from "../../src/core/deps.ts";
import { GlotRuntimeError, GlotValidationError } from "../../src/core/errors.ts";
import { runTranslate } from "../../src/core/operations/translate.ts";
import { PoFile } from "../../src/core/po/poFile.ts";

function baseConfig(overrides: Partial<GlotConfig> = {}): GlotConfig {
  return {
    endpointUrl: "http://fake",
    modelId: "m",
    apiKey: "",
    lang: "",
    dataDir: "",
    glossaryDir: mkdtempSync(join(tmpdir(), "glot-glossary-")),
    promptsDir: mkdtempSync(join(tmpdir(), "glot-prompts-")),
    coreDir: mkdtempSync(join(tmpdir(), "glot-core-")),
    translationsDir: mkdtempSync(join(tmpdir(), "glot-translations-")),
    maxStrings: 200,
    batchSize: 10,
    concurrency: 1,
    requestTimeout: 0,
    batchDelay: 0,
    debug: false,
    ...overrides,
  };
}

function writePo(content: string, name = "test.po"): string {
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const untranslatedPO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Hello"
msgstr ""

msgid "World"
msgstr ""
`;

test("runTranslate: missing env vars throws GlotValidationError", async () => {
  const p = writePo(untranslatedPO);
  await assert.rejects(
    () => runTranslate(baseConfig({ endpointUrl: "", modelId: "" }), p, "ne_NP", 0),
    GlotValidationError,
  );
});

test("runTranslate: missing file throws GlotValidationError", async () => {
  await assert.rejects(() => runTranslate(baseConfig(), "/no/such/file.po", "ne_NP", 0), GlotValidationError);
});

test("runTranslate: nothing to do when fully translated", async () => {
  const p = writePo(`msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Hello"
msgstr "नमस्ते"
`);
  const result = await runTranslate(baseConfig(), p, "ne_NP", 0);
  assert.equal(result.outcome, "alreadyTranslated");
});

test("runTranslate: AI translations written to file", async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({});
  deps.callAI = async () => ({ content: `{"1": "नमस्ते", "2": "संसार"}`, usage: null });

  const p = writePo(untranslatedPO);
  const result = await runTranslate(baseConfig(), p, "ne_NP", 0);
  assert.equal(result.outcome, "translated");

  const pf = PoFile.parseFile(p);
  const found: Record<string, string> = {};
  for (const e of pf.translatableEntries()) {
    found[e.msgId] = e.msgStr;
  }
  assert.equal(found["Hello"], "नमस्ते");
  assert.equal(found["World"], "संसार");
});

test("runTranslate: extractedComments and msgctxt reach the batch prompt", async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({});
  let sentPrompt = "";
  deps.callAI = async (_config, prompt) => {
    sentPrompt = prompt;
    return { content: `{"1": "नमस्ते"}`, usage: null };
  };

  const p = writePo(`msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

#. translators: %s is a username
msgctxt "verb"
msgid "Hello %s"
msgstr ""
`);
  const result = await runTranslate(baseConfig(), p, "ne_NP", 0);
  assert.equal(result.outcome, "translated");

  assert.match(sentPrompt, /Context: verb/);
  assert.match(sentPrompt, /Translator note: translators: %s is a username/);
});

test("runTranslate: unwritable file throws GlotRuntimeError", { skip: process.getuid?.() === 0 }, async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({});
  deps.callAI = async () => ({ content: `{"1": "नमस्ते", "2": "संसार"}`, usage: null });

  const p = writePo(untranslatedPO);
  chmodSync(p, 0o444);
  await assert.rejects(() => runTranslate(baseConfig(), p, "ne_NP", 0), GlotRuntimeError);
});

test("runTranslate: core cache skips AI", async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({ Hello: "नमस्ते", World: "संसार" });
  let aiCalled = false;
  deps.callAI = async () => {
    aiCalled = true;
    return { content: "", usage: null };
  };

  const p = writePo(untranslatedPO);
  const events: unknown[] = [];
  const result = await runTranslate(baseConfig(), p, "ne_NP", 0, (e) => events.push(e));

  assert.equal(aiCalled, false);
  assert.equal(result.outcome, "translated");
  assert.ok(events.some((e) => (e as { type: string; count?: number }).type === "coreMatches" && (e as { count: number }).count === 2));
});

test("runTranslate: custom translations cache hit also skips AI, wins over core on collision", async (t) => {
  const original = {
    callAI: deps.callAI,
    loadCoreTranslations: deps.loadCoreTranslations,
    loadTranslationsCache: deps.loadTranslationsCache,
  };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({ Hello: "core नमस्ते", World: "संसार" });
  deps.loadTranslationsCache = () => ({ Hello: "custom नमस्ते" });
  let aiCalled = false;
  deps.callAI = async () => {
    aiCalled = true;
    return { content: "", usage: null };
  };

  const p = writePo(untranslatedPO);
  const result = await runTranslate(baseConfig(), p, "ne_NP", 0);

  assert.equal(aiCalled, false);
  assert.equal(result.outcome, "translated");

  const pf = PoFile.parseFile(p);
  const found: Record<string, string> = {};
  for (const e of pf.translatableEntries()) {
    found[e.msgId] = e.msgStr;
  }
  assert.equal(found["Hello"], "custom नमस्ते");
  assert.equal(found["World"], "संसार");
});

const pluralPO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "%d item"
msgid_plural "%d items"
msgstr[0] ""
msgstr[1] ""
`;

test("runTranslate: plural core-cache hit fills msgstr_plural by index", async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({ "%d item": ["%d वस्तु", "%d वस्तुहरू"] });
  let aiCalled = false;
  deps.callAI = async () => {
    aiCalled = true;
    return { content: "", usage: null };
  };

  const p = writePo(pluralPO);
  const result = await runTranslate(baseConfig(), p, "ne_NP", 0);

  assert.equal(aiCalled, false);
  assert.equal(result.outcome, "translated");

  const pf = PoFile.parseFile(p);
  const [entry] = pf.translatableEntries();
  assert.equal(entry!.msgStrPlural[0], "%d वस्तु");
  assert.equal(entry!.msgStrPlural[1], "%d वस्तुहरू");
});

test("runTranslate: shape-mismatched core value (array for a singular entry) falls through to AI", async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({ Hello: ["a", "b"], World: "संसार" });
  deps.callAI = async () => ({ content: `{"1": "नमस्ते"}`, usage: null });

  const p = writePo(untranslatedPO);
  const result = await runTranslate(baseConfig(), p, "ne_NP", 0);
  assert.equal(result.outcome, "translated");

  const pf = PoFile.parseFile(p);
  const found: Record<string, string> = {};
  for (const e of pf.translatableEntries()) {
    found[e.msgId] = e.msgStr;
  }
  assert.equal(found["Hello"], "नमस्ते"); // came from AI, not the mismatched array
  assert.equal(found["World"], "संसार"); // came from the core cache
});

test("runTranslate: plural cache miss is AI-translated via buildPluralPrompt", async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({});
  let sentPrompt = "";
  deps.callAI = async (_config, prompt) => {
    sentPrompt = prompt;
    return { content: `["%d वस्तु", "%d वस्तुहरू"]`, usage: null };
  };

  const p = writePo(pluralPO);
  const result = await runTranslate(baseConfig(), p, "ne_NP", 0);

  assert.match(sentPrompt, /%d item/);
  assert.match(sentPrompt, /exactly 2 translated forms/); // nplurals read from the Plural-Forms header
  assert.equal(result.outcome, "translated");
  if (result.outcome !== "translated") throw new Error("unreachable");
  assert.equal(result.translated, 1);
  assert.equal(result.failed.length, 0);

  const pf = PoFile.parseFile(p);
  const [entry] = pf.translatableEntries();
  assert.equal(entry!.msgStrPlural[0], "%d वस्तु");
  assert.equal(entry!.msgStrPlural[1], "%d वस्तुहरू");
});

test("runTranslate: plural AI translation missing a form is reported failed", async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({});
  deps.callAI = async () => ({ content: `["%d वस्तु", ""]`, usage: null });

  const p = writePo(pluralPO);
  const result = await runTranslate(baseConfig(), p, "ne_NP", 0);

  assert.equal(result.outcome, "translated");
  if (result.outcome !== "translated") throw new Error("unreachable");
  assert.equal(result.translated, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]!.msgId, "%d item");

  const pf = PoFile.parseFile(p);
  const [entry] = pf.translatableEntries();
  assert.equal(entry!.msgStrPlural[0], "");
  assert.equal(entry!.msgStrPlural[1], "");
});

test("runTranslate: mixed batch — singular entry batched, plural cache-miss gets its own AI call", async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({});
  const prompts: string[] = [];
  deps.callAI = async (_config, prompt) => {
    prompts.push(prompt);
    if (prompt.includes("Singular English form:")) {
      return { content: `["%d वस्तु", "%d वस्तुहरू"]`, usage: null };
    }
    return { content: `{"1": "नमस्ते"}`, usage: null };
  };

  const p = writePo(`msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "Hello"
msgstr ""

msgid "%d item"
msgid_plural "%d items"
msgstr[0] ""
msgstr[1] ""
`);
  const result = await runTranslate(baseConfig(), p, "ne_NP", 0);

  assert.equal(result.outcome, "translated");
  if (result.outcome !== "translated") throw new Error("unreachable");
  assert.equal(result.translated, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(prompts.length, 2); // one batch call for the singular entry, one plural call for the other
  assert.ok(prompts.some((p) => p.includes("Hello") && !p.includes("%d item")));

  const pf = PoFile.parseFile(p);
  const entries = pf.translatableEntries();
  assert.equal(entries[0]!.msgStr, "नमस्ते");
  assert.equal(entries[1]!.msgStrPlural[0], "%d वस्तु");
  assert.equal(entries[1]!.msgStrPlural[1], "%d वस्तुहरू");
});

test("runTranslate: negative limit throws GlotValidationError", async () => {
  const p = writePo(untranslatedPO);
  await assert.rejects(() => runTranslate(baseConfig(), p, "ne_NP", -1), GlotValidationError);
});

test("runTranslate: invalid PO file throws GlotValidationError", async () => {
  const p = writePo("this is not a po file\njust plain text\n", "not_a_po.txt");
  await assert.rejects(() => runTranslate(baseConfig(), p, "ne_NP", 0), GlotValidationError);
});

test("runTranslate: batchDelay > 0 paces sequential batch calls", async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({});
  const timestamps: number[] = [];
  deps.callAI = async () => {
    timestamps.push(performance.now());
    return { content: `{"1": "नमस्ते"}`, usage: null };
  };

  const p = writePo(untranslatedPO);
  await runTranslate(baseConfig({ batchSize: 1, batchDelay: 0.05 }), p, "ne_NP", 0);

  assert.equal(timestamps.length, 2);
  assert.ok(timestamps[1]! - timestamps[0]! >= 45, `expected gap >= ~50ms, got ${timestamps[1]! - timestamps[0]!}`);
});

test("runTranslate: batchDelay = 0 adds no latency", async (t) => {
  const original = { callAI: deps.callAI, loadCoreTranslations: deps.loadCoreTranslations };
  t.after(() => Object.assign(deps, original));
  deps.loadCoreTranslations = () => ({});
  deps.callAI = async () => ({ content: `{"1": "नमस्ते", "2": "संसार"}`, usage: null });

  const p = writePo(untranslatedPO);
  const start = performance.now();
  await runTranslate(baseConfig({ batchDelay: 0 }), p, "ne_NP", 0);
  assert.ok(performance.now() - start < 45, "expected no added latency with batchDelay: 0");
});

test("runTranslate: rejects invalid lang", async (t) => {
  const original = deps.loadValidLanguages;
  t.after(() => {
    deps.loadValidLanguages = original;
  });
  deps.loadValidLanguages = () => ({ ne_NP: "Nepali", es_ES: "Spanish (Spain)" });

  const p = writePo(`msgid ""
msgstr ""
`);
  await assert.rejects(() => runTranslate(baseConfig(), p, "xx_XX", 0), GlotValidationError);
});
