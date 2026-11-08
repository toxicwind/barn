import { performance } from "perf_hooks";
import { writeFileSync } from "fs";
import { parseProjectsEnvSync } from "./modules/parser.js";
import { scanDirSync } from "./modules/git-scanner.js";
import { getSecretsRecord } from "./modules/secrets-scanner.js";
import { preCheck } from "./modules/precheck.js";
import { autoFix } from "./modules/autofix.js";
import { analyzeWithCompletions } from "./modules/completions.js";
import { toDataFrame } from "./modules/dataframe.js";
import { exportParquet } from "./modules/parquet.js";
import type { LocalAuditResult, AuditMode } from "./modules/types.js";
import { statSync } from "fs";

export async function localAudit(
  paths: string[] = [],
  mode: AuditMode = { type: "full", autoFix: false, preCheck: true, completions: false }
): Promise<LocalAuditResult> {
  const startTime = performance.now();
  let allRecords: LocalAuditResult["records"] = [];

  const scanPaths = parseProjectsEnvSync();
  for (const dir of scanPaths) {
    try {
      const stats = statSync(dir);
      if (!stats.isDirectory()) {
        allRecords.push({ name: dir.split("/").pop() || "unknown", path: dir, area: dir.startsWith("/home/toxic/pens/estate") ? "estate" : "projects", isGit: false, status: "missing", symlinks: [], issues: [] });
        continue;
      }
      const area = dir.startsWith("/home/toxic/pens/estate") ? "estate" : "projects";
      allRecords = [...allRecords, ...scanDirSync(dir, area)];
    } catch {
      allRecords.push({ name: dir.split("/").pop() || "unknown", path: dir, area: dir.startsWith("/home/toxic/pens/estate") ? "estate" : "projects", isGit: false, status: "missing", symlinks: [], issues: [] });
    }
  }

  allRecords.push(getSecretsRecord());

  const durationMs = performance.now() - startTime;

  const repos: LocalAuditResult["repos"] = [];
  const byArea: Record<string, number> = {};
  const allSymlinks: LocalAuditResult["symlinks"] = [];
  let recentCount = 0;
  let staleCount = 0;

  for (const record of allRecords) {
    repos.push(record);
    byArea[record.area] = (byArea[record.area] || 0) + 1;
    for (const sym of record.symlinks) allSymlinks.push(sym);
    if (record.lastCommit && record.lastCommit !== "unknown") recentCount++;
    else staleCount++;
  }

  const message = `Audit complete: ${allRecords.length} repos found in ${durationMs.toFixed(1)}ms`;

  return {
    records: allRecords,
    total: allRecords.length,
    durationMs,
    mode,
    repos,
    byArea,
    symlinks: allSymlinks,
    recent: recentCount,
    stale: staleCount,
    message,
    commit: "N/A",
    author: "system",
  };
}

export { toDataFrame } from "./modules/dataframe.js";
export { exportParquet } from "./modules/parquet.js";
export { preCheck } from "./modules/precheck.js";
export { autoFix } from "./modules/autofix.js";
export { analyzeWithCompletions } from "./modules/completions.js";
export { scanSecrets, getSecretsRecord } from "./modules/secrets-scanner.js";
export { parseProjectsEnvSync } from "./modules/parser.js";
export { scanDirSync } from "./modules/git-scanner.js";
