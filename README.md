# glot-cli

CLI tool for translating WordPress `.po` files using any OpenAI-compatible backend (local or remote).

Designed for WordPress translators — respects WordPress UI conventions, placeholder syntax, and pulls glossaries directly from translate.wordpress.org.

## Requirements

- Node.js 22.18+ and Bun (for building from source)
- An OpenAI-compatible endpoint (e.g. LM Studio, Ollama, OpenAI, OpenRouter)

## Install / Upgrade

**macOS** — prebuilt binary (replace `arm64` with `amd64` for Intel Macs):

```bash
curl -fL -o glot https://github.com/ernilambar/glot-cli/releases/latest/download/glot-darwin-arm64
xattr -d com.apple.quarantine glot 2>/dev/null || true
chmod +x glot
sudo mv glot /usr/local/bin/
glot --version
```

**From source** (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/ernilambar/glot-cli.git
cd glot-cli
bun install
bun run build
sudo mv dist/glot /usr/local/bin/
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GLOT_ENDPOINT_URL` | Yes | Chat completions URL, e.g. `http://localhost:11434/v1/chat/completions` |
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
- Strings found in the core translation cache are applied directly — no AI call for those.
- A `.bak` backup is created before the first write.
- If the file has more strings than `GLOT_MAX_STRINGS`, run again to continue.

Options:

```
--lang   Target language code, e.g. ne_NP. Overrides GLOT_LANG. Required if GLOT_LANG is not set.
--limit  Max strings this run, overrides GLOT_MAX_STRINGS
--debug  Show raw technical detail alongside AI error messages
```

### Review strings for i18n issues

```bash
glot review path/to/file.pot
```

Analyzes all strings in a `.po` or `.pot` file using AI and flags i18n violations — hardcoded numbers, dates, file names, URLs, and missing `/* translators: */` comments. Each issue shows the source string, file location, and what to fix.

```
Found 1 issue(s):

  String: "Showing 5 results"
  src/admin/class-admin.php:42
  Issue: Hardcoded number '5' — use %d via sprintf

Total: 1 issue(s) in 45 string(s)
```

```
--format   Output format: text (default), table, json, csv, markdown
--debug    Show raw technical detail alongside AI error messages
```

### Check translation status

```bash
glot status path/to/file.po
```

Shows total, translated, untranslated, and fuzzy counts for a `.po` file. If `GLOT_LANG` is set, also shows how many untranslated strings have cached translations in the core cache.

### Manage core translation cache

Download approved translations from WordPress core. These are applied before any AI call — strings found in core are used verbatim, bypassing the AI entirely.

```bash
# Download core translations from translate.wordpress.org
glot core pull ne_NP

# Omit locale if GLOT_LANG is set
glot core pull

# List downloaded core translation files
glot core list
```

Core translation files are stored at `$GLOT_DATA_DIR/core/<locale>.json` (default: `~/.config/glot-cli/core/<locale>.json`). Covers all three WP core projects: `wp/dev`, `wp/dev/admin`, and `wp/dev/admin/network`.

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
2. Make your changes and test locally with `node --test`.
3. Open a pull request with a clear description of what changed and why.

### Manual Testing

Before opening a PR, verify the key commands against a real `.po` file:

```bash
node src/index.ts status path/to/file.po
node src/index.ts translate path/to/file.po --lang ne_NP --limit 1
node src/index.ts review path/to/file.pot
node src/index.ts glossary pull ne_NP
node src/index.ts glossary list
node src/index.ts core pull ne_NP
node src/index.ts core list
```

## Release

Tags must be prefixed with `v` (e.g. `v1.0.1`). The release workflow triggers on `v*` tags only — an unprefixed tag like `1.0.1` will not build or publish binaries.

```bash
git tag v1.0.1
git push origin v1.0.1
```

## License

[MIT](LICENSE)
