// glot - CLI tool for translating WordPress .po files using any OpenAI-compatible backend.
//
// Author: Nilambar Sharma
// Repo:   https://github.com/ernilambar/glot-cli
package main

import (
	"bufio"
	"bytes"
	_ "embed"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"text/tabwriter"
	"time"
)

const VERSION = "1.0.0"

// ---------------------------------------------------------------------------
// Configuration (populated from environment at startup)
// ---------------------------------------------------------------------------

var (
	glotEndpointURL    string
	glotModelID        string
	glotAPIKey         string
	glotLang           string
	glotDataDir        string
	glossaryDir        string
	promptsDir         string
	coreDir            string
	glotMaxStrings     = 200
	glotBatchSize      = 10
	glotConcurrency    = 1
	glotRequestTimeout = 120 // seconds; 0 disables timeout
)

var coreProjects = []string{
	"wp/dev/{slug}/default",
	"wp/dev/admin/{slug}/default",
	"wp/dev/admin/network/{slug}/default",
}

// osExit is an indirection so tests can intercept exit calls without terminating.
var osExit = os.Exit

func loadConfig() {
	glotEndpointURL = os.Getenv("GLOT_ENDPOINT_URL")
	glotModelID = os.Getenv("GLOT_MODEL_ID")
	glotAPIKey = os.Getenv("GLOT_API_KEY")
	glotLang = os.Getenv("GLOT_LANG")

	glotDataDir = os.Getenv("GLOT_DATA_DIR")
	if glotDataDir == "" {
		home, _ := os.UserHomeDir()
		glotDataDir = filepath.Join(home, ".config", "glot-cli")
	}
	glossaryDir = filepath.Join(glotDataDir, "glossary")
	promptsDir = filepath.Join(glotDataDir, "prompts")
	coreDir = filepath.Join(glotDataDir, "core")

	if v := os.Getenv("GLOT_MAX_STRINGS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			glotMaxStrings = n
		}
	}
	if v := os.Getenv("GLOT_BATCH_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			glotBatchSize = n
		}
	}
	if v := os.Getenv("GLOT_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			glotConcurrency = n
		}
	}
	if v := os.Getenv("GLOT_REQUEST_TIMEOUT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			glotRequestTimeout = n
		}
	}
}

// ---------------------------------------------------------------------------
// Language list (embedded)
// ---------------------------------------------------------------------------

//go:embed data/languages.json
var languagesData []byte

// loadValidLanguages is a var so tests can override.
var loadValidLanguages = func() map[string]string {
	if len(languagesData) == 0 {
		return map[string]string{}
	}
	var m map[string]string
	if err := json.Unmarshal(languagesData, &m); err != nil {
		return map[string]string{}
	}
	return m
}

func validateLang(lang string) {
	langs := loadValidLanguages()
	if len(langs) > 0 {
		if _, ok := langs[lang]; !ok {
			fmt.Fprintf(os.Stderr, "Error: unknown locale '%s'.\n", lang)
			osExit(1)
		}
	}
}

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

type GlossaryTerm struct {
	Translation string
	Pos         string
	Note        string
}

func loadGlossary(targetLang string) map[string]GlossaryTerm {
	path := filepath.Join(glossaryDir, targetLang+".tsv")
	f, err := os.Open(path)
	if err != nil {
		return map[string]GlossaryTerm{}
	}
	defer f.Close()

	out := map[string]GlossaryTerm{}
	r := csv.NewReader(f)
	r.Comma = '\t'
	r.FieldsPerRecord = -1 // allow variable columns
	r.LazyQuotes = true

	header, err := r.Read()
	if err != nil {
		return out
	}
	// Column indices
	colEN := indexOf(header, "en")
	colPos := indexOf(header, "pos")
	colDesc := indexOf(header, "description")
	// The lang column is the second column per Python behavior.
	langCol := -1
	if len(header) > 1 {
		langCol = 1
	}

	for {
		row, err := r.Read()
		if err != nil {
			break
		}
		if colEN < 0 || colEN >= len(row) {
			continue
		}
		term := strings.TrimSpace(strings.ToLower(row[colEN]))
		if term == "" {
			continue
		}
		raw := ""
		if langCol >= 0 && langCol < len(row) {
			raw = strings.TrimSpace(row[langCol])
		}
		translation := ""
		if raw != "" {
			translation = strings.TrimSpace(strings.SplitN(raw, ",", 2)[0])
		}
		pos, note := "", ""
		if colPos >= 0 && colPos < len(row) {
			pos = strings.TrimSpace(row[colPos])
		}
		if colDesc >= 0 && colDesc < len(row) {
			note = strings.TrimSpace(row[colDesc])
		}
		out[term] = GlossaryTerm{Translation: translation, Pos: pos, Note: note}
	}
	return out
}

func indexOf(a []string, s string) int {
	for i, v := range a {
		if v == s {
			return i
		}
	}
	return -1
}

func buildGlossaryIndex(g map[string]GlossaryTerm) map[string][]string {
	idx := map[string][]string{}
	for term := range g {
		first := strings.SplitN(term, " ", 2)[0]
		idx[first] = append(idx[first], term)
	}
	return idx
}

var wordRe = regexp.MustCompile(`[A-Za-z0-9_]+`)

func tokenize(text string) []string {
	tokens := wordRe.FindAllString(text, -1)
	for i, t := range tokens {
		tokens[i] = strings.ToLower(t)
	}
	if tokens == nil {
		return []string{}
	}
	return tokens
}

type termMatch struct {
	Term string
	Info GlossaryTerm
}

