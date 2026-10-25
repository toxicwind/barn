/**
 * exa.ts — Exa search provider. COSTS CREDITS.
 *
 * FIX applied (key-ordering): exaSearch(query, numResults, apiKey) already takes
 * `apiKey` and uses it for the `x-api-key` header; it has never re-resolved a
 * key internally, so the orchestrator's key (explicit flag → env → ~/.secrets)
 * is what reaches the wire. `logExaCall` records every paid call (ok and
 * !ok); on !ok the function throws so the caller's safeCall layer turns it into
 * a source_degraded event and the audit line is written. Also exports
 * `resolveExaKey()`, the key chain previously living in src/borrow.ts.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type SourceResult } from "./types";
import { SHINGLE_CACHE, USER_AGENT, resolveSecretsmithKey } from "./http";

export const EXA_BASE = "https://api.exa.ai/search";

/**
 * Exa key resolver — explicit flag → secretsmith keyring (SSOT) →
 * environment → $HOME/.secrets. Mirrors the chain that lived in borrow.ts so
 * the paid leg is constructed only when a key actually resolves.
 */
export function resolveExaKey(explicit = ""): { key: string; from: string } {
  if (explicit) return { key: explicit, from: "explicit flag" };
  // Secretsmith keyring is the SSOT (AGENTS Rule 3); a stale env EXA_API_KEY
  // that has leaked would otherwise shadow the valid keyring value.
  const sm = resolveSecretsmithKey("EXA_API_KEY");
  if (sm.key) return sm;
  const fromEnv = process.env.EXA_API_KEY;
  if (fromEnv) return { key: fromEnv, from: "environment" };
  try {
    const vault = readFileSync(join(homedir(), ".secrets"), "utf8");
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

export async function exaSearch(
  query: string,
  numResults: number,
  apiKey: string,
): Promise<SourceResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(EXA_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ query, type: "auto", numResults }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = (await res.json()) as {
      results?: {
        title?: string;
        url?: string;
        publishedDate?: string;
        score?: number;
      }[];
      costDollars?: { total?: number };
    };
    logExaCall({
      ok: true,
      ms: performance.now() - t0,
      query,
      resultsReturned: data.results?.length ?? 0,
      costUsd: data.costDollars?.total ?? null,
    });
    return {
      ok: true,
      cost: "exa-credits",
      timingMs: performance.now() - t0,
      items: (data.results ?? []).map((r) => ({
        title: r.title ?? null,
        url: r.url ?? null,
        publishedDate: r.publishedDate ?? null,
        score: r.score ?? null,
      })),
    };
  } catch (e) {
    logExaCall({
      ok: false,
      ms: performance.now() - t0,
      query,
      error: String((e as Error).message),
    });
    throw e;
  }
}

export type ExaCall = {
  ok: boolean;
  ms: number;
  query: string;
  resultsReturned?: number;
  costUsd?: number | null;
  error?: string;
};

export function logExaCall(call: ExaCall): void {
  try {
    mkdirSync(SHINGLE_CACHE, { recursive: true });
    appendFileSync(
      join(SHINGLE_CACHE, "exa_audit.jsonl"),
      `${JSON.stringify({ ts: Date.now() / 1000, ...call })}\n`,
      "utf8",
    );
  } catch {
    /* audit is best-effort */
  }
}
