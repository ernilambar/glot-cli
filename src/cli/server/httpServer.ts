import { copyFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { basename } from "node:path";
import type { GlotConfig } from "../../core/config.ts";
import { deps } from "../../core/deps.ts";
import { applyEditorEdits, buildEditorView, findCoreMatches, translateSingle } from "../../core/operations/serveEditor.ts";
import { detectPluralCount } from "../../core/po/entry.ts";
import { PoFile } from "../../core/po/poFile.ts";
import { renderPage } from "./template.ts";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function renderIndex(config: GlotConfig, input: string, lang: string, glotEnabled: boolean, message?: string): string {
  const pf = PoFile.parseFile(input);
  const rows = buildEditorView(pf);
  const nplurals = detectPluralCount(pf.entries);

  if (lang !== "") {
    const core = deps.loadCoreTranslations(config, lang);
    for (const row of rows) {
      if (row.entry.msgIdPlural === "") {
        row.coreMatches = findCoreMatches(core, row.entry.msgId);
      }
    }
  }

  return renderPage(rows, { filename: basename(input), nplurals, glotEnabled, message });
}

export function createEditorServer(config: GlotConfig, input: string, lang: string): Server {
  const glotEnabled = config.endpointUrl !== "" && config.modelId !== "" && lang !== "";

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "GET" && url.pathname === "/") {
        const message = url.searchParams.has("saved")
          ? `Saved ${basename(input)} (previous version backed up as ${basename(input)}.bak)`
          : undefined;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderIndex(config, input, lang, glotEnabled, message));
        return;
      }

      if (req.method === "POST" && url.pathname === "/save") {
        const body = await readBody(req);
        const posted: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(body)) {
          posted[key] = value;
        }
        const pf = PoFile.parseFile(input);
        const rows = buildEditorView(pf);
        applyEditorEdits(rows, posted);
        copyFileSync(input, `${input}.bak`);
        pf.save(input);
        res.writeHead(302, { Location: "/?saved=1" });
        res.end();
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/translate") {
        const body = await readBody(req);
        let parsed: { msgid?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }

        const msgId = typeof parsed.msgid === "string" ? parsed.msgid : "";
        if (msgId === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "msgid is required" }));
          return;
        }
        if (lang === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "lang is required — pass --lang or set GLOT_LANG" }));
          return;
        }

        try {
          const result = await translateSingle(config, msgId, lang);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
}
