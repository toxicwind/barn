import { unlinkSync } from "fs";
import type { RepoRecord } from "./types.js";

export function autoFix(result: { records: RepoRecord[] }): string[] {
  const fixes: string[] = [];
  for (const record of result.records) {
    for (const symlink of record.symlinks) {
      if (symlink.broken) {
        try { unlinkSync(symlink.path); fixes.push(`Removed broken symlink: ${symlink.path}`); }
        catch (error) { fixes.push(`Failed to remove ${symlink.path}: ${error.message}`); }
      }
    }
  }
  return fixes;
}
