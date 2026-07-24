# FEATURE: `glot serve`

Local read-only REST API exposing glot-cli's glossary lookup, WordPress core
translation cache, and AI translation, so other local tools (primary consumer:
a WordPress plugin) call into glot-cli instead of reimplementing it.

Supersedes the original PLAN. Changes from the plan are marked **[revised]**
with rationale; everything unmarked is carried over unchanged.

## Decisions

- **Read-only.** No endpoint writes to any `.po` file or mutates state. The one
  exception is first-run token-file creation (see Auth).
- **Bind `127.0.0.1` only.** Never `0.0.0.0`.
- **Auth: filesystem token file.**
  - **[revised]** Path derived from config, not hardcoded:
    `join(config.dataDir, "serve.token")`. `dataDir` is `GLOT_DATA_DIR` or
    `~/.config/glot-cli` (`cli/env.ts:23`). Hardcoding `~/.config/glot-cli`
    breaks the moment a user sets `GLOT_DATA_DIR`, while glossary/core/prompts
    relocate correctly.
  - `crypto.randomBytes(32).toString('hex')` (64 hex chars), generated once on
    first `glot serve` if absent, reused after.
  - **[revised]** On startup: `mkdirSync(dataDir, {recursive:true})` before
    write (the dir may not exist on a first run); write with `{mode:0o600}`;
    **and** if the file already existed, `chmodSync(path, 0o600)` — the `mode`
    option only applies on creation, so a pre-existing loose-perm token is
    never fixed otherwise.
  - Every request requires `Authorization: Bearer <token>`; missing/wrong →
    `401`. Applied to all routes uniformly, including `/api/ping`.
  - **[revised]** Compare with `crypto.timingSafeEqual` over equal-length
    buffers (guard length first — `timingSafeEqual` throws on length
    mismatch), not `===`. Low severity behind 127.0.0.1 + a 256-bit secret,
    but free correctness given `crypto` is already imported.
  - `glot serve` prints only the file **path** on startup, never the token
    value (avoids leaking it into scrollback/session logs). The user opens the
    file once and pastes the value into the consuming tool's settings UI —
    required anyway since a Dockerized consumer can't read the host filesystem.
- **Error format: RFC 7807** (`application/problem+json`), minimal profile:
  `{ "title": "...", "status": 400, "detail": "..." }`. Success responses are
  plain resource JSON, no wrapper.
- **`/api/glossary` and `/api/core` list routes collapse to a flat array.**
  `runGlossaryList`/`runCoreList` (`core/operations/glossaryPull.ts`,
  `corePull.ts`) return a 3-way `outcome` (`dirNotFound`/`empty`/`listed`); the
  REST response flattens all three to `[]` or the items array — consumer only
  needs "is there anything," not why it's empty.
- **[revised] Locale validation.** Path/body `lang` is validated with
  `validateLang` (`core/languages.ts`) → `400` on an unknown locale.
  `loadGlossary`/`loadCoreTranslations` silently return `{}` for a missing
  file, so without this an unknown locale is indistinguishable from a known-
  but-not-yet-pulled one. Distinguish: unknown locale → `400`; known locale
  with no pulled data → `200` with `[]`/empty.
- **Not building for v1:** rate limiting, token rotation, concurrent AI request
  cap, request-body size cap. Single trusted, human-triggered consumer.
  Revisit only if hit in practice. **[note]** Every `/api/translate` reloads +
  parses the full core JSON from disk (can be thousands of entries) — accepted
  for one human-triggered consumer; first thing to cache if that assumption
  breaks.
- **Long-term running is out of scope for glot-cli.** Use an external process
  manager (`pm2 start glot -- serve`), not built-in daemon/PID/`--stop`.

## Translate modes **[revised — replaces `forceAi` boolean]**

The plan's `forceAi: true|false` has no way to say "never call AI." A WordPress
plugin that only wants **officially-approved** WP core translations — the most
obvious consumer — would be forced to configure an AI endpoint just to do
dictionary lookups. Replace the boolean with a 3-state `mode`:

| `mode` | Behavior | AI config required? |
|---|---|---|
| `"cache"` | Cache lookup only. Miss → `404`. Never calls AI. | **No** |
| `"cache-then-ai"` *(default)* | Cache lookup; miss falls through to AI. | Yes |
| `"ai"` | Skip cache, always call AI. | Yes |

**AI-config fail-fast** (carried from plan, now mode-scoped): for `ai` and
`cache-then-ai`, check `config.endpointUrl`/`config.modelId` **before** the
cache lookup, unconditionally, every call; missing either →
`GlotValidationError` → `400` with
`"required environment variable(s) not set: GLOT_ENDPOINT_URL, GLOT_MODEL_ID"`.
Matches `runTranslate` exactly (`translate.ts:57-66`, which checks before even
loading the core cache).

