import type { GlotConfig } from "../../core/config.ts";
import { runStatus } from "../../core/operations/status.ts";
import { handleError } from "../exit.ts";
import { renderStatus } from "../render.ts";

export function runStatusCommand(config: GlotConfig, input: string, lang: string): void {
  try {
    const result = runStatus(config, input, lang);
    process.stdout.write(renderStatus(result));
  } catch (err) {
    handleError(err, config.debug);
  }
}
