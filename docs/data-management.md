# Data management

### Manage core translation cache

Download approved translations from WordPress core. These are applied before any AI call — strings found in core are used verbatim, bypassing the AI entirely.

```bash
# Download core translations from translate.wordpress.org
glot core pull ne_NP

# List downloaded core translation files
glot core list
```

Core translation files are stored at `$GLOT_DATA_DIR/core/<locale>.json` (default: `~/.config/glot-cli/core/<locale>.json`). Covers all three WP core projects: `wp/dev`, `wp/dev/admin`, and `wp/dev/admin/network`.

### Manage translation cache

Import your own pre-approved translations (translation memory) — strings you've already reviewed and want glot-cli to use verbatim instead of calling the AI. These merge with the core cache; on a key collision, your imported translation wins.

```bash
# Import one or more PO files for a locale
glot translations import path/to/file.po --lang ne_NP

# A directory expands (non-recursively) to its *.po files, sorted alphabetically
glot translations import ./po-files/ --lang ne_NP

# Directories and files can be mixed; later files win on key collision
glot translations import ./po-files/ override.po --lang ne_NP

# Re-importing replaces the cache by default (--mode overwrite);
# --mode merge layers the new files onto the existing cache instead
glot translations import updated.po --lang ne_NP --mode merge

# List imported translation cache files
glot translations list
```

Translation cache files are stored at `$GLOT_DATA_DIR/translations/<locale>.json` (default: `~/.config/glot-cli/translations/<locale>.json`). Checked before the AI, same as the core cache. `glot status` and the core-cache lookups used by `serve`/`browse` report combined hits across core + translations.

### Manage glossaries

```bash
# Download glossary from translate.wordpress.org
glot glossary pull ne_NP

# List downloaded glossaries
glot glossary list
```

Glossary files are stored at `$GLOT_DATA_DIR/glossary/<locale>.tsv` (default: `~/.config/glot-cli/glossary/<locale>.tsv`). When present, matching terms are enforced for consistency.

To extend the WordPress core glossary with your own terms (e.g. product-specific terminology), place a same-format TSV file at `$GLOT_DATA_DIR/glossary/custom/<locale>.tsv`:

```
en	<lang-code>	pos	description
```

Custom terms merge with the core glossary; on a collision, the custom entry wins (replacing all of that term's pos-variants, not merged row-by-row). `glot glossary list` flags which locales have a custom file present.

### Custom system prompt

Place a file at `$GLOT_DATA_DIR/prompts/<locale>.md` (default: `~/.config/glot-cli/prompts/<locale>.md`) to override the default prompt for a locale.
