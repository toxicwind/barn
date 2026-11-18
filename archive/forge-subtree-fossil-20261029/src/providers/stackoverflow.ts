/**
 * stackoverflow.ts — StackExchange API provider (free, no auth, 300 req/day).
 */
import { type PaperItem, type SourceResult } from "./types";
import { USER_AGENT, fetchJson } from "./http";

/** StackExchange API — developer Q&A prior art (free, no auth, 300 req/day). */
export async function stackoverflowSearch(
  query: string,
  perPage = 5,
): Promise<SourceResult> {
  const { data, ms } = await fetchJson(
    `https://api.stackexchange.com/2.3/search/advanced?${new URLSearchParams({
      q: query,
      order: "desc",
      sort: "relevance",
      site: "stackoverflow",
      pagesize: String(perPage),
      filter: "withbody",
    })}`,
    { headers: { "User-Agent": USER_AGENT }, timeoutMs: 8_000 },
  );
  const body = data as { items?: Record<string, unknown>[]; total?: number };
  const items: PaperItem[] = (body.items ?? []).map((it) => ({
    title: (it.title as string) ?? null,
    authors: [
      (it.owner as { display_name?: string })?.display_name ?? "",
    ].filter(Boolean),
    venue: "stackoverflow",
    year: it.creation_date
      ? new Date((it.creation_date as number) * 1000).getFullYear()
      : null,
    url: (it.link as string) ?? null,
    summary: String(
      (it.body_markdown as string) ?? (it.body as string) ?? "",
    ).slice(0, 500),
  }));
  return {
    ok: true,
    items,
    cost: "free",
    totalCount: body.total ?? null,
    timingMs: ms,
    ranking: "relevance+score",
  };
}
