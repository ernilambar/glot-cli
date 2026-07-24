import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { GlotConfig } from "../../core/config.ts";
import { deps } from "../../core/deps.ts";
import { GlotNotFoundError, GlotValidationError } from "../../core/errors.ts";
import { buildGlossaryIndex, loadGlossary, matchingGlossaryTerms } from "../../core/glossary.ts";
import { validateLang } from "../../core/languages.ts";
import { runApiTranslate } from "../../core/operations/apiTranslate.ts";
import type { ApiTranslateInput, TranslateMode } from "../../core/operations/apiTranslate.ts";
import { runCoreList } from "../../core/operations/corePull.ts";
import type { CoreListResult } from "../../core/operations/corePull.ts";
import { runGlossaryList } from "../../core/operations/glossaryPull.ts";
import type { GlossaryListResult } from "../../core/operations/glossaryPull.ts";
import { findCoreMatches } from "../../core/operations/serveEditor.ts";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const TRANSLATE_MODES: readonly TranslateMode[] = ["cache", "cache-then-ai", "ai"];

function parseTranslateBody(raw: string): ApiTranslateInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GlotValidationError("invalid JSON body");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new GlotValidationError("invalid JSON body");
  }
  const body = parsed as Record<string, unknown>;

  const msgId = typeof body.msgid === "string" ? body.msgid : "";
  if (msgId === "") {
    throw new GlotValidationError("msgid is required");
  }

  const lang = typeof body.lang === "string" ? body.lang : "";
  if (lang === "") {
    throw new GlotValidationError("lang is required");
  }

  const msgCtxt = typeof body.msgctxt === "string" ? body.msgctxt : "";

  let mode: TranslateMode = "cache-then-ai";
  if (body.mode !== undefined) {
    if (typeof body.mode !== "string" || !TRANSLATE_MODES.includes(body.mode as TranslateMode)) {
      throw new GlotValidationError(`invalid mode '${String(body.mode)}'`);
    }
    mode = body.mode as TranslateMode;
  }

  const msgIdPlural = typeof body.msgid_plural === "string" && body.msgid_plural !== "" ? body.msgid_plural : undefined;

  let nplurals: number | undefined;
  if (msgIdPlural !== undefined) {
    if (typeof body.nplurals !== "number" || !Number.isInteger(body.nplurals) || body.nplurals < 1) {
      throw new GlotValidationError("nplurals is required when msgid_plural is present");
    }
    nplurals = body.nplurals;
  }

  return { msgId, msgCtxt, lang, mode, msgIdPlural, nplurals };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendProblem(res: ServerResponse, status: number, title: string, detail?: string): void {
  res.writeHead(status, { "Content-Type": "application/problem+json" });
  res.end(JSON.stringify(detail === undefined ? { title, status } : { title, status, detail }));
}

// crypto.timingSafeEqual throws on length mismatch, so the length check must
// happen first — a plain === would leak timing information about how much
// of the token prefix matched.
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// runGlossaryList/runCoreList return a 3-way outcome (dirNotFound/empty/listed)
// the CLI uses to print different messages; the API only needs "is there
// anything," so all three collapse to [] or the items array.
function flattenList(result: GlossaryListResult | CoreListResult): unknown[] {
  return result.outcome === "listed" ? result.items : [];
}

export function createApiServer(config: GlotConfig, token: string): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    // All routes live under /api/v1 — anything else falls through to 404.
    const route = segments[0] === "api" && segments[1] === "v1" ? segments.slice(2) : [];

    if (!isAuthorized(req, token)) {
      sendProblem(res, 401, "Unauthorized", "missing or invalid bearer token");
      return;
    }

    try {
      if (req.method === "GET" && route.length === 1 && route[0] === "ping") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "GET" && route.length === 1 && route[0] === "languages") {
        sendJson(res, 200, deps.loadValidLanguages());
        return;
      }

      if (req.method === "GET" && route.length === 1 && route[0] === "glossary") {
        sendJson(res, 200, flattenList(runGlossaryList(config)));
        return;
      }

      if (req.method === "GET" && route.length === 2 && route[0] === "glossary") {
        const lang = route[1]!;
        validateLang(lang, deps.loadValidLanguages());
        sendJson(res, 200, loadGlossary(config.glossaryDir, lang));
        return;
      }

      if (req.method === "GET" && route.length === 3 && route[0] === "glossary" && route[2] === "match") {
        const lang = route[1]!;
        validateLang(lang, deps.loadValidLanguages());
        const text = url.searchParams.get("text") ?? "";
        const glossary = loadGlossary(config.glossaryDir, lang);
        const glossaryIdx = buildGlossaryIndex(glossary);
        sendJson(res, 200, matchingGlossaryTerms(text, glossary, glossaryIdx));
        return;
      }

      if (req.method === "GET" && route.length === 1 && route[0] === "core") {
        sendJson(res, 200, flattenList(runCoreList(config)));
        return;
      }

      if (req.method === "GET" && route.length === 2 && route[0] === "core") {
        const lang = route[1]!;
        validateLang(lang, deps.loadValidLanguages());
        const msgid = url.searchParams.get("msgid") ?? "";
        const core = deps.loadCoreTranslations(config, lang);
        sendJson(res, 200, findCoreMatches(core, msgid));
        return;
      }

      if (req.method === "POST" && route.length === 1 && route[0] === "translate") {
        const input = parseTranslateBody(await readBody(req));
        const result = await runApiTranslate(config, input);
        sendJson(
          res,
          200,
          result.kind === "plural"
            ? { translations: result.translations, source: result.source }
            : { translation: result.translation, source: result.source },
        );
        return;
      }

      sendProblem(res, 404, "Not Found", `no route for ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof GlotValidationError) {
        sendProblem(res, 400, "Bad Request", err.message);
        return;
      }
      if (err instanceof GlotNotFoundError) {
        sendProblem(res, 404, "Not Found", err.message);
        return;
      }
      sendProblem(res, 500, "Internal Server Error", err instanceof Error ? err.message : String(err));
    }
  });
}
