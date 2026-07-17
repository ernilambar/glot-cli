package main

import (
	"bytes"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/leonelquinteros/gotext"
)

// Entry represents a single PO/POT entry.
type Entry struct {
	MsgCtxt      string
	MsgID        string
	MsgIDPlural  string
	MsgStr       string
	MsgStrPlural map[int]string

	// Translator comments (# ...)
	TranslatorComments []string
	// Extracted comments (#. ...)
	ExtractedComments []string
	// References (#: file:line ...)
	References []string
	// Flags (#, fuzzy, c-format, ...)
	Flags []string
	// Whether entry is marked obsolete (#~ ...)
	Obsolete bool

	// Original raw block for header entries (msgid ""). Preserved verbatim for round-trip.
	rawHeaderBlock string
	isHeader       bool
}

// Fuzzy returns whether the entry has the fuzzy flag.
func (e *Entry) Fuzzy() bool {
	for _, f := range e.Flags {
		if f == "fuzzy" {
			return true
		}
	}
	return false
}

// Translated returns true if the entry has a non-empty msgstr and is not fuzzy.
func (e *Entry) Translated() bool {
	if e.Fuzzy() {
		return false
	}
	if e.MsgIDPlural != "" {
		if len(e.MsgStrPlural) == 0 {
			return false
		}
		for _, v := range e.MsgStrPlural {
			if v == "" {
				return false
			}
		}
		return true
	}
	return e.MsgStr != ""
}

// Occurrences parses References into (file, line) pairs.
func (e *Entry) Occurrences() [][2]string {
	var out [][2]string
	for _, ref := range e.References {
		for _, part := range strings.Fields(ref) {
			file, line := part, ""
			if i := strings.LastIndex(part, ":"); i > 0 {
				file, line = part[:i], part[i+1:]
			}
			out = append(out, [2]string{file, line})
		}
	}
	return out
}

// HasTranslatorComment returns true if the entry has any translator comment (# ...) or
// extracted comment (#. ...) — matches polib's `entry.comment` semantics used by the
// static i18n check (any comment above msgid counts).
func (e *Entry) HasTranslatorComment() bool {
	return len(e.TranslatorComments) > 0 || len(e.ExtractedComments) > 0
}

// PoFile is an ordered collection of PO entries.
type PoFile struct {
	Entries []*Entry
}

// ParsePoFile parses a .po/.pot file from disk.
func ParsePoFile(path string) (*PoFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParsePo(data)
}

