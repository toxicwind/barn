/**
 * registry.ts — table-driven provider registry.
 *
 * Maps every SourceName to a ProviderSpec (timeout cap, retry ceiling, key
 * requirement, cost class) so the borrow orchestrator can be data-driven
 * instead of an if-chain. The `search` here adapts each provider's native
 * signature onto the ProviderSearch surface; ctx.apiKey is what the
 * orchestrator pre-resolved for keyed legs (never resolve a key twice).
 */
import { type ProviderSpec, type SourceName, type SourceResult } from "./types";
import { resolveGithubToken, resolveKey } from "./http";
import { resolveExaKey, exaSearch } from "./exa";
import { githubCodeSearch, githubRepoSearch } from "./github";
import { arxivSearch } from "./arxiv";
import { openAlexSearch } from "./openalex";
import { s2Search } from "./semanticscholar";
import { dblpSearch } from "./dblp";
import { npmSearch } from "./npm";
import { stackoverflowSearch } from "./stackoverflow";
import { hfPapersSearch } from "./hf_papers";
import { braveSearch, serperSearch, tavilySearch } from "./web";
import { localTreeSearch } from "./local";

type Ctx = { apiKey?: string };
const nctx = (ctx?: Ctx) => ctx?.apiKey ?? "";

export const PROVIDERS: Record<SourceName, ProviderSpec> = {
  local: {
    name: "local",
    label: "local AST-BM25",
    search: (q, n) => localTreeSearch(q, n) as Promise<SourceResult>,
    timeoutMs: 4000,
    maxRetries: 0,
    keyed: false,
    always: true,
  },
  github: {
    name: "github",
    label: "GitHub code search",
    search: (q, n) => githubCodeSearch(q, n),
    timeoutMs: 10000,
    maxRetries: 2,
    keyed: true,
    resolveKey: resolveGithubToken,
  },
  github_repos: {
    name: "github_repos",
    label: "GitHub repository search",
    search: (q, n) => githubRepoSearch(q, n) as Promise<SourceResult>,
    timeoutMs: 10000,
    maxRetries: 2,
    keyed: true,
    resolveKey: resolveGithubToken,
  },
  npm: {
    name: "npm",
    label: "npm registry",
    search: (q, n) => npmSearch(q, n),
    timeoutMs: 6000,
    maxRetries: 0,
    keyed: false,
    always: true,
  },
  stackoverflow: {
    name: "stackoverflow",
    label: "StackOverflow",
    search: (q, n) => stackoverflowSearch(q, n),
    timeoutMs: 6000,
    maxRetries: 0,
    keyed: false,
    always: true,
  },
  arxiv: {
    name: "arxiv",
    label: "arXiv",
    search: (q, n) => arxivSearch(q, n),
    timeoutMs: 10000,
    maxRetries: 3,
    keyed: false,
    always: true,
  },
  openalex: {
    name: "openalex",
    label: "OpenAlex",
    search: (q, n) => openAlexSearch(q, n),
    timeoutMs: 8000,
    maxRetries: 0,
    keyed: false,
    always: true,
  },
  semanticscholar: {
    name: "semanticscholar",
    label: "Semantic Scholar",
    search: (q, n, ctx) => s2Search(q, n, nctx(ctx)),
    timeoutMs: 8000,
    maxRetries: 1,
    keyed: true,
    resolveKey: () => resolveKey("s2"),
  },
  dblp: {
    name: "dblp",
    label: "DBLP",
    search: (q, n) => dblpSearch(q, n),
    timeoutMs: 8000,
    maxRetries: 2,
    keyed: false,
    always: true,
  },
  hf_papers: {
    name: "hf_papers",
    label: "Hugging Face Papers",
    search: (q, n) => hfPapersSearch(q, n),
    timeoutMs: 8000,
    maxRetries: 0,
    keyed: false,
    always: true,
  },
  brave: {
    name: "brave",
    label: "Brave Search",
    search: (q, n, ctx) => braveSearch(q, n, nctx(ctx)),
    timeoutMs: 8000,
    maxRetries: 0,
    keyed: true,
    resolveKey: () => resolveKey("brave"),
  },
  serper: {
    name: "serper",
    label: "SERPER (Google)",
    search: (q, n, ctx) => serperSearch(q, n, nctx(ctx)),
    timeoutMs: 8000,
    maxRetries: 0,
    keyed: true,
    resolveKey: () => resolveKey("serper"),
  },
  tavily: {
    name: "tavily",
    label: "Tavily",
    search: (q, n, ctx) => tavilySearch(q, n, nctx(ctx)),
    timeoutMs: 8000,
    maxRetries: 0,
    keyed: true,
    resolveKey: () => resolveKey("tavily"),
  },
  exa: {
    name: "exa",
    label: "Exa (credits)",
    search: (q, n, ctx) => exaSearch(q, n, nctx(ctx)),
    timeoutMs: 12000,
    maxRetries: 0,
    keyed: true,
    resolveKey: resolveExaKey,
    cost: "paid",
  },
};
