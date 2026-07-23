import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hasTranslatorComment, occurrences } from "../../src/core/po/entry.ts";
import { parsePo } from "../../src/core/po/parser.ts";
import { PoFile } from "../../src/core/po/poFile.ts";
import type { Entry } from "../../src/core/po/types.ts";
import { marshalPo } from "../../src/core/po/writer.ts";

// ---------------------------------------------------------------------------
// Core PO parsing/marshaling behavior
// ---------------------------------------------------------------------------

test("ParsePo: basic header", () => {
  const src = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: ne_NP\\n"

msgid "Hello"
msgstr "नमस्ते"
`;
  const { entries } = parsePo(src);
  assert.equal(entries.length, 2);
  assert.ok(entries[0]!.isHeader, "first entry should be header");
  assert.match(entries[0]!.msgStr, /Content-Type/);
  assert.equal(entries[1]!.msgId, "Hello");
  assert.equal(entries[1]!.msgStr, "नमस्ते");
});

test("ParsePo: msgctxt", () => {
  const src = `msgid ""
msgstr ""

msgctxt "menu"
msgid "Home"
msgstr "गृहपृष्ठ"
`;
  const { entries } = parsePo(src);
  assert.equal(entries[1]!.msgCtxt, "menu");
  assert.equal(entries[1]!.msgId, "Home");
});

test("ParsePo: plural", () => {
  const src = `msgid ""
msgstr ""

msgid "%d comment"
msgid_plural "%d comments"
msgstr[0] "%d टिप्पणी"
msgstr[1] "%d टिप्पणीहरू"
`;
  const { entries } = parsePo(src);
  const e = entries[1]!;
  assert.equal(e.msgIdPlural, "%d comments");
  assert.equal(e.msgStrPlural[0], "%d टिप्पणी");
  assert.equal(e.msgStrPlural[1], "%d टिप्पणीहरू");
});

test("ParsePo: comments", () => {
  const src = `msgid ""
msgstr ""

# translator comment
#. extracted comment
#: src/file.php:42 src/other.php:10
#, fuzzy, c-format
msgid "Hello %s"
msgstr "नमस्ते %s"
`;
  const { entries } = parsePo(src);
  const e = entries[1]!;
  assert.deepEqual(e.translatorComments, ["translator comment"]);
  assert.deepEqual(e.extractedComments, ["extracted comment"]);
  assert.deepEqual(e.references, ["src/file.php:42 src/other.php:10"]);
  assert.deepEqual(e.flags, ["fuzzy", "c-format"]);
  assert.ok(e.flags.includes("fuzzy"));
});

test("ParsePo: multiline continuation", () => {
  const src = `msgid ""
msgstr ""

msgid ""
"line one "
"line two"
msgstr ""
"पंक्ति एक "
"पंक्ति दुई"
`;
  const { entries } = parsePo(src);
  const e = entries[1]!;
  assert.equal(e.msgId, "line one line two");
  assert.equal(e.msgStr, "पंक्ति एक पंक्ति दुई");
});

test("ParsePo: escaped quotes", () => {
  const src = `msgid ""
msgstr ""

msgid "Click \\"Save\\" now"
msgstr "अहिले \\"बचत गर्नुहोस्\\" थिच्नुहोस्"
`;
  const { entries } = parsePo(src);
  assert.equal(entries[1]!.msgId, 'Click "Save" now');
});

test("ParsePo: non-PO input rejected", () => {
  assert.throws(() => parsePo("plain text\nno keywords\n"));
});

test("PoFile: translated/untranslated/fuzzy counts", () => {
  const src = `msgid ""
msgstr ""

msgid "A"
msgstr "क"

msgid "B"
msgstr ""

#, fuzzy
msgid "C"
msgstr "ग"
`;
  const pf = PoFile.parse(src);
  assert.equal(pf.total(), 3);
  assert.equal(pf.translatedCount(), 1);
  assert.equal(pf.untranslatedCount(), 1);
  assert.equal(pf.fuzzyCount(), 1);
});

test("PoFile: round trip after modifying one entry", () => {
  const src = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: ne_NP\\n"

#. translators: %s is the site name
#: src/admin.php:42
msgid "Welcome to %s"
msgstr ""

msgctxt "menu"
msgid "Home"
msgstr "गृहपृष्ठ"
`;
  const pf = PoFile.parse(src);
  pf.entries[1]!.msgStr = "%s मा स्वागत छ";

  const out = pf.marshal();
  const pf2 = PoFile.parse(out);

  assert.equal(pf2.entries.length, 3);
  assert.equal(pf2.entries[1]!.msgId, "Welcome to %s");
  assert.equal(pf2.entries[1]!.msgStr, "%s मा स्वागत छ");
  assert.deepEqual(pf2.entries[1]!.extractedComments, ["translators: %s is the site name"]);
  assert.deepEqual(pf2.entries[1]!.references, ["src/admin.php:42"]);
  assert.equal(pf2.entries[2]!.msgCtxt, "menu");
});

