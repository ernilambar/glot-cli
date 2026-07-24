import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

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

export function createApiServer(token: string): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (!isAuthorized(req, token)) {
      sendProblem(res, 401, "Unauthorized", "missing or invalid bearer token");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    sendProblem(res, 404, "Not Found", `no route for ${req.method} ${url.pathname}`);
  });
}
