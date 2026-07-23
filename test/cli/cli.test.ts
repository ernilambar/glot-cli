import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "../../src/cli/cli.ts";
import type { GlotConfig } from "../../src/core/config.ts";
import { exitDeps } from "../../src/cli/exit.ts";
import { GlotRuntimeError, GlotValidationError } from "../../src/core/errors.ts";
import { handleError } from "../../src/cli/exit.ts";

class ExitSentinel extends Error {
  code: number;
  constructor(code: number) {
    super(`exit:${code}`);
    this.code = code;
  }
}

function mockExit(t: import("node:test").TestContext): number[] {
  const codes: number[] = [];
  const original = exitDeps.exit;
  t.after(() => {
    exitDeps.exit = original;
  });
  exitDeps.exit = ((code: number) => {
    codes.push(code);
    throw new ExitSentinel(code);
  }) as typeof exitDeps.exit;
  return codes;
}

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

// ---------------------------------------------------------------------------
// handleError: exit-code mapping (GlotValidationError -> 2, GlotRuntimeError -> 1)
// ---------------------------------------------------------------------------

test("handleError: GlotValidationError maps to exit code 2", (t) => {
  const codes = mockExit(t);
  assert.throws(() => handleError(new GlotValidationError("bad input")), ExitSentinel);
  assert.deepEqual(codes, [2]);
});

test("handleError: GlotRuntimeError maps to exit code 1", (t) => {
  const codes = mockExit(t);
  assert.throws(() => handleError(new GlotRuntimeError("io failed")), ExitSentinel);
  assert.deepEqual(codes, [1]);
});

test("handleError: debug flag appends detail for GlotRuntimeError", (t) => {
  mockExit(t);
  let written = "";
  const original = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, "write", (chunk: string) => {
    written += chunk;
    return true;
  });
  t.after(() => {
    process.stderr.write = original;
  });
  assert.throws(() => handleError(new GlotRuntimeError("io failed", "detail here"), true), ExitSentinel);
  assert.match(written, /io failed \(detail here\)/);
});

// ---------------------------------------------------------------------------
// runCli: arg-parsing-layer failures -> exit code 2
// ---------------------------------------------------------------------------

test("runCli: unknown command exits 2", async (t) => {
  const codes = mockExit(t);
  await assert.rejects(() => runCli(["foobar"], baseConfig()), ExitSentinel);
  assert.deepEqual(codes, [2]);
});

test("runCli: missing positional file exits 2", async (t) => {
  const codes = mockExit(t);
  await assert.rejects(() => runCli(["translate"], baseConfig()), ExitSentinel);
  assert.deepEqual(codes, [2]);
});

test("runCli: translate without --lang and no GLOT_LANG exits 2", async (t) => {
  const codes = mockExit(t);
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const p = join(dir, "test.po");
  writeFileSync(p, 'msgid ""\nmsgstr ""\n');
  await assert.rejects(() => runCli(["translate", p], baseConfig({ lang: "" })), ExitSentinel);
  assert.deepEqual(codes, [2]);
});

test("runCli: review with invalid --format choice exits 2", async (t) => {
  const codes = mockExit(t);
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const p = join(dir, "test.pot");
  writeFileSync(p, 'msgid ""\nmsgstr ""\n');
  await assert.rejects(() => runCli(["review", p, "--format", "bogus"], baseConfig()), ExitSentinel);
  assert.deepEqual(codes, [2]);
});

test("runCli: glossary with no subcommand exits 2", async (t) => {
  const codes = mockExit(t);
  await assert.rejects(() => runCli(["glossary"], baseConfig()), ExitSentinel);
  assert.deepEqual(codes, [2]);
});

// ---------------------------------------------------------------------------
// runCli: business-logic failures surfaced through a command -> exit 2 (GlotValidationError)
// ---------------------------------------------------------------------------

test("runCli: status on a missing file exits 2", async (t) => {
  const codes = mockExit(t);
  await assert.rejects(() => runCli(["status", "/no/such/file.po"], baseConfig()), ExitSentinel);
  assert.deepEqual(codes, [2]);
});

// ---------------------------------------------------------------------------
// runCli: successful command path prints expected output, no exit call
// ---------------------------------------------------------------------------

test("runCli: status on a real file prints counts and does not exit", async (t) => {
  mockExit(t); // fail loudly if exit() is unexpectedly called
  let written = "";
  t.mock.method(process.stdout, "write", (chunk: string) => {
    written += chunk;
    return true;
  });

  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const p = join(dir, "test.po");
  writeFileSync(
    p,
    `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Hello"
msgstr "नमस्ते"
`,
  );

  await runCli(["status", p], baseConfig());
  assert.match(written, /Total\s+1/);
  assert.match(written, /Translated\s+1/);
});
