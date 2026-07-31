import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlotConfig } from "../config.ts";
import { deps } from "../deps.ts";
import { GlotValidationError } from "../errors.ts";
import { validateLang } from "../languages.ts";
import { PoFile } from "../po/poFile.ts";
import { indexTranslatableEntries } from "./corePull.ts";

export type TranslationsImportMode = "overwrite" | "merge";

export interface TranslationsImportResult {
  savedPath: string;
  entries: number;
  filesUsed: string[];
}

// Directory args expand, non-recursively, to their immediate *.po children
// (sorted alphabetically) in place — so a mix of directories and explicit
// files preserves later-wins ordering exactly as the user typed it.
function expandPaths(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    if (existsSync(p) && statSync(p).isDirectory()) {
      const poFiles = readdirSync(p, { withFileTypes: true })
        .filter((ent) => !ent.isDirectory() && ent.name.endsWith(".po"))
        .map((ent) => ent.name)
        .sort()
        .map((name) => join(p, name));
      files.push(...poFiles);
    } else {
      files.push(p);
    }
  }
  return files;
}

function loadExistingTranslations(config: GlotConfig, locale: string): Record<string, string | string[]> {
  const path = join(config.translationsDir, `${locale}.json`);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return typeof data === "object" && data !== null && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// Explicit import, not auto-parse-on-load: PO parsing is far more expensive
// than JSON.parse, so this materializes JSON once up front and keeps the
// per-translate-call read path (loadTranslationsCache) as cheap as it is
// today. mode "overwrite" (default) replaces translationsDir/<locale>.json
// from only the files given this run, matching core pull's behavior. mode
// "merge" layers these files onto the existing cache; new files still win on
// key collision, both within this run and against the pre-existing file.
export function runTranslationsImport(
  config: GlotConfig,
  locale: string,
  paths: string[],
  mode: TranslationsImportMode = "overwrite",
): TranslationsImportResult {
  if (locale === "") {
    throw new GlotValidationError("locale is required");
  }
  validateLang(locale, deps.loadValidLanguages());

  if (paths.length === 0) {
    throw new GlotValidationError("at least one file or directory is required");
  }

  const files = expandPaths(paths);

  const index: Record<string, string | string[]> = mode === "merge" ? loadExistingTranslations(config, locale) : {};

  for (const file of files) {
    if (!existsSync(file)) {
      throw new GlotValidationError(`file not found: ${file}`);
    }
    let pf: PoFile;
    try {
      pf = PoFile.parseFile(file);
    } catch (err) {
      throw new GlotValidationError(`cannot read file '${file}': ${err instanceof Error ? err.message : String(err)}`);
    }
    Object.assign(index, indexTranslatableEntries(pf));
  }

  mkdirSync(config.translationsDir, { recursive: true });
  const dest = join(config.translationsDir, `${locale}.json`);
  writeFileSync(dest, JSON.stringify(index));

  return { savedPath: dest, entries: Object.keys(index).length, filesUsed: files };
}

export interface TranslationsListItem {
  locale: string;
  lastUpdated: string;
  entries: number;
}

export type TranslationsListResult =
  | { outcome: "dirNotFound"; dir: string }
  | { outcome: "empty" }
  | { outcome: "listed"; dataDir: string; items: TranslationsListItem[] };

export function runTranslationsList(config: GlotConfig): TranslationsListResult {
  if (!existsSync(config.translationsDir) || !statSync(config.translationsDir).isDirectory()) {
    return { outcome: "dirNotFound", dir: config.translationsDir };
  }

  const jsonFiles = readdirSync(config.translationsDir, { withFileTypes: true })
    .filter((ent) => !ent.isDirectory() && ent.name.endsWith(".json"))
    .map((ent) => ent.name)
    .sort();

  if (jsonFiles.length === 0) {
    return { outcome: "empty" };
  }

  const items: TranslationsListItem[] = jsonFiles.map((name) => {
    const path = join(config.translationsDir, name);
    const mtime = statSync(path).mtime;
    let count = 0;
    try {
      const m = JSON.parse(readFileSync(path, "utf8"));
      if (typeof m === "object" && m !== null && !Array.isArray(m)) {
        count = Object.keys(m).length;
      }
    } catch {
      // malformed JSON leaves count at 0 rather than failing the whole listing
    }
    return { locale: name.slice(0, -".json".length), lastUpdated: mtime.toISOString().slice(0, 10), entries: count };
  });

  return { outcome: "listed", dataDir: config.dataDir, items };
}