Rationale unchanged from plan: if AI is misconfigured, the endpoint must fail
identically on every call, not succeed for cached `msgid`s and fail for
uncached ones. Non-deterministic failure is worse for the consumer than always
failing until setup is fixed. Without the pre-check, an unconfigured setup
fails deep in `callAI` with the misleading `"could not reach AI endpoint —
check GLOT_ENDPOINT_URL and your network connection"` (`ai-client.ts:60-63`),
which reads like a network fault rather than "never configured."

`"cache"` mode **skips** this check — it never reaches AI, so requiring AI
config would defeat the entire point of the mode.

## Plural support **[new — in scope for this release]**

The plan omitted plurals. Two gaps must be fixed, not just the API surface:

### Gap 1 — the core cache currently discards plural data (data-layer bug)

`corePull.ts:137` stores `index[coreCacheKey(e)] = e.msgStr`. For a plural
entry, `msgStr` is empty (translations live in `msgStrPlural`), yet
`isTranslated(e)` passes it (`entry.ts:11-18` checks `msgStrPlural`). Result:
**translated plural entries are cached as empty strings today.** Any plural
support is impossible until the cache actually stores plural forms.

**Fix — core cache value type becomes `string | string[]`:**

- `corePull.ts`: for a plural entry, store the ordered array
  `Object.keys(e.msgStrPlural).map(Number).sort((a,b)=>a-b).map(k => e.msgStrPlural[k])`;
  for a singular entry, store `e.msgStr` as today.
- `core-translations.ts`: `loadCoreTranslations` return type →
  `Record<string, string | string[]>`. It already returns whatever's on disk,
  so old (all-string) files keep loading; consumers must handle both shapes.
- **Ripple — must update or these regress:**
  - `translate.ts:96-104` core-hit loop does `e.msgStr = v`. If `v` is now an
    array this assigns an array to a string field. Update: array value + plural
    entry → fill `msgStrPlural` by index; scalar → `msgStr`; mismatch (array
    value, singular entry or vice versa) → treat as a miss and fall through.
    Note the CLI batch translate path is otherwise singular-only today; this
    change only needs to stop it breaking, not add full CLI plural translation.
  - `findCoreMatches` (`serveEditor.ts:48-61`) iterates `Object.entries(core)`
    and compares `value !== ""`. Handle array values (e.g. skip in the
    singular-chip context, or join for display) so it doesn't stringify an
    array.
- **Migration:** existing `*.json` core caches lack plural arrays. Users must
  re-run `glot core pull` to populate them. Document in the release notes; no
  auto-migration.

### Gap 2 — the AI path is singular-only, and the API has no `.po` header

`buildBatchPrompt` reads only `msgId`; `parseBatchResponse` returns one string
per item; `translateSingle` returns one string. Plural translation needs N
forms. And the stateless API has **no `.po` file**, so the server cannot derive
`nplurals` the way the CLI does (`detectPluralCount` reads the `.po` header,
`entry.ts:41-48`).

**Fix — `nplurals` comes from the request:**

- Request carries `msgid_plural` (string) and `nplurals` (int). `nplurals` is
  **required whenever `msgid_plural` is present** — keeps the fail-fast rule
  deterministic. The WP plugin already knows its locale's plural-form count.
- AI plural path: add a plural-aware prompt builder + parser (extend
  `prompts.ts` or add a sibling in the serve wrapper) that asks for exactly
  `nplurals` forms of one string and parses back an ordered array of that
  length. `buildBatchPrompt`/`parseBatchResponse` stay singular; do not
  overload them.
- Cache path: lookup key stays `coreCacheKey({msgCtxt, msgId})` — the singular
  `msgid`, matching how WP core `.po` keys work. A hit whose stored value is an
  array is a plural hit. If the cached array length ≠ requested `nplurals`, the
  **cached WP-core array is authoritative** — return it as-is with
  `source:"core"` and let the consumer reconcile. (Do not pad/truncate;
  do not error.)

## Endpoints

| Method | Path | Backed by |
|---|---|---|
| `GET` | `/api/ping` | New, trivial — valid token → `{"status":"ok"}`. Connection test for the consumer's settings UI. |
| `GET` | `/api/languages` | `loadValidLanguages` (`core/languages.ts`) — full locale list (code → display name). |
| `GET` | `/api/glossary` | `runGlossaryList` — flattened to array. |
| `GET` | `/api/glossary/:lang` | `loadGlossary` (`core/glossary.ts`). `validateLang` first. |
| `GET` | `/api/glossary/:lang/match?text=...` | `buildGlossaryIndex` + `matchingGlossaryTerms` (`core/glossary.ts`). |
| `GET` | `/api/core` | `runCoreList` — flattened to array. |
| `GET` | `/api/core/:lang?msgid=...` | **[revised]** `findCoreMatches` (`serveEditor.ts:48`), **not** a direct `loadCoreTranslations` key lookup. |
| `POST` | `/api/translate` | New cache-then-AI wrapper in `core/operations/`. |

**[revised] `/api/core/:lang?msgid=...`:** cache keys are `ctxt\x04msgid`
(`entry.ts:53`). A direct `core[msgid]` lookup **misses every context-qualified
translation** (`core["Menu\x04Foo"]` for `msgid=Foo`). `findCoreMatches`
already scans and strips `\x04` for exactly this reason — reuse it. Returns all
approved candidates for the `msgid` across contexts.

