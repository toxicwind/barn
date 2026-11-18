/**
 * web.ts — web-search providers (brave / serper / tavily).
 *
 * All three are paid-keyed web sources; each takes apiKey as a parameter and
 * degrades quietly (non-ok SourceResult) on failure. Shapes match the
 * monolithic providers.ts exactly.
 */
import { type PaperItem, type SourceResult } from "./types";

/** Brave Search — free/resilient web source. Verified live: HTTP 200 + web.results[] (key from secretsmith). */
export async function braveSearch(
  query: string,
  maxResults: number,
  apiKey = "",
): Promise<SourceResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(maxResults) })}`,
      {
        headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const data = (await res.json()) as {
      web?: { results?: Record<string, unknown>[] };
    };
    const items: PaperItem[] = (data.web?.results ?? []).map((it) => ({
      title: (it.title as string) ?? null,
      authors: [],
      venue: "brave",
      url: (it.url as string) ?? null,
      summary: String(
        (it.description as string) ??
          (it.profile?.longDescription as string) ??
          "",
      ).slice(0, 500),
    }));
    return {
      ok: true,
      items,
      cost: "free",
      totalCount: items.length,
      timingMs: Math.round(performance.now() - t0),
      ranking: "brave-web",
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      cost: "free",
      error: `brave: ${(e as Error).message ?? e}`,
    };
  }
}

/** SERPER — Google results via google.serper.dev. Verified live: organic[].title/link/snippet. Free/resilient. */
export async function serperSearch(
  query: string,
  maxResults: number,
  apiKey = "",
): Promise<SourceResult> {
  const t0 = performance.now();
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { organic?: Record<string, unknown>[] };
    const items: PaperItem[] = (data.organic ?? []).map((it) => ({
      title: (it.title as string) ?? null,
      authors: [],
      venue: "google",
      url: (it.link as string) ?? null,
      summary: String((it.snippet as string) ?? "").slice(0, 500),
    }));
    return {
      ok: true,
      items,
      cost: "free",
      totalCount: items.length,
      timingMs: Math.round(performance.now() - t0),
      ranking: "google-organic",
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      cost: "free",
      error: `serper: ${(e as Error).message ?? e}`,
    };
  }
}

/** Tavily — RAG web search. Verified live: results[].url. Free/resilient. */
export async function tavilySearch(
  query: string,
  maxResults: number,
  apiKey = "",
): Promise<SourceResult> {
  const t0 = performance.now();
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { results?: Record<string, unknown>[] };
    const items: PaperItem[] = (data.results ?? []).map((it) => ({
      title: (it.title as string) ?? null,
      authors: [],
      venue: "web",
      url: (it.url as string) ?? null,
      summary: String((it.content as string) ?? "").slice(0, 500),
    }));
    return {
      ok: true,
      items,
      cost: "free",
      totalCount: items.length,
      timingMs: Math.round(performance.now() - t0),
      ranking: "tavily",
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      cost: "free",
      error: `tavily: ${(e as Error).message ?? e}`,
    };
  }
}
