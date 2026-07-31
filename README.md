# glot-cli

CLI tool for translating WordPress PO files using any OpenAI-compatible backend (local or remote).

## Requirements

- An OpenAI-compatible endpoint (e.g. OpenAI, Ollama, LM Studio, OpenRouter)

## Install / Upgrade

**macOS** — Homebrew:

```bash
brew tap ernilambar/tap
brew trust ernilambar/tap
brew install ernilambar/tap/glot
glot --version
```

For the prebuilt-binary and from-source options, see [docs/installation.md](docs/installation.md).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GLOT_ENDPOINT_URL` | Yes | OpenAI-compatible base URL, e.g. `https://api.openai.com/v1` (OpenAI) or `http://localhost:11434/v1` (Ollama) |
| `GLOT_MODEL_ID` | Yes | Model ID to use |
| `GLOT_API_KEY` | No | API key (omit for local models) |
| `GLOT_LANG` | No | Default locale for read-only commands (`status`, `browse`), e.g. `ne_NP`. Commands that write data (`translate`, `core pull`, `glossary pull`, `translations import`) always require an explicit locale |
| `GLOT_DATA_DIR` | No | Data directory (default: `~/.config/glot-cli`) |
| `GLOT_MAX_STRINGS` | No | Max strings per run (default: `200`) |
| `GLOT_BATCH_SIZE` | No | Strings per API call (default: `10`) |
| `GLOT_CONCURRENCY` | No | Parallel API calls (default: `1`, increase for remote APIs) |
| `GLOT_REQUEST_TIMEOUT` | No | Seconds before HTTP timeout (default: `120`, set to `0` to disable) |
| `GLOT_BATCH_DELAY` | No | Seconds to wait before each batch API call (default: `0`, disabled) |

## Documentation

| Doc | Covers |
|---|---|
| [docs/installation.md](docs/installation.md) | Prebuilt binary and from-source install options |
| [docs/usage.md](docs/usage.md) | `translate`, `review`, `browse`, `status` |
| [docs/data-management.md](docs/data-management.md) | Core translation cache, custom translations cache, glossaries (incl. custom glossary), custom system prompt |
| [docs/serve.md](docs/serve.md) | Local REST API — endpoints, auth, running under pm2 |
| [docs/contributing.md](docs/contributing.md) | Contributing guidelines and manual testing checklist |
| [docs/release.md](docs/release.md) | How to cut a release |

## License

[MIT](LICENSE)
