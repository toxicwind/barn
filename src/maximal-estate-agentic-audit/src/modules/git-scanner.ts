import { join } from "path";
import { readdirSync, statSync, readlinkSync, accessSync } from "fs";
import { execFile } from "child_process";
import type { RepoRecord, SymlinkRecord } from "./types.js";

function runGitAsync(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: dir, encoding: "utf8", timeout: 5000 }, (error, stdout) => {
      if (error) { resolve("unknown"); return; }
      resolve(stdout.trim());
    });
  });
}

export function scanSymlinksSync(dir: string): SymlinkRecord[] {
  const symlinks: SymlinkRecord[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      try {
        const target = readlinkSync(fullPath);
        let exists = true;
        try { accessSync(target); } catch { exists = false; }
        symlinks.push({ path: fullPath, target, exists, broken: !exists });
      } catch { /* broken symlink */ }
    }
  } catch { /* dir not readable */ }
  return symlinks;
}

export function scanDirSync(dir: string, area: string): RepoRecord[] {
  const repos: RepoRecord[] = [];
  try {
    let isGitRepo = false;
    try {
      const stats = statSync(join(dir, ".git"));
      if (stats.isDirectory()) {
        isGitRepo = true;
        repos.push({
          name: dir.split("/").pop() || "unknown",
          path: dir,
          area,
          isGit: true,
          remoteUrl: "no remote",
          branch: "detached",
          lastCommit: "unknown",
          lastCommitDate: "unknown",
          status: "clean",
          symlinks: scanSymlinksSync(dir),
          issues: [],
        });
      }
    } catch { /* not a git repo */ }
    if (!isGitRepo) {
      repos.push({ name: dir.split("/").pop() || "unknown", path: dir, area, isGit: false, status: "no-git", symlinks: [], issues: [] });
    }
  } catch { /* dir not readable */ }
  return repos;
}
