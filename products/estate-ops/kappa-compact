#!/usr/bin/env bun
/**
 * kappa-compact — First-class Kappa Compaction & Precompaction Seed Extension.
 *
 * Lives in olympus/products/kappa/extensions/kappa-compact (NEVER in /tmp/kappa-compact!).
 * Bridges Kappa's precompaction orchestrator seed (`orchestrator-seed.ts`) with SQLite
 * compaction epoch telemetry (`session_context_epoch`, `compaction` parts) so subagents
 * and sessions compact deterministically without losing orchestrator ground truth.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  generateSeed,
  formatSeed,
  type SeedInput,
  type SeedSnapshot,
} from "../../kappa-code/packages/cli/src/kappacode/orchestrator-seed.ts";

const HOME = process.env.HOME || "/home/toxic";
export const KAPPA_DB = process.env.KAPPA_DB_PATH || join(HOME, ".local/share/kappa/kappa-main.db");

export const extensionManifest = {
  id: "kappa-compact",
  version: "1.0.0",
  type: "hook" as const,
  entry: "/home/toxic/pens/olympus/products/kappa/extensions/kappa-compact/index.ts",
  manifest: {
    description: "Kappa precompaction seed & context compaction telemetry extension (olympus/products/kappa)",
  },
};

export interface CompactionStats {
  sessions: number;
  messages: number;
  compactionParts: number;
  epochRows: number;
  compactingSessions: number;
  topCompactedSessions: Array<{ sessionId: string; count: number }>;
}

export function getCompactionStats(dbPath = KAPPA_DB): CompactionStats {
  if (!existsSync(dbPath)) {
    return {
      sessions: 0,
      messages: 0,
      compactionParts: 0,
      epochRows: 0,
      compactingSessions: 0,
      topCompactedSessions: [],
    };
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const sessions = (db.query("SELECT count(*) as n FROM session").get() as { n: number }).n;
    const messages = (db.query("SELECT count(*) as n FROM message").get() as { n: number }).n;
    const compactionParts = (
      db.query("SELECT count(*) as n FROM part WHERE json_extract(data, '$.type') = 'compaction'").get() as { n: number }
    ).n;
    const epochRows = (db.query("SELECT count(*) as n FROM session_context_epoch").get() as { n: number }).n;
    const compactingSessions = (
      db.query("SELECT count(*) as n FROM session WHERE time_compacting IS NOT NULL").get() as { n: number }
    ).n;
    const topCompactedSessions = db
      .query(
        `SELECT session_id as sessionId, count(*) as count
         FROM part
         WHERE json_extract(data, '$.type') = 'compaction'
         GROUP BY session_id
         ORDER BY count DESC
         LIMIT 10`,
      )
      .all() as Array<{ sessionId: string; count: number }>;

    return {
      sessions,
      messages,
      compactionParts,
      epochRows,
      compactingSessions,
      topCompactedSessions,
    };
  } finally {
    db.close();
  }
}

export function buildSessionPrecompactionSeed(
  sessionId: string,
  goalBrief = "Active Kappa orchestrator session",
  dbPath = KAPPA_DB,
): { snapshot: SeedSnapshot; formatted: string } {
  const subagents: SeedInput["subagents"] = [];
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .query(
          `SELECT id, COALESCE(title, '') as title, time_updated
           FROM session WHERE parent_id = ? ORDER BY time_updated DESC LIMIT 12`,
        )
        .all(sessionId) as Array<{ id: string; title: string; time_updated: number }>;
      for (const r of rows) {
        subagents.push({
          id: r.id,
          task_id: r.id,
          status: "completed",
          model: "kappa",
          provider: "estate",
          lastActivity: r.title,
          idleMs: Math.max(0, Date.now() - (r.time_updated || Date.now())),
        });
      }
    } finally {
      db.close();
    }
  }
  const snapshot = generateSeed({
    taskId: sessionId,
    goalBrief,
    subagents,
    boardMessages: [],
    totalBoardMessages: 0,
    pendingWork: [],
    fileChanges: { modified: [], added: [], deleted: [], gitAvailable: true },
    services: [],
  });
  return { snapshot, formatted: formatSeed(snapshot) };
}

if (import.meta.main) {
  const [cmd, sessionId] = process.argv.slice(2);
  if (cmd === "seed" && sessionId) {
    const { formatted } = buildSessionPrecompactionSeed(sessionId);
    console.log(formatted);
  } else {
    console.log(JSON.stringify(getCompactionStats(), null, 2));
  }
}
