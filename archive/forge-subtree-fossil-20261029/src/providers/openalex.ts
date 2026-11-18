/**
 * openalex.ts — OpenAlex works provider (free, no auth, 250M+ works).
 *
 * The unblinded fallback when arXiv throttles. Exposes the work→item mapper,
 * the exact DOI lookup (used by --id mode), and abstract reconstruction from
 * OpenAlex's inverted index. Shape unchanged from the monolithic providers.ts.
 */
import { type PaperItem, type SourceResult } from "./types";
import { POLITE_MAILTO, USER_AGENT, fetchJson, throttle } from "./http";

export const OPENALEX_BASE = "https://api.openalex.org";

const failed = (error: unknown): SourceResult => ({
  ok: false,
  items: [],
  cost: "free",
  error: String((error as Error)?.message ?? error).slice(0, 160),
});

/** Reconstruct abstract text from OpenAlex's inverted index. */
export function abstractFromInvertedIndex(
  inv: Record<string, number[]> | null | undefined,
): string {
  if (!inv) return "";
  const positions: [number, string][] = [];
  for (const [word, idxs] of Object.entries(inv))
    for (const i of idxs) positions.push([i, word]);
  positions.sort((a, b) => a[0] - b[0]);
  return positions
    .map(([, w]) => w)
    .join(" ")
    .slice(0, 600);
}

/** Surface a real arXiv id so dedupe across legs works instead of title-matching. */
export function arxivIdFrom(
  ids: Record<string, string> | null | undefined,
): string | null {
  const m = /arxiv\.org\/(?:abs|pdf)\/([^\s"'<>]+)/.exec(ids?.arxiv ?? "");
  return m ? m[1]! : null;
}

const OA_SELECT =
  "id,doi,ids,title,publication_year,authorships,abstract_inverted_index,cited_by_count,primary_location";

type OaWork = {
  id?: string;
  doi?: string | null;
  ids?: Record<string, string>;
  title?: string | null;
  publication_year?: number | null;
  authorships?: { author?: { display_name?: string } }[];
  abstract_inverted_index?: Record<string, number[]> | null;
  cited_by_count?: number | null;
  primary_location?: { source?: { display_name?: string } | null } | null;
};

export type { OaWork };

export function openAlexWorkToItem(w: OaWork): PaperItem {
  const doi = w.doi ?? null;
  return {
    title: w.title ?? null,
    authors: (w.authorships ?? [])
      .slice(0, 6)
      .map((a) => a.author?.display_name ?? "")
      .filter(Boolean),
    year: w.publication_year ?? null,
    citedByCount: w.cited_by_count ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    arxivId: arxivIdFrom(w.ids),
    doi: (doi ?? "").replace("https://doi.org/", "") || null,
    url: doi ?? w.id ?? null,
    openAlexId: w.id ?? null,
    summary: abstractFromInvertedIndex(w.abstract_inverted_index),
  };
}

/** OpenAlex: 250M+ works incl. arXiv content. The unblinded fallback when arXiv throttles. */
export async function openAlexSearch(
  query: string,
  maxResults: number,
): Promise<SourceResult> {
  throttle("openalex", 1000);
  const url = `${OPENALEX_BASE}/works?${new URLSearchParams({
    search: query,
    "per-page": String(Math.max(1, Math.min(25, maxResults))),
    mailto: POLITE_MAILTO,
    select: OA_SELECT,
  })}`;
  const { data, ms } = await fetchJson(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  const body = data as { results?: OaWork[] };
  return {
    ok: true,
    items: (body.results ?? []).map(openAlexWorkToItem),
    cost: "free",
    ranking: "relevance",
    timingMs: ms,
    note: "covers arXiv + journals + preprints",
  };
}

/** Exact DOI lookup, not a search — the right call for --id mode. */
export async function openAlexLookupDoi(doi: string): Promise<SourceResult> {
  throttle("openalex", 1000);
  const bare = doi.trim().replace(/^doi:/i, "");
  const url = `${OPENALEX_BASE}/works/doi:${encodeURIComponent(bare)}?${new URLSearchParams({ mailto: POLITE_MAILTO, select: OA_SELECT })}`;
  try {
    const { data, ms } = await fetchJson(url, {
      headers: { "User-Agent": USER_AGENT },
      timeoutMs: 10_000,
    });
    const work = data as OaWork;
    if (!work.id)
      return { ok: false, items: [], cost: "free", error: "not found" };
    return {
      ok: true,
      items: [openAlexWorkToItem(work)],
      cost: "free",
      timingMs: ms,
      note: "exact DOI lookup",
    };
  } catch (e) {
    return failed(e);
  }
}
