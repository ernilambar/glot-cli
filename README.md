# glot-cli

CLI tool for translating `.po` files using any OpenAI-compatible backend (local or remote).

## Requirements

- Python 3.10+
- An OpenAI-compatible endpoint (e.g. LM Studio, Ollama, OpenAI, OpenRouter)

## Setup

Install via [pipx](https://pipx.pypa.io) for a global `glot` command available from any directory:

```bash
brew install pipx
pipx ensurepath
pipx install -e /path/to/glot-cli
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GLOT_ENDPOINT_URL` | Yes | Chat completions URL, e.g. `http://127.0.0.1:1234/v1/chat/completions` |
| `GLOT_MODEL_ID` | Yes | Model ID to use |
| `GLOT_API_KEY` | No | API key (omit for local models) |
| `GLOT_LANG` | No | Default target language code, e.g. `ne_NP` |
| `GLOT_DATA_DIR` | No | Data directory (default: `~/.config/glot-cli`) |
| `GLOT_MAX_STRINGS` | No | Max strings per run (default: `200`) |
| `GLOT_BATCH_SIZE` | No | Strings per API call (default: `10`) |
| `GLOT_CONCURRENCY` | No | Parallel API calls (default: `1`, increase for remote APIs) |
| `GLOT_REQUEST_TIMEOUT` | No | Seconds before HTTP timeout (default: `120`, set to `0` to disable) |

## Usage

### Translate a .po file

```bash
glot translate path/to/file.po --lang ne_NP
```

- Only untranslated entries are touched.
- A `.bak` backup is created before the first write.
- If the file has more strings than `GLOT_MAX_STRINGS`, run again to continue.

Options:

```
--lang   Target language code, e.g. ne_NP. Overrides GLOT_LANG. Required if GLOT_LANG is not set.
--limit  Max strings this run, overrides GLOT_MAX_STRINGS
```

### Manage glossaries

```bash
# Download glossary from translate.wordpress.org
glot glossary pull ne_NP

# Omit locale if GLOT_LANG is set
glot glossary pull

# List downloaded glossaries
glot glossary list
```

Glossary files are stored at `$GLOT_DATA_DIR/glossary/<locale>.tsv` (default: `~/.config/glot-cli/glossary/<locale>.tsv`). When present, matching terms are enforced for consistency.

### Custom system prompt

Place a file at `$GLOT_DATA_DIR/prompts/<locale>.md` (default: `~/.config/glot-cli/prompts/<locale>.md`) to override the default prompt for a locale.

## Contributing

Bug reports and pull requests are welcome on [GitHub](https://github.com/ernilambar/glot-cli).

1. Fork the repo and create your branch from `main`.
2. Make your changes and test locally.
3. Open a pull request with a clear description of what changed and why.

## License

[MIT](LICENSE)

