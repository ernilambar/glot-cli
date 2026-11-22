import { randomUUID } from "node:crypto";
import { VERSION, type GlotConfig } from "./config.ts";
import { GlotRuntimeError } from "./errors.ts";

// OpenCode Go requires a stable per-conversation routing id. One glot
// process is one conversation: every batch shares the same system prompt,
// so a stable id also preserves prompt-cache locality across calls. Only
// send it to OpenCode so unrelated OpenAI-compatible backends never see a
// nonstandard header.
const OPENCODE_SESSION = `ses_${randomUUID().replaceAll("-", "")}`;

function isOpenCodeEndpoint(endpointUrl: string): boolean {
  try {
    const host = new URL(endpointUrl).hostname.toLowerCase();
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

// Provider error bodies vary: OpenAI/Anthropic use { error: { message } },
// some gateways use { error: "..." } or { message: "..." }, and plain-text
// failures have no envelope at all. Prefer the most specific string so the
// real reason reaches the user instead of only the generic guidance.
function providerErrorMessage(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim() !== "") {
      return parsed.message.trim();
    }
    if (typeof parsed.error === "string" && parsed.error.trim() !== "") {
      return parsed.error.trim();
    }
    if (parsed.error !== null && typeof parsed.error === "object") {
      const err = parsed.error as { message?: unknown; type?: unknown };
      if (typeof err.message === "string" && err.message.trim() !== "") {
        return err.message.trim();
      }
      if (typeof err.type === "string" && err.type.trim() !== "") {
        return err.type.trim();
      }
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CallAIResult {
  content: string;
  usage: UsageInfo | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GLOT_ENDPOINT_URL is a base URL (e.g. http://localhost:11434/v1) — the
// standard OpenAI-compatible convention. /chat/completions is appended here.
// 3-attempt retry on HTTP 429 with a 1<<attempt second backoff, and
// friendly-vs-debug error mapping on failure.
export async function callAI(
  config: GlotConfig,
  prompt: string,
  systemPrompt: string,
  temperature: number,
): Promise<CallAIResult> {
  const messages: { role: string; content: string }[] = [];
  if (systemPrompt !== "") {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const body = JSON.stringify({
    model: config.modelId,
    messages,
    temperature,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `glot-cli/${VERSION}`,
  };
  if (isOpenCodeEndpoint(config.endpointUrl)) {
    headers["x-opencode-session"] = OPENCODE_SESSION;
  }
  if (config.apiKey !== "") {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const url = `${config.endpointUrl.replace(/\/+$/, "")}/chat/completions`;

  let lastError: GlotRuntimeError | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: config.requestTimeout > 0 ? AbortSignal.timeout(config.requestTimeout * 1000) : undefined,
      });
    } catch (err) {
      throw new GlotRuntimeError(
        "could not reach AI endpoint — check GLOT_ENDPOINT_URL and your network connection",
        err instanceof Error ? err.message : String(err),
      );
    }

    if (response.status === 429) {
      const buf = (await response.text()).slice(0, 500);
      const providerMsg = providerErrorMessage(buf);
      lastError = new GlotRuntimeError(
        providerMsg
          ? `AI endpoint is rate-limiting requests — try again later or lower GLOT_CONCURRENCY: ${providerMsg}`
          : "AI endpoint is rate-limiting requests — try again later or lower GLOT_CONCURRENCY",
        `HTTP 429: ${buf.trim()}`,
      );
      await sleep((1 << attempt) * 1000);
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      const buf = (await response.text()).slice(0, 500);
      const detail = `HTTP ${response.status}: ${buf.trim()}`;
      const providerMsg = providerErrorMessage(buf);
      let friendly: string;
      switch (response.status) {
        case 401:
        case 403:
          friendly = "AI endpoint rejected the request — check GLOT_API_KEY";
          break;
        case 404:
          friendly = "AI endpoint not found — check GLOT_ENDPOINT_URL";
          break;
        case 400:
          friendly = /MissingSessionID|x-opencode-session/i.test(buf)
            ? "AI endpoint requires an OpenCode session header (x-opencode-session) — check that it reaches the endpoint"
            : "AI endpoint rejected the request — check GLOT_MODEL_ID";
          break;
        default:
          friendly = `AI endpoint returned an error (HTTP ${response.status})`;
      }
      if (providerMsg) {
        friendly = `${friendly}: ${providerMsg}`;
      }
      throw new GlotRuntimeError(friendly, detail);
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new GlotRuntimeError(
        "AI returned an unexpected response",
        `invalid JSON: ${err instanceof Error ? err.message : String(err)}; body: ${text.slice(0, 500).trim()}`,
      );
    }

    const parsed = data as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    if (!parsed.choices || parsed.choices.length === 0) {
      throw new GlotRuntimeError("AI returned an unexpected response", "no choices in response");
    }

    const content = (parsed.choices[0]?.message?.content ?? "").trim();
    const usage = parsed.usage
      ? {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          totalTokens: parsed.usage.total_tokens ?? 0,
        }
      : null;

    return { content, usage };
  }

  if (lastError) {
    throw lastError;
  }
  throw new GlotRuntimeError("exhausted retries");
}
