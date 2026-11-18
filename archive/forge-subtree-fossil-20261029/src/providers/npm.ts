/**
 * npm.ts — npm registry search provider (free, no auth).
 *
 * Also owns `bm25DocScore`, the shared one-doc BM25 relevance helper used by
 * the repo-finder leg (github.ts imports it from here) so it is not duplicated
 * across modules.
 */
import { tokenize } from "../bm25";
import { USER_AGENT, fetchJson } from "./http";
import { type CodeItem, type SourceResult } from "./types";

/**
 * One-doc BM25-style relevance for repo finder results: token-overlap
 * scoring between the repo text (name/description/topics) and the query.
 * Cheap on purpose — GitHub relevance remains the primary signal; this
 * only breaks ties between GitHub's order and our query intent.
 */
export function bm25DocScore(doc: string, query: string): number {
  const docT = new Set(tokenize(doc));
  const q = tokenize(query);
  if (docT.size === 0 || q.length === 0) return 0;
  let hits = 0;
  for (const t of q) if (docT.has(t)) hits++;
  return hits / q.length;
}

/** npm registry search — package/CLI prior art (free, no auth). */
export async function npmSearch(
  query: string,
  perPage = 5,
): Promise<SourceResult> {
  const { data, ms } = await fetchJson(
    `https://registry.npmjs.org/-/v1/search?${new URLSearchParams({ text: query, size: String(perPage) })}`,
    { headers: { "User-Agent": USER_AGENT }, timeoutMs: 10_000 },
  );
  const body = data as {
    objects?: { package: Record<string, unknown> }[];
    total?: number;
  };
  const items: CodeItem[] = (body.objects ?? []).map((o) => {
    const p = o.package ?? {};
    return {
      name: (p.name as string) ?? null,
      path: null,
      repo: (p.links as { repository?: string })?.repository ?? null,
      html_url: (p.links as { npm?: string })?.npm ?? null,
      score: (p.score as unknown as number) ?? null,
      description: (p.description as string) ?? "",
      language: "javascript",
      stars:
        (p.publisher ? 1 : 0, (p.version as string) ? undefined : undefined),
      bm25: bm25DocScore(
        `${(p.name as string) ?? ""} ${(p.description as string) ?? ""} ${((p.keywords as string[]) ?? []).join(" ")}`,
        query,
      ),
    } as unknown as CodeItem;
  });
  return {
    ok: true,
    items,
    cost: "free",
    totalCount: body.total ?? null,
    timingMs: ms,
    ranking: "npm search score",
  };
}
