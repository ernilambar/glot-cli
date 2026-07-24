import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApiServer } from "../../src/cli/server/apiServer.ts";

const TOKEN = "a".repeat(64);

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApiServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /api/ping: valid token returns 200 ok", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ping`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("GET /api/ping: missing Authorization header returns 401 problem+json", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ping`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
    const body = (await res.json()) as { title: string; status: number };
    assert.equal(body.title, "Unauthorized");
    assert.equal(body.status, 401);
  });
});

test("GET /api/ping: wrong token returns 401", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ping`, { headers: { Authorization: "Bearer wrong" } });
    assert.equal(res.status, 401);
  });
});

test("GET /api/ping: wrong-length token returns 401 (exercises the timing-safe length guard)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ping`, { headers: { Authorization: "Bearer short" } });
    assert.equal(res.status, 401);
  });
});

test("auth applies uniformly to unknown routes too", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 401);
  });
});

test("GET /api/nope: unknown route with a valid token returns 404 problem+json", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
    const body = (await res.json()) as { title: string; status: number };
    assert.equal(body.title, "Not Found");
    assert.equal(body.status, 404);
  });
});
