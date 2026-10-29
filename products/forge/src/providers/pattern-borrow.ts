/**
 * pattern-borrow.ts — Modular 10-factor GitHub + in-tree (ffs grep) pattern ranker.
 *
 * Integrated into the code-patterns modular provider architecture (`src/providers/`):
 * reuses shared `resolveGithubToken`, `fetchJson`, and `USER_AGENT` from `./http`
 * and exposes `patternBorrow()` + `renderPatternBorrow()` to both `forge pattern-borrow`
 * (`src/cli.ts`), `src/borrow.ts`, and `estate/scripts/pattern-borrow.ts`.
 *
 * Factors:
 *   F1  newest          newest repo push among top matches
 *   F2  avgSize         matched-file size + modern-API token density
 *   F3  nRepos          distinct repos using the pattern (prevalence)
 *   F4  stars           total stargazers across top repos
 *   F5  issues          total open issues/PRs across top repos
 *   F6  testFrac        fraction of top repos with a test dir
 *   F7  forks           total forks (dependent/centrality proxy)
 *   F8  bugRel          lexical closeness to target bug/domain terms
 */
import { USER_AGENT, fetchJson, resolveGithubToken } from "./http";
import { ESTATE } from "../paths";

export const DEFAULT_PATTERNS = [
  "hot reload",
  "session restore",
  "jsonl session",
  "conversation reload",
  "fs.watch",
  "process reload",
  "resume session",
  "durable session",
];

export const DEFAULT_BUG_TERMS = [
  "reload",
  "watch",
  "hot",
  "session",
  "conversation",
  "restore",
  "resume",
  "plugin",
  "borrow",
  "race",
];

export const PATTERN_FACTORS = [
  "newest",
  "avgSize",
  "nRepos",
  "stars",
  "issues",
  "forks",
  "testFrac",
  "bugRel",
] as const;

export type PatternFactor = (typeof PATTERN_FACTORS)[number];
export type PatternWeights = Partial<Record<PatternFactor, number>>;

export const DEFAULT_PATTERN_WEIGHTS: PatternWeights = {
  newest: 0.1,
  avgSize: 0.1,
  nRepos: 0.12,
  stars: 0.14,
  issues: 0.12,
  forks: 0.08,
  testFrac: 0.06,
  bugRel: 0.28,
};

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "with", "via", "using", "how", "best",
  "in", "of", "to", "on", "at", "by", "from", "into", "code", "implement",
  "implementation", "pattern", "patterns", "example", "examples", "real",
  "world", "real-world", "github", "repo", "repos",
]);

export function toSearchTerms(positional: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of positional) {
    if (p.includes("-") && p.length <= 40 && !p.includes(" ")) {
      out.push(p);
      continue;
    }
    const words = p.split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
    if (words.length <= 2) {
      out.push(words.join(" ") || p);
    } else {
      out.push(words.slice(0, 4).join(" "));
    }
  }
  return [...new Set(out.filter(Boolean))].slice(0, 6);
}

export type PatternRepoMatch = {
  fullName: string;
  stars: number;
  issues: number;
  forks: number;
  pushed: number;
  hasTest: number;
  description: string;
  language: string;
  license: string;
  url: string;
  matchedFiles: string[];
  terms?: string[];
};

export type PatternTermRow = {
  term: string;
  nRepos: number;
  stars: number;
  issues: number;
  forks: number;
  newest: number;
  testFrac: number;
  avgSize: number;
  bugRel: number;
  score?: number;
  repos: PatternRepoMatch[];
  [k: string]: unknown;
};

export type PatternBorrowOptions = {
  patterns?: readonly string[];
  top?: number;
  perPage?: number;
  weights?: PatternWeights;
  estateRoot?: string;
  localOnly?: boolean;
};

export type PatternBorrowResult = {
  terms: string[];
  rows: PatternTermRow[];
  topRepos: PatternRepoMatch[];
  timingMs: number;
};

async function ghGet(path: string, token: string, params?: Record<string, string>): Promise<unknown> {
  if (!token) return null;
  let url = `https://api.github.com${path}`;
  if (params) url += `?${new URLSearchParams(params).toString()}`;
  try {
    const { data } = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeoutMs: 8_000,
      maxRetries: 1,
      retryDelayMs: 500,
    });
    return data;
  } catch {
    return null;
  }
}

export async function scanLocalCode(
  term: string,
  limit = 5,
  estateRoot = process.env.ESTATE ?? ESTATE,
): Promise<Array<{ file: string; line: string }>> {
  try {
    const proc = Bun.spawn(["ffs", "grep", term, "--root", estateRoot, "--limit", String(limit)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const hits: Array<{ file: string; line: string }> = [];
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("[")) continue;
      const parts = line.split(":");
      if (parts.length >= 2) {
        hits.push({ file: parts[0]!, line: parts.slice(1).join(":") });
      }
    }
    return hits;
  } catch {
    return [];
  }
}

