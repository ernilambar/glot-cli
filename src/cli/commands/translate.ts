import type { GlotConfig } from "../../core/config.ts";
import { runTranslate } from "../../core/operations/translate.ts";
import type { TranslateEvent } from "../../core/operations/translate.ts";
import { handleError } from "../exit.ts";

function printEvent(event: TranslateEvent): void {
  switch (event.type) {
    case "backupCreated":
      process.stdout.write(`Backup created: ${event.path}\n`);
      break;
    case "found":
      process.stdout.write(`Found ${event.count} untranslated string(s).\n`);
      break;
    case "coreMatches":
      process.stdout.write(`Core matches: ${event.count} (skipped AI)\n`);
      break;
    case "glossaryLoaded":
      process.stdout.write(`Glossary loaded: ${event.count} terms (${event.lang})\n`);
      break;
    case "customSystemPromptLoaded":
      process.stdout.write("Custom system prompt loaded.\n");
      break;
    case "translating":
      process.stdout.write(
        `Translating ${event.totalStrings} string(s) in ${event.totalBatches} batch(es) (batch size: ${event.batchSize}, concurrency: ${event.concurrency}) ...\n\n`,
      );
      break;
    case "batchFailed":
      process.stdout.write(
        `  Batch ${event.index + 1}/${event.totalBatches}: FAILED — ${event.error}  [${event.doneStrings}/${event.totalStrings}]\n`,
      );
      break;
    case "batchOk":
      process.stdout.write(
        `  Batch ${event.index + 1}/${event.totalBatches}: ${event.ok}/${event.chunkSize} ok  [${event.doneStrings}/${event.totalStrings}]\n`,
      );
      break;
  }
}

export async function runTranslateCommand(
  config: GlotConfig,
  input: string,
  lang: string,
  limit: number,
  debug: boolean,
): Promise<void> {
  try {
    const result = await runTranslate({ ...config, debug }, input, lang, limit, printEvent);

    if (result.outcome === "alreadyTranslated") {
      process.stdout.write("Nothing to do. File is already fully translated.\n");
      return;
    }

    process.stdout.write(`\nSaved: ${result.savedPath}\n`);
    process.stdout.write(`Translated: ${result.translated}  Failed: ${result.failed.length}\n`);
    if (result.usage) {
      process.stdout.write(
        `Tokens: input=${result.usage.promptTokens}, output=${result.usage.completionTokens}, total=${result.usage.totalTokens}\n`,
      );
    }
    if (result.failed.length > 0) {
      process.stdout.write("\nFailed entries:\n");
      result.failed.slice(0, 10).forEach((f) => {
        const msgid = f.msgId.length > 80 ? f.msgId.slice(0, 80) : f.msgId;
        process.stdout.write(`  [${f.error}] ${msgid}\n`);
      });
    }
    if (result.capped) {
      process.stdout.write(`\nNote: ${result.remaining} string(s) remain. Run again to continue.\n`);
    }
  } catch (err) {
    handleError(err, debug);
  }
}
