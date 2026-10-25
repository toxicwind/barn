import type { LocalAuditResult } from "./types.js";

export function toDataFrame(result: LocalAuditResult): Record<string, unknown[]> {
  return {
    name: result.records.map((r) => r.name),
    path: result.records.map((r) => r.path),
    area: result.records.map((r) => r.area),
    isGit: result.records.map((r) => r.isGit),
    remoteUrl: result.records.map((r) => r.remoteUrl ?? ""),
    branch: result.records.map((r) => r.branch ?? ""),
    lastCommit: result.records.map((r) => r.lastCommit ?? ""),
    lastCommitDate: result.records.map((r) => r.lastCommitDate ?? ""),
    status: result.records.map((r) => r.status),
    lastCommitMessage: result.records.map((r) => r.message ?? ""),
    lastCommitAuthor: result.records.map((r) => r.author ?? ""),
    message: result.records.map((r) => r.message ?? ""),
    commit: result.records.map((r) => r.commit ?? ""),
    author: result.records.map((r) => r.author ?? ""),
    symlinkCount: result.records.map((r) => r.symlinks.length),
    issueCount: result.records.map((r) => r.issues.length),
  };
}