// ParsePo parses PO content from a byte slice.
func ParsePo(data []byte) (*PoFile, error) {
	// Detect binary/non-PO garbage upfront. A PO file must contain a msgid keyword
	// at some point; if not, reject.
	text := string(data)
	if !strings.Contains(text, "msgid") {
		return nil, fmt.Errorf("no msgid found; not a PO file")
	}

	lines := strings.Split(text, "\n")
	pf := &PoFile{}

	cur := newEmptyEntry()
	state := 0 // 0=none, 1=msgctxt, 2=msgid, 3=msgid_plural, 4=msgstr (with pluralIdx)
	pluralIdx := 0
	entryStarted := false

	flush := func() {
		if !entryStarted {
			return
		}
		if cur.MsgID == "" && cur.MsgCtxt == "" && !cur.isHeader {
			cur.isHeader = true
		}
		pf.Entries = append(pf.Entries, cur)
		cur = newEmptyEntry()
		entryStarted = false
		state = 0
		pluralIdx = 0
	}

	for _, raw := range lines {
		l := strings.TrimSpace(raw)

		// Blank line ends the current entry
		if l == "" {
			flush()
			continue
		}

		// Comment lines only make sense before msgid/msgstr blocks.
		if strings.HasPrefix(l, "#") {
			// Once we've started collecting msgid/msgstr, a comment marks
			// the start of a new entry — flush first.
			if state == 2 || state == 3 || state == 4 {
				flush()
			}
			entryStarted = true
			switch {
			case strings.HasPrefix(l, "#~"):
				cur.Obsolete = true
				// Treat as a plain comment for now; obsolete entries are skipped by callers.
				cur.TranslatorComments = append(cur.TranslatorComments, strings.TrimSpace(strings.TrimPrefix(l, "#~")))
			case strings.HasPrefix(l, "#."):
				cur.ExtractedComments = append(cur.ExtractedComments, strings.TrimSpace(strings.TrimPrefix(l, "#.")))
			case strings.HasPrefix(l, "#:"):
				cur.References = append(cur.References, strings.TrimSpace(strings.TrimPrefix(l, "#:")))
			case strings.HasPrefix(l, "#,"):
				flagLine := strings.TrimSpace(strings.TrimPrefix(l, "#,"))
				for _, f := range strings.Split(flagLine, ",") {
					f = strings.TrimSpace(f)
					if f != "" {
						cur.Flags = append(cur.Flags, f)
					}
				}
			default:
				// # <comment> — translator comment
				cur.TranslatorComments = append(cur.TranslatorComments, strings.TrimSpace(strings.TrimPrefix(l, "#")))
			}
			continue
		}

		switch {
		case strings.HasPrefix(l, "msgctxt "):
			if state == 2 || state == 3 || state == 4 {
				flush()
			}
			entryStarted = true
			v, err := unquotePOString(strings.TrimPrefix(l, "msgctxt "))
			if err != nil {
				return nil, fmt.Errorf("invalid msgctxt: %v", err)
			}
			cur.MsgCtxt = v
			state = 1
		case strings.HasPrefix(l, "msgid_plural "):
			v, err := unquotePOString(strings.TrimPrefix(l, "msgid_plural "))
			if err != nil {
				return nil, fmt.Errorf("invalid msgid_plural: %v", err)
			}
			cur.MsgIDPlural = v
			state = 3
		case strings.HasPrefix(l, "msgid "):
			if state == 4 {
				flush()
			}
			entryStarted = true
			v, err := unquotePOString(strings.TrimPrefix(l, "msgid "))
			if err != nil {
				return nil, fmt.Errorf("invalid msgid: %v", err)
			}
			cur.MsgID = v
			state = 2
		case strings.HasPrefix(l, "msgstr[") || strings.HasPrefix(l, "msgstr "):
			// Plural form
			if strings.HasPrefix(l, "msgstr[") {
				end := strings.Index(l, "]")
				if end == -1 {
					return nil, fmt.Errorf("malformed msgstr index: %q", l)
				}
				idx, err := strconv.Atoi(l[7:end])
				if err != nil {
					return nil, fmt.Errorf("malformed msgstr index: %v", err)
				}
				rest := strings.TrimSpace(l[end+1:])
				v, err := unquotePOString(rest)
				if err != nil {
					return nil, fmt.Errorf("invalid msgstr[%d]: %v", idx, err)
				}
				if cur.MsgStrPlural == nil {
					cur.MsgStrPlural = make(map[int]string)
				}
				cur.MsgStrPlural[idx] = v
				pluralIdx = idx
			} else {
				v, err := unquotePOString(strings.TrimPrefix(l, "msgstr "))
				if err != nil {
					return nil, fmt.Errorf("invalid msgstr: %v", err)
				}
				cur.MsgStr = v
			}
			state = 4
		case strings.HasPrefix(l, "\""):
			// Continuation line for the most recent field.
			v, err := unquotePOString(l)
			if err != nil {
				return nil, fmt.Errorf("invalid continuation: %v", err)
			}
			switch state {
			case 1:
				cur.MsgCtxt += v
			case 2:
				cur.MsgID += v
			case 3:
				cur.MsgIDPlural += v
			case 4:
				if cur.MsgIDPlural != "" {
					if cur.MsgStrPlural == nil {
						cur.MsgStrPlural = make(map[int]string)
					}
					cur.MsgStrPlural[pluralIdx] += v
				} else {
					cur.MsgStr += v
				}
			}
		default:
			// Unknown line — ignore.
		}
	}
	flush()

	// Mark header (first entry with empty msgid).
	if len(pf.Entries) > 0 && pf.Entries[0].MsgID == "" && pf.Entries[0].MsgCtxt == "" {
		pf.Entries[0].isHeader = true
	}

	return pf, nil
}

func newEmptyEntry() *Entry {
	return &Entry{}
}

// unquotePOString unquotes a "..." token, per PO escaping rules (which match Go string literals).
func unquotePOString(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	// Concatenated string literals on the same line: "a" "b"
	// We handle continuation on separate lines elsewhere, but callers may pass
	// multiple adjacent tokens too. Concatenate them.
	var out strings.Builder
	i := 0
	for i < len(s) {
		if s[i] != '"' {
			// Skip whitespace between tokens.
			if s[i] == ' ' || s[i] == '\t' {
				i++
				continue
			}
			return "", fmt.Errorf("expected quoted string, got %q at position %d", s[i], i)
		}
		// Find matching close quote respecting backslash escapes.
		j := i + 1
		for j < len(s) {
			if s[j] == '\\' && j+1 < len(s) {
				j += 2
				continue
			}
			if s[j] == '"' {
				break
			}
			j++
		}
		if j >= len(s) {
			return "", fmt.Errorf("unterminated string in %q", s)
		}
		tok := s[i : j+1]
		v, err := strconv.Unquote(tok)
		if err != nil {
			return "", err
		}
		out.WriteString(v)
		i = j + 1
	}
	return out.String(), nil
}

