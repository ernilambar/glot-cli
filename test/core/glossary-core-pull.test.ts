import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GlotConfig } from "../../src/core/config.ts";
import { deps } from "../../src/core/deps.ts";
import { GlotValidationError } from "../../src/core/errors.ts";
import { indexTranslatableEntries, runCoreList, runCorePull } from "../../src/core/operations/corePull.ts";
import { runGlossaryList, runGlossaryPull } from "../../src/core/operations/glossaryPull.ts";
import { PoFile } from "../../src/core/po/poFile.ts";

function baseConfig(overrides: Partial<GlotConfig> = {}): GlotConfig {
  return {
    endpointUrl: "",
    modelId: "",
    apiKey: "",
    lang: "",
    dataDir: "/data",
    glossaryDir: mkdtempSync(join(tmpdir(), "glot-glossary-")),
    promptsDir: "",
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

const fakeLanguages = { ne_NP: "Nepali", es_ES: "Spanish (Spain)" };

// ---------------------------------------------------------------------------
// Locale validation only — the network fetch path itself isn't mocked here.
// ---------------------------------------------------------------------------

test("runGlossaryPull: no locale throws GlotValidationError", async () => {
  await assert.rejects(() => runGlossaryPull(baseConfig(), ""), GlotValidationError);
});

test("runGlossaryPull: invalid locale throws GlotValidationError", async (t) => {
  const original = deps.loadValidLanguages;
  t.after(() => {
    deps.loadValidLanguages = original;
  });
  deps.loadValidLanguages = () => fakeLanguages;
  await assert.rejects(() => runGlossaryPull(baseConfig(), "xx_XX"), GlotValidationError);
});

test("runCorePull: no locale throws GlotValidationError", async () => {
  await assert.rejects(() => runCorePull(baseConfig(), ""), GlotValidationError);
});

test("runCorePull: invalid locale throws GlotValidationError", async (t) => {
  const original = deps.loadValidLanguages;
  t.after(() => {
    deps.loadValidLanguages = original;
  });
  deps.loadValidLanguages = () => fakeLanguages;
  await assert.rejects(() => runCorePull(baseConfig(), "xx_XX"), GlotValidationError);
});

// ---------------------------------------------------------------------------
// Local filesystem listing — no network involved, so fully testable.
// ---------------------------------------------------------------------------

test("runGlossaryList: directory not found", () => {
  const result = runGlossaryList(baseConfig({ glossaryDir: "/no/such/dir" }));
  assert.deepEqual(result, { outcome: "dirNotFound", dir: "/no/such/dir" });
});

test("runGlossaryList: empty directory", () => {
  const result = runGlossaryList(baseConfig());
  assert.deepEqual(result, { outcome: "empty" });
});

test("runGlossaryList: lists .tsv files with entry counts", () => {
  const config = baseConfig();
  writeFileSync(join(config.glossaryDir, "ne_NP.tsv"), "en\tne_NP\npost\tपोस्ट\npage\tपृष्ठ\n");
  const result = runGlossaryList(config);
  assert.equal(result.outcome, "listed");
  if (result.outcome !== "listed") throw new Error("unreachable");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.locale, "ne_NP");
  assert.equal(result.items[0]!.entries, 2);
  assert.equal(result.items[0]!.hasCustom, false);
});

test("runGlossaryList: flags locales with a custom glossary file", () => {
  const config = baseConfig();
  writeFileSync(join(config.glossaryDir, "ne_NP.tsv"), "en\tne_NP\npost\tपोस्ट\n");
  mkdirSync(join(config.glossaryDir, "custom"));
  writeFileSync(join(config.glossaryDir, "custom", "ne_NP.tsv"), "en\tne_NP\nwidget\tविजेट\n");
  const result = runGlossaryList(config);
  assert.equal(result.outcome, "listed");
  if (result.outcome !== "listed") throw new Error("unreachable");
  assert.equal(result.items[0]!.hasCustom, true);
});

test("runCoreList: directory not found", () => {
  const result = runCoreList(baseConfig({ coreDir: "/no/such/dir" }));
  assert.deepEqual(result, { outcome: "dirNotFound", dir: "/no/such/dir" });
});

test("runCoreList: lists .json files with entry counts", () => {
  const config = baseConfig();
  writeFileSync(join(config.coreDir, "ne_NP.json"), JSON.stringify({ Hello: "नमस्ते", World: "संसार" }));
  const result = runCoreList(config);
  assert.equal(result.outcome, "listed");
  if (result.outcome !== "listed") throw new Error("unreachable");
  assert.equal(result.items[0]!.locale, "ne_NP");
  assert.equal(result.items[0]!.entries, 2);
});

// ---------------------------------------------------------------------------
// indexTranslatableEntries — the PO-text-to-cache-index step of runCorePull,
// extracted so plural handling is testable without mocking httpGet.
// ---------------------------------------------------------------------------

const PLURAL_PO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "Hello"
msgstr "नमस्ते"

msgid "%d item"
msgid_plural "%d items"
msgstr[0] "%d वस्तु"
msgstr[1] "%d वस्तुहरू"

msgid "Untranslated"
msgstr ""

#, fuzzy
msgid "Fuzzy"
msgstr "अस्पष्ट"
`;

test("indexTranslatableEntries: singular entry stores plain string", () => {
  const index = indexTranslatableEntries(PoFile.parse(PLURAL_PO));
  assert.equal(index["Hello"], "नमस्ते");
});

test("indexTranslatableEntries: plural entry stores ordered array of msgstr_plural forms", () => {
  const index = indexTranslatableEntries(PoFile.parse(PLURAL_PO));
  assert.deepEqual(index["%d item"], ["%d वस्तु", "%d वस्तुहरू"]);
});

test("indexTranslatableEntries: skips untranslated and fuzzy entries", () => {
  const index = indexTranslatableEntries(PoFile.parse(PLURAL_PO));
  assert.equal("Untranslated" in index, false);
  assert.equal("Fuzzy" in index, false);
});
