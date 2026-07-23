# REFACTOR.md — Go → Node.js rewrite plan

## Goal

Port `glot-cli` from Go to Node.js/TypeScript with **identical commands, flags, environment
variables, and behavior**. This is a re-platform, not a redesign — no new features, no dropped
features.

## Decisions locked in

| Question | Decision |
|---|---|
| Language | TypeScript, compiled/run via Bun (no separate `tsc` build step needed for the binary; `tsc --noEmit` used only for CI type-checking) |
| CLI framework | `yargs` |
| PO parser | `gettext-parser` (replaces in-repo `po.go`) |
| Concurrency | `p-limit` (replaces goroutines + channel + `sync.WaitGroup` + semaphore pattern) |
| AI client | `openai` SDK, pointed at `GLOT_ENDPOINT_URL` via `baseURL` (works for OpenAI, OpenRouter, LM Studio, Ollama's OpenAI-compatible endpoint, etc.) |
| Executable | `bun build --compile` |
| Test framework | Node's built-in `node:test` + `node:assert` — no Jest/Vitest/Mocha |
| Release targets | macOS only (arm64 + x64), matching current `release.yml` |

**Non-goal:** exact byte-for-byte `--help`/`--version` text. We accept yargs' native help
formatting instead of reproducing the current hand-written `helpText` string verbatim. Commands,
subcommands, flags, defaults, and exit codes must still match exactly — only the *help
rendering* is allowed to look different.

## Internal boundary: `core` / `cli` (so a future `@glot/core` split is a folder move, not a rewrite)

Not splitting into packages now — but two structural rules, applied from the first line of code,
keep that door open cheaply instead of requiring a rewrite later:

1. **Explicit config, not ambient globals.** Go's `glotEndpointURL`, `glotBatchSize`, etc. become
   fields on one `GlotConfig` object instead of module-level state populated from `process.env`.
   `core/` code takes `GlotConfig` as an explicit parameter and never reads `process.env` itself;
   only `cli/env.ts` reads the environment, once, to build that object. A future consumer (a
   script, a server, a test, a second CLI) builds its own `GlotConfig` however it wants, with no
   shared mutable state to fight.
2. **Core returns data (or throws typed errors); CLI renders and exits.** Go's command handlers
   (`cmdTranslate`, `cmdReview`, ...) compute *and* print *and* call `osExit` in the same
   function. In this port, `core/operations/*.ts` only compute: each exports a function like
   `runTranslate(config, input, lang, limit): Promise<TranslateResult>` that returns a plain
   result object and never touches `console.log`/`process.stdout.write`/`process.exit`.
   `cli/commands/*.ts` calls the operation, prints the exact same messages the Go CLI prints
   today, and maps the outcome to an exit code. See "Error handling & progress events" below for
   how failures and live progress lines — which Go prints via direct `osExit`/`fmt.Printf` calls
   mid-function — translate into this split without losing any behavior.

The dependency direction is one-way: `cli/` imports from `core/`, `core/` never imports anything
CLI-specific (no `yargs`, no `process.env`, no `process.exit`). That single rule is what makes
`src/core/` liftable into `packages/core/src/` later with zero code changes — only
`package.json`/workspace wiring changes. Practical tip: add a `tsconfig.json` path alias
`"@glot/core/*": ["src/core/*"]` now, so internal imports already read as if `core` were a
separate package (`import { runTranslate } from "@glot/core/operations/translate"`) — if the
alias name matches the eventual npm package name, splitting later needs no import-path edits at
all, just turning the alias into a real workspace dependency.

Side effect: `core/deps.ts` (the `callAI`/`loadCoreTranslations`/`loadValidLanguages` swap-object,
see Testing plan) stops being just a test seam and becomes a legitimate extension point a future
`@glot/core` package could expose publicly — "bring your own AI backend or core-translation
source" — rather than internal-only plumbing.

## Current architecture (for reference)

- `main.go` (1708 lines) — config from env, glossary loading/matching, prompt building, response
  parsing, HTTP AI client, `translate`/`review`/`status`/`glossary`/`core` command handlers,
  flag parsing, help/version.
- `po.go` (490 lines) — hand-rolled, order-preserving PO parser/writer (msgid/msgstr/msgctxt,
  plurals, comments, references, flags, obsolete entries).
- `main_test.go` (74 tests) + `po_test.go` (12 tests) — table-style tests using package-level
  `var` indirection (`callAI`, `loadCoreTranslations`, `loadValidLanguages`, `osExit`) so tests
  can substitute mocks without DI plumbing, plus stdout/stderr capture via `os.Pipe`.
- `.github/workflows/tests.yml` — vet, test, build smoke test, `--version` smoke check.
- `.github/workflows/release.yml` — cross-compiles `darwin-arm64` + `darwin-amd64` on
  `ubuntu-latest`, uploads to GitHub Release.

## Proposed repository layout

```
glot-cli/
  package.json
  tsconfig.json
  bunfig.toml
  src/
    core/                          # framework-agnostic: no process.env, no printing, no process.exit
      config.ts                     # GlotConfig type + defaults (no env reading here)
      errors.ts                      # GlotValidationError / GlotRuntimeError — see below
      languages.ts                    # embedded languages.json loader + validateLang(langs, code)
      glossary.ts                     # loadGlossary, buildGlossaryIndex, tokenize, matchingGlossaryTerms
      core-translations.ts             # loadCoreTranslations, loadSystemPrompt
      prompts.ts                       # buildBatchPrompt, buildReviewPrompt, stripCodeFences,
                                        parseBatchResponse, parseReviewResponse
      ai-client.ts                      # OpenAI SDK wrapper — callAI(), usage extraction, friendly error mapping
      deps.ts                          # swap-point object: callAI, loadCoreTranslations, loadValidLanguages
      po/
        types.ts                       # Entry, PoFile type defs
        parser.ts                       # gettext-parser wrapper: parse() → ordered Entry[]
        writer.ts                       # ordered Entry[] → PO text (via gettext-parser compile + order adapter)
        poFile.ts                       # PoFile class: Total/TranslatedCount/UntranslatedCount/FuzzyCount/
                                        TranslatableEntries/Save/Marshal — mirrors po.go's PoFile methods
      operations/
        translate.ts                    # runTranslate(config, input, lang, limit, onEvent?) → TranslateResult
        review.ts                       # runReview(config, input, format, onEvent?) → ReviewResult
        status.ts                       # runStatus(config, input, lang) → StatusResult
        glossaryPull.ts                  # runGlossaryPull(config, locale), runGlossaryList(config)
        corePull.ts                      # runCorePull(config, locale), runCoreList(config)
    cli/                           # the only layer touching process.env / stdout / process.exit
      env.ts                         # reads process.env → builds GlotConfig (replaces loadConfig())
      exit.ts                        # exit(code) wrapper — CLI's half of the exit story
      render.ts                       # shared output-formatting helpers (review's 5 formats, table layout)
      commands/
        translate.ts                   # calls core operation, prints, exits — thin
        review.ts
        status.ts
        glossary.ts
        core.ts
      cli.ts                          # yargs setup, command wiring, help/version
    index.ts                       # entrypoint: imports cli/cli.ts
  data/
    languages.json                  # unchanged, statically imported (Bun bundles it into the compiled binary)
  test/
    core/
      po.test.ts
      glossary.test.ts
      prompts.test.ts
      ai-client.test.ts
      translate.test.ts               # asserts on TranslateResult + recorded onEvent sequence
      review.test.ts
      status.test.ts
      glossary-core-pull.test.ts
    cli/
      render.test.ts                   # output-format assertions (json/csv/markdown/table/text)
      cli.test.ts                      # arg parsing, exit codes, error-to-exit-code mapping
  .github/workflows/
    tests.yml
    release.yml
```

This adds one extra layer of nesting (`core/` vs `cli/`) versus a flat `src/`, but every module
inside each folder is still the same single-purpose split the Go code already uses internally
(config, glossary, prompts, AI client, PO, commands) — the nesting is the only new thing, and it's
exactly the seam a future package split would need anyway.

## Command / flag parity matrix

| Command | Args | Flags | Notes |
|---|---|---|---|
| `translate <file>` | required `.po` path | `--lang` (fallback `GLOT_LANG`), `--limit` (default 0 → `GLOT_MAX_STRINGS`), `--debug` | Same required-env check (`GLOT_ENDPOINT_URL`, `GLOT_MODEL_ID`), same backup-file (`.bak`) behavior, same core-cache-before-AI order |
| `review <file>` | required `.po`/`.pot` path | `--format` (`text`\|`table`\|`json`\|`csv`\|`markdown`, default `text`), `--debug` | Same static placeholder check + AI pass merge |
| `status <file>` | required `.po` path | `--lang` (fallback `GLOT_LANG`) | Same core-cache count when `--lang` given |
| `glossary list` | none | none | |
| `glossary pull [<locale>]` | optional locale (fallback `GLOT_LANG`) | none | |
| `core list` | none | none | |
| `core pull [<locale>]` | optional locale (fallback `GLOT_LANG`) | none | |
| `-V`, `--version` | | | |
| `-h`, `--help` | | | |

Env vars are unchanged: `GLOT_ENDPOINT_URL`, `GLOT_MODEL_ID`, `GLOT_API_KEY`, `GLOT_LANG`,
`GLOT_DATA_DIR`, `GLOT_MAX_STRINGS`, `GLOT_BATCH_SIZE`, `GLOT_CONCURRENCY`,
`GLOT_REQUEST_TIMEOUT`. Defaults unchanged (200 / 10 / 1 / 120s).

`--long-flag` GNU-style normalization (`normalizeArgs` in `main.go`) is a non-issue — yargs
accepts `--flag` natively, so that shim is simply dropped.

Each row above is implemented as a thin `cli/commands/*.ts` handler (arg validation via yargs,
printing, exit code) delegating to a `core/operations/*.ts` function that does the actual work —
per the core/cli boundary above.

## PO parsing: hard requirement — minimal, order-preserving diffs

**Requirement (non-negotiable, not a "nice to have"):** translating a subset of entries in a
file must change *only* the lines belonging to those entries. Every other entry's spacing,
comments, references, flags, and position in the file must come out exactly as they went in.
Entry order across the whole file — including `msgctxt` entries interleaved with default-context
entries — must be preserved exactly, byte for byte where nothing changed.

`po.go` meets this today by construction: it's a flat, order-preserving array
(`PoFile.Entries []*Entry`), so "don't touch what didn't change" falls out of the data structure
for free. `gettext-parser` parses into a *nested* structure instead —
`translations[context][msgid]`, grouped by context first, msgid second. That grouping is the
thing to watch: if the writer walks that structure directly (all of context `""`, then all of
context `"menu"`, etc.), any file that interleaves contexts — which the repo's own
`TestPoFile_RoundTrip` fixture in `po_test.go` already does — comes back out with entries
reordered, even though every string is still correct. Reordering alone would already violate the
requirement above, independent of any escaping/whitespace concerns.

**How this gets satisfied — approach is flexible, the bar is not:**
`gettext-parser` stays the single source of truth for PO *syntax* (escaping, multi-line
continuation, plural forms, comment types), per the requirement to use the package. On top of
it, `core/po/parser.ts`/`core/po/writer.ts` need whatever adapter makes the two things below
true — the likely shape is a raw pre-pass over the file text that records
`(context, msgid, msgidPlural)` in file order, then the writer walks entries in that recorded
order instead of trusting the library's per-context grouping — but the specific mechanism is an
implementation detail decided during Phase 0, not fixed in advance.

**Acceptance criteria (Phase 0 spike must pass both before this module is considered done):**
1. **Idempotence:** parse a real `.po` file, re-serialize with zero data changes, diff against
   the original file — must be empty. (Run against the repo's existing fixtures —
   `potContent`, `statusPO`, the round-trip fixture — plus at least one real-world WordPress
   `.po` file with interleaved contexts.)
2. **Minimal diff:** parse the same file, change exactly one entry's `msgstr`, re-serialize, diff
   against the original — the diff must touch only that entry's `msgstr` line(s). Nothing else
   moves, reformats, or re-escapes.

Both become new tests in `test/core/po.test.ts` (neither exists in the current Go suite — Go's
version never needed them, since it isn't going through a library that reshapes the data first).
If no adapter approach reaches both criteria against real-world fixtures, escalate to the user
before shipping reduced fidelity — do not ship a version that silently reformats untouched
entries.

`gettext-parser`'s `.po.parse()`/`.po.compile()` still remove most of `po.go`'s hand-rolled
`unquotePOString`/`writePOField` escaping logic. `Entry.Occurrences()`,
`Entry.HasTranslatorComment()`, `Entry.Fuzzy()`, `Entry.Translated()`, and all four `PoFile`
counters are thin logic ported as-is on top of whatever adapter shape Phase 0 lands on.

## AI client

`core/ai-client.ts` wraps the `openai` SDK. Per the core/cli boundary, it takes `GlotConfig`
explicitly rather than reading module-level globals — no shared client singleton, so a future
consumer can point two calls at two different endpoints in the same process if it wants to:

```ts
function createAiClient(config: GlotConfig) {
  const client = new OpenAI({
    baseURL: config.endpointUrl,   // any OpenAI-compatible chat/completions endpoint
    apiKey: config.apiKey || "not-needed",  // SDK requires a non-empty string even for keyless local backends
    timeout: config.requestTimeout > 0 ? config.requestTimeout * 1000 : undefined,
  });
  return { callAI: (prompt: string, systemPrompt: string, temperature: number) => { /* ... */ } };
}
```

Must reproduce, not just approximate:
- 3-attempt retry on HTTP 429 with `1 << attempt` second backoff (the SDK has its own retry
  logic — either disable it (`maxRetries: 0`) and keep the existing hand-rolled loop for
  behavioral parity, or verify the SDK's default retry/backoff produces equivalent observable
  behavior before dropping the custom loop. Default to keeping the custom loop; it's what the
  tests assert against).
- Friendly-vs-debug error message split (`aiError.Friendly` / `.Detail`) for network failure,
  401/403, 404, 400, and generic non-2xx — same status-code-to-message table as `main.go:521-536`.
  These become `GlotRuntimeError` instances (see "Error handling & progress events" below), not
  thrown SDK errors, so callers see the same friendly-vs-debug shape regardless of backend.
- `usage.prompt_tokens`/`completion_tokens`/`total_tokens` extraction, tolerating a missing
  `usage` block (sets `usageComplete = false` upstream, same as today).
- No `choices` in response → "AI returned an unexpected response" friendly error, same as today.

The default `callAI` implementation is exposed as `deps.callAI` in `core/deps.ts` (see Testing
plan) so tests inject a mock exactly like the Go tests do with `setCallAIForTest` — with the
config now passed as `deps.callAI`'s first argument instead of being closed over implicitly.

## Error handling & progress events (consequence of "core never touches process.exit / stdout")

Go's command handlers print an error to stderr and call `osExit(1)` or `osExit(2)` inline,
mid-function, at every validation/failure point. Since `core/operations/*.ts` isn't allowed to
call `process.exit` or print, those failure points become typed throws instead, and the CLI
layer maps them back to the same exit codes:

- `core/errors.ts` defines `GlotValidationError` (bad args/input — missing env vars, file not
  found, invalid PO file, negative `--limit`, invalid `--format`, invalid locale, missing
  locale — maps to **exit code 2**, matching Go's `osExit(2)` usage) and `GlotRuntimeError`
  (I/O or AI failures — unwritable file, AI endpoint errors — maps to **exit code 1**, matching
  Go's `osExit(1)` usage).
- Every Go call site that does `fmt.Fprintf(os.Stderr, "Error: ...")` + `osExit(n)` becomes
  `throw new GlotValidationError(message)` or `throw new GlotRuntimeError(message)` in the
  corresponding `core/operations/*.ts` function, with the exact same message text.
- `cli/commands/*.ts` wraps each `run*` call in try/catch: prints `Error: ${err.message}` to
  stderr, then calls `exit(err instanceof GlotValidationError ? 2 : 1)`.

Live progress output (`translate`/`review`'s `Batch N/M: ... [x/y]` lines, "Core matches: N",
"Custom system prompt loaded.", per-batch failures) can't just be part of the final return value
— Go prints these as batches complete, not all at once at the end. `runTranslate`/`runReview`
take an optional `onEvent(event: TranslateEvent | ReviewEvent): void` callback; the CLI's
implementation of `onEvent` does the actual printing, formatted identically to today.
`core/operations/*.test.ts` passes a simple recording array instead and asserts on the event
sequence — a more precise check than the Go tests' stdout string-matching, not a weaker one.

Net effect on `mustExit`: Go's single "did `osExit` get called" check splits into two smaller,
more specific assertions — `assert.throws(() => runTranslate(...), GlotValidationError)` in
`test/core/*.test.ts` (no process/exit involved at all), and a thin
`assert.equal(exitCodeMock.mock.calls[0].arguments[0], 2)` in `test/cli/*.test.ts` where
`cli/exit.ts` is mocked.

## Concurrency

Two spots use goroutines + a semaphore channel + `sync.WaitGroup`: batch translation/review
chunk processing (`core/operations/translate.ts` and `review.ts`), and the core-pull's parallel
fetch of the two secondary WP core projects (`core/operations/corePull.ts`). Both become
`p-limit`:

```ts
const limit = pLimit(config.concurrency);
const results = await Promise.all(chunks.map((chunk, idx) => limit(() => processChunk(chunk, idx))));
```

Order of *dispatch* isn't guaranteed identical to Go's channel-based fan-in (Go's `results` channel
yields whichever goroutine finishes first; `Promise.all` preserves input order in the resolved
array regardless of completion order). The current code's progress lines
(`Batch %d/%d: ... [%d/%d]`) are printed as each result arrives — replicate that with
`Promise.allSettled` iteration order matching completion, not array index order, to keep the
"live progress" UX rather than silently switching to input-order printing.

## Testing plan

### Dependency injection: the `deps` object (now core-only)

Go's tests substitute mocks via package-level `var`s (`callAI`, `loadCoreTranslations`,
`loadValidLanguages`, `osExit`). Three of those four are core-side swap points; `osExit` is now
CLI-only (see the core/cli boundary above), so it moves to `cli/exit.ts` instead of living in the
same object. `core/deps.ts` is an object of mutable function properties, imported everywhere
instead of importing the functions directly:

```ts
// core/deps.ts
export const deps = {
  callAI: defaultCallAI,
  loadCoreTranslations: defaultLoadCoreTranslations,
  loadValidLanguages: defaultLoadValidLanguages,
};
```

Production code calls `deps.callAI(...)`, never the underlying function directly. Tests do:

```ts
const original = deps.callAI;
deps.callAI = mock.fn(async () => ({ content: "...", usage: null }));
t.after(() => { deps.callAI = original; });
```

This is the same shape as the Go pattern, works identically under ESM (no `mock.module`
gymnastics needed, no CommonJS `require` cache-busting), and is the one deliberate structural
concession to testability — exactly like the Go code already does.

### Asserting failure: core throws, CLI exits

Go's `mustExit` swaps `osExit` for a function that panics with a sentinel, then recovers — one
mechanism for every kind of failure, because Go's version has both the validation logic and the
exit call in the same function. Now that those two things live in different layers (see "Error
handling & progress events" above), the assertion splits into two much simpler pieces:

```ts
// test/core/*.test.ts — assert the operation itself signals failure correctly
await assert.rejects(() => runTranslate(config, "/no/such/file.po", "ne_NP", 0), GlotValidationError);

// test/cli/*.test.ts — assert the CLI maps that failure to the right exit code
const exitMock = mock.method(exitModule, "exit", () => undefined as never);
await runTranslateCommand(["--lang", "ne_NP", "/no/such/file.po"]);
assert.equal(exitMock.mock.calls[0].arguments[0], 2);
```

No sentinel-throwing/panic-recovery trick needed on either side — `assert.rejects`/`assert.throws`
handle the core case natively, and mocking `cli/exit.ts`'s exported `exit` function (rather than
letting the real `process.exit` tear down the test process) handles the CLI case.

### stdout/stderr capture

Go's `captureOutput` pipes `os.Stdout`/`os.Stderr`. Node equivalent: `mock.method(process.stdout,
"write")` / `mock.method(process.stderr, "write")` from `node:test`'s built-in mocking, collecting
the concatenated calls — no child process, no real pipes needed. This is now a `test/cli/`-only
concern (rendering/printing), not something core tests need at all.

### Test file → Go test mapping (parity checklist)

Every existing Go test must have a corresponding `node:test` case. Table below is the porting
checklist (not exhaustive per-test, grouped by `describe` block):

| Go test group (main_test.go / po_test.go) | New file | Layer | Notes |
|---|---|---|---|
| `TestParseBatchResponse_*` (7 tests) | `test/core/prompts.test.ts` | core | JSON, code-fenced JSON, missing key, out-of-range key, regex fallback, malformed-JSON fallback, empty input |
| `TestTokenize_*` (3) | `test/core/glossary.test.ts` | core | |
| `TestBuildGlossaryIndex_*` (2) | `test/core/glossary.test.ts` | core | |
| `TestMatchingGlossaryTerms_*` (6) | `test/core/glossary.test.ts` | core | |
| `TestBuildBatchPrompt_*` (5) | `test/core/prompts.test.ts` | core | |
| `TestBuildReviewPrompt_*` (2) | `test/core/prompts.test.ts` | core | |
| `TestParseReviewResponse_*` (5) | `test/core/prompts.test.ts` | core | |
| `TestValidateLang_*` (3) | `test/core/languages.test.ts` | core | now `assert.throws(..., GlotValidationError)` instead of `mustExit` |
| `TestStripCodeFences_*` (2) | `test/core/prompts.test.ts` | core | |
| `TestOutputReviewReport_*` (9) | `test/cli/render.test.ts` | cli | text/json/csv/markdown/table rendering — this is a `cli/render.ts` concern, not core business logic |
| `TestCmdStatus_*` (5) | `test/core/status.test.ts` (counts/values) + `test/cli/render.test.ts` (text-format assertions) | split | |
| `TestCmdTranslate_*` (9) | `test/core/translate.test.ts` | core | asserts on `TranslateResult` + recorded `onEvent` sequence, not printed strings; includes unwritable-file test — `chmod`-based skip-as-root logic ports as-is via `fs.chmodSync` + `process.getuid?.() === 0` guard |
| `TestCmdReview_*` (9) | `test/core/review.test.ts` | core | same result/event-based assertions |
| `TestGlossaryPull_*`, `TestCorePull_*` (4) | `test/core/glossary-core-pull.test.ts` | core | locale validation only — network-fetching paths were untested in Go too (no test mocks `httpGet`); port the same scope, don't expand it here |
| `TestParsePo_*` (7), `TestPoFile_*` (2), `TestEntry_*` (2) | `test/core/po.test.ts` | core | Depends on Phase 0 spike outcome — if the order pre-pass adapter is needed, add tests specifically for interleaved-context ordering (this is currently under-tested even in Go — the one round-trip test has only one context switch) |

Total Go tests: 86 (`74` in `main_test.go` + `12` in `po_test.go`, counting each `func Test...` as
one). New suite must be ≥ 86 cases covering the same behaviors; add cases where TS/Node
introduces new edge cases (e.g. `gettext-parser` version quirks found during the Phase 0 spike,
or `p-limit` cancellation semantics) rather than skipping coverage to hit a number. `test/cli/`
also gains a handful of new thin exit-code-mapping tests (e.g. `GlotValidationError` → exit 2,
`GlotRuntimeError` → exit 1) that don't map to a single Go test 1:1, because Go's version tested
"business logic + exit" as one unit and the split above breaks that into two smaller units — see
the count as a floor, not a ceiling.

### Running tests

**Decision: `node --test` on the real Node runtime, using Node's native TypeScript type-stripping
— no `tsx`, no `ts-node`, no pre-build step.**

Node has shipped zero-config TS execution since 22.6 (behind `--experimental-strip-types`) and
made it default-on (no flag) starting in 22.18 LTS / 23.6 — this is now the Node team's own
sanctioned way to run `.ts` files, not a third-party workaround, which fits "use node's inbuilt
test framework" more literally than routing through Bun's `node:test` compatibility shim would.
Running under actual `node` also sidesteps any risk of Bun's `node:test`/`mock` implementation
having subtle gaps versus the real thing — Bun stays scoped to the build step (`bun build
--compile`) only, per the earlier stack decision; it is not the test runtime.

Consequence for `tsconfig.json`: set `"erasableSyntaxOnly": true` (enforced by `tsc --noEmit` in
CI) so nothing in `src/`/`test/` uses TS syntax that requires actual transformation — no `enum`,
no experimental decorators, no constructor parameter-property shorthand. Everything this codebase
needs (interfaces, type aliases, string-literal unions instead of enums, plain classes) is
erasable already, so this is a style constraint, not a capability loss.

Pin CI (and `engines.node` in `package.json`) to Node ≥22.18 (or a later LTS) so the flag is never
needed. No Jest, no Vitest, no Mocha — `node:test` + `node:assert/strict` only, per the
requirement.

## Build & packaging

```jsonc
// package.json (excerpt)
{
  "type": "module",
  "bin": { "glot": "./dist/glot" },
  "scripts": {
    "build": "bun build --compile --minify ./src/index.ts --outfile dist/glot",
    "build:darwin-arm64": "bun build --compile --target=bun-darwin-arm64 --minify ./src/index.ts --outfile dist/glot-darwin-arm64",
    "build:darwin-x64": "bun build --compile --target=bun-darwin-x64 --minify ./src/index.ts --outfile dist/glot-darwin-x64",
    "test": "node --test",
    "typecheck": "tsc --noEmit"
  }
}
```

`data/languages.json` is statically imported (`import languages from "../data/languages.json"
with { type: "json" }`) — Bun's bundler inlines statically-imported JSON into the compiled
binary, replacing Go's `//go:embed`. Verify this survives `--compile` during Phase 0 (Bun's
asset-embedding rules differ slightly between `bun build` and `bun build --compile`).

Cross-compiling `bun-darwin-arm64`/`bun-darwin-x64` targets from an `ubuntu-latest` GitHub Actions
runner (matching the current Go setup, which cross-compiles from Linux too) is confirmed to work
— Bun's `--target` cross-compilation for standalone executables embeds a prebuilt runtime per
target, no macOS runner needed.

## CI/CD

### `tests.yml` (replaces Go version)

Same trigger shape (push to `main` + PRs, path-filtered on source/test/data changes, `main`-only
non-cancellable concurrency group), steps become:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: "22.18"   # or later LTS — first version with type-stripping on by default
- uses: oven-sh/setup-bun@v2
- run: bun install
- run: npm run typecheck
- run: node --test
- run: bun run build
- run: ./dist/glot --version
```

Two runtimes in CI is intentional, not redundant: Node runs the test suite (per the "Node's
inbuilt test framework" requirement), Bun only produces the compiled binary.

Path filters change `**.go`/`go.mod`/`go.sum` → `**.ts`, `package.json`, `bun.lock`.

### `release.yml` (replaces Go version)

Same trigger (`push: tags: ["v*"]`), same macOS-only matrix (arm64 + amd64/x64), same
upload-artifact → download-artifact → `softprops/action-gh-release` shape:

```yaml
strategy:
  matrix:
    include:
      - target: bun-darwin-arm64
        suffix: darwin-arm64
      - target: bun-darwin-x64
        suffix: darwin-amd64   # keep existing asset suffix so README's curl command still works
```

Keep the `darwin-amd64` artifact *suffix* (not the Bun target name) unchanged so the README's
existing `curl .../glot-darwin-arm64` install command needs zero edits for that arch's users, and
only the arm64/amd64 label mapping needs documenting in the release step.

## Migration order (phased)

1. **Spike** — build the order-preserving/minimal-diff adapter over `gettext-parser` and prove
   it against the idempotence + minimal-diff acceptance criteria in the PO section, using the
   repo's fixtures plus at least one real-world interleaved-context `.po` file. This gates
   everything downstream: `PoFile.Save()` is on the critical path for `translate`, and every
   other module's tests assume it already preserves untouched lines exactly (test runtime and
   cross-compile target are already settled — see Testing plan and Build & packaging above).
2. **`core/po/`** — parser/writer/PoFile, ported 1:1 from `po.go`, plus `test/core/po.test.ts`
   (19 ported tests from the table above + the 2 new idempotence/minimal-diff tests from the PO
   section).
3. **`core/config.ts` + `core/errors.ts` + `core/languages.ts`** — `GlotConfig` type,
   `GlotValidationError`/`GlotRuntimeError`, embedded language list, `validateLang` (throws
   `GlotValidationError` now, no `osExit`).
4. **`core/glossary.ts`** — TSV loading (Node's `csv`-parsing needs a substitute for Go's
   `encoding/csv` with `Comma='\t'`; a small manual split or a minimal TSV reader, not a full CSV
   library, since the format is simple tab-separated with quoted-field edge cases mirroring
   `LazyQuotes`), tokenize, index, matching — plus tests.
5. **`core/prompts.ts`** — prompt builders + response parsers (pure functions, straightforward
   port) — plus tests.
6. **`core/ai-client.ts` + `core/deps.ts`** — OpenAI SDK wrapper taking `GlotConfig` explicitly,
   retry/error-mapping into `GlotRuntimeError` — plus tests with mocked `deps.callAI`/mocked HTTP.
7. **`core/operations/translate.ts`** — full port including core-cache short-circuit, backup
   file, chunking via `p-limit`, failed-entry reporting, capped-limit note, the `onEvent` progress
   callback, and validation failures as `GlotValidationError`/`GlotRuntimeError` throws instead of
   `osExit` — plus `test/core/translate.test.ts` asserting on the returned result + event log.
8. **`core/operations/review.ts`** — static check + AI pass merge + `onEvent` progress — plus
   `test/core/review.test.ts`. (The five output *formats* move to `cli/render.ts` in step 11 —
   `runReview` itself returns structured `reviewItem[]`, it doesn't render text/json/csv/etc.)
9. **`core/operations/status.ts`** — plus tests.
10. **`core/operations/glossaryPull.ts` + `corePull.ts`** — list/pull, including the WP.org
    fetch-with-fallback-slug logic — plus tests (scope matches current Go test coverage:
    locale-validation only, network paths untested, same as today).
11. **`cli/`** — `env.ts` (env → `GlotConfig`), `exit.ts`, `render.ts` (the 5 review output
    formats + status/glossary/core list formatting — ported from `outputReviewReport` et al.),
    `commands/*.ts` (thin: call the `core/operations` function, feed its `onEvent` into
    `render.ts`, catch thrown errors and map to exit codes), `cli.ts` (yargs wiring for all
    commands/flags, `-V`/`-h` shortcuts), `index.ts` — plus `test/cli/render.test.ts` and
    `test/cli/cli.test.ts` for the exit-code-mapping tests described above.
12. **Build/release pipeline** — `bunfig.toml`, `package.json` scripts, `tests.yml`,
    `release.yml`.
13. **Full parity pass** — run both binaries side by side against the same fixture `.po`/`.pot`
    files and a mocked AI backend; diff output. Update `README.md` (Go install instructions →
    Bun/Node ones) and `CLAUDE.md` (architecture section — including the `core`/`cli` boundary)
    once the port is verified.

## Open items to confirm during Phase 0 (not blocking plan approval, blocking implementation)

- What's the minimal adapter over `gettext-parser` that satisfies the idempotence + minimal-diff
  acceptance criteria in the PO section — is a raw-text order pre-pass sufficient on its own, or
  do specific edge cases (obsolete `#~` entries, blank comment lines, header formatting) need
  additional handling beyond just reordering? The requirement itself is fixed; only the mechanism
  is open.
