/**
 * health — per-target probes for `forge stack health` and the post-`go`
 * verification. `--deep` additionally asserts the deployed version marker
 * matches the current `main` commit hash, catching a stale blue/green
 * restore before it becomes a live prod slip.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Target } from "./targets";
import { mainShortHash } from "./bluegreen";

export type HealthResult = {
  target: string;
  ok: boolean;
  detail: string;
  version?: string;
  expectedVersion?: string;
  deep: boolean;
};

async function probeHttp(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return {
      ok: res.ok || res.status < 500,
      detail: `http ${res.status} ${url}`,
    };
  } catch (e) {
    return { ok: false, detail: `unreachable ${url}: ${(e as Error).message}` };
  }
}

async function probeCli(
  argv: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const tail = (out || err).trim().split("\n").slice(-1).join("");
    return {
      ok: code === 0,
      detail: `cli[${argv.join(" ")}] -> exit ${code} ${tail ? `(${tail.slice(0, 80)})` : ""}`,
    };
  } catch (e) {
    return { ok: false, detail: `cli ${argv[0]}: ${(e as Error).message}` };
  }
}

function readVersionMarker(slotDir: string): string | null {
  for (const slot of ["blue", "green"]) {
    const marker = join(slotDir, slot, "VERSION");
    if (existsSync(marker)) {
      try {
        const v = readFileSync(marker, "utf8").trim();
        if (v) return v;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export async function checkTarget(
  t: Target,
  opts: { deep: boolean; gitRoot?: string },
): Promise<HealthResult> {
  const timeout = t.health.timeoutMs ?? 3000;
  let probe: { ok: boolean; detail: string };
  if (t.health.kind === "http") {
    probe = await probeHttp(t.health.url, timeout);
  } else {
    probe = await probeCli(
      t.health.argv,
      timeout,
      t.health.kind === "cli" ? undefined : undefined,
    );
  }

  const res: HealthResult = {
    target: t.name,
    ok: probe.ok,
    detail: probe.detail,
    deep: opts.deep,
  };

  if (opts.deep && opts.gitRoot) {
    res.expectedVersion = mainShortHash(opts.gitRoot);
    res.version = readVersionMarker(t.deploy.slotDir) ?? undefined;
    const matches = res.expectedVersion === res.version;
    if (!matches) {
      res.ok = false;
      res.detail = `deep: deployed ${res.version ?? "(none)"} != current main ${res.expectedVersion} (${probe.detail})`;
    }
  }
  return res;
}

export function renderHealth(results: HealthResult[]): string[] {
  const width = Math.max(...results.map((r) => r.target.length), 6);
  const lines = ["=== stack health ==="];
  for (const r of results) {
    const tag = r.deep
      ? r.ok
        ? "GREEN "
        : "STALE "
      : r.ok
        ? "PASS  "
        : "FAIL  ";
    lines.push(`${tag}${r.target.padEnd(width)}  ${r.detail}`);
  }
  const allOk = results.every((r) => r.ok);
  lines.push(
    allOk
      ? "== all targets healthy =="
      : `== ${results.filter((r) => !r.ok).length} target(s) unhealthy ==`,
  );
  return lines;
}
