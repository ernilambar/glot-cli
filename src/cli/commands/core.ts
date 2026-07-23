import type { GlotConfig } from "../../core/config.ts";
import { runCoreList, runCorePull } from "../../core/operations/corePull.ts";
import type { CorePullEvent } from "../../core/operations/corePull.ts";
import { handleError } from "../exit.ts";
import { renderCoreList } from "../render.ts";

export function runCoreListCommand(config: GlotConfig): void {
  try {
    process.stdout.write(renderCoreList(runCoreList(config)));
  } catch (err) {
    handleError(err, config.debug);
  }
}

function printEvent(event: CorePullEvent): void {
  switch (event.type) {
    case "trying":
      process.stdout.write(`Trying: ${event.url}\n`);
      break;
    case "projectSkipped":
      process.stdout.write(`  ${event.label}: skipped (not available)\n`);
      break;
    case "projectParseError":
      process.stdout.write(`  ${event.label}: parse error (${event.error})\n`);
      break;
    case "projectFetched":
      process.stdout.write(`  ${event.label}: ${event.count} strings\n`);
      break;
  }
}

export async function runCorePullCommand(config: GlotConfig, locale: string): Promise<void> {
  try {
    const result = await runCorePull(config, locale, printEvent);
    process.stdout.write(`Saved ${result.entries} entries to ${result.savedPath}\n`);
  } catch (err) {
    handleError(err, config.debug);
  }
}
