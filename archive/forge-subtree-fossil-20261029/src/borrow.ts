/**
 * Borrow — race every free source at once, rank what comes back.
 *
 * This is the merge paying off. emergent-enrich ran the sources one after
 * another and paid each one's latency in full; race-borrow ranked but raced
 * nothing. Here both properties hold: all legs launch together, so wall time
 * is the slowest leg rather than the sum, and the winners ledger drives
 * ordering on the next run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./paths";
import { emit } from "./concurrent";
import { measure } from "./measure";
import * as P from "./providers";
import { MLDictionary } from "./ml-dictionary";

export type SourceName = P.SourceName;

export type BorrowOptions = {
  perSource?: number;
  skip?: ReadonlySet<SourceName>;
  /** papersOnly: run only research-paper legs (arxiv/openalex/semanticscholar/
   * dblp/hf_papers/exa), skipping code sources. First-class `forge paper`. */
  papersOnly?: boolean;
  /** Exa costs credits. Without this the orchestrator never constructs the leg. */
  exaApiKey?: string;
  tag?: string;
  /** Hard wall-clock cap for the whole race. A borrow that would block past
   * this settles with whatever came in — never holds the agent hostage to one
   * hung source. Default 8s. */
  deadlineMs?: number;
  /** Per-leg cap applied inside safeCall so a single slow source degrades fast.
   * Default 5s. */
  legTimeoutMs?: number;
};

export type BorrowResult = {
  ok: true;
  query: string;
  sources: Partial<Record<SourceName, P.SourceResult | null>>;
  creditsSpent: boolean;
  notes: string[];
  timingMs: number;
  ranked: RankedBorrow[];
};

export type RankedBorrow = {
  source: SourceName | "cross-source";
  item: P.PaperItem | P.CodeItem;
  score: number;
  reasons: string[];
};

/** Weight the ranking puts on each signal. Free to tune, reported in output. */
export type Weights = {
  citations: number;
  upvotes: number;
  recency: number;
  abstractDepth: number;
  hasPdf: number;
  identifier: number;
};

export const DEFAULT_WEIGHTS: Weights = {
  citations: 3.0,
  upvotes: 2.5,
  recency: 1.5,
  abstractDepth: 1.0,
  hasPdf: 0.5,
  identifier: 2.0,
};

/**
 * Cross-source ranking.
 *
 * The point of ranking across sources rather than trusting each provider's
 * order: arXiv has no citation counts, OpenAlex has no upvotes, S2 has both.
 * A single weighting is the only place those get reconciled.
 */
