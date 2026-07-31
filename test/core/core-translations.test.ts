import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GlotConfig } from "../../src/core/config.ts";
import {
  buildCoreCacheFold,
  loadCoreTranslations,
  loadMergedCoreCache,
  loadSystemPrompt,
  loadTranslationsCache,
} from "../../src/core/core-translations.ts";
import { deps } from "../../src/core/deps.ts";

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
    translationsDir: "",
    maxStrings: 200,
    batchSize: 10,
    concurrency: 1,
    requestTimeout: 0,
    batchDelay: 0,
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

test("loadCoreTranslations: plural array values load alongside string values", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-core-"));
  writeFileSync(join(dir, "ne_NP.json"), JSON.stringify({ Hello: "नमस्ते", "%d item": ["%d वस्तु", "%d वस्तुहरू"] }));
  assert.deepEqual(loadCoreTranslations(baseConfig({ coreDir: dir }), "ne_NP"), {
    Hello: "नमस्ते",
    "%d item": ["%d वस्तु", "%d वस्तुहरू"],
  });
});

test("loadTranslationsCache: missing file returns empty object", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-translations-"));
  assert.deepEqual(loadTranslationsCache(baseConfig({ translationsDir: dir }), "ne_NP"), {});
});

test("loadTranslationsCache: valid JSON file returns its contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-translations-"));
  writeFileSync(join(dir, "ne_NP.json"), JSON.stringify({ Hello: "custom" }));
  assert.deepEqual(loadTranslationsCache(baseConfig({ translationsDir: dir }), "ne_NP"), { Hello: "custom" });
});

test("loadMergedCoreCache: merges core and translations, translations wins on collision", () => {
  const coreDir = mkdtempSync(join(tmpdir(), "glot-core-"));
  const translationsDir = mkdtempSync(join(tmpdir(), "glot-translations-"));
  writeFileSync(join(coreDir, "ne_NP.json"), JSON.stringify({ Hello: "core", Bye: "core-bye" }));
  writeFileSync(join(translationsDir, "ne_NP.json"), JSON.stringify({ Hello: "custom" }));
  const config = baseConfig({ coreDir, translationsDir });
  assert.deepEqual(loadMergedCoreCache(config, "ne_NP"), { Hello: "custom", Bye: "core-bye" });
});

test("loadMergedCoreCache: goes through deps, so swapped deps are honored", () => {
  const originalCore = deps.loadCoreTranslations;
  const originalTranslations = deps.loadTranslationsCache;
  deps.loadCoreTranslations = () => ({ Hello: "core-mock" });
  deps.loadTranslationsCache = () => ({ Bye: "translations-mock" });
  try {
    assert.deepEqual(loadMergedCoreCache(baseConfig(), "ne_NP"), {
      Hello: "core-mock",
      Bye: "translations-mock",
    });
  } finally {
    deps.loadCoreTranslations = originalCore;
    deps.loadTranslationsCache = originalTranslations;
  }
});

test("buildCoreCacheFold: lowercases keys for case-insensitive lookup", () => {
  assert.deepEqual(buildCoreCacheFold({ Post: "पोस्ट" }), { post: "पोस्ट" });
});

test("buildCoreCacheFold: first entry wins on a lowercase collision", () => {
  assert.deepEqual(buildCoreCacheFold({ Post: "first", post: "second" }), { post: "first" });
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
