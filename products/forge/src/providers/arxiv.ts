/**
 * arxiv.ts — arXiv Atom API provider (free, no auth).
 *
 * FIX applied: kept the 429/503 Retry-After backoff loop and the JSONL timing
 * audit. Timeout stays at 12000ms (opts.timeoutMs) and maxRetries at 3 so the
 * provider never hangs past the orchestrator cap; `opts` signature preserved.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type PaperItem, type SourceResult } from "./types";
import { SHINGLE_CACHE, USER_AGENT, throttle } from "./http";

export const ARXIV_BASE = "https://export.arxiv.org";

/** arXiv Atom, parsed without an XML dependency. Entries only — that is all we use. */
export function parseAtom(xml: string): PaperItem[] {
  const entries = xml.split("<entry>").slice(1);
  const tag = (entry: string, name: string): string => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
    return m ? decodeEntities(m[1]!.replace(/\s+/g, " ").trim()) : "";
  };
  return entries.map((entry) => ({
    title: tag(entry, "title"),
    authors: [
      ...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g),
    ].map((m) => decodeEntities(m[1]!.trim())),
    published: tag(entry, "published").slice(0, 10),
    url: tag(entry, "id") || null,
    summary: tag(entry, "summary").slice(0, 500),
  }));
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * arXiv: free, no auth, relevance-sorted. Throttles aggressively, so the
 * interval is enforced across invocations and 429/503 back off honouring
 * Retry-After. Every attempt lands in a JSONL timing audit.
 */
export async function arxivSearch(
  query: string,
  maxResults: number,
  opts: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<SourceResult> {
  const { timeoutMs = 12_000, maxRetries = 3 } = opts;
  const url = `${ARXIV_BASE}/api/query?${new URLSearchParams({
    search_query: `all:${query}`,
    start: "0",
    max_results: String(maxResults),
    sortBy: "relevance",
    sortOrder: "descending",
  })}`;
  throttle("arxiv", 3500);

  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
        auditArxiv({
          t_ms: performance.now() - t0,
          attempt,
          ok: false,
          status: res.status,
          query,
        });
        Bun.sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        auditArxiv({
          t_ms: performance.now() - t0,
          attempt,
          ok: false,
          status: res.status,
          query,
        });
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const xml = await res.text();
      const ms = performance.now() - t0;
      auditArxiv({ t_ms: ms, attempt, ok: true, status: 200, query });
      return {
        ok: true,
        items: parseAtom(xml),
        cost: "free",
        ranking: "relevance",
        timingMs: ms,
        retries: attempt,
      };
    } catch (e) {
      lastError = String((e as Error).message);
      auditArxiv({
        t_ms: performance.now() - t0,
        attempt,
        ok: false,
        status: 0,
        query,
        error: lastError,
      });
    }
  }
  return {
    ok: false,
    items: [],
    cost: "free",
    error: lastError || "arxiv exhausted retries",
  };
}

export type ArxivAudit = {
  t_ms: number;
  attempt: number;
  ok: boolean;
  status: number;
  query: string;
  error?: string;
};

/** Timing audit — shared budget visibility across every skill that hits arXiv. */
export function auditArxiv(record: ArxivAudit): void {
  try {
    mkdirSync(SHINGLE_CACHE, { recursive: true });
    appendFileSync(
      join(SHINGLE_CACHE, "arxiv_audit.jsonl"),
      `${JSON.stringify({ ts: Date.now() / 1000, ...record })}\n`,
      "utf8",
    );
  } catch {
    /* audit is best-effort */
  }
}
