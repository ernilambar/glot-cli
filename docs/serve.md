# Serve a local read-only REST API

```bash
glot serve --port 49701
```

Starts a local, read-only REST API exposing glossary lookup, the core translation cache, and AI translation — for other local tools (e.g. a WordPress plugin) to call into instead of reimplementing them. Binds to `127.0.0.1` only.

On first run, a bearer token is generated at `$GLOT_DATA_DIR/serve.token` (default: `~/.config/glot-cli/serve.token`). Every request requires it:

```bash
TOKEN=$(cat ~/.config/glot-cli/serve.token)

curl http://127.0.0.1:49701/api/v1/ping \
  -H "Authorization: Bearer $TOKEN"

curl http://127.0.0.1:49701/api/v1/glossary/ne_NP \
  -H "Authorization: Bearer $TOKEN"

curl -X POST http://127.0.0.1:49701/api/v1/translate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"msgid":"Settings saved","lang":"ne_NP","mode":"cache-then-ai"}'
```

Options:

```
--port   Port to serve on (default: 49701)
--debug  Show raw technical detail alongside error messages
```

Endpoints (all under `/api/v1`):

| Method | Path | Description |
|---|---|---|
| `GET` | `/ping` | Connection test |
| `GET` | `/info` | Server version and other basic information |
| `GET` | `/languages` | Full locale list (code → display name) |
| `GET` | `/glossary` | List pulled glossaries |
| `GET` | `/glossary/:lang` | Glossary terms for a locale |
| `GET` | `/glossary/:lang/match?text=...` | Glossary terms found in the given text |
| `GET` | `/core` | List pulled core translation caches |
| `GET` | `/core/:lang?msgid=...` | Approved translations for a `msgid` (WP core cache + custom translations cache, custom wins) |
| `GET` | `/translations` | List imported custom translations cache files |
| `POST` | `/translate` | Cache-then-AI translate (singular or plural); `mode`: `cache`, `cache-then-ai` (default), or `ai` |

Errors use RFC 7807 (`application/problem+json`): `{ "title": "...", "status": 400, "detail": "..." }`.

## Run in the background with pm2

Keep the API running with [pm2](https://pm2.keymetrics.io/). Run from a shell where the `GLOT_*` variables are set (flags after `--` go to glot):

```bash
pm2 start glot --name glot-serve -- serve

pm2 logs glot-serve      # view logs
pm2 restart glot-serve   # restart
pm2 delete glot-serve    # remove
pm2 save                 # persist across reboots
```
