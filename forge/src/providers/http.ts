/**
 * http.ts — shared transport + key/ degrade utilities for the provider modules.
 *
 * Every provider reaches the network through this one module so that timeout,
 * retry/backoff, throttling, and degradation classification live in exactly one
 * place (the "fix one by one" target for the paper/code-search legs).
 *
 * Bun-forward: uses global fetch + AbortSignal.timeout (adopted in bun canary),
 * and async/await race-based retry/backoff. Zero external deps.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emit } from "../concurrent";
import { type SourceResult, type ResolvedKey } from "./types";

export const SHINGLE_CACHE = join(homedir(), ".cache", "pattern-forge");
const SECRETSMITH = "secretsmith";

export const USER_AGENT = "pattern-forge/1.0";
export const POLITE_MAILTO = "pattern-forge@localhost";

/* ------------------------------------------------------------------ secrets */

/**
 * Secretsmith drop-in: pull a secret from the freedesktop Secret Service
 * keyring (estate SSOT). Returns a ResolvedKey with `from="secretsmith"` when
 * found; when none parses, `key=""` with a reason in `from`.
 */
export function resolveSecretsmithKey(name: string): ResolvedKey {
  let out = "";
  try {
    const proc = Bun.spawnSync([
      "secretsmith",
      "get",
      "--label",
      name,
      "--show",
    ]);
    out = proc.stdout.toString();
    if (proc.exitCode !== 0) {
      out =
        (out || proc.stderr.toString() || "").trim() ||
        `secretsmith get failed (exit ${proc.exitCode ?? "?"}) for ${name}`;
    }
  } catch (e) {
    return {
      key: "",
      from: `secretsmith unavailable: ${(e as Error).message ?? e}`,
    };
  }
  const secretLine = out
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.startsWith("secret:"));
  const candidate = secretLine ? secretLine.slice("secret:".length).trim() : "";
  if (isPlausibleKey(candidate)) return { key: candidate, from: SECRETSMITH };
  // The old loose fallback ("any non-attrib line") returned secretsmith ERROR
  // TEXT as the key ("no items match", "usage: secretsmith …"), which reached
  // exa/s2 as x-api-key and surfaced as HTTP 401. A key must look like one.
  const fallback = out
    .split("\n")
    .map((s) => s.trim())
    .find(
      (s) =>
        s &&
        !/^(label|path|content_type|attr|secret|usage|error|no items)/i.test(s),
    );
  if (isPlausibleKey(fallback)) return { key: fallback!, from: SECRETSMITH };
  return { key: "", from: "secretsmith returned no parseable key" };
}

/** Keys are long token-ish strings; error prose and usage text are not. */
function isPlausibleKey(s: string | undefined): s is string {
  return (
    !!s && s.length >= 20 && !/\s/.test(s) && /^[A-Za-z0-9_\-:.]+$/.test(s)
  );
}

/** Name-to-secret key for the tokenized sources. Overridable for tests. */
const SECRET_KEYS: Record<string, string> = {
  github: "GITHUB_TOKEN",
  s2: "S2_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
  serper: "SERPER_API_KEY",
  tavily: "TAVILY_API_KEY",
};

/** Resolve a key by canonical provider name: secretsmith → env. */
export function resolveKey(provider: keyof typeof SECRET_KEYS): ResolvedKey {
  const label = SECRET_KEYS[provider];
  const sm = resolveSecretsmithKey(label);
  if (sm.key) return sm;
  const env = process.env[label] || "";
  if (env.trim()) return { key: env.trim(), from: "environment" };
  return { key: "", from: `not found (${label})` };
}

/** GitHub token chain: env → ~/.secrets → gh auth token. */
export function resolveGithubToken(): ResolvedKey {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env?.trim()) return { key: env.trim(), from: "environment" };
  for (const envFile of [
    join(homedir(), ".secrets"),
    join(homedir(), ".bashrc.env"),
  ]) {
    try {
      const vault = readFileSync(envFile, "utf8");
      const m =
        /^\s*(?:export\s+)?(?:GITHUB_TOKEN|GH_TOKEN)\s*=\s*["']?([^"'\n#]+)["']?/m.exec(
          vault,
        );
      if (m?.[1]?.trim())
        return { key: m[1].trim(), from: `${envFile} (vault)` };
    } catch {
      /* continue */
    }
  }
  try {
    const proc = Bun.spawnSync(["gh", "auth", "token"]);
    const tok = proc.stdout.toString().trim();
    if (tok && !tok.startsWith("HTTP") && !tok.includes("error"))
      return { key: tok, from: "gh auth token" };
  } catch {
    /* gh not available */
  }
  const sm = resolveSecretsmithKey("GITHUB_TOKEN");
  if (sm.key) return sm;
  return { key: "", from: "not found" };
}

/* ---------------------------------------------------------------- throttle */