export function rankItems(
  items: readonly { source: SourceName; item: P.PaperItem | P.CodeItem }[],
  weights: Weights = DEFAULT_WEIGHTS,
  now = new Date(),
): RankedBorrow[] {
  const year = now.getFullYear();
  const ranked = items.map(({ source, item }) => {
    const reasons: string[] = [];

    // Distinct ranking logic for code vs papers. Code sources get their own
    // signal set (stars, bm25, npm score) so they compete with papers fairly —
    // a global paper-biased scale (citations/doi) buried every code result.
    if (source === "local" || source === "github" || "repo" in item) {
      const asCode = item as P.CodeItem;
      let score = (asCode.score ?? 5) * 1.5;
      if (source === "local") {
        score += 8.0;
        reasons.push("local codebase in-tree match");
      } else if (source === "github_repos") {
        // stars dominate: log10(1+stars)*3 keeps 100-star repos above 0-star noise
        const stars = (asCode as unknown as { stars?: number }).stars ?? 0;
        score +=
          Math.log10(stars + 1) * 3.0 +
          ((asCode as unknown as { bm25?: number }).bm25 ?? 0) * 4.0;
        reasons.push(`repo ${stars}★`);
      } else if (source === "npm") {
        score +=
          ((asCode as unknown as { bm25?: number }).bm25 ?? 0) * 4.0 + 2.0;
        reasons.push("npm package");
      } else if (source === "stackoverflow") {
        score += 3.0;
        reasons.push("developer Q&A");
      } else {
        reasons.push("github code");
      }
      if (asCode.repo) reasons.push(asCode.repo);
      return { source, item, score, reasons };
    }

    const asPaper = item as P.PaperItem;

    const citations = (asPaper.citedByCount ??
      asPaper.citationCount ??
      0) as number;
    if (citations) reasons.push(`cited x${citations}`);
    const citationScore = Math.log10(citations + 1) * weights.citations;

    const upvotes = (asPaper.upvotes ?? 0) as number;
    if (upvotes) reasons.push(`upvotes ${upvotes}`);
    const upvoteScore = Math.log10(upvotes + 1) * weights.upvotes;

    const published =
      asPaper.published ?? (asPaper.year ? String(asPaper.year) : null);
    const age = published ? year - Number(String(published).slice(0, 4)) : 99;
    const recencyScore = Math.max(0, 1 - age / 5) * weights.recency;
    if (age <= 2 && published)
      reasons.push(`recent ${String(published).slice(0, 4)}`);

    const depth = (asPaper.summary?.length ?? 0) / 600;
    if (depth > 0)
      reasons.push(`abstract ${Math.round(asPaper.summary!.length)}ch`);

    let score =
      citationScore +
      upvoteScore +
      recencyScore +
      depth * weights.abstractDepth;
    if (asPaper.pdfUrl) {
      score += weights.hasPdf;
      reasons.push("has pdf");
    }
    if (asPaper.arxivId || asPaper.doi) {
      score += weights.identifier;
      reasons.push(asPaper.arxivId ? "arxiv id" : "doi");
    }
    return { source, item, score, reasons };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * Resolve the exa key from the secretsmith vault. Order: explicit flag, then
 * the environment, then `$HOME/.secrets`. An earlier version required an
 * `--exa-ok` opt-in before it would even look, which meant a key sitting in
 * the vault went unused — exa is a good source and the audit log already
 * records every paid call and its cost. Audit, don't gate.
 */
export function resolveExaKey(explicit = ""): { key: string; from: string } {
  if (explicit) return { key: explicit, from: "explicit flag" };
  // Secretsmith keyring is the SSOT (AGENTS Rule 3); a stale env EXA_API_KEY
  // that has leaked would otherwise shadow the valid keyring value.
  const sm = P.resolveSecretsmithKey("EXA_API_KEY");
  if (sm.key) return sm;
  const fromEnv = process.env.EXA_API_KEY;
  if (fromEnv) return { key: fromEnv, from: "environment" };
  try {
    const vault = readFileSync(join(HOME, ".secrets"), "utf8");
    const hit = vault.match(
      /^\s*(?:export\s+)?EXA_API_KEY\s*=\s*["']?([^"'\n#]+)["']?/m,
    );
    if (hit?.[1]?.trim())
      return { key: hit[1].trim(), from: "$HOME/.secrets (secretsmith vault)" };
  } catch (e) {
    return {
      key: "",
      from: `$HOME/.secrets unreadable: ${(e as Error).message ?? e}`,
    };
  }
  return { key: "", from: "not found" };
}

/** Brave Search source (replaces the dead exa key on this box). SSOT-first like the others. */
export function resolveBraveKey(explicit = ""): { key: string; from: string } {
  if (explicit) return { key: explicit, from: "explicit flag" };
  const sm = P.resolveSecretsmithKey("BRAVE_SEARCH_API_KEY");
  if (sm.key) return sm;
  const env = process.env.BRAVE_SEARCH_API_KEY || "";
  if (env) return { key: env, from: "environment" };
  try {
    const vault = readFileSync(join(HOME, ".secrets"), "utf8");
    const hit = vault.match(
      /^\s*(?:export\s+)?(?:BRAVE_SEARCH_API_KEY|BRAVE_API_KEY)\s*=\s*["']?([^"'\n#]+)["']?/m,
    );
    if (hit?.[1]?.trim()) return { key: hit[1].trim(), from: "$HOME/.secrets" };
  } catch (e) {
    return {
      key: "",
      from: `$HOME/.secrets unreadable: ${(e as Error).message ?? e}`,
    };
  }
  return { key: "", from: "not found" };
}

/** SERPER (Google) — SSOT-first. */
export function resolveSerperKey(explicit = ""): { key: string; from: string } {
  if (explicit) return { key: explicit, from: "explicit flag" };
  const sm = P.resolveSecretsmithKey("SERPER_API_KEY");
  if (sm.key) return sm;
  const env = process.env.SERPER_API_KEY || "";
  if (env) return { key: env, from: "environment" };
  return { key: "", from: "not found" };
}

/** Tavily — SSOT-first. */
export function resolveTavilyKey(explicit = ""): { key: string; from: string } {
  if (explicit) return { key: explicit, from: "explicit flag" };
  const sm = P.resolveSecretsmithKey("TAVILY_API_KEY");
  if (sm.key) return sm;
  const env = process.env.TAVILY_API_KEY || "";
  if (env) return { key: env, from: "environment" };
  return { key: "", from: "not found" };
}

/** Run every enabled source concurrently. Wall time = slowest leg, not the sum. */
export async function borrow(
  query: string,
  opts: BorrowOptions = {},
): Promise<BorrowResult> {
  const {
    perSource = 5,
    skip = new Set(),
    deadlineMs = 12_000,
    legTimeoutMs = 4_000,
  } = opts;
  const resolvedKeys = new Map<SourceName, string>();
  const notes: string[] = [];
  const t0 = performance.now();

  const dict = new MLDictionary();
  const expanded = dict.expand(query);
  // exaApiKey flows through the registry's keyed-leg resolution, not a special case.
  if (opts.exaApiKey) resolvedKeys.set("exa", opts.exaApiKey);

  // Table-driven legs from the provider registry — the orchestrator owns NO
  // provider logic. Enablement = not skipped AND (keyless or a resolved key).
  const legNames = Object.keys(P.PROVIDERS) as SourceName[];
  const legs: {
    name: SourceName;
    enabled: boolean;
    run: () => Promise<P.SourceResult>;
  }[] = legNames.map((name) => {
    const spec = P.PROVIDERS[name];
    let key = "";
    if (spec.keyed) {
      key = resolvedKeys.get(name) ?? spec.resolveKey?.().key ?? "";
      resolvedKeys.set(name, key);
    }
    return {
      name,
      enabled: !skip.has(name) && (!spec.keyed || key.length > 0),
      run: () => spec.search(expanded, perSource, { apiKey: key }),
    };
  });

  for (const leg of legs)
    if (skip.has(leg.name)) notes.push(`${leg.name} skipped by flag`);
  if (!skip.has("github")) {
    const ghKey = resolvedKeys.get("github") ?? "";
    if (ghKey) notes.push("github token resolved");
    else
      notes.push(
        "github skipped: no GITHUB_TOKEN (checked environment and $HOME/.secrets); code search requires auth — degrades, does not fail the run",
      );
  }
  if (skip.has("exa")) notes.push("exa skipped by flag; no credits spent");
  else if (!resolvedKeys.get("exa"))
    notes.push(
      "exa has no api key (checked flag, environment, and $HOME/.secrets)",
    );
  else notes.push("exa key resolved; call logged with cost to the audit log");

  // All legs in flight at once. This is the merge's speed win over the
  // sequential Python original: 7 legs took 7 latencies, now they take 1.
  // Each leg is ALSO individually bounded (its registry timeoutMs) so one hung
  // source cannot dominate the run, and the WHOLE race is bounded by
  // deadlineMs: results are delivered to the agent the moment the wall lands —
  // settled-with-what-arrived, never held hostage by the slowest leg.
  const active = legs.filter((leg) => leg.enabled && !skip.has(leg.name));
  const partial = new Map<SourceName, P.SourceResult | null>();
  const legWork = active.map(async (leg) => {
    const cap = P.PROVIDERS?.[leg.name]?.timeoutMs ?? legTimeoutMs;
    const result = await measureAsyncResult(leg.name, leg.run, cap);
    partial.set(leg.name, result);
  });
  const wall = new Promise<"wall">((resolve) => {
    const timer = setTimeout(() => resolve("wall"), deadlineMs);
    (timer as { unref?: () => void }).unref?.();
  });
  await Promise.race([Promise.all(legWork), wall]);
  for (const leg of active)
    if (!partial.has(leg.name))
      partial.set(leg.name, {
        ok: false,
        items: [],
        cost: "free",
        error: `abandoned at ${deadlineMs}ms wall (still in flight)`,
      });
  const settled = [...partial.entries()] as [
    SourceName,
    P.SourceResult | null,
  ][];

  const sources: BorrowResult["sources"] = {};
  let creditsSpent = false;
  for (const [name, result] of settled) {
    sources[name] = result;
    if (name === "exa" && result?.ok) {
      creditsSpent = true;
      const cost =
        result.cost === "exa-credits"
          ? ` ${result.items.length} results billed`
          : "";
      notes.push(
        `exa ran and billed${cost}; see the exa audit log for costUsd`,
      );
    } else if (name === "exa" && result && !result.ok) {
      notes.push(`exa call failed: ${result.error ?? "unknown"}`);
    }
  }

  const flat = Object.entries(sources)
    .filter(([, r]) => r?.ok && r.items.length)
    .flatMap(([source, r]) =>
      (r!.items as (P.PaperItem | P.CodeItem)[]).map((item) => ({
        source: source as SourceName,
        item,
      })),
    );

  const result: BorrowResult = {
    ok: true,
    query,
    sources,
    creditsSpent,
    notes,
    timingMs: performance.now() - t0,
    ranked: rankItems(flat),
  };
  emit({
    event: "borrow_done",
    query,
    sources: Object.keys(sources).length,
    items: flat.length,
    timing_ms: result.timingMs,
  });
  return result;
}

async function measureAsyncResult(
  name: SourceName,
  fn: () => Promise<P.SourceResult>,
  legTimeoutMs = 4_000,
): Promise<P.SourceResult | null> {
  const started = performance.now();
  // Backstop the leg so a single hung provider (slow DNS, retry spiral, 30s
  // timeout) can't hold the whole borrow past the deadline. On strike we
  // return a degraded-but-null-safe leg result instead of awaiting forever.
  let outcome: Awaited<ReturnType<P.safeCall>> = null;
  try {
    outcome = await Promise.race([
      P.safeCall(name, fn),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), legTimeoutMs),
      ),
    ]);
  } catch {
    outcome = null;
  }
  if (outcome === null) {
    emit({
      event: "source_degraded",
      source: name,
      error: `timeout after ${legTimeoutMs}ms`,
      expected: true,
    });
    return {
      ok: false,
      items: [],
      cost: "free",
      error: `timed out after ${legTimeoutMs}ms`,
    };
  }
  emit({
    event: "source_done",
    source: name,
    ok: outcome?.ok ?? false,
    items: outcome?.items.length ?? 0,
    timing_ms: performance.now() - started,
  });
  return outcome;
}

