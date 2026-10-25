/**
 * types.ts — shared provider contracts for the borrow "find step".
 *
 * This is the modular home for the exact types that used to live in the
 * monolithic providers.ts / borrow.ts. Every provider module in ./exports
 * these; the registry in ./registry.ts maps each SourceName to a ProviderSpec
 * so the borrow orchestrator is table-driven rather than an if-chain.
 */

/** Every source the borrow orchestrator can race. */
export type SourceName =
  | "local"
  | "github"
  | "github_repos"
  | "npm"
  | "stackoverflow"
  | "arxiv"
  | "openalex"
  | "semanticscholar"
  | "dblp"
  | "hf_papers"
  | "exa"
  | "brave"
  | "serper"
  | "tavily";

export type PaperItem = {
  title: string | null;
  authors?: string[];
  year?: number | string | null;
  published?: string | null;
  venue?: string | null;
  citationCount?: number | null;
  citedByCount?: number | null;
  upvotes?: number | null;
  arxivId?: string | null;
  doi?: string | null;
  url?: string | null;
  pdfUrl?: string | null;
  summary?: string;
  openAlexId?: string | null;
};

export type CodeItem = {
  name: string | null;
  path: string | null;
  repo: string | null;
  html_url: string | null;
  score: number | null;
  description?: string;
  language?: string | null;
  topics?: string[];
  stars?: number;
  bm25?: number;
};

export type SourceResult = {
  ok: boolean;
  items: (PaperItem | CodeItem)[];
  cost: "free" | "exa-credits";
  ranking?: string;
  note?: string;
  timingMs?: number;
  totalCount?: number | null;
  retries?: number;
  error?: string;
};

/** A resolved secret/token: the value plus where it came from (for logs). */
export type ResolvedKey = { key: string; from: string };

/** Cost class for the "paid" leg guard. */
export type SourceCost = "free" | "paid";

/**
 * Per-provider search surface. A provider module exports `search` conforming
 * to this (plus zero or more independent named helpers such as
 * openAlexWorkToItem / openAlexLookupDoi / githubRepoSearch).
 *
 * `ctx` carries what the orchestrator already resolved for this run so a
 * provider never resolves a key twice.
 */
export type ProviderSearch = (
  query: string,
  perSource: number,
  ctx?: { apiKey?: string },
) => Promise<SourceResult>;

/**
 * Declarative spec the registry maps each SourceName to. Keeps the
 * orchestration (borrow.ts) free of provider logic: enablement, per-leg
 * timeout, retry ceiling, and key requirement are all data here, so a
 * provider is fixed in ONE place.
 */
export type ProviderSpec = {
  name: SourceName;
  /** Human label for doctor/log output. */
  label: string;
  search: ProviderSearch;
  /** Hard per-leg cap the orchestrator applies (ms). Provider-internal timeouts
   * may be tighter, but the orchestrator never waits past this. */
  timeoutMs: number;
  /** Worker's own retry/backoff ceiling. */
  maxRetries: number;
  /** Must a key resolve before the leg even starts? */
  keyed: boolean;
  /** Resolver called once by the orchestrator; key passed via ctx.apiKey. */
  resolveKey?: () => ResolvedKey;
  /** Paid legs (exa) are constructed only when a key resolves, and are audited. */
  cost?: SourceCost;
  /** Free/keyless legs run unconditionally. */
  always?: boolean;
};
