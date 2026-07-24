import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiServer } from "../../src/cli/server/apiServer.ts";
import type { GlotConfig } from "../../src/core/config.ts";
import { deps } from "../../src/core/deps.ts";

const TOKEN = "a".repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function baseConfig(overrides: Partial<GlotConfig> = {}): GlotConfig {
  return {
    endpointUrl: "",
    modelId: "",
    apiKey: "",
    lang: "",
    dataDir: "",
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

async function withServer(config: GlotConfig, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApiServer(config, TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Auth + routing skeleton (checkpoint 2 behavior, still true with routes added)
// ---------------------------------------------------------------------------

test("GET /api/v1/ping: valid token returns 200 ok", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/ping`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("GET /api/v1/ping: missing Authorization header returns 401 problem+json", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/ping`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
    const body = (await res.json()) as { title: string; status: number };
    assert.equal(body.title, "Unauthorized");
    assert.equal(body.status, 401);
  });
});

test("GET /api/v1/ping: wrong token returns 401", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/ping`, { headers: { Authorization: "Bearer wrong" } });
    assert.equal(res.status, 401);
  });
});

test("GET /api/v1/ping: wrong-length token returns 401 (exercises the timing-safe length guard)", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/ping`, { headers: { Authorization: "Bearer short" } });
    assert.equal(res.status, 401);
  });
});

test("auth applies uniformly to unknown routes too", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/nope`);
    assert.equal(res.status, 401);
  });
});

test("GET /api/v1/nope: unknown route with a valid token returns 404 problem+json", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/nope`, { headers: AUTH });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
    const body = (await res.json()) as { title: string; status: number };
    assert.equal(body.title, "Not Found");
    assert.equal(body.status, 404);
  });
});

test("GET /api/ping: unversioned path (no /v1) returns 404, not the ping route", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/ping`, { headers: AUTH });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/languages
// ---------------------------------------------------------------------------

test("GET /api/v1/languages: returns the full locale list", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/languages`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, string>;
    assert.equal(body["ne_NP"], "Nepali");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/glossary, /api/v1/glossary/:lang, /api/v1/glossary/:lang/match
// ---------------------------------------------------------------------------

test("GET /api/v1/glossary: flattens an empty directory to []", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/glossary`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test("GET /api/v1/glossary: lists pulled glossary files", async () => {
  const config = baseConfig();
  writeFileSync(join(config.glossaryDir, "ne_NP.tsv"), "en\tne_NP\npost\tपोस्ट\n");
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/v1/glossary`, { headers: AUTH });
    const body = (await res.json()) as { locale: string }[];
    assert.equal(body.length, 1);
    assert.equal(body[0]!.locale, "ne_NP");
  });
});

test("GET /api/v1/glossary/:lang: unknown locale returns 400 problem+json", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/glossary/xx_XX`, { headers: AUTH });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
    const body = (await res.json()) as { title: string; status: number };
    assert.equal(body.status, 400);
  });
});

test("GET /api/v1/glossary/:lang: known locale with no pulled file returns 200 {}", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/glossary/ne_NP`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
  });
});

test("GET /api/v1/glossary/:lang: returns parsed glossary terms", async () => {
  const config = baseConfig();
  writeFileSync(join(config.glossaryDir, "ne_NP.tsv"), "en\tne_NP\tpos\tdescription\npost\tपोस्ट\tnoun\t\n");
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/v1/glossary/ne_NP`, { headers: AUTH });
    const body = (await res.json()) as Record<string, { translation: string }>;
    assert.equal(body["post"]!.translation, "पोस्ट");
  });
});

test("GET /api/v1/glossary/:lang/match: unknown locale returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/glossary/xx_XX/match?text=post`, { headers: AUTH });
    assert.equal(res.status, 400);
  });
});

test("GET /api/v1/glossary/:lang/match: returns glossary terms found in the given text", async () => {
  const config = baseConfig();
  writeFileSync(join(config.glossaryDir, "ne_NP.tsv"), "en\tne_NP\tpos\tdescription\npost\tपोस्ट\tnoun\t\n");
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/v1/glossary/ne_NP/match?text=${encodeURIComponent("Edit this post now")}`, {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { term: string }[];
    assert.deepEqual(body.map((m) => m.term), ["post"]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/core, /api/v1/core/:lang
// ---------------------------------------------------------------------------

test("GET /api/v1/core: flattens an empty directory to []", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/core`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test("GET /api/v1/core: lists pulled core cache files", async () => {
  const config = baseConfig();
  writeFileSync(join(config.coreDir, "ne_NP.json"), JSON.stringify({ Hello: "नमस्ते" }));
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/v1/core`, { headers: AUTH });
    const body = (await res.json()) as { locale: string }[];
    assert.equal(body.length, 1);
    assert.equal(body[0]!.locale, "ne_NP");
  });
});

test("GET /api/v1/core/:lang: unknown locale returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/core/xx_XX?msgid=Search`, { headers: AUTH });
    assert.equal(res.status, 400);
  });
});

