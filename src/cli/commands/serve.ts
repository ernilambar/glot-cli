import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { GlotConfig } from "../../core/config.ts";
import { GlotRuntimeError, GlotValidationError } from "../../core/errors.ts";
import { handleError } from "../exit.ts";
import { createEditorServer } from "../server/httpServer.ts";

export function runServeCommand(
  config: GlotConfig,
  input: string,
  lang: string,
  port: number,
  open: boolean,
  debug: boolean,
): void {
  try {
    if (!existsSync(input)) {
      throw new GlotValidationError(`file not found: ${input}`);
    }

    const server = createEditorServer(config, input, lang);

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        handleError(new GlotRuntimeError(`port ${port} is already in use — try a different port with --port`), debug);
      } else {
        handleError(err, debug);
      }
    });

    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      process.stdout.write(`Serving ${input} at ${url} (Ctrl+C to stop)\n`);
      if (open) {
        execFile("open", [url]);
      }
    });
  } catch (err) {
    handleError(err, debug);
  }
}