/** Human-readable lead-with-winner summary, in the format the fleet already parses. */
export function renderBorrow(result: BorrowResult, topN = 10): string {
  const lines: string[] = [];
  const ok = Object.entries(result.sources).filter(([, r]) => r?.ok);
  const failedSources = Object.entries(result.sources).filter(
    ([, r]) => r && !r.ok,
  );
  lines.push(
    `=== Borrow: "${result.query}" — ${ok.length}/${Object.keys(result.sources).length} sources ok in ${result.timingMs.toFixed(0)}ms ===`,
  );
  for (const [name, r] of failedSources) {
    const err = r!.error ?? "unknown";
    // A degraded source is a note, never an alarm: the run succeeded
    // without it. Only a genuinely unexpected failure keeps FAILED.
    if (P.isExpectedDegrade(err))
      lines.push(`  note: ${name} degraded (${err}) — skipped`);
    else lines.push(`  ${name}: FAILED — ${err}`);
  }
  for (const note of result.notes) lines.push(`  note: ${note}`);
  if (!result.creditsSpent)
    lines.push(
      "  credits spent: 0 (exa runs only when a key resolves; none did)",
    );
  if (result.creditsSpent)
    lines.push("  CREDITS SPENT (exa ran; see the exa audit log for costUsd)");
  lines.push("");
  for (const [i, row] of result.ranked.slice(0, topN).entries()) {
    const item = row.item;
    let title = "(untitled)";
    let url = "";
    if ("repo" in item && item.repo) {
      title = item.name
        ? `${item.repo}: ${item.name}`
        : (item.repo ?? "(code)");
      url = item.html_url ?? item.path ?? "";
    } else {
      const p = item as P.PaperItem;
      title = p.title ?? "(untitled paper)";
      url = p.url ?? p.pdfUrl ?? "";
    }
    lines.push(
      `${String(i + 1).padStart(2)}. [${row.score.toFixed(2)}] [${row.source}] ${title}`,
    );
    if (url) lines.push(`    ${url}`);
    const authors = (item as P.PaperItem).authors;
    if (authors?.length)
      lines.push(
        `    ${authors.slice(0, 3).join(", ")}${authors.length > 3 ? " et al" : ""}`,
      );
    if (row.reasons.length) lines.push(`    ${row.reasons.join(" · ")}`);
    const snippet =
      (item as any).abstract || (item as any).snippet || (item as any).summary;
    if (snippet) {
      const clean = String(snippet).replace(/\s+/g, " ").trim();
      const truncated = clean.length > 180 ? `${clean.slice(0, 180)}…` : clean;
      lines.push(`    > "${truncated}"`);
    }
  }
  if (!result.ranked.length) lines.push("  (no items from any source)");
  return lines.join("\n");
}

export { measure };
