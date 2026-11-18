/**
 * dblp.ts — DBLP provider (CS-only, no abstracts, CC0 metadata).
 *
 * FIX applied: keeps the bot-challenge retry loop, and the shared fetchJson
 * throws on exhausted 429/5xx retries — that is now caught and degraded
 * quietly (try/catch to a non-ok SourceResult) so a DBLP 429 never kills the
 * borrow run.
 */
import { type PaperItem, type SourceResult } from "./types";
import { USER_AGENT, fetchJson, throttle } from "./http";

export const DBLP_BASE = "https://dblp.org/search/publ/api";

export async function dblpSearch(
  query: string,
  maxResults: number,
  opts: { retries?: number } = {},
): Promise<SourceResult> {
  throttle("dblp", 1000);
  const maxRetries = opts.retries ?? 2;
  const mkUrl = () =>
    `${DBLP_BASE}?${new URLSearchParams({ q: query, format: "json", h: String(Math.max(1, Math.min(30, maxResults))), c: "0" })}`;
  // dblp fronts a bot-challenge interstitial that serves HTML instead of JSON.
  // One polite retry after a short backoff clears the challenge for the
  // session; a second failure degrades the leg with a clear note (never fatal).
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };
  let lastError = "unknown";
  const t0 = performance.now();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { data } = await fetchJson(mkUrl(), {
        headers,
        timeoutMs: 8_000,
      });
      const body = data as {
        result?: { hits?: { hit?: { info?: Record<string, unknown> }[] } };
      };
      const hits = body.result?.hits?.hit ?? [];
      const items = hits.map((h): PaperItem => {
        const info = h.info ?? {};
        const raw = (info.authors as { author?: unknown })?.author ?? [];
        const list = Array.isArray(raw) ? raw : [raw];
        return {
          title: (info.title as string) ?? null,
          authors: list
            .filter(
              (a): a is { text?: string } =>
                typeof a === "object" && a !== null,
            )
            .slice(0, 6)
            .map((a) => a.text ?? ""),
          venue: (info.venue as string) ?? null,
          year: Number(info.year ?? 0) || null,
          url: (info.url as string) ?? null,
          summary: "",
        };
      });
      return {
        ok: true,
        items,
        cost: "free",
        timingMs: performance.now() - t0,
        ranking: "relevance",
        retriesUsed: attempt,
      };
    } catch (err) {
      const message = String((err as Error).message ?? err);
      // A thrown 429/5xx from fetchJson is transient weather — degrade quietly.
      if (/HTTP 429|HTTP 5\d\d/i.test(message)) {
        return {
          ok: false,
          items: [],
          cost: "free",
          timingMs: performance.now() - t0,
          error: `dblp rate limited after ${attempt} retries: ${message}`,
        };
      }
      lastError = message;
      if (/HTML|Challenge/i.test(lastError) && attempt < maxRetries) {
        await Bun.sleep(1500 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  return {
    ok: false,
    items: [],
    cost: "free",
    timingMs: performance.now() - t0,
    error: `dblp challenge persisted after ${maxRetries} retries: ${lastError}`,
  };
}
