/**
 * evidence.ts — observed-activity gatherers for lane-verify.
 *
 * Every evidence item is something OBSERVED on the box (a file mtime, a
 * sha256, a git commit, a heartbeat timestamp) — never a status string
 * someone wrote. Verdicts cite evidence refs, not prose. This is the
 * deterministic half of the estate's "verify by observed effects only"
 * rule, informed by "From Rubrics to Reliable Scores: Evidence-Grounded
 * Text Evaluation with LLM Judges" (arXiv:2601.08654, 2026): a score
 * without a cited evidence item is not a score.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export type EvidenceKind = "file" | "commit" | "receipt" | "heartbeat";

export interface EvidenceItem {
  kind: EvidenceKind;
  /** Stable reference id, e.g. "file#a3f9c1…". Rules cite these. */
  ref: string;
  /** ISO-8601 time the activity was observed at (file mtime, commit time…). */
  observed_at: string;
  sha256?: string;
  detail: string;
}

const MAX_FILES = 500;
const MAX_BYTES_HASH = 32 * 1024 * 1024;

function sha256File(path: string): string | undefined {
  try {
    const st = statSync(path);
    if (st.size > MAX_BYTES_HASH) return undefined;
    const h = createHash("sha256");
    h.update(readFileSync(path));
    return h.digest("hex");
  } catch {
    return undefined;
  }
}

function walkFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const p = join(dir, e.name);
    if (e.name === ".git" || e.name === "node_modules") continue;
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Files under watch dirs modified at/after `since`. */
export function gatherFiles(watchDirs: string[], since: Date): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const dir of watchDirs) {
    const files: string[] = [];
    walkFiles(dir, files);
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.add(f);
      let st;
      try {
        st = statSync(f);
      } catch {
        continue;
      }
      if (st.mtime < since) continue;
      const sha = sha256File(f);
      items.push({
        kind: "file",
        ref: `file#${(sha ?? "unhashable").slice(0, 12)}`,
        observed_at: st.mtime.toISOString(),
        sha256: sha,
        detail: `modified ${f} (${st.size} bytes)`,
      });
      if (items.length >= MAX_FILES) return items;
    }
  }
  return items;
}

/**
 * Git commits touching watch dirs since `since`. Runs `git log` in the
 * enclosing repo of the first watch dir that sits inside one.
 */
export function gatherCommits(watchDirs: string[], since: Date): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const dir of watchDirs) {
    let repo: string | null = null;
    try {
      repo = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 15000,
      }).trim();
    } catch {
      continue;
    }
    let out: string;
    try {
      out = execFileSync(
        "git",
        [
          "-C",
          repo,
          "log",
          `--since=${since.toISOString()}`,
          "--format=%H|%aI|%s",
          "--",
          dir,
        ],
        { encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch {
      continue;
    }
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [sha, date, ...msg] = line.split("|");
      items.push({
        kind: "commit",
        ref: `commit#${sha.slice(0, 12)}`,
        observed_at: date,
        sha256: sha,
        detail: `${msg.join("|").slice(0, 120)} [${repo}]`,
      });
    }
    break; // one repo scan covers all dirs inside it; others handled per-dir
  }
  return items;
}

/** Heartbeat freshness: the heartbeat file's mtime vs now. */
export function readHeartbeat(path: string): EvidenceItem | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  return {
    kind: "heartbeat",
    ref: `heartbeat#${path}`,
    observed_at: st.mtime.toISOString(),
    detail: `heartbeat file ${path} mtime`,
  };
}

export function gatherAll(
  watchDirs: string[],
  since: Date,
  heartbeatFile?: string,
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  items.push(...gatherFiles(watchDirs, since));
  items.push(...gatherCommits(watchDirs, since));
  if (heartbeatFile) {
    const hb = readHeartbeat(heartbeatFile);
    if (hb) items.push(hb);
  }
  return items;
}
