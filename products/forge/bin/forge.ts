#!/usr/bin/env bun
// @bun
var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};

// node_modules/@huggingface/hub/dist/chunk-FFYIGW52.mjs
var init_chunk_FFYIGW52 = () => {};

// src/cli.ts
import {
  existsSync as existsSync8,
  mkdirSync as mkdirSync6,
  readFileSync as readFileSync8,
  writeFileSync as writeFileSync3,
  readdirSync as readdirSync3,
  statSync as statSync5
} from "fs";
import { dirname as dirname4, resolve as resolve4, join as join14 } from "path";

// src/repo-index.ts
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

// src/bm25.ts
function countTerms(terms) {
  const tf = new Map;
  for (const t of terms)
    tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}
var WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
var CAMEL_SPLIT = /_|(?<=[a-z0-9])(?=[A-Z])/;
var HAS_CAMEL = /_|(?<=[a-z0-9])(?=[A-Z])/;
function tokenize(text) {
  const out = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (lower.length >= 2)
      out.push(lower);
    if (!HAS_CAMEL.test(word))
      continue;
    for (const part of word.split(CAMEL_SPLIT)) {
      const sub = part.toLowerCase();
      if (sub.length >= 2 && sub !== lower)
        out.push(sub);
    }
  }
  return out;
}
function normalizeImport(spec) {
  const tail = spec.split("/").filter(Boolean).pop();
  return (tail ?? spec).replace(/\.[cm]?[jt]sx?$/, "").toLowerCase();
}

class Bm25Index {
  paths = [];
  docLen = [];
  docAsync = [];
  docCent = [];
  symbols = [];
  stems = [];
  postings = new Map;
  totalLen = 0;
  incoming = new Map;
  n = 0;
  avgdl = 0;
  get size() {
    return this.n;
  }
  noteImport(spec) {
    const key = normalizeImport(spec);
    this.incoming.set(key, (this.incoming.get(key) ?? 0) + 1);
  }
  add(path, tf, symbolList, asyncCount) {
    const idx = this.n++;
    this.paths.push(path);
    this.stems.push(normalizeImport(path.replace(/\.[^.]+$/, "")));
    this.symbols.push([...symbolList]);
    let len = 0;
    for (const [t, f] of tf) {
      len += f;
      const p = this.postings.get(t);
      if (p) {
        p.docIdx.push(idx);
        p.freq.push(f);
      } else {
        this.postings.set(t, { docIdx: [idx], freq: [f] });
      }
    }
    this.docLen[idx] = len;
    this.docAsync[idx] = asyncCount;
    this.totalLen += len;
  }
  seal() {
    this.avgdl = this.n ? this.totalLen / this.n : 0;
    for (let i = 0;i < this.n; i++) {
      const own = this.incoming.get(this.stems[i]) ?? 0;
      const viaSymbol = this.symbols[i].reduce((best, s) => Math.max(best, this.incoming.get(normalizeImport(s)) ?? 0), 0);
      this.docCent[i] = Math.max(own, viaSymbol);
    }
  }
  bm25(queryTerms, k1 = 1.2, b = 0.75) {
    const scores = new Map;
    if (!this.n)
      return scores;
    const k1b = k1 * (1 - b);
    for (const t of new Set(queryTerms)) {
      const posting = this.postings.get(t);
      if (!posting)
        continue;
      const { docIdx, freq } = posting;
      const df = docIdx.length;
      if (!df)
        continue;
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
      for (let i = 0;i < df; i++) {
        const d = docIdx[i];
        const f = freq[i];
        const norm = k1b + b * (this.docLen[d] / (this.avgdl || 1));
        scores.set(d, (scores.get(d) ?? 0) + idf * f * (k1 + 1) / norm);
      }
    }
    return scores;
  }
  hybrid(query, topK = 10, opts = {}) {
    if (this.docCent.length !== this.n)
      this.seal();
    const { alpha = 0.6, beta = 0.4, gamma = 0.15, eps = 0.000001 } = opts;
    const qTerms = tokenize(query);
    const qSet = new Set(qTerms);
    const base = this.bm25(qTerms);
    const wantsAsync = qSet.has("async") || qSet.has("coroutine") || qSet.has("await");
    let maxCent = 0;
    for (const i of base.keys())
      maxCent = Math.max(maxCent, this.docCent[i] ?? 0);
    if (maxCent < 1)
      maxCent = 1;
    const ranked = [];
    for (const [i, bm25] of base) {
      const symbols = this.symbols[i];
      let symMatch = 0;
      for (const s of symbols) {
        const lower = s.toLowerCase();
        if (qSet.has(lower))
          symMatch++;
        else {
          for (const q of qSet) {
            if (q.length >= 3 && lower.includes(q)) {
              symMatch++;
              break;
            }
          }
        }
      }
      const symNorm = symMatch / 5;
      const asyncNorm = wantsAsync ? Math.min(this.docAsync[i] / 3, 1) : 0;
      const centNorm = this.docCent[i] / maxCent;
      ranked.push({
        path: this.paths[i],
        hybrid: (bm25 + eps) * (1 + alpha * symNorm + beta * asyncNorm + gamma * centNorm),
        bm25,
        symbols: symbols.length > 12 ? symbols.slice(0, 12) : symbols,
        asyncCount: this.docAsync[i],
        centrality: this.docCent[i]
      });
    }
    ranked.sort((a, b) => b.hybrid - a.hybrid || b.bm25 - a.bm25);
    return ranked.length > topK ? ranked.slice(0, topK) : ranked;
  }
  search(query, topK = 10) {
    return this.hybrid(query, topK).map((r) => ({
      ...r,
      file: r.path,
      score: r.hybrid
    }));
  }
}

// src/extract.ts
var CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
var PY_EXTS = new Set([".py"]);
var transpilerCache = new Map;
function transpilerFor(loader) {
  const cached = transpilerCache.get(loader);
  if (cached)
    return cached;
  const made = new Bun.Transpiler({ loader });
  transpilerCache.set(loader, made);
  return made;
}
function loaderFor(path) {
  if (path.endsWith(".tsx"))
    return "tsx";
  if (path.endsWith(".jsx"))
    return "jsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts"))
    return "ts";
  return "js";
}
function extractTsSymbols(path, source) {
  try {
    const t = transpilerFor(loaderFor(path));
    const scanned = t.scan(source);
    const symbols = scanned.exports ?? [];
    const imports = (scanned.imports ?? []).map((i) => i.path);
    const asyncCount = (source.match(/\basync\s+(?:function|\()/g) ?? []).length;
    return { symbols, imports, asyncCount };
  } catch {
    return { symbols: [], imports: [], asyncCount: 0 };
  }
}
var PY_CLASS = /^[ \t]*class[ \t]+([A-Za-z_]\w*)/gm;
var PY_FUNC = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm;
var PY_ASSIGN = /^(?:async[ \t]+)?def[ \t]+/gm;
function extractPySymbols(source) {
  const symbols = [];
  for (const m of source.matchAll(PY_CLASS))
    symbols.push(m[1]);
  for (const m of source.matchAll(PY_FUNC))
    symbols.push(m[1]);
  const imports = [];
  for (const m of source.matchAll(/^[ \t]*import[ \t]+([A-Za-z_][\w.]*)/gm))
    imports.push(m[1]);
  for (const m of source.matchAll(/^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import/gm))
    imports.push(m[1]);
  const asyncCount = source.match(PY_ASSIGN) && source.match(/^[ \t]*async[ \t]+def[ \t]+/gm)?.length || 0;
  return { symbols: [...new Set(symbols)], imports, asyncCount };
}
function extract(path, source) {
  return PY_EXTS.has(extname(path)) ? extractPySymbols(source) : extractTsSymbols(path, source);
}
function extname(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

// src/repo-index.ts
var SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  ".jj",
  ".pytest_cache",
  "coverage",
  "out",
  ".output",
  ".svelte-kit",
  "bower_components",
  "site-packages"
]);
var HEAVY_DIRS = new Set(["rancher-desktop", "snap", "go", "rustlib", ".rustup", ".cargo"]);
function isHidden(name) {
  return name.startsWith(".") && name !== ".";
}
function collectFiles(root, opts = {}) {
  const { maxFiles = 60000, includeHeavy = false } = opts;
  const files = [];
  let dirsWalked = 0;
  let dirsPruned = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirsWalked++;
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) {
          dirsPruned++;
          continue;
        }
        if (!includeHeavy && HEAVY_DIRS.has(name)) {
          dirsPruned++;
          continue;
        }
        if (isHidden(name))
          continue;
        stack.push(join(dir, name));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (CODE_EXTS.has(extOf(name)) || PY_EXTS.has(extOf(name)))
          files.push(join(dir, name));
      }
    }
  }
  files.sort();
  return { files: files.slice(0, maxFiles), stats: { root, dirsWalked, dirsPruned, truncated: files.length > maxFiles } };
}
function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}
async function buildIndex(root, opts = {}) {
  const started = performance.now();
  const { files, stats } = collectFiles(root, opts);
  const index = new Bm25Index;
  const CONCURRENCY = 256;
  let bytes = 0;
  for (let wave = 0;wave < files.length; wave += CONCURRENCY) {
    const slice = files.slice(wave, wave + CONCURRENCY);
    const sources = await Promise.all(slice.map(async (file) => {
      try {
        const text = await Bun.file(file).text();
        bytes += text.length;
        return { file, text };
      } catch {
        return null;
      }
    }));
    for (const got of sources) {
      if (!got)
        continue;
      const { symbols, imports, asyncCount } = extract(got.file, got.text);
      for (const spec of imports)
        index.noteImport(spec);
      const terms = tokenize(`${relative(root, got.file)} ${symbols.join(" ")}`);
      index.add(got.file, countTerms(terms), symbols, asyncCount);
    }
  }
  index.seal();
  return {
    index,
    stats: { ...stats, root, files: files.length, bytes, ms: Math.round(performance.now() - started) }
  };
}

// src/concurrent.ts
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname as dirname2 } from "path";

// src/paths.ts
import { existsSync, realpathSync } from "fs";
import { dirname, join as join2, resolve } from "path";
var HOME = process.env.HOME ?? "/home/toxic";
var SKILL_DIR = dirname(dirname(new URL(import.meta.url).pathname));
function estateCandidates() {
  return [...new Set(["/home/toxic/estate", join2(HOME, "estate")])];
}
function pickFirstExisting(candidates, fallback) {
  for (const c of candidates) {
    try {
      if (existsSync(c))
        return c;
    } catch {}
  }
  return fallback;
}
function discoverEstate() {
  const fromSkill = resolve(SKILL_DIR, "..", "..");
  if (existsSync(join2(fromSkill, "config", "ports.env")))
    return fromSkill;
  return pickFirstExisting(estateCandidates(), "");
}
function probeEstate() {
  return estateCandidates().map((candidate) => ({
    candidate,
    exists: existsSync(candidate),
    selected: ESTATE_ROOT !== "" && resolve(candidate) === ESTATE_ROOT
  }));
}
var ESTATE_ROOT = process.env.ESTATE ? resolve(process.env.ESTATE) : discoverEstate();
function resolvePath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
function estateSub(envKey, ...parts) {
  const fromEnv = process.env[envKey];
  if (fromEnv)
    return resolvePath(fromEnv);
  if (!ESTATE_ROOT)
    return "";
  return resolvePath(join2(ESTATE_ROOT, ...parts));
}
var ESTATE = ESTATE_ROOT ? resolvePath(ESTATE_ROOT) : "";
var RANCH = estateSub("RANCH", "ranch");
var VENDORED = estateSub("VENDORED", "vendored");
var VAR = estateSub("VAR", "var");
var MANOR = estateSub("MANOR", "manor");
var SKILLS_HOME = estateSub("SKILLS_HOME", "skills");
var TAU_DIR = process.env.TAU_DIR ? resolvePath(process.env.TAU_DIR) : RANCH ? resolvePath(join2(RANCH, "tau")) : "";
var PORTS_ENV = estateSub("PORTS_ENV", "config", "ports.env");
var KNOWLEDGEBASE = estateSub("KNOWLEDGEBASE", "docs", "fleet-knowledgebase.md");
var WINNERS_LOG = process.env.WINNERS_LOG ? resolve(process.env.WINNERS_LOG) : VAR ? resolve(join2(VAR, "cache", "pattern-forge", "winners.jsonl")) : "";
function isRepoRoot(path) {
  return existsSync(join2(path, ".git")) || existsSync(join2(path, ".git", "HEAD"));
}

// src/concurrent.ts
var OUTPUT_CAP = 256 * 1024;
var emitStream = (line) => {
  if (process.env.FORGE_QUIET === "1")
    return;
  process.stderr.write(`${line}
`);
};
function emit(event) {
  emitStream(JSON.stringify(event));
}
function setEmitter(fn) {
  emitStream = fn;
}
async function drainCapped(stream, cap) {
  if (!stream)
    return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      if (!value)
        continue;
      if (size >= cap) {
        truncated = true;
        continue;
      }
      const room = Math.min(value.length, cap - size);
      chunks.push(room === value.length ? value : value.subarray(0, room));
      size += room;
    }
  } catch {}
  const merged = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}
function killGroup(pid) {
  if (pid <= 0)
    return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
async function runOne(strategy, timeoutS, signal) {
  const t0 = performance.now();
  const elapsed = () => (performance.now() - t0) / 1000;
  const base = {
    name: strategy.name,
    ok: false,
    valid: false,
    rc: null,
    error: null,
    output: "",
    outputTruncated: false,
    stderrTail: "",
    latencyS: 0,
    cancelled: false
  };
  const fail = (error) => ({ ...base, error, latencyS: elapsed() });
  let proc;
  try {
    proc = Bun.spawn(strategy.cmd, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, ...strategy.env ?? {} },
      detached: true
    });
  } catch (e) {
    return fail(`command-not-found: ${strategy.cmd[0]} (${e.message})`);
  }
  if (signal?.aborted) {
    killGroup(proc.pid);
    return { ...fail("aborted"), cancelled: true };
  }
  const onAbort = () => killGroup(proc.pid);
  signal?.addEventListener("abort", onAbort, { once: true });
  const drainOut = drainCapped(proc.stdout, OUTPUT_CAP);
  const drainErr = drainCapped(proc.stderr, OUTPUT_CAP);
  const timer = setTimeout(() => killGroup(proc.pid), timeoutS * 1000);
  const rc = await proc.exited;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  const latency = elapsed();
  if (signal?.aborted)
    return { ...fail("aborted"), latencyS: latency, cancelled: true };
  if (latency >= timeoutS)
    return { ...fail(`timeout>${timeoutS}s`), latencyS: latency };
  const [{ text: output, truncated }, { text: errText }] = await Promise.all([drainOut, drainErr]);
  const valid = rc === 0 && (strategy.match === undefined || new RegExp(strategy.match, "s").test(output));
  return {
    name: strategy.name,
    ok: true,
    valid,
    rc,
    error: null,
    output: valid ? output : "",
    outputTruncated: valid && truncated,
    stderrTail: errText.slice(-2000),
    latencyS: latency,
    cancelled: false
  };
}
function passthrough(stderrTail) {
  for (const line of stderrTail.split(`
`)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"event"'))
      continue;
    try {
      emit(JSON.parse(trimmed));
    } catch {}
  }
}
async function runRace(strategies, opts) {
  const { raceId, tag, timeoutS, raceTimeoutS, hedgeMs = 0 } = opts;
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  const hedged = hedgeMs > 0 && strategies.length > 1;
  const ordered = hedged ? hedgeOrder(tag, strategies) : [...strategies];
  const results = {};
  const inflight = new Map;
  let winner = null;
  let winnerOutput = "";
  let winnerTruncated = false;
  let backups = [];
  let hedgeFired = false;
  let hedgeTimer = null;
  const finished = [];
  let wake = null;
  const launch = (s) => {
    const controller = new AbortController;
    emit({ event: "attempt_start", race_id: raceId, name: s.name, t_launch_s: now() });
    const promise = runOne(s, timeoutS, controller.signal);
    inflight.set(s.name, { name: s.name, controller, promise });
    promise.then((r) => {
      inflight.delete(s.name);
      finished.push(r);
      wake?.();
    });
  };
  emit({
    event: "race_start",
    race_id: raceId,
    tag,
    contestants: ordered.map((s) => s.name),
    launch_order: hedged ? ordered.map((s) => s.name) : null,
    hedge_ms: hedgeMs,
    timeout_s: timeoutS,
    race_timeout_s: raceTimeoutS
  });
  if (hedged) {
    backups = ordered.slice(1);
    launch(ordered[0]);
    emit({ event: "hedge_armed", race_id: raceId, hedge_ms: hedgeMs, primary: ordered[0].name, backups: backups.map((s) => s.name) });
    hedgeTimer = setTimeout(() => {
      if (winner || hedgeFired)
        return;
      hedgeFired = true;
      emit({ event: "hedge_fired", race_id: raceId, t_s: now(), backups: backups.map((s) => s.name) });
      for (const s of backups)
        launch(s);
      backups = [];
    }, hedgeMs);
  } else {
    for (const s of ordered)
      launch(s);
  }
  try {
    for (;; ) {
      if (winner !== null)
        break;
      if (!finished.length) {
        if (!inflight.size)
          break;
        const remaining = raceTimeoutS - now();
        if (remaining <= 0)
          break;
        const { promise: woke, resolve } = Promise.withResolvers();
        wake = resolve;
        const clock = setTimeout(resolve, remaining * 1000);
        await woke;
        clearTimeout(clock);
        wake = null;
      }
      while (finished.length) {
        const r = finished.shift();
        results[r.name] = r;
        emit({ event: "attempt_done", race_id: raceId, name: r.name, ok: r.ok, valid: r.valid, latency_s: r.latencyS, error: r.error });
        passthrough(r.stderrTail);
        if (r.valid && winner === null) {
          winner = r.name;
          winnerOutput = r.output;
          winnerTruncated = r.outputTruncated;
        }
      }
    }
  } finally {
    if (hedgeTimer) {
      clearTimeout(hedgeTimer);
      if (winner !== null)
        emit({ event: "hedge_standdown", race_id: raceId, winner, t_s: now() });
    }
    for (const c of inflight.values())
      c.controller.abort();
    await Promise.allSettled([...inflight.values()].map((c) => c.promise));
    while (finished.length) {
      const r = finished.shift();
      results[r.name] ??= r;
      emit({ event: "attempt_done", race_id: raceId, name: r.name, ok: r.ok, valid: r.valid, cancelled: r.cancelled, latency_s: r.latencyS, error: r.error });
    }
  }
  return { winner, winnerOutput, winnerTruncated, results };
}
function loadStrategies(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed?.strategies ?? parsed;
  if (!Array.isArray(list))
    throw new Error(`strategies file ${path} is not a list`);
  const strategies = list;
  for (const s of strategies) {
    if (!s?.name || !s?.cmd)
      throw new Error(`each strategy needs name + cmd: ${JSON.stringify(s)}`);
  }
  return strategies;
}
function logWinners(tag, winner, latency, logPath = WINNERS_LOG) {
  try {
    mkdirSync(dirname2(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify({ ts: Date.now() / 1000, tag, winner, latency })}
`, "utf8");
  } catch {}
}
function readWinners(tag, logPath = WINNERS_LOG) {
  const wins = {};
  const lats = {};
  let raw;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return { wins, lats };
  }
  for (const line of raw.split(`
`)) {
    if (!line.trim())
      continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.tag !== tag)
      continue;
    if (entry.winner)
      wins[entry.winner] = (wins[entry.winner] ?? 0) + 1;
    for (const [name, r] of Object.entries(entry.latency ?? {})) {
      (lats[name] ??= []).push(r?.latency_s ?? 1e9);
    }
  }
  return { wins, lats };
}
function medianLatency(values) {
  if (!values?.length)
    return 1e9;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function rankByRecord(items, tag, logPath) {
  const { wins, lats } = readWinners(tag, logPath);
  return items.map((item, i) => ({ item, i })).sort((a, b) => (wins[b.item.name] ?? 0) - (wins[a.item.name] ?? 0) || medianLatency(lats[a.item.name]) - medianLatency(lats[b.item.name]) || a.i - b.i).map((e) => e.item);
}
function hedgeOrder(tag, strategies, logPath) {
  return rankByRecord(strategies, tag, logPath);
}
function leadWithWinner(tag, strategies) {
  const { wins, lats } = readWinners(tag);
  const ranked = rankByRecord(strategies, tag).map((s) => ({
    name: s.name,
    wins: wins[s.name] ?? 0,
    medianLatencyS: medianLatency(lats[s.name])
  }));
  return { tag, winCounts: wins, ranked };
}

// src/measure.ts
function nowUs() {
  return performance.now() * 1000;
}
function distribution(samplesUs) {
  if (!samplesUs.length) {
    return { count: 0, minUs: 0, p50Us: 0, p95Us: 0, p99Us: 0, maxUs: 0, meanUs: 0 };
  }
  const sorted = [...samplesUs].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    count: sorted.length,
    minUs: sorted[0],
    p50Us: at(0.5),
    p95Us: at(0.95),
    p99Us: at(0.99),
    maxUs: sorted[sorted.length - 1],
    meanUs: sorted.reduce((a, b) => a + b, 0) / sorted.length
  };
}

// src/code-racer.ts
class CodeRacer {
  warmupRuns;
  testRuns;
  constructor(warmupRuns = 5, testRuns = 50) {
    this.warmupRuns = warmupRuns;
    this.testRuns = testRuns;
    if (warmupRuns < 0 || testRuns < 1)
      throw new Error("warmupRuns >= 0 and testRuns >= 1 required");
  }
  race(candidates) {
    if (!candidates.length)
      throw new Error("race needs at least one candidate");
    const rows = [];
    for (const candidate of candidates) {
      for (let i = 0;i < this.warmupRuns; i++) {
        try {
          candidate.impl();
        } catch {
          break;
        }
      }
      const samples = [];
      let failure = null;
      for (let i = 0;i < this.testRuns; i++) {
        const t0 = nowUs();
        try {
          candidate.impl();
        } catch (e) {
          failure = e.message;
          break;
        }
        samples.push(nowUs() - t0);
      }
      const dist = distribution(samples);
      rows.push({ name: candidate.name, distribution: dist, medianNs: dist.p50Us * 1000, ...failure ? { failure } : {} });
    }
    rows.sort((a, b) => rank(a) - rank(b));
    const first = rows[0];
    return { rows, winner: first && first.distribution.count > 0 ? first.name : null, warmupRuns: this.warmupRuns, testRuns: this.testRuns };
  }
  printLeaderboard(result) {
    const lines = [`=== Code Racer Leaderboard (${result.warmupRuns} warmup / ${result.testRuns} runs) ===`];
    const nameWidth = Math.max(4, ...result.rows.map((r) => r.name.length));
    for (const [i, row] of result.rows.entries()) {
      const d = row.distribution;
      const broken = d.count === 0;
      lines.push(`${broken ? " " : String(i + 1).padStart(2)}. ${row.name.padEnd(nameWidth)}  ` + (broken ? "FAILED" : `median ${fmtNs(row.medianNs)}  p95 ${fmtNs(d.p95Us * 1000)}  mean ${fmtNs(d.meanUs * 1000)}`));
    }
    lines.push(result.winner ? `winner: ${result.winner}` : "winner: none (every candidate failed)");
    return lines.join(`
`);
  }
}
var rank = (row) => row.distribution.count > 0 ? row.medianNs : Number.POSITIVE_INFINITY;
function fmtNs(ns) {
  if (ns < 1000)
    return `${ns.toFixed(1)}ns`;
  if (ns < 1e6)
    return `${(ns / 1000).toFixed(2)}\xB5s`;
  return `${(ns / 1e6).toFixed(2)}ms`;
}

// src/mcts.ts
class MCTSNode {
  stateId;
  parent;
  action;
  visits = 0;
  reward = 0;
  children = [];
  constructor(stateId, parent, action) {
    this.stateId = stateId;
    this.parent = parent;
    this.action = action;
  }
  get value() {
    return this.visits ? this.reward / this.visits : 0;
  }
  utcScore(explorationConstant, parentVisits) {
    if (this.visits === 0)
      return Number.POSITIVE_INFINITY;
    const exploit = this.value;
    const explore = explorationConstant * Math.sqrt(Math.log(Math.max(1, parentVisits)) / this.visits);
    return exploit + explore;
  }
}

class SWEMcts {
  maxDepth;
  timeoutSeconds;
  explorationConstant;
  root;
  startedAt = 0;
  constructor(maxDepth = 4, timeoutSeconds = 60, explorationConstant = Math.SQRT2) {
    this.maxDepth = maxDepth;
    this.timeoutSeconds = timeoutSeconds;
    this.explorationConstant = explorationConstant;
    if (maxDepth < 1)
      throw new Error("maxDepth must be >= 1");
    this.root = new MCTSNode("root", null, null);
  }
  get timedOut() {
    return (performance.now() - this.startedAt) / 1000 > this.timeoutSeconds;
  }
  select(node) {
    let current = node;
    while (current.children.length > 0) {
      current = current.children.reduce((best, child) => child.utcScore(this.explorationConstant, current.visits) > best.utcScore(this.explorationConstant, current.visits) ? child : best);
    }
    return current;
  }
  expand(node, candidateActions) {
    const made = candidateActions.map((action) => new MCTSNode(action.actionId, node, action));
    node.children.push(...made);
    if (made.length)
      emit({ event: "mcts_expand", state_id: node.stateId, children: made.length });
    return made;
  }
  backpropagate(node, reward) {
    for (let n = node;n !== null; n = n.parent) {
      n.visits += 1;
      n.reward += reward;
    }
  }
  getBestPatch() {
    if (!this.root.children.length)
      return { patch: null, stateId: null };
    const best = this.root.children.reduce((a, b) => b.value > a.value || b.value === a.value && b.visits > a.visits ? b : a);
    return { patch: best.action?.patch ?? null, stateId: best.stateId };
  }
  async search(candidatesByState, rollout) {
    const t0 = performance.now();
    this.startedAt = t0;
    let iterations = 0;
    let current = this.root;
    let timedOut = false;
    while (iterations < 1e4 && !this.timedOut) {
      iterations += 1;
      current = this.select(this.root);
      const depth = this.depthOf(current);
      if (depth >= this.maxDepth || current.children.length === 0) {
        const candidates = await candidatesByState(current.stateId);
        if (!candidates.length) {
          this.backpropagate(current, 0);
          continue;
        }
        const fresh = this.expand(current, candidates);
        if (fresh.length)
          current = fresh[0];
      }
      let reward = 0;
      try {
        reward = await rollout(current);
      } catch (e) {
        emit({ event: "mcts_rollout_failed", state_id: current.stateId, error: e.message });
        reward = 0;
      }
      this.backpropagate(current, reward);
    }
    if (this.timedOut)
      timedOut = true;
    const { patch, stateId } = this.getBestPatch();
    const result = {
      bestPatch: patch,
      bestStateId: stateId,
      iterations,
      nodesExplored: this.count(this.root),
      timedOut,
      elapsedS: (performance.now() - t0) / 1000
    };
    emit({ event: "mcts_done", ...result, best_patch: patch ? `${patch.slice(0, 120)}` : null });
    return result;
  }
  depthOf(node) {
    let d = 0;
    for (let n = node;n?.parent; n = n.parent)
      d += 1;
    return d;
  }
  count(node) {
    return 1 + node.children.reduce((sum, c) => sum + this.count(c), 0);
  }
}

// src/subgraph.ts
import { existsSync as existsSync2 } from "fs";
import { join as join3, relative as relative2, dirname as dirname3, resolve as resolvePath2 } from "path";
import { readFileSync as readFileSync2 } from "fs";
var TRACEBACK_FRAME = /^\s*File "([^"]+)", line (\d+), in (.+)$/;
var PY_TEST_FRAME = /^([^\s:]+\.py):(\d+):(?:\s+(\S+))?/;
var TS_FRAME = /at\s+(?:[\w.$<> ]+\s+\()?([^\s()]+):(\d+):(\d+)\)?/;
function extractTracebackFrames(output) {
  const frames = [];
  for (const line of output.split(`
`)) {
    let m = TRACEBACK_FRAME.exec(line);
    if (m) {
      frames.push({ file: m[1], line: Number(m[2]), symbol: m[3] });
      continue;
    }
    m = TS_FRAME.exec(line);
    if (m) {
      frames.push({ file: m[1], line: Number(m[2]), symbol: m[3] ?? null });
      continue;
    }
    m = PY_TEST_FRAME.exec(line);
    if (m) {
      frames.push({ file: m[1], line: Number(m[2]), symbol: m[3] ?? null });
    }
  }
  return frames;
}

class DynamicSubgraphInducer {
  rootDir;
  constructor(rootDir) {
    this.rootDir = rootDir;
    if (!existsSync2(rootDir))
      throw new Error(`root dir does not exist: ${rootDir}`);
    if (!isRepoRoot(rootDir))
      emit({ event: "inducer_unusual_root", root: rootDir });
  }
  induce(frames, opts = {}) {
    const { maxDepth = 3, maxNodes = 200 } = opts;
    const files = collectFiles(this.rootDir, { extensions: [...CODE_EXTS, ...PY_EXTS] }).files;
    const importsOf = new Map;
    const importedBy = new Map;
    for (const file of files) {
      const { imports } = extract(file, readText(file));
      importsOf.set(file, new Set);
      for (const spec of imports) {
        const target = resolveImport(file, spec, files);
        if (!target)
          continue;
        importsOf.get(file).add(target);
        const importers = importedBy.get(target) ?? new Set;
        importers.add(file);
        importedBy.set(target, importers);
      }
    }
    const roots = frames.map((f) => resolveFrameFile(f.file, this.rootDir, files)).filter((p) => p !== null);
    const tracebackSet = new Set(roots);
    const nodes = new Map;
    const edges = [];
    const fanIn = new Map;
    for (const root of roots) {
      const down = walk(root, importsOf, maxDepth, maxNodes);
      const up = walk(root, importedBy, maxDepth, maxNodes);
      for (const [path, depth] of [...down, ...up]) {
        const existing = nodes.get(path);
        if (existing) {
          existing.depth = Math.min(existing.depth, depth);
          continue;
        }
        nodes.set(path, { path, depth, symbols: [], inTraceback: tracebackSet.has(path) });
      }
      for (const [from, tos] of importsOf) {
        for (const to of tos)
          if (nodes.has(from) && nodes.has(to))
            edges.push({ from, to });
      }
    }
    for (const [path, node] of nodes) {
      if (node.symbols.length)
        continue;
      try {
        node.symbols = extract(path, readText(path)).symbols;
      } catch {
        continue;
      }
      fanIn.set(path, importedBy.get(path)?.size ?? 0);
    }
    const ordered = [...nodes.values()].sort((a, b) => {
      if (a.inTraceback !== b.inTraceback)
        return a.inTraceback ? -1 : 1;
      const f = (fanIn.get(b.path) ?? 0) - (fanIn.get(a.path) ?? 0);
      return f !== 0 ? f : a.depth - b.depth;
    });
    emit({ event: "subgraph_induced", roots: roots.length, nodes: ordered.length, edges: edges.length });
    return { nodes: ordered, edges, fanIn };
  }
}
function walk(start, adjacency, maxDepth, maxNodes) {
  const out = new Map([[start, 0]]);
  let frontier = [start];
  for (let depth = 1;depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node) ?? []) {
        if (out.has(neighbour))
          continue;
        if (out.size >= maxNodes)
          return out;
        out.set(neighbour, depth);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return out;
}
function resolveImport(from, spec, files) {
  if (!spec.startsWith("."))
    return null;
  const base = join3(dirname3(from), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.py`,
    join3(base, "index.ts"),
    join3(base, "index.tsx"),
    join3(base, "index.js")
  ];
  for (const candidate of candidates) {
    const normalised = resolvePath2(candidate);
    if (files.includes(normalised))
      return normalised;
  }
  return null;
}
function resolveFrameFile(framePath, rootDir, files) {
  if (existsSync2(framePath) && files.includes(resolvePath2(framePath)))
    return resolvePath2(framePath);
  const joined = resolvePath2(join3(rootDir, framePath));
  if (files.includes(joined))
    return joined;
  const tail = relative2(rootDir, resolvePath2(framePath));
  const bySuffix = files.find((f) => f.endsWith(tail));
  return bySuffix ?? null;
}
function readText(path) {
  return readFileSync2(path, "utf8");
}

// src/stack/cmdStack.ts
import { existsSync as existsSync6, readdirSync as readdirSync2, statSync as statSync3 } from "fs";
import { join as join7 } from "path";

// src/stack/targets.ts
import { join as join4 } from "path";
import { existsSync as existsSync3 } from "fs";
var RUNTIME_ROOT = process.env.FORGE_STACK_RUNTIME ?? "/home/toxic/var/runtime/forge/deploy";
function globPath(from, glob) {
  const p = join4(from, glob);
  return p;
}
var TARGETS = [
  {
    name: "kappa",
    build: {
      task: "kappa-build",
      cwd: "/home/toxic/pens/olympus/products/kappa/kappa-code",
      cache: true
    },
    artifact: {
      from: "/home/toxic/pens/olympus/products/kappa/kappa-code",
      glob: "packages/cli/dist/**/bin/kappa"
    },
    deploy: { slotDir: join4(RUNTIME_ROOT, "kappa"), ln: "active" },
    health: { kind: "http", url: "http://127.0.0.1:25159/", timeoutMs: 3000 },
    supervisor: "estate/kappa-acp",
    resolved(srcRoot) {
      const p = globPath(srcRoot, this.artifact.glob);
      return p;
    }
  },
  {
    name: "forge",
    build: {
      task: "forge-build",
      cwd: "/home/toxic/pens/barn/forge",
      cache: true
    },
    artifact: { from: "/home/toxic/pens/barn/forge", glob: "bin/forge.ts" },
    deploy: { slotDir: join4(RUNTIME_ROOT, "forge"), ln: "active" },
    health: {
      kind: "cli",
      argv: ["bun", "/home/toxic/pens/barn/forge/bin/forge.ts", "doctor"],
      timeoutMs: 30000
    },
    resolved(srcRoot) {
      const p = globPath(srcRoot, this.artifact.glob);
      return existsSync3(p) ? p : p;
    }
  }
];
function target(name) {
  if (name === "all")
    return;
  return TARGETS.find((t) => t.name === name);
}

// src/stack/bluegreen.ts
import {
  mkdirSync as mkdirSync2,
  readlinkSync,
  rmSync,
  statSync as statSync2,
  symlinkSync,
  writeFileSync,
  existsSync as existsSync4,
  renameSync
} from "fs";
import { join as join5 } from "path";
function slotState(slotDir, activeLink) {
  return {
    slotDir,
    activeLink,
    blue: join5(slotDir, "blue"),
    green: join5(slotDir, "green")
  };
}
function activeSlot(s) {
  try {
    const target = readlinkSync(s.activeLink);
    const base = target.split("/").pop() ?? "";
    return base === "green" ? "green" : base === "blue" ? "blue" : "none";
  } catch {
    return "none";
  }
}
function inactiveSlot(s) {
  mkdirSync2(s.blue, { recursive: true });
  mkdirSync2(s.green, { recursive: true });
  return activeSlot(s) === "green" ? "blue" : "green";
}
function stageBinary(s, binaryPath, version) {
  const slotName = inactiveSlot(s);
  const dir = join5(s.slotDir, slotName);
  mkdirSync2(dir, { recursive: true });
  const dest = join5(dir, version);
  if (!existsSync4(dest)) {
    const cp = Bun.spawnSync(["cp", binaryPath, dest], {
      stdout: "ignore",
      stderr: "pipe"
    });
    if (cp.exitCode !== 0) {
      throw new Error(`stage: cp ${binaryPath} -> ${dest} failed: ${(cp.stderr?.toString?.() ?? "").trim()}`);
    }
  }
  writeFileSync(join5(dir, "VERSION"), `${version}
`, "utf8");
  const latest = join5(dir, "latest");
  if (!existsSync4(latest)) {
    try {
      symlinkSync(version, latest);
    } catch {}
  }
  return { slot: slotName, dir };
}
function flipActive(s, to) {
  const prior = activeSlot(s);
  mkdirSync2(s.slotDir, { recursive: true });
  const target = to === "green" ? join5(s.slotDir, "green") : join5(s.slotDir, "blue");
  const tmp = `${s.activeLink}.tmp-${Date.now()}`;
  symlinkSync(target, tmp);
  rmSync(s.activeLink, { force: true });
  renameSync(tmp, s.activeLink);
  return prior;
}
function rollbackActive(s, to) {
  flipActive(s, to);
}
function mainShortHash(gitRoot) {
  const out = Bun.spawnSync(["git", "-C", gitRoot, "rev-parse", "--short", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: gitRoot
  });
  const h = (out.stdout?.toString?.() ?? "").trim();
  return h || "unknown";
}

// src/stack/health.ts
import { readFileSync as readFileSync3, existsSync as existsSync5 } from "fs";
import { join as join6 } from "path";
async function probeHttp(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return {
      ok: res.ok || res.status < 500,
      detail: `http ${res.status} ${url}`
    };
  } catch (e) {
    return { ok: false, detail: `unreachable ${url}: ${e.message}` };
  }
}
async function probeCli(argv, timeoutMs, cwd) {
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);
    const tail = (out || err).trim().split(`
`).slice(-1).join("");
    return {
      ok: code === 0,
      detail: `cli[${argv.join(" ")}] -> exit ${code} ${tail ? `(${tail.slice(0, 80)})` : ""}`
    };
  } catch (e) {
    return { ok: false, detail: `cli ${argv[0]}: ${e.message}` };
  }
}
function readVersionMarker(slotDir) {
  for (const slot of ["blue", "green"]) {
    const marker = join6(slotDir, slot, "VERSION");
    if (existsSync5(marker)) {
      try {
        const v = readFileSync3(marker, "utf8").trim();
        if (v)
          return v;
      } catch {}
    }
  }
  return null;
}
async function checkTarget(t, opts) {
  const timeout = t.health.timeoutMs ?? 3000;
  let probe;
  if (t.health.kind === "http") {
    probe = await probeHttp(t.health.url, timeout);
  } else {
    probe = await probeCli(t.health.argv, timeout, t.health.kind === "cli" ? undefined : undefined);
  }
  const res = {
    target: t.name,
    ok: probe.ok,
    detail: probe.detail,
    deep: opts.deep
  };
  if (opts.deep && opts.gitRoot) {
    res.expectedVersion = mainShortHash(opts.gitRoot);
    res.version = readVersionMarker(t.deploy.slotDir) ?? undefined;
    const matches = res.expectedVersion === res.version;
    if (!matches) {
      res.ok = false;
      res.detail = `deep: deployed ${res.version ?? "(none)"} != current main ${res.expectedVersion} (${probe.detail})`;
    }
  }
  return res;
}
function renderHealth(results) {
  const width = Math.max(...results.map((r) => r.target.length), 6);
  const lines = ["=== stack health ==="];
  for (const r of results) {
    const tag = r.deep ? r.ok ? "GREEN " : "STALE " : r.ok ? "PASS  " : "FAIL  ";
    lines.push(`${tag}${r.target.padEnd(width)}  ${r.detail}`);
  }
  const allOk = results.every((r) => r.ok);
  lines.push(allOk ? "== all targets healthy ==" : `== ${results.filter((r) => !r.ok).length} target(s) unhealthy ==`);
  return lines;
}

