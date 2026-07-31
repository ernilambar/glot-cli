import type { GlotConfig } from "../../core/config.ts";
import { runTranslationsImport, runTranslationsList } from "../../core/operations/translationsImport.ts";
import type { TranslationsImportMode } from "../../core/operations/translationsImport.ts";
import { handleError } from "../exit.ts";
import { renderTranslationsList } from "../render.ts";

export function runTranslationsListCommand(config: GlotConfig): void {
  try {
    process.stdout.write(renderTranslationsList(runTranslationsList(config)));
  } catch (err) {
    handleError(err, config.debug);
  }
}

export function runTranslationsImportCommand(
  config: GlotConfig,
  locale: string,
  paths: string[],
  mode: TranslationsImportMode,
): void {
  try {
    const result = runTranslationsImport(config, locale, paths, mode);
    if (result.entries === 0) {
      process.stderr.write("Warning: no entries found across the given files\n");
    }
    process.stdout.write(`Saved ${result.entries} entries to ${result.savedPath}\n`);
  } catch (err) {
    handleError(err, config.debug);
  }
}
