# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
go build -o glot .

# Install as `glot` on PATH
go install .

# Run all tests
go test ./...

# Run a specific test
go test -run TestParseBatchResponse_JSON -v

# Vet
go vet ./...
```

## Architecture

The tool is a small Go program split into two files:

- `main.go` — CLI entry, config from env, and all subcommand handlers (translate, review, status, glossary, core).
- `po.go` — In-repo PO parser and writer. Handles msgid/msgstr/msgctxt, plural forms, translator/extracted comments, references, fuzzy flag, and multi-line continuation. Order-preserving on save.

**Data flow for `glot translate`:**
1. Load glossary (`~/.config/glot-cli/glossary/<locale>.tsv`) and core translations (`~/.config/glot-cli/core/<locale>.json`).
2. Apply core translations directly — no AI call for those strings.
3. Remaining untranslated entries are batched (`GLOT_BATCH_SIZE`, default 10) and sent concurrently (`GLOT_CONCURRENCY`) to an OpenAI-compatible endpoint.
4. Each batch uses `buildBatchPrompt()` which injects matched glossary terms inline.
5. Responses parsed by `parseBatchResponse()` — tries JSON first, falls back to numbered-list regex.

**Data flow for `glot review`:**
1. Static pass: flags `%s`/`%d` placeholders without a translator/extracted comment.
2. AI pass: `buildReviewPrompt()` sends all msgids in batches; response is a JSON map of string-index → issue description.
3. Results merged and rendered via `outputReviewReport()` (text/table/json/csv/markdown).

**Key prompt functions:**
- `buildBatchPrompt()` — translation prompt; respects custom system prompt override from `~/.config/glot-cli/prompts/<locale>.md`.
- `buildReviewPrompt()` — i18n review prompt; flags hardcoded numbers/dates/paths and embedded URLs (not strings that are entirely a URL).

**Configuration:** All runtime config comes from environment variables (`GLOT_ENDPOINT_URL`, `GLOT_MODEL_ID`, `GLOT_API_KEY`, etc.). No config file.

**Language validation:** `data/languages.json` is embedded via `//go:embed` and is the source of truth for valid locale codes. `validateLang()` checks against it.

**Testability:** `callAI`, `loadCoreTranslations`, `loadValidLanguages`, and `osExit` are package-level `var`s so tests can substitute them without needing dependency injection plumbing.

**Dependency:** `github.com/leonelquinteros/gotext` is used only for `EscapeSpecialCharacters` when writing PO strings. The parser is in-repo.
