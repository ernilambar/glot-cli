# AGENTS.md

## Overview

CLI tool for translating WordPress `.po` files using any OpenAI-compatible backend. Built with TypeScript, bundled with Bun, runs on Node.js >= 22.18.

## Setup

```bash
bun install
```

Requires Node.js >= 22.18 and Bun installed.

## Commands

```bash
bun run build      # Compile to single binary at dist/glot
bun test           # Run test suite
bunx tsc --noEmit  # Type-check without emitting
```

No linter or formatter is configured. Follow existing code style.

## Architecture

- `src/core/` — no `process.env`, no printing, no `process.exit`. Takes `GlotConfig` explicitly.
- `src/cli/` — the only layer touching env/stdout/exit. `cli/env.ts` builds `GlotConfig`; `cli/commands/*.ts` call `core/operations/*.ts`, print results, map errors to exit codes; `cli/cli.ts` wires it to `yargs`.
- `core/operations/*.ts` return a result object and take an optional `onEvent()` callback for progress — they never print or exit.
- **Dependency injection:** `core/deps.ts` exports a mutable `deps` object (`callAI`, `loadCoreTranslations`, `loadTranslationsCache`, `loadValidLanguages`) so tests can swap them. Same pattern for `cli/exit.ts`'s `exitDeps.exit`.

## Conventions

- **Tabs for indentation** in `.ts` files (spaces only for `.json`, `.yml`, `.md`).
- **Use `.ts` extensions in relative imports** — required by NodeNext module resolution.
- **Strict TypeScript** — `erasableSyntaxOnly` is enabled; avoid `enum` and parameter properties.
- **Custom error classes** — use `GlotValidationError` (bad input, exit 2) and `GlotRuntimeError` (I/O or AI failure, exit 1). Add a `detail` string for debug output.
- **Tests use `node:test`** with `node:assert/strict`. Place tests in `test/` mirroring `src/` structure.

## Quality Gate

Run in order. All must exit 0 before declaring work complete:

```bash
bunx tsc --noEmit
bun test
bun run build
```
