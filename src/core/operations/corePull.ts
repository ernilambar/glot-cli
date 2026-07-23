import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pLimit from "p-limit";
import { CORE_PROJECTS } from "../config.ts";
import type { GlotConfig } from "../config.ts";
import { deps } from "../deps.ts";
import { GlotValidationError } from "../errors.ts";
import { httpGet } from "../http.ts";
import { validateLang } from "../languages.ts";
import { coreCacheKey, isTranslated } from "../po/entry.ts";
import { PoFile } from "../po/poFile.ts";

export interface CoreListItem {
  locale: string;
  lastUpdated: string;
  entries: number;
}

export type CoreListResult =
  | { outcome: "dirNotFound"; dir: string }
  | { outcome: "empty" }
  | { outcome: "listed"; dataDir: string; items: CoreListItem[] };

export function runCoreList(config: GlotConfig): CoreListResult {
  if (!existsSync(config.coreDir) || !statSync(config.coreDir).isDirectory()) {
    return { outcome: "dirNotFound", dir: config.coreDir };
  }

  const jsonFiles = readdirSync(config.coreDir, { withFileTypes: true })
    .filter((ent) => !ent.isDirectory() && ent.name.endsWith(".json"))
    .map((ent) => ent.name)
    .sort();

  if (jsonFiles.length === 0) {
    return { outcome: "empty" };
  }

  const items: CoreListItem[] = jsonFiles.map((name) => {
    const path = join(config.coreDir, name);
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

export type CorePullEvent =
  | { type: "trying"; url: string }
  | { type: "projectSkipped"; label: string }
  | { type: "projectParseError"; label: string; error: string }
  | { type: "projectFetched"; label: string; count: number };

export interface CorePullResult {
  savedPath: string;
  entries: number;
}

const PROJECT_LABELS = ["wp/dev", "wp/dev/admin", "wp/dev/admin/network"];

export async function runCorePull(
  config: GlotConfig,
  locale: string,
  onEvent?: (event: CorePullEvent) => void,
): Promise<CorePullResult> {
  if (locale === "") {
    throw new GlotValidationError("locale is required (or set GLOT_LANG env variable)");
  }
  validateLang(locale, deps.loadValidLanguages());

  const parts = locale.split("_");
  const fullSlug = locale.replaceAll("_", "-").toLowerCase();
  const langOnly = parts[0]!.toLowerCase();
  const slugs = fullSlug !== langOnly ? [fullSlug, langOnly] : [fullSlug];

  const base = "https://translate.wordpress.org/projects";

  let firstText = "";
  let workingSlug = "";
  for (const slug of slugs) {
    const url = `${base}/${CORE_PROJECTS[0]!.replaceAll("{slug}", slug)}/export-translations/?format=po`;
    onEvent?.({ type: "trying", url });
    const { body, ok } = await httpGet(url);
    if (ok) {
      workingSlug = slug;
      firstText = body;
      break;
    }
  }
  if (workingSlug === "") {
    throw new GlotValidationError(`could not fetch core translations for '${locale}'.`);
  }

  const remainingUrls = CORE_PROJECTS.slice(1).map(
    (t) => `${base}/${t.replaceAll("{slug}", workingSlug)}/export-translations/?format=po`,
  );

  const limiter = pLimit(2);
  const fetched = await Promise.all(
    remainingUrls.map((url) =>
      limiter(async () => {
        const { body, ok } = await httpGet(url);
        return ok ? body : "";
      }),
    ),
  );

  const poTexts = [firstText, ...fetched];

  const index: Record<string, string> = {};
  poTexts.forEach((text, i) => {
    const label = PROJECT_LABELS[i]!;
    if (text === "") {
      onEvent?.({ type: "projectSkipped", label });
      return;
    }
    let pf: PoFile;
    try {
      pf = PoFile.parse(text);
    } catch (err) {
      onEvent?.({ type: "projectParseError", label, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let count = 0;
    for (const e of pf.translatableEntries()) {
      if (!isTranslated(e)) {
        continue;
      }
      index[coreCacheKey(e)] = e.msgStr;
      count++;
    }
    onEvent?.({ type: "projectFetched", label, count });
  });

  mkdirSync(config.coreDir, { recursive: true });
  const dest = join(config.coreDir, `${locale}.json`);
  writeFileSync(dest, JSON.stringify(index));

  return { savedPath: dest, entries: Object.keys(index).length };
}
