import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGlossaryIndex, loadGlossary, matchingGlossaryTerms, tokenize } from "../../src/core/glossary.ts";

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

test("tokenize: basic", () => {
  assert.deepEqual(tokenize("Hello World"), ["hello", "world"]);
});

test("tokenize: punctuation stripped", () => {
  assert.deepEqual(tokenize("Hello, World!"), ["hello", "world"]);
});

test("tokenize: empty string", () => {
  assert.deepEqual(tokenize(""), []);
});

// ---------------------------------------------------------------------------
// loadGlossary: core + custom merge
// ---------------------------------------------------------------------------

test("loadGlossary: custom dir absent is a no-op, core terms load as-is", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-glossary-"));
  writeFileSync(join(dir, "ne_NP.tsv"), "en\tne_NP\tpos\tdescription\npost\tपोस्ट\tnoun\t\n");
  const g = loadGlossary(dir, "ne_NP");
  assert.deepEqual(g, { post: [{ translation: "पोस्ट", pos: "noun", note: "" }] });
});

test("loadGlossary: custom-only term is added alongside core terms", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-glossary-"));
  writeFileSync(join(dir, "ne_NP.tsv"), "en\tne_NP\tpos\tdescription\npost\tपोस्ट\tnoun\t\n");
  mkdirSync(join(dir, "custom"));
  writeFileSync(join(dir, "custom", "ne_NP.tsv"), "en\tne_NP\tpos\tdescription\nwidget\tविजेट\t\t\n");
  const g = loadGlossary(dir, "ne_NP");
  assert.deepEqual(g, {
    post: [{ translation: "पोस्ट", pos: "noun", note: "" }],
    widget: [{ translation: "विजेट", pos: "", note: "" }],
  });
});

test("loadGlossary: custom term wins whole-term on collision, replacing all core pos-variants", () => {
  const dir = mkdtempSync(join(tmpdir(), "glot-glossary-"));
  writeFileSync(
    join(dir, "ne_NP.tsv"),
    "en\tne_NP\tpos\tdescription\npost\tपोस्ट\tnoun\t\npost\tपोस्ट गर्नु\tverb\t\n",
  );
  mkdirSync(join(dir, "custom"));
  writeFileSync(join(dir, "custom", "ne_NP.tsv"), "en\tne_NP\tpos\tdescription\npost\tकस्टम पोस्ट\t\t\n");
  const g = loadGlossary(dir, "ne_NP");
  assert.deepEqual(g, { post: [{ translation: "कस्टम पोस्ट", pos: "", note: "" }] });
});

// ---------------------------------------------------------------------------
// buildGlossaryIndex
// ---------------------------------------------------------------------------

test("buildGlossaryIndex: single-word term", () => {
  const idx = buildGlossaryIndex({ plugin: [{ translation: "प्लगिन", pos: "", note: "" }] });
  assert.ok(idx["plugin"]?.includes("plugin"));
});

test("buildGlossaryIndex: multi-word term indexed by first word", () => {
  const idx = buildGlossaryIndex({ "admin panel": [{ translation: "व्यवस्थापक प्यानल", pos: "", note: "" }] });
  assert.ok(idx["admin"]?.includes("admin panel"));
});

// ---------------------------------------------------------------------------
// matchingGlossaryTerms
// ---------------------------------------------------------------------------

test("matchingGlossaryTerms: single word", () => {
  const g = {
    plugin: [{ translation: "प्लगिन", pos: "noun", note: "" }],
    "admin panel": [{ translation: "व्यवस्थापक प्यानल", pos: "noun", note: "" }],
  };
  const idx = buildGlossaryIndex(g);
  const got = matchingGlossaryTerms("Install plugin", g, idx);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.term, "plugin");
});

test("matchingGlossaryTerms: multi word", () => {
  const g = {
    plugin: [{ translation: "प्लगिन", pos: "noun", note: "" }],
    "admin panel": [{ translation: "व्यवस्थापक प्यानल", pos: "noun", note: "" }],
  };
  const idx = buildGlossaryIndex(g);
  const got = matchingGlossaryTerms("Open the admin panel now", g, idx);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.term, "admin panel");
});

test("matchingGlossaryTerms: no match", () => {
  const g = { plugin: [{ translation: "", pos: "", note: "" }] };
  const idx = buildGlossaryIndex(g);
  assert.equal(matchingGlossaryTerms("Hello World", g, idx).length, 0);
});

test("matchingGlossaryTerms: empty glossary", () => {
  assert.equal(matchingGlossaryTerms("Install plugin", {}, {}).length, 0);
});

test("matchingGlossaryTerms: case insensitive", () => {
  const g = { plugin: [{ translation: "प्लगिन", pos: "", note: "" }] };
  const idx = buildGlossaryIndex(g);
  const got = matchingGlossaryTerms("Install Plugin", g, idx);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.term, "plugin");
});

test("matchingGlossaryTerms: msgctxt selects the matching pos variant", () => {
  const g = {
    post: [
      { translation: "पोस्ट", pos: "noun", note: "" },
      { translation: "पोस्ट गर्नु", pos: "verb", note: "" },
    ],
  };
  const idx = buildGlossaryIndex(g);

  const noun = matchingGlossaryTerms("Post", g, idx, "noun");
  assert.equal(noun[0]!.info.translation, "पोस्ट");

  const verb = matchingGlossaryTerms("Post", g, idx, "verb");
  assert.equal(verb[0]!.info.translation, "पोस्ट गर्नु");
});

test("matchingGlossaryTerms: falls back to first variant when msgctxt has no pos match", () => {
  const g = {
    post: [
      { translation: "पोस्ट", pos: "noun", note: "" },
      { translation: "पोस्ट गर्नु", pos: "verb", note: "" },
    ],
  };
  const idx = buildGlossaryIndex(g);
  assert.equal(matchingGlossaryTerms("Post", g, idx, "")[0]!.info.translation, "पोस्ट");
  assert.equal(matchingGlossaryTerms("Post", g, idx, "adjective")[0]!.info.translation, "पोस्ट");
});
