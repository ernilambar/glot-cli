import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GlotConfig } from "../../src/core/config.ts";
import { deps } from "../../src/core/deps.ts";
import { GlotValidationError } from "../../src/core/errors.ts";
import { runTranslationsImport, runTranslationsList } from "../../src/core/operations/translationsImport.ts";

function baseConfig(overrides: Partial<GlotConfig> = {}): GlotConfig {
  return {
    endpointUrl: "",
    modelId: "",
    apiKey: "",
    lang: "",
    dataDir: "/data",
    glossaryDir: "",
    promptsDir: "",
    coreDir: "",
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

function writePo(path: string, entries: Record<string, string>): void {
  let body = 'msgid ""\nmsgstr ""\n\n';
  for (const [id, str] of Object.entries(entries)) {
    body += `msgid "${id}"\nmsgstr "${str}"\n\n`;
  }
  writeFileSync(path, body);
}

// ---------------------------------------------------------------------------
// runTranslationsImport: validation
// ---------------------------------------------------------------------------

test("runTranslationsImport: rejects empty locale", () => {
  assert.throws(() => runTranslationsImport(baseConfig(), "", ["a.po"]), GlotValidationError);
});

test("runTranslationsImport: rejects unknown locale", () => {
  const original = deps.loadValidLanguages;
  deps.loadValidLanguages = () => ({ ne_NP: "Nepali" });
  try {
    assert.throws(() => runTranslationsImport(baseConfig(), "xx_XX", ["a.po"]), GlotValidationError);
  } finally {
    deps.loadValidLanguages = original;
  }
});

test("runTranslationsImport: rejects empty file list", () => {
  assert.throws(() => runTranslationsImport(baseConfig(), "ne_NP", []), GlotValidationError);
});

test("runTranslationsImport: rejects a missing file", () => {
  assert.throws(() => runTranslationsImport(baseConfig(), "ne_NP", ["/no/such/file.po"]), GlotValidationError);
});

// ---------------------------------------------------------------------------
// runTranslationsImport: multi-file merge, later file wins
// ---------------------------------------------------------------------------

test("runTranslationsImport: single file writes translationsDir/<locale>.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const a = join(dir, "a.po");
  writePo(a, { Hello: "Namaste" });

  const config = baseConfig();
  const result = runTranslationsImport(config, "ne_NP", [a]);

  assert.equal(result.entries, 1);
  assert.deepEqual(JSON.parse(readFileSync(result.savedPath, "utf8")), { Hello: "Namaste" });
});

test("runTranslationsImport: multiple files merge, later file wins on collision", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const a = join(dir, "a.po");
  const b = join(dir, "b.po");
  writePo(a, { Hello: "A version", Bye: "Bye A" });
  writePo(b, { Hello: "B version" });

  const config = baseConfig();
  const result = runTranslationsImport(config, "ne_NP", [a, b]);

  assert.deepEqual(JSON.parse(readFileSync(result.savedPath, "utf8")), { Hello: "B version", Bye: "Bye A" });
});

test("runTranslationsImport: directory args expand non-recursively to sorted *.po children", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  writePo(join(dir, "a.po"), { A: "a", Z: "a-loses" });
  writePo(join(dir, "z.po"), { Z: "z-wins" });
  mkdirSync(join(dir, "nested"));
  writePo(join(dir, "nested", "n.po"), { Nested: "should not be picked up" });
  writeFileSync(join(dir, "not-a-po.txt"), "ignore me");

  const config = baseConfig();
  const result = runTranslationsImport(config, "ne_NP", [dir]);

  // a.po sorts before z.po alphabetically, so z.po's "Z" wins.
  assert.deepEqual(JSON.parse(readFileSync(result.savedPath, "utf8")), { A: "a", Z: "z-wins" });
  assert.equal(result.entries, 2);
});

test("runTranslationsImport: directories and explicit files mix, later-wins order follows argument order", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  writePo(join(dir, "a.po"), { Hello: "from-dir" });
  const explicit = join(dir, "explicit.po");
  writePo(explicit, { Hello: "from-explicit" });

  const config = baseConfig();
  const result = runTranslationsImport(config, "ne_NP", [dir, explicit]);
  assert.deepEqual(JSON.parse(readFileSync(result.savedPath, "utf8")), { Hello: "from-explicit" });
});

// ---------------------------------------------------------------------------
// runTranslationsImport: empty-result warning signal
// ---------------------------------------------------------------------------

test("runTranslationsImport: combined zero entries still writes, reports entries=0", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const empty = join(dir, "empty.po");
  writeFileSync(empty, 'msgid ""\nmsgstr ""\n');

  const config = baseConfig();
  const result = runTranslationsImport(config, "ne_NP", [empty]);
  assert.equal(result.entries, 0);
  assert.deepEqual(JSON.parse(readFileSync(result.savedPath, "utf8")), {});
});

// ---------------------------------------------------------------------------
// runTranslationsImport: --mode overwrite (default) vs --mode merge
// ---------------------------------------------------------------------------

test("runTranslationsImport: mode overwrite (default) replaces the existing cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const a = join(dir, "a.po");
  const b = join(dir, "b.po");
  writePo(a, { Hello: "A", Bye: "Bye A" });
  writePo(b, { OnlyB: "B" });

  const config = baseConfig();
  runTranslationsImport(config, "ne_NP", [a]);
  const result = runTranslationsImport(config, "ne_NP", [b]);

  assert.deepEqual(JSON.parse(readFileSync(result.savedPath, "utf8")), { OnlyB: "B" });
});

test("runTranslationsImport: mode merge layers new files onto the existing cache, new files win on collision", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const a = join(dir, "a.po");
  const b = join(dir, "b.po");
  writePo(a, { Hello: "A version", Bye: "Bye A" });
  writePo(b, { Hello: "B version" });

  const config = baseConfig();
  runTranslationsImport(config, "ne_NP", [a]);
  const result = runTranslationsImport(config, "ne_NP", [b], "merge");

  assert.deepEqual(JSON.parse(readFileSync(result.savedPath, "utf8")), { Hello: "B version", Bye: "Bye A" });
});

// ---------------------------------------------------------------------------
// runTranslationsList
// ---------------------------------------------------------------------------

test("runTranslationsList: directory not found", () => {
  const result = runTranslationsList(baseConfig({ translationsDir: "/no/such/dir" }));
  assert.deepEqual(result, { outcome: "dirNotFound", dir: "/no/such/dir" });
});

test("runTranslationsList: empty directory", () => {
  const result = runTranslationsList(baseConfig());
  assert.deepEqual(result, { outcome: "empty" });
});

test("runTranslationsList: lists .json files with entry counts", () => {
  const config = baseConfig();
  writeFileSync(join(config.translationsDir, "ne_NP.json"), JSON.stringify({ Hello: "Namaste", Bye: "Bidai" }));
  const result = runTranslationsList(config);
  assert.equal(result.outcome, "listed");
  if (result.outcome !== "listed") throw new Error("unreachable");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.locale, "ne_NP");
  assert.equal(result.items[0]!.entries, 2);
});
