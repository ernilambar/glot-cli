import type { GlotConfig } from "../../core/config.ts";
import { runGlossaryList, runGlossaryPull } from "../../core/operations/glossaryPull.ts";
import type { GlossaryPullEvent } from "../../core/operations/glossaryPull.ts";
import { handleError } from "../exit.ts";
import { renderGlossaryList } from "../render.ts";

export function runGlossaryListCommand(config: GlotConfig): void {
  try {
    process.stdout.write(renderGlossaryList(runGlossaryList(config)));
  } catch (err) {
    handleError(err, config.debug);
  }
}

function printEvent(event: GlossaryPullEvent): void {
  if (event.type === "trying") {
    process.stdout.write(`Trying: ${event.url}\n`);
  }
}

export async function runGlossaryPullCommand(config: GlotConfig, locale: string): Promise<void> {
  try {
    const result = await runGlossaryPull(config, locale, printEvent);
    process.stdout.write(`Saved ${result.entries} entries to ${result.savedPath}\n`);
  } catch (err) {
    handleError(err, config.debug);
  }
}
