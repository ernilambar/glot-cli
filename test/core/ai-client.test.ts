import assert from "node:assert/strict";
import { test } from "node:test";
import { callAI } from "../../src/core/ai-client.ts";
import type { GlotConfig } from "../../src/core/config.ts";
import { GlotRuntimeError } from "../../src/core/errors.ts";

function baseConfig(overrides: Partial<GlotConfig> = {}): GlotConfig {
  return {
    endpointUrl: "http://fake/v1",
    modelId: "test-model",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("callAI: appends /chat/completions to the base URL", async (t) => {
  let requestedUrl: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requestedUrl = url;
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  });
  await callAI(baseConfig({ endpointUrl: "http://fake/v1/" }), "prompt", "", 0.1);
  assert.equal(requestedUrl, "http://fake/v1/chat/completions");
});

test("callAI: sends a stable x-opencode-session header to OpenCode endpoints", async (t) => {
  const sessions: string[] = [];
  let userAgent: string | null = null;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    sessions.push(headers.get("x-opencode-session") ?? "");
    userAgent = headers.get("user-agent");
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  });

  const config = baseConfig({ endpointUrl: "https://opencode.ai/inference/go" });
  await callAI(config, "prompt", "", 0.1);
  await callAI(config, "prompt", "", 0.1);

  assert.match(sessions[0] ?? "", /^ses_[0-9a-f]{32}$/);
  assert.equal(sessions[0], sessions[1]);
  assert.match(userAgent ?? "", /^glot-cli\//);
});

test("callAI: omits x-opencode-session for non-OpenCode endpoints", async (t) => {
  let hasSession = true;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    hasSession = new Headers(init.headers).has("x-opencode-session");
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  });

  await callAI(baseConfig({ endpointUrl: "https://api.openai.com/v1" }), "prompt", "", 0.1);
  assert.equal(hasSession, false);

  await callAI(baseConfig({ endpointUrl: "https://opencode.ai.evil.example/v1" }), "prompt", "", 0.1);
  assert.equal(hasSession, false);
});

test("callAI: success with usage", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({
      choices: [{ message: { content: " नमस्ते " } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
  const result = await callAI(baseConfig(), "prompt", "", 0.1);
  assert.equal(result.content, "नमस्ते");
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
});

test("callAI: success without usage block sets usage to null", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
  const result = await callAI(baseConfig(), "prompt", "", 0.1);
  assert.equal(result.usage, null);
});

test("callAI: no choices throws friendly error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ choices: [] }));
  await assert.rejects(
    () => callAI(baseConfig(), "prompt", "", 0.1),
    (err: unknown) => {
      assert.ok(err instanceof GlotRuntimeError);
      assert.equal(err.message, "AI returned an unexpected response");
      return true;
    },
  );
});

test("callAI: non-JSON success body is included in the error detail", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("gateway said hello", { status: 200 }));
  await assert.rejects(
    () => callAI(baseConfig(), "prompt", "", 0.1),
    (err: unknown) => {
      assert.ok(err instanceof GlotRuntimeError);
      assert.equal(err.message, "AI returned an unexpected response");
      assert.match(err.detail ?? "", /gateway said hello/);
      return true;
    },
  );
});

test("callAI: 401 mentions GLOT_API_KEY", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 401 }));
  await assert.rejects(() => callAI(baseConfig(), "p", "", 0), /GLOT_API_KEY/);
});

test("callAI: 404 mentions GLOT_ENDPOINT_URL", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 404 }));
  await assert.rejects(() => callAI(baseConfig(), "p", "", 0), /GLOT_ENDPOINT_URL/);
});

test("callAI: 400 mentions GLOT_MODEL_ID", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 400 }));
  await assert.rejects(() => callAI(baseConfig(), "p", "", 0), /GLOT_MODEL_ID/);
});

test("callAI: surfaces MissingSessionID as an OpenCode session-header error", async (t) => {
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "MissingSessionID",
      message: "Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed efficiently.",
    },
  });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 400 }));

  await assert.rejects(
    () => callAI(baseConfig(), "p", "", 0),
    (err: unknown) => {
      assert.ok(err instanceof GlotRuntimeError);
      assert.match(err.message, /OpenCode session header/);
      assert.match(err.message, /missing x-opencode-session/);
      assert.equal(err.detail, `HTTP 400: ${body}`);
      return true;
    },
  );
});

test("callAI: exposes the provider's error message instead of swallowing it", async (t) => {
  const body = JSON.stringify({ error: { message: "model 'foo' does not exist" } });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 401 }));

  await assert.rejects(
    () => callAI(baseConfig(), "p", "", 0),
    (err: unknown) => {
      assert.ok(err instanceof GlotRuntimeError);
      assert.match(err.message, /GLOT_API_KEY/);
      assert.match(err.message, /model 'foo' does not exist/);
      return true;
    },
  );
});

test("callAI: exposes a plain-text error body", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("upstream unavailable", { status: 502 }));

  await assert.rejects(
    () => callAI(baseConfig(), "p", "", 0),
    (err: unknown) => {
      assert.ok(err instanceof GlotRuntimeError);
      assert.match(err.message, /HTTP 502/);
      assert.match(err.message, /upstream unavailable/);
      return true;
    },
  );
});

test("callAI: network failure throws immediately without retry", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("connection refused");
  });
  await assert.rejects(() => callAI(baseConfig(), "p", "", 0), /could not reach AI endpoint/);
  assert.equal(calls, 1);
});

test("callAI: retries on 429 three times with backoff, then throws", async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  t.mock.method(globalThis, "setTimeout", ((fn: () => void, ms: number) => {
    delays.push(ms);
    return realSetTimeout(fn, 0);
  }) as typeof setTimeout);

  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("", { status: 429 });
  });

  await assert.rejects(
    () => callAI(baseConfig(), "p", "", 0),
    (err: unknown) => {
      assert.ok(err instanceof GlotRuntimeError);
      assert.match(err.message, /rate-limiting/);
      return true;
    },
  );

  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000, 4000]);
});
