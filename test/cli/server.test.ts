import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEditorServer } from "../../src/cli/server/httpServer.ts";
import type { GlotConfig } from "../../src/core/config.ts";
import { deps } from "../../src/core/deps.ts";

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
    maxStrings: 200,
    batchSize: 10,
    concurrency: 1,
    requestTimeout: 0,
    debug: false,
    ...overrides,
  };
}

function writePo(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "glot-serve-"));
  const p = join(dir, "test.po");
  writeFileSync(p, content);
  return p;
}

const SAMPLE_PO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Hello"
msgstr ""
`;

async function withServer(
  config: GlotConfig,
  input: string,
  lang: string,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createEditorServer(config, input, lang);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /: renders entries with AI-translate buttons when configured", async () => {
  const p = writePo(SAMPLE_PO);
  await withServer(baseConfig(), p, "ne_NP", async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Hello/);
    assert.match(html, /data-translate=/);
  });
});

test("GET /: hides AI-translate buttons when not configured", async () => {
  const p = writePo(SAMPLE_PO);
  await withServer(baseConfig({ endpointUrl: "", modelId: "" }), p, "", async (base) => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.doesNotMatch(html, /data-translate=/);
  });
});

test("GET /: hides AI-translate buttons when AI is configured but no lang is given", async () => {
  const p = writePo(SAMPLE_PO);
  await withServer(baseConfig(), p, "", async (base) => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.doesNotMatch(html, /data-translate=/);
  });
});

test("GET /: shows every approved core-cache match as a clickable chip", async (t) => {
  const original = deps.loadCoreTranslations;
  t.after(() => {
    deps.loadCoreTranslations = original;
  });
  deps.loadCoreTranslations = () => ({
    Hello: "नमस्ते",
    "menu\x04Hello": "नमस्कार",
  });

  const p = writePo(SAMPLE_PO);
  await withServer(baseConfig(), p, "ne_NP", async (base) => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.match(html, /data-suggestion="नमस्ते"/);
    assert.match(html, /data-suggestion="नमस्कार"/);
    assert.match(html, /class="suggestion-tag">WP</);
  });
});

test("GET /: shows no approved chips without a lang", async (t) => {
  const original = deps.loadCoreTranslations;
  t.after(() => {
    deps.loadCoreTranslations = original;
  });
  deps.loadCoreTranslations = () => ({ Hello: "नमस्ते" });

  const p = writePo(SAMPLE_PO);
  await withServer(baseConfig(), p, "", async (base) => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.doesNotMatch(html, /data-suggestion=/);
  });
});

test("POST /api/translate: 400s when no lang is configured", async () => {
  const p = writePo(SAMPLE_PO);
  await withServer(baseConfig(), p, "", async (base) => {
    const res = await fetch(`${base}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgid: "Hello" }),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /save: persists edits and writes a .bak backup", async () => {
  const p = writePo(SAMPLE_PO);
  await withServer(baseConfig(), p, "ne_NP", async (base) => {
    const body = new URLSearchParams({ entry_0_msgstr: "नमस्ते" }).toString();
    const res = await fetch(`${base}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    assert.equal(res.status, 200); // fetch follows the 302 redirect to "/"
    const html = await res.text();
    assert.match(html, /Saved/);
    assert.match(readFileSync(p, "utf8"), /msgstr "नमस्ते"/);
    assert.ok(existsSync(`${p}.bak`));
  });
});

test("POST /api/translate: returns an AI translation as JSON", async (t) => {
  const original = deps.callAI;
  t.after(() => {
    deps.callAI = original;
  });
  deps.callAI = async () => ({ content: `{"1": "नमस्ते"}`, usage: null });

  const p = writePo(SAMPLE_PO);
  await withServer(baseConfig(), p, "ne_NP", async (base) => {
    const res = await fetch(`${base}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgid: "Hello" }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { translation: string };
    assert.equal(data.translation, "नमस्ते");
  });
});

test("POST /api/translate: calls AI even when the core cache has a match for the msgid", async (t) => {
  const originalCallAI = deps.callAI;
  const originalCore = deps.loadCoreTranslations;
  t.after(() => {
    deps.callAI = originalCallAI;
    deps.loadCoreTranslations = originalCore;
  });
  deps.loadCoreTranslations = () => ({ Hello: "नमस्ते" });
  deps.callAI = async () => ({ content: `{"1": "AI संस्करण"}`, usage: null });

  const p = writePo(SAMPLE_PO);
  await withServer(baseConfig(), p, "ne_NP", async (base) => {
    const res = await fetch(`${base}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgid: "Hello" }),
    });
    const data = (await res.json()) as { translation: string };
    assert.equal(data.translation, "AI संस्करण");
  });
});

test("POST /api/translate: 400s on a missing msgid", async () => {
  const p = writePo(SAMPLE_PO);
  await withServer(baseConfig(), p, "ne_NP", async (base) => {
    const res = await fetch(`${base}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgid: "" }),
    });
    assert.equal(res.status, 400);
  });
});
