#!/usr/bin/env bun
// worker-queue-watch.ts — event-driven watcher for the persistent worker queue.
//
// Watches pending/ + active/ + failed/ via fs.watch (inotify — no polling).
// On any mutation it:
//   1. Re-evaluates the dispatch condition (covers file mutations that bypass
//      the worker-queue CLI, e.g. another agent moving files directly).
//   2. Sweeps active/ for stale heartbeats (stuck workers) and alerts once
//      per item.
// The CLI itself signals synchronously on submit/complete/fail/retry/start,
// so this daemon is the safety net, not the hot path.
//
// Pure logic (dispatchReady, shouldSignal, staleIds) is exported for tests.
//
// Usage:
//   worker-queue-watch.ts watch            # run the watcher (foreground)
//   worker-queue-watch.ts ensure           # start if not running (cron keepalive)
//   worker-queue-watch.ts stop             # stop the daemon
//   worker-queue-watch.ts status           # print daemon + queue status
//   worker-queue-watch.ts check            # one-shot: run checks once, no watch
//
// Env:
//   WORKER_QUEUE_DIR   queue dir (default ~/workspace/queue)
//   WORKER_QUEUE_NO_SQUAWK=1  suppress squawk posts (tests)
//   WQ_STALE_SECS      heartbeat staleness threshold (default 1800)
//   WQ_REALERT_SECS    dispatch re-alert interval (default 900)

import { watch } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";

const QUEUE_DIR = process.env.WORKER_QUEUE_DIR ?? path.join(os.homedir(), "workspace", "queue");
const NO_SQUAWK = !!process.env.WORKER_QUEUE_NO_SQUAWK;
const STALE_SECS = parseInt(process.env.WQ_STALE_SECS ?? "1800", 10);
const REALERT_SECS = parseInt(process.env.WQ_REALERT_SECS ?? "900", 10);
const PID_FILE = path.join(QUEUE_DIR, ".watch.pid");
const LOG_FILE = path.join(QUEUE_DIR, "watch.log");
const SIGNAL_FILE = path.join(QUEUE_DIR, ".dispatch-signal");
const STALE_FILE = path.join(QUEUE_DIR, ".stale-alerted");

function log(msg: string) {
  const line = `${new Date().toISOString()} [watch] ${msg}\n`;
  try {
    require("node:fs").appendFileSync(LOG_FILE, line);
  } catch { /* best effort */ }
}