test("GET /api/v1/core/:lang: known locale with no pulled data returns 200 []", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/core/ne_NP?msgid=Search`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test("GET /api/v1/core/:lang: returns context-qualified matches, not just a direct key lookup", async () => {
  const config = baseConfig();
  writeFileSync(
    join(config.coreDir, "ne_NP.json"),
    JSON.stringify({ Search: "खोज", "menu\x04Search": "खोजी गर्नुहोस्" }),
  );
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/v1/core/ne_NP?msgid=Search`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { value: string; ctxt: string }[];
    assert.deepEqual(
      body.sort((a, b) => a.ctxt.localeCompare(b.ctxt)),
      [
        { value: "खोज", ctxt: "" },
        { value: "खोजी गर्नुहोस्", ctxt: "menu" },
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/translate
// ---------------------------------------------------------------------------

function postTranslate(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/v1/translate`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/v1/translate: invalid JSON body returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/v1/translate`, { method: "POST", headers: AUTH, body: "not json" });
    assert.equal(res.status, 400);
  });
});

test("POST /api/v1/translate: missing msgid returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await postTranslate(base, { lang: "ne_NP" });
    assert.equal(res.status, 400);
  });
});

test("POST /api/v1/translate: missing lang returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await postTranslate(base, { msgid: "Hello" });
    assert.equal(res.status, 400);
  });
});

test("POST /api/v1/translate: unknown locale returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await postTranslate(base, { msgid: "Hello", lang: "xx_XX" });
    assert.equal(res.status, 400);
  });
});

test("POST /api/v1/translate: invalid mode returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await postTranslate(base, { msgid: "Hello", lang: "ne_NP", mode: "bogus" });
    assert.equal(res.status, 400);
  });
});

test("POST /api/v1/translate: msgid_plural without nplurals returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await postTranslate(base, { msgid: "%d item", msgid_plural: "%d items", lang: "ne_NP" });
    assert.equal(res.status, 400);
  });
});

test("POST /api/v1/translate: default mode cache-then-ai, cache hit returns singular shape", async () => {
  const config = baseConfig({ endpointUrl: "http://fake", modelId: "m" });
  writeFileSync(join(config.coreDir, "ne_NP.json"), JSON.stringify({ Hello: "नमस्ते" }));
  await withServer(config, async (base) => {
    const res = await postTranslate(base, { msgid: "Hello", lang: "ne_NP" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { translation: "नमस्ते", source: "core" });
  });
});

test("POST /api/v1/translate: mode cache, miss returns 404 problem+json", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await postTranslate(base, { msgid: "Hello", lang: "ne_NP", mode: "cache" });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
  });
});

test("POST /api/v1/translate: mode ai without AI config returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await postTranslate(base, { msgid: "Hello", lang: "ne_NP", mode: "ai" });
    assert.equal(res.status, 400);
  });
});

test("POST /api/v1/translate: mode ai calls AI and returns singular shape", async (t) => {
  const original = deps.callAI;
  t.after(() => {
    deps.callAI = original;
  });
  deps.callAI = async () => ({ content: `{"1": "नमस्ते"}`, usage: null });

  const config = baseConfig({ endpointUrl: "http://fake", modelId: "m" });
  await withServer(config, async (base) => {
    const res = await postTranslate(base, { msgid: "Hello", lang: "ne_NP", mode: "ai" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { translation: "नमस्ते", source: "ai" });
  });
});

test("POST /api/v1/translate: plural cache hit returns translations array with source core", async () => {
  const config = baseConfig({ endpointUrl: "http://fake", modelId: "m" });
  writeFileSync(join(config.coreDir, "ne_NP.json"), JSON.stringify({ "%d item": ["%d वस्तु", "%d वस्तुहरू"] }));
  await withServer(config, async (base) => {
    const res = await postTranslate(base, {
      msgid: "%d item",
      msgid_plural: "%d items",
      lang: "ne_NP",
      nplurals: 2,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { translations: ["%d वस्तु", "%d वस्तुहरू"], source: "core" });
  });
});

test("POST /api/v1/translate: plural AI path returns translations array with source ai", async (t) => {
  const original = deps.callAI;
  t.after(() => {
    deps.callAI = original;
  });
  deps.callAI = async () => ({ content: `["%d वस्तु", "%d वस्तुहरू"]`, usage: null });

  const config = baseConfig({ endpointUrl: "http://fake", modelId: "m" });
  await withServer(config, async (base) => {
    const res = await postTranslate(base, {
      msgid: "%d item",
      msgid_plural: "%d items",
      lang: "ne_NP",
      nplurals: 2,
      mode: "ai",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { translations: ["%d वस्तु", "%d वस्तुहरू"], source: "ai" });
  });
});
