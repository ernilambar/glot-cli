# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install for development (creates global `glot` command)
pip install -e ".[dev]"

# Run all tests
pytest tests/ -v

# Run a single test class or function
pytest tests/test_glot.py::TestParseBatchResponse -v
pytest tests/test_glot.py::TestParseBatchResponse::test_json_response -v
```

## Architecture

The entire tool lives in a single file: `glot.py`. No packages or submodules.

**Data flow for `glot translate`:**
1. Load glossary (`~/.config/glot-cli/glossary/<locale>.tsv`) and core translations (`~/.config/glot-cli/core/<locale>.json`)
2. Apply core translations directly — no AI call for those strings
3. Remaining untranslated entries are batched (`GLOT_BATCH_SIZE`, default 10) and sent concurrently (`GLOT_CONCURRENCY`) to an OpenAI-compatible endpoint
4. Each batch uses `build_batch_prompt()` which injects matched glossary terms inline
5. Responses parsed by `parse_batch_response()` — tries JSON first, falls back to numbered-list regex

**Data flow for `glot review`:**
1. Static pass: flags `%s`/`%d` placeholders without a `/* translators: */` comment
2. AI pass: `build_review_prompt()` sends all msgids in batches; response is a JSON map of string-index → issue description
3. Results merged and rendered via `_output_review_report()` (text/json/csv/markdown)

**Key prompt functions:**
- `build_batch_prompt()` — translation prompt; respects custom system prompt override from `~/.config/glot-cli/prompts/<locale>.md`
- `build_review_prompt()` — i18n review prompt; flags hardcoded numbers/dates/paths and embedded URLs (not strings that are entirely a URL)

**Configuration:** All runtime config comes from environment variables (`GLOT_ENDPOINT_URL`, `GLOT_MODEL_ID`, `GLOT_API_KEY`, etc.). No config file.

**Language validation:** `data/languages.json` is the source of truth for valid locale codes. `validate_lang()` checks against it.