async function repoStats(full: string, token: string): Promise<Omit<PatternRepoMatch, "fullName" | "matchedFiles">> {
  const r = (await ghGet(`/repos/${full}`, token)) as Record<string, unknown> | null;
  if (!r) {
    return {
      stars: 0,
      issues: 0,
      forks: 0,
      pushed: 0,
      hasTest: 0,
      description: "",
      language: "",
      license: "",
      url: `https://github.com/${full}`,
    };
  }
  let hasTest = 0;
  const root = await ghGet(`/repos/${full}/contents/`, token);
  if (Array.isArray(root)) {
    const names = root.map((x: Record<string, unknown>) => String(x.name ?? "").toLowerCase());
    hasTest = names.some((n) => ["tests", "test", "__tests__", "spec", "crates", "packages"].includes(n)) ? 1 : 0;
  }
  const lic = r.license as { spdx_id?: string; name?: string } | undefined;
  return {
    stars: Number(r.stargazers_count ?? 0),
    issues: Number(r.open_issues_count ?? 0),
    forks: Number(r.forks_count ?? 0),
    pushed: typeof r.pushed_at === "string" ? Date.parse(r.pushed_at) / 1000 : 0,
    hasTest,
    description: String(r.description ?? ""),
    language: String(r.language ?? ""),
    license: String(lic?.spdx_id ?? lic?.name ?? ""),
    url: String(r.html_url ?? `https://github.com/${full}`),
  };
}

