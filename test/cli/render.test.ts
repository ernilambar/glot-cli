import assert from "node:assert/strict";
import { test } from "node:test";
import { renderCoreList, renderGlossaryList, renderReviewReport, renderStatus } from "../../src/cli/render.ts";
import type { ReviewItem } from "../../src/core/operations/review.ts";

function sampleReport(): ReviewItem[] {
  return [
    {
      num: 3,
      msgId: "Showing 5 results",
      occurrences: ["src/admin.php:42"],
      staticIssue: "",
      aiIssue: "Hardcoded number '5' — use %d",
    },
  ];
}

test("renderReviewReport: text shows string label", () => {
  const out = renderReviewReport(sampleReport(), 10, "text", null);
  assert.match(out, /String: "Showing 5 results"/);
});

test("renderReviewReport: text shows occurrence", () => {
  const out = renderReviewReport(sampleReport(), 10, "text", null);
  assert.match(out, /src\/admin\.php:42/);
});

test("renderReviewReport: text shows issue", () => {
  const out = renderReviewReport(sampleReport(), 10, "text", null);
  assert.match(out, /Issue:/);
  assert.match(out, /Hardcoded number/);
});

test("renderReviewReport: text no issues", () => {
  const out = renderReviewReport([], 10, "text", null);
  assert.match(out, /No issues found/);
});

test("renderReviewReport: text truncates long msgid", () => {
  const long = "A".repeat(100);
  const report: ReviewItem[] = [{ num: 1, msgId: long, occurrences: [], staticIssue: "Too long", aiIssue: "" }];
  const out = renderReviewReport(report, 1, "text", null);
  assert.match(out, /\.\.\./);
});

test("renderReviewReport: JSON is valid and matches shape", () => {
  const out = renderReviewReport(sampleReport(), 10, "json", null);
  const data = JSON.parse(out);
  assert.equal(data[0].msgid, "Showing 5 results");
  assert.deepEqual(data[0].occurrences, ["src/admin.php:42"]);
  assert.equal(data[0].ai_issue, "Hardcoded number '5' — use %d");
  assert.ok(!("static_issue" in data[0]), "empty static_issue should be omitted");
});

test("renderReviewReport: CSV has header and row", () => {
  const out = renderReviewReport(sampleReport(), 10, "csv", null);
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "num,msgid,occurrences,static_issue,ai_issue");
  assert.match(lines[1]!, /Showing 5 results/);
});

test("renderReviewReport: CSV flattens occurrences", () => {
  const report: ReviewItem[] = [
    { num: 1, msgId: "Test", occurrences: ["src/a.php:1", "src/b.php:2"], staticIssue: "Some issue", aiIssue: "" },
  ];
  const out = renderReviewReport(report, 1, "csv", null);
  assert.match(out, /src\/a\.php:1; src\/b\.php:2/);
});

test("renderReviewReport: markdown table", () => {
  const out = renderReviewReport(sampleReport(), 10, "markdown", null);
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "| # | String | Location | Issue |");
  assert.equal(lines[1], "|---|--------|----------|-------|");
  assert.match(lines[2]!, /Showing 5 results/);
  assert.match(lines[2]!, /src\/admin\.php:42/);
  assert.match(lines[2]!, /Hardcoded number/);
});

test("renderReviewReport: table format renders columns", () => {
  const out = renderReviewReport(sampleReport(), 10, "table", null);
  assert.match(out, /Showing 5 results/);
  assert.match(out, /Total: 1 issue\(s\) in 10 string\(s\)/);
});

test("renderReviewReport: includes tokens line when usage present", () => {
  const out = renderReviewReport([], 0, "text", { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  assert.match(out, /Tokens: input=10, output=5, total=15/);
});

test("renderStatus: shows counts and percentage", () => {
  const out = renderStatus({
    input: "test.po",
    total: 4,
    translated: 2,
    untranslated: 1,
    fuzzy: 1,
    percentage: 50,
    coreCache: null,
  });
  assert.match(out, /Total\s+4/);
  assert.match(out, /Translated\s+2\s+\(50\.0%\)/);
  assert.match(out, /Untranslated\s+1/);
  assert.match(out, /Fuzzy\s+1/);
});

test("renderStatus: shows core cache line when present", () => {
  const out = renderStatus({
    input: "test.po",
    total: 4,
    translated: 2,
    untranslated: 1,
    fuzzy: 1,
    percentage: 50,
    coreCache: { lang: "ne_NP", hits: 1, untranslated: 1 },
  });
  assert.match(out, /Core cache \(ne_NP\): 1 of 1 untranslated string\(s\)/);
});

test("renderGlossaryList: dirNotFound / empty / listed", () => {
  assert.match(renderGlossaryList({ outcome: "dirNotFound", dir: "/x" }), /Glossary directory not found: \/x/);
  assert.match(renderGlossaryList({ outcome: "empty" }), /No glossary files found/);
  const out = renderGlossaryList({
    outcome: "listed",
    dataDir: "/data",
    items: [{ locale: "ne_NP", lastUpdated: "2026-01-01", entries: 5 }],
  });
  assert.match(out, /ne_NP/);
  assert.match(out, /5/);
});

test("renderCoreList: dirNotFound / empty / listed", () => {
  assert.match(renderCoreList({ outcome: "dirNotFound", dir: "/x" }), /Core directory not found: \/x/);
  assert.match(renderCoreList({ outcome: "empty" }), /No core translation files found/);
  const out = renderCoreList({
    outcome: "listed",
    dataDir: "/data",
    items: [{ locale: "ne_NP", lastUpdated: "2026-01-01", entries: 5 }],
  });
  assert.match(out, /ne_NP/);
});
