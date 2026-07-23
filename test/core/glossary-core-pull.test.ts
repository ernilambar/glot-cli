import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GlotConfig } from "../../src/core/config.ts";
import { deps } from "../../src/core/deps.ts";
import { GlotValidationError } from "../../src/core/errors.ts";
import { runCoreList, runCorePull } from "../../src/core/operations/corePull.ts";
import { runGlossaryList, runGlossaryPull } from "../../src/core/operations/glossaryPull.ts";

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
    maxStrings: 200,
    batchSize: 10,
    concurrency: 1,
    requestTimeout: 0,
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