test("Entry: occurrences", () => {
  const e: Entry = {
    msgCtxt: "",
    msgId: "",
    msgIdPlural: "",
    msgStr: "",
    msgStrPlural: {},
    translatorComments: [],
    extractedComments: [],
    references: ["src/a.php:10 src/b.php:20"],
    flags: [],
    obsolete: false,
    commentOrder: [],
    isHeader: false,
  };
  const occs = occurrences(e);
  assert.equal(occs.length, 2);
  assert.deepEqual(occs[0], ["src/a.php", "10"]);
  assert.deepEqual(occs[1], ["src/b.php", "20"]);
});

test("Entry: hasTranslatorComment", () => {
  const base: Entry = {
    msgCtxt: "",
    msgId: "",
    msgIdPlural: "",
    msgStr: "",
    msgStrPlural: {},
    translatorComments: [],
    extractedComments: [],
    references: [],
    flags: [],
    obsolete: false,
    commentOrder: [],
    isHeader: false,
  };
  assert.ok(hasTranslatorComment({ ...base, translatorComments: ["note"] }));
  assert.ok(hasTranslatorComment({ ...base, extractedComments: ["translators: %s is file"] }));
  assert.ok(!hasTranslatorComment({ ...base, references: ["src/a.php:1"] }));
});

// ---------------------------------------------------------------------------
// Idempotence + minimal-diff acceptance criteria — gettext-parser's grouped
// output makes both worth asserting here.
// ---------------------------------------------------------------------------

const roundTripFixture = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: ne_NP\\n"

#. translators: %s is the site name
#: src/admin.php:42
msgid "Welcome to %s"
msgstr ""

msgctxt "menu"
msgid "Home"
msgstr "गृहपृष्ठ"
`;

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

// Comment kinds appear out of gettext's conventional order here (#: before
// #.) — exercises the commentOrder fix.
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

const pluralFixture = `msgid ""
msgstr ""

msgid "%d comment"
msgid_plural "%d comments"
msgstr[0] "%d टिप्पणी"
msgstr[1] "%d टिप्पणीहरू"
`;

function idempotent(name: string, src: string) {
  test(`idempotence: ${name}`, () => {
    const pf = PoFile.parse(src);
    assert.equal(pf.marshal(), src);
  });
}

idempotent("round-trip fixture (interleaved contexts)", roundTripFixture);
idempotent("statusPO fixture", statusPO);
idempotent("potContent fixture (comment ordering)", potContent);
idempotent("plural fixture", pluralFixture);

const realWorldPoPath = new URL("./fixtures/classic-editor-ne.po", import.meta.url);

test("idempotence: real-world WordPress .po (classic-editor, ne_NP, interleaved contexts)", () => {
  const src = readFileSync(realWorldPoPath, "utf8");
  const pf = PoFile.parse(src);
  assert.equal(pf.marshal(), src);
});

function minimalDiffLines(before: string, after: string): number[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  assert.equal(afterLines.length, beforeLines.length, "line count must not change");
  const changed: number[] = [];
  for (let i = 0; i < beforeLines.length; i++) {
    if (beforeLines[i] !== afterLines[i]) {
      changed.push(i);
    }
  }
  return changed;
}

test("minimal diff: changing one entry's msgstr touches only that entry's line", () => {
  const src = readFileSync(realWorldPoPath, "utf8");
  const pf = PoFile.parse(src);

  const target = pf.entries.find((e) => e.msgId === "Default Editor");
  assert.ok(target, "fixture must contain the target entry");
  target.msgStr = "परिवर्तित पाठ";

  const changed = minimalDiffLines(src, pf.marshal());
  assert.equal(changed.length, 1, `expected exactly 1 changed line, got: ${changed}`);
});

test("minimal diff: changing an interleaved-context entry touches only that entry's line", () => {
  const src = readFileSync(realWorldPoPath, "utf8");
  const pf = PoFile.parse(src);

  const target = pf.entries.find((e) => e.msgCtxt === "Editor Name" && e.msgId === "Classic editor");
  assert.ok(target, "fixture must contain the interleaved-context target entry");
  target.msgStr = "परिवर्तित सम्पादक";

  const changed = minimalDiffLines(src, pf.marshal());
  assert.equal(changed.length, 1, `expected exactly 1 changed line, got: ${changed}`);
});

test("marshalPo: standalone function matches PoFile.marshal()", () => {
  const pf = PoFile.parse(statusPO);
  assert.equal(marshalPo(pf.entries, true), pf.marshal());
});
