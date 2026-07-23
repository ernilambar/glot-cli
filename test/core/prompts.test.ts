import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBatchPrompt,
  buildReviewPrompt,
  parseBatchResponse,
  parseReviewResponse,
  stripCodeFences,
} from "../../src/core/prompts.ts";

// ---------------------------------------------------------------------------
// parseBatchResponse
// ---------------------------------------------------------------------------

test("parseBatchResponse: JSON", () => {
  const got = parseBatchResponse(`{"1": "नमस्ते", "2": "संसार"}`, 2);
  assert.deepEqual(got, ["नमस्ते", "संसार"]);
});

test("parseBatchResponse: JSON with code fences", () => {
  const got = parseBatchResponse('```json\n{"1": "नमस्ते"}\n```', 1);
  assert.deepEqual(got, ["नमस्ते"]);
});

test("parseBatchResponse: JSON missing key returns empty", () => {
  const got = parseBatchResponse(`{"1": "नमस्ते"}`, 2);
  assert.deepEqual(got, ["नमस्ते", ""]);
});

test("parseBatchResponse: ignores out-of-range keys", () => {
  const got = parseBatchResponse(`{"1": "A", "9": "B"}`, 2);
  assert.deepEqual(got, ["A", ""]);
});

test("parseBatchResponse: regex fallback", () => {
  const got = parseBatchResponse("1. नमस्ते\n2. संसार", 2);
  assert.deepEqual(got, ["नमस्ते", "संसार"]);
});

test("parseBatchResponse: malformed JSON falls back to regex", () => {
  const got = parseBatchResponse("{bad json}\n1. नमस्ते\n2. संसार", 2);
  assert.deepEqual(got, ["नमस्ते", "संसार"]);
});

test("parseBatchResponse: empty returns empty strings", () => {
  const got = parseBatchResponse("", 2);
  assert.deepEqual(got, ["", ""]);
});

// ---------------------------------------------------------------------------
// buildBatchPrompt
// ---------------------------------------------------------------------------

test("buildBatchPrompt: numbered strings present", () => {
  const p = buildBatchPrompt([{ msgId: "Hello", matches: [] }, { msgId: "World", matches: [] }], "ne_NP", "");
  assert.ok(p.includes("1. Hello"));
  assert.ok(p.includes("2. World"));
});

test("buildBatchPrompt: JSON format instruction", () => {
  const p = buildBatchPrompt([{ msgId: "Hello", matches: [] }], "ne_NP", "");
  assert.ok(p.includes("JSON"));
});

test("buildBatchPrompt: glossary terms injected", () => {
  const matches = [{ term: "plugin", info: { translation: "प्लगिन", pos: "noun", note: "" } }];
  const p = buildBatchPrompt([{ msgId: "Install plugin", matches }], "ne_NP", "");
  assert.ok(p.includes("plugin"));
  assert.ok(p.includes("प्लगिन"));
});

test("buildBatchPrompt: duplicate glossary terms deduplicated", () => {
  const matches = [{ term: "plugin", info: { translation: "प्लगिन", pos: "", note: "" } }];
  const p = buildBatchPrompt(
    [
      { msgId: "Install plugin", matches },
      { msgId: "Delete plugin", matches },
    ],
    "ne_NP",
    "",
  );
  const count = p.split("प्लगिन").length - 1;
  assert.equal(count, 1);
});

test("buildBatchPrompt: with system prompt uses short format", () => {
  const p = buildBatchPrompt(
    [{ msgId: "Hello", matches: [] }, { msgId: "World", matches: [] }],
    "ne_NP",
    "You are a translator.",
  );
  assert.ok(p.includes("1. Hello"));
  assert.ok(p.includes("2. World"));
});

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

test("buildReviewPrompt: numbered strings present", () => {
  const p = buildReviewPrompt(["Showing 5 results", "Hello World"]);
  assert.ok(p.includes("1. Showing 5 results"));
  assert.ok(p.includes("2. Hello World"));
});

test("buildReviewPrompt: rules mentioned", () => {
  const p = buildReviewPrompt(["Test"]);
  assert.ok(p.includes("%d"));
  assert.ok(p.includes("%s"));
});

// ---------------------------------------------------------------------------
// parseReviewResponse
// ---------------------------------------------------------------------------

test("parseReviewResponse: valid JSON", () => {
  const got = parseReviewResponse(`{"1": "Hardcoded number", "3": "Hardcoded URL"}`);
  assert.deepEqual(got, { "1": "Hardcoded number", "3": "Hardcoded URL" });
});

test("parseReviewResponse: empty JSON", () => {
  assert.deepEqual(parseReviewResponse("{}"), {});
});

test("parseReviewResponse: strips code fences", () => {
  const got = parseReviewResponse('```json\n{"2": "Hardcoded file name"}\n```');
  assert.deepEqual(got, { "2": "Hardcoded file name" });
});

test("parseReviewResponse: malformed JSON returns empty", () => {
  assert.deepEqual(parseReviewResponse("{bad json}"), {});
});

test("parseReviewResponse: empty string returns empty", () => {
  assert.deepEqual(parseReviewResponse(""), {});
});

test("parseReviewResponse: null values excluded", () => {
  const got = parseReviewResponse(`{"1": "Issue here", "2": null}`);
  assert.deepEqual(got, { "1": "Issue here" });
});

// ---------------------------------------------------------------------------
// stripCodeFences
// ---------------------------------------------------------------------------

test("stripCodeFences: plain", () => {
  assert.equal(stripCodeFences("hello"), "hello");
});

test("stripCodeFences: with fences", () => {
  assert.equal(stripCodeFences('```json\n{"a":1}\n```'), '{"a":1}');
});
