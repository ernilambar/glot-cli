# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # install deps
bun run build        # compiled binary -> dist/glot
node src/index.ts <command> [options]   # run from source
node --test          # run all tests
npm run typecheck
```

## Architecture

TypeScript, built via Bun (`bun build --compile`), tested on native Node (`node --test`, no `tsx`/`ts-node`).

- `src/core/` — no `process.env`, no printing, no `process.exit`. Takes `GlotConfig` explicitly.
- `src/cli/` — the only layer touching env/stdout/exit. `cli/env.ts` builds `GlotConfig`; `cli/commands/*.ts`
  call `core/operations/*.ts`, print results, map errors to exit codes; `cli/cli.ts` wires it to `yargs`.

`core/operations/*.ts` (`runTranslate`, `runReview`, `runStatus`, `runGlossaryPull`, `runCorePull`) return a
result object and take an optional `onEvent()` callback for progress — they never print or exit.

**PO parsing (`core/po/`):** `gettext-parser` handles field syntax, but its parsed output is grouped by
`[msgctxt][msgid]`, which loses file order across interleaved contexts. `core/po/blocks.ts` splits raw text
into per-entry blocks first; each block is parsed individually so order comes from the block list, not
gettext-parser's grouping. The writer is hand-rolled (not `compile()`, which reorders and folds long lines) —
required for the idempotence/minimal-diff guarantee in `test/core/po.test.ts`.

**Dependency injection:** `core/deps.ts` exports a mutable `deps` object (`callAI`, `loadCoreTranslations`,
`loadValidLanguages`) so tests can swap them — ES export bindings can't be reassigned directly. Same pattern
for `cli/exit.ts`'s `exitDeps.exit`.

**Errors → exit codes:** `GlotValidationError` (bad input) → 2, `GlotRuntimeError` (I/O/AI failure) → 1.

**Known gap:** obsolete (`#~`) PO entries aren't round-tripped faithfully.