// src/stack/cmdStack.ts
var str = (flags, key, fallback) => {
  const raw = flags.get(key);
  return typeof raw === "string" ? raw : fallback;
};
function expandTargets(want) {
  if (want === "all")
    return TARGETS;
  const t = target(want);
  if (t)
    return [t];
  return [];
}
function gitRootFor(t) {
  return t.build?.cwd ?? t.artifact.from;
}
async function runBuild(t, dryRun) {
  if (!t.build)
    throw new Error(`target "${t.name}" has no build task`);
  const cwd = t.build.cwd;
  if (dryRun) {
    process.stdout.write(`  [dry-run] mise run ${t.build.task} (cwd=${cwd})
`);
    return true;
  }
  const res = Bun.spawnSync(["mise", "run", t.build.task], {
    cwd,
    stdout: "inherit",
    stderr: "inherit"
  });
  return res.exitCode === 0;
}
function findArtifact(t) {
  const from = t.artifact.from;
  const glob = t.artifact.glob;
  if (glob.includes("*")) {
    const base = glob.split("*")[0];
    const tail = glob.split("**/").pop() ?? "";
    const root = join7(from, base);
    if (!existsSync6(root))
      return null;
    return findByTail(root, tail);
  }
  const p = t.resolved(from);
  return existsSync6(p) ? p : null;
}
function findByTail(dir, leaf) {
  let entries = [];
  try {
    entries = readdirSync2(dir);
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (ent.startsWith("."))
      continue;
    const full = join7(dir, ent);
    let st;
    try {
      st = statSync3(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const hit = findByTail(full, leaf);
      if (hit)
        return hit;
    } else if (full.endsWith(leaf) && leaf) {
      return full;
    }
  }
  return null;
}
async function deployTarget(t, opts) {
  const s = slotState(t.deploy.slotDir, join7(t.deploy.slotDir, t.deploy.ln));
  const version = opts.version ?? mainShortHash(opts.gitRoot);
  if (opts.dryRun) {
    process.stdout.write(`  [dry-run] stage ${t.name}@${version} into ${s.slotDir} then flip active
`);
    return true;
  }
  const artifact = findArtifact(t);
  if (!artifact) {
    process.stderr.write(`deploy ${t.name}: no artifact at ${t.artifact.from}/${t.artifact.glob} (build first?)
`);
    return false;
  }
  stageBinary(s, artifact, version);
  const staged = activeSlot(s) === "green" ? "blue" : "green";
  flipActive(s, staged);
  process.stdout.write(`  deployed ${t.name} -> active=${staged} version=${version}
`);
  return true;
}
async function healthTarget(t, opts) {
  if (opts.dryRun) {
    return {
      target: t.name,
      ok: true,
      detail: "[dry-run] would probe " + (t.health.kind === "http" ? t.health.url : t.health.argv.join(" ")),
      deep: opts.deep
    };
  }
  return checkTarget(t, { deep: opts.deep, gitRoot: opts.gitRoot });
}
var STACK_HELP = `forge stack \u2014 layered build/deploy/health/go across Greek targets.

usage:
  forge stack targets
  forge stack build   --target <name>|all [--no-cache] [--dry-run]
  forge stack deploy  --target <name>|all [--version <hash>] [--dry-run]
  forge stack health  [--target <name>|all] [--deep] [--dry-run]
  forge stack go      --target <name>|all [--version <hash>] [--no-build]
                      [--no-restart] [--dry-run]

targets: ${TARGETS.map((t) => t.name).join(", ")} (or "all")
`;
async function cmdStack(args) {
  const sub = args._[0];
  const targetName = str(args.flags, "target", "all");
  const dryRun = args.flags.get("dry-run") === true;
  const deep = args.flags.get("deep") === true;
  const noBuild = args.flags.get("no-build") === true;
  const noRestart = args.flags.get("no-restart") === true;
  const targets = expandTargets(targetName);
  if (targets.length === 0 && sub !== "targets") {
    process.stderr.write(`stack: unknown target "${targetName}" (known: ${TARGETS.map((t) => t.name).join(", ")})
`);
    return 2;
  }
  switch (sub) {
    case "targets": {
      for (const t of TARGETS) {
        process.stdout.write(`  ${t.name.padEnd(8)} build=${t.build?.task ?? "-"}  probe=${t.health.kind}:${t.health.kind === "http" ? t.health.url : t.health.argv.join(" ")}
`);
      }
      return 0;
    }
    case "build": {
      let ok = true;
      for (const t of targets) {
        process.stdout.write(`forge stack build: ${t.name}
`);
        if (!await runBuild(t, dryRun))
          ok = false;
      }
      return ok ? 0 : 1;
    }
    case "deploy": {
      const version = str(args.flags, "version", "");
      let ok = true;
      for (const t of targets) {
        process.stdout.write(`forge stack deploy: ${t.name}
`);
        if (!await deployTarget(t, {
          version: version || undefined,
          dryRun,
          gitRoot: gitRootFor(t)
        }))
          ok = false;
      }
      return ok ? 0 : 1;
    }
    case "health": {
      const results = [];
      for (const t of targets)
        results.push(await healthTarget(t, { deep, dryRun, gitRoot: gitRootFor(t) }));
      for (const line of renderHealth(results))
        process.stdout.write(`${line}
`);
      return results.every((r) => r.ok) ? 0 : 1;
    }
    case "go": {
      if (!noBuild) {
        for (const t of targets) {
          process.stdout.write(`forge stack go: building ${t.name}
`);
          if (!await runBuild(t, dryRun)) {
            process.stderr.write(`forge stack go: build failed for ${t.name}
`);
            return 1;
          }
        }
      } else if (dryRun) {
        process.stdout.write(`  [dry-run] skipping build (--no-build)
`);
      }
      const prior = {};
      for (const t of targets) {
        process.stdout.write(`forge stack go: deploying ${t.name}
`);
        if (dryRun) {
          const s = slotState(t.deploy.slotDir, join7(t.deploy.slotDir, t.deploy.ln));
          process.stdout.write(`  [dry-run] stage+flip ${t.name} (prior=${activeSlot(s)})
`);
          continue;
        }
        const version = str(args.flags, "version", "").trim() || mainShortHash(gitRootFor(t));
        const ok = await deployTarget(t, {
          version,
          dryRun: false,
          gitRoot: gitRootFor(t)
        });
        if (!ok)
          return 1;
        prior[t.name] = activeSlot(slotState(t.deploy.slotDir, join7(t.deploy.slotDir, t.deploy.ln)));
      }
      if (!dryRun && !noRestart) {
        for (const t of targets) {
          if (!t.supervisor) {
            process.stdout.write(`forge stack go: no supervisor for ${t.name}; skipping restart
`);
            continue;
          }
          process.stdout.write(`forge stack go: restarting ${t.supervisor}
`);
          const r = Bun.spawnSync(["pitchfork", "restart", t.supervisor], {
            stdout: "inherit",
            stderr: "inherit"
          });
          if (r.exitCode !== 0) {
            process.stderr.write(`forge stack go: restart ${t.supervisor} failed (exit ${r.exitCode})
`);
            process.stderr.write(`forge stack go: NOT rolling back automatically on restart failure \u2014 health gate follows
`);
          }
        }
      }
      let allOk = true;
      for (const t of targets) {
        const h = await healthTarget(t, {
          deep,
          dryRun,
          gitRoot: gitRootFor(t)
        });
        process.stdout.write(`${deep ? h.ok ? "  GREEN " : "  STALE " : h.ok ? "  PASS  " : "  FAIL  "}${t.name}: ${h.detail}
`);
        if (!h.ok)
          allOk = false;
      }
      if (dryRun) {
        process.stdout.write(`forge stack go: [dry-run] complete
`);
        return 0;
      }
      if (allOk) {
        process.stdout.write(`forge stack go: all targets healthy
`);
        return 0;
      }
      process.stderr.write(`forge stack go: health gate failed \u2014 rolling back active slot(s)
`);
      for (const t of targets) {
        const p = prior[t.name];
        if (!p || p === "none")
          continue;
        const s = slotState(t.deploy.slotDir, join7(t.deploy.slotDir, t.deploy.ln));
        rollbackActive(s, p);
        process.stdout.write(`forge stack go: rolled back ${t.name} to ${p}
`);
      }
      return 1;
    }
    case "--help":
    case "help":
    default:
      process.stdout.write(`${STACK_HELP}
`);
      return sub === "help" ? 0 : 2;
  }
}
// src/providers/http.ts
import {
  appendFileSync as appendFileSync2,
  existsSync as existsSync7,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync4,
  renameSync as renameSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { homedir } from "os";
import { join as join8 } from "path";
var SHINGLE_CACHE = join8(homedir(), ".cache", "pattern-forge");
var SECRETSMITH = "secretsmith";
var USER_AGENT = "pattern-forge/1.0";
var POLITE_MAILTO = "pattern-forge@localhost";
function resolveSecretsmithKey(name) {
  let out = "";
  try {
    const proc = Bun.spawnSync([
      "secretsmith",
      "get",
      "--label",
      name,
      "--show"
    ]);
    out = proc.stdout.toString();
    if (proc.exitCode !== 0) {
      out = (out || proc.stderr.toString() || "").trim() || `secretsmith get failed (exit ${proc.exitCode ?? "?"}) for ${name}`;
    }
  } catch (e) {
    return {
      key: "",
      from: `secretsmith unavailable: ${e.message ?? e}`
    };
  }
  const secretLine = out.split(`
`).map((s) => s.trim()).find((s) => s.startsWith("secret:"));
  const candidate = secretLine ? secretLine.slice("secret:".length).trim() : "";
  if (isPlausibleKey(candidate))
    return { key: candidate, from: SECRETSMITH };
  const fallback = out.split(`
`).map((s) => s.trim()).find((s) => s && !/^(label|path|content_type|attr|secret|usage|error|no items)/i.test(s));
  if (isPlausibleKey(fallback))
    return { key: fallback, from: SECRETSMITH };
  return { key: "", from: "secretsmith returned no parseable key" };
}
function isPlausibleKey(s) {
  return !!s && s.length >= 20 && !/\s/.test(s) && /^[A-Za-z0-9_\-:.]+$/.test(s);
}
var SECRET_KEYS = {
  github: "GITHUB_TOKEN",
  s2: "S2_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
  serper: "SERPER_API_KEY",
  tavily: "TAVILY_API_KEY"
};
function resolveKey(provider) {
  const label = SECRET_KEYS[provider];
  const sm = resolveSecretsmithKey(label);
  if (sm.key)
    return sm;
  const env = process.env[label] || "";
  if (env.trim())
    return { key: env.trim(), from: "environment" };
  return { key: "", from: `not found (${label})` };
}
function resolveGithubToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env?.trim())
    return { key: env.trim(), from: "environment" };
  for (const envFile of [
    join8(homedir(), ".secrets"),
    join8(homedir(), ".bashrc.env")
  ]) {
    try {
      const vault = readFileSync4(envFile, "utf8");
      const m = /^\s*(?:export\s+)?(?:GITHUB_TOKEN|GH_TOKEN)\s*=\s*["']?([^"'\n#]+)["']?/m.exec(vault);
      if (m?.[1]?.trim())
        return { key: m[1].trim(), from: `${envFile} (vault)` };
    } catch {}
  }
  try {
    const proc = Bun.spawnSync(["gh", "auth", "token"]);
    const tok = proc.stdout.toString().trim();
    if (tok && !tok.startsWith("HTTP") && !tok.includes("error"))
      return { key: tok, from: "gh auth token" };
  } catch {}
  const sm = resolveSecretsmithKey("GITHUB_TOKEN");
  if (sm.key)
    return sm;
  return { key: "", from: "not found" };
}
async function throttle(key, minIntervalMs = 1000) {
  const stateFile = join8(SHINGLE_CACHE, `lit_${key}.json`);
  let last = 0;
  try {
    last = JSON.parse(readFileSync4(stateFile, "utf8")).last ?? 0;
  } catch {
    last = 0;
  }
  const wait = minIntervalMs - (Date.now() / 1000 - last) * 1000;
  if (wait > 0)
    await Bun.sleep(wait);
  try {
    mkdirSync3(SHINGLE_CACHE, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    writeFileSync2(tmp, JSON.stringify({ last: Date.now() / 1000 }), "utf8");
    renameSync2(tmp, stateFile);
  } catch {}
}
async function fetchJson(url, init = {}) {
  const {
    timeoutMs = 15000,
    maxRetries = 0,
    retryDelayMs = 1000,
    ...rest
  } = init;
  let lastErr = "";
  for (let attempt = 0;attempt <= maxRetries; attempt++) {
    const t0 = performance.now();
    let controller = null;
    let signal;
    if (typeof AbortSignal.timeout === "function") {
      signal = AbortSignal.timeout(timeoutMs);
    } else {
      controller = new AbortController;
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      queueMicrotask(() => clearTimeout(timer));
      signal = controller.signal;
    }
    try {
      const res = await fetch(url, { ...rest, signal });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
        const delay = retryAfter > 0 ? retryAfter * 1000 : retryDelayMs * (attempt + 1);
        lastErr = `HTTP ${res.status}`;
        if (attempt < maxRetries) {
          await Bun.sleep(delay);
          continue;
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.ok)
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      const trimmed = text.trim();
      if (trimmed.startsWith("<")) {
        throw new Error(`Non-JSON response (HTML/Challenge) from ${url.split("?")[0]}`);
      }
      return { data: JSON.parse(text), ms: performance.now() - t0 };
    } catch (e) {
      lastErr = String(e?.message ?? e).slice(0, 200);
      const isNetwork = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|timeout|SIGTERM/i.test(lastErr);
      if (isNetwork && attempt < maxRetries) {
        await Bun.sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr || "fetchJson exhausted retries");
}
var EXPECTED_DEGRADE_PATTERNS = [
  /HTTP 429/,
  /Unrecognized token '<'/,
  /bot[-\s]?check/i,
  /captcha/i,
  /cloudflare/i,
  /ENOTFOUND/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /fetch failed/i,
  /timeout after/i,
  /challenge persisted/i
];
function isExpectedDegrade(error) {
  return EXPECTED_DEGRADE_PATTERNS.some((re) => re.test(error));
}
async function safeCall(name, fn) {
  try {
    const result = await fn();
    if (!result.ok)
      emit({
        event: "source_degraded",
        source: name,
        error: result.error,
        expected: isExpectedDegrade(result.error ?? "")
      });
    return result;
  } catch (e) {
    const message = String(e.message);
    emit({
      event: "source_degraded",
      source: name,
      error: message,
      expected: isExpectedDegrade(message)
    });
    return { ok: false, items: [], cost: "free", error: message.slice(0, 160) };
  }
}
// src/providers/npm.ts
function bm25DocScore(doc, query) {
  const docT = new Set(tokenize(doc));
  const q = tokenize(query);
  if (docT.size === 0 || q.length === 0)
    return 0;
  let hits = 0;
  for (const t of q)
    if (docT.has(t))
      hits++;
  return hits / q.length;
}
async function npmSearch(query, perPage = 5) {
  const { data, ms } = await fetchJson(`https://registry.npmjs.org/-/v1/search?${new URLSearchParams({ text: query, size: String(perPage) })}`, { headers: { "User-Agent": USER_AGENT }, timeoutMs: 1e4 });
  const body = data;
  const items = (body.objects ?? []).map((o) => {
    const p = o.package ?? {};
    return {
      name: p.name ?? null,
      path: null,
      repo: p.links?.repository ?? null,
      html_url: p.links?.npm ?? null,
      score: p.score ?? null,
      description: p.description ?? "",
      language: "javascript",
      stars: (p.publisher ? 1 : 0, p.version ? undefined : undefined),
      bm25: bm25DocScore(`${p.name ?? ""} ${p.description ?? ""} ${(p.keywords ?? []).join(" ")}`, query)
    };
  });
  return {
    ok: true,
    items,
    cost: "free",
    totalCount: body.total ?? null,
    timingMs: ms,
    ranking: "npm search score"
  };
}

// src/providers/github.ts
async function githubCodeSearch(query, perPage = 5) {
  const token = resolveGithubToken();
  if (!token.key) {
    return {
      ok: false,
      items: [],
      cost: "free",
      error: "no GITHUB_TOKEN (checked environment and $HOME/.secrets); GitHub code search requires authentication"
    };
  }
  const url = `https://api.github.com/search/code?${new URLSearchParams({ q: query, per_page: String(perPage) })}`;
  const { data, ms } = await fetchJson(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token.key}`
    },
    timeoutMs: 1e4,
    maxRetries: 2,
    retryDelayMs: 800
  });
  const body = data;
  const items = (body.items ?? []).map((it) => ({
    name: it.name ?? null,
    path: it.path ?? null,
    repo: it.repository?.full_name ?? null,
    html_url: it.html_url ?? null,
    score: it.score ?? null
  }));
  return {
    ok: true,
    items,
    cost: "free",
    totalCount: body.total_count ?? null,
    timingMs: ms,
    ranking: "best-match relevance (not stars)"
  };
}
async function githubRepoSearch(query, perPage = 5, opts = {}) {
  const token = resolveGithubToken();
  const params = new URLSearchParams({ q: query, per_page: String(perPage) });
  if (opts.sort === "stars")
    params.set("sort", "stars");
  const url = `https://api.github.com/search/repositories?${params}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token.key)
    headers.Authorization = `Bearer ${token.key}`;
  const { data, ms } = await fetchJson(url, {
    headers,
    timeoutMs: 1e4,
    maxRetries: 2,
    retryDelayMs: 800
  });
  const body = data;
  const items = (body.items ?? []).map((it) => {
    const full = it.full_name ?? null;
    const desc = it.description ?? "";
    const topics = it.topics ?? [];
    return {
      name: it.name ?? null,
      path: null,
      repo: full,
      html_url: it.html_url ?? (full ? `https://github.com/${full}` : null),
      score: it.stargazers_count ?? 0,
      description: desc,
      language: it.language ?? null,
      topics,
      stars: it.stargazers_count ?? 0,
      bm25: bm25DocScore(`${(full ?? "").replace(/[-_/]/g, " ")} ${desc} ${topics.join(" ")}`, query)
    };
  });
  return {
    ok: true,
    items,
    cost: "free",
    totalCount: body.total_count ?? null,
    timingMs: ms,
    ranking: token.key ? "GitHub relevance; BM25 rerank over name/description/topics" : "GitHub relevance (unauthenticated)"
  };
}
// src/providers/arxiv.ts
import { appendFileSync as appendFileSync3, mkdirSync as mkdirSync4 } from "fs";
import { join as join9 } from "path";
var ARXIV_BASE = "https://export.arxiv.org";
function parseAtom(xml) {
  const entries = xml.split("<entry>").slice(1);
  const tag = (entry, name) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
    return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : "";
  };
  return entries.map((entry) => ({
    title: tag(entry, "title"),
    authors: [
      ...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)
    ].map((m) => decodeEntities(m[1].trim())),
    published: tag(entry, "published").slice(0, 10),
    url: tag(entry, "id") || null,
    summary: tag(entry, "summary").slice(0, 500)
  }));
}
function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, "&");
}
async function arxivSearch(query, maxResults, opts = {}) {
  const { timeoutMs = 12000, maxRetries = 3 } = opts;
  const url = `${ARXIV_BASE}/api/query?${new URLSearchParams({
    search_query: `all:${query}`,
    start: "0",
    max_results: String(maxResults),
    sortBy: "relevance",
    sortOrder: "descending"
  })}`;
  throttle("arxiv", 3500);
  let lastError = "";
  for (let attempt = 0;attempt <= maxRetries; attempt++) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
        auditArxiv({
          t_ms: performance.now() - t0,
          attempt,
          ok: false,
          status: res.status,
          query
        });
        Bun.sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        auditArxiv({
          t_ms: performance.now() - t0,
          attempt,
          ok: false,
          status: res.status,
          query
        });
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const xml = await res.text();
      const ms = performance.now() - t0;
      auditArxiv({ t_ms: ms, attempt, ok: true, status: 200, query });
      return {
        ok: true,
        items: parseAtom(xml),
        cost: "free",
        ranking: "relevance",
        timingMs: ms,
        retries: attempt
      };
    } catch (e) {
      lastError = String(e.message);
      auditArxiv({
        t_ms: performance.now() - t0,
        attempt,
        ok: false,
        status: 0,
        query,
        error: lastError
      });
    }
  }
  return {
    ok: false,
    items: [],
    cost: "free",
    error: lastError || "arxiv exhausted retries"
  };
}
function auditArxiv(record) {
  try {
    mkdirSync4(SHINGLE_CACHE, { recursive: true });
    appendFileSync3(join9(SHINGLE_CACHE, "arxiv_audit.jsonl"), `${JSON.stringify({ ts: Date.now() / 1000, ...record })}
`, "utf8");
  } catch {}
}
// src/providers/openalex.ts
var OPENALEX_BASE = "https://api.openalex.org";
function abstractFromInvertedIndex(inv) {
  if (!inv)
    return "";
  const positions = [];
  for (const [word, idxs] of Object.entries(inv))
    for (const i of idxs)
      positions.push([i, word]);
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(" ").slice(0, 600);
}
function arxivIdFrom(ids) {
  const m = /arxiv\.org\/(?:abs|pdf)\/([^\s"'<>]+)/.exec(ids?.arxiv ?? "");
  return m ? m[1] : null;
}
var OA_SELECT = "id,doi,ids,title,publication_year,authorships,abstract_inverted_index,cited_by_count,primary_location";
function openAlexWorkToItem(w) {
  const doi = w.doi ?? null;
  return {
    title: w.title ?? null,
    authors: (w.authorships ?? []).slice(0, 6).map((a) => a.author?.display_name ?? "").filter(Boolean),
    year: w.publication_year ?? null,
    citedByCount: w.cited_by_count ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    arxivId: arxivIdFrom(w.ids),
    doi: (doi ?? "").replace("https://doi.org/", "") || null,
    url: doi ?? w.id ?? null,
    openAlexId: w.id ?? null,
    summary: abstractFromInvertedIndex(w.abstract_inverted_index)
  };
}
async function openAlexSearch(query, maxResults) {
  throttle("openalex", 1000);
  const url = `${OPENALEX_BASE}/works?${new URLSearchParams({
    search: query,
    "per-page": String(Math.max(1, Math.min(25, maxResults))),
    mailto: POLITE_MAILTO,
    select: OA_SELECT
  })}`;
  const { data, ms } = await fetchJson(url, {
    headers: { "User-Agent": USER_AGENT }
  });
  const body = data;
  return {
    ok: true,
    items: (body.results ?? []).map(openAlexWorkToItem),
    cost: "free",
    ranking: "relevance",
    timingMs: ms,
    note: "covers arXiv + journals + preprints"
  };
}
// src/providers/semanticscholar.ts
import { readFileSync as readFileSync5 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join10 } from "path";
var S2_BASE = "https://api.semanticscholar.org";
function s2ToItem(p) {
  return {
    title: p.title ?? null,
    authors: (p.authors ?? []).slice(0, 6).map((a) => a.name ?? ""),
    year: p.year ?? null,
    citationCount: p.citationCount ?? null,
    arxivId: p.externalIds?.ArXiv ?? null,
    doi: p.externalIds?.DOI ?? null,
    url: p.url ?? null,
    pdfUrl: p.openAccessPdf?.url ?? null,
    summary: (p.abstract ?? "").slice(0, 600)
  };
}
function resolveS2Key(explicit = "") {
  if (explicit)
    return { key: explicit, from: "explicit" };
  const env = process.env.S2_API_KEY || process.env.SEMANTIC_SCHOLAR_API_KEY || "";
  if (env)
    return { key: env, from: "environment" };
  try {
    const vault = readFileSync5(join10(homedir2(), ".secrets"), "utf8");
    for (const line of vault.split(`
`)) {
      const m = /^\s*(?:export\s+)?S2_API_KEY\s*=\s*\"?([^"\s]+)\"?/.exec(line) || /^\s*(?:export\s+)?SEMANTIC_SCHOLAR_API_KEY\s*=\s*\"?([^"\s]+)\"?/.exec(line);
      if (m?.[1])
        return { key: m[1], from: "$HOME/.secrets" };
    }
  } catch {}
  return { key: "", from: "none" };
}
async function s2Search(query, maxResults, explicitKey = "") {
  throttle("semanticscholar", 1000);
  const url = `${S2_BASE}/graph/v1/paper/search?${new URLSearchParams({
    query,
    limit: String(Math.max(1, Math.min(25, maxResults))),
    fields: "title,abstract,authors,year,url,openAccessPdf,citationCount,externalIds"
  })}`;
  const key = resolveS2Key(explicitKey);
  const headers = { "User-Agent": USER_AGENT };
  if (key.key)
    headers["x-api-key"] = key.key;
  try {
    const { data, ms } = await fetchJson(url, {
      headers,
      timeoutMs: 8000,
      maxRetries: 1
    });
    const body = data;
    return {
      ok: true,
      items: (body.data ?? []).map(s2ToItem),
      cost: "free",
      ranking: key.key ? "relevance (authenticated)" : "relevance",
      timingMs: ms
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      cost: "free",
      error: String(e?.message ?? e).slice(0, 160),
      retries: 1
    };
  }
}
// src/providers/dblp.ts
var DBLP_BASE = "https://dblp.org/search/publ/api";
async function dblpSearch(query, maxResults, opts = {}) {
  throttle("dblp", 1000);
  const maxRetries = opts.retries ?? 2;
  const mkUrl = () => `${DBLP_BASE}?${new URLSearchParams({ q: query, format: "json", h: String(Math.max(1, Math.min(30, maxResults))), c: "0" })}`;
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };
  let lastError = "unknown";
  const t0 = performance.now();
  for (let attempt = 0;attempt <= maxRetries; attempt++) {
    try {
      const { data } = await fetchJson(mkUrl(), {
        headers,
        timeoutMs: 8000
      });
      const body = data;
      const hits = body.result?.hits?.hit ?? [];
      const items = hits.map((h) => {
        const info = h.info ?? {};
        const raw = info.authors?.author ?? [];
        const list = Array.isArray(raw) ? raw : [raw];
        return {
          title: info.title ?? null,
          authors: list.filter((a) => typeof a === "object" && a !== null).slice(0, 6).map((a) => a.text ?? ""),
          venue: info.venue ?? null,
          year: Number(info.year ?? 0) || null,
          url: info.url ?? null,
          summary: ""
        };
      });
      return {
        ok: true,
        items,
        cost: "free",
        timingMs: performance.now() - t0,
        ranking: "relevance",
        retriesUsed: attempt
      };
    } catch (err) {
      const message = String(err.message ?? err);
      if (/HTTP 429|HTTP 5\d\d/i.test(message)) {
        return {
          ok: false,
          items: [],
          cost: "free",
          timingMs: performance.now() - t0,
          error: `dblp rate limited after ${attempt} retries: ${message}`
        };
      }
      lastError = message;
      if (/HTML|Challenge/i.test(lastError) && attempt < maxRetries) {
        await Bun.sleep(1500 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  return {
    ok: false,
    items: [],
    cost: "free",
    timingMs: performance.now() - t0,
    error: `dblp challenge persisted after ${maxRetries} retries: ${lastError}`
  };
}
// src/providers/stackoverflow.ts
async function stackoverflowSearch(query, perPage = 5) {
  const { data, ms } = await fetchJson(`https://api.stackexchange.com/2.3/search/advanced?${new URLSearchParams({
    q: query,
    order: "desc",
    sort: "relevance",
    site: "stackoverflow",
    pagesize: String(perPage),
    filter: "withbody"
  })}`, { headers: { "User-Agent": USER_AGENT }, timeoutMs: 8000 });
  const body = data;
  const items = (body.items ?? []).map((it) => ({
    title: it.title ?? null,
    authors: [
      it.owner?.display_name ?? ""
    ].filter(Boolean),
    venue: "stackoverflow",
    year: it.creation_date ? new Date(it.creation_date * 1000).getFullYear() : null,
    url: it.link ?? null,
    summary: String(it.body_markdown ?? it.body ?? "").slice(0, 500)
  }));
  return {
    ok: true,
    items,
    cost: "free",
    totalCount: body.total ?? null,
    timingMs: ms,
    ranking: "relevance+score"
  };
}
// src/providers/hf_papers.ts
var HF_PAPERS_BASE = "https://huggingface.co/api/papers/search";
async function hfPapersSearch(query, maxResults) {
  throttle("hf_papers", 1000);
  const url = `${HF_PAPERS_BASE}?${new URLSearchParams({ q: query })}`;
  const { data, ms } = await fetchJson(url, {
    headers: { "User-Agent": USER_AGENT },
    timeoutMs: 8000
  });
  const raw = Array.isArray(data) ? data : data.papers ?? data.results ?? [];
  const items = raw.filter((p) => typeof p === "object" && p !== null).slice(0, maxResults).map((p) => ({
    title: p.title ?? null,
    authors: (p.authors ?? []).slice(0, 6).map((a) => typeof a === "object" && a !== null ? a.name ?? "" : String(a)),
    published: p.publishedAt ?? p.published_at ?? null,
    arxivId: p.id ?? null,
    url: p.id ? `https://huggingface.co/papers/${String(p.id)}` : null,
    summary: (p.summary ?? p.abstract ?? "").slice(0, 600),
    upvotes: p.upvotes ?? null
  }));
  return {
    ok: true,
    items,
    cost: "free",
    ranking: "relevance",
    timingMs: ms,
    note: "HF paper search, AI/ML focused"
  };
}
// src/providers/web.ts
async function braveSearch(query, maxResults, apiKey = "") {
  const t0 = performance.now();
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(maxResults) })}`, {
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    const items = (data.web?.results ?? []).map((it) => ({
      title: it.title ?? null,
      authors: [],
      venue: "brave",
      url: it.url ?? null,
      summary: String(it.description ?? it.profile?.longDescription ?? "").slice(0, 500)
    }));
    return {
      ok: true,
      items,
      cost: "free",
      totalCount: items.length,
      timingMs: Math.round(performance.now() - t0),
      ranking: "brave-web"
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      cost: "free",
      error: `brave: ${e.message ?? e}`
    };
  }
}
async function serperSearch(query, maxResults, apiKey = "") {
  const t0 = performance.now();
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    const items = (data.organic ?? []).map((it) => ({
      title: it.title ?? null,
      authors: [],
      venue: "google",
      url: it.link ?? null,
      summary: String(it.snippet ?? "").slice(0, 500)
    }));
    return {
      ok: true,
      items,
      cost: "free",
      totalCount: items.length,
      timingMs: Math.round(performance.now() - t0),
      ranking: "google-organic"
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      cost: "free",
      error: `serper: ${e.message ?? e}`
    };
  }
}
async function tavilySearch(query, maxResults, apiKey = "") {
  const t0 = performance.now();
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    const items = (data.results ?? []).map((it) => ({
      title: it.title ?? null,
      authors: [],
      venue: "web",
      url: it.url ?? null,
      summary: String(it.content ?? "").slice(0, 500)
    }));
    return {
      ok: true,
      items,
      cost: "free",
      totalCount: items.length,
      timingMs: Math.round(performance.now() - t0),
      ranking: "tavily"
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      cost: "free",
      error: `tavily: ${e.message ?? e}`
    };
  }
}
// src/providers/exa.ts
import { appendFileSync as appendFileSync4, mkdirSync as mkdirSync5, readFileSync as readFileSync6 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join11 } from "path";
var EXA_BASE = "https://api.exa.ai/search";
function resolveExaKey(explicit = "") {
  if (explicit)
    return { key: explicit, from: "explicit flag" };
  const sm = resolveSecretsmithKey("EXA_API_KEY");
  if (sm.key)
    return sm;
  const fromEnv = process.env.EXA_API_KEY;
  if (fromEnv)
    return { key: fromEnv, from: "environment" };
  try {
    const vault = readFileSync6(join11(homedir3(), ".secrets"), "utf8");
    const hit = vault.match(/^\s*(?:export\s+)?EXA_API_KEY\s*=\s*["']?([^"'\n#]+)["']?/m);
    if (hit?.[1]?.trim())
      return { key: hit[1].trim(), from: "$HOME/.secrets (secretsmith vault)" };
  } catch (e) {
    return {
      key: "",
      from: `$HOME/.secrets unreadable: ${e.message ?? e}`
    };
  }
  return { key: "", from: "not found" };
}
async function exaSearch(query, numResults, apiKey) {
  const t0 = performance.now();
  try {
    const res = await fetch(EXA_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "x-api-key": apiKey
      },
      body: JSON.stringify({ query, type: "auto", numResults }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok)
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    logExaCall({
      ok: true,
      ms: performance.now() - t0,
      query,
      resultsReturned: data.results?.length ?? 0,
      costUsd: data.costDollars?.total ?? null
    });
    return {
      ok: true,
      cost: "exa-credits",
      timingMs: performance.now() - t0,
      items: (data.results ?? []).map((r) => ({
        title: r.title ?? null,
        url: r.url ?? null,
        publishedDate: r.publishedDate ?? null,
        score: r.score ?? null
      }))
    };
  } catch (e) {
    logExaCall({
      ok: false,
      ms: performance.now() - t0,
      query,
      error: String(e.message)
    });
    throw e;
  }
}
function logExaCall(call) {
  try {
    mkdirSync5(SHINGLE_CACHE, { recursive: true });
    appendFileSync4(join11(SHINGLE_CACHE, "exa_audit.jsonl"), `${JSON.stringify({ ts: Date.now() / 1000, ...call })}
`, "utf8");
  } catch {}
}
// src/providers/local.ts
async function localTreeSearch(query, maxResults = 10, root = ESTATE) {
  const t0 = performance.now();
  try {
    const idx = buildIndex(root, 1e4);
    const bm = new Bm25Index(idx.files);
    const hits = bm.search(query, maxResults);
    const items = hits.map((h) => ({
      name: h.path.split("/").pop() ?? h.path,
      path: h.path,
      repo: "local/estate",
      html_url: `file://${h.path}`,
      score: h.score
    }));
    return {
      ok: true,
      items,
      cost: "free",
      timingMs: performance.now() - t0,
      totalCount: items.length
    };
  } catch (err) {
    return {
      ok: false,
      items: [],
      cost: "free",
      timingMs: performance.now() - t0,
      error: String(err)
    };
  }
}
// src/providers/pattern-borrow.ts
var DEFAULT_PATTERNS = [
  "hot reload",
  "session restore",
  "jsonl session",
  "conversation reload",
  "fs.watch",
  "process reload",
  "resume session",
  "durable session"
];
var DEFAULT_BUG_TERMS = [
  "reload",
  "watch",
  "hot",
  "session",
  "conversation",
  "restore",
  "resume",
  "plugin",
  "borrow",
  "race"
];
var PATTERN_FACTORS = [
  "newest",
  "avgSize",
  "nRepos",
  "stars",
  "issues",
  "forks",
  "testFrac",
  "bugRel"
];
var DEFAULT_PATTERN_WEIGHTS = {
  newest: 0.1,
  avgSize: 0.1,
  nRepos: 0.12,
  stars: 0.14,
  issues: 0.12,
  forks: 0.08,
  testFrac: 0.06,
  bugRel: 0.28
};
var STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "with",
  "via",
  "using",
  "how",
  "best",
  "in",
  "of",
  "to",
  "on",
  "at",
  "by",
  "from",
  "into",
  "code",
  "implement",
  "implementation",
  "pattern",
  "patterns",
  "example",
  "examples",
  "real",
  "world",
  "real-world",
  "github",
  "repo",
  "repos"
]);
function toSearchTerms(positional) {
  const out = [];
  for (const p of positional) {
    if (p.includes("-") && p.length <= 40 && !p.includes(" ")) {
      out.push(p);
      continue;
    }
    const words = p.split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
    if (words.length <= 2) {
      out.push(words.join(" ") || p);
    } else {
      out.push(words.slice(0, 4).join(" "));
    }
  }
  return [...new Set(out.filter(Boolean))].slice(0, 6);
}
async function ghGet(path, token, params) {
  if (!token)
    return null;
  let url = `https://api.github.com${path}`;
  if (params)
    url += `?${new URLSearchParams(params).toString()}`;
  try {
    const { data } = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      timeoutMs: 8000,
      maxRetries: 1,
      retryDelayMs: 500
    });
    return data;
  } catch {
    return null;
  }
}
async function scanLocalCode(term, limit = 5, estateRoot = process.env.ESTATE ?? ESTATE) {
  try {
    const proc = Bun.spawn(["ffs", "grep", term, "--root", estateRoot, "--limit", String(limit)], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const out = await new Response(proc.stdout).text();
    const hits = [];
    for (const raw of out.split(`
`)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("["))
        continue;
      const parts = line.split(":");
      if (parts.length >= 2) {
        hits.push({ file: parts[0], line: parts.slice(1).join(":") });
      }
    }
    return hits;
  } catch {
    return [];
  }
}
async function repoStats(full, token) {
  const r = await ghGet(`/repos/${full}`, token);
  if (!r) {
    return {
      stars: 0,
      issues: 0,
      forks: 0,
      pushed: 0,
      hasTest: 0,
      description: "",
      language: "",
      license: "",
      url: `https://github.com/${full}`
    };
  }
  let hasTest = 0;
  const root = await ghGet(`/repos/${full}/contents/`, token);
  if (Array.isArray(root)) {
    const names = root.map((x) => String(x.name ?? "").toLowerCase());
    hasTest = names.some((n) => ["tests", "test", "__tests__", "spec", "crates", "packages"].includes(n)) ? 1 : 0;
  }
  const lic = r.license;
  return {
    stars: Number(r.stargazers_count ?? 0),
    issues: Number(r.open_issues_count ?? 0),
    forks: Number(r.forks_count ?? 0),
    pushed: typeof r.pushed_at === "string" ? Date.parse(r.pushed_at) / 1000 : 0,
    hasTest,
    description: String(r.description ?? ""),
    language: String(r.language ?? ""),
    license: String(lic?.spdx_id ?? lic?.name ?? ""),
    url: String(r.html_url ?? `https://github.com/${full}`)
  };
}
function rankPatternRows(rows, weights = DEFAULT_PATTERN_WEIGHTS) {
  for (const key of PATTERN_FACTORS) {
    const vals = rows.map((r) => Number(r[key] ?? 0));
    if (rows.length <= 1) {
      for (const r of rows)
        r[`n_${key}`] = 1;
      continue;
    }
    const mx = Math.max(...vals) || 1;
    const mn = Math.min(...vals);
    const rng = mx - mn || 1;
    for (const r of rows)
      r[`n_${key}`] = (Number(r[key] ?? 0) - mn) / rng;
  }
  const wsum = PATTERN_FACTORS.reduce((a, k) => a + (weights[k] ?? 0), 0) || 1;
  for (const r of rows) {
    r.score = PATTERN_FACTORS.reduce((a, k) => a + Number(r[`n_${k}`] ?? 0) * (weights[k] ?? 0), 0) / wsum;
  }
  rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
function collectTopPatternRepos(rows, topTerms, limit) {
  const repoMap = new Map;
  for (const r of rows.slice(0, topTerms)) {
    for (const repo of r.repos || []) {
      const existing = repoMap.get(repo.fullName);
      if (!existing) {
        repoMap.set(repo.fullName, { ...repo, terms: [r.term] });
      } else {
        if (!existing.terms)
          existing.terms = [];
        if (!existing.terms.includes(r.term))
          existing.terms.push(r.term);
        for (const f of repo.matchedFiles) {
          if (!existing.matchedFiles.includes(f))
            existing.matchedFiles.push(f);
        }
      }
    }
  }
  return Array.from(repoMap.values()).sort((a, b) => b.stars - a.stars).slice(0, limit);
}
async function patternBorrow(opts = {}) {
  const t0 = performance.now();
  const terms = opts.patterns?.length ? toSearchTerms(opts.patterns) : DEFAULT_PATTERNS;
  const top = opts.top ?? (opts.patterns?.length ? opts.patterns.length : 5);
  const perPage = opts.perPage ?? 5;
  const weights = { ...DEFAULT_PATTERN_WEIGHTS, ...opts.weights ?? {} };
  const token = opts.localOnly ? "" : resolveGithubToken().key;
  const estateRoot = opts.estateRoot ?? process.env.ESTATE ?? ESTATE;
  const rows = await Promise.all(terms.map(async (term) => {
    const [data, localHits] = await Promise.all([
      token ? ghGet("/search/code", token, { q: term, per_page: String(perPage) }) : Promise.resolve(null),
      scanLocalCode(term, perPage, estateRoot)
    ]);
    const repos = {};
    const matchedFiles = {};
    const sizes = [];
    if (localHits.length) {
      for (const h of localHits) {
        const rel = h.file.replace(`${estateRoot}/`, "");
        const key = `local:${rel}`;
        repos[key] = {
          stars: 9999,
          issues: 0,
          forks: 1,
          pushed: Math.floor(Date.now() / 1000),
          hasTest: 1,
          description: `In-tree pattern: ${h.line.trim().slice(0, 100)}`,
          language: rel.split(".").pop() ?? "ts",
          license: "estate",
          url: `file://${h.file}`
        };
        matchedFiles[key] = [rel];
      }
    }
    if (data?.items) {
      const uniqueRepos = new Set;
      for (const it of data.items) {
        const full = it.repository?.full_name;
        if (!full || full.startsWith("toxicwind/"))
          continue;
        if (!matchedFiles[full])
          matchedFiles[full] = [];
        if (it.path)
          matchedFiles[full].push(it.path);
        uniqueRepos.add(full);
        if (typeof it.size === "number")
          sizes.push(it.size);
      }
      const statsEntries = await Promise.all([...uniqueRepos].map(async (full) => [full, await repoStats(full, token)]));
      for (const [full, st] of statsEntries) {
        repos[full] = st;
      }
    }
    const vals = Object.values(repos);
    const nRepos = vals.length;
    const totalStars = vals.reduce((a, v) => a + v.stars, 0);
    const totalIssues = vals.reduce((a, v) => a + v.issues, 0);
    const totalForks = vals.reduce((a, v) => a + v.forks, 0);
    const pushed = vals.map((v) => v.pushed).filter((x) => x > 0);
    const newest = pushed.length ? Math.max(...pushed) : 0;
    const testFrac = nRepos ? vals.reduce((a, v) => a + v.hasTest, 0) / nRepos : 0;
    const avgSize = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
    const bugRel = DEFAULT_BUG_TERMS.reduce((a, t) => a + (term.toLowerCase().match(new RegExp(t, "g"))?.length ?? 0), 0);
    const repoList = Object.entries(repos).map(([fullName, st]) => ({
      fullName,
      ...st,
      matchedFiles: matchedFiles[fullName] ?? []
    }));
    return {
      term,
      nRepos,
      stars: totalStars,
      issues: totalIssues,
      forks: totalForks,
      newest,
      testFrac,
      avgSize,
      bugRel,
      repos: repoList
    };
  }));
  rankPatternRows(rows, weights);
  const topRepos = collectTopPatternRepos(rows, top, top);
  return {
    terms: rows.map((r) => r.term),
    rows,
    topRepos,
    timingMs: performance.now() - t0
  };
}
function renderPatternBorrow(result, asText = false) {
  if (!asText) {
    return JSON.stringify({ terms: result.terms, topRepos: result.topRepos, timingMs: Math.round(result.timingMs) }, null, 2);
  }
  const lines = [
    `# pattern-borrow \u2014 terms: ${result.terms.join(" | ")}`,
    `# scored across ${result.rows.length} terms in ${result.timingMs.toFixed(0)}ms; factors: ${PATTERN_FACTORS.join(",")}`,
    ""
  ];
  for (let i = 0;i < result.topRepos.length; i++) {
    const repo = result.topRepos[i];
    const isLocal = repo.fullName.startsWith("local:");
    lines.push(`[${i + 1}] ${repo.fullName}  \u2605${repo.stars}  ${repo.language || "?"}  ${repo.license || "?"}`);
    if (repo.description)
      lines.push(`    why: ${repo.description.slice(0, 140)}`);
    if (repo.terms?.length)
      lines.push(`    matched terms: ${repo.terms.join(", ")}`);
    if (isLocal) {
      lines.push(`    in-tree first-class: ${repo.url.replace("file://", "")}`);
    } else {
      lines.push(`    repo: ${repo.url}`);
      const rawFiles = (repo.matchedFiles || []).slice(0, 3);
      if (rawFiles.length) {
        lines.push(`    matching files:`);
        for (const f of rawFiles) {
          lines.push(`      - https://raw.githubusercontent.com/${repo.fullName}/HEAD/${f}`);
        }
      }
    }
  }
  if (!result.topRepos.length) {
    lines.push("no matches \u2014 refine terms (stopwords stripped; use code identifiers)");
  }
  return lines.join(`
`);
}
// src/providers/registry.ts
var nctx = (ctx) => ctx?.apiKey ?? "";
var PROVIDERS = {
  local: {
    name: "local",
    label: "local AST-BM25",
    search: (q, n) => localTreeSearch(q, n),
    timeoutMs: 4000,
    maxRetries: 0,
    keyed: false,
    always: true
  },
  github: {
    name: "github",
    label: "GitHub code search",
    search: (q, n) => githubCodeSearch(q, n),
    timeoutMs: 1e4,
    maxRetries: 2,
    keyed: true,
    resolveKey: resolveGithubToken
  },
  github_repos: {
    name: "github_repos",
    label: "GitHub repository search",
    search: (q, n) => githubRepoSearch(q, n),
    timeoutMs: 1e4,
    maxRetries: 2,
    keyed: true,
    resolveKey: resolveGithubToken
  },
  npm: {
    name: "npm",
    label: "npm registry",
    search: (q, n) => npmSearch(q, n),
    timeoutMs: 6000,
    maxRetries: 0,
    keyed: false,
    always: true
  },
  stackoverflow: {
    name: "stackoverflow",
    label: "StackOverflow",
    search: (q, n) => stackoverflowSearch(q, n),
    timeoutMs: 6000,
    maxRetries: 0,
    keyed: false,
    always: true
  },
  arxiv: {
    name: "arxiv",
    label: "arXiv",
    search: (q, n) => arxivSearch(q, n),
    timeoutMs: 1e4,
    maxRetries: 3,
    keyed: false,
    always: true
  },
  openalex: {
    name: "openalex",
    label: "OpenAlex",
    search: (q, n) => openAlexSearch(q, n),
    timeoutMs: 8000,
    maxRetries: 0,
    keyed: false,
    always: true
  },
  semanticscholar: {
    name: "semanticscholar",
    label: "Semantic Scholar",
    search: (q, n, ctx) => s2Search(q, n, nctx(ctx)),
    timeoutMs: 8000,
    maxRetries: 1,
    keyed: true,
    resolveKey: () => resolveKey("s2")
  },
  dblp: {
    name: "dblp",
    label: "DBLP",
    search: (q, n) => dblpSearch(q, n),
    timeoutMs: 8000,
    maxRetries: 2,
    keyed: false,
    always: true
  },
  hf_papers: {
    name: "hf_papers",
    label: "Hugging Face Papers",
    search: (q, n) => hfPapersSearch(q, n),
    timeoutMs: 8000,
    maxRetries: 0,
    keyed: false,
    always: true
  },
  brave: {
    name: "brave",
    label: "Brave Search",
    search: (q, n, ctx) => braveSearch(q, n, nctx(ctx)),
    timeoutMs: 8000,
    maxRetries: 0,
    keyed: true,
    resolveKey: () => resolveKey("brave")
  },
  serper: {
    name: "serper",
    label: "SERPER (Google)",
    search: (q, n, ctx) => serperSearch(q, n, nctx(ctx)),
    timeoutMs: 8000,
    maxRetries: 0,
    keyed: true,
    resolveKey: () => resolveKey("serper")
  },
  tavily: {
    name: "tavily",
    label: "Tavily",
    search: (q, n, ctx) => tavilySearch(q, n, nctx(ctx)),
    timeoutMs: 8000,
    maxRetries: 0,
    keyed: true,
    resolveKey: () => resolveKey("tavily")
  },
  exa: {
    name: "exa",
    label: "Exa (credits)",
    search: (q, n, ctx) => exaSearch(q, n, nctx(ctx)),
    timeoutMs: 12000,
    maxRetries: 0,
    keyed: true,
    resolveKey: resolveExaKey,
    cost: "paid"
  }
};
// src/ml-dictionary.ts
class MLDictionary {
  vocab = new Map;
  totalDocs = 0;
  constructor() {
    this.seedDefaultMLTerms();
  }
  seedDefaultMLTerms() {
    const defaultTerms = [
      ["transformer", "nlp", ["attention", "bert", "gpt", "decoder"]],
      ["attention", "nlp", ["self-attention", "cross-attention", "flash-attention"]],
      ["embedding", "nlp", ["vector", "representation", "latent"]],
      ["token", "nlp", ["subword", "bpe", "wordpiece", "tiktoken"]],
      ["vocabulary", "nlp", ["lexicon", "dictionary", "tokens"]],
      ["sandboxing", "systems", ["isolation", "seccomp", "namespaces", "container"]],
      ["deadline", "systems", ["timeout", "budget", "wall-clock", "expiration"]],
      ["guardrail", "ml", ["policy", "sanitizer", "firewall", "moderation"]],
      ["hook", "tooling", ["interception", "callback", "trap", "instrumentation"]],
      ["observability", "systems", ["telemetry", "tracing", "profiling", "metrics"]],
      ["shell", "tooling", ["bash", "zsh", "repl", "command-line"]],
      ["injection", "systems", ["sanitization", "escaping", "validation"]],
      ["fine-tuning", "ml", ["lora", "qlora", "sft", "rlhf", "dpo"]],
      ["inference", "systems", ["generation", "forward-pass", "latency", "throughput"]],
      ["quantization", "systems", ["gguf", "awq", "gptq", "bitsandbytes"]],
      ["mcp", "tooling", ["model-context-protocol", "tools", "gateway", "rpc"]],
      ["rag", "nlp", ["retrieval", "hybrid-search", "bm25", "vector-db"]],
      ["semantic", "nlp", ["similarity", "meaning", "embedding-distance"]],
      ["context", "nlp", ["context-window", "prompt", "kv-cache"]],
      ["latency", "systems", ["ttft", "tps", "response-time", "p99"]]
    ];
    for (const [term, category, synonyms] of defaultTerms) {
      this.vocab.set(term, {
        term,
        frequency: 1,
        idf: 1,
        category,
        synonyms
      });
    }
  }
  tokenize(text) {
    return text.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/).filter((t) => t.length > 1);
  }
  ingest(documentText) {
    this.totalDocs++;
    const tokens = new Set(this.tokenize(documentText));
    for (const t of tokens) {
      const entry = this.vocab.get(t);
      if (entry) {
        entry.frequency++;
      } else {
        this.vocab.set(t, {
          term: t,
          frequency: 1,
          idf: 0,
          category: "general",
          synonyms: []
        });
      }
    }
    for (const entry of this.vocab.values()) {
      entry.idf = Math.log(1 + this.totalDocs / (1 + entry.frequency));
    }
  }
  lookup(term) {
    return this.vocab.get(term.toLowerCase());
  }
  expandQuery(query) {
    const tokens = this.tokenize(query);
    const expanded = new Set(tokens);
    for (const t of tokens) {
      const entry = this.vocab.get(t);
      if (entry && entry.synonyms.length > 0) {
        for (const syn of entry.synonyms) {
          expanded.add(syn);
        }
      }
    }
    return Array.from(expanded);
  }
  get size() {
    return this.vocab.size;
  }
  expand(query, maxTerms = 4) {
    const words = query.toLowerCase().split(/[^a-z0-9.-]+/).filter(Boolean);
    const extras = new Set;
    for (const [term, _cat, syns] of this.seedDefaultMLTerms === undefined ? [] : [])
      ;
    for (const w of words) {
      const entry = this.vocab.get(w) ?? this.vocab.get(w.replace(/s$/, ""));
      if (entry)
        for (const s of entry.synonyms.slice(0, 2))
          extras.add(s);
      if (extras.size >= maxTerms)
        break;
    }
    return extras.size ? `${query} ${[...extras].join(" ")}` : query;
  }
}

