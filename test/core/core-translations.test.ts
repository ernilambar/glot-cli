import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GlotConfig } from "../../src/core/config.ts";
import { loadCoreTranslations, loadSystemPrompt } from "../../src/core/core-translations.ts";

function baseConfig(overrides: Partial<GlotConfig> = {}): GlotConfig {
  return {
    endpointUrl: "",
    modelId: "",
    apiKey: "",
    lang: "",
    dataDir: "",
    glossaryDir: "",
    promptsDir: "",
    coreDir: "",
    maxStrings: 200,
    batchSize: 10,
    concurrency: 1,
    requestTimeout: 0,
    debug: false,
    ...overrides,
  };
}

test("loadCoreTranslations: missing file returns empty object", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-core-"));
  assert.deepEqual(loadCoreTranslations(baseConfig({ coreDir: dir }), "ne_NP"), {});
});

test("loadCoreTranslations: valid JSON file returns its contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-core-"));
  writeFileSync(join(dir, "ne_NP.json"), JSON.stringify({ Hello: "नमस्ते" }));
  assert.deepEqual(loadCoreTranslations(baseConfig({ coreDir: dir }), "ne_NP"), { Hello: "नमस्ते" });
});

test("loadCoreTranslations: invalid JSON returns empty object", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-core-"));
  writeFileSync(join(dir, "ne_NP.json"), "not json");
  assert.deepEqual(loadCoreTranslations(baseConfig({ coreDir: dir }), "ne_NP"), {});
});

test("loadSystemPrompt: missing file returns empty string", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-prompts-"));
  assert.equal(loadSystemPrompt(baseConfig({ promptsDir: dir }), "ne_NP"), "");
});

test("loadSystemPrompt: present file is trimmed", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-prompts-"));
  writeFileSync(join(dir, "ne_NP.md"), "  You are a translator.  \n");
  assert.equal(loadSystemPrompt(baseConfig({ promptsDir: dir }), "ne_NP"), "You are a translator.");
});
