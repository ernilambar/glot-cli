import assert from "node:assert/strict";
import { test } from "node:test";
import { deps } from "../../src/core/deps.ts";

test("deps: callAI can be swapped and restored", () => {
  const original = deps.callAI;
  const mock = async () => ({ content: "mocked", usage: null });
  deps.callAI = mock;
  assert.equal(deps.callAI, mock);
  deps.callAI = original;
  assert.equal(deps.callAI, original);
});

test("deps: loadValidLanguages default returns the embedded language map", () => {
  const langs = deps.loadValidLanguages();
  assert.ok(Object.keys(langs).length > 0);
});
