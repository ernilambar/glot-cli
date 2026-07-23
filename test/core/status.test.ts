import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GlotConfig } from "../../src/core/config.ts";
import { deps } from "../../src/core/deps.ts";
import { GlotValidationError } from "../../src/core/errors.ts";
import { runStatus } from "../../src/core/operations/status.ts";

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

function writePo(content: string, name = "test.po"): string {
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const statusPO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Hello"
msgstr "नमस्ते"

msgid "World"
msgstr "संसार"

msgid "Untranslated string"
msgstr ""

#, fuzzy
msgid "Fuzzy entry"
msgstr "अस्पष्ट"
`;

test("runStatus: counts are correct", () => {
  const p = writePo(statusPO);
  const result = runStatus(baseConfig(), p, "");
  assert.equal(result.total, 4);
  assert.equal(result.translated, 2);
  assert.equal(result.untranslated, 1);
  assert.equal(result.fuzzy, 1);
});

test("runStatus: missing file throws GlotValidationError", () => {
  assert.throws(() => runStatus(baseConfig(), "/nonexistent/file.po", ""), GlotValidationError);
});

test("runStatus: rejects invalid lang", (t) => {
  const original = deps.loadValidLanguages;
  t.after(() => {
    deps.loadValidLanguages = original;
  });
  deps.loadValidLanguages = () => ({ ne_NP: "Nepali", es_ES: "Spanish (Spain)" });

  const p = writePo(`msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
`);
  assert.throws(() => runStatus(baseConfig(), p, "xx_XX"), GlotValidationError);
});

test("runStatus: skips validation when no lang given", (t) => {
  const original = deps.loadValidLanguages;
  t.after(() => {
    deps.loadValidLanguages = original;
  });
  deps.loadValidLanguages = () => ({ ne_NP: "Nepali", es_ES: "Spanish (Spain)" });

  const p = writePo(`msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
`);
  assert.doesNotThrow(() => runStatus(baseConfig(), p, ""));
});

test("runStatus: core cache hits reported when lang given", (t) => {
  const original = deps.loadCoreTranslations;
  t.after(() => {
    deps.loadCoreTranslations = original;
  });
  deps.loadCoreTranslations = () => ({ "Untranslated string": "translated" });

  const p = writePo(statusPO);
  const result = runStatus(baseConfig(), p, "ne_NP");
  assert.deepEqual(result.coreCache, { lang: "ne_NP", hits: 1, untranslated: 1 });
});
