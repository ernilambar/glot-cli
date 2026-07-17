package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// captureOutput runs fn while capturing os.Stdout and os.Stderr.
func captureOutput(t *testing.T, fn func()) (stdout, stderr string) {
	t.Helper()
	origOut, origErr := os.Stdout, os.Stderr
	rOut, wOut, _ := os.Pipe()
	rErr, wErr, _ := os.Pipe()
	os.Stdout = wOut
	os.Stderr = wErr

	var outBuf, errBuf bytes.Buffer
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); io.Copy(&outBuf, rOut) }()
	go func() { defer wg.Done(); io.Copy(&errBuf, rErr) }()

	fn()

	wOut.Close()
	wErr.Close()
	wg.Wait()
	os.Stdout = origOut
	os.Stderr = origErr
	return outBuf.String(), errBuf.String()
}

// mustExit runs fn and asserts it called os.Exit (via a panic recovery from a helper).
// Since Go's os.Exit terminates the test process, we use a fork-based approach:
// re-run the test binary in a subprocess to detect the exit. Simpler: replace
// osExitCalls-testable code paths. Here we use recover on a custom panic.
func mustExit(t *testing.T, fn func()) {
	t.Helper()
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected os.Exit to be called")
		}
	}()
	// Replace osExit with a panic during the test.
	origExit := osExit
	osExit = func(code int) { panic(exitSentinel{code: code}) }
	defer func() { osExit = origExit }()
	fn()
}

type exitSentinel struct{ code int }

// setConfigForTest resets package-level config to known values.
func setConfigForTest(t *testing.T, endpoint, model, apiKey string) {
	t.Helper()
	origEndpoint, origModel, origKey := glotEndpointURL, glotModelID, glotAPIKey
	glotEndpointURL, glotModelID, glotAPIKey = endpoint, model, apiKey
	t.Cleanup(func() {
		glotEndpointURL, glotModelID, glotAPIKey = origEndpoint, origModel, origKey
	})
}

// setCallAIForTest replaces callAI with a mock.
func setCallAIForTest(t *testing.T, fn func(prompt, systemPrompt string, temperature float64) (string, *usageInfo, error)) {
	t.Helper()
	orig := callAI
	callAI = fn
	t.Cleanup(func() { callAI = orig })
}

// setLanguagesForTest replaces the language list loader.
func setLanguagesForTest(t *testing.T, langs map[string]string) {
	t.Helper()
	orig := loadValidLanguages
	loadValidLanguages = func() map[string]string { return langs }
	t.Cleanup(func() { loadValidLanguages = orig })
}

// setCoreLoaderForTest replaces loadCoreTranslations.
func setCoreLoaderForTest(t *testing.T, fn func(locale string) map[string]string) {
	t.Helper()
	orig := loadCoreTranslations
	loadCoreTranslations = fn
	t.Cleanup(func() { loadCoreTranslations = orig })
}

// writePO writes a temp .po file and returns its path.
func writePO(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return p
}

var fakeLanguages = map[string]string{"ne_NP": "Nepali", "es_ES": "Spanish (Spain)"}

// ---------------------------------------------------------------------------
// parseBatchResponse
// ---------------------------------------------------------------------------