function readJson(p: string): any | null {
  try {
    return JSON.parse(require("node:fs").readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function countState(state: string): number {
  try {
    return require("node:fs").readdirSync(path.join(QUEUE_DIR, state))
      .filter((f: string) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function getMaxWorkers(): number {
  const cfg = readJson(path.join(QUEUE_DIR, "config.json"));
  const mw = cfg?.max_workers;
  return typeof mw === "number" && mw >= 1 ? mw : 8;
}

// --- pure logic (exported for tests) ---------------------------------------

export function dispatchReady(pending: number, active: number, maxWorkers: number): boolean {
  const available = Math.max(0, maxWorkers - active);
  return pending > 0 && available > 0;
}

export function shouldSignal(
  now: number, lastSignal: number, lastCondition: boolean, condition: boolean,
  realertSecs: number,
): { fire: boolean; newLastSignal: number } {
  if (!condition) return { fire: false, newLastSignal: lastSignal };
  if (!lastCondition) return { fire: true, newLastSignal: now };   // false -> true edge
  if (lastSignal === 0) return { fire: true, newLastSignal: now };  // no prior signal
  if (now - lastSignal >= realertSecs) return { fire: true, newLastSignal: now };
  return { fire: false, newLastSignal: lastSignal };
}

export interface ActiveItem { id: string; heartbeat?: string; started?: string }

export function staleIds(items: ActiveItem[], nowEpoch: number, thresholdSecs: number): string[] {
  const out: string[] = [];
  for (const it of items) {
    const ts = it.heartbeat ?? it.started;
    if (!ts) continue;
    const epoch = Math.floor(new Date(ts).getTime() / 1000);
    if (Number.isFinite(epoch) && nowEpoch - epoch > thresholdSecs) out.push(it.id);
  }
  return out;
}

// --- side-effecting checks ---------------------------------------------------

function sendSquawk(text: string) {
  console.log(text);
  if (NO_SQUAWK) return;
  const squawk = path.join(os.homedir(), "workspace", "bin", "squawk");
  try {
    const p = spawn(squawk, ["send", "fleet", text], {
      env: { ...process.env, SQUAWK_SENDER: "worker-queue" },
      stdio: "ignore",
    });
    p.on("error", () => {});
  } catch { /* best effort */ }
}

function readSignalState(): { lastSignal: number; lastCondition: boolean } {
  const s = readJson(SIGNAL_FILE);
  return {
    lastSignal: typeof s?.last_signal === "number" ? s.last_signal : 0,
    lastCondition: s?.last_condition === 1 || s?.last_condition === true,
  };
}

function writeSignalState(lastSignal: number, condition: boolean) {
  try {
    require("node:fs").writeFileSync(
      SIGNAL_FILE,
      JSON.stringify({ last_signal: lastSignal, last_condition: condition ? 1 : 0, updated: new Date().toISOString() }) + "\n",
    );
  } catch { /* best effort */ }
}

function checkDispatch() {
  const pending = countState("pending");
  const active = countState("active");
  const maxw = getMaxWorkers();
  const condition = dispatchReady(pending, active, maxw);
  const st = readSignalState();
  const now = Math.floor(Date.now() / 1000);
  const { fire, newLastSignal } = shouldSignal(now, st.lastSignal, st.lastCondition, condition, REALERT_SECS);
  writeSignalState(newLastSignal, condition);
  if (fire) {
    const available = Math.max(0, maxw - active);
    const n = Math.min(pending, available);
    sendSquawk(`📋 worker-queue: ${n} item(s) ready to dispatch (${pending} pending, ${available}/${maxw} slots free). Run: worker-queue next`);
    log(`dispatch signal fired (pending=${pending} active=${active})`);
  }
}

function readActiveItems(): ActiveItem[] {
  const dir = path.join(QUEUE_DIR, "active");
  const out: ActiveItem[] = [];
  try {
    for (const f of require("node:fs").readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const j = readJson(path.join(dir, f));
      if (j?.id) out.push({
        id: j.id, heartbeat: j.heartbeat, started: j.started,
        agent_id: j.agent_id, title: j.title, brief: j.brief,
      } as ActiveItem & { agent_id?: string; title?: string; brief?: string });
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * Death-of-a-lane auto-capture: when a queued worker's heartbeat goes stale,
 * run agent-checkpoint.ts recover for its agent so the lane can resume from
 * a checkpoint instead of starting over. Returns a short note for the alert
 * ("" when there is nothing to capture or capture failed). Best-effort and
 * fail-closed: recover itself refuses agents whose session is fresh (<10m).
 */
function tryAutoCapture(item: ActiveItem & { agent_id?: string; title?: string; brief?: string }): string {
  if (!item.agent_id) return "";
  try {
    const script = path.join(os.homedir(), "workspace", "bin", "agent-checkpoint.ts");
    const args = [
      process.execPath, script, "recover",
      "--agent-id", item.agent_id,
      "--name", `agent-${item.agent_id.slice(0, 8)}`,
      "--lane", item.title ?? "worker-queue",
      "--brief", item.brief ?? "",
    ];
    const r = require("node:child_process").spawnSync(args[0], args.slice(1), {
      encoding: "utf8", timeout: 60000,
    });
    const out = String(r.stdout ?? "") + String(r.stderr ?? "");
    const cp = out.match(/^Checkpoint: (\S+)/m);
    const kill = out.match(/^kill: (\S+)/m);
    if (cp) {
      log(`auto-capture: ${item.id} -> ${cp[1]} (kill: ${kill?.[1] ?? "?"})`);
      return ` auto-captured checkpoint ${cp[1]} (kill: ${kill?.[1] ?? "?"}); resume via \`agent-checkpoint.ts brief ${cp[1]}\` -> subagent.spawn`;
    }
    log(`auto-capture: ${item.id} no checkpoint (${out.slice(0, 120).replace(/\s+/g, " ")})`);
  } catch (e) {
    log(`auto-capture error: ${item.id}: ${(e as Error)?.message ?? e}`);
  }
  return "";
}

function checkStale() {
  const now = Math.floor(Date.now() / 1000);
  const stale = staleIds(readActiveItems(), now, STALE_SECS);
  if (stale.length === 0) return;
  let alerted: string[] = [];
  const prev = readJson(STALE_FILE);
  if (Array.isArray(prev)) alerted = prev.filter((x) => typeof x === "string");
  const fresh = stale.filter((id) => !alerted.includes(id));
  // drop ids that are no longer active (completed/failed since)
  const activeItems = readActiveItems();
  const activeIds = new Set(activeItems.map((i) => i.id));
  const stillOut = [...new Set([...alerted, ...fresh])].filter((id) => activeIds.has(id));
  try {
    require("node:fs").writeFileSync(STALE_FILE, JSON.stringify(stillOut) + "\n");
  } catch { /* ignore */ }
  for (const id of fresh) {
    const item = activeItems.find((i) => i.id === id) as (ActiveItem & { agent_id?: string; title?: string; brief?: string }) | undefined;
    const note = item ? tryAutoCapture(item) : "";
    sendSquawk(`⚠️ worker-queue: worker ${id} heartbeat stale >${Math.round(STALE_SECS / 60)}m (stuck?).${note} Review: worker-queue list active`);
    log(`stale alert: ${id}`);
  }
}

function onEvent() {
  try {
    checkDispatch();
    checkStale();
  } catch (e) {
    log(`check error: ${e}`);
  }
}

// --- daemon lifecycle --------------------------------------------------------

function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  try {
    const pid = parseInt(require("node:fs").readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function ensureQueueDir() {
  // The queue dir may not exist yet (fresh box, or first run). The worker-queue
  // CLI self-heals with mkdir -p; the watcher must do the same instead of
  // crashing on PID-file write (ENOENT). Fix-forward 2026-10-02 (Cinder).
  const fs = require("node:fs");
  for (const sub of ["", "pending", "active", "completed", "failed"]) {
    fs.mkdirSync(sub ? path.join(QUEUE_DIR, sub) : QUEUE_DIR, { recursive: true });
  }
}

async function cmdEnsure() {
  ensureQueueDir();
  const pid = readPid();
  if (pid && pidRunning(pid)) {
    console.log(`watcher already running (pid ${pid})`);
    return;
  }
  const script = process.argv[1];
  const child = spawn(process.execPath, [script, "watch"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  require("node:fs").writeFileSync(PID_FILE, String(child.pid) + "\n");
  console.log(`watcher started (pid ${child.pid})`);
}

function cmdStop() {
  const pid = readPid();
  if (!pid || !pidRunning(pid)) {
    console.log("watcher not running");
    try { require("node:fs").unlinkSync(PID_FILE); } catch {}
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
  try { require("node:fs").unlinkSync(PID_FILE); } catch {}
  console.log(`watcher stopped (was pid ${pid})`);
}

function cmdStatus() {
  const pid = readPid();
  const running = pid !== null && pidRunning(pid);
  console.log(`watcher: ${running ? `running (pid ${pid})` : "not running"}`);
  console.log(`queue: ${countState("pending")} pending, ${countState("active")} active, ${countState("completed")} completed, ${countState("failed")} failed`);
  const st = readSignalState();
  console.log(`dispatch signal: last=${st.lastSignal ? new Date(st.lastSignal * 1000).toISOString() : "never"} condition=${st.lastCondition}`);
}

async function cmdWatch() {
  ensureQueueDir();
  require("node:fs").writeFileSync(PID_FILE, String(process.pid) + "\n");
  log(`watcher started (pid ${process.pid}) dir=${QUEUE_DIR}`);
  const dirs = ["pending", "active", "failed"].map((d) => path.join(QUEUE_DIR, d));
  for (const d of dirs) require("node:fs").mkdirSync(d, { recursive: true });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onEvent(); }, 500);
  };
  for (const d of dirs) {
    try {
      watch(d, debounced);
    } catch (e) {
      log(`watch failed on ${d}: ${e}`);
    }
  }
  // initial sweep
  onEvent();
  const shutdown = () => {
    log("watcher stopping");
    try { require("node:fs").unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await new Promise(() => {}); // run forever
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "watch") await cmdWatch();
  else if (cmd === "ensure") await cmdEnsure();
  else if (cmd === "stop") cmdStop();
  else if (cmd === "status") cmdStatus();
  else if (cmd === "check") { onEvent(); console.log("checks ran"); }
  else { console.error(`unknown command: ${cmd}`); process.exit(2); }
}
