import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureServeToken, tokenPath } from "../../src/cli/server/token.ts";
import type { GlotConfig } from "../../src/core/config.ts";

function baseConfig(overrides: Partial<GlotConfig> = {}): GlotConfig {
  return {
    endpointUrl: "",
    modelId: "",
    apiKey: "",
    lang: "",
    dataDir: join(mkdtempSync(join(tmpdir(), "glot-serve-")), "data"),
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

test("ensureServeToken: creates dataDir and a 64-char hex token on first run", () => {
  const config = baseConfig();
  const { path, token } = ensureServeToken(config);

  assert.equal(path, tokenPath(config));
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(path, "utf8"), token);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("ensureServeToken: reuses an existing token instead of regenerating", () => {
  const config = baseConfig();
  const first = ensureServeToken(config);
  const second = ensureServeToken(config);

  assert.equal(second.token, first.token);
});

test("ensureServeToken: tightens permissions on a pre-existing loose-perm token file", () => {
  const config = baseConfig();
  const dir = mkdtempSync(join(tmpdir(), "glot-serve-existing-"));
  config.dataDir = dir;
  const path = tokenPath(config);
  writeFileSync(path, "a".repeat(64), { mode: 0o644 });

  const { token } = ensureServeToken(config);

  assert.equal(token, "a".repeat(64));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("ensureServeToken: is a no-op idempotent path when dataDir already exists", () => {
  const config = baseConfig();
  ensureServeToken(config);
  assert.doesNotThrow(() => ensureServeToken(config));
  assert.ok(existsSync(config.dataDir));
});
