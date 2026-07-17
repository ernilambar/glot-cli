package main

import (
	"strings"
	"testing"
)

func TestParsePo_BasicHeader(t *testing.T) {
	src := `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"
"Language: ne_NP\n"

msgid "Hello"
msgstr "नमस्ते"
`
	pf, err := ParsePo([]byte(src))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(pf.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(pf.Entries))
	}
	if !pf.Entries[0].isHeader {
		t.Fatalf("first entry should be header")
	}
	if !strings.Contains(pf.Entries[0].MsgStr, "Content-Type") {
		t.Fatalf("header content missing: %q", pf.Entries[0].MsgStr)
	}
	if pf.Entries[1].MsgID != "Hello" || pf.Entries[1].MsgStr != "नमस्ते" {
		t.Fatalf("bad entry: %+v", pf.Entries[1])
	}
}

func TestParsePo_Msgctxt(t *testing.T) {
	src := `msgid ""
msgstr ""

msgctxt "menu"
msgid "Home"
msgstr "गृहपृष्ठ"
`
	pf, err := ParsePo([]byte(src))
	if err != nil {
		t.Fatalf("%v", err)
	}
	if pf.Entries[1].MsgCtxt != "menu" || pf.Entries[1].MsgID != "Home" {
		t.Fatalf("bad msgctxt entry: %+v", pf.Entries[1])
	}
}

func TestParsePo_Plural(t *testing.T) {
	src := `msgid ""
msgstr ""

msgid "%d comment"
msgid_plural "%d comments"
msgstr[0] "%d टिप्पणी"
msgstr[1] "%d टिप्पणीहरू"
`
	pf, err := ParsePo([]byte(src))
	if err != nil {
		t.Fatalf("%v", err)
	}
	e := pf.Entries[1]
	if e.MsgIDPlural != "%d comments" {
		t.Fatalf("bad plural id: %q", e.MsgIDPlural)
	}
	if e.MsgStrPlural[0] != "%d टिप्पणी" || e.MsgStrPlural[1] != "%d टिप्पणीहरू" {
		t.Fatalf("bad plural strs: %v", e.MsgStrPlural)
	}
}

func TestParsePo_Comments(t *testing.T) {
	src := `msgid ""
msgstr ""

# translator comment
#. extracted comment
#: src/file.php:42 src/other.php:10
#, fuzzy, c-format
msgid "Hello %s"
msgstr "नमस्ते %s"
`
	pf, err := ParsePo([]byte(src))
	if err != nil {
		t.Fatalf("%v", err)
	}
	e := pf.Entries[1]
	if len(e.TranslatorComments) != 1 || e.TranslatorComments[0] != "translator comment" {
		t.Fatalf("bad translator comment: %v", e.TranslatorComments)
	}
	if len(e.ExtractedComments) != 1 || e.ExtractedComments[0] != "extracted comment" {
		t.Fatalf("bad extracted comment: %v", e.ExtractedComments)
	}
	if len(e.References) != 1 || e.References[0] != "src/file.php:42 src/other.php:10" {
		t.Fatalf("bad references: %v", e.References)
	}
	if len(e.Flags) != 2 || e.Flags[0] != "fuzzy" || e.Flags[1] != "c-format" {
		t.Fatalf("bad flags: %v", e.Flags)
	}
	if !e.Fuzzy() {
		t.Fatalf("expected fuzzy")
	}
}

func TestParsePo_MultilineContinuation(t *testing.T) {
	src := `msgid ""
msgstr ""

msgid ""
"line one "
"line two"
msgstr ""
"पंक्ति एक "
"पंक्ति दुई"
`
	pf, err := ParsePo([]byte(src))
	if err != nil {
		t.Fatalf("%v", err)
	}
	e := pf.Entries[1]
	if e.MsgID != "line one line two" {
		t.Fatalf("bad msgid: %q", e.MsgID)
	}
	if e.MsgStr != "पंक्ति एक पंक्ति दुई" {
		t.Fatalf("bad msgstr: %q", e.MsgStr)
	}
}

func TestParsePo_EscapedQuotes(t *testing.T) {
	src := `msgid ""
msgstr ""

msgid "Click \"Save\" now"
msgstr "अहिले \"बचत गर्नुहोस्\" थिच्नुहोस्"
`
	pf, err := ParsePo([]byte(src))
	if err != nil {
		t.Fatalf("%v", err)
	}
	e := pf.Entries[1]
	if e.MsgID != `Click "Save" now` {
		t.Fatalf("bad msgid: %q", e.MsgID)
	}
}

