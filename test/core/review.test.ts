import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GlotConfig } from "../../src/core/config.ts";
import { deps } from "../../src/core/deps.ts";
import { GlotValidationError } from "../../src/core/errors.ts";
import { runReview } from "../../src/core/operations/review.ts";

function baseConfig(overrides: Partial<GlotConfig> = {}): GlotConfig {
  return {
    endpointUrl: "http://fake",
    modelId: "m",
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

function writePo(content: string, name = "test.pot"): string {
  const dir = mkdtempSync(join(tmpdir(), "glot-po-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const potContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

#: src/admin.php:42
msgid "Showing 5 results"
msgstr ""

#: src/core.php:10
#. translators: %s is a file name
msgid "Error in %s detected"
msgstr ""

#: src/settings.php:99
msgid "Save settings %s"
msgstr ""

#: src/misc.php:5
msgid "Hello World"
msgstr ""
`;

function mockCallAI(t: import("node:test").TestContext, fn: typeof deps.callAI) {
  const original = deps.callAI;
  t.after(() => {
    deps.callAI = original;
  });
  deps.callAI = fn;
}

test("runReview: missing env vars throws GlotValidationError", async () => {
  const p = writePo(potContent);
  await assert.rejects(() => runReview(baseConfig({ endpointUrl: "", modelId: "" }), p, "text"), GlotValidationError);
});

test("runReview: missing file throws GlotValidationError", async () => {
  await assert.rejects(() => runReview(baseConfig(), "/no/such/file.pot", "text"), GlotValidationError);
});

test("runReview: static check flags placeholder without translator comment", async (t) => {
  mockCallAI(t, async () => ({ content: "{}", usage: null }));
  const p = writePo(potContent);
  const result = await runReview(baseConfig(), p, "text");
  assert.equal(result.outcome, "reviewed");
  if (result.outcome !== "reviewed") throw new Error("unreachable");
  const item = result.report.find((r) => r.msgId === "Save settings %s");
  assert.ok(item, "expected an item for 'Save settings %s'");
  assert.match(item.staticIssue, /translators/);
});

test("runReview: static check ignores placeholder with translator comment", async (t) => {
  mockCallAI(t, async () => ({ content: "{}", usage: null }));
  const p = writePo(potContent);
  const result = await runReview(baseConfig(), p, "text");
  if (result.outcome !== "reviewed") throw new Error("unreachable");
  assert.ok(!result.report.some((r) => r.msgId === "Error in %s detected"));
});

test("runReview: AI issues appear in report", async (t) => {
  mockCallAI(t, async () => ({ content: `{"1": "Hardcoded number — use %d"}`, usage: null }));
  const p = writePo(potContent);
  const result = await runReview(baseConfig(), p, "text");
  if (result.outcome !== "reviewed") throw new Error("unreachable");
  const item = result.report.find((r) => r.msgId === "Showing 5 results");
  assert.ok(item);
  assert.match(item.aiIssue, /Hardcoded number/);
});

test("runReview: occurrence shown in report", async (t) => {
  mockCallAI(t, async () => ({ content: `{"1": "Hardcoded number — use %d"}`, usage: null }));
  const p = writePo(potContent);
  const result = await runReview(baseConfig(), p, "text");
  if (result.outcome !== "reviewed") throw new Error("unreachable");
  const item = result.report.find((r) => r.msgId === "Showing 5 results");
  assert.ok(item?.occurrences.includes("src/admin.php:42"));
});

test("runReview: no issues when clean", async (t) => {
  mockCallAI(t, async () => ({ content: "{}", usage: null }));
  const p = writePo(`msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

#: src/misc.php:5
msgid "Hello World"
msgstr ""
`);
  const result = await runReview(baseConfig(), p, "text");
  if (result.outcome !== "reviewed") throw new Error("unreachable");
  assert.equal(result.report.length, 0);
});

test("runReview: failed batch does not throw, emits batchFailed event", async (t) => {
  mockCallAI(t, async () => {
    throw new Error("API down");
  });
  const p = writePo(potContent);
  const events: unknown[] = [];
  const result = await runReview(baseConfig(), p, "text", (e) => events.push(e));
  assert.equal(result.outcome, "reviewed");
  assert.ok(events.some((e) => (e as { type: string }).type === "batchFailed"));
});

test("runReview: machine formats (json/csv/markdown) suppress progress events", async (t) => {
  mockCallAI(t, async () => ({ content: `{"1": "Hardcoded number"}`, usage: null }));
  const p = writePo(potContent);
  const events: unknown[] = [];
  await runReview(baseConfig(), p, "json", (e) => events.push(e));
  assert.equal(events.length, 0);
});

test("runReview: no strings found", async () => {
  const p = writePo(`msgid ""
msgstr ""
`);
  const result = await runReview(baseConfig(), p, "text");
  assert.equal(result.outcome, "noStrings");
});
