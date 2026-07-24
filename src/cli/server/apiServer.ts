import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { GlotConfig } from "../../core/config.ts";
import { deps } from "../../core/deps.ts";
import { GlotValidationError } from "../../core/errors.ts";
import { buildGlossaryIndex, loadGlossary, matchingGlossaryTerms } from "../../core/glossary.ts";
import { validateLang } from "../../core/languages.ts";
import { runCoreList } from "../../core/operations/corePull.ts";
import type { CoreListResult } from "../../core/operations/corePull.ts";
import { runGlossaryList } from "../../core/operations/glossaryPull.ts";
import type { GlossaryListResult } from "../../core/operations/glossaryPull.ts";
import { findCoreMatches } from "../../core/operations/serveEditor.ts";

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
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    if (!isAuthorized(req, token)) {
      sendProblem(res, 401, "Unauthorized", "missing or invalid bearer token");
      return;
    }

    try {
      if (req.method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "ping") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "languages") {
        sendJson(res, 200, deps.loadValidLanguages());
        return;
      }

      if (req.method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "glossary") {
        sendJson(res, 200, flattenList(runGlossaryList(config)));
        return;
      }

      if (req.method === "GET" && segments.length === 3 && segments[0] === "api" && segments[1] === "glossary") {
        const lang = segments[2]!;
        validateLang(lang, deps.loadValidLanguages());
        sendJson(res, 200, loadGlossary(config.glossaryDir, lang));
        return;
      }

      if (
        req.method === "GET" &&
        segments.length === 4 &&
        segments[0] === "api" &&
        segments[1] === "glossary" &&
        segments[3] === "match"
      ) {
        const lang = segments[2]!;
        validateLang(lang, deps.loadValidLanguages());
        const text = url.searchParams.get("text") ?? "";
        const glossary = loadGlossary(config.glossaryDir, lang);
        const glossaryIdx = buildGlossaryIndex(glossary);
        sendJson(res, 200, matchingGlossaryTerms(text, glossary, glossaryIdx));
        return;
      }

      if (req.method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "core") {
        sendJson(res, 200, flattenList(runCoreList(config)));
        return;
      }

      if (req.method === "GET" && segments.length === 3 && segments[0] === "api" && segments[1] === "core") {
        const lang = segments[2]!;
        validateLang(lang, deps.loadValidLanguages());
        const msgid = url.searchParams.get("msgid") ?? "";
        const core = deps.loadCoreTranslations(config, lang);
        sendJson(res, 200, findCoreMatches(core, msgid));
        return;
      }

      sendProblem(res, 404, "Not Found", `no route for ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof GlotValidationError) {
        sendProblem(res, 400, "Bad Request", err.message);
        return;
      }
      sendProblem(res, 500, "Internal Server Error", err instanceof Error ? err.message : String(err));
    }
  });
}
