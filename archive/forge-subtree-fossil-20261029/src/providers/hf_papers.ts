/**
 * hf_papers.ts — Hugging Face Papers provider (free, no token).
 *
 * Hybrid semantic + keyword over arXiv-indexed AI/ML.
 */
import { type PaperItem, type SourceResult } from "./types";
import { USER_AGENT, fetchJson, throttle } from "./http";

export const HF_PAPERS_BASE = "https://huggingface.co/api/papers/search";

export async function hfPapersSearch(
  query: string,
  maxResults: number,
): Promise<SourceResult> {
  throttle("hf_papers", 1000);
  const url = `${HF_PAPERS_BASE}?${new URLSearchParams({ q: query })}`;
  const { data, ms } = await fetchJson(url, {
    headers: { "User-Agent": USER_AGENT },
    timeoutMs: 8_000,
  });
  const raw = Array.isArray(data)
    ? data
    : ((data as { papers?: unknown[]; results?: unknown[] }).papers ??
      (data as { results?: unknown[] }).results ??
      []);
  const items = (raw as Record<string, unknown>[])
    .filter(
      (p): p is Record<string, unknown> => typeof p === "object" && p !== null,
    )
    .slice(0, maxResults)
    .map((p): PaperItem => ({
      title: (p.title as string) ?? null,
      authors: ((p.authors as unknown[]) ?? [])
        .slice(0, 6)
        .map((a) =>
          typeof a === "object" && a !== null
            ? ((a as { name?: string }).name ?? "")
            : String(a),
        ),
      published:
        (p.publishedAt as string) ?? (p.published_at as string) ?? null,
      arxivId: (p.id as string) ?? null,
      url: p.id ? `https://huggingface.co/papers/${String(p.id)}` : null,
      summary: ((p.summary as string) ?? (p.abstract as string) ?? "").slice(
        0,
        600,
      ),
      upvotes: (p.upvotes as number) ?? null,
    }));
  return {
    ok: true,
    items,
    cost: "free",
    ranking: "relevance",
    timingMs: ms,
    note: "HF paper search, AI/ML focused",
  };
}
