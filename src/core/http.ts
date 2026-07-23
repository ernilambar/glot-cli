import { VERSION } from "./config.ts";

export interface HttpGetResult {
  body: string;
  ok: boolean;
}

// Only treats HTTP 200 as ok, absolute http(s) URLs only. Not part of
// `deps` — tests cover locale validation around these call sites, not
// the network path itself.
export async function httpGet(url: string): Promise<HttpGetResult> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { body: "", ok: false };
  }
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": `glot-cli/${VERSION}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status !== 200) {
      return { body: "", ok: false };
    }
    return { body: await response.text(), ok: true };
  } catch {
    return { body: "", ok: false };
  }
}