func matchingGlossaryTerms(text string, glossary map[string]GlossaryTerm, index map[string][]string) []termMatch {
	if len(glossary) == 0 {
		return nil
	}
	words := tokenize(text)
	seen := map[string]bool{}
	var out []termMatch
	for i, w := range words {
		for _, term := range index[w] {
			tw := strings.Fields(term)
			if i+len(tw) > len(words) {
				continue
			}
			match := true
			for k, part := range tw {
				if words[i+k] != part {
					match = false
					break
				}
			}
			if match && !seen[term] {
				seen[term] = true
				out = append(out, termMatch{Term: term, Info: glossary[term]})
			}
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Core translations & system prompt
// ---------------------------------------------------------------------------

// loadCoreTranslations is a var so tests can override.
var loadCoreTranslations = func(locale string) map[string]string {
	path := filepath.Join(coreDir, locale+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]string{}
	}
	var m map[string]string
	if json.Unmarshal(data, &m) != nil {
		return map[string]string{}
	}
	return m
}

func loadSystemPrompt(targetLang string) string {
	path := filepath.Join(promptsDir, targetLang+".md")
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// ---------------------------------------------------------------------------
// Prompt building & response parsing
// ---------------------------------------------------------------------------

type batchItem struct {
	MsgID   string
	Matches []termMatch
}

func buildBatchPrompt(items []batchItem, targetLang string, systemPrompt string) string {
	// Deduplicate glossary terms while preserving first-seen order.
	seenOrder := []string{}
	seenInfo := map[string]GlossaryTerm{}
	for _, it := range items {
		for _, m := range it.Matches {
			if _, ok := seenInfo[m.Term]; !ok {
				seenOrder = append(seenOrder, m.Term)
				seenInfo[m.Term] = m.Info
			}
		}
	}

	var b strings.Builder
	for i, it := range items {
		fmt.Fprintf(&b, "%d. %s\n", i+1, it.MsgID)
	}
	numbered := strings.TrimRight(b.String(), "\n")

	if systemPrompt != "" {
		glossaryBlock := ""
		if len(seenOrder) > 0 {
			var lines []string
			for _, t := range seenOrder {
				lines = append(lines, fmt.Sprintf("%s = %s", t, seenInfo[t].Translation))
			}
			glossaryBlock = "Approved terms:\n" + strings.Join(lines, "\n") + "\n\n"
		}
		return glossaryBlock + "Translate each numbered string:\n" + numbered
	}

	glossaryBlock := ""
	if len(seenOrder) > 0 {
		var lines []string
		for _, t := range seenOrder {
			info := seenInfo[t]
			line := fmt.Sprintf("- %q -> %q", t, info.Translation)
			if info.Note != "" {
				line += fmt.Sprintf(" (%s)", info.Note)
			}
			lines = append(lines, line)
		}
		glossaryBlock = "\n\nUse these exact terms where they apply:\n" + strings.Join(lines, "\n")
	}

	return fmt.Sprintf(
		"Translate each numbered English WordPress UI string into %s. "+
			"Follow these rules strictly:\n"+
			"1. Passthrough: if the entire string is a URL, email, file path, or version number, return it unchanged.\n"+
			"2. String type: commands/buttons → imperative verb form; labels/statuses/nouns → concise word or phrase, no added verb; sentences → natural sentence.\n"+
			"3. Placeholders: keep exactly as-is — printf variables (%%s, %%d, %%1$s), template variables ({{name}}, {{{{email}}}}), HTML tags, HTML entities (&amp;, &lt;, &gt;, &quot;), WordPress shortcodes, plugin/theme names, URLs.\n"+
			"4. Glossary: if approved terms are listed, copy them exactly — no synonyms, no alternatives.\n"+
			"Return ONLY a JSON object mapping number strings to translations: {\"1\": \"...\", \"2\": \"...\"}. "+
			"No explanation, no extra text.%s\n\n%s",
		targetLang, glossaryBlock, numbered,
	)
}

func buildReviewPrompt(msgids []string) string {
	var b strings.Builder
	for i, m := range msgids {
		fmt.Fprintf(&b, "%d. %s\n", i+1, m)
	}
	numbered := strings.TrimRight(b.String(), "\n")

	return "You are a WordPress i18n quality reviewer. Analyze each numbered English string for i18n violations.\n\n" +
		"Flag only these issues:\n" +
		"1. Hardcoded numeric literal that should use %d — e.g., \"Showing 5 results\", \"1 item found\", \"3 comments\". Do NOT flag strings without a digit or without a runtime-variable count (e.g., \"No results found\", \"Delete items\", \"Add new\", \"Recent posts\" are fine).\n" +
		"2. Hardcoded version number, date, or date format that should use %s\n" +
		"3. Hardcoded file name or file path that should use %s; or a URL/email embedded within other text — do NOT flag a string whose entire content is a URL or email\n" +
		"4. String that is clearly not user-facing (raw error codes, debug output, code snippets)\n" +
		"5. String starts with a lowercase letter and is not a continuation, code value, or proper noun — likely a concatenated fragment\n" +
		"6. HTML tags inside the string — HTML markup should be outside the translatable string or needs a /* translators: */ comment explaining the tags\n" +
		"7. Leading or trailing whitespace — padding inside translatable strings causes translation mismatches\n" +
		"8. Ambiguous string that needs _x() with context — e.g., a single word that could be a verb or noun, or a question used as a UI label\n" +
		"9. Hardcoded ordinal suffix (e.g., \"1st\", \"2nd\", \"3rd\") — ordinals are not universal and should use %s\n\n" +
		"Return ONLY a JSON object mapping string numbers (as strings) to a short issue description. " +
		"Include only strings with issues. Return {} if all strings are fine. No explanation outside the JSON.\n\n" +
		numbered
}

// stripCodeFences trims ```/```json fences around the response.
func stripCodeFences(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		// remove opening fence line
		nl := strings.Index(s, "\n")
		if nl >= 0 {
			s = s[nl+1:]
		} else {
			s = strings.TrimPrefix(s, "```")
		}
	}
	s = strings.TrimSpace(s)
	if strings.HasSuffix(s, "```") {
		s = strings.TrimSuffix(s, "```")
	}
	return strings.TrimSpace(s)
}

func parseBatchResponse(response string, count int) []string {
	results := make([]string, count)

	text := stripCodeFences(response)
	var data map[string]any
	if err := json.Unmarshal([]byte(text), &data); err == nil {
		for k, v := range data {
			idx, err := strconv.Atoi(k)
			if err != nil {
				continue
			}
			idx--
			if idx >= 0 && idx < count {
				results[idx] = strings.TrimSpace(fmt.Sprint(v))
			}
		}
		return results
	}

	// Regex fallback
	re := regexp.MustCompile(`(?m)^(\d+)\.\s*(.+)$`)
	for _, m := range re.FindAllStringSubmatch(response, -1) {
		idx, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		idx--
		if idx >= 0 && idx < count {
			results[idx] = strings.TrimSpace(m[2])
		}
	}
	return results
}

func parseReviewResponse(response string) map[string]string {
	text := stripCodeFences(response)
	var data map[string]any
	if json.Unmarshal([]byte(text), &data) != nil {
		return map[string]string{}
	}
	out := map[string]string{}
	for k, v := range data {
		if v == nil {
			continue
		}
		s := strings.TrimSpace(fmt.Sprint(v))
		if s == "" {
			continue
		}
		out[k] = s
	}
	return out
}

// ---------------------------------------------------------------------------
// AI call (HTTP)
// ---------------------------------------------------------------------------

type usageInfo struct {
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
}

// callAI is a var so tests can inject a mock.
var callAI = defaultCallAI

func defaultCallAI(prompt string, systemPrompt string, temperature float64) (string, *usageInfo, error) {
	messages := []map[string]string{}
	if systemPrompt != "" {
		messages = append(messages, map[string]string{"role": "system", "content": systemPrompt})
	}
	messages = append(messages, map[string]string{"role": "user", "content": prompt})

	payload := map[string]any{
		"model":       glotModelID,
		"messages":    messages,
		"temperature": temperature,
	}
	body, _ := json.Marshal(payload)

	client := &http.Client{}
	if glotRequestTimeout > 0 {
		client.Timeout = time.Duration(glotRequestTimeout) * time.Second
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequest("POST", glotEndpointURL, bytes.NewReader(body))
		if err != nil {
			return "", nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		if glotAPIKey != "" {
			req.Header.Set("Authorization", "Bearer "+glotAPIKey)
		}

		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			return "", nil, err
		}
		if resp.StatusCode == 429 {
			resp.Body.Close()
			time.Sleep(time.Duration(1<<attempt) * time.Second)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			buf, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
			resp.Body.Close()
			return "", nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(buf)))
		}

		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return "", nil, err
		}
		var parsed struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
				TotalTokens      int `json:"total_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(data, &parsed); err != nil {
			return "", nil, err
		}
		if len(parsed.Choices) == 0 {
			return "", nil, fmt.Errorf("no choices in response")
		}
		content := strings.TrimSpace(parsed.Choices[0].Message.Content)
		var usage *usageInfo
		if parsed.Usage != nil {
			usage = &usageInfo{
				PromptTokens:     parsed.Usage.PromptTokens,
				CompletionTokens: parsed.Usage.CompletionTokens,
				TotalTokens:      parsed.Usage.TotalTokens,
			}
		}
		return content, usage, nil
	}
	if lastErr != nil {
		return "", nil, lastErr
	}
	return "", nil, fmt.Errorf("exhausted retries")
}

// ---------------------------------------------------------------------------
// translate command
// ---------------------------------------------------------------------------

type translateArgs struct {
	Input string
	Lang  string
	Limit int
}

func cmdTranslate(args translateArgs) {
	missing := []string{}
	if glotEndpointURL == "" {
		missing = append(missing, "GLOT_ENDPOINT_URL")
	}
	if glotModelID == "" {
		missing = append(missing, "GLOT_MODEL_ID")
	}
	if len(missing) > 0 {
		fmt.Fprintf(os.Stderr, "Error: required environment variable(s) not set: %s\n", strings.Join(missing, ", "))
		osExit(1)
	}

	validateLang(args.Lang)

	if _, err := os.Stat(args.Input); err != nil {
		fmt.Fprintf(os.Stderr, "Error: file not found: %s\n", args.Input)
		osExit(1)
	}

	glossary := loadGlossary(args.Lang)
	glossaryIdx := buildGlossaryIndex(glossary)
	systemPrompt := loadSystemPrompt(args.Lang)
	core := loadCoreTranslations(args.Lang)

	pf, err := ParsePoFile(args.Input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot read file: %v\n", err)
		osExit(1)
	}

	translatable := pf.TranslatableEntries()
	var missingEntries []*Entry
	for _, e := range translatable {
		if !e.Translated() {
			missingEntries = append(missingEntries, e)
		}
	}

	if len(missingEntries) == 0 {
		fmt.Println("Nothing to do. File is already fully translated.")
		return
	}

	coreHits := 0
	if len(core) > 0 {
		var remaining []*Entry
		for _, e := range missingEntries {
			key := e.MsgID
			if e.MsgCtxt != "" {
				key = e.MsgCtxt + "\x04" + e.MsgID
			}
			if v, ok := core[key]; ok && v != "" {
				e.MsgStr = v
				coreHits++
			} else {
				remaining = append(remaining, e)
			}
		}
		missingEntries = remaining
	}

	fmt.Printf("Found %d untranslated string(s).\n", len(missingEntries)+coreHits)
	if coreHits > 0 {
		fmt.Printf("Core matches: %d (skipped AI)\n", coreHits)
	}
	if len(glossary) > 0 {
		fmt.Printf("Glossary loaded: %d terms (%s)\n", len(glossary), args.Lang)
	}
	if systemPrompt != "" {
		fmt.Println("Custom system prompt loaded.")
	}

	if len(missingEntries) == 0 {
		if err := pf.Save(args.Input); err != nil {
			fmt.Fprintf(os.Stderr, "Error: cannot write file: %v\n", err)
			osExit(1)
		}
		fmt.Printf("\nSaved: %s\n", args.Input)
		fmt.Printf("Translated: %d  Failed: 0\n", coreHits)
		return
	}

	backupPath := args.Input + ".bak"
	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		if err := copyFile(args.Input, backupPath); err == nil {
			fmt.Printf("Backup created: %s\n", backupPath)
		}
	}

	if args.Limit < 0 {
		fmt.Fprintln(os.Stderr, "Error: --limit must be a non-negative integer")
		osExit(1)
	}
	limit := args.Limit
	if limit == 0 {
		limit = glotMaxStrings
	}
	capped := len(missingEntries) > limit
	batch := missingEntries
	if capped {
		batch = missingEntries[:limit]
	}

	// Split into chunks
	var chunks [][]*Entry
	for i := 0; i < len(batch); i += glotBatchSize {
		end := i + glotBatchSize
		if end > len(batch) {
			end = len(batch)
		}
		chunks = append(chunks, batch[i:end])
	}

	fmt.Printf("Translating %d string(s) in %d batch(es) (batch size: %d, concurrency: %d) ...\n\n",
		len(batch), len(chunks), glotBatchSize, glotConcurrency)

	type failedEntry struct {
		MsgID string
		Error string
	}

	type chunkResult struct {
		Idx          int
		Chunk        []*Entry
		Translations []string
		Usage        *usageInfo
		Err          error
	}

	results := make(chan chunkResult, len(chunks))

	sem := make(chan struct{}, glotConcurrency)
	var wg sync.WaitGroup
	for idx, chunk := range chunks {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, chunk []*Entry) {
			defer wg.Done()
			defer func() { <-sem }()

			items := make([]batchItem, len(chunk))
			for i, e := range chunk {
				items[i] = batchItem{
					MsgID:   e.MsgID,
					Matches: matchingGlossaryTerms(e.MsgID, glossary, glossaryIdx),
				}
			}
			prompt := buildBatchPrompt(items, args.Lang, systemPrompt)
			resp, usage, err := callAI(prompt, systemPrompt, 0.1)
			if err != nil {
				results <- chunkResult{Idx: idx, Chunk: chunk, Err: err}
				return
			}
			trs := parseBatchResponse(resp, len(chunk))
			results <- chunkResult{Idx: idx, Chunk: chunk, Translations: trs, Usage: usage}
		}(idx, chunk)
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	var failed []failedEntry
	totalUsage := usageInfo{}
	usageComplete := true
	doneStrings := 0

	for r := range results {
		if r.Err != nil {
			usageComplete = false
			doneStrings += len(r.Chunk)
			for _, e := range r.Chunk {
				failed = append(failed, failedEntry{MsgID: e.MsgID, Error: r.Err.Error()})
			}
			fmt.Printf("  Batch %d/%d: FAILED — %s  [%d/%d]\n", r.Idx+1, len(chunks), r.Err.Error(), doneStrings, len(batch))
			continue
		}
		if r.Usage == nil {
			usageComplete = false
		} else {
			totalUsage.PromptTokens += r.Usage.PromptTokens
			totalUsage.CompletionTokens += r.Usage.CompletionTokens
			totalUsage.TotalTokens += r.Usage.TotalTokens
		}
		ok := 0
		for i, e := range r.Chunk {
			tr := ""
			if i < len(r.Translations) {
				tr = r.Translations[i]
			}
			if tr != "" {
				e.MsgStr = tr
				ok++
			} else {
				failed = append(failed, failedEntry{MsgID: e.MsgID, Error: "missing from response"})
			}
		}
		doneStrings += len(r.Chunk)
		fmt.Printf("  Batch %d/%d: %d/%d ok  [%d/%d]\n", r.Idx+1, len(chunks), ok, len(r.Chunk), doneStrings, len(batch))
	}

	if err := pf.Save(args.Input); err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot write file: %v\n", err)
		osExit(1)
	}

	translated := len(batch) - len(failed)
	fmt.Printf("\nSaved: %s\n", args.Input)
	fmt.Printf("Translated: %d  Failed: %d\n", translated+coreHits, len(failed))
	if usageComplete && totalUsage.TotalTokens > 0 {
		fmt.Printf("Tokens: input=%d, output=%d, total=%d\n",
			totalUsage.PromptTokens, totalUsage.CompletionTokens, totalUsage.TotalTokens)
	}

	if len(failed) > 0 {
		fmt.Println("\nFailed entries:")
		for i, f := range failed {
			if i >= 10 {
				break
			}
			msgid := f.MsgID
			if len(msgid) > 80 {
				msgid = msgid[:80]
			}
			fmt.Printf("  [%s] %s\n", f.Error, msgid)
		}
	}

	if capped {
		remaining := len(missingEntries) - limit
		fmt.Printf("\nNote: %d string(s) remain. Run again to continue.\n", remaining)
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// ---------------------------------------------------------------------------
// review command
// ---------------------------------------------------------------------------

type reviewArgs struct {
	Input  string
	Format string
}

type reviewItem struct {
	Num         int      `json:"num"`
	MsgID       string   `json:"msgid"`
	Occurrences []string `json:"occurrences"`
	StaticIssue string   `json:"static_issue,omitempty"`
	AIIssue     string   `json:"ai_issue,omitempty"`
}

func cmdReview(args reviewArgs) {
	missing := []string{}
	if glotEndpointURL == "" {
		missing = append(missing, "GLOT_ENDPOINT_URL")
	}
	if glotModelID == "" {
		missing = append(missing, "GLOT_MODEL_ID")
	}
	if len(missing) > 0 {
		fmt.Fprintf(os.Stderr, "Error: required environment variable(s) not set: %s\n", strings.Join(missing, ", "))
		osExit(1)
	}

	if _, err := os.Stat(args.Input); err != nil {
		fmt.Fprintf(os.Stderr, "Error: file not found: %s\n", args.Input)
		osExit(1)
	}

	pf, err := ParsePoFile(args.Input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot read file: %v\n", err)
		osExit(1)
	}

	entries := pf.TranslatableEntries()
	if len(entries) == 0 {
		fmt.Fprintln(os.Stderr, "No strings found.")
		return
	}

	machineFmt := args.Format == "json" || args.Format == "csv" || args.Format == "markdown"

	if !machineFmt {
		fmt.Fprintf(os.Stderr, "Reviewing %d string(s) in %s ...\n\n", len(entries), args.Input)
	}

	placeholderRe := regexp.MustCompile(`%(\d+\$)?[sd]`)
	staticIssues := map[int]string{}
	for i, e := range entries {
		if placeholderRe.MatchString(e.MsgID) && !e.HasTranslatorComment() {
			staticIssues[i] = "Has %s/%d placeholder but no /* translators: */ comment"
		}
	}

	// Chunk entries
	var chunks [][]*Entry
	for i := 0; i < len(entries); i += glotBatchSize {
		end := i + glotBatchSize
		if end > len(entries) {
			end = len(entries)
		}
		chunks = append(chunks, entries[i:end])
	}

	type chunkResult struct {
		Idx    int
		Chunk  []*Entry
		Issues map[string]string
		Usage  *usageInfo
		Err    error
	}

	results := make(chan chunkResult, len(chunks))
	sem := make(chan struct{}, glotConcurrency)
	var wg sync.WaitGroup
	for idx, chunk := range chunks {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, chunk []*Entry) {
			defer wg.Done()
			defer func() { <-sem }()
			msgids := make([]string, len(chunk))
			for i, e := range chunk {
				msgids[i] = e.MsgID
			}
			prompt := buildReviewPrompt(msgids)
			resp, usage, err := callAI(prompt, "", 0.0)
			if err != nil {
				results <- chunkResult{Idx: idx, Chunk: chunk, Err: err}
				return
			}
			results <- chunkResult{Idx: idx, Chunk: chunk, Issues: parseReviewResponse(resp), Usage: usage}
		}(idx, chunk)
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	aiIssues := map[int]string{}
	totalUsage := usageInfo{}
	usageComplete := true
	completed := 0

	for r := range results {
		completed++
		if r.Err != nil {
			usageComplete = false
			if !machineFmt {
				fmt.Fprintf(os.Stderr, "  Batch %d/%d: FAILED — %s  [%d/%d]\n", r.Idx+1, len(chunks), r.Err.Error(), completed, len(chunks))
			}
			continue
		}
		if r.Usage == nil {
			usageComplete = false
		} else {
			totalUsage.PromptTokens += r.Usage.PromptTokens
			totalUsage.CompletionTokens += r.Usage.CompletionTokens
			totalUsage.TotalTokens += r.Usage.TotalTokens
		}
		offset := r.Idx * glotBatchSize
		for k, v := range r.Issues {
			localIdx, err := strconv.Atoi(k)
			if err != nil {
				continue
			}
			localIdx--
			if localIdx >= 0 && localIdx < len(r.Chunk) {
				aiIssues[offset+localIdx] = v
			}
		}
		if !machineFmt {
			fmt.Fprintf(os.Stderr, "  Batch %d/%d: done  [%d/%d]\n", r.Idx+1, len(chunks), completed, len(chunks))
		}
	}

	// Merge indices
	indices := map[int]bool{}
	for i := range staticIssues {
		indices[i] = true
	}
	for i := range aiIssues {
		indices[i] = true
	}
	sorted := make([]int, 0, len(indices))
	for i := range indices {
		sorted = append(sorted, i)
	}
	sort.Ints(sorted)

	report := make([]reviewItem, 0, len(sorted))
	for _, idx := range sorted {
		e := entries[idx]
		var occs []string
		for _, o := range e.Occurrences() {
			if o[1] != "" {
				occs = append(occs, o[0]+":"+o[1])
			} else {
				occs = append(occs, o[0])
			}
		}
		if occs == nil {
			occs = []string{}
		}
		report = append(report, reviewItem{
			Num:         idx + 1,
			MsgID:       e.MsgID,
			Occurrences: occs,
			StaticIssue: staticIssues[idx],
			AIIssue:     aiIssues[idx],
		})
	}

	var usageDisplay *usageInfo
	if usageComplete && totalUsage.TotalTokens > 0 {
		u := totalUsage
		usageDisplay = &u
	}
	outputReviewReport(report, len(entries), args.Format, usageDisplay)
}

func formatIssueDisplay(item reviewItem) string {
	var parts []string
	if item.StaticIssue != "" {
		parts = append(parts, item.StaticIssue)
	}
	if item.AIIssue != "" {
		parts = append(parts, "✨ "+item.AIIssue)
	}
	return strings.Join(parts, "; ")
}

func truncateStr(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

func outputReviewReport(report []reviewItem, total int, format string, usage *usageInfo) {
	printTokens := func() {
		if usage != nil {
			fmt.Printf("Tokens: input=%d, output=%d, total=%d\n",
				usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens)
		}
	}

	switch format {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.SetEscapeHTML(false)
		// Ensure occurrences serialize as [] not null (handled above).
		_ = enc.Encode(report)
		return

	case "markdown":
		fmt.Println("| # | String | Location | Issue |")
		fmt.Println("|---|--------|----------|-------|")
		for _, it := range report {
			preview := truncateStr(it.MsgID, 60)
			locations := "—"
			if len(it.Occurrences) > 0 {
				locations = strings.Join(it.Occurrences, ", ")
			}
			fmt.Printf("| %d | %s | %s | %s |\n", it.Num, preview, locations, formatIssueDisplay(it))
		}
		if usage != nil {
			fmt.Println()
			printTokens()
		}
		return

	case "csv":
		w := csv.NewWriter(os.Stdout)
		_ = w.Write([]string{"num", "msgid", "occurrences", "static_issue", "ai_issue"})
		for _, it := range report {
			_ = w.Write([]string{
				strconv.Itoa(it.Num),
				it.MsgID,
				strings.Join(it.Occurrences, "; "),
				it.StaticIssue,
				it.AIIssue,
			})
		}
		w.Flush()
		return

	case "table":
		if len(report) == 0 {
			fmt.Println("\nNo issues found.")
			printTokens()
			return
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "#\tString\tLocation\tIssue")
		fmt.Fprintln(tw, "-\t------\t--------\t-----")
		for _, it := range report {
			preview := truncateStr(it.MsgID, 80)
			loc := "—"
			if len(it.Occurrences) > 0 {
				loc = strings.Join(it.Occurrences, "\n")
			}
			fmt.Fprintf(tw, "%d\t%s\t%s\t%s\n", it.Num, preview, loc, formatIssueDisplay(it))
		}
		tw.Flush()
		fmt.Printf("\nTotal: %d issue(s) in %d string(s)\n", len(report), total)
		printTokens()
		return
	}

	// text (default)
	if len(report) == 0 {
		fmt.Println("\nNo issues found.")
		printTokens()
		return
	}
	fmt.Printf("\nFound %d issue(s):\n\n", len(report))
	for _, it := range report {
		preview := truncateStr(it.MsgID, 80)
		fmt.Printf("  String: %q\n", preview)
		for _, occ := range it.Occurrences {
			fmt.Printf("  %s\n", occ)
		}
		fmt.Printf("  Issue: %s\n\n", formatIssueDisplay(it))
	}
	fmt.Printf("Total: %d issue(s) in %d string(s)\n", len(report), total)
	printTokens()
}

// ---------------------------------------------------------------------------
// status command
// ---------------------------------------------------------------------------

type statusArgs struct {
	Input string
	Lang  string
}

func cmdStatus(args statusArgs) {
	if args.Lang != "" {
		validateLang(args.Lang)
	}

	if _, err := os.Stat(args.Input); err != nil {
		fmt.Fprintf(os.Stderr, "Error: file not found: %s\n", args.Input)
		osExit(1)
	}

	pf, err := ParsePoFile(args.Input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot read file: %v\n", err)
		osExit(1)
	}

	total := pf.Total()
	translated := pf.TranslatedCount()
	untranslated := pf.UntranslatedCount()
	fuzzy := pf.FuzzyCount()
	pct := 0.0
	if total > 0 {
		pct = float64(translated) / float64(total) * 100
	}

	fmt.Printf("File: %s\n\n", args.Input)
	fmt.Printf("  %-14s %d\n", "Total", total)
	fmt.Printf("  %-14s %d  (%.1f%%)\n", "Translated", translated, pct)
	fmt.Printf("  %-14s %d\n", "Untranslated", untranslated)
	fmt.Printf("  %-14s %d\n", "Fuzzy", fuzzy)

	if args.Lang != "" {
		core := loadCoreTranslations(args.Lang)
		if len(core) > 0 {
			cacheHits := 0
			for _, e := range pf.TranslatableEntries() {
				if e.Translated() {
					continue
				}
				key := e.MsgID
				if e.MsgCtxt != "" {
					key = e.MsgCtxt + "\x04" + e.MsgID
				}
				if _, ok := core[key]; ok {
					cacheHits++
				}
			}
			fmt.Printf("\n  Core cache (%s): %d of %d untranslated string(s) have cached translations\n",
				args.Lang, cacheHits, untranslated)
		}
	}
}

// ---------------------------------------------------------------------------
// glossary commands
// ---------------------------------------------------------------------------

func cmdGlossaryList() {
	fi, err := os.Stat(glossaryDir)
	if err != nil || !fi.IsDir() {
		fmt.Printf("Glossary directory not found: %s\n", glossaryDir)
		return
	}
	entries, _ := os.ReadDir(glossaryDir)
	var tsvFiles []os.DirEntry
	for _, ent := range entries {
		if !ent.IsDir() && strings.HasSuffix(ent.Name(), ".tsv") {
			tsvFiles = append(tsvFiles, ent)
		}
	}
	sort.Slice(tsvFiles, func(i, j int) bool { return tsvFiles[i].Name() < tsvFiles[j].Name() })
	if len(tsvFiles) == 0 {
		fmt.Println("No glossary files found.")
		return
	}
	fmt.Printf("Data dir: %s\n\n", glotDataDir)
	fmt.Printf("%-12s  %-12s  ENTRIES\n", "LOCALE", "LAST UPDATED")
	fmt.Printf("%-12s  %-12s  -------\n", "------------", "------------")
	for _, ent := range tsvFiles {
		locale := strings.TrimSuffix(ent.Name(), ".tsv")
		info, _ := ent.Info()
		mtime := info.ModTime()
		// Count lines minus header
		count := countLines(filepath.Join(glossaryDir, ent.Name())) - 1
		if count < 0 {
			count = 0
		}
		fmt.Printf("%-12s  %-12s  %d\n", locale, mtime.Format("2006-01-02"), count)
	}
}

func countLines(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	n := 0
	for scanner.Scan() {
		n++
	}
	return n
}

type glossaryPullArgs struct {
	Locale string
}

func cmdGlossaryPull(args glossaryPullArgs) {
	if args.Locale == "" {
		fmt.Fprintln(os.Stderr, "Error: locale is required (or set GLOT_LANG env variable)")
		osExit(1)
	}
	validateLang(args.Locale)
	locale := args.Locale
	parts := strings.Split(locale, "_")
	baseURL := "https://translate.wordpress.org/locale"

	tryURL := func(u string) string {
		fmt.Printf("Trying: %s\n", u)
		body, ok := httpGet(u)
		if ok && strings.HasPrefix(body, "en,") {
			return body
		}
		return ""
	}

	csvText := ""
	if len(parts) >= 3 {
		lang := strings.ToLower(parts[0])
		variant := strings.ToLower(parts[2])
		csvText = tryURL(fmt.Sprintf("%s/%s/%s/glossary/-export/", baseURL, lang, variant))
		if csvText == "" {
			fmt.Fprintf(os.Stderr, "Error: could not fetch glossary for '%s'.\n", locale)
			osExit(1)
		}
	} else {
		fullSlug := strings.ToLower(strings.ReplaceAll(locale, "_", "-"))
		langOnly := strings.ToLower(parts[0])
		slugs := []string{fullSlug}
		if fullSlug != langOnly {
			slugs = append(slugs, langOnly)
		}
		for _, slug := range slugs {
			csvText = tryURL(fmt.Sprintf("%s/%s/default/glossary/-export/", baseURL, slug))
			if csvText != "" {
				break
			}
		}
		if csvText == "" {
			fmt.Fprintf(os.Stderr, "Error: could not fetch glossary for '%s'.\n", locale)
			osExit(1)
		}
	}

	if err := os.MkdirAll(glossaryDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot create dir: %v\n", err)
		osExit(1)
	}
	dest := filepath.Join(glossaryDir, locale+".tsv")
	out, err := os.Create(dest)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot write file: %v\n", err)
		osExit(1)
	}
	defer out.Close()

	r := csv.NewReader(strings.NewReader(csvText))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	rows := 0
	for {
		row, err := r.Read()
		if err != nil {
			break
		}
		if len(row) < 4 {
			continue
		}
		clean := make([]string, len(row))
		for i, f := range row {
			clean[i] = strings.ReplaceAll(f, "\t", " ")
		}
		fmt.Fprintln(out, strings.Join(clean, "\t"))
		rows++
	}
	entries := rows - 1
	if entries < 0 {
		entries = 0
	}
	fmt.Printf("Saved %d entries to %s\n", entries, dest)
}

// httpGet returns body, ok. Only treats status 200 as ok.
func httpGet(u string) (string, bool) {
	// Basic sanity: absolute HTTPS/HTTP only.
	if !(strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")) {
		return "", false
	}
	if _, err := url.Parse(u); err != nil {
		return "", false
	}
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return "", false
	}
	req.Header.Set("User-Agent", "glot-cli/"+VERSION)
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", false
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", false
	}
	return string(body), true
}

// ---------------------------------------------------------------------------
// core commands
// ---------------------------------------------------------------------------

func cmdCoreList() {
	fi, err := os.Stat(coreDir)
	if err != nil || !fi.IsDir() {
		fmt.Printf("Core directory not found: %s\n", coreDir)
		return
	}
	entries, _ := os.ReadDir(coreDir)
	var jsonFiles []os.DirEntry
	for _, ent := range entries {
		if !ent.IsDir() && strings.HasSuffix(ent.Name(), ".json") {
			jsonFiles = append(jsonFiles, ent)
		}
	}
	sort.Slice(jsonFiles, func(i, j int) bool { return jsonFiles[i].Name() < jsonFiles[j].Name() })
	if len(jsonFiles) == 0 {
		fmt.Println("No core translation files found.")
		return
	}
	fmt.Printf("Data dir: %s\n\n", glotDataDir)
	fmt.Printf("%-12s  %-12s  ENTRIES\n", "LOCALE", "LAST UPDATED")
	fmt.Printf("%-12s  %-12s  -------\n", "------------", "------------")
	for _, ent := range jsonFiles {
		locale := strings.TrimSuffix(ent.Name(), ".json")
		info, _ := ent.Info()
		mtime := info.ModTime()
		data, _ := os.ReadFile(filepath.Join(coreDir, ent.Name()))
		var m map[string]string
		_ = json.Unmarshal(data, &m)
		fmt.Printf("%-12s  %-12s  %d\n", locale, mtime.Format("2006-01-02"), len(m))
	}
}

type corePullArgs struct {
	Locale string
}

func cmdCorePull(args corePullArgs) {
	if args.Locale == "" {
		fmt.Fprintln(os.Stderr, "Error: locale is required (or set GLOT_LANG env variable)")
		osExit(1)
	}
	validateLang(args.Locale)
	locale := args.Locale
	parts := strings.Split(locale, "_")
	fullSlug := strings.ToLower(strings.ReplaceAll(locale, "_", "-"))
	langOnly := strings.ToLower(parts[0])
	slugs := []string{fullSlug}
	if fullSlug != langOnly {
		slugs = append(slugs, langOnly)
	}

	base := "https://translate.wordpress.org/projects"
	fetchPO := func(u string) (string, bool) {
		return httpGet(u)
	}

	var firstText string
	workingSlug := ""
	for _, slug := range slugs {
		u := fmt.Sprintf("%s/%s/export-translations/?format=po", base, strings.Replace(coreProjects[0], "{slug}", slug, -1))
		fmt.Printf("Trying: %s\n", u)
		if body, ok := fetchPO(u); ok {
			workingSlug = slug
			firstText = body
			break
		}
	}
	if workingSlug == "" {
		fmt.Fprintf(os.Stderr, "Error: could not fetch core translations for '%s'.\n", locale)
		osExit(1)
	}

	remainingURLs := make([]string, 0, len(coreProjects)-1)
	for _, t := range coreProjects[1:] {
		remainingURLs = append(remainingURLs,
			fmt.Sprintf("%s/%s/export-translations/?format=po", base, strings.Replace(t, "{slug}", workingSlug, -1)))
	}

	poTexts := []string{firstText}
	fetched := make([]string, len(remainingURLs))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 2)
	for i, u := range remainingURLs {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, u string) {
			defer wg.Done()
			defer func() { <-sem }()
			body, ok := fetchPO(u)
			if !ok {
				fetched[i] = ""
				return
			}
			fetched[i] = body
		}(i, u)
	}
	wg.Wait()
	poTexts = append(poTexts, fetched...)

	labels := []string{"wp/dev", "wp/dev/admin", "wp/dev/admin/network"}
	index := map[string]string{}
	for i, text := range poTexts {
		label := labels[i]
		if text == "" {
			fmt.Printf("  %s: skipped (not available)\n", label)
			continue
		}
		pf, err := ParsePo([]byte(text))
		if err != nil {
			fmt.Printf("  %s: parse error (%v)\n", label, err)
			continue
		}
		count := 0
		for _, e := range pf.TranslatableEntries() {
			if !e.Translated() {
				continue
			}
			key := e.MsgID
			if e.MsgCtxt != "" {
				key = e.MsgCtxt + "\x04" + e.MsgID
			}
			index[key] = e.MsgStr
			count++
		}
		fmt.Printf("  %s: %d strings\n", label, count)
	}

	if err := os.MkdirAll(coreDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot create dir: %v\n", err)
		osExit(1)
	}
	dest := filepath.Join(coreDir, locale+".json")
	data, _ := json.Marshal(index)
	if err := os.WriteFile(dest, data, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot write file: %v\n", err)
		osExit(1)
	}
	fmt.Printf("Saved %d entries to %s\n", len(index), dest)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const helpText = `glot - Translate WordPress .po files using any OpenAI-compatible backend.

USAGE
  glot <command> [options]

COMMANDS
  translate <file> [--lang <code>] [--limit <n>]
      Translate missing entries in a .po file.

  review <file> [--format text|table|json|csv|markdown]
      Review strings in a .po/.pot file for i18n issues.

  status <file> [--lang <code>]
      Show translation progress for a .po file.

  glossary list
  glossary pull [<locale>]
      Manage glossary files.

  core list
  core pull [<locale>]
      Manage core translation cache.

  -V, --version   Show version and exit.
  -h, --help      Show this help.

ENVIRONMENT
  GLOT_ENDPOINT_URL   OpenAI-compatible chat/completions URL (required)
  GLOT_MODEL_ID       Model ID (required)
  GLOT_API_KEY        API key (optional for local backends)
  GLOT_LANG           Default target locale code (e.g. ne_NP)
  GLOT_DATA_DIR       Data directory (default: ~/.config/glot-cli)
  GLOT_MAX_STRINGS    Max strings per translate run (default: 200)
  GLOT_BATCH_SIZE     Strings per API call (default: 10)
  GLOT_CONCURRENCY    Parallel API calls (default: 1)
  GLOT_REQUEST_TIMEOUT Request timeout in seconds (default: 120; 0 disables)
`

func main() {
	loadConfig()

	if len(os.Args) < 2 {
		fmt.Print(helpText)
		osExit(0)
	}

	switch os.Args[1] {
	case "-h", "--help":
		fmt.Print(helpText)
		return
	case "-V", "--version":
		fmt.Printf("glot %s\n", VERSION)
		return
	}

	cmd := os.Args[1]
	rest := os.Args[2:]

	switch cmd {
	case "translate":
		runTranslate(rest)
	case "review":
		runReview(rest)
	case "status":
		runStatus(rest)
	case "glossary":
		runGlossary(rest)
	case "core":
		runCore(rest)
	default:
		fmt.Fprintf(os.Stderr, "Error: unknown command %q\n\n", cmd)
		fmt.Fprint(os.Stderr, helpText)
		osExit(2)
	}
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	fs.SetOutput(os.Stderr)
	return fs
}

func runTranslate(rest []string) {
	fs := newFlagSet("translate")
	lang := fs.String("lang", glotLang, "Target locale code (overrides GLOT_LANG)")
	limit := fs.Int("limit", 0, "Max strings this run (0 = GLOT_MAX_STRINGS)")
	_ = fs.Parse(normalizeArgs(rest))
	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "Error: input .po file is required")
		osExit(2)
	}
	if *lang == "" {
		fmt.Fprintln(os.Stderr, "Error: --lang is required (or set GLOT_LANG env variable)")
		osExit(2)
	}
	cmdTranslate(translateArgs{Input: fs.Arg(0), Lang: *lang, Limit: *limit})
}

func runReview(rest []string) {
	fs := newFlagSet("review")
	format := fs.String("format", "text", "Output format: text, table, json, csv, markdown")
	_ = fs.Parse(normalizeArgs(rest))
	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "Error: input .po/.pot file is required")
		osExit(2)
	}
	switch *format {
	case "text", "table", "json", "csv", "markdown":
	default:
		fmt.Fprintf(os.Stderr, "Error: invalid --format %q\n", *format)
		osExit(2)
	}
	cmdReview(reviewArgs{Input: fs.Arg(0), Format: *format})
}

func runStatus(rest []string) {
	fs := newFlagSet("status")
	lang := fs.String("lang", glotLang, "Locale for core cache check")
	_ = fs.Parse(normalizeArgs(rest))
	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "Error: input .po file is required")
		osExit(2)
	}
	cmdStatus(statusArgs{Input: fs.Arg(0), Lang: *lang})
}

func runGlossary(rest []string) {
	if len(rest) == 0 {
		fmt.Fprintln(os.Stderr, "Error: glossary requires a subcommand: list, pull")
		osExit(2)
	}
	sub := rest[0]
	inner := rest[1:]
	switch sub {
	case "list":
		cmdGlossaryList()
	case "pull":
		fs := newFlagSet("glossary pull")
		_ = fs.Parse(normalizeArgs(inner))
		loc := glotLang
		if fs.NArg() > 0 {
			loc = fs.Arg(0)
		}
		cmdGlossaryPull(glossaryPullArgs{Locale: loc})
	default:
		fmt.Fprintf(os.Stderr, "Error: unknown glossary subcommand %q\n", sub)
		osExit(2)
	}
}

func runCore(rest []string) {
	if len(rest) == 0 {
		fmt.Fprintln(os.Stderr, "Error: core requires a subcommand: list, pull")
		osExit(2)
	}
	sub := rest[0]
	inner := rest[1:]
	switch sub {
	case "list":
		cmdCoreList()
	case "pull":
		fs := newFlagSet("core pull")
		_ = fs.Parse(normalizeArgs(inner))
		loc := glotLang
		if fs.NArg() > 0 {
			loc = fs.Arg(0)
		}
		cmdCorePull(corePullArgs{Locale: loc})
	default:
		fmt.Fprintf(os.Stderr, "Error: unknown core subcommand %q\n", sub)
		osExit(2)
	}
}

// normalizeArgs converts GNU --long-flag into Go's -long-flag form.
func normalizeArgs(in []string) []string {
	out := make([]string, 0, len(in))
	for _, a := range in {
		if strings.HasPrefix(a, "--") && len(a) > 2 {
			out = append(out, a[1:])
			continue
		}
		out = append(out, a)
	}
	return out
}