func TestParsePo_NonPoRejected(t *testing.T) {
	if _, err := ParsePo([]byte("plain text\nno keywords\n")); err == nil {
		t.Fatalf("expected error for non-PO input")
	}
}

func TestPoFile_Translated(t *testing.T) {
	src := `msgid ""
msgstr ""

msgid "A"
msgstr "क"

msgid "B"
msgstr ""

#, fuzzy
msgid "C"
msgstr "ग"
`
	pf, err := ParsePo([]byte(src))
	if err != nil {
		t.Fatalf("%v", err)
	}
	if pf.Total() != 3 {
		t.Fatalf("bad Total: %d", pf.Total())
	}
	if pf.TranslatedCount() != 1 {
		t.Fatalf("bad TranslatedCount: %d", pf.TranslatedCount())
	}
	if pf.UntranslatedCount() != 1 {
		t.Fatalf("bad UntranslatedCount: %d", pf.UntranslatedCount())
	}
	if pf.FuzzyCount() != 1 {
		t.Fatalf("bad FuzzyCount: %d", pf.FuzzyCount())
	}
}

func TestPoFile_RoundTrip(t *testing.T) {
	src := `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"
"Language: ne_NP\n"

#. translators: %s is the site name
#: src/admin.php:42
msgid "Welcome to %s"
msgstr ""

msgctxt "menu"
msgid "Home"
msgstr "गृहपृष्ठ"
`
	pf, err := ParsePo([]byte(src))
	if err != nil {
		t.Fatalf("%v", err)
	}
	// Modify: set a translation
	pf.Entries[1].MsgStr = "%s मा स्वागत छ"

	out, err := pf.Marshal()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	pf2, err := ParsePo(out)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if len(pf2.Entries) != 3 {
		t.Fatalf("expected 3 entries after round-trip, got %d\n%s", len(pf2.Entries), string(out))
	}
	if pf2.Entries[1].MsgID != "Welcome to %s" {
		t.Fatalf("msgid lost in round-trip: %q", pf2.Entries[1].MsgID)
	}
	if pf2.Entries[1].MsgStr != "%s मा स्वागत छ" {
		t.Fatalf("msgstr lost: %q", pf2.Entries[1].MsgStr)
	}
	if len(pf2.Entries[1].ExtractedComments) != 1 ||
		pf2.Entries[1].ExtractedComments[0] != "translators: %s is the site name" {
		t.Fatalf("extracted comment lost: %v", pf2.Entries[1].ExtractedComments)
	}
	if len(pf2.Entries[1].References) != 1 || pf2.Entries[1].References[0] != "src/admin.php:42" {
		t.Fatalf("reference lost: %v", pf2.Entries[1].References)
	}
	if pf2.Entries[2].MsgCtxt != "menu" {
		t.Fatalf("msgctxt lost: %q", pf2.Entries[2].MsgCtxt)
	}
}

func TestEntry_Occurrences(t *testing.T) {
	e := &Entry{References: []string{"src/a.php:10 src/b.php:20"}}
	occs := e.Occurrences()
	if len(occs) != 2 {
		t.Fatalf("expected 2 occurrences, got %d", len(occs))
	}
	if occs[0][0] != "src/a.php" || occs[0][1] != "10" {
		t.Fatalf("bad first occurrence: %v", occs[0])
	}
	if occs[1][0] != "src/b.php" || occs[1][1] != "20" {
		t.Fatalf("bad second occurrence: %v", occs[1])
	}
}

func TestEntry_HasTranslatorComment(t *testing.T) {
	e := &Entry{TranslatorComments: []string{"note"}}
	if !e.HasTranslatorComment() {
		t.Fatalf("expected true for translator comment")
	}
	e2 := &Entry{ExtractedComments: []string{"translators: %s is file"}}
	if !e2.HasTranslatorComment() {
		t.Fatalf("expected true for extracted comment")
	}
	e3 := &Entry{References: []string{"src/a.php:1"}}
	if e3.HasTranslatorComment() {
		t.Fatalf("expected false when only refs present")
	}
}