export function rankPatternRows(
  rows: PatternTermRow[],
  weights: PatternWeights = DEFAULT_PATTERN_WEIGHTS,
): void {
  for (const key of PATTERN_FACTORS) {
    const vals = rows.map((r) => Number(r[key] ?? 0));
    if (rows.length <= 1) {
      for (const r of rows) r[`n_${key}`] = 1.0;
      continue;
    }
    const mx = Math.max(...vals) || 1;
    const mn = Math.min(...vals);
    const rng = mx - mn || 1;
    for (const r of rows) r[`n_${key}`] = (Number(r[key] ?? 0) - mn) / rng;
  }
  const wsum = PATTERN_FACTORS.reduce((a, k) => a + (weights[k] ?? 0), 0) || 1;
  for (const r of rows) {
    r.score =
      PATTERN_FACTORS.reduce((a, k) => a + Number(r[`n_${k}`] ?? 0) * (weights[k] ?? 0), 0) / wsum;
  }
  rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function collectTopPatternRepos(rows: readonly PatternTermRow[], topTerms: number, limit: number): PatternRepoMatch[] {
  const repoMap = new Map<string, PatternRepoMatch>();
  for (const r of rows.slice(0, topTerms)) {
    for (const repo of r.repos || []) {
      const existing = repoMap.get(repo.fullName);
      if (!existing) {
        repoMap.set(repo.fullName, { ...repo, terms: [r.term] });
      } else {
        if (!existing.terms) existing.terms = [];
        if (!existing.terms.includes(r.term)) existing.terms.push(r.term);
        for (const f of repo.matchedFiles) {
          if (!existing.matchedFiles.includes(f)) existing.matchedFiles.push(f);
        }
      }
    }
  }
  return Array.from(repoMap.values())
    .sort((a, b) => b.stars - a.stars)
    .slice(0, limit);
}

export async function patternBorrow(opts: PatternBorrowOptions = {}): Promise<PatternBorrowResult> {
  const t0 = performance.now();
  const terms = opts.patterns?.length ? toSearchTerms(opts.patterns) : DEFAULT_PATTERNS;
  const top = opts.top ?? (opts.patterns?.length ? opts.patterns.length : 5);
  const perPage = opts.perPage ?? 5;
  const weights: PatternWeights = { ...DEFAULT_PATTERN_WEIGHTS, ...(opts.weights ?? {}) };
  const token = opts.localOnly ? "" : resolveGithubToken().key;
  const estateRoot = opts.estateRoot ?? process.env.ESTATE ?? ESTATE;

  const rows: PatternTermRow[] = await Promise.all(
    terms.map(async (term) => {
      const [data, localHits] = await Promise.all([
        token
          ? (ghGet("/search/code", token, { q: term, per_page: String(perPage) }) as Promise<{
              items?: Array<{
                path?: string;
                size?: number;
                repository?: { full_name?: string };
              }>;
            } | null>)
          : Promise.resolve(null),
        scanLocalCode(term, perPage, estateRoot),
      ]);

      const repos: Record<string, Omit<PatternRepoMatch, "fullName" | "matchedFiles">> = {};
      const matchedFiles: Record<string, string[]> = {};
      const sizes: number[] = [];

      if (localHits.length) {
        for (const h of localHits) {
          const rel = h.file.replace(`${estateRoot}/`, "");
          const key = `local:${rel}`;
          repos[key] = {
            stars: 9999,
            issues: 0,
            forks: 1,
            pushed: Math.floor(Date.now() / 1000),
            hasTest: 1,
            description: `In-tree pattern: ${h.line.trim().slice(0, 100)}`,
            language: rel.split(".").pop() ?? "ts",
            license: "estate",
            url: `file://${h.file}`,
          };
          matchedFiles[key] = [rel];
        }
      }

      if (data?.items) {
        const uniqueRepos = new Set<string>();
        for (const it of data.items) {
          const full = it.repository?.full_name;
          if (!full || full.startsWith("toxicwind/")) continue;
          if (!matchedFiles[full]) matchedFiles[full] = [];
          if (it.path) matchedFiles[full]!.push(it.path);
          uniqueRepos.add(full);
          if (typeof it.size === "number") sizes.push(it.size);
        }
        const statsEntries = await Promise.all(
          [...uniqueRepos].map(async (full) => [full, await repoStats(full, token)] as const),
        );
        for (const [full, st] of statsEntries) {
          repos[full] = st;
        }
      }

      const vals = Object.values(repos);
      const nRepos = vals.length;
      const totalStars = vals.reduce((a, v) => a + v.stars, 0);
      const totalIssues = vals.reduce((a, v) => a + v.issues, 0);
      const totalForks = vals.reduce((a, v) => a + v.forks, 0);
      const pushed = vals.map((v) => v.pushed).filter((x) => x > 0);
      const newest = pushed.length ? Math.max(...pushed) : 0;
      const testFrac = nRepos ? vals.reduce((a, v) => a + v.hasTest, 0) / nRepos : 0;
      const avgSize = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
      const bugRel = DEFAULT_BUG_TERMS.reduce(
        (a, t) => a + (term.toLowerCase().match(new RegExp(t, "g"))?.length ?? 0),
        0,
      );
      const repoList: PatternRepoMatch[] = Object.entries(repos).map(([fullName, st]) => ({
        fullName,
        ...st,
        matchedFiles: matchedFiles[fullName] ?? [],
      }));
      return {
        term,
        nRepos,
        stars: totalStars,
        issues: totalIssues,
        forks: totalForks,
        newest,
        testFrac,
        avgSize,
        bugRel,
        repos: repoList,
      };
    }),
  );

  rankPatternRows(rows, weights);
  const topRepos = collectTopPatternRepos(rows, top, top);
  return {
    terms: rows.map((r) => r.term),
    rows,
    topRepos,
    timingMs: performance.now() - t0,
  };
}

export function renderPatternBorrow(result: PatternBorrowResult, asText = false): string {
  if (!asText) {
    return JSON.stringify({ terms: result.terms, topRepos: result.topRepos, timingMs: Math.round(result.timingMs) }, null, 2);
  }
  const lines: string[] = [
    `# pattern-borrow — terms: ${result.terms.join(" | ")}`,
    `# scored across ${result.rows.length} terms in ${result.timingMs.toFixed(0)}ms; factors: ${PATTERN_FACTORS.join(",")}`,
    "",
  ];
  for (let i = 0; i < result.topRepos.length; i++) {
    const repo = result.topRepos[i]!;
    const isLocal = repo.fullName.startsWith("local:");
    lines.push(`[${i + 1}] ${repo.fullName}  ★${repo.stars}  ${repo.language || "?"}  ${repo.license || "?"}`);
    if (repo.description) lines.push(`    why: ${repo.description.slice(0, 140)}`);
    if (repo.terms?.length) lines.push(`    matched terms: ${repo.terms.join(", ")}`);
    if (isLocal) {
      lines.push(`    in-tree first-class: ${repo.url.replace("file://", "")}`);
    } else {
      lines.push(`    repo: ${repo.url}`);
      const rawFiles = (repo.matchedFiles || []).slice(0, 3);
      if (rawFiles.length) {
        lines.push(`    matching files:`);
        for (const f of rawFiles) {
          lines.push(`      - https://raw.githubusercontent.com/${repo.fullName}/HEAD/${f}`);
        }
      }
    }
  }
  if (!result.topRepos.length) {
    lines.push("no matches — refine terms (stopwords stripped; use code identifiers)");
  }
  return lines.join("\n");
}
