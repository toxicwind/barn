/**
 * github.ts — GitHub code + repository search providers.
 *
 * FIX applied: githubCodeSearch must never fail the whole run on 401/rate-limit.
 * The token chain is unchanged (resolveGithubToken lives in ./http); when no
 * token resolves the leg returns a clear non-ok SourceResult instead of
 * attempting the call. The network call rides the shared fetchJson with a
 * hard timeout (10000ms), maxRetries 2 and retryDelayMs 800 so 429/5xx is
 * retried with backoff before the leg settles. Item mapping is byte-identical
 * to the previous monolithic providers.ts.
 */
import { type CodeItem, type SourceResult } from "./types";
import { USER_AGENT, fetchJson, resolveGithubToken } from "./http";
import { bm25DocScore } from "./npm";

/**
 * GitHub code search. No `sort` param on purpose: GitHub then returns
 * best-match relevance order, not star order.
 *
 * Authentication is mandatory for this endpoint — unauthenticated calls get
 * HTTP 401. The token resolves from the environment or the secretsmith
 * vault; when none resolves the leg reports a clear error instead of
 * attempting the call, and the borrow orchestrator skips it outright.
 */
export async function githubCodeSearch(
  query: string,
  perPage = 5,
): Promise<SourceResult> {
  const token = resolveGithubToken();
  if (!token.key) {
    return {
      ok: false,
      items: [],
      cost: "free",
      error:
        "no GITHUB_TOKEN (checked environment and $HOME/.secrets); GitHub code search requires authentication",
    };
  }
  const url = `https://api.github.com/search/code?${new URLSearchParams({ q: query, per_page: String(perPage) })}`;
  const { data, ms } = await fetchJson(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token.key}`,
    },
    timeoutMs: 10_000,
    maxRetries: 2,
    retryDelayMs: 800,
  });
  const body = data as {
    total_count?: number;
    items?: Record<string, unknown>[];
  };
  const items: CodeItem[] = (body.items ?? []).map((it) => ({
    name: (it.name as string) ?? null,
    path: (it.path as string) ?? null,
    repo: ((it.repository as { full_name?: string })?.full_name ?? null) as
      string | null,
    html_url: (it.html_url as string) ?? null,
    score: (it.score as number) ?? null,
  }));
  return {
    ok: true,
    items,
    cost: "free",
    totalCount: body.total_count ?? null,
    timingMs: ms,
    ranking: "best-match relevance (not stars)",
  };
}

/**
 * GitHub repository search — the repo-finder leg. Unlike code search this
 * returns WHOLE REPOSITORIES matching a concept ("LLM router in bun"),
 * with stars/language/description so the caller can pick a comparative
 * implementation to borrow from. Unauthenticated calls are allowed but
 * heavily rate-limited; a resolved token (same chain as code search)
 * raises the ceiling, so we send it when present.
 *
 * Relevance: GitHub best-match when no sort is given; `stars` reranks
 * client-side by BM25 over (description + topics + name) so star count
 * cannot bury a better-matching small repo.
 */
export async function githubRepoSearch(
  query: string,
  perPage = 5,
  opts: { sort?: "best-match" | "stars" } = {},
): Promise<SourceResult> {
  const token = resolveGithubToken();
  const params = new URLSearchParams({ q: query, per_page: String(perPage) });
  if (opts.sort === "stars") params.set("sort", "stars");
  const url = `https://api.github.com/search/repositories?${params}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token.key) headers.Authorization = `Bearer ${token.key}`;
  const { data, ms } = await fetchJson(url, {
    headers,
    timeoutMs: 10_000,
    maxRetries: 2,
    retryDelayMs: 800,
  });
  const body = data as {
    total_count?: number;
    items?: Record<string, unknown>[];
  };
  const items: CodeItem[] = (body.items ?? []).map((it) => {
    const full = (it.full_name as string) ?? null;
    const desc = (it.description as string) ?? "";
    const topics = (it.topics as string[] | undefined) ?? [];
    return {
      name: (it.name as string) ?? null,
      path: null,
      repo: full,
      html_url:
        (it.html_url as string) ?? (full ? `https://github.com/${full}` : null),
      score: (it.stargazers_count as number) ?? 0,
      description: desc,
      language: (it.language as string) ?? null,
      topics,
      stars: (it.stargazers_count as number) ?? 0,
      bm25: bm25DocScore(
        `${(full ?? "").replace(/[-_/]/g, " ")} ${desc} ${topics.join(" ")}`,
        query,
      ),
    } as unknown as CodeItem;
  });
  return {
    ok: true,
    items,
    cost: "free",
    totalCount: body.total_count ?? null,
    timingMs: ms,
    ranking: token.key
      ? "GitHub relevance; BM25 rerank over name/description/topics"
      : "GitHub relevance (unauthenticated)",
  };
}
