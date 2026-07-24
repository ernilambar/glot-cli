import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiServer } from "../../src/cli/server/apiServer.ts";
import type { GlotConfig } from "../../src/core/config.ts";

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

test("GET /api/ping: valid token returns 200 ok", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/ping`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("GET /api/ping: missing Authorization header returns 401 problem+json", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/ping`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
    const body = (await res.json()) as { title: string; status: number };
    assert.equal(body.title, "Unauthorized");
    assert.equal(body.status, 401);
  });
});

test("GET /api/ping: wrong token returns 401", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/ping`, { headers: { Authorization: "Bearer wrong" } });
    assert.equal(res.status, 401);
  });
});

test("GET /api/ping: wrong-length token returns 401 (exercises the timing-safe length guard)", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/ping`, { headers: { Authorization: "Bearer short" } });
    assert.equal(res.status, 401);
  });
});

test("auth applies uniformly to unknown routes too", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 401);
  });
});

test("GET /api/nope: unknown route with a valid token returns 404 problem+json", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/nope`, { headers: AUTH });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
    const body = (await res.json()) as { title: string; status: number };
    assert.equal(body.title, "Not Found");
    assert.equal(body.status, 404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/languages
// ---------------------------------------------------------------------------

test("GET /api/languages: returns the full locale list", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/languages`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, string>;
    assert.equal(body["ne_NP"], "Nepali");
  });
});

// ---------------------------------------------------------------------------
// GET /api/glossary, /api/glossary/:lang, /api/glossary/:lang/match
// ---------------------------------------------------------------------------

test("GET /api/glossary: flattens an empty directory to []", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/glossary`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test("GET /api/glossary: lists pulled glossary files", async () => {
  const config = baseConfig();
  writeFileSync(join(config.glossaryDir, "ne_NP.tsv"), "en\tne_NP\npost\tपोस्ट\n");
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/glossary`, { headers: AUTH });
    const body = (await res.json()) as { locale: string }[];
    assert.equal(body.length, 1);
    assert.equal(body[0]!.locale, "ne_NP");
  });
});

test("GET /api/glossary/:lang: unknown locale returns 400 problem+json", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/glossary/xx_XX`, { headers: AUTH });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
    const body = (await res.json()) as { title: string; status: number };
    assert.equal(body.status, 400);
  });
});

test("GET /api/glossary/:lang: known locale with no pulled file returns 200 {}", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/glossary/ne_NP`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
  });
});

test("GET /api/glossary/:lang: returns parsed glossary terms", async () => {
  const config = baseConfig();
  writeFileSync(join(config.glossaryDir, "ne_NP.tsv"), "en\tne_NP\tpos\tdescription\npost\tपोस्ट\tnoun\t\n");
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/glossary/ne_NP`, { headers: AUTH });
    const body = (await res.json()) as Record<string, { translation: string }>;
    assert.equal(body["post"]!.translation, "पोस्ट");
  });
});

test("GET /api/glossary/:lang/match: unknown locale returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/glossary/xx_XX/match?text=post`, { headers: AUTH });
    assert.equal(res.status, 400);
  });
});

test("GET /api/glossary/:lang/match: returns glossary terms found in the given text", async () => {
  const config = baseConfig();
  writeFileSync(join(config.glossaryDir, "ne_NP.tsv"), "en\tne_NP\tpos\tdescription\npost\tपोस्ट\tnoun\t\n");
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/glossary/ne_NP/match?text=${encodeURIComponent("Edit this post now")}`, {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { term: string }[];
    assert.deepEqual(body.map((m) => m.term), ["post"]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/core, /api/core/:lang
// ---------------------------------------------------------------------------

test("GET /api/core: flattens an empty directory to []", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/core`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test("GET /api/core: lists pulled core cache files", async () => {
  const config = baseConfig();
  writeFileSync(join(config.coreDir, "ne_NP.json"), JSON.stringify({ Hello: "नमस्ते" }));
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/core`, { headers: AUTH });
    const body = (await res.json()) as { locale: string }[];
    assert.equal(body.length, 1);
    assert.equal(body[0]!.locale, "ne_NP");
  });
});

test("GET /api/core/:lang: unknown locale returns 400", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/core/xx_XX?msgid=Search`, { headers: AUTH });
    assert.equal(res.status, 400);
  });
});

test("GET /api/core/:lang: known locale with no pulled data returns 200 []", async () => {
  await withServer(baseConfig(), async (base) => {
    const res = await fetch(`${base}/api/core/ne_NP?msgid=Search`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test("GET /api/core/:lang: returns context-qualified matches, not just a direct key lookup", async () => {
  const config = baseConfig();
  writeFileSync(
    join(config.coreDir, "ne_NP.json"),
    JSON.stringify({ Search: "खोज", "menu\x04Search": "खोजी गर्नुहोस्" }),
  );
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/core/ne_NP?msgid=Search`, { headers: AUTH });
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