func TestParseBatchResponse_JSON(t *testing.T) {
	got := parseBatchResponse(`{"1": "नमस्ते", "2": "संसार"}`, 2)
	want := []string{"नमस्ते", "संसार"}
	if !equalStrSlices(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseBatchResponse_JSONWithCodeFences(t *testing.T) {
	got := parseBatchResponse("```json\n{\"1\": \"नमस्ते\"}\n```", 1)
	want := []string{"नमस्ते"}
	if !equalStrSlices(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseBatchResponse_JSONMissingKeyReturnsEmpty(t *testing.T) {
	got := parseBatchResponse(`{"1": "नमस्ते"}`, 2)
	want := []string{"नमस्ते", ""}
	if !equalStrSlices(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseBatchResponse_IgnoresOutOfRangeKeys(t *testing.T) {
	got := parseBatchResponse(`{"1": "A", "9": "B"}`, 2)
	want := []string{"A", ""}
	if !equalStrSlices(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseBatchResponse_RegexFallback(t *testing.T) {
	got := parseBatchResponse("1. नमस्ते\n2. संसार", 2)
	want := []string{"नमस्ते", "संसार"}
	if !equalStrSlices(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseBatchResponse_MalformedJSONFallsBackToRegex(t *testing.T) {
	got := parseBatchResponse("{bad json}\n1. नमस्ते\n2. संसार", 2)
	want := []string{"नमस्ते", "संसार"}
	if !equalStrSlices(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseBatchResponse_EmptyReturnsEmptyStrings(t *testing.T) {
	got := parseBatchResponse("", 2)
	want := []string{"", ""}
	if !equalStrSlices(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

func TestTokenize_Basic(t *testing.T) {
	got := tokenize("Hello World")
	want := []string{"hello", "world"}
	if !equalStrSlices(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTokenize_PunctuationStripped(t *testing.T) {
	got := tokenize("Hello, World!")
	want := []string{"hello", "world"}
	if !equalStrSlices(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTokenize_EmptyString(t *testing.T) {
	got := tokenize("")
	if len(got) != 0 {
		t.Fatalf("got %v, want []", got)
	}
}

// ---------------------------------------------------------------------------
// buildGlossaryIndex
// ---------------------------------------------------------------------------

func TestBuildGlossaryIndex_SingleWordTerm(t *testing.T) {
	g := map[string]GlossaryTerm{"plugin": {Translation: "प्लगिन"}}
	idx := buildGlossaryIndex(g)
	if !containsStr(idx["plugin"], "plugin") {
		t.Fatalf("expected index[\"plugin\"] to contain \"plugin\", got %v", idx["plugin"])
	}
}

func TestBuildGlossaryIndex_MultiWordTermIndexedByFirstWord(t *testing.T) {
	g := map[string]GlossaryTerm{"admin panel": {Translation: "व्यवस्थापक प्यानल"}}
	idx := buildGlossaryIndex(g)
	if !containsStr(idx["admin"], "admin panel") {
		t.Fatalf("expected index[\"admin\"] to contain \"admin panel\", got %v", idx["admin"])
	}
}

// ---------------------------------------------------------------------------
// matchingGlossaryTerms
// ---------------------------------------------------------------------------

func TestMatchingGlossaryTerms_SingleWord(t *testing.T) {
	g := map[string]GlossaryTerm{
		"plugin":      {Translation: "प्लगिन", Pos: "noun"},
		"admin panel": {Translation: "व्यवस्थापक प्यानल", Pos: "noun"},
	}
	idx := buildGlossaryIndex(g)
	got := matchingGlossaryTerms("Install plugin", g, idx)
	if len(got) != 1 || got[0].Term != "plugin" {
		t.Fatalf("got %v", got)
	}
}

func TestMatchingGlossaryTerms_MultiWord(t *testing.T) {
	g := map[string]GlossaryTerm{
		"plugin":      {Translation: "प्लगिन", Pos: "noun"},
		"admin panel": {Translation: "व्यवस्थापक प्यानल", Pos: "noun"},
	}
	idx := buildGlossaryIndex(g)
	got := matchingGlossaryTerms("Open the admin panel now", g, idx)
	if len(got) != 1 || got[0].Term != "admin panel" {
		t.Fatalf("got %v", got)
	}
}

func TestMatchingGlossaryTerms_NoMatch(t *testing.T) {
	g := map[string]GlossaryTerm{"plugin": {}}
	idx := buildGlossaryIndex(g)
	got := matchingGlossaryTerms("Hello World", g, idx)
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestMatchingGlossaryTerms_EmptyGlossary(t *testing.T) {
	got := matchingGlossaryTerms("Install plugin", map[string]GlossaryTerm{}, map[string][]string{})
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestMatchingGlossaryTerms_CaseInsensitive(t *testing.T) {
	g := map[string]GlossaryTerm{"plugin": {Translation: "प्लगिन"}}
	idx := buildGlossaryIndex(g)
	got := matchingGlossaryTerms("Install Plugin", g, idx)
	if len(got) != 1 || got[0].Term != "plugin" {
		t.Fatalf("got %v", got)
	}
}

// ---------------------------------------------------------------------------
// buildBatchPrompt
// ---------------------------------------------------------------------------

func TestBuildBatchPrompt_NumberedStringsPresent(t *testing.T) {
	items := []batchItem{{MsgID: "Hello"}, {MsgID: "World"}}
	p := buildBatchPrompt(items, "ne_NP", "")
	if !strings.Contains(p, "1. Hello") || !strings.Contains(p, "2. World") {
		t.Fatalf("missing numbered strings: %s", p)
	}
}

func TestBuildBatchPrompt_JSONFormatInstruction(t *testing.T) {
	p := buildBatchPrompt([]batchItem{{MsgID: "Hello"}}, "ne_NP", "")
	if !strings.Contains(p, "JSON") {
		t.Fatalf("missing JSON instruction: %s", p)
	}
}

func TestBuildBatchPrompt_GlossaryTermsInjected(t *testing.T) {
	matches := []termMatch{{Term: "plugin", Info: GlossaryTerm{Translation: "प्लगिन", Pos: "noun"}}}
	p := buildBatchPrompt([]batchItem{{MsgID: "Install plugin", Matches: matches}}, "ne_NP", "")
	if !strings.Contains(p, "plugin") || !strings.Contains(p, "प्लगिन") {
		t.Fatalf("missing glossary content: %s", p)
	}
}

func TestBuildBatchPrompt_DuplicateGlossaryTermsDeduplicated(t *testing.T) {
	matches := []termMatch{{Term: "plugin", Info: GlossaryTerm{Translation: "प्लगिन"}}}
	items := []batchItem{
		{MsgID: "Install plugin", Matches: matches},
		{MsgID: "Delete plugin", Matches: matches},
	}
	p := buildBatchPrompt(items, "ne_NP", "")
	if count := strings.Count(p, "प्लगिन"); count != 1 {
		t.Fatalf("expected 1 occurrence of translation, got %d in: %s", count, p)
	}
}

func TestBuildBatchPrompt_WithSystemPromptUsesShortFormat(t *testing.T) {
	p := buildBatchPrompt([]batchItem{{MsgID: "Hello"}, {MsgID: "World"}}, "ne_NP", "You are a translator.")
	if !strings.Contains(p, "1. Hello") || !strings.Contains(p, "2. World") {
		t.Fatalf("missing numbered strings: %s", p)
	}
}

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

func TestBuildReviewPrompt_NumberedStringsPresent(t *testing.T) {
	p := buildReviewPrompt([]string{"Showing 5 results", "Hello World"})
	if !strings.Contains(p, "1. Showing 5 results") || !strings.Contains(p, "2. Hello World") {
		t.Fatalf("missing numbered strings: %s", p)
	}
}

func TestBuildReviewPrompt_RulesMentioned(t *testing.T) {
	p := buildReviewPrompt([]string{"Test"})
	if !strings.Contains(p, "%d") || !strings.Contains(p, "%s") {
		t.Fatalf("missing rule references: %s", p)
	}
}

// ---------------------------------------------------------------------------
// parseReviewResponse
// ---------------------------------------------------------------------------

func TestParseReviewResponse_ValidJSON(t *testing.T) {
	got := parseReviewResponse(`{"1": "Hardcoded number", "3": "Hardcoded URL"}`)
	want := map[string]string{"1": "Hardcoded number", "3": "Hardcoded URL"}
	if !equalStrMap(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseReviewResponse_EmptyJSON(t *testing.T) {
	got := parseReviewResponse("{}")
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestParseReviewResponse_StripsCodeFences(t *testing.T) {
	got := parseReviewResponse("```json\n{\"2\": \"Hardcoded file name\"}\n```")
	want := map[string]string{"2": "Hardcoded file name"}
	if !equalStrMap(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseReviewResponse_MalformedJSONReturnsEmpty(t *testing.T) {
	got := parseReviewResponse("{bad json}")
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestParseReviewResponse_EmptyStringReturnsEmpty(t *testing.T) {
	got := parseReviewResponse("")
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestParseReviewResponse_NullValuesExcluded(t *testing.T) {
	got := parseReviewResponse(`{"1": "Issue here", "2": null}`)
	want := map[string]string{"1": "Issue here"}
	if !equalStrMap(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// ---------------------------------------------------------------------------
// validateLang
// ---------------------------------------------------------------------------

func TestValidateLang_ValidPasses(t *testing.T) {
	setLanguagesForTest(t, fakeLanguages)
	// Must not exit.
	validateLang("ne_NP")
}

func TestValidateLang_InvalidExits(t *testing.T) {
	setLanguagesForTest(t, fakeLanguages)
	mustExit(t, func() { validateLang("xx_XX") })
}

func TestValidateLang_SkipsWhenLangFileMissing(t *testing.T) {
	setLanguagesForTest(t, map[string]string{})
	// Must not exit.
	validateLang("xx_XX")
}

// ---------------------------------------------------------------------------
// stripCodeFences
// ---------------------------------------------------------------------------

func TestStripCodeFences_Plain(t *testing.T) {
	if got := stripCodeFences("hello"); got != "hello" {
		t.Fatalf("got %q", got)
	}
}

func TestStripCodeFences_WithFences(t *testing.T) {
	if got := stripCodeFences("```json\n{\"a\":1}\n```"); got != `{"a":1}` {
		t.Fatalf("got %q", got)
	}
}

// ---------------------------------------------------------------------------
// outputReviewReport
// ---------------------------------------------------------------------------

func sampleReport() []reviewItem {
	return []reviewItem{{
		Num:         3,
		MsgID:       "Showing 5 results",
		Occurrences: []string{"src/admin.php:42"},
		StaticIssue: "",
		AIIssue:     "Hardcoded number '5' — use %d",
	}}
}

func TestOutputReviewReport_TextShowsStringLabel(t *testing.T) {
	out, _ := captureOutput(t, func() { outputReviewReport(sampleReport(), 10, "text", nil) })
	if !strings.Contains(out, `String: "Showing 5 results"`) {
		t.Fatalf("missing string label in output: %s", out)
	}
}

func TestOutputReviewReport_TextShowsOccurrence(t *testing.T) {
	out, _ := captureOutput(t, func() { outputReviewReport(sampleReport(), 10, "text", nil) })
	if !strings.Contains(out, "src/admin.php:42") {
		t.Fatalf("missing occurrence: %s", out)
	}
}

func TestOutputReviewReport_TextShowsIssue(t *testing.T) {
	out, _ := captureOutput(t, func() { outputReviewReport(sampleReport(), 10, "text", nil) })
	if !strings.Contains(out, "Issue:") || !strings.Contains(out, "Hardcoded number") {
		t.Fatalf("missing issue: %s", out)
	}
}

func TestOutputReviewReport_TextNoIssues(t *testing.T) {
	out, _ := captureOutput(t, func() { outputReviewReport([]reviewItem{}, 10, "text", nil) })
	if !strings.Contains(out, "No issues found") {
		t.Fatalf("missing no-issues message: %s", out)
	}
}

func TestOutputReviewReport_TextTruncatesLongMsgID(t *testing.T) {
	long := strings.Repeat("A", 100)
	report := []reviewItem{{Num: 1, MsgID: long, Occurrences: []string{}, StaticIssue: "Too long"}}
	out, _ := captureOutput(t, func() { outputReviewReport(report, 1, "text", nil) })
	if !strings.Contains(out, "...") {
		t.Fatalf("missing truncation marker: %s", out)
	}
}

func TestOutputReviewReport_JSONValid(t *testing.T) {
	out, _ := captureOutput(t, func() { outputReviewReport(sampleReport(), 10, "json", nil) })
	var data []reviewItem
	if err := json.Unmarshal([]byte(out), &data); err != nil {
		t.Fatalf("invalid JSON: %v (%s)", err, out)
	}
	if len(data) == 0 || data[0].MsgID != "Showing 5 results" {
		t.Fatalf("bad JSON content: %s", out)
	}
	if len(data[0].Occurrences) != 1 || data[0].Occurrences[0] != "src/admin.php:42" {
		t.Fatalf("bad occurrences: %v", data[0].Occurrences)
	}
}

func TestOutputReviewReport_CSVHasHeaderAndRow(t *testing.T) {
	out, _ := captureOutput(t, func() { outputReviewReport(sampleReport(), 10, "csv", nil) })
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if lines[0] != "num,msgid,occurrences,static_issue,ai_issue" {
		t.Fatalf("bad header: %s", lines[0])
	}
	if len(lines) < 2 || !strings.Contains(lines[1], "Showing 5 results") {
		t.Fatalf("missing data row: %s", out)
	}
}

func TestOutputReviewReport_MarkdownTable(t *testing.T) {
	out, _ := captureOutput(t, func() { outputReviewReport(sampleReport(), 10, "markdown", nil) })
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if lines[0] != "| # | String | Location | Issue |" {
		t.Fatalf("bad markdown header: %s", lines[0])
	}
	if lines[1] != "|---|--------|----------|-------|" {
		t.Fatalf("bad markdown separator: %s", lines[1])
	}
	if !strings.Contains(lines[2], "Showing 5 results") ||
		!strings.Contains(lines[2], "src/admin.php:42") ||
		!strings.Contains(lines[2], "Hardcoded number") {
		t.Fatalf("bad markdown row: %s", lines[2])
	}
}

func TestOutputReviewReport_CSVFlattensOccurrences(t *testing.T) {
	report := []reviewItem{{
		Num:         1,
		MsgID:       "Test",
		Occurrences: []string{"src/a.php:1", "src/b.php:2"},
		StaticIssue: "Some issue",
	}}
	out, _ := captureOutput(t, func() { outputReviewReport(report, 1, "csv", nil) })
	if !strings.Contains(out, "src/a.php:1; src/b.php:2") {
		t.Fatalf("occurrences not flattened: %s", out)
	}
}

// ---------------------------------------------------------------------------
// cmdStatus
// ---------------------------------------------------------------------------

const statusPO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"

msgid "Hello"
msgstr "नमस्ते"

msgid "World"
msgstr "संसार"

msgid "Untranslated string"
msgstr ""

#, fuzzy
msgid "Fuzzy entry"
msgstr "अस्पष्ट"
`

func TestCmdStatus_OutputContainsSectionLabels(t *testing.T) {
	dir := t.TempDir()
	p := writePO(t, dir, "test.po", statusPO)
	out, _ := captureOutput(t, func() { cmdStatus(statusArgs{Input: p}) })
	for _, s := range []string{"Total", "Translated", "Untranslated", "Fuzzy"} {
		if !strings.Contains(out, s) {
			t.Fatalf("missing %q: %s", s, out)
		}
	}
}

func TestCmdStatus_CountsAreCorrect(t *testing.T) {
	dir := t.TempDir()
	p := writePO(t, dir, "test.po", statusPO)
	out, _ := captureOutput(t, func() { cmdStatus(statusArgs{Input: p}) })
	// Total 4, translated 2, untranslated 1, fuzzy 1
	if !strings.Contains(out, "Total          4") {
		t.Fatalf("bad total count: %s", out)
	}
	if !strings.Contains(out, "Translated     2") {
		t.Fatalf("bad translated count: %s", out)
	}
	if !strings.Contains(out, "Untranslated   1") {
		t.Fatalf("bad untranslated count: %s", out)
	}
	if !strings.Contains(out, "Fuzzy          1") {
		t.Fatalf("bad fuzzy count: %s", out)
	}
}

func TestCmdStatus_MissingFileExits(t *testing.T) {
	mustExit(t, func() { cmdStatus(statusArgs{Input: "/nonexistent/file.po"}) })
}

func TestCmdStatus_RejectsInvalidLang(t *testing.T) {
	setLanguagesForTest(t, fakeLanguages)
	dir := t.TempDir()
	p := writePO(t, dir, "test.po", `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"
`)
	mustExit(t, func() { cmdStatus(statusArgs{Input: p, Lang: "xx_XX"}) })
}

func TestCmdStatus_SkipsValidationWhenNoLang(t *testing.T) {
	setLanguagesForTest(t, fakeLanguages)
	dir := t.TempDir()
	p := writePO(t, dir, "test.po", `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"
`)
	// Must not exit.
	captureOutput(t, func() { cmdStatus(statusArgs{Input: p}) })
}

// ---------------------------------------------------------------------------
// cmdTranslate
// ---------------------------------------------------------------------------

const untranslatedPO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"

msgid "Hello"
msgstr ""

msgid "World"
msgstr ""
`

func TestCmdTranslate_MissingEnvVarsExits(t *testing.T) {
	setConfigForTest(t, "", "", "")
	dir := t.TempDir()
	p := writePO(t, dir, "test.po", untranslatedPO)
	mustExit(t, func() { cmdTranslate(translateArgs{Input: p, Lang: "ne_NP"}) })
}

func TestCmdTranslate_MissingFileExits(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	mustExit(t, func() { cmdTranslate(translateArgs{Input: "/no/such/file.po", Lang: "ne_NP"}) })
}

func TestCmdTranslate_NothingToDoWhenFullyTranslated(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	dir := t.TempDir()
	p := writePO(t, dir, "done.po", `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"

msgid "Hello"
msgstr "नमस्ते"
`)
	out, _ := captureOutput(t, func() { cmdTranslate(translateArgs{Input: p, Lang: "ne_NP"}) })
	if !strings.Contains(out, "Nothing to do") {
		t.Fatalf("missing 'Nothing to do': %s", out)
	}
}

func TestCmdTranslate_AITranslationsWrittenToFile(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	setCoreLoaderForTest(t, func(string) map[string]string { return nil })
	setCallAIForTest(t, func(prompt, sys string, temp float64) (string, *usageInfo, error) {
		return `{"1": "नमस्ते", "2": "संसार"}`, nil, nil
	})
	dir := t.TempDir()
	p := writePO(t, dir, "test.po", untranslatedPO)
	captureOutput(t, func() { cmdTranslate(translateArgs{Input: p, Lang: "ne_NP"}) })

	pf, err := ParsePoFile(p)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	found := map[string]string{}
	for _, e := range pf.TranslatableEntries() {
		found[e.MsgID] = e.MsgStr
	}
	if found["Hello"] != "नमस्ते" || found["World"] != "संसार" {
		t.Fatalf("translations not written: %v", found)
	}
}

func TestCmdTranslate_UnwritablePoExits(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("chmod has no effect as root")
	}
	setConfigForTest(t, "http://fake", "m", "")
	setCoreLoaderForTest(t, func(string) map[string]string { return nil })
	setCallAIForTest(t, func(prompt, sys string, temp float64) (string, *usageInfo, error) {
		return `{"1": "नमस्ते", "2": "संसार"}`, nil, nil
	})
	dir := t.TempDir()
	p := writePO(t, dir, "test.po", untranslatedPO)
	if err := os.Chmod(p, 0o444); err != nil {
		t.Fatal(err)
	}
	mustExit(t, func() { cmdTranslate(translateArgs{Input: p, Lang: "ne_NP"}) })
}

func TestCmdTranslate_CoreCacheSkipsAI(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	setCoreLoaderForTest(t, func(string) map[string]string {
		return map[string]string{"Hello": "नमस्ते", "World": "संसार"}
	})
	aiCalled := false
	setCallAIForTest(t, func(prompt, sys string, temp float64) (string, *usageInfo, error) {
		aiCalled = true
		return "", nil, nil
	})
	dir := t.TempDir()
	p := writePO(t, dir, "test.po", untranslatedPO)
	out, _ := captureOutput(t, func() { cmdTranslate(translateArgs{Input: p, Lang: "ne_NP"}) })
	if aiCalled {
		t.Fatalf("AI should not be called when core cache satisfies all entries")
	}
	if !strings.Contains(out, "Core matches: 2") {
		t.Fatalf("missing 'Core matches: 2': %s", out)
	}
}

func TestCmdTranslate_NegativeLimitExits(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	dir := t.TempDir()
	p := writePO(t, dir, "test.po", untranslatedPO)
	mustExit(t, func() { cmdTranslate(translateArgs{Input: p, Lang: "ne_NP", Limit: -1}) })
}

func TestCmdTranslate_InvalidPoFileExits(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	dir := t.TempDir()
	p := writePO(t, dir, "not_a_po.txt", "this is not a po file\njust plain text\n")
	mustExit(t, func() { cmdTranslate(translateArgs{Input: p, Lang: "ne_NP"}) })
}

func TestCmdTranslate_RejectsInvalidLang(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	setLanguagesForTest(t, fakeLanguages)
	dir := t.TempDir()
	p := writePO(t, dir, "test.po", `msgid ""
msgstr ""
`)
	mustExit(t, func() { cmdTranslate(translateArgs{Input: p, Lang: "xx_XX"}) })
}

// ---------------------------------------------------------------------------
// cmdReview
// ---------------------------------------------------------------------------

const potContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"

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
`

func TestCmdReview_MissingEnvVarsExits(t *testing.T) {
	setConfigForTest(t, "", "", "")
	dir := t.TempDir()
	p := writePO(t, dir, "test.pot", potContent)
	mustExit(t, func() { cmdReview(reviewArgs{Input: p, Format: "text"}) })
}

func TestCmdReview_MissingFileExits(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	mustExit(t, func() { cmdReview(reviewArgs{Input: "/no/such/file.pot", Format: "text"}) })
}

func TestCmdReview_StaticCheckFlagsPlaceholderWithoutComment(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	setCallAIForTest(t, func(prompt, sys string, temp float64) (string, *usageInfo, error) {
		return "{}", nil, nil
	})
	dir := t.TempDir()
	p := writePO(t, dir, "test.pot", potContent)
	out, _ := captureOutput(t, func() { cmdReview(reviewArgs{Input: p, Format: "text"}) })
	if !strings.Contains(out, "Save settings %s") {
		t.Fatalf("expected 'Save settings %%s' in output: %s", out)
	}
	if !strings.Contains(out, "translators") {
		t.Fatalf("expected 'translators' in output: %s", out)
	}
}

func TestCmdReview_StaticCheckIgnoresPlaceholderWithComment(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	setCallAIForTest(t, func(prompt, sys string, temp float64) (string, *usageInfo, error) {
		return "{}", nil, nil
	})
	dir := t.TempDir()
	p := writePO(t, dir, "test.pot", potContent)
	out, _ := captureOutput(t, func() { cmdReview(reviewArgs{Input: p, Format: "text"}) })
	if strings.Contains(out, "Error in %s detected") {
		t.Fatalf("should NOT flag 'Error in %%s detected' (has translator comment): %s", out)
	}
}

func TestCmdReview_AIIssuesAppearInOutput(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	setCallAIForTest(t, func(prompt, sys string, temp float64) (string, *usageInfo, error) {
		return `{"1": "Hardcoded number — use %d"}`, nil, nil
	})
	dir := t.TempDir()
	p := writePO(t, dir, "test.pot", potContent)
	out, _ := captureOutput(t, func() { cmdReview(reviewArgs{Input: p, Format: "text"}) })
	if !strings.Contains(out, "Hardcoded number") {
		t.Fatalf("missing AI issue: %s", out)
	}
}

func TestCmdReview_OccurrenceShownInOutput(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	setCallAIForTest(t, func(prompt, sys string, temp float64) (string, *usageInfo, error) {
		return `{"1": "Hardcoded number — use %d"}`, nil, nil
	})
	dir := t.TempDir()
	p := writePO(t, dir, "test.pot", potContent)
	out, _ := captureOutput(t, func() { cmdReview(reviewArgs{Input: p, Format: "text"}) })
	if !strings.Contains(out, "src/admin.php:42") {
		t.Fatalf("missing occurrence: %s", out)
	}
}

func TestCmdReview_NoIssuesMessageWhenClean(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	setCallAIForTest(t, func(prompt, sys string, temp float64) (string, *usageInfo, error) {
		return "{}", nil, nil
	})
	dir := t.TempDir()
	p := writePO(t, dir, "clean.pot", `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"

#: src/misc.php:5
msgid "Hello World"
msgstr ""
`)
	out, _ := captureOutput(t, func() { cmdReview(reviewArgs{Input: p, Format: "text"}) })
	if !strings.Contains(out, "No issues found") {
		t.Fatalf("missing 'No issues found': %s", out)
	}
}

func TestCmdReview_FailedBatchDoesNotCrash(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	setCallAIForTest(t, func(prompt, sys string, temp float64) (string, *usageInfo, error) {
		return "", nil, errors.New("API down")
	})
	dir := t.TempDir()
	p := writePO(t, dir, "test.pot", potContent)
	_, stderr := captureOutput(t, func() { cmdReview(reviewArgs{Input: p, Format: "text"}) })
	if !strings.Contains(stderr, "FAILED") {
		t.Fatalf("expected 'FAILED' in stderr: %s", stderr)
	}
}

func TestCmdReview_JSONFormat(t *testing.T) {
	setConfigForTest(t, "http://fake", "m", "")
	setCallAIForTest(t, func(prompt, sys string, temp float64) (string, *usageInfo, error) {
		return `{"1": "Hardcoded number"}`, nil, nil
	})
	dir := t.TempDir()
	p := writePO(t, dir, "test.pot", potContent)
	stdout, _ := captureOutput(t, func() { cmdReview(reviewArgs{Input: p, Format: "json"}) })
	var data []reviewItem
	if err := json.Unmarshal([]byte(stdout), &data); err != nil {
		t.Fatalf("invalid JSON: %v (%s)", err, stdout)
	}
	found := false
	for _, item := range data {
		if item.AIIssue == "Hardcoded number" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected AI issue in JSON output: %s", stdout)
	}
}

// ---------------------------------------------------------------------------
// glossary/core pull locale validation
// ---------------------------------------------------------------------------

func TestGlossaryPull_NoLocaleExits(t *testing.T) {
	mustExit(t, func() { cmdGlossaryPull(glossaryPullArgs{Locale: ""}) })
}

func TestGlossaryPull_InvalidLocaleExits(t *testing.T) {
	setLanguagesForTest(t, fakeLanguages)
	mustExit(t, func() { cmdGlossaryPull(glossaryPullArgs{Locale: "xx_XX"}) })
}

func TestCorePull_NoLocaleExits(t *testing.T) {
	mustExit(t, func() { cmdCorePull(corePullArgs{Locale: ""}) })
}

func TestCorePull_InvalidLocaleExits(t *testing.T) {
	setLanguagesForTest(t, fakeLanguages)
	mustExit(t, func() { cmdCorePull(corePullArgs{Locale: "xx_XX"}) })
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

func equalStrSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalStrMap(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func containsStr(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}
