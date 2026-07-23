// Bad args/input — missing env vars, file not found, invalid PO file, negative
// --limit, invalid --format, invalid locale, missing locale. CLI maps this to
// exit code 2.
export class GlotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlotValidationError";
  }
}

// I/O or AI failures — unwritable file, AI endpoint errors. CLI maps this to
// exit code 1.
export class GlotRuntimeError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "GlotRuntimeError";
    this.detail = detail;
  }
}