**[removed] Server-level `--lang` default.** The plan floated one; no route
uses it. Every glossary/core route takes `:lang` in the path and
`/api/translate` takes `lang` in the body. Drop it — it was cargo-culted from
`browse.ts`, where a single file has a single target lang.

No batch/file-level translate or `.po`-status endpoint in v1 — the WordPress
tool handles `.po` files itself; `runTranslate`/`runStatus` stay CLI-only.

### `POST /api/translate`

**Singular request:**

```json
{ "msgid": "Settings saved", "lang": "de", "msgctxt": "", "mode": "cache-then-ai" }
```

**Plural request:**

```json
{
  "msgid": "%d item",
  "msgid_plural": "%d items",
  "lang": "de",
  "msgctxt": "",
  "nplurals": 2,
  "mode": "cache-then-ai"
}
```

- `msgctxt` (optional, default `""`) — part of the exact cache key:
  `coreCacheKey({ msgCtxt: msgctxt, msgId: msgid })` (`entry.ts:53-55`), i.e.
  `` `${msgctxt}\x04${msgid}` `` with a context, else bare `msgid`. Note the
  field is `msgctxt` in the request but maps to `msgCtxt` in the core type.
- `mode` (optional, default `"cache-then-ai"`) — see Translate modes.
- `msgid_plural` (optional) — presence makes it a plural request.
- `nplurals` (int) — **required iff `msgid_plural` present.**

**Response — singular:** `{ "translation": "...", "source": "core" | "ai" }`
**Response — plural:** `{ "translations": ["...", "..."], "source": "core" | "ai" }`

Shape is distinguished by whether `msgid_plural` was sent. `mode:"cache"` miss
→ `404` (RFC 7807).

## Implementation

- `src/cli/server/apiServer.ts` — new, sibling to `httpServer.ts`, same raw
  `node:http` + manual routing style (no framework). Auth middleware
  (timing-safe bearer check) wraps all routes.
- `src/core/operations/` — new cache-then-AI translate wrapper (singular +
  plural). Glossary/core read routes call existing functions directly.
- `src/core/operations/corePull.ts` + `src/core/core-translations.ts` — core
  cache value type `string | string[]` (Plural Gap 1).
- `src/core/operations/translate.ts` + `serveEditor.ts` (`findCoreMatches`) —
  updated to tolerate array core values without regressing.
- `src/core/prompts.ts` (or serve-wrapper sibling) — plural-aware prompt +
  parser (Plural Gap 2).
- `src/cli/commands/serve.ts` — new, mirrors `browse.ts`: load/generate token
  file, create server, bind `127.0.0.1`, print listen message + token path.
- `src/cli/cli.ts` — wire `serve` subcommand (`--port`; **no `--lang`**).

## Tests

- `apiServer` routing + auth: `401` on missing/wrong token (assert timing-safe
  path is exercised), `404` on unknown route.
- `validateLang` → `400` on unknown locale; `200`/`[]` on known-but-unpulled.
- `/api/core/:lang?msgid=` returns context-qualified matches (regression guard
  against the direct-lookup bug).
- Translate modes: `cache` miss → `404` **and** does not require AI config;
  `ai`/`cache-then-ai` → `400` when AI env unset, before any cache lookup.
- Plural round-trip: `corePull` stores plural arrays; `/api/translate` plural
  cache hit returns the array; `nplurals` required with `msgid_plural`; cached
  array length ≠ `nplurals` returns cached array unchanged with `source:core`.
- Old-shape (all-string) core JSON still loads (migration tolerance).

## Example requests

**curl:**

```bash
TOKEN=$(cat "${GLOT_DATA_DIR:-$HOME/.config/glot-cli}/serve.token")

curl http://127.0.0.1:4000/api/glossary/de \
  -H "Authorization: Bearer $TOKEN"

curl -X POST http://127.0.0.1:4000/api/translate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"msgid":"Settings saved","lang":"de","msgctxt":"","mode":"cache-then-ai"}'
```

**PHP (WordPress plugin, token stored via its own settings UI):**

```php
$token = get_option( 'glot_cli_token' );

$response = wp_remote_post( 'http://127.0.0.1:4000/api/translate', array(
    'headers' => array(
        'Authorization' => 'Bearer ' . $token,
        'Content-Type'  => 'application/json',
    ),
    'body' => wp_json_encode( array(
        'msgid'        => '%d item',
        'msgid_plural' => '%d items',
        'lang'         => 'de',
        'msgctxt'      => '',
        'nplurals'     => 2,
        'mode'         => 'cache',
    ) ),
) );

$code = wp_remote_retrieve_response_code( $response );
$data = json_decode( wp_remote_retrieve_body( $response ), true );

if ( $code >= 400 ) {
    // RFC 7807 shape: $data['title'], $data['detail']
} elseif ( isset( $data['translations'] ) ) {
    // plural forms array
}
```