/**
 * Light per-host client throttle, persisted across invocations so polite
 * interval holds between separate process runs (keyed by host name).
 */
export async function throttle(
  key: string,
  minIntervalMs = 1000,
): Promise<void> {
  const stateFile = join(SHINGLE_CACHE, `lit_${key}.json`);
  let last = 0;
  try {
    last =
      (JSON.parse(readFileSync(stateFile, "utf8")) as { last?: number }).last ??
      0;
  } catch {
    last = 0;
  }
  const wait = minIntervalMs - (Date.now() / 1000 - last) * 1000;
  if (wait > 0) await Bun.sleep(wait);
  try {
    mkdirSync(SHINGLE_CACHE, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ last: Date.now() / 1000 }), "utf8");
    renameSync(tmp, stateFile);
  } catch {
    /* politeness, not correctness */
  }
}

/* ------------------------------------------------------------------ network */

export type FetchResult = { data: unknown; ms: number };

/**
 * fetchJson with a hard timeout and retry/backoff for transient statuses
 * (429/5xx) and network weather. Bun-specific: response.stream is what Bun
 * exposes; the signal aborts on timeout (canary) or a manual AbortController.
 *
 * `maxRetries` and `retryDelayMs` allow a provider to tune without writing its
 * own retry loop. On 429 it honours Retry-After when present.
 */
export async function fetchJson(
  url: string,
  init: RequestInit & {
    timeoutMs?: number;
    maxRetries?: number;
    retryDelayMs?: number;
  } = {},
): Promise<FetchResult> {
  const {
    timeoutMs = 15_000,
    maxRetries = 0,
    retryDelayMs = 1000,
    ...rest
  } = init;
  let lastErr = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = performance.now();
    let controller: AbortController | null = null;
    let signal: AbortSignal;
    if (typeof AbortSignal.timeout === "function") {
      signal = AbortSignal.timeout(timeoutMs);
    } else {
      controller = new AbortController();
      const timer = setTimeout(
        () => controller!.abort(new Error("timeout")),
        timeoutMs,
      );
      queueMicrotask(() => clearTimeout(timer)); // no-op guard; kept for clarity
      signal = controller.signal;
    }
    try {
      const res = await fetch(url, { ...rest, signal });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
        const delay =
          retryAfter > 0 ? retryAfter * 1000 : retryDelayMs * (attempt + 1);
        lastErr = `HTTP ${res.status}`;
        if (attempt < maxRetries) {
          await Bun.sleep(delay);
          continue;
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      const trimmed = text.trim();
      if (trimmed.startsWith("<")) {
        throw new Error(
          `Non-JSON response (HTML/Challenge) from ${url.split("?")[0]}`,
        );
      }
      return { data: JSON.parse(text), ms: performance.now() - t0 };
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e).slice(0, 200);
      const isNetwork =
        /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|timeout|SIGTERM/i.test(
          lastErr,
        );
      if (isNetwork && attempt < maxRetries) {
        await Bun.sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr || "fetchJson exhausted retries");
}

/* ------------------------------------------------------------ degradation */

const EXPECTED_DEGRADE_PATTERNS = [
  /HTTP 429/,
  /Unrecognized token '<'/,
  /bot[-\s]?check/i,
  /captcha/i,
  /cloudflare/i,
  /ENOTFOUND/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /fetch failed/i,
  /timeout after/i,
  /challenge persisted/i,
];

export function isExpectedDegrade(error: string): boolean {
  return EXPECTED_DEGRADE_PATTERNS.some((re) => re.test(error));
}

/**
 * safeCall — a provider failure must never kill the run. Every per-route
 * failure emits `source_degraded`, never `source_failed`; a true hard error is
 * reserved for whole-run failure.
 */
export async function safeCall(
  name: string,
  fn: () => Promise<SourceResult>,
): Promise<SourceResult | null> {
  try {
    const result = await fn();
    if (!result.ok)
      emit({
        event: "source_degraded",
        source: name,
        error: result.error,
        expected: isExpectedDegrade(result.error ?? ""),
      });
    return result;
  } catch (e) {
    const message = String((e as Error).message);
    emit({
      event: "source_degraded",
      source: name,
      error: message,
      expected: isExpectedDegrade(message),
    });
    return { ok: false, items: [], cost: "free", error: message.slice(0, 160) };
  }
}

/* ---------------------------------------------------------------- audits */

/** Append one JSONL audit record (exa, arxiv, etc.). Best-effort. */
export function appendAudit(
  file: string,
  record: Record<string, unknown>,
): void {
  try {
    mkdirSync(SHINGLE_CACHE, { recursive: true });
    appendFileSync(
      join(SHINGLE_CACHE, file),
      `${JSON.stringify({ ts: Date.now() / 1000, ...record })}\n`,
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

/** Keep the old single-file export naming for the index re-export. */
export const AUDIT_DIR = SHINGLE_CACHE;
export { existsSync };
