import type { GlotConfig } from "./config.ts";
import { GlotRuntimeError } from "./errors.ts";

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

// Ported 1:1 from main.go's defaultCallAI: a plain POST to the full
// GLOT_ENDPOINT_URL (not a "base URL" — the openai SDK's baseURL would
// double-append /chat/completions onto what users already configure as the
// complete endpoint, per README.md), 3-attempt retry on HTTP 429 with a
// 1<<attempt second backoff, and the same friendly-vs-debug error mapping.
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

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey !== "") {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  let lastError: GlotRuntimeError | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(config.endpointUrl, {
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
      lastError = new GlotRuntimeError(
        "AI endpoint is rate-limiting requests — try again later or lower GLOT_CONCURRENCY",
      );
      await sleep((1 << attempt) * 1000);
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      const buf = (await response.text()).slice(0, 500);
      const detail = `HTTP ${response.status}: ${buf.trim()}`;
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
          friendly = "AI endpoint rejected the request — check GLOT_MODEL_ID";
          break;
        default:
          friendly = `AI endpoint returned an error (HTTP ${response.status})`;
      }
      throw new GlotRuntimeError(friendly, detail);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      throw new GlotRuntimeError(
        "AI returned an unexpected response",
        err instanceof Error ? err.message : String(err),
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
