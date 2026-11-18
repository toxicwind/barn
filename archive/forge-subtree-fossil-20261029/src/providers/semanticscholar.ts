/**
 * semanticscholar.ts — Semantic Scholar graph API provider (free anonymous tier).
 *
 * FIX applied: when the request 429s, fetchJson already retries/backs off then
 * throws — s2Search now wraps the call in a try/catch and returns a non-ok
 * SourceResult (degrade quietly) instead of letting the exception propagate and
 * kill the run. `resolveS2Key` and the `explicitKey` param are preserved.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type PaperItem, type SourceResult } from "./types";
import { USER_AGENT, fetchJson, throttle } from "./http";

export const S2_BASE = "https://api.semanticscholar.org";

type S2Paper = {
  title?: string | null;
  abstract?: string | null;
  authors?: { name?: string }[];
  year?: number | null;
  url?: string | null;
  openAccessPdf?: { url?: string } | null;
  citationCount?: number | null;
  externalIds?: Record<string, string>;
};

export type { S2Paper };

function s2ToItem(p: S2Paper): PaperItem {
  return {
    title: p.title ?? null,
    authors: (p.authors ?? []).slice(0, 6).map((a) => a.name ?? ""),
    year: p.year ?? null,
    citationCount: p.citationCount ?? null,
    arxivId: p.externalIds?.ArXiv ?? null,
    doi: p.externalIds?.DOI ?? null,
    url: p.url ?? null,
    pdfUrl: p.openAccessPdf?.url ?? null,
    summary: (p.abstract ?? "").slice(0, 600),
  };
}

/** Semantic Scholar key resolver: env first, then the secretsmith vault ($HOME/.secrets). */
export function resolveS2Key(explicit = ""): { key: string; from: string } {
  if (explicit) return { key: explicit, from: "explicit" };
  const env =
    process.env.S2_API_KEY || process.env.SEMANTIC_SCHOLAR_API_KEY || "";
  if (env) return { key: env, from: "environment" };
  try {
    const vault = readFileSync(join(homedir(), ".secrets"), "utf8");
    for (const line of vault.split("\n")) {
      const m =
        /^\s*(?:export\s+)?S2_API_KEY\s*=\s*\"?([^"\s]+)\"?/.exec(line) ||
        /^\s*(?:export\s+)?SEMANTIC_SCHOLAR_API_KEY\s*=\s*\"?([^"\s]+)\"?/.exec(
          line,
        );
      if (m?.[1]) return { key: m[1], from: "$HOME/.secrets" };
    }
  } catch {
    /* no vault */
  }
  return { key: "", from: "none" };
}

export async function s2Search(
  query: string,
  maxResults: number,
  explicitKey = "",
): Promise<SourceResult> {
  throttle("semanticscholar", 1000);
  const url = `${S2_BASE}/graph/v1/paper/search?${new URLSearchParams({
    query,
    limit: String(Math.max(1, Math.min(25, maxResults))),
    fields:
      "title,abstract,authors,year,url,openAccessPdf,citationCount,externalIds",
  })}`;
  const key = resolveS2Key(explicitKey);
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  // Authenticated key avoids the anonymous 429 ceiling entirely.
  if (key.key) headers["x-api-key"] = key.key;
  // FIX: fetchJson throws on exhausted 429/5xx retries — degrade quietly rather
  // than let the exception kill the whole borrow run.
  try {
    const { data, ms } = await fetchJson(url, {
      headers,
      timeoutMs: 8_000,
      maxRetries: 1,
    });
    const body = data as { data?: S2Paper[] };
    return {
      ok: true,
      items: (body.data ?? []).map(s2ToItem),
      cost: "free",
      ranking: key.key ? "relevance (authenticated)" : "relevance",
      timingMs: ms,
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      cost: "free",
      error: String((e as Error)?.message ?? e).slice(0, 160),
      retries: 1,
    };
  }
}