// src/borrow.ts
var DEFAULT_WEIGHTS = {
  citations: 3,
  upvotes: 2.5,
  recency: 1.5,
  abstractDepth: 1,
  hasPdf: 0.5,
  identifier: 2
};
function rankItems(items, weights = DEFAULT_WEIGHTS, now = new Date) {
  const year = now.getFullYear();
  const ranked = items.map(({ source, item }) => {
    const reasons = [];
    if (source === "local" || source === "github" || "repo" in item) {
      const asCode = item;
      let score = (asCode.score ?? 5) * 1.5;
      if (source === "local") {
        score += 8;
        reasons.push("local codebase in-tree match");
      } else if (source === "github_repos") {
        const stars = asCode.stars ?? 0;
        score += Math.log10(stars + 1) * 3 + (asCode.bm25 ?? 0) * 4;
        reasons.push(`repo ${stars}\u2605`);
      } else if (source === "npm") {
        score += (asCode.bm25 ?? 0) * 4 + 2;
        reasons.push("npm package");
      } else if (source === "stackoverflow") {
        score += 3;
        reasons.push("developer Q&A");
      } else {
        reasons.push("github code");
      }
      if (asCode.repo)
        reasons.push(asCode.repo);
      return { source, item, score, reasons };
    }
    const asPaper = item;
    const citations = asPaper.citedByCount ?? asPaper.citationCount ?? 0;
    if (citations)
      reasons.push(`cited x${citations}`);
    const citationScore = Math.log10(citations + 1) * weights.citations;
    const upvotes = asPaper.upvotes ?? 0;
    if (upvotes)
      reasons.push(`upvotes ${upvotes}`);
    const upvoteScore = Math.log10(upvotes + 1) * weights.upvotes;
    const published = asPaper.published ?? (asPaper.year ? String(asPaper.year) : null);
    const age = published ? year - Number(String(published).slice(0, 4)) : 99;
    const recencyScore = Math.max(0, 1 - age / 5) * weights.recency;
    if (age <= 2 && published)
      reasons.push(`recent ${String(published).slice(0, 4)}`);
    const depth = (asPaper.summary?.length ?? 0) / 600;
    if (depth > 0)
      reasons.push(`abstract ${Math.round(asPaper.summary.length)}ch`);
    let score = citationScore + upvoteScore + recencyScore + depth * weights.abstractDepth;
    if (asPaper.pdfUrl) {
      score += weights.hasPdf;
      reasons.push("has pdf");
    }
    if (asPaper.arxivId || asPaper.doi) {
      score += weights.identifier;
      reasons.push(asPaper.arxivId ? "arxiv id" : "doi");
    }
    return { source, item, score, reasons };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
async function borrow(query, opts = {}) {
  const {
    perSource = 5,
    skip = new Set,
    deadlineMs = 12000,
    legTimeoutMs = 4000
  } = opts;
  const resolvedKeys = new Map;
  const notes = [];
  const t0 = performance.now();
  const dict = new MLDictionary;
  const expanded = dict.expand(query);
  if (opts.exaApiKey)
    resolvedKeys.set("exa", opts.exaApiKey);
  const legNames = Object.keys(PROVIDERS);
  const legs = legNames.map((name) => {
    const spec = PROVIDERS[name];
    let key = "";
    if (spec.keyed) {
      key = resolvedKeys.get(name) ?? spec.resolveKey?.().key ?? "";
      resolvedKeys.set(name, key);
    }
    return {
      name,
      enabled: !skip.has(name) && (!spec.keyed || key.length > 0),
      run: () => spec.search(expanded, perSource, { apiKey: key })
    };
  });
  for (const leg of legs)
    if (skip.has(leg.name))
      notes.push(`${leg.name} skipped by flag`);
  if (!skip.has("github")) {
    const ghKey = resolvedKeys.get("github") ?? "";
    if (ghKey)
      notes.push("github token resolved");
    else
      notes.push("github skipped: no GITHUB_TOKEN (checked environment and $HOME/.secrets); code search requires auth \u2014 degrades, does not fail the run");
  }
  if (skip.has("exa"))
    notes.push("exa skipped by flag; no credits spent");
  else if (!resolvedKeys.get("exa"))
    notes.push("exa has no api key (checked flag, environment, and $HOME/.secrets)");
  else
    notes.push("exa key resolved; call logged with cost to the audit log");
  const active = legs.filter((leg) => leg.enabled && !skip.has(leg.name));
  const partial = new Map;
  const legWork = active.map(async (leg) => {
    const cap = PROVIDERS?.[leg.name]?.timeoutMs ?? legTimeoutMs;
    const result = await measureAsyncResult(leg.name, leg.run, cap);
    partial.set(leg.name, result);
  });
  const wall = new Promise((resolve) => {
    const timer = setTimeout(() => resolve("wall"), deadlineMs);
    timer.unref?.();
  });
  await Promise.race([Promise.all(legWork), wall]);
  for (const leg of active)
    if (!partial.has(leg.name))
      partial.set(leg.name, {
        ok: false,
        items: [],
        cost: "free",
        error: `abandoned at ${deadlineMs}ms wall (still in flight)`
      });
  const settled = [...partial.entries()];
  const sources = {};
  let creditsSpent = false;
  for (const [name, result] of settled) {
    sources[name] = result;
    if (name === "exa" && result?.ok) {
      creditsSpent = true;
      const cost = result.cost === "exa-credits" ? ` ${result.items.length} results billed` : "";
      notes.push(`exa ran and billed${cost}; see the exa audit log for costUsd`);
    } else if (name === "exa" && result && !result.ok) {
      notes.push(`exa call failed: ${result.error ?? "unknown"}`);
    }
  }
  const flat = Object.entries(sources).filter(([, r]) => r?.ok && r.items.length).flatMap(([source, r]) => r.items.map((item) => ({
    source,
    item
  })));
  const result = {
    ok: true,
    query,
    sources,
    creditsSpent,
    notes,
    timingMs: performance.now() - t0,
    ranked: rankItems(flat)
  };
  emit({
    event: "borrow_done",
    query,
    sources: Object.keys(sources).length,
    items: flat.length,
    timing_ms: result.timingMs
  });
  return result;
}
async function measureAsyncResult(name, fn, legTimeoutMs = 4000) {
  const started = performance.now();
  let outcome = null;
  try {
    outcome = await Promise.race([
      safeCall(name, fn),
      new Promise((resolve) => setTimeout(() => resolve(null), legTimeoutMs))
    ]);
  } catch {
    outcome = null;
  }
  if (outcome === null) {
    emit({
      event: "source_degraded",
      source: name,
      error: `timeout after ${legTimeoutMs}ms`,
      expected: true
    });
    return {
      ok: false,
      items: [],
      cost: "free",
      error: `timed out after ${legTimeoutMs}ms`
    };
  }
  emit({
    event: "source_done",
    source: name,
    ok: outcome?.ok ?? false,
    items: outcome?.items.length ?? 0,
    timing_ms: performance.now() - started
  });
  return outcome;
}
function renderBorrow(result, topN = 10) {
  const lines = [];
  const ok = Object.entries(result.sources).filter(([, r]) => r?.ok);
  const failedSources = Object.entries(result.sources).filter(([, r]) => r && !r.ok);
  lines.push(`=== Borrow: "${result.query}" \u2014 ${ok.length}/${Object.keys(result.sources).length} sources ok in ${result.timingMs.toFixed(0)}ms ===`);
  for (const [name, r] of failedSources) {
    const err = r.error ?? "unknown";
    if (isExpectedDegrade(err))
      lines.push(`  note: ${name} degraded (${err}) \u2014 skipped`);
    else
      lines.push(`  ${name}: FAILED \u2014 ${err}`);
  }
  for (const note of result.notes)
    lines.push(`  note: ${note}`);
  if (!result.creditsSpent)
    lines.push("  credits spent: 0 (exa runs only when a key resolves; none did)");
  if (result.creditsSpent)
    lines.push("  CREDITS SPENT (exa ran; see the exa audit log for costUsd)");
  lines.push("");
  for (const [i, row] of result.ranked.slice(0, topN).entries()) {
    const item = row.item;
    let title = "(untitled)";
    let url = "";
    if ("repo" in item && item.repo) {
      title = item.name ? `${item.repo}: ${item.name}` : item.repo ?? "(code)";
      url = item.html_url ?? item.path ?? "";
    } else {
      const p = item;
      title = p.title ?? "(untitled paper)";
      url = p.url ?? p.pdfUrl ?? "";
    }
    lines.push(`${String(i + 1).padStart(2)}. [${row.score.toFixed(2)}] [${row.source}] ${title}`);
    if (url)
      lines.push(`    ${url}`);
    const authors = item.authors;
    if (authors?.length)
      lines.push(`    ${authors.slice(0, 3).join(", ")}${authors.length > 3 ? " et al" : ""}`);
    if (row.reasons.length)
      lines.push(`    ${row.reasons.join(" \xB7 ")}`);
    const snippet = item.abstract || item.snippet || item.summary;
    if (snippet) {
      const clean = String(snippet).replace(/\s+/g, " ").trim();
      const truncated = clean.length > 180 ? `${clean.slice(0, 180)}\u2026` : clean;
      lines.push(`    > "${truncated}"`);
    }
  }
  if (!result.ranked.length)
    lines.push("  (no items from any source)");
  return lines.join(`
`);
}

// src/audit.ts
import { join as join12, relative as relative3, resolve as resolve2 } from "path";
import { accessSync, constants, statSync as statSync4 } from "fs";
import { homedir as homedir4 } from "os";
var cachedBin;
function resolveAstGrep() {
  if (cachedBin !== undefined)
    return cachedBin;
  const env = process.env["AST_GREP_BIN"];
  const candidates = [
    ...env ? [env] : [],
    join12(homedir4(), ".local", "bin", "ast-grep"),
    join12(homedir4(), ".local", "share", "mise", "shims", "ast-grep")
  ];
  for (const c of candidates) {
    if (isExecutable(c)) {
      cachedBin = c;
      return cachedBin;
    }
  }
  const probe = Bun.spawnSync(["sh", "-c", "command -v ast-grep"], { stdout: "pipe" });
  cachedBin = probe.exitCode === 0 ? new TextDecoder().decode(probe.stdout).trim() : null;
  return cachedBin;
}
function runSg(bin, args, cwd) {
  const proc = Bun.spawnSync([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(proc.stdout).trim();
  if (out) {
    try {
      return JSON.parse(out);
    } catch {}
  }
  const err = new TextDecoder().decode(proc.stderr).trim();
  throw new Error(err.split(`
`)[0] || `ast-grep exit ${proc.exitCode} (no JSON stdout)`);
}
function toEvidence(m) {
  const meta = {};
  for (const [k, v] of Object.entries(m.metaVariables?.single ?? {}))
    meta[k] = v.text;
  return {
    file: m.file,
    line: m.range.start.line,
    col: m.range.start.column,
    endLine: m.range.end.line,
    endCol: m.range.end.column,
    text: (m.lines || m.text).trim().slice(0, 300),
    language: m.language,
    meta
  };
}
function routeClaim(claim) {
  const portRe = /(?:port\s+(\d+))[^.]{0,50}?\b(serves?|listens?(?:\s+on)?|hosts?|runs?)\b\s+([A-Za-z0-9_.\-/]+)|([A-Za-z0-9_.\-/]+)[^.]{0,50}?\b(listens?\s+on|serves?|runs?\s+on|hosts?)\b[^.]{0,20}?port\s+(\d+)/i;
  const pm = claim.match(portRe);
  if (pm) {
    const port = pm[1] ?? pm[6];
    const name = (pm[3] ?? pm[4] ?? "").toLowerCase();
    const queries = [
      { label: "ts listen", pattern: "$APP.listen($PORT, $$$)", lang: "ts" },
      { label: "ts listen (tsx)", pattern: "$APP.listen($PORT, $$$)", lang: "tsx" },
      { label: "bun serve", pattern: "Bun.serve({ $$$ })", lang: "ts" },
      { label: "py listen", pattern: "$APP.listen($PORT)", lang: "py" },
      { label: "py uvicorn", pattern: "uvicorn.run($$$, port=$PORT, $$$)", lang: "py" },
      { label: "go http", pattern: "http.ListenAndServe($ADDR, $$$)", lang: "go" },
      { label: "go net listen", pattern: "net.Listen($$$, $ADDR)", lang: "go" },
      { label: "rs axum bind", pattern: "axum::Server::bind($ADDR)", lang: "rs" },
      { label: "rs tcp bind", pattern: "TcpListener::bind($ADDR)", lang: "rs" }
    ];
    return {
      type: `port-bind (port ${port}${name ? `, service "${name}"` : ""})`,
      queries,
      check: (ev) => {
        const hits = ev.filter((e) => {
          const vals = Object.values(e.meta).join(" ");
          return new RegExp(`\\b${port}\\b`).test(vals) || new RegExp(`\\b${port}\\b`).test(e.text);
        });
        if (hits.length) {
          return {
            verdict: "VERIFIED",
            confidence: hits.some((h) => new RegExp(`\\b${port}\\b`).test(Object.values(h.meta).join(" "))) ? "high" : "medium",
            notes: [`port literal ${port} captured in bind call${name ? ` (claim names "${name}" \u2014 confirm the file/service matches)` : ""}`]
          };
        }
        return { verdict: "NOT-FOUND", confidence: "medium", notes: [`no bind site captures port ${port}; the port may live in config (use rg) or env`] };
      }
    };
  }
  const callsRe = /\b([A-Za-z_]\w*)\s+calls?\s+([A-Za-z_]\w*)\b/i;
  const cm = claim.match(callsRe);
  if (cm) {
    const [, x, y] = cm;
    return {
      type: `call-edge (${x} -> ${y})`,
      queries: [{ label: `call sites of ${y} (filtered to ${x}'s body)`, pattern: `${y}($$$)`, lang: "ts" }],
      check: () => ({ verdict: "INCONCLUSIVE", confidence: "low", notes: ["call-edge needs the two-pass path \u2014 handled by auditCallEdge()"] })
    };
  }
  const impRe = /\b([A-Za-z0-9_@.\-/]+)\s+imports?\s+([A-Za-z0-9_@.\-/]+)\b/i;
  const im = claim.match(impRe);
  if (im) {
    const [, , b] = im;
    const queries = [
      { label: "es named import", pattern: `import { $$$ } from "$SPEC"`, lang: "ts" },
      { label: "es default import", pattern: `import $DEF from "$SPEC"`, lang: "ts" },
      { label: "es namespace import", pattern: `import * as $NS from "$SPEC"`, lang: "ts" },
      { label: "es side-effect import", pattern: `import "$SPEC"`, lang: "ts" },
      { label: "py from-import", pattern: `from $MOD import $$$`, lang: "py" },
      { label: "py import", pattern: `import $MOD`, lang: "py" },
      { label: "require", pattern: `require("$SPEC")`, lang: "ts" },
      { label: "go import", pattern: `import ( $$$ $SPEC $$$ )`, lang: "go" }
    ];
    return {
      type: `import-edge (-> ${b})`,
      queries,
      check: (ev) => {
        const hits = ev.filter((e) => {
          const spec = (e.meta["SPEC"] ?? e.meta["MOD"] ?? "").replace(/['"]/g, "");
          return spec.includes(b);
        });
        return hits.length ? { verdict: "VERIFIED", confidence: "high", notes: [`${hits.length} structural import hit(s); specifier contains "${b}"`] } : { verdict: "NOT-FOUND", confidence: "medium", notes: [`no import specifier containing "${b}" found`] };
      }
    };
  }
  const defRe = /\b(function|class|method|struct|interface)\s+([A-Za-z_]\w*)/i;
  const dm = claim.match(defRe);
  if (dm) {
    const [, kind, name] = dm;
    const k = kind.toLowerCase();
    const patterns = {
      function: [
        { label: "ts function", pattern: `function ${name}($$$)`, lang: "ts" },
        { label: "py def", pattern: `def ${name}($$$)`, lang: "py" },
        { label: "go func", pattern: `func ${name}($$$)`, lang: "go" },
        { label: "rs fn", pattern: `fn ${name}($$$)`, lang: "rs" }
      ],
      class: [
        { label: "ts class", pattern: `class ${name} $$$`, lang: "ts" },
        { label: "py class", pattern: `class ${name}($$$)`, lang: "py" }
      ],
      method: [
        { label: "ts method", pattern: `${name}($$$) { $$$ }`, lang: "ts" },
        { label: "py method", pattern: `def ${name}($$$)`, lang: "py" }
      ],
      struct: [{ label: "go struct", pattern: `type ${name} struct { $$$ }`, lang: "go" }],
      interface: [
        { label: "ts interface", pattern: `interface ${name} { $$$ }`, lang: "ts" },
        { label: "go interface", pattern: `type ${name} interface { $$$ }`, lang: "go" }
      ]
    };
    return {
      type: `symbol-definition (${k} ${name})`,
      queries: patterns[k] ?? [],
      check: (ev) => ev.length ? { verdict: "VERIFIED", confidence: "high", notes: [`${ev.length} definition site(s) for ${k} "${name}"`] } : { verdict: "NOT-FOUND", confidence: "medium", notes: [`no ${k} "${name}" defined in the searched tree`] }
    };
  }
  return null;
}
var DEF_PATTERNS = {
  ts: ["function $X($$$): $RT { $$$ }", "function $X($$$) { $$$ }"],
  tsx: ["function $X($$$): $RT { $$$ }", "function $X($$$) { $$$ }"],
  js: ["function $X($$$) { $$$ }"],
  py: ["def $X($$$)"],
  go: ["func $X($$$)"],
  rs: ["fn $X($$$) -> $RT { $$$ }", "fn $X($$$) { $$$ }"]
};
var LANGS = ["ts", "tsx", "js", "py", "go", "rs"];
function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function auditCallEdge(bin, root, globs, x, y, qlog) {
  const out = [];
  for (const lang of LANGS) {
    const defPats = DEF_PATTERNS[lang];
    if (!defPats)
      continue;
    const defs = [];
    const seen = new Set;
    for (const defPat of defPats) {
      const pat = defPat.replace("$X", x);
      const args = ["run", "-p", pat, "--lang", lang, "--json=compact", ...globs.flatMap((g) => ["--globs", g]), root];
      let found;
      try {
        found = runSg(bin, args, root);
      } catch (e) {
        qlog.push({ label: `def ${x} (${lang})`, pattern: pat, lang, globs, hits: 0, note: String(e) });
        continue;
      }
      qlog.push({ label: `def ${x} (${lang})`, pattern: pat, lang, globs, hits: found.length });
      for (const d of found) {
        const key = `${d.file}:${d.range.start.line}:${d.range.start.column}`;
        if (!seen.has(key)) {
          seen.add(key);
          defs.push(d);
        }
      }
    }
    for (const d of defs) {
      const rel = relative3(root, d.file) || d.file;
      const callArgs = ["run", "-p", `${y}($$$)`, "--lang", lang, "--json=compact", "--globs", rel, root];
      let calls;
      try {
        calls = runSg(bin, callArgs, root);
      } catch {
        continue;
      }
      qlog.push({ label: `calls to ${y} in ${d.file} (${lang})`, pattern: `${y}($$$)`, lang, globs: [d.file], hits: calls.length });
      for (const c of calls) {
        if (c.range.start.line >= d.range.start.line && c.range.start.line <= d.range.end.line) {
          out.push(toEvidence(c));
        }
      }
    }
  }
  return out;
}
function audit(opts) {
  const bin = resolveAstGrep();
  if (!bin) {
    return {
      claim: opts.claim ?? opts.pattern ?? opts.rule ?? "",
      claimType: "none",
      verdict: "INCONCLUSIVE",
      confidence: "low",
      queries: [],
      evidence: [],
      notes: ["ast-grep binary not found. Install: download the release zip from github.com/ast-grep/ast-grep and put `ast-grep` on PATH (or set AST_GREP_BIN). Do NOT use `sg` \u2014 on Linux that's util-linux setgroups."]
    };
  }
  const rootDir = resolve2(opts.root);
  let rootIsDir = false;
  try {
    rootIsDir = statSync4(rootDir).isDirectory();
  } catch {
    rootIsDir = false;
  }
  if (!rootIsDir) {
    return {
      claim: opts.claim ?? opts.pattern ?? opts.rule ?? "",
      claimType: "none",
      verdict: "INCONCLUSIVE",
      confidence: "low",
      queries: [],
      evidence: [],
      notes: [`--root must be a DIRECTORY (used as the working dir), got: ${opts.root}. Pass a dir, e.g. --root src/ or --root <repo>/src/tools.`]
    };
  }
  const qlog = [];
  const evidence = [];
  const notes = [];
  let claimType = "direct";
  const root = resolve2(opts.root);
  const runQuery = (q) => {
    const args = q.rule ? ["scan", "--rule", q.rule, "--json=compact", ...opts.globs.flatMap((g) => ["--globs", g]), root] : ["run", "-p", q.pattern, "--lang", q.lang, "--json=compact", ...opts.globs.flatMap((g) => ["--globs", g]), root];
    try {
      const hits = runSg(bin, args, root);
      qlog.push({ label: q.label, pattern: q.pattern, rule: q.rule, lang: q.lang, globs: opts.globs, hits: hits.length });
      for (const h of hits.slice(0, opts.top * 4))
        evidence.push(toEvidence(h));
    } catch (e) {
      qlog.push({ label: q.label, pattern: q.pattern, rule: q.rule, lang: q.lang, globs: opts.globs, hits: 0, note: String(e) });
    }
  };
  if (opts.claim) {
    const routed = routeClaim(opts.claim);
    if (!routed) {
      return {
        claim: opts.claim,
        claimType: "unrouted",
        verdict: "INCONCLUSIVE",
        confidence: "low",
        queries: [],
        evidence: [],
        notes: [
          "claim didn't match a known shape (port-bind, call-edge, import-edge, symbol-definition).",
          "Restate it in one of those shapes, or pass --pattern '<ast-grep pattern>' --lang <l> directly.",
          "Config values (key = value in yml/toml/ini) are text, not structure \u2014 use rg for those."
        ]
      };
    }
    claimType = routed.type;
    if (routed.type.startsWith("call-edge")) {
      const m = opts.claim.match(/\b([A-Za-z_]\w*)\s+calls?\s+([A-Za-z_]\w*)\b/i);
      const hits = auditCallEdge(bin, root, opts.globs, m[1], m[2], qlog);
      for (const h of hits.slice(0, opts.top))
        evidence.push(h);
      const verdict = hits.length ? "VERIFIED" : "NOT-FOUND";
      return {
        claim: opts.claim,
        claimType,
        verdict,
        confidence: hits.length ? "high" : "medium",
        queries: qlog,
        evidence: evidence.slice(0, opts.top),
        notes: hits.length ? [`${hits.length} call site(s) of "${m[2]}" inside "${m[1]}"'s body`] : [`no call to "${m[2]}" inside "${m[1]}"'s definition range`]
      };
    }
    for (const q of routed.queries)
      runQuery(q);
    const { verdict, confidence, notes: n } = routed.check(evidence);
    return { claim: opts.claim, claimType, verdict, confidence, queries: qlog, evidence: evidence.slice(0, opts.top), notes: [...notes, ...n] };
  }
  if (opts.pattern) {
    claimType = "direct-pattern";
    const langs = opts.lang ? [opts.lang] : LANGS;
    for (const lang of langs)
      runQuery({ label: `pattern (${lang})`, pattern: opts.pattern, lang });
    const verdict = evidence.length ? "VERIFIED" : "NOT-FOUND";
    return {
      claim: opts.pattern,
      claimType,
      verdict,
      confidence: evidence.length ? "high" : "medium",
      queries: qlog,
      evidence: evidence.slice(0, opts.top),
      notes: evidence.length ? [`${evidence.length} structural hit(s)`] : ["pattern matched nothing \u2014 check references/pitfalls.md \xA72 (pattern must be valid code)"]
    };
  }
  if (opts.rule) {
    claimType = "yaml-rule";
    runQuery({ label: `rule ${opts.rule}`, rule: opts.rule, lang: opts.lang ?? "ts" });
    const verdict = evidence.length ? "VERIFIED" : "NOT-FOUND";
    return {
      claim: opts.rule,
      claimType,
      verdict,
      confidence: evidence.length ? "high" : "medium",
      queries: qlog,
      evidence: evidence.slice(0, opts.top),
      notes: evidence.length ? [`${evidence.length} rule hit(s)`] : ["rule matched nothing"]
    };
  }
  return {
    claim: "",
    claimType: "none",
    verdict: "INCONCLUSIVE",
    confidence: "low",
    queries: [],
    evidence: [],
    notes: [`audit needs one of: --claim "...", --pattern '<p>' [--lang l], --rule <file.yml>`]
  };
}
function renderAudit(r) {
  const lines = [`=== audit: "${r.claim}" [${r.claimType}] -> ${r.verdict} (confidence: ${r.confidence}) ===`];
  for (const q of r.queries) {
    lines.push(`  query [${q.label}] lang=${q.lang} hits=${q.hits}${q.note ? ` !! ${q.note}` : ""}`);
  }
  if (!r.evidence.length)
    lines.push("  (no evidence)");
  for (const e of r.evidence) {
    lines.push(`  ${e.file}:${e.line + 1}:${e.col}-${e.endLine + 1}:${e.endCol}  ${e.text}`);
    const mv = Object.entries(e.meta).map(([k, v]) => `$${k}="${v}"`).join(" ");
    if (mv)
      lines.push(`    captures: ${mv}`);
  }
  for (const n of r.notes)
    lines.push(`  note: ${n}`);
  return lines.join(`
`);
}

// src/hf-lib.ts
import { join as join13 } from "path";
import { homedir as homedir5 } from "os";
import { readFileSync as readFileSync7 } from "fs";
var TOKEN_KEYS = ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HF_AUTH_TOKEN"];
function resolveMaybe(envKeys, vaultPaths) {
  for (const k of envKeys) {
    const v = process.env[k]?.trim();
    if (v)
      return { key: v, from: `environment:${k}` };
  }
  for (const p of vaultPaths) {
    try {
      const vault = readFileSync7(p, "utf8");
      const re = new RegExp(`^\\s*(?:export\\s+)?(?:${envKeys.join("|")})\\s*=\\s*["']?([^"'\\n#]+)["']?`, "m");
      const hit = vault.match(re);
      if (hit?.[1]?.trim())
        return { key: hit[1].trim(), from: `${p} (vault)` };
    } catch {}
  }
  return { key: "", from: "not found" };
}
var HF_TOKEN = resolveMaybe(TOKEN_KEYS, [join13(homedir5(), ".secrets"), join13(homedir5(), ".bashrc.env")]).key;
var FREEINF_BASE = process.env.FREEINFERENCE_BASE_URL ?? "https://freeinference.org/v1";
var FREEINF_KEY = resolveMaybe(["FREEINFERENCE_API_KEY"], [join13(homedir5(), ".secrets"), join13(homedir5(), ".bashrc.env")]).key;

// node_modules/@huggingface/blake3-jit/dist/esm/compress.js
function compress(cv, cvOff, block, blockOff, out, outOff, full, counter, blockLen, flags) {
  let m0 = block[blockOff] | 0;
  let m1 = block[blockOff + 1] | 0;
  let m2 = block[blockOff + 2] | 0;
  let m3 = block[blockOff + 3] | 0;
  let m4 = block[blockOff + 4] | 0;
  let m5 = block[blockOff + 5] | 0;
  let m6 = block[blockOff + 6] | 0;
  let m7 = block[blockOff + 7] | 0;
  let m8 = block[blockOff + 8] | 0;
  let m9 = block[blockOff + 9] | 0;
  let m10 = block[blockOff + 10] | 0;
  let m11 = block[blockOff + 11] | 0;
  let m12 = block[blockOff + 12] | 0;
  let m13 = block[blockOff + 13] | 0;
  let m14 = block[blockOff + 14] | 0;
  let m15 = block[blockOff + 15] | 0;
  let s0 = cv[cvOff] | 0;
  let s1 = cv[cvOff + 1] | 0;
  let s2 = cv[cvOff + 2] | 0;
  let s3 = cv[cvOff + 3] | 0;
  let s4 = cv[cvOff + 4] | 0;
  let s5 = cv[cvOff + 5] | 0;
  let s6 = cv[cvOff + 6] | 0;
  let s7 = cv[cvOff + 7] | 0;
  let s8 = 1779033703;
  let s9 = 3144134277;
  let s10 = 1013904242;
  let s11 = 2773480762;
  let s12 = counter | 0;
  let s13 = counter / 4294967296 | 0;
  let s14 = blockLen | 0;
  let s15 = flags | 0;
  s0 = (s0 + s4 | 0) + m0 | 0;
  s12 ^= s0;
  s12 = s12 >>> 16 | s12 << 16;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 12 | s4 << 20;
  s0 = (s0 + s4 | 0) + m1 | 0;
  s12 ^= s0;
  s12 = s12 >>> 8 | s12 << 24;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 7 | s4 << 25;
  s1 = (s1 + s5 | 0) + m2 | 0;
  s13 ^= s1;
  s13 = s13 >>> 16 | s13 << 16;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 12 | s5 << 20;
  s1 = (s1 + s5 | 0) + m3 | 0;
  s13 ^= s1;
  s13 = s13 >>> 8 | s13 << 24;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 7 | s5 << 25;
  s2 = (s2 + s6 | 0) + m4 | 0;
  s14 ^= s2;
  s14 = s14 >>> 16 | s14 << 16;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 12 | s6 << 20;
  s2 = (s2 + s6 | 0) + m5 | 0;
  s14 ^= s2;
  s14 = s14 >>> 8 | s14 << 24;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 7 | s6 << 25;
  s3 = (s3 + s7 | 0) + m6 | 0;
  s15 ^= s3;
  s15 = s15 >>> 16 | s15 << 16;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 12 | s7 << 20;
  s3 = (s3 + s7 | 0) + m7 | 0;
  s15 ^= s3;
  s15 = s15 >>> 8 | s15 << 24;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 7 | s7 << 25;
  s0 = (s0 + s5 | 0) + m8 | 0;
  s15 ^= s0;
  s15 = s15 >>> 16 | s15 << 16;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 12 | s5 << 20;
  s0 = (s0 + s5 | 0) + m9 | 0;
  s15 ^= s0;
  s15 = s15 >>> 8 | s15 << 24;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 7 | s5 << 25;
  s1 = (s1 + s6 | 0) + m10 | 0;
  s12 ^= s1;
  s12 = s12 >>> 16 | s12 << 16;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 12 | s6 << 20;
  s1 = (s1 + s6 | 0) + m11 | 0;
  s12 ^= s1;
  s12 = s12 >>> 8 | s12 << 24;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 7 | s6 << 25;
  s2 = (s2 + s7 | 0) + m12 | 0;
  s13 ^= s2;
  s13 = s13 >>> 16 | s13 << 16;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 12 | s7 << 20;
  s2 = (s2 + s7 | 0) + m13 | 0;
  s13 ^= s2;
  s13 = s13 >>> 8 | s13 << 24;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 7 | s7 << 25;
  s3 = (s3 + s4 | 0) + m14 | 0;
  s14 ^= s3;
  s14 = s14 >>> 16 | s14 << 16;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 12 | s4 << 20;
  s3 = (s3 + s4 | 0) + m15 | 0;
  s14 ^= s3;
  s14 = s14 >>> 8 | s14 << 24;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 7 | s4 << 25;
  {
    const t0 = m0, t1 = m1;
    m0 = m2;
    m2 = m3;
    m3 = m10;
    m10 = m12;
    m12 = m9;
    m9 = m11;
    m11 = m5;
    m5 = t0;
    m1 = m6;
    m6 = m4;
    m4 = m7;
    m7 = m13;
    m13 = m14;
    m14 = m15;
    m15 = m8;
    m8 = t1;
  }
  s0 = (s0 + s4 | 0) + m0 | 0;
  s12 ^= s0;
  s12 = s12 >>> 16 | s12 << 16;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 12 | s4 << 20;
  s0 = (s0 + s4 | 0) + m1 | 0;
  s12 ^= s0;
  s12 = s12 >>> 8 | s12 << 24;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 7 | s4 << 25;
  s1 = (s1 + s5 | 0) + m2 | 0;
  s13 ^= s1;
  s13 = s13 >>> 16 | s13 << 16;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 12 | s5 << 20;
  s1 = (s1 + s5 | 0) + m3 | 0;
  s13 ^= s1;
  s13 = s13 >>> 8 | s13 << 24;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 7 | s5 << 25;
  s2 = (s2 + s6 | 0) + m4 | 0;
  s14 ^= s2;
  s14 = s14 >>> 16 | s14 << 16;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 12 | s6 << 20;
  s2 = (s2 + s6 | 0) + m5 | 0;
  s14 ^= s2;
  s14 = s14 >>> 8 | s14 << 24;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 7 | s6 << 25;
  s3 = (s3 + s7 | 0) + m6 | 0;
  s15 ^= s3;
  s15 = s15 >>> 16 | s15 << 16;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 12 | s7 << 20;
  s3 = (s3 + s7 | 0) + m7 | 0;
  s15 ^= s3;
  s15 = s15 >>> 8 | s15 << 24;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 7 | s7 << 25;
  s0 = (s0 + s5 | 0) + m8 | 0;
  s15 ^= s0;
  s15 = s15 >>> 16 | s15 << 16;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 12 | s5 << 20;
  s0 = (s0 + s5 | 0) + m9 | 0;
  s15 ^= s0;
  s15 = s15 >>> 8 | s15 << 24;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 7 | s5 << 25;
  s1 = (s1 + s6 | 0) + m10 | 0;
  s12 ^= s1;
  s12 = s12 >>> 16 | s12 << 16;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 12 | s6 << 20;
  s1 = (s1 + s6 | 0) + m11 | 0;
  s12 ^= s1;
  s12 = s12 >>> 8 | s12 << 24;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 7 | s6 << 25;
  s2 = (s2 + s7 | 0) + m12 | 0;
  s13 ^= s2;
  s13 = s13 >>> 16 | s13 << 16;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 12 | s7 << 20;
  s2 = (s2 + s7 | 0) + m13 | 0;
  s13 ^= s2;
  s13 = s13 >>> 8 | s13 << 24;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 7 | s7 << 25;
  s3 = (s3 + s4 | 0) + m14 | 0;
  s14 ^= s3;
  s14 = s14 >>> 16 | s14 << 16;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 12 | s4 << 20;
  s3 = (s3 + s4 | 0) + m15 | 0;
  s14 ^= s3;
  s14 = s14 >>> 8 | s14 << 24;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 7 | s4 << 25;
  {
    const t0 = m0, t1 = m1;
    m0 = m2;
    m2 = m3;
    m3 = m10;
    m10 = m12;
    m12 = m9;
    m9 = m11;
    m11 = m5;
    m5 = t0;
    m1 = m6;
    m6 = m4;
    m4 = m7;
    m7 = m13;
    m13 = m14;
    m14 = m15;
    m15 = m8;
    m8 = t1;
  }
  s0 = (s0 + s4 | 0) + m0 | 0;
  s12 ^= s0;
  s12 = s12 >>> 16 | s12 << 16;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 12 | s4 << 20;
  s0 = (s0 + s4 | 0) + m1 | 0;
  s12 ^= s0;
  s12 = s12 >>> 8 | s12 << 24;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 7 | s4 << 25;
  s1 = (s1 + s5 | 0) + m2 | 0;
  s13 ^= s1;
  s13 = s13 >>> 16 | s13 << 16;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 12 | s5 << 20;
  s1 = (s1 + s5 | 0) + m3 | 0;
  s13 ^= s1;
  s13 = s13 >>> 8 | s13 << 24;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 7 | s5 << 25;
  s2 = (s2 + s6 | 0) + m4 | 0;
  s14 ^= s2;
  s14 = s14 >>> 16 | s14 << 16;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 12 | s6 << 20;
  s2 = (s2 + s6 | 0) + m5 | 0;
  s14 ^= s2;
  s14 = s14 >>> 8 | s14 << 24;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 7 | s6 << 25;
  s3 = (s3 + s7 | 0) + m6 | 0;
  s15 ^= s3;
  s15 = s15 >>> 16 | s15 << 16;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 12 | s7 << 20;
  s3 = (s3 + s7 | 0) + m7 | 0;
  s15 ^= s3;
  s15 = s15 >>> 8 | s15 << 24;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 7 | s7 << 25;
  s0 = (s0 + s5 | 0) + m8 | 0;
  s15 ^= s0;
  s15 = s15 >>> 16 | s15 << 16;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 12 | s5 << 20;
  s0 = (s0 + s5 | 0) + m9 | 0;
  s15 ^= s0;
  s15 = s15 >>> 8 | s15 << 24;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 7 | s5 << 25;
  s1 = (s1 + s6 | 0) + m10 | 0;
  s12 ^= s1;
  s12 = s12 >>> 16 | s12 << 16;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 12 | s6 << 20;
  s1 = (s1 + s6 | 0) + m11 | 0;
  s12 ^= s1;
  s12 = s12 >>> 8 | s12 << 24;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 7 | s6 << 25;
  s2 = (s2 + s7 | 0) + m12 | 0;
  s13 ^= s2;
  s13 = s13 >>> 16 | s13 << 16;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 12 | s7 << 20;
  s2 = (s2 + s7 | 0) + m13 | 0;
  s13 ^= s2;
  s13 = s13 >>> 8 | s13 << 24;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 7 | s7 << 25;
  s3 = (s3 + s4 | 0) + m14 | 0;
  s14 ^= s3;
  s14 = s14 >>> 16 | s14 << 16;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 12 | s4 << 20;
  s3 = (s3 + s4 | 0) + m15 | 0;
  s14 ^= s3;
  s14 = s14 >>> 8 | s14 << 24;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 7 | s4 << 25;
  {
    const t0 = m0, t1 = m1;
    m0 = m2;
    m2 = m3;
    m3 = m10;
    m10 = m12;
    m12 = m9;
    m9 = m11;
    m11 = m5;
    m5 = t0;
    m1 = m6;
    m6 = m4;
    m4 = m7;
    m7 = m13;
    m13 = m14;
    m14 = m15;
    m15 = m8;
    m8 = t1;
  }
  s0 = (s0 + s4 | 0) + m0 | 0;
  s12 ^= s0;
  s12 = s12 >>> 16 | s12 << 16;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 12 | s4 << 20;
  s0 = (s0 + s4 | 0) + m1 | 0;
  s12 ^= s0;
  s12 = s12 >>> 8 | s12 << 24;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 7 | s4 << 25;
  s1 = (s1 + s5 | 0) + m2 | 0;
  s13 ^= s1;
  s13 = s13 >>> 16 | s13 << 16;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 12 | s5 << 20;
  s1 = (s1 + s5 | 0) + m3 | 0;
  s13 ^= s1;
  s13 = s13 >>> 8 | s13 << 24;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 7 | s5 << 25;
  s2 = (s2 + s6 | 0) + m4 | 0;
  s14 ^= s2;
  s14 = s14 >>> 16 | s14 << 16;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 12 | s6 << 20;
  s2 = (s2 + s6 | 0) + m5 | 0;
  s14 ^= s2;
  s14 = s14 >>> 8 | s14 << 24;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 7 | s6 << 25;
  s3 = (s3 + s7 | 0) + m6 | 0;
  s15 ^= s3;
  s15 = s15 >>> 16 | s15 << 16;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 12 | s7 << 20;
  s3 = (s3 + s7 | 0) + m7 | 0;
  s15 ^= s3;
  s15 = s15 >>> 8 | s15 << 24;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 7 | s7 << 25;
  s0 = (s0 + s5 | 0) + m8 | 0;
  s15 ^= s0;
  s15 = s15 >>> 16 | s15 << 16;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 12 | s5 << 20;
  s0 = (s0 + s5 | 0) + m9 | 0;
  s15 ^= s0;
  s15 = s15 >>> 8 | s15 << 24;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 7 | s5 << 25;
  s1 = (s1 + s6 | 0) + m10 | 0;
  s12 ^= s1;
  s12 = s12 >>> 16 | s12 << 16;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 12 | s6 << 20;
  s1 = (s1 + s6 | 0) + m11 | 0;
  s12 ^= s1;
  s12 = s12 >>> 8 | s12 << 24;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 7 | s6 << 25;
  s2 = (s2 + s7 | 0) + m12 | 0;
  s13 ^= s2;
  s13 = s13 >>> 16 | s13 << 16;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 12 | s7 << 20;
  s2 = (s2 + s7 | 0) + m13 | 0;
  s13 ^= s2;
  s13 = s13 >>> 8 | s13 << 24;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 7 | s7 << 25;
  s3 = (s3 + s4 | 0) + m14 | 0;
  s14 ^= s3;
  s14 = s14 >>> 16 | s14 << 16;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 12 | s4 << 20;
  s3 = (s3 + s4 | 0) + m15 | 0;
  s14 ^= s3;
  s14 = s14 >>> 8 | s14 << 24;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 7 | s4 << 25;
  {
    const t0 = m0, t1 = m1;
    m0 = m2;
    m2 = m3;
    m3 = m10;
    m10 = m12;
    m12 = m9;
    m9 = m11;
    m11 = m5;
    m5 = t0;
    m1 = m6;
    m6 = m4;
    m4 = m7;
    m7 = m13;
    m13 = m14;
    m14 = m15;
    m15 = m8;
    m8 = t1;
  }
  s0 = (s0 + s4 | 0) + m0 | 0;
  s12 ^= s0;
  s12 = s12 >>> 16 | s12 << 16;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 12 | s4 << 20;
  s0 = (s0 + s4 | 0) + m1 | 0;
  s12 ^= s0;
  s12 = s12 >>> 8 | s12 << 24;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 7 | s4 << 25;
  s1 = (s1 + s5 | 0) + m2 | 0;
  s13 ^= s1;
  s13 = s13 >>> 16 | s13 << 16;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 12 | s5 << 20;
  s1 = (s1 + s5 | 0) + m3 | 0;
  s13 ^= s1;
  s13 = s13 >>> 8 | s13 << 24;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 7 | s5 << 25;
  s2 = (s2 + s6 | 0) + m4 | 0;
  s14 ^= s2;
  s14 = s14 >>> 16 | s14 << 16;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 12 | s6 << 20;
  s2 = (s2 + s6 | 0) + m5 | 0;
  s14 ^= s2;
  s14 = s14 >>> 8 | s14 << 24;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 7 | s6 << 25;
  s3 = (s3 + s7 | 0) + m6 | 0;
  s15 ^= s3;
  s15 = s15 >>> 16 | s15 << 16;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 12 | s7 << 20;
  s3 = (s3 + s7 | 0) + m7 | 0;
  s15 ^= s3;
  s15 = s15 >>> 8 | s15 << 24;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 7 | s7 << 25;
  s0 = (s0 + s5 | 0) + m8 | 0;
  s15 ^= s0;
  s15 = s15 >>> 16 | s15 << 16;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 12 | s5 << 20;
  s0 = (s0 + s5 | 0) + m9 | 0;
  s15 ^= s0;
  s15 = s15 >>> 8 | s15 << 24;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 7 | s5 << 25;
  s1 = (s1 + s6 | 0) + m10 | 0;
  s12 ^= s1;
  s12 = s12 >>> 16 | s12 << 16;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 12 | s6 << 20;
  s1 = (s1 + s6 | 0) + m11 | 0;
  s12 ^= s1;
  s12 = s12 >>> 8 | s12 << 24;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 7 | s6 << 25;
  s2 = (s2 + s7 | 0) + m12 | 0;
  s13 ^= s2;
  s13 = s13 >>> 16 | s13 << 16;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 12 | s7 << 20;
  s2 = (s2 + s7 | 0) + m13 | 0;
  s13 ^= s2;
  s13 = s13 >>> 8 | s13 << 24;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 7 | s7 << 25;
  s3 = (s3 + s4 | 0) + m14 | 0;
  s14 ^= s3;
  s14 = s14 >>> 16 | s14 << 16;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 12 | s4 << 20;
  s3 = (s3 + s4 | 0) + m15 | 0;
  s14 ^= s3;
  s14 = s14 >>> 8 | s14 << 24;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 7 | s4 << 25;
  {
    const t0 = m0, t1 = m1;
    m0 = m2;
    m2 = m3;
    m3 = m10;
    m10 = m12;
    m12 = m9;
    m9 = m11;
    m11 = m5;
    m5 = t0;
    m1 = m6;
    m6 = m4;
    m4 = m7;
    m7 = m13;
    m13 = m14;
    m14 = m15;
    m15 = m8;
    m8 = t1;
  }
  s0 = (s0 + s4 | 0) + m0 | 0;
  s12 ^= s0;
  s12 = s12 >>> 16 | s12 << 16;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 12 | s4 << 20;
  s0 = (s0 + s4 | 0) + m1 | 0;
  s12 ^= s0;
  s12 = s12 >>> 8 | s12 << 24;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 7 | s4 << 25;
  s1 = (s1 + s5 | 0) + m2 | 0;
  s13 ^= s1;
  s13 = s13 >>> 16 | s13 << 16;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 12 | s5 << 20;
  s1 = (s1 + s5 | 0) + m3 | 0;
  s13 ^= s1;
  s13 = s13 >>> 8 | s13 << 24;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 7 | s5 << 25;
  s2 = (s2 + s6 | 0) + m4 | 0;
  s14 ^= s2;
  s14 = s14 >>> 16 | s14 << 16;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 12 | s6 << 20;
  s2 = (s2 + s6 | 0) + m5 | 0;
  s14 ^= s2;
  s14 = s14 >>> 8 | s14 << 24;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 7 | s6 << 25;
  s3 = (s3 + s7 | 0) + m6 | 0;
  s15 ^= s3;
  s15 = s15 >>> 16 | s15 << 16;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 12 | s7 << 20;
  s3 = (s3 + s7 | 0) + m7 | 0;
  s15 ^= s3;
  s15 = s15 >>> 8 | s15 << 24;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 7 | s7 << 25;
  s0 = (s0 + s5 | 0) + m8 | 0;
  s15 ^= s0;
  s15 = s15 >>> 16 | s15 << 16;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 12 | s5 << 20;
  s0 = (s0 + s5 | 0) + m9 | 0;
  s15 ^= s0;
  s15 = s15 >>> 8 | s15 << 24;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 7 | s5 << 25;
  s1 = (s1 + s6 | 0) + m10 | 0;
  s12 ^= s1;
  s12 = s12 >>> 16 | s12 << 16;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 12 | s6 << 20;
  s1 = (s1 + s6 | 0) + m11 | 0;
  s12 ^= s1;
  s12 = s12 >>> 8 | s12 << 24;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 7 | s6 << 25;
  s2 = (s2 + s7 | 0) + m12 | 0;
  s13 ^= s2;
  s13 = s13 >>> 16 | s13 << 16;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 12 | s7 << 20;
  s2 = (s2 + s7 | 0) + m13 | 0;
  s13 ^= s2;
  s13 = s13 >>> 8 | s13 << 24;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 7 | s7 << 25;
  s3 = (s3 + s4 | 0) + m14 | 0;
  s14 ^= s3;
  s14 = s14 >>> 16 | s14 << 16;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 12 | s4 << 20;
  s3 = (s3 + s4 | 0) + m15 | 0;
  s14 ^= s3;
  s14 = s14 >>> 8 | s14 << 24;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 7 | s4 << 25;
  {
    const t0 = m0, t1 = m1;
    m0 = m2;
    m2 = m3;
    m3 = m10;
    m10 = m12;
    m12 = m9;
    m9 = m11;
    m11 = m5;
    m5 = t0;
    m1 = m6;
    m6 = m4;
    m4 = m7;
    m7 = m13;
    m13 = m14;
    m14 = m15;
    m15 = m8;
    m8 = t1;
  }
  s0 = (s0 + s4 | 0) + m0 | 0;
  s12 ^= s0;
  s12 = s12 >>> 16 | s12 << 16;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 12 | s4 << 20;
  s0 = (s0 + s4 | 0) + m1 | 0;
  s12 ^= s0;
  s12 = s12 >>> 8 | s12 << 24;
  s8 = s8 + s12 | 0;
  s4 ^= s8;
  s4 = s4 >>> 7 | s4 << 25;
  s1 = (s1 + s5 | 0) + m2 | 0;
  s13 ^= s1;
  s13 = s13 >>> 16 | s13 << 16;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 12 | s5 << 20;
  s1 = (s1 + s5 | 0) + m3 | 0;
  s13 ^= s1;
  s13 = s13 >>> 8 | s13 << 24;
  s9 = s9 + s13 | 0;
  s5 ^= s9;
  s5 = s5 >>> 7 | s5 << 25;
  s2 = (s2 + s6 | 0) + m4 | 0;
  s14 ^= s2;
  s14 = s14 >>> 16 | s14 << 16;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 12 | s6 << 20;
  s2 = (s2 + s6 | 0) + m5 | 0;
  s14 ^= s2;
  s14 = s14 >>> 8 | s14 << 24;
  s10 = s10 + s14 | 0;
  s6 ^= s10;
  s6 = s6 >>> 7 | s6 << 25;
  s3 = (s3 + s7 | 0) + m6 | 0;
  s15 ^= s3;
  s15 = s15 >>> 16 | s15 << 16;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 12 | s7 << 20;
  s3 = (s3 + s7 | 0) + m7 | 0;
  s15 ^= s3;
  s15 = s15 >>> 8 | s15 << 24;
  s11 = s11 + s15 | 0;
  s7 ^= s11;
  s7 = s7 >>> 7 | s7 << 25;
  s0 = (s0 + s5 | 0) + m8 | 0;
  s15 ^= s0;
  s15 = s15 >>> 16 | s15 << 16;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 12 | s5 << 20;
  s0 = (s0 + s5 | 0) + m9 | 0;
  s15 ^= s0;
  s15 = s15 >>> 8 | s15 << 24;
  s10 = s10 + s15 | 0;
  s5 ^= s10;
  s5 = s5 >>> 7 | s5 << 25;
  s1 = (s1 + s6 | 0) + m10 | 0;
  s12 ^= s1;
  s12 = s12 >>> 16 | s12 << 16;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 12 | s6 << 20;
  s1 = (s1 + s6 | 0) + m11 | 0;
  s12 ^= s1;
  s12 = s12 >>> 8 | s12 << 24;
  s11 = s11 + s12 | 0;
  s6 ^= s11;
  s6 = s6 >>> 7 | s6 << 25;
  s2 = (s2 + s7 | 0) + m12 | 0;
  s13 ^= s2;
  s13 = s13 >>> 16 | s13 << 16;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 12 | s7 << 20;
  s2 = (s2 + s7 | 0) + m13 | 0;
  s13 ^= s2;
  s13 = s13 >>> 8 | s13 << 24;
  s8 = s8 + s13 | 0;
  s7 ^= s8;
  s7 = s7 >>> 7 | s7 << 25;
  s3 = (s3 + s4 | 0) + m14 | 0;
  s14 ^= s3;
  s14 = s14 >>> 16 | s14 << 16;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 12 | s4 << 20;
  s3 = (s3 + s4 | 0) + m15 | 0;
  s14 ^= s3;
  s14 = s14 >>> 8 | s14 << 24;
  s9 = s9 + s14 | 0;
  s4 ^= s9;
  s4 = s4 >>> 7 | s4 << 25;
  if (full) {
    out[outOff + 8] = s8 ^ cv[cvOff];
    out[outOff + 9] = s9 ^ cv[cvOff + 1];
    out[outOff + 10] = s10 ^ cv[cvOff + 2];
    out[outOff + 11] = s11 ^ cv[cvOff + 3];
    out[outOff + 12] = s12 ^ cv[cvOff + 4];
    out[outOff + 13] = s13 ^ cv[cvOff + 5];
    out[outOff + 14] = s14 ^ cv[cvOff + 6];
    out[outOff + 15] = s15 ^ cv[cvOff + 7];
  }
  out[outOff] = s0 ^ s8;
  out[outOff + 1] = s1 ^ s9;
  out[outOff + 2] = s2 ^ s10;
  out[outOff + 3] = s3 ^ s11;
  out[outOff + 4] = s4 ^ s12;
  out[outOff + 5] = s5 ^ s13;
  out[outOff + 6] = s6 ^ s14;
  out[outOff + 7] = s7 ^ s15;
}

// node_modules/@huggingface/blake3-jit/dist/esm/constants.js
var IV = new Uint32Array([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var CHUNK_START = 1;
var CHUNK_END = 1 << 1;
var PARENT = 1 << 2;
var ROOT = 1 << 3;
var KEYED_HASH = 1 << 4;
var DERIVE_KEY_CONTEXT = 1 << 5;
var DERIVE_KEY_MATERIAL = 1 << 6;
var OUT_LEN = 32;
var KEY_LEN = 32;
var BLOCK_LEN = 64;
var CHUNK_LEN = 1024;
var MAX_DEPTH = 54;
var PERMUTATIONS = new Uint8Array([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  2,
  6,
  3,
  10,
  7,
  0,
  4,
  13,
  1,
  11,
  12,
  5,
  9,
  14,
  15,
  8,
  3,
  4,
  10,
  12,
  13,
  2,
  7,
  14,
  6,
  5,
  9,
  0,
  11,
  15,
  8,
  1,
  10,
  7,
  12,
  9,
  14,
  3,
  13,
  15,
  4,
  0,
  11,
  2,
  5,
  8,
  1,
  6,
  12,
  13,
  9,
  11,
  15,
  10,
  14,
  8,
  7,
  2,
  5,
  3,
  0,
  1,
  6,
  4,
  9,
  14,
  11,
  5,
  8,
  12,
  15,
  1,
  13,
  3,
  0,
  10,
  2,
  6,
  4,
  7,
  11,
  15,
  5,
  0,
  1,
  9,
  8,
  6,
  14,
  10,
  2,
  12,
  3,
  4,
  7,
  13
]);

// node_modules/@huggingface/blake3-jit/dist/esm/utils.js
var IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([16909060]).buffer)[0] === 4;
function readLittleEndianWordsFull(input, offset, words) {
  for (let i = 0;i < 16; ++i, offset += 4) {
    words[i] = input[offset] | input[offset + 1] << 8 | input[offset + 2] << 16 | input[offset + 3] << 24;
  }
}
function writeLittleEndianBytesPartial(words, wordOffset, output, byteOffset, byteCount) {
  const fullWords = byteCount >>> 2;
  let i = 0;
  for (;i < fullWords; ++i, byteOffset += 4) {
    const w = words[wordOffset + i];
    output[byteOffset] = w & 255;
    output[byteOffset + 1] = w >>> 8 & 255;
    output[byteOffset + 2] = w >>> 16 & 255;
    output[byteOffset + 3] = w >>> 24 & 255;
  }
  const remaining = byteCount & 3;
  if (remaining > 0) {
    const w = words[wordOffset + i];
    output[byteOffset] = w & 255;
    if (remaining > 1)
      output[byteOffset + 1] = w >>> 8 & 255;
    if (remaining > 2)
      output[byteOffset + 2] = w >>> 16 & 255;
  }
}
function encodeUTF8(str) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str);
  }
  const bytes = [];
  for (let i = 0;i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 128) {
      bytes.push(c);
    } else if (c < 2048) {
      bytes.push(192 | c >> 6, 128 | c & 63);
    } else if (c < 55296 || c >= 57344) {
      bytes.push(224 | c >> 12, 128 | c >> 6 & 63, 128 | c & 63);
    } else {
      i++;
      c = 65536 + ((c & 1023) << 10 | str.charCodeAt(i) & 1023);
      bytes.push(240 | c >> 18, 128 | c >> 12 & 63, 128 | c >> 6 & 63, 128 | c & 63);
    }
  }
  return new Uint8Array(bytes);
}
var CTZ32_TABLE = new Uint8Array([
  0,
  1,
  28,
  2,
  29,
  14,
  24,
  3,
  30,
  22,
  20,
  15,
  25,
  17,
  4,
  8,
  31,
  27,
  13,
  23,
  21,
  19,
  16,
  7,
  26,
  12,
  18,
  6,
  11,
  5,
  10,
  9
]);

// node_modules/@huggingface/blake3-jit/dist/esm/hasher.js
class XofReader {
  inputCv;
  blockWords;
  counter;
  blockLen;
  flags;
  outputBlock;
  outputBlockOffset;
  constructor(inputCv, blockWords, counter, blockLen, flags) {
    this.inputCv = inputCv;
    this.blockWords = blockWords;
    this.counter = counter;
    this.blockLen = blockLen;
    this.flags = flags | ROOT;
    this.outputBlock = new Uint32Array(16);
    this.outputBlockOffset = 64;
  }
  read(length) {
    const output = new Uint8Array(length);
    let outputOffset = 0;
    while (outputOffset < length) {
      if (this.outputBlockOffset >= 64) {
        compress(this.inputCv, 0, this.blockWords, 0, this.outputBlock, 0, true, this.counter++, this.blockLen, this.flags);
        this.outputBlockOffset = 0;
      }
      const available = 64 - this.outputBlockOffset;
      const toCopy = Math.min(available, length - outputOffset);
      const wordOffset = this.outputBlockOffset >>> 2;
      const byteWithinWord = this.outputBlockOffset & 3;
      if (byteWithinWord === 0 && toCopy >= 4) {
        const fullWords = toCopy >>> 2;
        writeLittleEndianBytesPartial(this.outputBlock, wordOffset, output, outputOffset, fullWords << 2);
        const bytesCopied = fullWords << 2;
        outputOffset += bytesCopied;
        this.outputBlockOffset += bytesCopied;
      } else {
        for (let i = 0;i < toCopy; i++) {
          const wordIdx = this.outputBlockOffset + i >>> 2;
          const byteIdx = this.outputBlockOffset + i & 3;
          output[outputOffset + i] = this.outputBlock[wordIdx] >>> (byteIdx << 3) & 255;
        }
        outputOffset += toCopy;
        this.outputBlockOffset += toCopy;
      }
    }
    return output;
  }
}

class ChunkState {
  chainingValue;
  chunkCounter;
  blockWords;
  blockLen;
  blocksCompressed;
  flags;
  constructor(keyWords, chunkCounter, flags) {
    this.chainingValue = new Uint32Array(keyWords);
    this.chunkCounter = chunkCounter;
    this.blockWords = new Uint32Array(16);
    this.blockLen = 0;
    this.blocksCompressed = 0;
    this.flags = flags;
  }
  resetTo(keyWords, chunkCounter, flags) {
    this.chainingValue.set(keyWords);
    this.chunkCounter = chunkCounter;
    this.blockLen = 0;
    this.blocksCompressed = 0;
    this.flags = flags;
  }
  startFlag() {
    return this.blocksCompressed === 0 ? CHUNK_START : 0;
  }
  update(input, inputOffset, inputLen) {
    let consumed = 0;
    while (inputLen > 0) {
      if (this.blockLen === BLOCK_LEN) {
        compress(this.chainingValue, 0, this.blockWords, 0, this.chainingValue, 0, false, this.chunkCounter, BLOCK_LEN, this.flags | this.startFlag());
        this.blocksCompressed++;
        this.blockLen = 0;
      }
      const want = BLOCK_LEN - this.blockLen;
      const take = Math.min(want, inputLen);
      if (this.blockLen === 0 && take === BLOCK_LEN) {
        readLittleEndianWordsFull(input, inputOffset, this.blockWords);
      } else {
        for (let i = 0;i < take; i++) {
          const pos = this.blockLen + i;
          const wordIdx = pos >>> 2;
          const byteIdx = pos & 3;
          if (byteIdx === 0) {
            this.blockWords[wordIdx] = input[inputOffset + i];
          } else {
            this.blockWords[wordIdx] |= input[inputOffset + i] << (byteIdx << 3);
          }
        }
      }
      this.blockLen += take;
      inputOffset += take;
      inputLen -= take;
      consumed += take;
    }
    return consumed;
  }
  output() {
    const usedWords = this.blockLen + 3 >>> 2;
    for (let i = usedWords;i < 16; i++) {
      this.blockWords[i] = 0;
    }
    return {
      inputCv: this.chainingValue,
      blockWords: this.blockWords,
      blockLen: this.blockLen,
      counter: this.chunkCounter,
      flags: this.flags | this.startFlag() | CHUNK_END
    };
  }
  len() {
    return this.blocksCompressed * BLOCK_LEN + this.blockLen;
  }
}

class Hasher {
  chunkState;
  keyWords;
  cvStack;
  cvStackLen;
  flags;
  parentBlock;
  parentCv;
  chunkCv;
  outWords;
  finalizeCv;
  constructor(keyWords, flags) {
    this.keyWords = keyWords ? new Uint32Array(keyWords) : new Uint32Array(IV);
    this.flags = flags ?? 0;
    this.chunkState = new ChunkState(this.keyWords, 0, this.flags);
    this.cvStack = new Uint32Array(MAX_DEPTH * 8);
    this.cvStackLen = 0;
    this.parentBlock = new Uint32Array(16);
    this.parentCv = new Uint32Array(8);
    this.chunkCv = new Uint32Array(8);
    this.outWords = new Uint32Array(16);
    this.finalizeCv = new Uint32Array(8);
  }
  reset() {
    this.chunkState.resetTo(this.keyWords, 0, this.flags);
    this.cvStackLen = 0;
    return this;
  }
  static newKeyed(key) {
    if (key.length !== KEY_LEN) {
      throw new Error(`Key must be ${KEY_LEN} bytes, got ${key.length}`);
    }
    const keyWords = new Uint32Array(8);
    if (IS_LITTLE_ENDIAN) {
      const view = new Uint32Array(key.buffer, key.byteOffset, 8);
      keyWords.set(view);
    } else {
      for (let i = 0;i < 8; i++) {
        const off = i * 4;
        keyWords[i] = key[off] | key[off + 1] << 8 | key[off + 2] << 16 | key[off + 3] << 24;
      }
    }
    return new Hasher(keyWords, KEYED_HASH);
  }
  static newDeriveKey(context) {
    const contextBytes = encodeUTF8(context);
    const contextHasher = new Hasher(new Uint32Array(IV), DERIVE_KEY_CONTEXT);
    contextHasher.update(contextBytes);
    const contextKey = new Uint32Array(8);
    const output = contextHasher.finalizeOutput();
    compress(output.inputCv, 0, output.blockWords, 0, contextKey, 0, false, output.counter, output.blockLen, output.flags | ROOT);
    return new Hasher(contextKey, DERIVE_KEY_MATERIAL);
  }
  pushCv(cv, cvOffset) {
    this.cvStack.set(cv.subarray(cvOffset, cvOffset + 8), this.cvStackLen * 8);
    this.cvStackLen++;
  }
  popCv(out, outOffset) {
    this.cvStackLen--;
    out.set(this.cvStack.subarray(this.cvStackLen * 8, (this.cvStackLen + 1) * 8), outOffset);
  }
  addChunkCv(newCv, newCvOffset, totalChunks) {
    const parentBlock = this.parentBlock;
    const parentCv = this.parentCv;
    while ((totalChunks & 1) === 0) {
      this.popCv(parentBlock, 0);
      parentBlock.set(newCv.subarray(newCvOffset, newCvOffset + 8), 8);
      compress(this.keyWords, 0, parentBlock, 0, parentCv, 0, false, 0, BLOCK_LEN, this.flags | PARENT);
      newCv = parentCv;
      newCvOffset = 0;
      totalChunks >>>= 1;
    }
    this.pushCv(newCv, newCvOffset);
  }
  update(input) {
    let inputOffset = 0;
    let inputLen = input.length;
    while (inputLen > 0) {
      if (this.chunkState.len() === CHUNK_LEN) {
        const output = this.chunkState.output();
        const chunkCv = this.chunkCv;
        compress(output.inputCv, 0, output.blockWords, 0, chunkCv, 0, false, output.counter, output.blockLen, output.flags);
        const totalChunks = this.chunkState.chunkCounter + 1;
        this.addChunkCv(chunkCv, 0, totalChunks);
        this.chunkState.resetTo(this.keyWords, totalChunks, this.flags);
      }
      const want = CHUNK_LEN - this.chunkState.len();
      const take = Math.min(want, inputLen);
      this.chunkState.update(input, inputOffset, take);
      inputOffset += take;
      inputLen -= take;
    }
    return this;
  }
  finalizeOutput() {
    let output = this.chunkState.output();
    let parentBlock = this.parentBlock;
    let cv = this.finalizeCv;
    if (this.cvStackLen > 0) {
      compress(output.inputCv, 0, output.blockWords, 0, cv, 0, false, output.counter, output.blockLen, output.flags);
      while (this.cvStackLen > 0) {
        this.cvStackLen--;
        parentBlock.set(this.cvStack.subarray(this.cvStackLen * 8, (this.cvStackLen + 1) * 8), 0);
        parentBlock.set(cv, 8);
        if (this.cvStackLen > 0) {
          compress(this.keyWords, 0, parentBlock, 0, cv, 0, false, 0, BLOCK_LEN, this.flags | PARENT);
        } else {
          return {
            inputCv: this.keyWords,
            blockWords: parentBlock,
            blockLen: BLOCK_LEN,
            counter: 0,
            flags: this.flags | PARENT
          };
        }
      }
    }
    return output;
  }
  finalize(outputLength = OUT_LEN) {
    const output = this.finalizeOutput();
    const result = new Uint8Array(outputLength);
    if (outputLength <= 64) {
      const outWords = this.outWords;
      compress(output.inputCv, 0, output.blockWords, 0, outWords, 0, outputLength > 32, output.counter, output.blockLen, output.flags | ROOT);
      if (IS_LITTLE_ENDIAN) {
        const outBytes = new Uint8Array(outWords.buffer);
        result.set(outBytes.subarray(0, outputLength));
      } else {
        writeLittleEndianBytesPartial(outWords, 0, result, 0, outputLength);
      }
    } else {
      const xof = this.finalizeXof();
      const full = xof.read(outputLength);
      result.set(full);
    }
    return result;
  }
  finalizeXof() {
    const output = this.finalizeOutput();
    return new XofReader(new Uint32Array(output.inputCv), new Uint32Array(output.blockWords), output.counter, output.blockLen, output.flags);
  }
}
// node_modules/@huggingface/blake3-jit/dist/esm/wasm-simd.js
function toLebU32Min2(n) {
  return [n & 127 | 128, n >>> 7 & 127];
}
function toLebU32Padded5(n) {
  return [
    n & 127 | 128,
    n >>> 7 & 127 | 128,
    n >>> 14 & 127 | 128,
    n >>> 21 & 127 | 128,
    n >>> 28 & 15
  ];
}
function toSignedLeb128_i32(n) {
  const bytes = [];
  let value = n | 0;
  let more = true;
  while (more) {
    let byte = value & 127;
    value >>= 7;
    if (value === 0 && (byte & 64) === 0 || value === -1 && (byte & 64) !== 0) {
      more = false;
    } else {
      byte |= 128;
    }
    bytes.push(byte);
  }
  return bytes;
}
var MSG_ACCESS_ORDER = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  2,
  6,
  3,
  10,
  7,
  0,
  4,
  13,
  1,
  11,
  12,
  5,
  9,
  14,
  15,
  8,
  3,
  4,
  10,
  12,
  13,
  2,
  7,
  14,
  6,
  5,
  9,
  0,
  11,
  15,
  8,
  1,
  10,
  7,
  12,
  9,
  14,
  3,
  13,
  15,
  4,
  0,
  11,
  2,
  5,
  8,
  1,
  6,
  12,
  13,
  9,
  11,
  15,
  10,
  14,
  8,
  7,
  2,
  5,
  3,
  0,
  1,
  6,
  4,
  9,
  14,
  11,
  5,
  8,
  12,
  15,
  1,
  13,
  3,
  0,
  10,
  2,
  6,
  4,
  7,
  11,
  15,
  5,
  0,
  1,
  9,
  8,
  6,
  14,
  10,
  2,
  12,
  3,
  4,
  7,
  13
];
function generateWasmBytes() {
  const code = [];
  function put(bytes) {
    code.push(...bytes);
  }
  put([0, 97, 115, 109]);
  put([1, 0, 0, 0]);
  put([1]);
  put([4]);
  put([1]);
  put([96, 0, 0]);
  put([2]);
  put([11]);
  put([1]);
  put([2, 106, 115]);
  put([3, 109, 101, 109]);
  put([2, 0, 1]);
  put([3]);
  put([4]);
  put([3]);
  put([0]);
  put([0]);
  put([0]);
  put([7]);
  put([50]);
  put([3]);
  put([10]);
  put([99, 111, 109, 112, 114, 101, 115, 115, 52, 120]);
  put([0, 0]);
  put([16]);
  put([
    99,
    111,
    109,
    112,
    114,
    101,
    115,
    115,
    67,
    104,
    117,
    110,
    107,
    115,
    52,
    120
  ]);
  put([0, 1]);
  put([14]);
  put([99, 111, 109, 112, 114, 101, 115, 115, 80, 97, 114, 101, 110, 116]);
  put([0, 2]);
  put([10]);
  const sectionSizeOffset = code.length;
  put([0, 0, 0, 0, 0]);
  put([3]);
  const funcSizeOffset = code.length;
  put([0, 0, 0, 0, 0]);
  const funcBodyStart = code.length;
  put([1]);
  put([32, 123]);
  for (let i = 0;i < 16; i++) {
    put([65, ...toLebU32Min2(i * 16)]);
    put([253, 0, 2, 0]);
    put([33, i]);
  }
  for (let i = 0;i < 8; i++) {
    put([65, ...toLebU32Min2(512 + i * 16)]);
    put([253, 0, 2, 0]);
    put([33, 16 + i]);
  }
  const IV = [1779033703, 3144134277, 1013904242, 2773480762];
  for (let i = 0;i < 4; i++) {
    const ivBytes = [];
    for (let j = 0;j < 4; j++) {
      ivBytes.push(IV[i] & 255);
      ivBytes.push(IV[i] >>> 8 & 255);
      ivBytes.push(IV[i] >>> 16 & 255);
      ivBytes.push(IV[i] >>> 24 & 255);
    }
    put([253, 12, ...ivBytes]);
    put([33, 24 + i]);
  }
  put([65, ...toLebU32Min2(768)]);
  put([253, 0, 2, 0]);
  put([33, 28]);
  put([65, ...toLebU32Min2(784)]);
  put([253, 0, 2, 0]);
  put([33, 29]);
  put([65, ...toLebU32Min2(800)]);
  put([253, 0, 2, 0]);
  put([33, 30]);
  put([65, ...toLebU32Min2(816)]);
  put([253, 0, 2, 0]);
  put([33, 31]);
  let msgIdx = 0;
  function g(a, b, c, d) {
    const mx = MSG_ACCESS_ORDER[msgIdx++];
    const my = MSG_ACCESS_ORDER[msgIdx++];
    put([32, 16 + a]);
    put([32, 16 + b]);
    put([253, 174, 1]);
    put([32, mx]);
    put([253, 174, 1]);
    put([33, 16 + a]);
    put([32, 16 + d]);
    put([32, 16 + a]);
    put([253, 81]);
    put([34, 16 + d]);
    put([32, 16 + d]);
    put([253, 13, 2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13]);
    put([33, 16 + d]);
    put([32, 16 + c]);
    put([32, 16 + d]);
    put([253, 174, 1]);
    put([33, 16 + c]);
    put([32, 16 + b]);
    put([32, 16 + c]);
    put([253, 81]);
    put([34, 16 + b]);
    put([65, 12]);
    put([253, 173, 1]);
    put([32, 16 + b]);
    put([65, 20]);
    put([253, 171, 1]);
    put([253, 80]);
    put([33, 16 + b]);
    put([32, 16 + a]);
    put([32, 16 + b]);
    put([253, 174, 1]);
    put([32, my]);
    put([253, 174, 1]);
    put([33, 16 + a]);
    put([32, 16 + d]);
    put([32, 16 + a]);
    put([253, 81]);
    put([34, 16 + d]);
    put([32, 16 + d]);
    put([253, 13, 1, 2, 3, 0, 5, 6, 7, 4, 9, 10, 11, 8, 13, 14, 15, 12]);
    put([33, 16 + d]);
    put([32, 16 + c]);
    put([32, 16 + d]);
    put([253, 174, 1]);
    put([33, 16 + c]);
    put([32, 16 + b]);
    put([32, 16 + c]);
    put([253, 81]);
    put([34, 16 + b]);
    put([65, 7]);
    put([253, 173, 1]);
    put([32, 16 + b]);
    put([65, 25]);
    put([253, 171, 1]);
    put([253, 80]);
    put([33, 16 + b]);
  }
  for (let round = 0;round < 7; round++) {
    g(0, 4, 8, 12);
    g(1, 5, 9, 13);
    g(2, 6, 10, 14);
    g(3, 7, 11, 15);
    g(0, 5, 10, 15);
    g(1, 6, 11, 12);
    g(2, 7, 8, 13);
    g(3, 4, 9, 14);
  }
  for (let i = 0;i < 8; i++) {
    put([65, ...toLebU32Min2(640 + i * 16)]);
    put([32, 16 + i]);
    put([32, 24 + i]);
    put([253, 81]);
    put([253, 11, 2, 0]);
  }
  put([11]);
  const funcBodySize = code.length - funcBodyStart;
  const funcSizeBytes = toLebU32Padded5(funcBodySize);
  for (let i = 0;i < 5; i++) {
    code[funcSizeOffset + i] = funcSizeBytes[i];
  }
  const func1SizeOffset = code.length;
  put([0, 0, 0, 0, 0]);
  const func1BodyStart = code.length;
  const compressChunksBody = generateCompressChunks4xBody();
  put(compressChunksBody);
  const func1BodySize = code.length - func1BodyStart;
  const func1SizeBytes = toLebU32Padded5(func1BodySize);
  for (let i = 0;i < 5; i++) {
    code[func1SizeOffset + i] = func1SizeBytes[i];
  }
  const func2SizeOffset = code.length;
  put([0, 0, 0, 0, 0]);
  const func2BodyStart = code.length;
  const compressParentBody = generateCompressParentBody();
  put(compressParentBody);
  const func2BodySize = code.length - func2BodyStart;
  const func2SizeBytes = toLebU32Padded5(func2BodySize);
  for (let i = 0;i < 5; i++) {
    code[func2SizeOffset + i] = func2SizeBytes[i];
  }
  const sectionSize = code.length - sectionSizeOffset - 5;
  const sectionSizeBytes = toLebU32Padded5(sectionSize);
  for (let i = 0;i < 5; i++) {
    code[sectionSizeOffset + i] = sectionSizeBytes[i];
  }
  return new Uint8Array(code);
}
function generateCompressChunks4xBody() {
  const code = [];
  function put(bytes) {
    code.push(...bytes);
  }
  put([2]);
  put([32, 123]);
  put([1, 127]);
  const BATCH_BLOCK_WORDS = SIMD_MEMORY.BATCH_BLOCK_WORDS;
  const BATCH_CV = SIMD_MEMORY.BATCH_CV;
  const BATCH_COUNTER_LOW = SIMD_MEMORY.BATCH_COUNTER_LOW;
  const BATCH_FLAGS_BASE = SIMD_MEMORY.BATCH_FLAGS_BASE;
  const BATCH_OUTPUT = SIMD_MEMORY.BATCH_OUTPUT;
  const IV = [1779033703, 3144134277, 1013904242, 2773480762];
  for (let i = 0;i < 8; i++) {
    put([65, ...toLebU32Min2(BATCH_CV + i * 16)]);
    put([253, 0, 2, 0]);
    put([33, 16 + i]);
  }
  put([65, 0]);
  put([33, 32]);
  put([2, 64]);
  put([3, 64]);
  for (let w = 0;w < 16; w++) {
    put([32, 32]);
    put([65, ...toLebU32Min2(256)]);
    put([108]);
    put([65, ...toLebU32Min2(BATCH_BLOCK_WORDS + w * 16)]);
    put([106]);
    put([253, 0, 2, 0]);
    put([33, w]);
  }
  for (let i = 0;i < 4; i++) {
    const ivBytes = [];
    for (let j = 0;j < 4; j++) {
      ivBytes.push(IV[i] & 255);
      ivBytes.push(IV[i] >>> 8 & 255);
      ivBytes.push(IV[i] >>> 16 & 255);
      ivBytes.push(IV[i] >>> 24 & 255);
    }
    put([253, 12, ...ivBytes]);
    put([33, 24 + i]);
  }
  put([65, ...toLebU32Min2(BATCH_COUNTER_LOW)]);
  put([253, 0, 2, 0]);
  put([33, 28]);
  put([253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  put([33, 29]);
  const blockLen64 = [];
  for (let j = 0;j < 4; j++) {
    blockLen64.push(64, 0, 0, 0);
  }
  put([253, 12, ...blockLen64]);
  put([33, 30]);
  put([65, ...toLebU32Min2(BATCH_FLAGS_BASE)]);
  put([253, 0, 2, 0]);
  put([32, 32]);
  put([69]);
  put([32, 32]);
  put([65, 15]);
  put([70]);
  put([65, 1]);
  put([116]);
  put([114]);
  put([253, 17]);
  put([253, 80]);
  put([33, 31]);
  let msgIdx = 0;
  function g(a, b, c, d) {
    const mx = MSG_ACCESS_ORDER[msgIdx++];
    const my = MSG_ACCESS_ORDER[msgIdx++];
    put([32, 16 + a]);
    put([32, 16 + b]);
    put([253, 174, 1]);
    put([32, mx]);
    put([253, 174, 1]);
    put([33, 16 + a]);
    put([32, 16 + d]);
    put([32, 16 + a]);
    put([253, 81]);
    put([34, 16 + d]);
    put([32, 16 + d]);
    put([253, 13, 2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13]);
    put([33, 16 + d]);
    put([32, 16 + c]);
    put([32, 16 + d]);
    put([253, 174, 1]);
    put([33, 16 + c]);
    put([32, 16 + b]);
    put([32, 16 + c]);
    put([253, 81]);
    put([34, 16 + b]);
    put([65, 12]);
    put([253, 173, 1]);
    put([32, 16 + b]);
    put([65, 20]);
    put([253, 171, 1]);
    put([253, 80]);
    put([33, 16 + b]);
    put([32, 16 + a]);
    put([32, 16 + b]);
    put([253, 174, 1]);
    put([32, my]);
    put([253, 174, 1]);
    put([33, 16 + a]);
    put([32, 16 + d]);
    put([32, 16 + a]);
    put([253, 81]);
    put([34, 16 + d]);
    put([32, 16 + d]);
    put([253, 13, 1, 2, 3, 0, 5, 6, 7, 4, 9, 10, 11, 8, 13, 14, 15, 12]);
    put([33, 16 + d]);
    put([32, 16 + c]);
    put([32, 16 + d]);
    put([253, 174, 1]);
    put([33, 16 + c]);
    put([32, 16 + b]);
    put([32, 16 + c]);
    put([253, 81]);
    put([34, 16 + b]);
    put([65, 7]);
    put([253, 173, 1]);
    put([32, 16 + b]);
    put([65, 25]);
    put([253, 171, 1]);
    put([253, 80]);
    put([33, 16 + b]);
  }
  for (let round = 0;round < 7; round++) {
    g(0, 4, 8, 12);
    g(1, 5, 9, 13);
    g(2, 6, 10, 14);
    g(3, 7, 11, 15);
    g(0, 5, 10, 15);
    g(1, 6, 11, 12);
    g(2, 7, 8, 13);
    g(3, 4, 9, 14);
  }
  for (let i = 0;i < 8; i++) {
    put([32, 16 + i]);
    put([32, 24 + i]);
    put([253, 81]);
    put([33, 16 + i]);
  }
  put([32, 32]);
  put([65, 1]);
  put([106]);
  put([34, 32]);
  put([65, 16]);
  put([73]);
  put([13, 0]);
  put([11]);
  put([11]);
  for (let i = 0;i < 8; i++) {
    put([65, ...toLebU32Min2(BATCH_OUTPUT + i * 16)]);
    put([32, 16 + i]);
    put([253, 11, 2, 0]);
  }
  put([11]);
  return code;
}
function generateCompressParentBody() {
  const code = [];
  function put(bytes) {
    code.push(...bytes);
  }
  put([1]);
  put([32, 127]);
  const PARENT_BLOCK_OFFSET = SIMD_MEMORY.PARENT_BLOCK;
  const CHUNK_CV_OFFSET = SIMD_MEMORY.CHUNK_CV;
  const IV = [
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ];
  for (let i = 0;i < 16; i++) {
    put([65, ...toLebU32Min2(PARENT_BLOCK_OFFSET + i * 4)]);
    put([40, 2, 0]);
    put([33, i]);
  }
  for (let i = 0;i < 8; i++) {
    put([65, ...toSignedLeb128_i32(IV[i])]);
    put([33, 16 + i]);
  }
  for (let i = 0;i < 4; i++) {
    put([65, ...toSignedLeb128_i32(IV[i])]);
    put([33, 24 + i]);
  }
  put([65, 0]);
  put([33, 28]);
  put([65, 0]);
  put([33, 29]);
  put([65, 192, 0]);
  put([33, 30]);
  put([65, 4]);
  put([33, 31]);
  function g(a, b, c, d, mx, my) {
    const sa = 16 + a, sb = 16 + b, sc = 16 + c, sd = 16 + d;
    put([32, sa]);
    put([32, sb]);
    put([106]);
    put([32, mx]);
    put([106]);
    put([33, sa]);
    put([32, sd]);
    put([32, sa]);
    put([115]);
    put([65, 16]);
    put([120]);
    put([33, sd]);
    put([32, sc]);
    put([32, sd]);
    put([106]);
    put([33, sc]);
    put([32, sb]);
    put([32, sc]);
    put([115]);
    put([65, 12]);
    put([120]);
    put([33, sb]);
    put([32, sa]);
    put([32, sb]);
    put([106]);
    put([32, my]);
    put([106]);
    put([33, sa]);
    put([32, sd]);
    put([32, sa]);
    put([115]);
    put([65, 8]);
    put([120]);
    put([33, sd]);
    put([32, sc]);
    put([32, sd]);
    put([106]);
    put([33, sc]);
    put([32, sb]);
    put([32, sc]);
    put([115]);
    put([65, 7]);
    put([120]);
    put([33, sb]);
  }
  let msgIdx = 0;
  for (let round = 0;round < 7; round++) {
    g(0, 4, 8, 12, MSG_ACCESS_ORDER[msgIdx], MSG_ACCESS_ORDER[msgIdx + 1]);
    msgIdx += 2;
    g(1, 5, 9, 13, MSG_ACCESS_ORDER[msgIdx], MSG_ACCESS_ORDER[msgIdx + 1]);
    msgIdx += 2;
    g(2, 6, 10, 14, MSG_ACCESS_ORDER[msgIdx], MSG_ACCESS_ORDER[msgIdx + 1]);
    msgIdx += 2;
    g(3, 7, 11, 15, MSG_ACCESS_ORDER[msgIdx], MSG_ACCESS_ORDER[msgIdx + 1]);
    msgIdx += 2;
    g(0, 5, 10, 15, MSG_ACCESS_ORDER[msgIdx], MSG_ACCESS_ORDER[msgIdx + 1]);
    msgIdx += 2;
    g(1, 6, 11, 12, MSG_ACCESS_ORDER[msgIdx], MSG_ACCESS_ORDER[msgIdx + 1]);
    msgIdx += 2;
    g(2, 7, 8, 13, MSG_ACCESS_ORDER[msgIdx], MSG_ACCESS_ORDER[msgIdx + 1]);
    msgIdx += 2;
    g(3, 4, 9, 14, MSG_ACCESS_ORDER[msgIdx], MSG_ACCESS_ORDER[msgIdx + 1]);
    msgIdx += 2;
  }
  for (let i = 0;i < 8; i++) {
    put([65, ...toLebU32Min2(CHUNK_CV_OFFSET + i * 4)]);
    put([32, 16 + i]);
    put([32, 24 + i]);
    put([115]);
    put([54, 2, 0]);
  }
  put([11]);
  return code;
}
var wasmInstance = null;
var wasmMemory = null;
var wasmCompress4x = null;
var wasmCompressChunks4x = null;
var wasmCompressParent = null;
var wasmMemoryView = null;
var wasmMemoryView32 = null;
function isSimdSupported() {
  try {
    const simdTest = new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      1,
      5,
      1,
      96,
      0,
      1,
      123,
      3,
      2,
      1,
      0,
      10,
      22,
      1,
      20,
      0,
      253,
      12,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      11
    ]);
    return WebAssembly.validate(simdTest);
  } catch {
    return false;
  }
}
function setupArenaViews() {
  if (!wasmMemory)
    return;
  const buffer = wasmMemory.buffer;
  arenaCvStack = new Uint32Array(buffer, SIMD_MEMORY.CV_STACK, 64 * 8);
  arenaParentBlock = new Uint32Array(buffer, SIMD_MEMORY.PARENT_BLOCK, 16);
  arenaChunkCv = new Uint32Array(buffer, SIMD_MEMORY.CHUNK_CV, 8);
  arenaTempCvs = new Uint32Array(buffer, SIMD_MEMORY.TEMP_CVS, 32);
  arenaBatchBlockWords = new Uint32Array(buffer, SIMD_MEMORY.BATCH_BLOCK_WORDS, 16 * 16 * 4);
  arenaBatchCv = new Uint32Array(buffer, SIMD_MEMORY.BATCH_CV, 32);
  arenaBatchCounterLow = new Uint32Array(buffer, SIMD_MEMORY.BATCH_COUNTER_LOW, 4);
  arenaBatchFlagsBase = new Uint32Array(buffer, SIMD_MEMORY.BATCH_FLAGS_BASE, 4);
  arenaBatchOutput = new Uint32Array(buffer, SIMD_MEMORY.BATCH_OUTPUT, 32);
}
var cachedWasmBytes = null;
function initSimdSync() {
  if (wasmInstance)
    return true;
  if (!isSimdSupported()) {
    return false;
  }
  try {
    const wasmBytes = cachedWasmBytes || generateWasmBytes();
    cachedWasmBytes = wasmBytes;
    wasmMemory = new WebAssembly.Memory({ initial: 1 });
    const importObject = {
      js: { mem: wasmMemory }
    };
    const module = new WebAssembly.Module(wasmBytes.buffer);
    wasmInstance = new WebAssembly.Instance(module, importObject);
    wasmCompress4x = wasmInstance.exports.compress4x;
    wasmCompressChunks4x = wasmInstance.exports.compressChunks4x;
    wasmCompressParent = wasmInstance.exports.compressParent;
    wasmMemoryView = new Uint8Array(wasmMemory.buffer);
    wasmMemoryView32 = new Uint32Array(wasmMemory.buffer);
    setupArenaViews();
    return true;
  } catch (e) {
    console.warn("Failed to initialize WASM SIMD:", e);
    return false;
  }
}
var SIMD_MEMORY = {
  BLOCK_WORDS: 0,
  CHAINING_VALUES: 512,
  OUTPUT: 640,
  COUNTER_LOW: 768,
  COUNTER_HIGH: 784,
  BLOCK_LEN: 800,
  FLAGS: 816,
  BATCH_BLOCK_WORDS: 832,
  BATCH_CV: 4928,
  BATCH_COUNTER_LOW: 5056,
  BATCH_FLAGS_BASE: 5072,
  BATCH_OUTPUT: 5088,
  CV_STACK: 5216,
  PARENT_BLOCK: 7264,
  CHUNK_CV: 7328,
  TEMP_CVS: 7360
};
var arenaCvStack = null;
var arenaParentBlock = null;
var arenaChunkCv = null;
var arenaTempCvs = null;
var arenaBatchBlockWords = null;
var arenaBatchCv = null;
var arenaBatchCounterLow = null;
var arenaBatchFlagsBase = null;
var arenaBatchOutput = null;

// node_modules/@huggingface/blake3-jit/dist/esm/hash.js
var CV_STACK_DEPTH = 64;
var HYPER_CV_STACK = new Uint32Array(CV_STACK_DEPTH * 8);
var CV_POOL_SIZE = 64;
var CV_POOL = new Uint32Array(CV_POOL_SIZE * 8);
var CV_VIEWS = [];
for (let i = 0;i < CV_POOL_SIZE; i++) {
  CV_VIEWS.push(CV_POOL.subarray(i * 8, i * 8 + 8));
}
var simdAvailable = false;
var SIMD_THRESHOLD = 4 * CHUNK_LEN;
function ensureSimdSync() {
  if (simdAvailable)
    return true;
  simdAvailable = initSimdSync();
  return simdAvailable;
}
var simdChunkCvs = new Uint32Array(32);
var reusableTempCv = new Uint32Array(8);
var reusableChunkCv = new Uint32Array(8);
var reusablePureParentBlock = new Uint32Array(16);
var reusablePureParentCv = new Uint32Array(8);
var reusableSimdCvs = new Uint32Array(32);
var reusableSimdParentBlock = new Uint32Array(16);
var reusableSimdParentCv = new Uint32Array(8);
var reusableOffsets = new Uint32Array(4);
var reusableCounters = new Uint32Array(4);
var reusableBlockLens = new Uint32Array(4);
var reusableFlags = new Uint32Array(4);
var reusableOut8 = new Uint32Array(8);
var reusableOut8View = new Uint8Array(reusableOut8.buffer, 0, 32);
var SIMD_CV_BASE = SIMD_MEMORY.CHAINING_VALUES / 4;
var SIMD_OUT_BASE = SIMD_MEMORY.OUTPUT / 4;
var SIMD_COUNTER_LOW_BASE = SIMD_MEMORY.COUNTER_LOW / 4;
var SIMD_COUNTER_HIGH_BASE = SIMD_MEMORY.COUNTER_HIGH / 4;
var SIMD_BLOCK_LEN_BASE = SIMD_MEMORY.BLOCK_LEN / 4;
var BATCH_CV_BASE = SIMD_MEMORY.BATCH_CV / 4;
var BATCH_COUNTER_LOW_BASE = SIMD_MEMORY.BATCH_COUNTER_LOW / 4;
var BATCH_FLAGS_BASE_OFFSET = SIMD_MEMORY.BATCH_FLAGS_BASE / 4;
var BATCH_OUTPUT_BASE = SIMD_MEMORY.BATCH_OUTPUT / 4;
var batchChunkOffsets = new Uint32Array(4);
var SIMD_FLAGS_BASE = SIMD_MEMORY.FLAGS / 4;
function warmupSimd() {
  return ensureSimdSync();
}

// node_modules/@huggingface/blake3-jit/dist/esm/index.js
if (typeof globalThis !== "undefined" && typeof globalThis.document !== "undefined") {
  queueMicrotask(() => {
    warmupSimd();
  });
}

// node_modules/@huggingface/xetchunk-wasm/dist/esm/xet-chunker.js
var TARGET_CHUNK_SIZE = 64 * 1024;
var BLAKE3_DATA_KEY = new Uint8Array([
  102,
  151,
  245,
  119,
  91,
  149,
  80,
  222,
  49,
  53,
  203,
  172,
  165,
  151,
  24,
  28,
  157,
  228,
  33,
  16,
  155,
  235,
  43,
  88,
  180,
  208,
  176,
  75,
  147,
  173,
  242,
  41
]);
// node_modules/@huggingface/xetchunk-wasm/dist/esm/xorb-hash.js
var BLAKE3_NODE_KEY = new Uint8Array([
  1,
  126,
  197,
  199,
  165,
  71,
  41,
  150,
  253,
  148,
  102,
  102,
  180,
  138,
  2,
  230,
  93,
  221,
  83,
  111,
  55,
  199,
  109,
  210,
  248,
  99,
  82,
  230,
  74,
  83,
  113,
  63
]);
var INDEX_OF_LAST_BYTE_OF_LAST_U64_IN_CHUNK_HASH = 3 * 8;
var nodeHasher = Hasher.newKeyed(BLAKE3_NODE_KEY);
// node_modules/@huggingface/xetchunk-wasm/dist/esm/hash-utils.js
var ZERO_KEY = new Uint8Array(32);
var VERIFICATION_KEY = new Uint8Array([
  127,
  24,
  87,
  214,
  206,
  86,
  237,
  102,
  18,
  127,
  249,
  19,
  231,
  165,
  195,
  243,
  164,
  205,
  38,
  213,
  181,
  219,
  73,
  230,
  65,
  36,
  152,
  127,
  40,
  251,
  148,
  195
]);
var fileHasher = Hasher.newKeyed(ZERO_KEY);
var verificationHasher = Hasher.newKeyed(VERIFICATION_KEY);
// node_modules/@huggingface/hub/dist/chunk-QHHEO5TW.mjs
var HUB_URL = "https://huggingface.co";
async function createApiError(response, opts) {
  const error = new HubApiError(response.url, response.status, response.headers.get("X-Request-Id") ?? opts?.requestId);
  error.message = `Api error with status ${error.statusCode}${opts?.message ? `. ${opts.message}` : ""}`;
  const trailer = [`URL: ${error.url}`, error.requestId ? `Request ID: ${error.requestId}` : undefined].filter(Boolean).join(". ");
  if (response.headers.get("Content-Type")?.startsWith("application/json")) {
    const json = await response.json();
    error.message = json.error || json.message || error.message;
    if (json.error_description) {
      error.message = error.message ? error.message + `: ${json.error_description}` : json.error_description;
    }
    error.data = json;
  } else {
    error.data = { message: await response.text() };
  }
  error.message += `. ${trailer}`;
  throw error;
}
var HubApiError = class extends Error {
  statusCode;
  url;
  requestId;
  data;
  constructor(url, statusCode, requestId, message) {
    super(message);
    this.statusCode = statusCode;
    this.requestId = requestId;
    this.url = url;
  }
};
function checkAccessToken(accessToken) {
  if (!accessToken.startsWith("hf_")) {
    throw new TypeError("Your access token must start with 'hf_'");
  }
}
function checkCredentials(params) {
  if (params.accessToken) {
    checkAccessToken(params.accessToken);
    return params.accessToken;
  }
  if (params.credentials?.accessToken) {
    checkAccessToken(params.credentials.accessToken);
    return params.credentials.accessToken;
  }
}
var isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";
var isWebWorker = typeof self === "object" && self.constructor && self.constructor.name === "DedicatedWorkerGlobalScope";
var isBackend = !isBrowser && !isWebWorker;
var isFrontend = !isBackend;
var resolve3;
var waitPromise = new Promise((r) => {
  resolve3 = r;
});
var hashSize = 65536;
var mlBits = 4;
var mlMask = (1 << mlBits) - 1;
var runBits = 4;
var runMask = (1 << runBits) - 1;
var blockBuf = makeBuffer(5242880);
var hashTable = makeHashTable();
function makeHashTable() {
  try {
    return new Uint32Array(hashSize);
  } catch (error) {
    const hashTable2 = new Array(hashSize);
    for (let i = 0;i < hashSize; i++) {
      hashTable2[i] = 0;
    }
    return hashTable2;
  }
}
function makeBuffer(size) {
  return new Uint8Array(size);
}
var textEncoder = new TextEncoder;
var CRLF = textEncoder.encode(`\r
`);
var HEADER_SEPARATOR = textEncoder.encode(`\r
\r
`);
function hasH2Fetch(versions = typeof process !== "undefined" ? process.versions : undefined, frontend = isFrontend) {
  if (frontend || !versions?.undici || versions.bun) {
    return false;
  }
  return Number(versions.undici.split(".")[0]) >= 8;
}
var GLOBAL_DISPATCHER_KEYS = [Symbol.for("undici.globalDispatcher.2"), Symbol.for("undici.globalDispatcher.1")];
function withHttp1(base) {
  return {
    dispatch: (options, handler) => base.dispatch({ ...options, allowH2: false }, handler)
  };
}
var cached;
async function getHttp1Dispatcher() {
  const globals = globalThis;
  const find = () => GLOBAL_DISPATCHER_KEYS.map((key) => globals[key]).find((d) => typeof d?.dispatch === "function");
  let base = find();
  if (base === undefined) {
    await (await fetch("data:,")).arrayBuffer();
    base = find();
  }
  if (base === undefined) {
    return;
  }
  if (cached?.base !== base) {
    cached = { base, http1: withHttp1(base) };
  }
  return cached.http1;
}
var undiciHttp1Fetch = async (input, init) => {
  const dispatcher = await getHttp1Dispatcher();
  return dispatcher ? fetch(input, { ...init, dispatcher }) : fetch(input, init);
};
var http1Fetch = hasH2Fetch() ? undiciHttp1Fetch : (input, init) => fetch(input, init);
var HASH_LENGTH = 32;
var XORB_HASH_BOOKEND = "ff".repeat(HASH_LENGTH);
var ZERO_KEY2 = new Uint8Array(32);
var TARGET_CHUNK_SIZE2 = 65536;
var MAX_CHUNK_SIZE = 2 * TARGET_CHUNK_SIZE2;
var PROCESSING_PROGRESS_RATIO = 0.1;
var UPLOADING_PROGRESS_RATIO = 1 - PROCESSING_PROGRESS_RATIO;
var SHARD_MAGIC_TAG = new Uint8Array([
  72,
  70,
  82,
  101,
  112,
  111,
  77,
  101,
  116,
  97,
  68,
  97,
  116,
  97,
  0,
  85,
  105,
  103,
  69,
  106,
  123,
  129,
  87,
  131,
  165,
  189,
  217,
  92,
  205,
  209,
  74,
  169
]);
function parseLinkHeader(header) {
  const regex = /<(https?:[/][/][^>]+)>;\s+rel="([^"]+)"/g;
  return Object.fromEntries([...header.matchAll(regex)].map(([, url, rel]) => [rel, url]));
}
var REGEX_COMMIT_HASH = new RegExp("^[0-9a-f]{40}$");
function normalizeInferenceProviderMapping(hfModelId, inferenceProviderMapping) {
  if (!inferenceProviderMapping) {
    return [];
  }
  if (Array.isArray(inferenceProviderMapping)) {
    return inferenceProviderMapping.map((entry) => ({
      ...entry,
      hfModelId
    }));
  }
  return Object.entries(inferenceProviderMapping).map(([provider, mapping]) => ({
    provider,
    hfModelId,
    providerId: mapping.providerId,
    status: mapping.status,
    task: mapping.task
  }));
}
var MODEL_EXPAND_KEYS = [
  "pipeline_tag",
  "private",
  "gated",
  "downloads",
  "likes",
  "lastModified"
];
var MODEL_DERIVED_FIELD_TO_API_KEY = {
  filePaths: "siblings"
};
async function* listModels(params) {
  const accessToken = params && checkCredentials(params);
  let totalToFetch = params?.limit ?? Infinity;
  const additionalExpandKeys = params?.additionalFields?.map((field) => MODEL_DERIVED_FIELD_TO_API_KEY[field] ?? field) ?? [];
  const search = new URLSearchParams([
    ...Object.entries({
      limit: String(Math.min(totalToFetch, 500)),
      ...params?.search?.owner ? { author: params.search.owner } : undefined,
      ...params?.search?.task ? { pipeline_tag: params.search.task } : undefined,
      ...params?.search?.query ? { search: params.search.query } : undefined,
      ...params?.search?.inferenceProviders ? { inference_provider: params.search.inferenceProviders.join(",") } : undefined,
      ...params?.search?.apps ? { apps: params.search.apps.join(",") } : undefined,
      ...params?.sort ? { sort: params.sort } : undefined
    }),
    ...params?.search?.tags?.map((tag) => ["filter", tag]) ?? [],
    ...MODEL_EXPAND_KEYS.map((val) => ["expand", val]),
    ...additionalExpandKeys.map((val) => ["expand", val])
  ]).toString();
  let url = `${params?.hubUrl || HUB_URL}/api/models?${search}`;
  while (url) {
    const res = await (params?.fetch ?? fetch)(url, {
      headers: {
        accept: "application/json",
        ...accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined
      }
    });
    if (!res.ok) {
      throw await createApiError(res);
    }
    const items = await res.json();
    for (const item of items) {
      const additional = {};
      if (params?.additionalFields) {
        for (const field of params.additionalFields) {
          if (field === "filePaths") {
            additional.filePaths = (item.siblings ?? []).map((s) => s.rfilename);
          } else if (field === "inferenceProviderMapping" && item.inferenceProviderMapping) {
            additional.inferenceProviderMapping = normalizeInferenceProviderMapping(item.id, item.inferenceProviderMapping);
          } else {
            additional[field] = item[field];
          }
        }
      }
      yield {
        ...additional,
        id: item._id,
        name: item.id,
        private: item.private,
        task: item.pipeline_tag,
        downloads: item.downloads,
        gated: item.gated,
        likes: item.likes,
        updatedAt: new Date(item.lastModified)
      };
      totalToFetch--;
      if (totalToFetch <= 0) {
        return;
      }
    }
    const linkHeader = res.headers.get("Link");
    url = linkHeader ? parseLinkHeader(linkHeader).next : undefined;
  }
}
var DIFFUSERS_SAFETENSORS_FILE = "diffusion_pytorch_model.safetensors";
var DIFFUSERS_SAFETENSORS_INDEX_FILE = "diffusion_pytorch_model.safetensors.index.json";
var DIFFUSERS_WEIGHTS_SUBFOLDERS = ["transformer", "unet"];
var LIBRARY_WEIGHT_CANDIDATES = {
  diffusers: [
    ...DIFFUSERS_WEIGHTS_SUBFOLDERS.map((folder) => ({
      single: `${folder}/${DIFFUSERS_SAFETENSORS_FILE}`,
      index: `${folder}/${DIFFUSERS_SAFETENSORS_INDEX_FILE}`
    })),
    { single: DIFFUSERS_SAFETENSORS_FILE, index: DIFFUSERS_SAFETENSORS_INDEX_FILE }
  ]
};

// node_modules/@huggingface/hub/dist/index.mjs
init_chunk_FFYIGW52();

// src/hf.ts
var HF_HUB = "https://huggingface.co/api/models";
var HF_INFERENCE = "https://router.huggingface.co/hf-inference";
var USER_AGENT2 = "pattern-forge/hf-1.0";
var TASK_ALIASES = {
  "zero-shot": ["zero-shot-classification"],
  zsc: ["zero-shot-classification"],
  class: ["zero-shot-classification", "text-classification", "token-classification"],
  embed: ["feature-extraction", "sentence-similarity"],
  retriever: ["feature-extraction", "sentence-similarity"],
  nli: ["zero-shot-classification", "text-classification"],
  search: ["feature-extraction"],
  rerank: ["text-classification"],
  quant: ["generation", "text-generation"],
  gen: ["generation", "text-generation"]
};
function resolveTask(term) {
  if (!term)
    return [];
  const t = term.toLowerCase();
  if (TASK_ALIASES[t])
    return TASK_ALIASES[t];
  return [t];
}
async function hfSearch(query, opts = {}) {
  const sort = opts.sort ?? "downloads";
  const limit = opts.limit ?? 12;
  const rows = [];
  const tasks = resolveTask(opts.task);
  const gen = listModels({
    search: { query: query || undefined, task: tasks[0] || undefined },
    sort,
    limit,
    hubUrl: "https://huggingface.co",
    credentials: {
      accessToken: HF_TOKEN || undefined,
      provider: "hf",
      type: "header"
    },
    additionalFields: opts.includeParams ? ["safetensors"] : undefined
  });
  try {
    for await (const m of gen) {
      rows.push(mapRow(m));
      if (rows.length >= limit)
        break;
    }
  } catch (e) {
    if (e?.message?.includes("401") || e?.status && e.status !== 200) {
      const gen2 = listModels({ search: { query: query || undefined, task: tasks[0] || undefined }, sort, limit, additionalFields: opts.includeParams ? ["safetensors"] : undefined });
      try {
        for await (const m of gen2) {
          rows.push(mapRow(m));
          if (rows.length >= limit)
            break;
        }
      } catch {}
    }
  }
  return rows;
}
function mapRow(r) {
  return {
    id: r.id ?? "",
    downloads: r.downloads ?? 0,
    likes: r.likes ?? 0,
    trending: r.trendingScore ?? 0,
    createdAt: r.createdAt,
    modifiedAt: r.lastModified,
    pipelineTag: r.pipeline_tag,
    libraryName: r.library_name,
    tags: r.tags ?? [],
    sha: r.sha,
    task: r.pipeline_tag
  };
}
function rankModel(m, now = Date.now()) {
  const downloads = Math.log1p(m.downloads ?? 0);
  const likes = Math.log1p(m.likes ?? 0);
  const trending = Math.log1p(m.trending ?? 0);
  let recency = 0;
  if (m.modifiedAt) {
    const ageDays = (now - Date.parse(m.modifiedAt)) / 86400000;
    recency = Math.max(0, 1 - ageDays / 365);
  }
  return downloads * 2 + likes * 3 + trending * 2 + recency * 4;
}
function sortByRank(models) {
  return [...models].sort((a, b) => rankModel(b) - rankModel(a));
}
async function classifyOne(modelId, input, timeoutMs = 15000) {
  const started = Date.now();
  const body = {
    inputs: input.text,
    parameters: { candidate_labels: input.labels, multi_label: (input.candidateThreshold ?? 0) > 0 }
  };
  try {
    const ac = new AbortController;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`${HF_INFERENCE}/models/${modelId}`, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT2, Authorization: `Bearer ${HF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    clearTimeout(timer);
    if (res.status === 503) {
      const wait = Number(res.headers.get("x-wait-to-load") ?? 8000);
      await new Promise((r) => setTimeout(r, Math.min(wait, 20000)));
      return classifyOne(modelId, input, timeoutMs);
    }
    if (!res.ok)
      return { candidate: modelId, label: "", score: 0, ok: false, ms: Date.now() - started, error: `HTTP ${res.status}` };
    const data = await res.json();
    const cand = Array.isArray(data.labels) ? data.labels : Array.isArray(data.scores) ? data.scores.map((_, i) => `label${i}`) : [];
    const scores = Array.isArray(data.scores) ? data.scores : [];
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0;i < cand.length; i++) {
      const s = Number(scores[i] ?? 0);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return { candidate: modelId, label: best >= 0 ? String(cand[best]) : "", score: bestScore, ok: best >= 0, ms: Date.now() - started };
  } catch (e) {
    return { candidate: modelId, label: "", score: 0, ok: false, ms: Date.now() - started, error: e?.message ?? "timeout/aborted" };
  }
}
async function classifyRace(input, models, concurrency = 3) {
  const results = [];
  for (let i = 0;i < models.length; i += concurrency) {
    const batch = models.slice(i, i + concurrency);
    const done = await Promise.all(batch.map((m) => classifyOne(m, input)));
    results.push(...done.map((v, j) => ({
      model: batch[j],
      rank: 0,
      downloads: 0,
      likes: 0,
      verdict: v
    })));
  }
  const ok = results.filter((r) => r.verdict?.ok);
  const byLabel = new Map;
  let winnerLabel = "";
  let agreed = 0;
  for (const r of ok) {
    byLabel.set(r.verdict.label, (byLabel.get(r.verdict.label) ?? 0) + 1);
  }
  for (const [label, count] of byLabel) {
    if (count > agreed) {
      agreed = count;
      winnerLabel = label;
    }
  }
  const winner = ok.find((r) => r.verdict.label === winnerLabel)?.model ?? "";
  return { winner, candidates: results, agreed };
}
async function completionsClassify(text, labels, opts = {}) {
  if (!FREEINF_KEY)
    return { ok: false, winner: "", score: 0, model: "", raw: "", error: "no FREEINFERENCE_API_KEY", ms: 0 };
  const model = opts.model ?? "glm-5.3-flash";
  const started = Date.now();
  const list = labels.join(`
`);
  const system = "You are a precise classifier. Read the user's input and answer with EXACTLY one of the allowed labels, verbatim, with no punctuation, quotes, markdown, or explanation.";
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Allowed labels:
${list}

Classify this:
${text}

Answer with exactly one label:` }
    ],
    max_tokens: 8
  };
  try {
    const ac = new AbortController;
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 25000);
    const res = await fetch(`${FREEINF_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FREEINF_KEY}` },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    clearTimeout(timer);
    if (!res.ok)
      return { ok: false, winner: "", score: 0, model, raw: "", error: `HTTP ${res.status}`, ms: Date.now() - started };
    const data = await res.json();
    const raw = (data?.choices?.[0]?.message?.content ?? "").toString();
    const winner = pickLabel(raw, labels);
    return { ok: !!winner, winner, score: winner ? 1 : 0, model, raw: raw.slice(0, 40), ms: Date.now() - started };
  } catch (e) {
    return { ok: false, winner: "", score: 0, model, raw: "", error: e?.message ?? "timeout", ms: Date.now() - started };
  }
}
function pickLabel(raw, labels) {
  const clean = raw.trim().replace(/^["'`\s]+|["'`\s.,;:!?]+$/g, "");
  const lower = clean.toLowerCase();
  for (const l of labels) {
    const ll = l.toLowerCase();
    if (lower.startsWith(ll))
      return l;
    if (ll.split(/\s+/).some((w) => w.length > 3 && lower.includes(w)))
      return l;
  }
  for (const l of labels) {
    if (l.split(/\s+/).some((w) => w.length >= 3 && lower.includes(w.toLowerCase())))
      return l;
  }
  return "";
}
async function freeinfModels() {
  if (!FREEINF_KEY)
    return [];
  try {
    const res = await fetch(`${FREEINF_BASE}/models`, { headers: { Authorization: `Bearer ${FREEINF_KEY}` } });
    if (!res.ok)
      return [];
    const d = await res.json();
    return (d.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}
function cosine(a, b) {
  let dot = 0, an = 0, bn = 0;
  for (let i = 0;i < a.length; i++) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  return dot / (Math.sqrt(an) * Math.sqrt(bn) || 1);
}
function classifyMember(id, author, parentAuthor, base, pipelineTag, library) {
  const lid = id.toLowerCase();
  const short = id.split("/").pop() ?? "";
  const isOfficial = author === parentAuthor;
  let format = library ?? "";
  if (lid.includes("-gguf"))
    format = "gguf";
  else if (lid.includes("-mlx"))
    format = "mlx";
  else if (lid.includes("-exl3") || lid.includes("-exl2"))
    format = "exl3";
  else if (lid.includes("nvfp4") || lid.includes("-fp8") || lid.includes("-ap-"))
    format = "gguf-quant";
  else if (library === "transformers")
    format = "transformers";
  let type;
  if (short.endsWith("-base") || short.endsWith("-base-256") || base === id)
    type = "base";
  else if (format === "gguf")
    type = "quantization";
  else if (format === "mlx")
    type = "conversion";
  else if (format === "exl3")
    type = "conversion";
  else if (String(base ?? "").startsWith(id) || String(base ?? "").includes(short.replace(/-gguf.*/i, "")) && !isOfficial)
    type = "quantization";
  else if (base && !isOfficial)
    type = "finetune";
  else
    type = "parent";
  const params = short.match(/(\d+(?:\.\d+)?[bBmM]|-\d+b-)/i)?.[1] ?? "";
  return { type, format, params, isOfficial };
}
async function modelTree(repo, opts = {}) {
  const short = repo.split("/").pop() ?? repo;
  const parentAuthor = repo.split("/")[0] ?? "";
  const limit = opts.limit ?? 40;
  try {
    const baseUrl = new URL(HF_HUB);
    baseUrl.searchParams.set("search", short);
    baseUrl.searchParams.set("sort", "downloads");
    baseUrl.searchParams.set("direction", "-1");
    baseUrl.searchParams.set("limit", String(limit * 3));
    const res = await fetch(baseUrl.toString(), { headers: { "User-Agent": USER_AGENT2, Authorization: `Bearer ${HF_TOKEN}` } });
    if (!res.ok)
      return { root: repo, parent: { repo, type: "parent", format: "", isOfficial: true }, finetunes: [], quantizations: [], conversions: [], total: 0, error: `HTTP ${res.status}` };
    const rows = await res.json();
    const parentRow = rows.find((r) => r.id === repo);
    const parentBase = parentRow?.cardData?.base_model;
    const members = rows.map((r) => {
      const author = r.author ?? "";
      const cl = classifyMember(r.id, author, parentAuthor, r.cardData?.base_model, r.pipeline_tag, r.library_name);
      return { repo: r.id, downloads: r.downloads ?? 0, likes: r.likes ?? 0, ...cl };
    });
    const isBase = parentRow?.cardData?.base_model?.toString().toLowerCase() !== repo.toLowerCase() && (parentRow?.cardData?.base_model || "");
    const base = String(parentBase ?? parentRow?.tags?.find((t) => t.startsWith("base_model:") && !t.includes("finetune"))?.split(":")[1] ?? "");
    const self2 = members.find((m) => m.repo === repo) ?? { repo, type: "parent", format: "", params: "", isOfficial: true, downloads: parentRow?.downloads ?? 0, likes: parentRow?.likes ?? 0 };
    const others = members.filter((m) => m.repo !== repo);
    return {
      root: repo,
      base: base || undefined,
      parent: self2,
      finetunes: others.filter((m) => m.type === "finetune").sort((a, b) => b.downloads - a.downloads),
      quantizations: others.filter((m) => m.type === "quantization").sort((a, b) => b.downloads - a.downloads),
      conversions: others.filter((m) => m.type === "conversion").sort((a, b) => b.downloads - a.downloads),
      total: members.length
    };
  } catch (e) {
    return { root: repo, parent: { repo, type: "parent", format: "", isOfficial: true }, finetunes: [], quantizations: [], conversions: [], total: 0, error: e?.message ?? "error" };
  }
}
async function embedClassify(text, labels, opts = {}) {
  if (!FREEINF_KEY)
    return { ok: false, winner: "", score: 0, margin: 0, ranked: [], model: opts.model ?? "bge-m3", dims: 0, error: "no FREEINFERENCE_API_KEY", ms: 0 };
  const model = opts.model ?? "bge-m3";
  const started = Date.now();
  const inputs = [text, ...labels.map((l) => opts.labelDesc ? `label: ${l}` : l)];
  try {
    const ac = new AbortController;
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30000);
    const res = await fetch(`${FREEINF_BASE}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FREEINF_KEY}` },
      body: JSON.stringify({ model, input: inputs }),
      signal: ac.signal
    });
    clearTimeout(timer);
    if (!res.ok)
      return { ok: false, winner: "", score: 0, margin: 0, ranked: [], model, dims: 0, error: `HTTP ${res.status}`, ms: Date.now() - started };
    const d = await res.json();
    const vecs = (d.data ?? []).map((x) => x.embedding);
    const dims = vecs[0]?.length ?? 0;
    const probe = vecs[0];
    if (dims === 0)
      return { ok: false, winner: "", score: 0, margin: 0, ranked: [], model, dims: 0, error: "empty embedding", ms: Date.now() - started };
    const ranked = labels.map((l, i) => ({
      label: l,
      score: vecs[i + 1] ? cosine(probe, vecs[i + 1]) : 0
    })).sort((a, b) => b.score - a.score);
    const top = ranked[0];
    const margin = (top?.score ?? 0) - (ranked[1]?.score ?? 0);
    const confident = (top?.score ?? 0) > 0.2 && margin > 0.02;
    return { ok: confident, winner: confident ? top.label : "", score: top?.score ?? 0, margin, ranked, model, dims, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, winner: "", score: 0, margin: 0, ranked: [], model, dims: 0, error: e?.message ?? "timeout", ms: Date.now() - started };
  }
}
async function embedMany(texts, opts = {}) {
  if (!FREEINF_KEY)
    return { ok: false, vectors: [], model: opts.model ?? "bge-m3", dims: 0, error: "no FREEINFERENCE_API_KEY" };
  const model = opts.model ?? "bge-m3";
  try {
    const ac = new AbortController;
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 60000);
    const res = await fetch(`${FREEINF_BASE}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FREEINF_KEY}` },
      body: JSON.stringify({ model, input: texts }),
      signal: ac.signal
    });
    clearTimeout(timer);
    if (!res.ok)
      return { ok: false, vectors: [], model, dims: 0, error: `HTTP ${res.status}` };
    const d = await res.json();
    const vectors = (d.data ?? []).map((x) => x.embedding);
    return { ok: true, vectors, model, dims: vectors[0]?.length ?? 0 };
  } catch (e) {
    return { ok: false, vectors: [], model, dims: 0, error: e?.message ?? "timeout" };
  }
}
async function categorizeRepos(signatures, labels, opts = {}) {
  const labelTexts = opts.labelDesc && opts.labelDesc.length === labels.length ? opts.labelDesc : labels;
  const all = [...signatures.map((s) => s.text), ...labelTexts];
  const emb = await embedMany(all, { model: opts.model ?? "bge-m3" });
  const ms = opts.minScore ?? 0.2;
  const mm = opts.margin ?? 0.02;
  if (!emb.ok)
    return { ok: false, model: { id: emb.model, dims: 0, engine: "freeinference", servedAt: new Date().toISOString() }, labels: labels.map((id, i) => ({ id, desc: labelTexts[i] })), thresholds: { minScore: ms, minMargin: mm }, scope: { sourceRepo: opts.sourceRepo ?? "", repoCount: signatures.length, signatureBytes: signatures.reduce((a, s) => a + s.text.length, 0) }, generatedAt: new Date().toISOString(), assignments: [], error: emb.error };
  const nRepos = signatures.length;
  const labelVectors = emb.vectors.slice(nRepos);
  const assignments = signatures.map((s, i) => {
    const probe = emb.vectors[i];
    const rank = labels.map((l, j) => ({ label: l, score: labelVectors[j] ? cosine(probe, labelVectors[j]) : 0 })).sort((a, b) => b.score - a.score);
    const top = rank[0];
    const runnerUp = rank[1];
    const m = (top?.score ?? 0) - (runnerUp?.score ?? 0);
    const confident = (top?.score ?? 0) >= ms && m >= mm;
    return { repo: s.repo, label: confident ? top.label : "", confident, score: top?.score ?? 0, margin: m, runnerUp: runnerUp?.label ?? "", signature: { file: "README.md|SKILL.md|package.json", bytes: s.text.length }, rank };
  });
  return { ok: true, model: { id: emb.model, dims: emb.dims, engine: "freeinference", servedAt: new Date().toISOString() }, labels: labels.map((id, i) => ({ id, desc: labelTexts[i] })), thresholds: { minScore: ms, minMargin: mm }, scope: { sourceRepo: opts.sourceRepo ?? "", repoCount: signatures.length, signatureBytes: signatures.reduce((a, s) => a + s.text.length, 0) }, generatedAt: new Date().toISOString(), assignments };
}
async function bestClassifyModels(explicit, labels) {
  if (explicit.length)
    return explicit;
  const curated = [
    "facebook/bart-large-mnli",
    "MoritzLaurer/deberta-v3-base-zeroshot-v2.0",
    "cross-encoder/nli-deberta-v3-xlarge",
    "sentence-transformers/all-MiniLM-L6-v2"
  ];
  return curated;
}
var MIN_SCORE = 0.05;
var MIN_MARGIN = 0.08;
function localZeroShot(text, labels, opts = {}) {
  const minScore = opts.minScore ?? MIN_SCORE;
  const minMargin = opts.minMargin ?? MIN_MARGIN;
  const configs = labels.map((l) => typeof l === "string" ? { id: l, desc: l } : l);
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const t = norm(text);
  const textWords = t.split(/\s+/).filter(Boolean);
  const STOP = new Set(["a", "an", "the", "for", "of", "and", "or", "to", "in", "on", "with", "this", "that", "your", "our", "from", "as", "is", "are", "be", "by", "it", "at", "its"]);
  const df = new Map;
  for (const w of textWords)
    if (!STOP.has(w))
      df.set(w, (df.get(w) ?? 0) + 1);
  const charGrams = (s, n) => {
    const out = new Set;
    const normed = norm(s);
    for (let i = 0;i + n <= normed.length; i++)
      out.add(normed.slice(i, i + n));
    return out;
  };
  const tBigrams = charGrams(t, 2);
  const tTrigrams = charGrams(t, 3);
  const scored = configs.map((c) => {
    const idTokens = norm(c.id).split(/\s+/).filter(Boolean);
    const lSet = new Set(idTokens);
    for (const w of norm(c.desc).split(/\s+/))
      if (!STOP.has(w))
        lSet.add(w);
    let idfOverlap = 0;
    let idfUnion = 0;
    for (const w of lSet) {
      const wIdf = STOP.has(w) ? 0 : Math.log2(1 + (textWords.length + 1) / ((df.get(w) ?? 0) + 1));
      idfUnion += wIdf || (STOP.has(w) ? 0.15 : 1);
      if (textWords.includes(w))
        idfOverlap += wIdf || (STOP.has(w) ? 0.15 : 1);
    }
    const jaccard = idfUnion === 0 ? 0 : idfOverlap / idfUnion;
    const lb = charGrams(c.desc, 2);
    const lt = charGrams(c.desc, 3);
    let bCommon = 0;
    for (const g of lb)
      if (tBigrams.has(g))
        bCommon++;
    let tCommon = 0;
    for (const g of lt)
      if (tTrigrams.has(g))
        tCommon++;
    const bigramSim = lb.size ? bCommon / lb.size : 0;
    const trigramSim = lt.size ? tCommon / lt.size : 0;
    const score = jaccard * 0.7 + bigramSim * 0.25 + trigramSim * 0.05;
    return { label: c.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  const margin = (top?.score ?? 0) - (second?.score ?? 0);
  const confident = (top?.score ?? 0) >= minScore && margin >= minMargin;
  return { winner: confident ? top.label : "", score: top?.score ?? 0, margin, ranked: scored, confident };
}
async function findClassifierCandidates(text, labels, task, limit = 8) {
  const tasks = resolveTask(task);
  const searchTerms = tasks.length ? ["zeroshot", "zero-shot", "nli", "deberta", "bge", "embedding"] : ["classifier", "text-classification"];
  const pool = [];
  for (const t of tasks.length ? tasks : ["zero-shot-classification", "text-classification"]) {
    for (const q of searchTerms) {
      try {
        const rows = await hfSearch(q, { sort: "downloads", limit: 4, task: t });
        pool.push(...rows);
      } catch {}
    }
  }
  const dedupe = new Map;
  for (const m of pool)
    if (m.id && !dedupe.has(m.id))
      dedupe.set(m.id, m);
  return sortByRank([...dedupe.values()]).slice(0, limit);
}

// src/cli.ts
function parseArgs(argv) {
  const _ = [];
  const flags = new Map;
  for (let i = 0;i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      _.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      i++;
    }
  }
  return { _, flags };
}
var num = (flags, key, fallback) => {
  const raw = flags.get(key);
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};
var str2 = (flags, key, fallback) => {
  const raw = flags.get(key);
  return typeof raw === "string" ? raw : fallback;
};
var list = (flags, key) => {
  const raw = flags.get(key);
  return typeof raw === "string" && raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
};
function writeOut(flags, payload, rendered) {
  const out = flags.get("out");
  if (typeof out === "string" && out) {
    mkdirSync6(dirname4(resolve4(out)), { recursive: true });
    writeFileSync3(out, `${JSON.stringify(payload, null, 2)}
`, "utf8");
    process.stderr.write(`wrote ${out}
`);
  }
  if (flags.get("quiet") === true)
    return;
  process.stdout.write(`${rendered}
`);
}
async function cmdRetrieve(args) {
  const root = resolve4(str2(args.flags, "root", args._[0] ?? RANCH));
  const query = str2(args.flags, "query", args._[1] ?? "");
  if (!query) {
    process.stderr.write(`retrieve needs a query: forge retrieve --root <dir> --query 'symbols or words'
`);
    return 2;
  }
  const topK = num(args.flags, "top", 10);
  const t0 = performance.now();
  const { index, stats } = await buildIndex(root, {
    maxFiles: num(args.flags, "max-files", 60000)
  });
  const buildMs = performance.now() - t0;
  const t1 = performance.now();
  const hits = index.hybrid(query, topK);
  const queryMs = performance.now() - t1;
  const width = Math.max(...hits.map((h) => h.path.length), 10);
  const lines = [
    `=== Retrieve: ${stats.files} files / ${(stats.bytes / 1e6).toFixed(1)} MB in ${buildMs.toFixed(0)}ms ` + `(walked ${stats.dirsWalked} dirs, pruned ${stats.dirsPruned}${stats.truncated ? ", TRUNCATED (raise --max-files)" : ""}) ===`,
    `=== query "${query}" in ${queryMs.toFixed(2)}ms ===`
  ];
  for (const [i, hit] of hits.entries()) {
    lines.push(`${String(i + 1).padStart(2)}. ${hit.path.padEnd(width)}  ${hit.hybrid.toFixed(2)}  bm25=${hit.bm25.toFixed(2)}`);
    if (hit.symbols.length)
      lines.push(`    ${hit.symbols.slice(0, 8).join(", ")}`);
  }
  if (!hits.length)
    lines.push("  (no matches)");
  writeOut(args.flags, { root, query, buildMs, queryMs, stats, hits }, lines.join(`
`));
  return 0;
}
async function cmdRace(args) {
  const specPath = str2(args.flags, "strategies", args._[0] ?? "");
  if (!specPath || !existsSync8(specPath)) {
    process.stderr.write(`race needs a strategies file: forge race --strategies r.json --tag mytag
  e.g. {"strategies":[{"name":"a","cmd":["bun","run","a.ts"],"match":"OK"}]}
`);
    return 2;
  }
  const strategies = loadStrategies(specPath);
  const tag = str2(args.flags, "tag", "default");
  const timeoutS = num(args.flags, "timeout", 60);
  const raceTimeoutS = num(args.flags, "race-timeout", timeoutS + 5);
  const hedgeMs = num(args.flags, "hedge-ms", 0);
  if (args.flags.get("lead") === true) {
    const ranked = leadWithWinner(tag, strategies);
    process.stdout.write(`=== lead-with-winner: ${tag} ===
`);
    for (const [i, row] of ranked.ranked.entries()) {
      process.stdout.write(`${String(i + 1).padStart(2)}. ${row.name}  wins=${row.wins}  median=${row.medianLatencyS.toFixed(3)}s
`);
    }
    return 0;
  }
  const raceId = `${tag}-${Date.now().toString(36)}`;
  const outcome = await runRace(strategies, {
    raceId,
    tag,
    timeoutS,
    raceTimeoutS,
    hedgeMs
  });
  const latency = {};
  for (const [name, r] of Object.entries(outcome.results))
    latency[name] = { latency_s: r.latencyS };
  if (outcome.winner)
    logWinners(tag, outcome.winner, latency);
  const lines = [`=== Race ${raceId} (tag=${tag}, hedge=${hedgeMs}ms) ===`];
  for (const [name, r] of Object.entries(outcome.results)) {
    lines.push(`  ${name.padEnd(16)} ${r.valid ? "VALID  " : "invalid"} ${r.latencyS.toFixed(3)}s${r.error ? `  ${r.error}` : ""}`);
  }
  for (const name of strategies.map((s) => s.name)) {
    if (!outcome.results[name])
      lines.push(`  ${name.padEnd(16)} cancelled (lost the race)`);
  }
  lines.push(outcome.winner ? `winner: ${outcome.winner}` : "winner: none \u2014 every contestant failed or timed out");
  if (outcome.winner && args.flags.get("stdout") === true)
    lines.push("", outcome.winnerOutput);
  writeOut(args.flags, { raceId, tag, hedgeMs, winner: outcome.winner, results: outcome.results }, lines.join(`
`));
  return outcome.winner ? 0 : 1;
}
async function cmdBench(args) {
  const warmup = num(args.flags, "warmup", 5);
  const runs = num(args.flags, "runs", 50);
  const racer = new CodeRacer(warmup, runs);
  let candidates;
  const candFile = args.flags.get("candidates");
  if (typeof candFile === "string" && candFile) {
    let parsed;
    try {
      parsed = await Bun.file(candFile).json();
    } catch (e) {
      process.stderr.write(`bench: cannot read --candidates file '${candFile}': ${e.message}
`);
      return 2;
    }
    const rows = parsed?.candidates;
    if (!Array.isArray(rows) || rows.length === 0) {
      process.stderr.write(`bench: --candidates file must be {"candidates":[{"name","code"},...]}
`);
      return 2;
    }
    candidates = [];
    for (const row of rows) {
      if (typeof row.name !== "string" || typeof row.code !== "string" || !row.name || !row.code) {
        process.stderr.write(`bench: skipping malformed candidate ${JSON.stringify(row).slice(0, 80)}
`);
        continue;
      }
      let impl;
      try {
        impl = new Function(`"use strict"; return (${row.code});`);
      } catch (e) {
        process.stderr.write(`bench: skipping candidate '${row.name}': code does not compile: ${e.message}
`);
        continue;
      }
      candidates.push({ name: row.name, impl });
    }
    if (!candidates.length) {
      process.stderr.write(`bench: no usable candidates after validation
`);
      return 2;
    }
  } else {
    candidates = [
      {
        name: "array-index-of",
        impl: () => [1, 2, 3, 4, 5].indexOf(4)
      },
      { name: "includes", impl: () => [1, 2, 3, 4, 5].includes(4) },
      {
        name: "find",
        impl: () => [1, 2, 3, 4, 5].find((n) => n === 4)
      },
      {
        name: "sort",
        impl: () => [5, 4, 3, 2, 1].sort((a, b) => a - b)
      },
      {
        name: "tokenize-100",
        impl: () => "aBcDeFgHiJ".toLowerCase().split(/[_]|(?<=[a-z0-9])(?=[A-Z])/).length
      }
    ];
  }
  const result = racer.race(candidates);
  const rendered = racer.printLeaderboard(result);
  writeOut(args.flags, result, rendered);
  return 0;
}
async function cmdBorrow(args) {
  const query = str2(args.flags, "query", args._[0] ?? "");
  if (!query) {
    process.stderr.write(`borrow needs a query: forge borrow "agent memory eviction"
`);
    return 2;
  }
  const skip = new Set(list(args.flags, "skip"));
  const result = await borrow(query, {
    perSource: num(args.flags, "per-source", 5),
    skip,
    exaApiKey: str2(args.flags, "exa-key", "")
  });
  const rendered = renderBorrow(result, num(args.flags, "top", 10));
  writeOut(args.flags, result, rendered);
  return 0;
}
async function cmdPatternBorrow(args) {
  const weights = { ...DEFAULT_PATTERN_WEIGHTS };
  const rawW = str2(args.flags, "weights", "");
  if (rawW) {
    for (const kv of rawW.split(",")) {
      const [k, v] = kv.split("=");
      if (k && v && k in DEFAULT_PATTERN_WEIGHTS) {
        weights[k] = Number(v);
      }
    }
  }
  const result = await patternBorrow({
    patterns: args._.length ? args._ : undefined,
    top: num(args.flags, "top", args._.length ? args._.length : 5),
    perPage: num(args.flags, "per-page", num(args.flags, "perPage", 5)),
    weights,
    localOnly: args.flags.get("local-only") === true
  });
  const asText = args.flags.get("text") === true;
  const rendered = renderPatternBorrow(result, asText);
  writeOut(args.flags, {
    terms: result.terms,
    topRepos: result.topRepos,
    timingMs: result.timingMs
  }, rendered);
  return 0;
}
async function cmdSubgraph(args) {
  const root = str2(args.flags, "root", process.cwd());
  const trace = str2(args.flags, "trace", "");
  if (!trace) {
    process.stderr.write(`subgraph needs --trace <file> holding a python traceback
`);
    return 2;
  }
  const frames = extractTracebackFrames(readFileSync8(trace, "utf8"));
  const inducer = new DynamicSubgraphInducer(root);
  const graph = inducer.induce(frames, {
    maxDepth: num(args.flags, "depth", 3)
  });
  const width = Math.max(...graph.nodes.map((n) => n.path.length), 10);
  const lines = [
    `=== Subgraph: ${frames.length} frames -> ${graph.nodes.length} files, ${graph.edges.length} edges (root ${root}) ===`
  ];
  for (const node of graph.nodes) {
    const inFan = graph.fanIn.get(node.path) ?? 0;
    lines.push(`${node.inTraceback ? "*" : " "} d${node.depth} ${node.path.padEnd(width)} fanIn=${inFan}${node.symbols.length ? `  ${node.symbols.slice(0, 5).join(", ")}` : ""}`);
  }
  writeOut(args.flags, graph, lines.join(`
`));
  return 0;
}
async function cmdMcts(args) {
  let cands = [];
  const candFile = args.flags.get("candidates-file");
  if (typeof candFile === "string" && candFile) {
    let parsed;
    try {
      parsed = await Bun.file(candFile).json();
    } catch (e) {
      process.stderr.write(`mcts: cannot read --candidates-file '${candFile}': ${e.message}
`);
      return 2;
    }
    const rows = parsed?.candidates;
    if (!Array.isArray(rows)) {
      process.stderr.write(`mcts: --candidates-file must be {"candidates":[{"name","cmd":[...]},...]}
`);
      return 2;
    }
    for (const row of rows) {
      if (typeof row.name === "string" && Array.isArray(row.cmd) && row.cmd.every((c) => typeof c === "string")) {
        cands.push({ name: row.name, cmd: row.cmd });
      } else {
        process.stderr.write(`mcts: skipping malformed candidate ${JSON.stringify(row).slice(0, 80)}
`);
      }
    }
  } else {
    const names = list(args.flags, "candidates");
    cands = names.map((n) => ({
      name: n,
      cmd: n.split(/\s+/).filter(Boolean)
    }));
  }
  cands = cands.filter((c) => c.cmd.length > 0);
  if (!cands.length) {
    process.stderr.write(`mcts needs --candidates a,b,c or --candidates-file c.json
`);
    return 2;
  }
  const actions = cands.map((c) => ({
    actionId: c.name,
    patch: JSON.stringify(c.cmd)
  }));
  const real = args.flags.get("real") === true;
  const timeoutS = num(args.flags, "timeout", 60);
  const engine = new SWEMcts(num(args.flags, "depth", 4), num(args.flags, "timeout", 60));
  const result = await engine.search(async () => actions, async (node) => {
    if (!real)
      return node.stateId === "root" ? 0 : 1;
    if (!node.action)
      return 0;
    let cmd;
    try {
      cmd = JSON.parse(node.action.patch);
    } catch {
      cmd = node.action.actionId.split(/\s+/).filter(Boolean);
    }
    return await runRealTest(cmd, timeoutS);
  });
  const lines = [
    `=== MCTS: ${result.iterations} iterations, ${result.nodesExplored} nodes, ${result.elapsedS.toFixed(3)}s${result.timedOut ? " (timed out)" : ""} ===`,
    `best: ${result.bestPatch ?? "(none)"} via ${result.bestStateId ?? "-"}`
  ];
  writeOut(args.flags, result, lines.join(`
`));
  return 0;
}
async function cmdAudit(args) {
  const opts = {
    root: args.flags.get("root") || process.cwd(),
    globs: list(args.flags, "globs"),
    top: num(args.flags, "top", 10),
    claim: args.flags.get("claim"),
    pattern: args.flags.get("pattern"),
    lang: args.flags.get("lang"),
    rule: args.flags.get("rule")
  };
  const result = audit(opts);
  const rendered = renderAudit(result);
  writeOut(args.flags, result, rendered);
  return result.verdict === "VERIFIED" ? 0 : result.verdict === "NOT-FOUND" ? 1 : 2;
}
async function runRealTest(cmd, timeoutS) {
  const [bin, ...argv] = cmd;
  if (!bin)
    return -1;
  try {
    const proc = Bun.spawn([bin, ...argv], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      timeout: timeoutS * 1000,
      killSignal: "SIGKILL"
    });
    return await proc.exited === 0 ? 1 : -1;
  } catch {
    return -1;
  }
}
function cmdPaths(_args) {
  const rows = [
    ["ESTATE", ESTATE],
    ["RANCH", RANCH],
    ["VENDORED", VENDORED],
    ["VAR", VAR],
    ["MANOR", MANOR],
    ["SKILLS_HOME", SKILLS_HOME],
    ["TAU_DIR", TAU_DIR],
    ["PORTS_ENV", PORTS_ENV],
    ["KNOWLEDGEBASE", KNOWLEDGEBASE]
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  const lines = [
    "=== resolved paths (env override -> skill-marker discovery -> candidate probe -> honest miss) ==="
  ];
  for (const [key, value] of rows) {
    const rendered = value === "" ? "(unset \u2014 no estate checkout on this host)" : `${value}  ${existsSync8(value) ? "" : "(MISSING)"}`;
    lines.push(`${key.padEnd(width)}  ${rendered}`);
  }
  lines.push("--- estate candidate probe ---");
  for (const r of probeEstate()) {
    lines.push(`  ${r.candidate}  ${r.exists ? "exists" : "missing"}${r.selected ? "  [selected]" : ""}`);
  }
  process.stdout.write(`${lines.join(`
`)}
`);
  return rows.every(([, v]) => existsSync8(v)) ? 0 : 1;
}
async function cmdDoctor(args) {
  const checks = [];
  setEmitter(() => {});
  try {
    const files = collectFiles(SKILL_DIR, {
      extensions: [...CODE_EXTS]
    }).files;
    checks.push({
      name: "scan skill dir",
      ok: files.length > 0,
      detail: `${files.length} code files under ${SKILL_DIR}`
    });
    const { index, stats } = await buildIndex(SKILL_DIR);
    const hits = index.hybrid("race first valid winner hedge", 3);
    checks.push({
      name: "retrieve",
      ok: hits.length > 0,
      detail: `${stats.files} indexed, top=${hits[0]?.path ?? "none"}`
    });
    const racer = new CodeRacer(2, 5);
    const raced = racer.race([
      { name: "noop", impl: () => 1 },
      {
        name: "boom",
        impl: () => {
          throw new Error("expected");
        }
      }
    ]);
    checks.push({
      name: "bench",
      ok: raced.winner === "noop",
      detail: `winner=${raced.winner} rows=${raced.rows.length}`
    });
    const py = collectFiles(SKILL_DIR, { extensions: [...PY_EXTS] }).files;
    const frames = extractTracebackFrames(`  File "/x/y.py", line 3, in boom
Traceback (most recent call last):`);
    checks.push({
      name: "subgraph parse",
      ok: frames.length === 1,
      detail: `frames=${frames.length} pyFiles=${py.length}`
    });
    const mcts = new SWEMcts(2, 5);
    const searched = await mcts.search(async () => [{ actionId: "a", patch: "p" }], async () => 1);
    checks.push({
      name: "mcts",
      ok: searched.bestPatch === "p",
      detail: `${searched.iterations} iters best=${searched.bestStateId}`
    });
    const estateOk = ESTATE === "" || existsSync8(ESTATE);
    checks.push({
      name: "paths",
      ok: estateOk,
      detail: ESTATE === "" ? "no estate checkout on this host \u2014 resolver reported the miss honestly (no blessed stale dir)" : `ESTATE=${ESTATE} (probed: ${probeEstate().map((r) => `${r.candidate}=${r.exists ? "exists" : "missing"}${r.selected ? " [selected]" : ""}`).join(", ")})`
    });
    const sgBin = resolveAstGrep();
    checks.push({
      name: "audit (ast-grep)",
      ok: sgBin !== null,
      detail: sgBin ?? "ast-grep missing from PATH (set AST_GREP_BIN)"
    });
    if (args.flags.get("borrow") === true) {
      const borrowed = await borrow("mcts planning", {
        perSource: 1,
        skip: new Set(["exa"])
      });
      const allSources = Object.values(borrowed.sources);
      const okSources = allSources.filter((s) => s?.ok);
      const okWithItems = allSources.filter((s) => s?.ok && Array.isArray(s.items) && s.items.length > 0);
      checks.push({
        name: "borrow (network)",
        ok: okWithItems.length > 0,
        detail: `${okWithItems.length} sources with items / ${okSources.length} ok / ${allSources.length} total in ${borrowed.timingMs.toFixed(0)}ms`
      });
      const gh = borrowed.sources["github"];
      checks.push({
        name: "borrow github leg",
        ok: gh?.ok === true && (Array.isArray(gh.items) ? gh.items.length > 0 : false),
        detail: gh?.ok === true ? `${Array.isArray(gh.items) ? gh.items.length : 0} github item(s)` : `github degraded: ${gh?.error ?? "leg disabled"}`
      });
    }
  } finally {
    setEmitter((line) => process.stderr.write(`${line}
`));
  }
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = ["=== doctor ==="];
  for (const check of checks) {
    lines.push(`${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  process.stdout.write(`${lines.join(`
`)}
`);
  return checks.every((c) => c.ok) ? 0 : 1;
}
function formatTag(m) {
  return [m.format, m.params].filter(Boolean).join(" ").toUpperCase() || m.type;
}
function repoSignature(dir, name) {
  const candidateFiles = ["README.md", "SKILL.md", "AGENTS.md", "readme.md"];
  for (const f of candidateFiles) {
    const p = join14(dir, f);
    if (existsSync8(p) && statSync5(p).size > 0 && statSync5(p).size < 120000) {
      try {
        return readFileSync8(p, "utf8").slice(0, 2000);
      } catch {
        continue;
      }
    }
  }
  const pkg = join14(dir, "package.json");
  if (existsSync8(pkg)) {
    try {
      const pj = JSON.parse(readFileSync8(pkg, "utf8"));
      const desc = pj?.description || "";
      if (desc)
        return desc.slice(0, 1200);
    } catch {}
  }
  return null;
}
async function cmdHf(args) {
  const sub = args._[0] ?? "search";
  const REST = args._.slice(1);
  if (sub === "search" || sub === "models") {
    const provider = String(args.flags.get("provider") ?? "hub");
    if (sub === "models" && provider === "freeinference") {
      const models = await freeinfModels();
      if (args.flags.get("json") === true) {
        process.stdout.write(JSON.stringify({ provider: "freeinference", models }) + `
`);
        return models.length ? 0 : 1;
      }
      process.stdout.write(`FreeInference models:
`);
      for (const m of models)
        process.stdout.write(`  ${m}
`);
      return models.length ? 0 : 1;
    }
    const query = REST.join(" ");
    const sort = String(args.flags.get("sort") ?? "downloads");
    const dir = String(args.flags.get("direction") ?? "-1");
    const limit = Number(args.flags.get("limit") ?? 12);
    const task = String(args.flags.get("task") ?? "");
    const lib = String(args.flags.get("library") ?? "");
    try {
      const rows = await hfSearch(query, {
        sort,
        direction: dir,
        limit,
        task,
        library: lib
      });
      if (args.flags.get("json") === true) {
        const ranked = sortByRank(rows).map((m) => ({
          id: m.id,
          task: m.task,
          downloads: m.downloads,
          likes: m.likes,
          trending: m.trending,
          modifiedAt: m.modifiedAt,
          rank: Number(rankModel(m).toFixed(1))
        }));
        process.stdout.write(JSON.stringify({ query, sort, results: ranked }) + `
`);
        return 0;
      }
      if (!rows.length) {
        process.stdout.write(`HF: no models for '${query}'
`);
        return 1;
      }
      const ranked = sortByRank(rows);
      process.stdout.write(`HF search '${query}' (sort=${sort}) -> top ${rows.length} by rank:
`);
      for (const m of ranked) {
        const score = rankModel(m).toFixed(1);
        process.stdout.write(`  ${score.padStart(5)}  ${String(m.downloads ?? 0).padStart(10)}dl ${String(m.likes ?? 0).padStart(4)}\u2661 ${(m.task ?? "?").padEnd(20)} ${m.id}
`);
      }
      return 0;
    } catch (e) {
      process.stdout.write(`HF search failed: ${e?.message ?? e}
`);
      return 1;
    }
  }
  if (sub === "classify" || sub === "completions" || sub === "embed" || sub === "bge") {
    const text = REST.join(" ");
    const labels = String(args.flags.get("labels") ?? "").split(",").filter(Boolean);
    const explicit = String(args.flags.get("models") ?? "").split(",").filter(Boolean);
    if (!text || !labels.length) {
      process.stdout.write(`usage: forge hf classify "<text>" --labels repo,tool,mcp,vendor [--engine local|freeinference|hf] [--model glm-5.3-flash]
`);
      return 2;
    }
    const engine = String(args.flags.get("engine") ?? (sub === "completions" ? "freeinference" : "local"));
    if (engine === "embed" || engine === "bge" || sub === "embed" || sub === "bge") {
      const r = await embedClassify(text, labels, {
        model: String(args.flags.get("model") ?? "bge-m3")
      });
      if (args.flags.get("json") === true) {
        process.stdout.write(JSON.stringify({
          text,
          engine: "embed",
          model: r.model,
          ok: r.ok,
          winner: r.winner,
          score: r.score,
          margin: r.margin,
          dims: r.dims,
          ranked: r.ranked,
          error: r.error,
          ms: r.ms
        }) + `
`);
        return r.ok ? 0 : 2;
      }
      process.stdout.write(`HF classify "${text.slice(0, 50)}" [embed/${r.model} dims=${r.dims}]
`);
      for (const l of r.ranked)
        process.stdout.write(`  ${l.label === r.winner ? "\u2192" : " "} ${l.label.padEnd(60)} ${l.score.toFixed(4)}
`);
      if (r.error)
        process.stdout.write(`  \u2717 ${r.error}
`);
      process.stdout.write(`
  ${r.ok ? `winner: ${r.winner} (cos ${r.score.toFixed(4)}, +${r.margin.toFixed(4)})` : `ABSTAIN: best ${r.winner || "none"} @ ${r.score.toFixed(4)}, margin ${r.margin.toFixed(4)} too thin`}
`);
      return r.ok ? 0 : 2;
    }
    if (engine === "freeinference" || sub === "completions") {
      const model = String(args.flags.get("model") ?? "glm-5.3-flash");
      const r = await completionsClassify(text, labels, { model });
      if (args.flags.get("json") === true) {
        process.stdout.write(JSON.stringify({
          text,
          engine: "freeinference",
          model: r.model,
          ok: r.ok,
          winner: r.winner,
          raw: r.raw,
          error: r.error,
          ms: r.ms
        }) + `
`);
        return r.ok ? 0 : 2;
      }
      process.stdout.write(`HF classify "${text.slice(0, 50)}" [freeinference/${r.model}]
`);
      if (r.ok)
        process.stdout.write(`  \u2713 ${r.winner}
`);
      else
        process.stdout.write(`  \u2717 ${r.error ?? "no label"}
`);
      return r.ok ? 0 : 2;
    }
    if (engine === "local") {
      const local = localZeroShot(text, labels);
      if (args.flags.get("json") === true) {
        process.stdout.write(JSON.stringify({
          text,
          engine: "local",
          confident: local.confident,
          winner: local.winner,
          score: local.score,
          margin: local.margin,
          ranked: local.ranked
        }) + `
`);
        return local.confident ? 0 : 2;
      }
      process.stdout.write(`HF classify "${text.slice(0, 60)}" [pure-Bun local]
`);
      for (const l of local.ranked)
        process.stdout.write(`  ${l.label === local.winner ? "\u2192" : " "} ${l.label.padEnd(60)} ${l.score.toFixed(3)}
`);
      process.stdout.write(`
  ${local.confident ? `winner: ${local.winner} (${local.score.toFixed(3)}, +${local.margin.toFixed(3)})` : `ABSTAIN: best ${local.winner || "none"} @ ${local.score.toFixed(3)}, margin ${local.margin.toFixed(3)} too thin`}
`);
      return local.confident ? 0 : 2;
    }
    const winners = await bestClassifyModels(explicit, labels);
    let { winner, candidates, agreed } = await classifyRace({ text, labels }, winners, 3);
    const okCount = candidates.filter((c) => c.verdict?.ok).length;
    if (!winner || okCount === 0) {
      const local = localZeroShot(text, labels);
      if (args.flags.get("json") === true) {
        process.stdout.write(JSON.stringify({
          text,
          engine: "local",
          confident: local.confident,
          winner: local.winner,
          score: Number(local.score.toFixed(4)),
          margin: Number(local.margin.toFixed(4)),
          ranked: local.ranked.map((r) => ({
            label: r.label,
            score: Number(r.score.toFixed(4))
          })),
          server: {
            ok: okCount,
            candidates: candidates.map((c) => ({
              model: c.model,
              ok: c.verdict?.ok ?? false,
              error: c.verdict?.error
            }))
          }
        }) + `
`);
        return local.confident ? 0 : 2;
      }
      process.stdout.write(`HF classify "${text.slice(0, 60)}"
`);
      process.stdout.write(`  (serverless zero-shot 402-gated/offline \u2014 using pure-Bun local fallback; set --models to a free-inference id)
`);
      for (const l of local.ranked) {
        process.stdout.write(`  ${l.label === local.winner ? "\u2192" : " "} ${l.label.padEnd(60)} ${l.score.toFixed(3)}
`);
      }
      process.stdout.write(`
  ${local.confident ? `winner: ${local.winner} (${local.score.toFixed(3)}, +${local.margin.toFixed(3)} vs runner-up)` : `ABSTAIN: best ${local.winner || "none"} @ ${local.score.toFixed(3)}, margin ${local.margin.toFixed(3)} too thin`}
`);
      return local.confident ? 0 : 2;
    }
    process.stdout.write(`HF classify "${text.slice(0, 60)}"
`);
    for (const c of candidates) {
      const short = c.model.slice(0, 60);
      process.stdout.write(`  ${c.verdict?.ok ? "\u2713" : "\u2717"} ${short.padEnd(62)} ${c.verdict?.label ?? "err"}=${c.verdict?.score?.toFixed(3) ?? "\u2015"} ${c.verdict?.ms ?? 0}ms${c.verdict?.error ? ` [${c.verdict.error}]` : ""}
`);
    }
    process.stdout.write(`
  consensus: ${winner || "none"} (${agreed}/${candidates.filter((c) => c.verdict?.ok).length} agree)
`);
    if (args.flags.get("json") === true) {
      process.stdout.write(JSON.stringify({
        text,
        engine: "server",
        winner,
        agreed,
        candidates: candidates.map((c) => ({
          model: c.model,
          label: c.verdict?.label,
          score: c.verdict?.score,
          ok: c.verdict?.ok,
          ms: c.verdict?.ms,
          error: c.verdict?.error
        }))
      }) + `
`);
    }
    return winner ? 0 : 1;
  }
  if (sub === "find-classifier" || sub === "find") {
    const text = REST.join(" ");
    const labels = String(args.flags.get("labels") ?? "").split(",").filter(Boolean);
    const probe = String(args.flags.get("probe") ?? text);
    const task = String(args.flags.get("task") ?? "zero-shot");
    const pool = await findClassifierCandidates(probe, labels, task, Number(args.flags.get("limit") ?? 8));
    if (!pool.length) {
      process.stdout.write(`find-classifier: no candidate classifiers from HF Hub
`);
      return 1;
    }
    const winners = pool.map((m) => m.model);
    const race = await classifyRace({ text: probe, labels }, winners, 3);
    let winner = race.winner;
    if (!winner) {
      const local = localZeroShot(probe, labels);
      winner = local.confident ? local.winner : "";
      if (args.flags.get("json") === true) {
        process.stdout.write(JSON.stringify({
          text: probe,
          engine: "local",
          confident: local.confident,
          winner: local.winner,
          score: Number(local.score.toFixed(4)),
          margin: Number(local.margin.toFixed(4)),
          ranked: local.ranked.map((r) => ({
            label: r.label,
            score: Number(r.score.toFixed(4))
          })),
          candidates: pool.map((m) => m.id)
        }) + `
`);
        return winner ? 0 : 2;
      }
      process.stdout.write(`find-classifier: ${pool.length} candidates all 402-gated; pure-Bun fallback ${local.confident ? `selects '${local.winner}' (${local.score.toFixed(3)}, +${local.margin.toFixed(3)})` : `ABSTAINS (best ${local.winner || "none"} @ ${local.score.toFixed(3)}, margin ${local.margin.toFixed(3)} too thin)`}
`);
      for (const l of local.ranked)
        process.stdout.write(`  ${l.label === local.winner ? "\u2192" : " "} ${l.label.padEnd(12)} ${l.score.toFixed(3)}
`);
      return winner ? 0 : 2;
    }
    process.stdout.write(`find-classifier: raced ${pool.length} candidate zero-shot models on '${probe.slice(0, 50)}'
`);
    for (const c of race.candidates.sort((a, b) => (b.verdict?.score ?? 0) - (a.verdict?.score ?? 0))) {
      const rank = pool.find((m) => m.model === c.model)?.rank ?? 0;
      process.stdout.write(`  ${c.verdict?.ok ? "\u2713" : "\u2717"} rank${rank.toFixed(0).padStart(2)} ${c.verdict?.label?.padEnd(12)} ${(c.verdict?.score ?? 0).toFixed(3)} ${c.model}${c.verdict?.error ? ` [${c.verdict.error}]` : ""}
`);
    }
    process.stdout.write(`
  recommended: ${winner}
`);
    return winner ? 0 : 1;
  }
  if (sub === "categorize" || sub === "categorize-repos") {
    const rootArg = String(args.flags.get("root") ?? "");
    const defaultLabels = [
      {
        id: "infra",
        desc: "infrastructure, deployment, and system daemon repository: services, ports, supervisors, docker, nginx, telemetry, CI/CD"
      },
      {
        id: "tool",
        desc: "command-line tool or utility program: a CLI, script, or developer-facing utility"
      },
      {
        id: "mcp",
        desc: "MCP server: exposes agent tools and resources over the Model Context Protocol for AI coding agents"
      },
      {
        id: "agent",
        desc: "autonomous agent or agent fleet runtime: orchestrates agents, tasks, fleets, swarms, or multi-agent workflows"
      },
      {
        id: "vendor",
        desc: "third-party upstream project: a fork, vendored copy, or reference clone of an external open-source codebase"
      },
      {
        id: "tau",
        desc: "tau ecosystem: part of the tau coding-agent engine, its extensions, or its plugin marketplace"
      },
      {
        id: "ml",
        desc: "machine learning and model tooling: model serving, embeddings, LLM orchestration, fine-tuning, or inference infrastructure"
      },
      {
        id: "research",
        desc: "research, analysis, experiment, or audit repository: benchmark, probe, recon, or investigation scripts"
      },
      {
        id: "runtime",
        desc: "long-running daemon or runtime service: a background process, broker, watchdog, or distributed service"
      },
      {
        id: "website",
        desc: "website source or content repository: a public site, static site, storefront, or web application frontend"
      }
    ];
    const labels = String(args.flags.get("labels") ?? "infra,tool,mcp,agent,vendor,tau,ml,research,runtime,website").split(",").filter(Boolean);
    const labelDescs = defaultLabels.filter((l) => labels.includes(l.id)).map((l) => l.desc);
    const writePath = String(args.flags.get("write") ?? "");
    if (!rootArg || !resolve4(rootArg).startsWith("/")) {
      process.stdout.write(`usage: forge hf categorize --root <dir> --labels a,b,c [--write out.json]
`);
      return 2;
    }
    const root = resolve4(rootArg);
    if (!existsSync8(root)) {
      process.stdout.write(`categorize: root not found: ${root}
`);
      return 1;
    }
    const entries = readdirSync3(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    const signatures = [];
    for (const e of entries) {
      const dir = join14(root, e.name);
      const sig = repoSignature(dir, e.name);
      if (sig)
        signatures.push({ repo: e.name, text: sig });
    }
    if (!signatures.length) {
      process.stdout.write(`categorize: no repos with a readable signature under ${root}
`);
      return 1;
    }
    process.stderr.write(`categorize: ${signatures.length} repos \xD7 ${labels.length} labels (bge-m3, batch embed)
`);
    const res = await categorizeRepos(signatures, labels, {
      labelDesc: labelDescs,
      sourceRepo: root
    });
    if (!res.ok) {
      process.stdout.write(`categorize: embed failed \u2014 ${res.error}
`);
      return 1;
    }
    if (args.flags.get("json") === true || writePath) {
      const payload = {
        schema: "estate.categorize@1",
        model: res.model,
        labels: res.labels,
        thresholds: res.thresholds,
        scope: res.scope,
        generatedAt: res.generatedAt,
        assignments: res.assignments.map((a) => ({
          repo: a.repo,
          label: a.label || null,
          confident: a.confident,
          score: Number(a.score.toFixed(4)),
          margin: Number(a.margin.toFixed(4)),
          runnerUp: a.runnerUp || null,
          signature: a.signature,
          top3: a.rank.slice(0, 3).map((r) => ({
            label: r.label,
            score: Number(r.score.toFixed(4))
          }))
        }))
      };
      if (writePath)
        writeFileSync3(resolve4(writePath), JSON.stringify(payload, null, 2) + `
`);
      if (args.flags.get("json") === true)
        process.stdout.write(JSON.stringify(payload) + `
`);
    } else {
      process.stdout.write(`model=${res.model.id} dims=${res.model.dims} repos=${res.scope.repoCount} labels=${res.labels.length}
`);
      for (const a of res.assignments) {
        process.stdout.write(`  ${a.confident ? "\u2713" : "?"} ${(a.label || "\u2014").padEnd(14)} ${a.repo.padEnd(40)} ${a.score.toFixed(3)} +${a.margin.toFixed(3)}${a.confident ? `  (vs ${a.runnerUp})` : ""}
`);
      }
      if (writePath)
        process.stdout.write(`
wrote ${resolve4(writePath)} (schema estate.categorize@1)
`);
    }
    return 0;
  }
  if (sub === "tree") {
    const repo = REST.join(" ").trim().replace(/\/$/, "");
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      process.stdout.write(`usage: forge hf tree <author/model> [--limit N]   e.g. forge hf tree LiquidAI/LFM2.5-24B-A2B
`);
      return 2;
    }
    const tree = await modelTree(repo, {
      limit: Number(args.flags.get("limit") ?? 40)
    });
    if (tree.error) {
      process.stdout.write(`tree: failed \u2014 ${tree.error}
`);
      return 1;
    }
    if (args.flags.get("json") === true) {
      process.stdout.write(JSON.stringify(tree) + `
`);
      return 0;
    }
    process.stdout.write(`Model tree for ${tree.root}
`);
    if (tree.base)
      process.stdout.write(`
Base model
  ${tree.base}
`);
    process.stdout.write(`
This model
  ${tree.parent.repo}  (${formatTag(tree.parent)}${tree.parent.downloads ? ` \xB7 ${tree.parent.downloads.toLocaleString()} dl \xB7 ${tree.parent.likes}\u2665` : ""})
`);
    if (tree.finetunes.length) {
      process.stdout.write(`
Finetunes (${tree.finetunes.length}):
`);
      for (const m of tree.finetunes.slice(0, 20))
        process.stdout.write(`  ${m.repo}  [${formatTag(m)}] \xB7 ${m.downloads.toLocaleString()} dl
`);
      if (tree.finetunes.length > 20)
        process.stdout.write(`  \u2026 and ${tree.finetunes.length - 20} more
`);
    }
    if (tree.quantizations.length) {
      process.stdout.write(`
Quantizations (${tree.quantizations.length}):
`);
      for (const m of tree.quantizations.slice(0, 25))
        process.stdout.write(`  ${m.repo}  [${formatTag(m)}] \xB7 ${m.downloads.toLocaleString()} dl${m.isOfficial ? " (official)" : ""}
`);
      if (tree.quantizations.length > 25)
        process.stdout.write(`  \u2026 and ${tree.quantizations.length - 25} more
`);
    }
    if (tree.conversions.length) {
      process.stdout.write(`
Conversions (${tree.conversions.length}):
`);
      for (const m of tree.conversions.slice(0, 15))
        process.stdout.write(`  ${m.repo}  [${formatTag(m)}] \xB7 ${m.downloads.toLocaleString()} dl
`);
    }
    if (tree.total === 0)
      process.stdout.write(`  (no family members found \u2014 check the author/model spelling)
`);
    return 0;
  }
  process.stdout.write(`forge hf subcommands: search | models | classify | embed | completions | find-classifier | categorize | tree
`);
  return 2;
}
var HELP = `forge \u2014 pattern-forge: retrieve, race, borrow, search. Pure Bun.

  forge retrieve --root <dir> --query <q> [--top N] [--max-files N]
  forge race --strategies <file.json> [--tag t] [--timeout S] [--race-timeout S]
              [--hedge-ms MS] [--lead] [--stdout]
  forge bench [--candidates <file.json>] [--warmup N] [--runs N]
  forge borrow <query> [--per-source N] [--skip a,b] [--top N] [--exa-key K]
  forge pattern-borrow [patterns...] [--top N] [--per-page N] [--weights k=v,...] [--text] [--local-only]
  forge mcts (--candidates a,b,c | --candidates-file <c.json>) [--depth N] [--timeout S] [--real]
  forge subgraph --root <dir> --trace <file> [--depth N]
  forge hf search <query> [--sort downloads|likes|trendingScore] [--task zero-shot|embed|gen] [--limit N]
  forge hf models --provider freeinference
  forge hf classify <text> --labels a,b,c [--engine local|freeinference|hf|embed] [--model glm-5.3-flash]
  forge hf embed <text> --labels a,b,c [--model bge-m3]  (bge-m3 cosine-nearest classifier)
  forge hf find-classifier <text> --labels a,b,c [--task zero-shot] [--limit N]
  forge audit --root <dir> --claim "<claim>" [--globs a,b] [--top N]
  forge audit --root <dir> --pattern '<ast-grep pattern>' [--lang ts] [--globs a,b]
  forge audit --root <dir> --rule <rule.yml>
  forge paths
  forge doctor [--borrow]
  forge stack <build|deploy|health|go|targets> --target <kappa|forge|all> [--deep] [--dry-run]

Strategies JSON:
  {"strategies":[{"name":"fast","cmd":["bun","run","fast.ts"],"match":"^OK"}]}

Global: --out <file> writes the JSON payload, --quiet suppresses stdout,
        --verbose restores JSONL telemetry on stderr (default: quiet).

Bench candidates JSON:
  {"candidates":[{"name":"includes","code":""abc".includes("b")"}]}
MCTS candidates JSON:
  {"candidates":[{"name":"t","cmd":["bun","test","t.ts"]}]}`;
async function main(argv) {
  const parsed = parseArgs(argv);
  const command = parsed._[0] ?? "help";
  const loud = parsed.flags.get("json") === true || parsed.flags.get("verbose") === true || process.env.FORGE_VERBOSE === "1";
  setEmitter(loud ? (line) => process.stderr.write(`${line}
`) : () => {});
  const args = { _: parsed._.slice(1), flags: parsed.flags };
  switch (command) {
    case "retrieve":
      return cmdRetrieve(args);
    case "race":
      return cmdRace(args);
    case "bench":
      return cmdBench(args);
    case "borrow":
      return cmdBorrow(args);
    case "pattern-borrow":
    case "pb":
      return cmdPatternBorrow(args);
    case "mcts":
      return cmdMcts(args);
    case "subgraph":
      return cmdSubgraph(args);
    case "audit":
      return cmdAudit(args);
    case "stack":
    case "st":
      return cmdStack(args);
    case "paths":
      return cmdPaths(args);
    case "doctor":
      return cmdDoctor(args);
    case "hf":
      return cmdHf(args);
    case "help":
    default:
      process.stdout.write(`${HELP}
`);
      return command === "help" ? 0 : 2;
  }
}
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
export {
  main
};
