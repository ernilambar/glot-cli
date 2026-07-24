import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlotConfig } from "../../core/config.ts";

export interface ServeToken {
  path: string;
  token: string;
}

export function tokenPath(config: GlotConfig): string {
  return join(config.dataDir, "serve.token");
}

// Loads the persistent bearer token for `glot serve`, generating one on
// first run. `{mode:0o600}` on writeFileSync only applies at creation time,
// so an existing token file gets its permissions re-tightened on every call
// in case it was ever created with looser permissions.
export function ensureServeToken(config: GlotConfig): ServeToken {
  const path = tokenPath(config);
  mkdirSync(config.dataDir, { recursive: true });

  if (existsSync(path)) {
    chmodSync(path, 0o600);
    return { path, token: readFileSync(path, "utf8").trim() };
  }

  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { mode: 0o600 });
  return { path, token };
}
