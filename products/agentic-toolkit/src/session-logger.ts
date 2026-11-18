/**
 * Session Logger Subagent — background log tracker for chat sessions
 * 
 * Runs as a background process, tracks all agent/user interactions,
 * provides queryable session history for future reference.
 * 
 * Usage:
 *   import { SessionLogger, queryLog } from './session-logger.ts';
 *   const logger = new SessionLogger({ sessionId: '...' });
 *   logger.log({ role: 'user', content: '...' });
 *   logger.log({ role: 'agent', content: '...', tools: [...] });
 */

import { readFile, writeFile, appendFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_DIR = "/home/toxic/pens/logs/sessions";

export interface LogEntry {
  timestamp: string;
  sessionId: string;
  turn: number;
  role: "user" | "agent" | "system" | "tool";
  content: string;
  tools?: string[];
  toolResults?: any[];
  metadata?: Record<string, any>;
}

export interface SessionLoggerOptions {
  sessionId?: string;
  maxMemoryEntries?: number;
  flushIntervalMs?: number;
}

export class SessionLogger {
  private sessionId: string;
  private turn: number = 0;
  private buffer: LogEntry[] = [];
  private maxMemoryEntries: number;
  private flushIntervalMs: number;
  private flushTimer?: ReturnType<typeof setInterval>;
  private initialized: boolean = false;

  constructor(options: SessionLoggerOptions = {}) {
    this.sessionId = options.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.maxMemoryEntries = options.maxMemoryEntries || 100;
    this.flushIntervalMs = options.flushIntervalMs || 5000;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(LOG_DIR, { recursive: true });
    this.startFlushTimer();
    this.initialized = true;
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.flushTimer.unref();
  }

  log(entry: Omit<LogEntry, "timestamp" | "sessionId" | "turn">): void {
    const fullEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      turn: ++this.turn,
      ...entry,
    };
    
    this.buffer.push(fullEntry);
    
    if (this.buffer.length >= this.maxMemoryEntries) {
      this.flush();
    }
  }

  logUser(content: string, metadata?: Record<string, any>): void {
    this.log({ role: "user", content, metadata });
  }

  logAgent(content: string, tools?: string[], metadata?: Record<string, any>): void {
    this.log({ role: "agent", content, tools, metadata });
  }

  logTool(toolName: string, args: any, result: any): void {
    this.log({
      role: "tool",
      content: `Tool: ${toolName}`,
      metadata: { tool: toolName, args, result: this.sanitizeResult(result) },
    });
  }

  private sanitizeResult(result: any): any {
    if (result === null || result === undefined) return result;
    if (typeof result === "string" && result.length > 10000) {
      return { type: "string", length: result.length, preview: result.slice(0, 200) + "..." };
    }
    if (Buffer.isBuffer(result)) {
      return { type: "buffer", length: result.length };
    }
    if (Array.isArray(result)) {
      return { type: "array", length: result.length, items: result.slice(0, 3).map(this.sanitizeResult) };
    }
    if (typeof result === "object") {
      const keys = Object.keys(result);
      if (keys.length > 20) {
        return { type: "object", keys: keys.slice(0, 20) };
      }
      const sanitized: Record<string, any> = {};
      for (const k of keys.slice(0, 20)) {
        sanitized[k] = this.sanitizeResult(result[k]);
      }
      return sanitized;
    }
    return result;
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    const entries = this.buffer.splice(0, this.buffer.length);
    const logFile = join(LOG_DIR, `${this.sessionId}.jsonl`);
    
    try {
      const lines = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
      await appendFile(logFile, lines, "utf-8");
    } catch (e) {
      this.buffer.unshift(...entries);
      console.error(`[SessionLogger] Flush failed: ${e}`);
    }
  }

  async getLog(): Promise<LogEntry[]> {
    await this.flush();
    const logFile = join(LOG_DIR, `${this.sessionId}.jsonl`);
    
    try {
      const content = await readFile(logFile, "utf-8");
      return content.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }
}

let globalLogger: SessionLogger | null = null;

export function getGlobalLogger(): SessionLogger {
  if (!globalLogger) {
    globalLogger = new SessionLogger();
  }
  return globalLogger;
}

export async function queryLog(query: {
  sessionId?: string;
  since?: string;
  until?: string;
  role?: LogEntry["role"];
  limit?: number;
}): Promise<LogEntry[]> {
  const files = await readdir(LOG_DIR);
  const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
  
  let allEntries: LogEntry[] = [];
  
  for (const file of jsonlFiles) {
    const sessionId = file.replace(".jsonl", "");
    if (query.sessionId && sessionId !== query.sessionId) continue;
    
    const content = await readFile(join(LOG_DIR, file), "utf-8");
    const entries = content.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    allEntries.push(...entries);
  }
  
  if (query.since) {
    allEntries = allEntries.filter(e => e.timestamp >= query.since!);
  }
  if (query.until) {
    allEntries = allEntries.filter(e => e.timestamp <= query.until!);
  }
  if (query.role) {
    allEntries = allEntries.filter(e => e.role === query.role);
  }
  
  allEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  
  if (query.limit) {
    allEntries = allEntries.slice(-query.limit);
  }
  
  return allEntries;
}

export async function getRecentSessions(limit: number = 10): Promise<string[]> {
  const files = await readdir(LOG_DIR);
  const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
  return jsonlFiles
    .map(f => f.replace(".jsonl", ""))
    .filter(Boolean)
    .sort()
    .reverse()
    .slice(0, limit);
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  
  if (cmd === "query") {
    const sessionId = args[1];
    const entries = await queryLog({ sessionId, limit: 50 });
    for (const e of entries) {
      console.log(`[${e.timestamp}] ${e.role}: ${e.content.slice(0, 100)}`);
    }
  } else if (cmd === "sessions") {
    const sessions = await getRecentSessions(20);
    for (const s of sessions) {
      console.log(s);
    }
  } else {
    console.log("Usage: session-logger.ts <query|sessions> [sessionId]");
  }
}