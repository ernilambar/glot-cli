import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GlotConfig } from "../../src/core/config.ts";
import { deps } from "../../src/core/deps.ts";
import { GlotNotFoundError, GlotValidationError } from "../../src/core/errors.ts";
import type { ApiTranslateInput } from "../../src/core/operations/apiTranslate.ts";
import { runApiTranslate } from "../../src/core/operations/apiTranslate.ts";

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

function baseInput(overrides: Partial<ApiTranslateInput> = {}): ApiTranslateInput {
  return { msgId: "Hello", msgCtxt: "", lang: "ne_NP", mode: "cache-then-ai", ...overrides };
}

function withDeps(t: import("node:test").TestContext, overrides: Partial<typeof deps>): void {
  const original = { ...deps };
  t.after(() => Object.assign(deps, original));
  Object.assign(deps, overrides);
}

// ---------------------------------------------------------------------------
// Locale validation
// ---------------------------------------------------------------------------

test("runApiTranslate: rejects unknown locale", async (t) => {
  withDeps(t, { loadValidLanguages: () => ({ ne_NP: "Nepali" }) });
  await assert.rejects(() => runApiTranslate(baseConfig(), baseInput({ lang: "xx_XX" })), GlotValidationError);
});

// ---------------------------------------------------------------------------
// Mode: cache
// ---------------------------------------------------------------------------

test("runApiTranslate: mode cache, miss -> GlotNotFoundError, no AI config required", async (t) => {
  withDeps(t, { loadCoreTranslations: () => ({}) });
  await assert.rejects(
    () => runApiTranslate(baseConfig({ endpointUrl: "", modelId: "" }), baseInput({ mode: "cache" })),
    GlotNotFoundError,
  );
});

test("runApiTranslate: mode cache, hit -> returns cached value, never calls AI", async (t) => {
  let aiCalled = false;
  withDeps(t, {
    loadCoreTranslations: () => ({ Hello: "नमस्ते" }),
    callAI: async () => {
      aiCalled = true;
      return { content: "", usage: null };
    },
  });
  const result = await runApiTranslate(baseConfig(), baseInput({ mode: "cache" }));
  assert.deepEqual(result, { kind: "singular", translation: "नमस्ते", source: "core" });
  assert.equal(aiCalled, false);
});

// ---------------------------------------------------------------------------
// AI-config fail-fast (mode-scoped)
// ---------------------------------------------------------------------------

test("runApiTranslate: mode ai, missing AI config -> 400-mapped GlotValidationError before any cache lookup", async (t) => {
  let cacheCalled = false;
  withDeps(t, {
    loadCoreTranslations: () => {
      cacheCalled = true;
      return {};
    },
  });
  await assert.rejects(
    () => runApiTranslate(baseConfig({ endpointUrl: "", modelId: "" }), baseInput({ mode: "ai" })),
    GlotValidationError,
  );
  assert.equal(cacheCalled, false);
});

test("runApiTranslate: mode cache-then-ai, missing AI config -> GlotValidationError before any cache lookup", async (t) => {
  let cacheCalled = false;
  withDeps(t, {
    loadCoreTranslations: () => {
      cacheCalled = true;
      return {};
    },
  });
  await assert.rejects(
    () => runApiTranslate(baseConfig({ endpointUrl: "", modelId: "" }), baseInput({ mode: "cache-then-ai" })),
    GlotValidationError,
  );
  assert.equal(cacheCalled, false);
});

// ---------------------------------------------------------------------------
// Mode: cache-then-ai
// ---------------------------------------------------------------------------

test("runApiTranslate: mode cache-then-ai, cache hit skips AI", async (t) => {
  let aiCalled = false;
  withDeps(t, {
    loadCoreTranslations: () => ({ Hello: "नमस्ते" }),
    callAI: async () => {
      aiCalled = true;
      return { content: "", usage: null };
    },
  });
  const result = await runApiTranslate(baseConfig(), baseInput());
  assert.deepEqual(result, { kind: "singular", translation: "नमस्ते", source: "core" });
  assert.equal(aiCalled, false);
});

test("runApiTranslate: mode cache-then-ai, custom translations cache hit skips AI", async (t) => {
  let aiCalled = false;
  withDeps(t, {
    loadCoreTranslations: () => ({}),
    loadTranslationsCache: () => ({ Hello: "custom नमस्ते" }),
    callAI: async () => {
      aiCalled = true;
      return { content: "", usage: null };
    },
  });
  const result = await runApiTranslate(baseConfig(), baseInput());
  assert.deepEqual(result, { kind: "singular", translation: "custom नमस्ते", source: "core" });
  assert.equal(aiCalled, false);
});

test("runApiTranslate: custom translations cache wins over core cache on collision", async (t) => {
  withDeps(t, {
    loadCoreTranslations: () => ({ Hello: "core नमस्ते" }),
    loadTranslationsCache: () => ({ Hello: "custom नमस्ते" }),
  });
  const result = await runApiTranslate(baseConfig(), baseInput());
  assert.deepEqual(result, { kind: "singular", translation: "custom नमस्ते", source: "core" });
});

test("runApiTranslate: mode cache-then-ai, cache miss falls through to AI", async (t) => {
  withDeps(t, {
    loadCoreTranslations: () => ({}),
    callAI: async () => ({ content: `{"1": "नमस्ते"}`, usage: null }),
  });
  const result = await runApiTranslate(baseConfig(), baseInput());
  assert.deepEqual(result, { kind: "singular", translation: "नमस्ते", source: "ai" });
});

