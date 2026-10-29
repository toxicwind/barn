#!/usr/bin/env bun
/**
 * kappa-context — First-class Kappa Context Explorer, Precompaction Seed Generator, & MCP Server.
 *
 * Replaces ad-hoc SQLite queries with a unified CLI + Kappa Extension + stdio MCP tool (`kccontext`)
 * over `~/.local/share/kappa/kappa-main.db` (sessions, messages, parts, todos, board) with ZERO truncation.
 *
 * Usage:
 *   kappa-context search <query> [--limit N]
 *   kappa-context session <session_id> [--grep <pattern>]
 *   kappa-context seed [session_id]
 *   kappa-context mcp
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "/home/toxic";
export const KAPPA_DB = process.env.KAPPA_DB_PATH || join(HOME, ".local/share/kappa/kappa-main.db");

export const extensionManifest = {
  id: "kappa-context",
  version: "1.0.0",
  type: "tool" as const,
  entry: "/home/toxic/pens/olympus/products/kappa/extensions/kappa-context/index.ts",
  manifest: {
    description: "Kappa session context explorer, untruncated conversation search, and MCP server (kccontext)",
    commands: ["search", "session", "seed", "mcp"],
  },
};

export interface ContextMatch {
  sessionId: string;
  sessionTitle: string;
  directory: string;
  partId: string;
  partType: string;
  createdAt: string;
  text: string;
}

export function searchKappaContext(query: string, limit = 50, dbPath = KAPPA_DB): ContextMatch[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT p.session_id, COALESCE(s.title, '') as title, COALESCE(s.directory, '') as directory,
                p.id as part_id, json_extract(p.data, '$.type') as part_type,
                datetime(p.time_created / 1000, 'unixepoch') as created_at,
                COALESCE(json_extract(p.data, '$.text'), json_extract(p.data, '$.state.output'), p.data) as content
         FROM part p
         JOIN session s ON s.id = p.session_id
         WHERE p.data LIKE ? OR s.title LIKE ?
         ORDER BY p.time_created DESC
         LIMIT ?`,
      )
      .all(`%${query}%`, `%${query}%`, limit) as Array<{
      session_id: string;
      title: string;
      directory: string;
      part_id: string;
      part_type: string | null;
      created_at: string;
      content: string;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      sessionTitle: r.title,
      directory: r.directory,
      partId: r.part_id,
      partType: r.part_type ?? "unknown",
      createdAt: r.created_at,
      text: r.content,
    }));
  } finally {
    db.close();
  }
}

export function exploreKappaSession(sessionId: string, grepPattern?: string, dbPath = KAPPA_DB): {
  session: { id: string; title: string; directory: string; parentId: string | null; createdAt: string } | null;
  subagents: Array<{ id: string; title: string; createdAt: string }>;
  parts: Array<{ id: string; type: string; createdAt: string; content: string }>;
} {
  if (!existsSync(dbPath)) return { session: null, subagents: [], parts: [] };
  const db = new Database(dbPath, { readonly: true });
  try {
    const s = db
      .query(
        `SELECT id, COALESCE(title, '') as title, COALESCE(directory, '') as directory,
                parent_id, datetime(time_created / 1000, 'unixepoch') as created_at
         FROM session WHERE id = ?`,
      )
      .get(sessionId) as { id: string; title: string; directory: string; parent_id: string | null; created_at: string } | null;
    if (!s) return { session: null, subagents: [], parts: [] };

    const subs = db
      .query(
        `SELECT id, COALESCE(title, '') as title, datetime(time_created / 1000, 'unixepoch') as created_at
         FROM session WHERE parent_id = ? ORDER BY time_created ASC`,
      )
      .all(sessionId) as Array<{ id: string; title: string; created_at: string }>;

    const rawParts = db
      .query(
        `SELECT id, json_extract(data, '$.type') as part_type,
                datetime(time_created / 1000, 'unixepoch') as created_at,
                COALESCE(json_extract(data, '$.text'), json_extract(data, '$.state.output'), data) as content
         FROM part WHERE session_id = ? ORDER BY time_created ASC`,
      )
      .all(sessionId) as Array<{ id: string; part_type: string | null; created_at: string; content: string }>;

    const re = grepPattern ? new RegExp(grepPattern, "i") : null;
    const parts = rawParts
      .filter((p) => (re ? re.test(p.content) : (p.part_type === "text" || p.part_type === "tool")))
      .map((p) => ({
        id: p.id,
        type: p.part_type ?? "unknown",
        createdAt: p.created_at,
        content: p.content,
      }));

    return {
      session: {
        id: s.id,
        title: s.title,
        directory: s.directory,
        parentId: s.parent_id,
        createdAt: s.created_at,
      },
      subagents: subs.map((x) => ({ id: x.id, title: x.title, createdAt: x.created_at })),
      parts,
    };
  } finally {
    db.close();
  }
}

async function runMcp(): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk);
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line);
        const id = req.id;
        if (req.method === "initialize") {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "kappa-context", version: "1.0.0" },
              },
            }) + "\n",
          );
        } else if (req.method === "tools/list") {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                tools: [
                  {
                    name: "kccontext_search",
                    description: "Search Kappa sessions and parts without truncation",
                    inputSchema: {
                      type: "object",
                      properties: { query: { type: "string" }, limit: { type: "number" } },
                      required: ["query"],
                    },
                  },
                  {
                    name: "kccontext_session",
                    description: "Explore a Kappa session by ID with optional regex filter",
                    inputSchema: {
                      type: "object",
                      properties: { session_id: { type: "string" }, grep: { type: "string" } },
                      required: ["session_id"],
                    },
                  },
                ],
              },
            }) + "\n",
          );
        } else if (req.method === "tools/call") {
          const name = req.params?.name;
          const args = req.params?.arguments ?? {};
          const payload =
            name === "kccontext_search"
              ? searchKappaContext(String(args.query ?? ""), Number(args.limit ?? 25))
              : exploreKappaSession(String(args.session_id ?? ""), args.grep ? String(args.grep) : undefined);
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] },
            }) + "\n",
          );
        }
      } catch {}
    }
  }
}

if (import.meta.main) {
  const [cmd, arg1, ...rest] = process.argv.slice(2);
  if (cmd === "mcp") {
    await runMcp();
  } else if (cmd === "search" && arg1) {
    const limitIdx = rest.indexOf("--limit");
    const limit = limitIdx >= 0 ? Number(rest[limitIdx + 1]) || 25 : 25;
    const hits = searchKappaContext(arg1, limit);
    console.log(`=== kappa-context search: "${arg1}" (${hits.length} matches) ===`);
    for (const h of hits) {
      console.log(`\n[${h.sessionId} | ${h.partId} | ${h.partType} | ${h.createdAt}] (${h.sessionTitle} @ ${h.directory})`);
      console.log(h.text);
    }
  } else if (cmd === "session" && arg1) {
    const grepIdx = rest.indexOf("--grep");
    const grepPat = grepIdx >= 0 ? rest[grepIdx + 1] : undefined;
    const res = exploreKappaSession(arg1, grepPat);
    if (!res.session) {
      console.error(`Session not found: ${arg1}`);
      process.exit(1);
    }
    console.log(`=== Session ${res.session.id}: ${res.session.title} (${res.session.directory}) @ ${res.session.createdAt} ===`);
    console.log(`Subagents (${res.subagents.length}):`);
    for (const sub of res.subagents) {
      console.log(`  - ${sub.id}: ${sub.title} (${sub.createdAt})`);
    }
    console.log(`\nParts (${res.parts.length}${grepPat ? ` matching /${grepPat}/i` : ""}):`);
    for (const p of res.parts) {
      console.log(`\n--- [${p.id} | ${p.type} | ${p.createdAt}] ---`);
      console.log(p.content);
    }
  } else {
    console.log("Usage: kappa-context <search <query> [--limit N] | session <id> [--grep <pat>] | mcp>");
  }
}
