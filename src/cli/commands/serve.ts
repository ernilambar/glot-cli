import type { GlotConfig } from "../../core/config.ts";
import { GlotRuntimeError } from "../../core/errors.ts";
import { handleError } from "../exit.ts";
import { createApiServer } from "../server/apiServer.ts";
import { ensureServeToken } from "../server/token.ts";

export function runServeCommand(config: GlotConfig, port: number, debug: boolean): void {
  try {
    const { path, token } = ensureServeToken(config);
    const server = createApiServer(config, token);

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        handleError(new GlotRuntimeError(`port ${port} is already in use — try a different port with --port`), debug);
      } else {
        handleError(err, debug);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`Serving API at http://127.0.0.1:${port} (Ctrl+C to stop)\n`);
      process.stdout.write(`Token: ${path}\n`);
    });
  } catch (err) {
    handleError(err, debug);
  }
}
