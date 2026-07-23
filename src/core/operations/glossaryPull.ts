import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlotConfig } from "../config.ts";
import { deps } from "../deps.ts";
import { GlotValidationError } from "../errors.ts";
import { httpGet } from "../http.ts";
import { validateLang } from "../languages.ts";

export interface GlossaryListItem {
  locale: string;
  lastUpdated: string;
  entries: number;
}

export type GlossaryListResult =
  | { outcome: "dirNotFound"; dir: string }
  | { outcome: "empty" }
  | { outcome: "listed"; dataDir: string; items: GlossaryListItem[] };

function countLines(path: string): number {
  const text = readFileSync(path, "utf8");
  if (text === "") {
    return 0;
  }
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

export function runGlossaryList(config: GlotConfig): GlossaryListResult {
  if (!existsSync(config.glossaryDir) || !statSync(config.glossaryDir).isDirectory()) {
    return { outcome: "dirNotFound", dir: config.glossaryDir };
  }

  const tsvFiles = readdirSync(config.glossaryDir, { withFileTypes: true })
    .filter((ent) => !ent.isDirectory() && ent.name.endsWith(".tsv"))
    .map((ent) => ent.name)
    .sort();

  if (tsvFiles.length === 0) {
    return { outcome: "empty" };
  }

  const items: GlossaryListItem[] = tsvFiles.map((name) => {
    const path = join(config.glossaryDir, name);
    const mtime = statSync(path).mtime;
    const count = Math.max(0, countLines(path) - 1);
    return {
      locale: name.slice(0, -".tsv".length),
      lastUpdated: mtime.toISOString().slice(0, 10),
      entries: count,
    };
  });

  return { outcome: "listed", dataDir: config.dataDir, items };
}

export type GlossaryPullEvent = { type: "trying"; url: string };

export interface GlossaryPullResult {
  savedPath: string;
  entries: number;
}

// Lenient RFC4180-ish CSV parser (quoted fields, "" escaping, embedded
// commas/newlines inside quotes) for the comma-separated response from
// translate.wordpress.org — distinct from the tab-separated format we write
// to disk, and from the simple split-based TSV reader in core/glossary.ts.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function runGlossaryPull(
  config: GlotConfig,
  locale: string,
  onEvent?: (event: GlossaryPullEvent) => void,
): Promise<GlossaryPullResult> {
  if (locale === "") {
    throw new GlotValidationError("locale is required (or set GLOT_LANG env variable)");
  }
  validateLang(locale, deps.loadValidLanguages());

  const parts = locale.split("_");
  const baseURL = "https://translate.wordpress.org/locale";

  const tryURL = async (url: string): Promise<string> => {
    onEvent?.({ type: "trying", url });
    const { body, ok } = await httpGet(url);
    return ok && body.startsWith("en,") ? body : "";
  };

  let csvText = "";
  if (parts.length >= 3) {
    const lang = parts[0]!.toLowerCase();
    const variant = parts[2]!.toLowerCase();
    csvText = await tryURL(`${baseURL}/${lang}/${variant}/glossary/-export/`);
    if (csvText === "") {
      throw new GlotValidationError(`could not fetch glossary for '${locale}'.`);
    }
  } else {
    const fullSlug = locale.replaceAll("_", "-").toLowerCase();
    const langOnly = parts[0]!.toLowerCase();
    const slugs = fullSlug !== langOnly ? [fullSlug, langOnly] : [fullSlug];
    for (const slug of slugs) {
      csvText = await tryURL(`${baseURL}/${slug}/default/glossary/-export/`);
      if (csvText !== "") {
        break;
      }
    }
    if (csvText === "") {
      throw new GlotValidationError(`could not fetch glossary for '${locale}'.`);
    }
  }

  mkdirSync(config.glossaryDir, { recursive: true });
  const dest = join(config.glossaryDir, `${locale}.tsv`);

  const lines: string[] = [];
  for (const row of parseCsv(csvText)) {
    if (row.length < 4) {
      continue;
    }
    const clean = row.map((f) => f.replaceAll("\t", " "));
    lines.push(clean.join("\t"));
  }
  writeFileSync(dest, lines.map((l) => `${l}\n`).join(""));

  const entries = Math.max(0, lines.length - 1);
  return { savedPath: dest, entries };
}
