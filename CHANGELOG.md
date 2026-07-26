# Changelog

## 1.0.6 - 2026-07-26
- Added: context (`msgctxt`) support in glossary terms
- Added: `GET /info` endpoint exposing basic info
- Fixed: review no longer flags URL-only and email-only strings as issues

## 1.0.5 - 2026-07-26
- Fixed: `msgctxt` now reaches AI translation prompts, not just the cache lookup
- Fixed: PO translator comments (`#.`) now reach AI translation prompts
- Added: optional `comment` field on `POST /translate`

## 1.0.4 - 2026-07-25
- Added: `serve` sub-command to REST API
- Fixed: `glot translate` now AI-translates plural strings that miss the core cache
- Changed: hide redundant single-match suggestions

## 1.0.3 - 2026-07-23
- Added: `browse` sub-command to open PO file in the browser.

## 1.0.2 - 2026-07-23
- Fixed: `--lang` (and other flags) were silently ignored when passed after the positional file argument.

## 1.0.1 - 2026-07-22
- Fixed: enforce JSON output format
- Added: `--debug` flag on `translate`/`review` to show additional debug info

## 1.0.0 - 2026-07-17
- Initial release
