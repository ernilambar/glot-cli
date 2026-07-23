import { GlotRuntimeError, GlotValidationError } from "../core/errors.ts";

// Mutable swap-point (same shape as core/deps.ts) rather than a plain
// exported function: ESM export bindings can't be redefined by node:test's
// mock.method, so tests swap exitDeps.exit instead of mocking `exit` itself.
export const exitDeps = {
  exit: (code: number): never => process.exit(code),
};

// Thin wrapper around exitDeps.exit so call sites don't need to know about
// the swap point.
export function exit(code: number): never {
  return exitDeps.exit(code);
}

// GlotValidationError -> 2, GlotRuntimeError -> 1 — see core/errors.ts for the rationale.
export function handleError(err: unknown, debug = false): never {
  let message = err instanceof Error ? err.message : String(err);
  if (debug && err instanceof GlotRuntimeError && err.detail) {
    message = `${message} (${err.detail})`;
  }
  process.stderr.write(`Error: ${message}\n`);
  exit(err instanceof GlotValidationError ? 2 : 1);
}
