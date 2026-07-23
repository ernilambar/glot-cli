import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGlossaryIndex, matchingGlossaryTerms, tokenize } from "../../src/core/glossary.ts";

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
// buildGlossaryIndex
// ---------------------------------------------------------------------------

test("buildGlossaryIndex: single-word term", () => {
  const idx = buildGlossaryIndex({ plugin: { translation: "प्लगिन", pos: "", note: "" } });
  assert.ok(idx["plugin"]?.includes("plugin"));
});

test("buildGlossaryIndex: multi-word term indexed by first word", () => {
  const idx = buildGlossaryIndex({ "admin panel": { translation: "व्यवस्थापक प्यानल", pos: "", note: "" } });
  assert.ok(idx["admin"]?.includes("admin panel"));
});

// ---------------------------------------------------------------------------
// matchingGlossaryTerms
// ---------------------------------------------------------------------------

test("matchingGlossaryTerms: single word", () => {
  const g = {
    plugin: { translation: "प्लगिन", pos: "noun", note: "" },
    "admin panel": { translation: "व्यवस्थापक प्यानल", pos: "noun", note: "" },
  };
  const idx = buildGlossaryIndex(g);
  const got = matchingGlossaryTerms("Install plugin", g, idx);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.term, "plugin");
});

test("matchingGlossaryTerms: multi word", () => {
  const g = {
    plugin: { translation: "प्लगिन", pos: "noun", note: "" },
    "admin panel": { translation: "व्यवस्थापक प्यानल", pos: "noun", note: "" },
  };
  const idx = buildGlossaryIndex(g);
  const got = matchingGlossaryTerms("Open the admin panel now", g, idx);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.term, "admin panel");
});

test("matchingGlossaryTerms: no match", () => {
  const g = { plugin: { translation: "", pos: "", note: "" } };
  const idx = buildGlossaryIndex(g);
  assert.equal(matchingGlossaryTerms("Hello World", g, idx).length, 0);
});

test("matchingGlossaryTerms: empty glossary", () => {
  assert.equal(matchingGlossaryTerms("Install plugin", {}, {}).length, 0);
});

test("matchingGlossaryTerms: case insensitive", () => {
  const g = { plugin: { translation: "प्लगिन", pos: "", note: "" } };
  const idx = buildGlossaryIndex(g);
  const got = matchingGlossaryTerms("Install Plugin", g, idx);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.term, "plugin");
});
