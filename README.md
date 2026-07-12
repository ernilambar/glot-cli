# glot-cli

CLI tool for translating `.po` files using any OpenAI-compatible backend (local or remote).

## Requirements

- Python 3.10+
- An OpenAI-compatible endpoint (e.g. LM Studio, Ollama, OpenAI, OpenRouter)

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GLOT_ENDPOINT_URL` | Yes | Chat completions URL, e.g. `http://127.0.0.1:1234/v1/chat/completions` |
| `GLOT_MODEL_ID` | Yes | Model ID to use |
| `GLOT_API_KEY` | No | API key (omit for local models) |
| `GLOT_DATA_DIR` | No | Data directory (default: `~/.config/glot-cli`) |
| `GLOT_MAX_STRINGS` | No | Max strings per run (default: `200`) |
| `GLOT_BATCH_SIZE` | No | Strings per API call (default: `10`) |
| `GLOT_CONCURRENCY` | No | Parallel API calls (default: `1`, increase for remote APIs) |
| `GLOT_REQUEST_TIMEOUT` | No | Seconds before HTTP timeout (default: none — waits forever) |

## Usage

### Translate a .po file

```bash
.venv/bin/python glot.py translate path/to/file.po --lang ne_NP
```

- Only untranslated entries are touched.
- A `.bak` backup is created before the first write.
- If the file has more strings than `GLOT_MAX_STRINGS`, run again to continue.

Options:

```
--lang   Target language code (default: ne_NP)
--tone   Translation register: formal, informal (default: formal)
--limit  Max strings this run, overrides GLOT_MAX_STRINGS
```

### Manage glossaries

```bash
# Download glossary from translate.wordpress.org
.venv/bin/python glot.py glossary pull ne_NP

# List downloaded glossaries
.venv/bin/python glot.py glossary list
```

Glossary files are stored at `$GLOT_DATA_DIR/glossary/<locale>.tsv` (default: `~/.config/glot-cli/glossary/<locale>.tsv`). When present, matching terms are enforced for consistency.

### Custom system prompt

Place a file at `$GLOT_DATA_DIR/prompts/<locale>.md` (default: `~/.config/glot-cli/prompts/<locale>.md`) to override the default prompt for a locale.

