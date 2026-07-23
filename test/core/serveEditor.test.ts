import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GlotConfig } from "../../src/core/config.ts";
import { deps } from "../../src/core/deps.ts";
import { applyEditorEdits, buildEditorView, findCoreMatches, translateSingle } from "../../src/core/operations/serveEditor.ts";
import { PoFile } from "../../src/core/po/poFile.ts";

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

const SAMPLE_PO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Hello"
msgstr ""

msgid "one item"
msgid_plural "%d items"
msgstr[0] ""
msgstr[1] ""

#~ msgid "gone"
#~ msgstr ""
`;

test("buildEditorView: skips header and obsolete entries, preserves order", () => {
  const pf = PoFile.parse(SAMPLE_PO);
  const rows = buildEditorView(pf);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.displayPos, 0);
  assert.equal(rows[0]!.entry.msgId, "Hello");
  assert.equal(rows[0]!.status, "untranslated");
  assert.equal(rows[1]!.entry.msgId, "one item");
});

test("applyEditorEdits: sets msgstr on a plain entry by display position", () => {
  const pf = PoFile.parse(SAMPLE_PO);
  const rows = buildEditorView(pf);
  applyEditorEdits(rows, { entry_0_msgstr: "नमस्ते" });
  assert.equal(rows[0]!.entry.msgStr, "नमस्ते");
});

test("applyEditorEdits: sets msgstr_plural entries by index", () => {
  const pf = PoFile.parse(SAMPLE_PO);
  const rows = buildEditorView(pf);
  applyEditorEdits(rows, {
    entry_1_msgstr_plural_0: "एक वस्तु",
    entry_1_msgstr_plural_1: "%d वस्तुहरू",
  });
  assert.equal(rows[1]!.entry.msgStrPlural[0], "एक वस्तु");
  assert.equal(rows[1]!.entry.msgStrPlural[1], "%d वस्तुहरू");
});

test("applyEditorEdits: ignores fields for unknown display positions", () => {
  const pf = PoFile.parse(SAMPLE_PO);
  const rows = buildEditorView(pf);
  assert.doesNotThrow(() => applyEditorEdits(rows, { entry_99_msgstr: "x" }));
});

test("findCoreMatches: collects distinct translations across contexts, ignoring ctxt", () => {
  const core = {
    Search: "खोज",
    "menu\x04Search": "खोजी गर्नुहोस्",
    "widget\x04Search": "खोज", // duplicate value — deduped
    Home: "गृहपृष्ठ",
  };
  assert.deepEqual(findCoreMatches(core, "Search"), ["खोज", "खोजी गर्नुहोस्"]);
});

test("findCoreMatches: empty when nothing matches", () => {
  assert.deepEqual(findCoreMatches({ Hello: "नमस्ते" }, "World"), []);
});

test("translateSingle: always calls AI, even when the core cache has a match", async (t) => {
  const original = deps.callAI;
  t.after(() => {
    deps.callAI = original;
  });
  deps.callAI = async () => ({ content: `{"1": "संसार"}`, usage: null });

  const result = await translateSingle(baseConfig(), "World", "ne_NP");
  assert.deepEqual(result, { translation: "संसार" });
});

