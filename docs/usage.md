# Usage

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
--lang   Target language code, e.g. ne_NP. Always required (not read from GLOT_LANG).
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

### Browse and edit a PO file in the browser

```bash
glot browse path/to/file.po --lang ne_NP
```

Opens a browser-based editor for viewing and editing entries. Editing/saving works without `--lang`; it's only needed for AI-translate from the browser.

```
--lang    Target locale code, e.g. ne_NP. Overrides GLOT_LANG.
--port    Port to serve on (default: 49700)
--no-open Don't open the browser automatically
--debug   Show raw technical detail alongside AI error messages
```

### Check translation status

```bash
glot status path/to/file.po
```

Shows total, translated, untranslated, and fuzzy counts for a `.po` file. If `GLOT_LANG` is set, also shows how many untranslated strings have cached translations in the core cache.
