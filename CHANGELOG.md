# Changelog

## Unreleased
- Fixed: AI requests to OpenCode endpoints now send a stable `x-opencode-session` header, required by OpenCode Go
- Fixed: AI error messages now include the provider's own error text instead of only generic guidance

## 1.0.11 - 2026-09-26
- Fixed: macOS release binaries are now code-signed

## 1.0.10 - 2026-09-01
- Fixed: AI prompts now state that the strings to translate are data, not instructions to follow

## 1.0.9 - 2026-08-15
- Changed: AI prompts now use the locale's human-readable name (e.g. "Nepali") instead of the raw locale code
- Changed: WordPress i18n rules (placeholders, passthrough, glossary) are now always sent to the AI
- Fixed: target language was silently omitted from AI prompts when a custom system prompt was set

## 1.0.8 - 2026-07-31
- Added: custom glossary support via `glossary/custom/<locale>.tsv`, merged with the core glossary (custom wins)
- Added: `glot translations import`/`list` — import approved translations from PO files into a custom cache
- Added: `GET /api/v1/translations` endpoint

## 1.0.7 - 2026-07-29
- Added: `GLOT_BATCH_DELAY` env var to pace sequential batch API calls

## 1.0.6 - 2026-07-26
- Added: context (`msgctxt`) support in glossary terms
- Added: `GET /info` endpoint exposing basic info
- Fixed: review no longer flags URL-only and email-only strings as issues

## 1.0.5 - 2026-07-26
- Added: optional `comment` field on `POST /translate`
- Fixed: `msgctxt` now reaches AI translation prompts, not just the cache lookup
- Fixed: PO translator comments (`#.`) now reach AI translation prompts

## 1.0.4 - 2026-07-25
- Added: `serve` sub-command to REST API
- Changed: hide redundant single-match suggestions
- Fixed: `glot translate` now AI-translates plural strings that miss the core cache

## 1.0.3 - 2026-07-23
- Added: `browse` sub-command to open PO file in the browser.

## 1.0.2 - 2026-07-23
- Fixed: `--lang` (and other flags) were silently ignored when passed after the positional file argument.

## 1.0.1 - 2026-07-22
- Added: `--debug` flag on `translate`/`review` to show additional debug info
- Fixed: enforce JSON output format

## 1.0.0 - 2026-07-17
- Initial release