test("runApiTranslate: msgctxt and comment reach the AI prompt", async (t) => {
  let seenPrompt = "";
  withDeps(t, {
    loadCoreTranslations: () => ({}),
    callAI: async (_c, prompt) => {
      seenPrompt = prompt;
      return { content: `{"1": "नमस्ते"}`, usage: null };
    },
  });
  await runApiTranslate(baseConfig(), baseInput({ msgCtxt: "verb", comment: "translators: an action" }));
  assert.ok(seenPrompt.includes("Context: verb"));
  assert.ok(seenPrompt.includes("Translator note: translators: an action"));
});

test("runApiTranslate: differing msgctxt yields distinct prompts for identical msgid", async (t) => {
  const prompts: string[] = [];
  withDeps(t, {
    loadCoreTranslations: () => ({}),
    callAI: async (_c, prompt) => {
      prompts.push(prompt);
      return { content: `{"1": "नमस्ते"}`, usage: null };
    },
  });
  await runApiTranslate(baseConfig(), baseInput({ msgId: "Post", msgCtxt: "noun" }));
  await runApiTranslate(baseConfig(), baseInput({ msgId: "Post", msgCtxt: "verb" }));
  assert.ok(prompts[0]!.includes("Context: noun"));
  assert.ok(prompts[1]!.includes("Context: verb"));
  assert.notEqual(prompts[0], prompts[1]);
});

// ---------------------------------------------------------------------------
// Mode: ai
// ---------------------------------------------------------------------------

test("runApiTranslate: mode ai skips the cache even on a hit", async (t) => {
  let cacheCalled = false;
  withDeps(t, {
    loadCoreTranslations: () => {
      cacheCalled = true;
      return { Hello: "नमस्ते" };
    },
    callAI: async () => ({ content: `{"1": "AI संस्करण"}`, usage: null }),
  });
  const result = await runApiTranslate(baseConfig(), baseInput({ mode: "ai" }));
  assert.deepEqual(result, { kind: "singular", translation: "AI संस्करण", source: "ai" });
  assert.equal(cacheCalled, false);
});

// ---------------------------------------------------------------------------
// Shape mismatch — treated as a miss, not an error
// ---------------------------------------------------------------------------

test("runApiTranslate: array cached for a singular request is treated as a miss", async (t) => {
  withDeps(t, {
    loadCoreTranslations: () => ({ Hello: ["a", "b"] }),
    callAI: async () => ({ content: `{"1": "नमस्ते"}`, usage: null }),
  });
  const result = await runApiTranslate(baseConfig(), baseInput());
  assert.deepEqual(result, { kind: "singular", translation: "नमस्ते", source: "ai" });
});

test("runApiTranslate: mode cache with a shape-mismatched value -> GlotNotFoundError, not a crash", async (t) => {
  withDeps(t, { loadCoreTranslations: () => ({ Hello: ["a", "b"] }) });
  await assert.rejects(() => runApiTranslate(baseConfig(), baseInput({ mode: "cache" })), GlotNotFoundError);
});

// ---------------------------------------------------------------------------
// Plural
// ---------------------------------------------------------------------------

function pluralInput(overrides: Partial<ApiTranslateInput> = {}): ApiTranslateInput {
  return baseInput({ msgId: "%d item", msgIdPlural: "%d items", nplurals: 2, ...overrides });
}

test("runApiTranslate: nplurals is required when msgid_plural is present", async () => {
  await assert.rejects(
    () => runApiTranslate(baseConfig(), pluralInput({ nplurals: undefined })),
    GlotValidationError,
  );
});

test("runApiTranslate: plural cache hit returns the cached array", async (t) => {
  withDeps(t, { loadCoreTranslations: () => ({ "%d item": ["%d वस्तु", "%d वस्तुहरू"] }) });
  const result = await runApiTranslate(baseConfig(), pluralInput());
  assert.deepEqual(result, { kind: "plural", translations: ["%d वस्तु", "%d वस्तुहरू"], source: "core" });
});

test("runApiTranslate: cached array length != requested nplurals returns the cached array unchanged", async (t) => {
  withDeps(t, { loadCoreTranslations: () => ({ "%d item": ["%d वस्तु", "%d वस्तुहरू", "%d वस्तु (extra)"] }) });
  const result = await runApiTranslate(baseConfig(), pluralInput({ nplurals: 2 }));
  assert.deepEqual(result, {
    kind: "plural",
    translations: ["%d वस्तु", "%d वस्तुहरू", "%d वस्तु (extra)"],
    source: "core",
  });
});

test("runApiTranslate: plural AI path returns exactly nplurals forms", async (t) => {
  withDeps(t, {
    loadCoreTranslations: () => ({}),
    callAI: async () => ({ content: `["%d वस्तु", "%d वस्तुहरू"]`, usage: null }),
  });
  const result = await runApiTranslate(baseConfig(), pluralInput());
  assert.deepEqual(result, { kind: "plural", translations: ["%d वस्तु", "%d वस्तुहरू"], source: "ai" });
});

test("runApiTranslate: plural mode cache, miss -> GlotNotFoundError, never calls AI", async (t) => {
  let aiCalled = false;
  withDeps(t, {
    loadCoreTranslations: () => ({}),
    callAI: async () => {
      aiCalled = true;
      return { content: "[]", usage: null };
    },
  });
  await assert.rejects(() => runApiTranslate(baseConfig(), pluralInput({ mode: "cache" })), GlotNotFoundError);
  assert.equal(aiCalled, false);
});

test("runApiTranslate: batchDelay is ignored — single-call path never sleeps", async (t) => {
  withDeps(t, {
    loadCoreTranslations: () => ({}),
    callAI: async () => ({ content: `{"1": "नमस्ते"}`, usage: null }),
  });
  const start = performance.now();
  await runApiTranslate(baseConfig({ batchDelay: 1 }), baseInput());
  assert.ok(performance.now() - start < 500, "runApiTranslate must not sleep for batchDelay");
});
