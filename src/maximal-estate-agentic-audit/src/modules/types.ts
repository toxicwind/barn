export interface RepoRecord {
  name: string;
  path: string;
  area: string;
  isGit: boolean;
  remoteUrl?: string;
  branch?: string;
  lastCommit?: string;
  lastCommitDate?: string;
  status: string;
  symlinks: SymlinkRecord[];
  issues: string[];
  message?: string;
  commit?: string;
  author?: string;
}

export interface LocalAuditResult {
  records: RepoRecord[];
  total: number;
  durationMs: number;
  mode: AuditMode;
  repos: RepoRecord[];
  byArea: Record<string, number>;
  symlinks: SymlinkRecord[];
  recent: number;
  stale: number;
  message: string;
  commit: string;
  author: string;
}

export interface SymlinkRecord {
  path: string;
  target: string;
  exists: boolean;
  broken: boolean;
}

export interface AuditMode {
  type: "full" | "git-only" | "symlinks-only";
  autoFix: boolean;
  preCheck: boolean;
  completions: boolean;
}
