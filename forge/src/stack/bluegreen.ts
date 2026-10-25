/**
 * bluegreen — two-slot deploy with a main-commit-hash version marker.
 *
 * Slots live at <slotDir>/blue and <slotDir>/green plus a <slotDir>/active
 * symlink naming which slot is live. Deploy writes the built artifact into
 * the INACTIVE slot and nothing else. `go` atomically repoints `active` to
 * the staged slot, restarts the supervised daemon, verifies health, and
 * rolls `active` back to the prior slot on a failed health check.
 *
 * Everything is fsync-rooted-ish and tolerant of absent slots (a first
 * deploy has no prior slot to roll back to).
 */

import {
  mkdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

export type SlotState = {
  slotDir: string;
  activeLink: string;
  blue: string;
  green: string;
};

export function slotState(slotDir: string, activeLink: string): SlotState {
  return {
    slotDir,
    activeLink,
    blue: join(slotDir, "blue"),
    green: join(slotDir, "green"),
  };
}

/** Which slot is currently live: "blue" | "green" | "none". */
export function activeSlot(s: SlotState): "blue" | "green" | "none" {
  try {
    const target = readlinkSync(s.activeLink);
    const base = target.split("/").pop() ?? "";
    return base === "green" ? "green" : base === "blue" ? "blue" : "none";
  } catch {
    return "none";
  }
}

/** The inactive slot name, creating slots as needed. */
export function inactiveSlot(s: SlotState): "blue" | "green" {
  mkdirSync(s.blue, { recursive: true });
  mkdirSync(s.green, { recursive: true });
  return activeSlot(s) === "green" ? "blue" : "green";
}

/**
 * Stage the artifact into the inactive slot under the main-short-hash
 * version name, then symlink <slot>/main-<hash> -> <slot>/latest so a watcher
 * can find the current build regardless of hash churn. Returns the path that
 * is now the staged binary and its version marker.
 */
export function stageBinary(
  s: SlotState,
  binaryPath: string,
  version: string,
): { slot: string; dir: string } {
  const slotName = inactiveSlot(s);
  const dir = join(s.slotDir, slotName);
  mkdirSync(dir, { recursive: true });

  // Copy the built artifact into a hash-named file inside the slot.
  const dest = join(dir, version);
  if (!existsSync(dest)) {
    const cp = Bun.spawnSync(["cp", binaryPath, dest], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (cp.exitCode !== 0) {
      throw new Error(
        `stage: cp ${binaryPath} -> ${dest} failed: ${(cp.stderr?.toString?.() ?? "").trim()}`,
      );
    }
  }

  // version marker + a stable `latest` symlink inside the slot.
  writeFileSync(join(dir, "VERSION"), `${version}\n`, "utf8");
  const latest = join(dir, "latest");
  if (!existsSync(latest)) {
    try {
      symlinkSync(version, latest);
    } catch {
      /* exists */
    }
  }

  return { slot: slotName, dir };
}

/**
 * Flip the active symlink to a *specific* slot (not "inactive" — callers
 * pass the slot that was just staged). Returns the prior slot so a rollback
 * can restore it.
 */
export function flipActive(
  s: SlotState,
  to: "blue" | "green",
): "blue" | "green" | "none" {
  const prior = activeSlot(s);
  mkdirSync(s.slotDir, { recursive: true });
  const target =
    to === "green" ? join(s.slotDir, "green") : join(s.slotDir, "blue");
  const tmp = `${s.activeLink}.tmp-${Date.now()}`;
  symlinkSync(target, tmp);
  rmSync(s.activeLink, { force: true });
  renameSync(tmp, s.activeLink);
  return prior;
}

/** Point the active symlink back at a prior slot (rollback). */
export function rollbackActive(s: SlotState, to: "blue" | "green"): void {
  flipActive(s, to);
}

/** The hash-named binary currently linked by `active`. */
export function activeBinary(s: SlotState): string | null {
  const slot = activeSlot(s);
  if (slot === "none") return null;
  const latest = join(s.slotDir, slot, "latest");
  try {
    if (existsSync(latest)) {
      const name = readlinkSync(latest);
      return join(s.slotDir, slot, name);
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/** Short main commit hash, deref the current HEAD of `gitRoot`. */
export function mainShortHash(gitRoot: string): string {
  const out = Bun.spawnSync(
    ["git", "-C", gitRoot, "rev-parse", "--short", "HEAD"],
    {
      stdout: "pipe",
      stderr: "pipe",
      cwd: gitRoot,
    },
  );
  const h = (out.stdout?.toString?.() ?? "").trim();
  return h || "unknown";
}

/** Remove a slot's runtime dir entirely (used by `--clean` / tests). */
export function clearSlotDir(s: SlotState): void {
  for (const p of [s.slotDir, s.activeLink]) {
    try {
      if (existsSync(p)) {
        const st = statSync(p);
        if (st.isSymbolicLink() || st.isFile()) rmSync(p, { force: true });
        else rmSync(p, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }
}