// Total returns total number of non-obsolete entries excluding the header.
func (pf *PoFile) Total() int {
	n := 0
	for _, e := range pf.Entries {
		if e.Obsolete || e.isHeader {
			continue
		}
		n++
	}
	return n
}

// TranslatedCount returns number of translated (non-fuzzy, non-empty msgstr) entries.
func (pf *PoFile) TranslatedCount() int {
	n := 0
	for _, e := range pf.Entries {
		if e.Obsolete || e.isHeader {
			continue
		}
		if e.Translated() {
			n++
		}
	}
	return n
}

// UntranslatedCount returns number of non-fuzzy entries with empty msgstr.
func (pf *PoFile) UntranslatedCount() int {
	n := 0
	for _, e := range pf.Entries {
		if e.Obsolete || e.isHeader {
			continue
		}
		if !e.Translated() && !e.Fuzzy() {
			n++
		}
	}
	return n
}

// FuzzyCount returns number of fuzzy entries.
func (pf *PoFile) FuzzyCount() int {
	n := 0
	for _, e := range pf.Entries {
		if e.Obsolete || e.isHeader {
			continue
		}
		if e.Fuzzy() {
			n++
		}
	}
	return n
}

// TranslatableEntries returns non-header, non-obsolete entries in original order.
func (pf *PoFile) TranslatableEntries() []*Entry {
	out := make([]*Entry, 0, len(pf.Entries))
	for _, e := range pf.Entries {
		if e.Obsolete || e.isHeader {
			continue
		}
		out = append(out, e)
	}
	return out
}

// Save writes the PO file back to disk, preserving order, comments, and structure.
func (pf *PoFile) Save(path string) error {
	data, err := pf.Marshal()
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// Marshal serializes the PO file to bytes.
func (pf *PoFile) Marshal() ([]byte, error) {
	var buf bytes.Buffer
	for i, e := range pf.Entries {
		if i > 0 {
			buf.WriteByte('\n')
		}
		if err := writeEntry(&buf, e); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

func writeEntry(buf *bytes.Buffer, e *Entry) error {
	prefix := ""
	if e.Obsolete {
		prefix = "#~ "
		// For obsolete, translator comments were captured but we won't try to preserve
		// arbitrary raw content. Emit obsolete-style entry.
	}

	if !e.Obsolete {
		for _, c := range e.TranslatorComments {
			if c == "" {
				buf.WriteString("#\n")
			} else {
				buf.WriteString("# " + c + "\n")
			}
		}
		for _, c := range e.ExtractedComments {
			buf.WriteString("#. " + c + "\n")
		}
		for _, r := range e.References {
			buf.WriteString("#: " + r + "\n")
		}
		if len(e.Flags) > 0 {
			buf.WriteString("#, " + strings.Join(e.Flags, ", ") + "\n")
		}
	}

	if e.MsgCtxt != "" {
		writePOField(buf, prefix+"msgctxt", e.MsgCtxt)
	}
	writePOField(buf, prefix+"msgid", e.MsgID)

	if e.MsgIDPlural != "" {
		writePOField(buf, prefix+"msgid_plural", e.MsgIDPlural)
		// Emit msgstr[N] in numeric order.
		max := -1
		for k := range e.MsgStrPlural {
			if k > max {
				max = k
			}
		}
		for i := 0; i <= max; i++ {
			v := e.MsgStrPlural[i]
			writePOField(buf, fmt.Sprintf("%smsgstr[%d]", prefix, i), v)
		}
		if max == -1 {
			// No plural forms defined — emit empty [0] and [1] to keep file valid.
			writePOField(buf, prefix+"msgstr[0]", "")
			writePOField(buf, prefix+"msgstr[1]", "")
		}
	} else {
		writePOField(buf, prefix+"msgstr", e.MsgStr)
	}
	return nil
}

// writePOField writes `field "value"\n` or a multi-line variant matching common PO style.
func writePOField(buf *bytes.Buffer, field, value string) {
	// Emit header entries verbatim for multi-line values so headers keep their shape:
	// msgstr ""
	// "Content-Type: ...\n"
	// "Language: ..."
	if strings.Contains(value, "\n") {
		lines := strings.Split(value, "\n")
		// Trailing "\n" produces an empty last element — treat as trailing newline in encoded form.
		trailing := ""
		if len(lines) > 0 && lines[len(lines)-1] == "" {
			lines = lines[:len(lines)-1]
			trailing = "\\n"
		}
		buf.WriteString(field + " \"\"\n")
		for i, ln := range lines {
			end := "\\n"
			if i == len(lines)-1 && trailing == "" {
				end = ""
			}
			buf.WriteString("\"" + gotext.EscapeSpecialCharacters(ln) + end + "\"\n")
		}
		return
	}
	buf.WriteString(field + " \"" + gotext.EscapeSpecialCharacters(value) + "\"\n")
}
