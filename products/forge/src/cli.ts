/**
 * forge — one CLI over every leg. `forge help` is the whole surface.
 *
 * Subcommands map 1:1 onto the doctrine:
 *   retrieve  find the code you already own        (ast-bm25-racer + ast_indexer)
 *   race      run contenders, first valid wins     (hft-latency race.py)
 *   bench     nanosecond leaderboard               (code_racer.py)
 *   borrow    free-first literature + code search  (emergent-enrich route.py)
 *   mcts      search patch candidates              (mcts_engine.py)
 *   subgraph  traceback -> files that matter       (dynamic_subgraph_inducer.py)
 *   audit     verify claims against the AST          (ast-grep; merged 2026-10-02)
 *   paths     what this build resolves to          (non-hardcoded path proof)
 *   doctor    verify every leg still runs
 *   hf        HuggingFace model finder + zero-shot classifier
 *             (search/models | classify | find-classifier) — raw Bun, pure-Bun
 *             offline fallback when HF serverless is 402-gated; FreeInference
 *             completion-based classifier (--engine freeinference) is credit-free
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { Bm25Index } from "./bm25";
import { buildIndex, collectFiles } from "./repo-index";
import { CODE_EXTS, PY_EXTS, extract } from "./extract";
import { CodeRacer } from "./code-racer";
import { CircuitBreaker } from "./circuit-breaker";
import { SWEMcts, type PatchAction } from "./mcts";
import { DynamicSubgraphInducer, extractTracebackFrames } from "./subgraph";
import { cmdStack } from "./stack/cmdStack";
import { borrow, renderBorrow, type SourceName } from "./borrow";
import { audit, renderAudit, resolveAstGrep, type AuditOptions } from "./audit";
import {
  leadWithWinner,
  loadStrategies,
  logWinners,
  runRace,
  setEmitter,
  type Strategy,
} from "./concurrent";
import {
  CodeItem,
  PaperItem,
  DEFAULT_PATTERN_WEIGHTS,
  type PatternFactor,
  type PatternWeights,
  patternBorrow,
  renderPatternBorrow,
} from "./providers";
import * as P from "./paths";
import * as hf from "./hf";

type Args = { _: string[]; flags: Map<string, string | boolean> };

function parseArgs(argv: readonly string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
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

const num = (flags: Args["flags"], key: string, fallback: number): number => {
  const raw = flags.get(key);
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

const str = (flags: Args["flags"], key: string, fallback: string): string => {
  const raw = flags.get(key);
  return typeof raw === "string" ? raw : fallback;
};

const list = (flags: Args["flags"], key: string): string[] => {
  const raw = flags.get(key);
  return typeof raw === "string" && raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
};

function writeOut(
  flags: Args["flags"],
  payload: unknown,
  rendered: string,
): void {
  const out = flags.get("out");
  if (typeof out === "string" && out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    process.stderr.write(`wrote ${out}\n`);
  }
  if (flags.get("quiet") === true) return;
  process.stdout.write(`${rendered}\n`);
}

async function cmdRetrieve(args: Args): Promise<number> {
  const root = resolve(str(args.flags, "root", args._[0] ?? P.RANCH));
  const query = str(args.flags, "query", args._[1] ?? "");
  if (!query) {
    process.stderr.write(
      "retrieve needs a query: forge retrieve --root <dir> --query 'symbols or words'\n",
    );
    return 2;
  }
  const topK = num(args.flags, "top", 10);
  const t0 = performance.now();
  const { index, stats } = await buildIndex(root, {
    maxFiles: num(args.flags, "max-files", 60_000),
  });
  const buildMs = performance.now() - t0;

  const t1 = performance.now();
  const hits = index.hybrid(query, topK);
  const queryMs = performance.now() - t1;

  const width = Math.max(...hits.map((h) => h.path.length), 10);
  const lines = [
    `=== Retrieve: ${stats.files} files / ${(stats.bytes / 1e6).toFixed(1)} MB in ${buildMs.toFixed(0)}ms ` +
      `(walked ${stats.dirsWalked} dirs, pruned ${stats.dirsPruned}${stats.truncated ? ", TRUNCATED (raise --max-files)" : ""}) ===`,
    `=== query "${query}" in ${queryMs.toFixed(2)}ms ===`,
  ];
  for (const [i, hit] of hits.entries()) {
    lines.push(
      `${String(i + 1).padStart(2)}. ${hit.path.padEnd(width)}  ${hit.hybrid.toFixed(2)}  bm25=${hit.bm25.toFixed(2)}`,
    );
    if (hit.symbols.length)
      lines.push(`    ${hit.symbols.slice(0, 8).join(", ")}`);
  }
  if (!hits.length) lines.push("  (no matches)");
  writeOut(
    args.flags,
    { root, query, buildMs, queryMs, stats, hits },
    lines.join("\n"),
  );
  return 0;
}

async function cmdRace(args: Args): Promise<number> {
  const specPath = str(args.flags, "strategies", args._[0] ?? "");
  if (!specPath || !existsSync(specPath)) {
    process.stderr.write(
      'race needs a strategies file: forge race --strategies r.json --tag mytag\n  e.g. {"strategies":[{"name":"a","cmd":["bun","run","a.ts"],"match":"OK"}]}\n',
    );
    return 2;
  }
  const strategies = loadStrategies(specPath);
  const tag = str(args.flags, "tag", "default");
  const timeoutS = num(args.flags, "timeout", 60);
  const raceTimeoutS = num(args.flags, "race-timeout", timeoutS + 5);
  const hedgeMs = num(args.flags, "hedge-ms", 0);

  if (args.flags.get("lead") === true) {
    const ranked = leadWithWinner(tag, strategies);
    process.stdout.write(`=== lead-with-winner: ${tag} ===\n`);
    for (const [i, row] of ranked.ranked.entries()) {
      process.stdout.write(
        `${String(i + 1).padStart(2)}. ${row.name}  wins=${row.wins}  median=${row.medianLatencyS.toFixed(3)}s\n`,
      );
    }
    return 0;
  }

  const raceId = `${tag}-${Date.now().toString(36)}`;
  const outcome = await runRace(strategies, {
    raceId,
    tag,
    timeoutS,
    raceTimeoutS,
    hedgeMs,
  });
  const latency: Record<string, { latency_s: number }> = {};
  for (const [name, r] of Object.entries(outcome.results))
    latency[name] = { latency_s: r.latencyS };
  if (outcome.winner) logWinners(tag, outcome.winner, latency);

  const lines = [`=== Race ${raceId} (tag=${tag}, hedge=${hedgeMs}ms) ===`];
  for (const [name, r] of Object.entries(outcome.results)) {
    lines.push(
      `  ${name.padEnd(16)} ${r.valid ? "VALID  " : "invalid"} ${r.latencyS.toFixed(3)}s${r.error ? `  ${r.error}` : ""}`,
    );
  }
  for (const name of strategies.map((s) => s.name)) {
    if (!outcome.results[name])
      lines.push(`  ${name.padEnd(16)} cancelled (lost the race)`);
  }
  lines.push(
    outcome.winner
      ? `winner: ${outcome.winner}`
      : "winner: none — every contestant failed or timed out",
  );
  if (outcome.winner && args.flags.get("stdout") === true)
    lines.push("", outcome.winnerOutput);

  writeOut(
    args.flags,
    { raceId, tag, hedgeMs, winner: outcome.winner, results: outcome.results },
    lines.join("\n"),
  );
  return outcome.winner ? 0 : 1;
}

async function cmdBench(args: Args): Promise<number> {
  const warmup = num(args.flags, "warmup", 5);
  const runs = num(args.flags, "runs", 50);
  const racer = new CodeRacer(warmup, runs);

  let candidates: Array<{ name: string; impl: () => unknown }>;
  const candFile = args.flags.get("candidates");
  if (typeof candFile === "string" && candFile) {
    let parsed: unknown;
    try {
      parsed = await Bun.file(candFile).json();
    } catch (e) {
      process.stderr.write(
        `bench: cannot read --candidates file '${candFile}': ${(e as Error).message}\n`,
      );
      return 2;
    }
    const rows = (
      parsed as { candidates?: Array<{ name?: unknown; code?: unknown }> }
    )?.candidates;
    if (!Array.isArray(rows) || rows.length === 0) {
      process.stderr.write(
        `bench: --candidates file must be {"candidates":[{"name","code"},...]}\n`,
      );
      return 2;
    }
    candidates = [];
    for (const row of rows) {
      if (
        typeof row.name !== "string" ||
        typeof row.code !== "string" ||
        !row.name ||
        !row.code
      ) {
        process.stderr.write(
          `bench: skipping malformed candidate ${JSON.stringify(row).slice(0, 80)}\n`,
        );
        continue;
      }
      let impl: () => unknown;
      try {
        impl = new Function(
          `"use strict"; return (${row.code});`,
        ) as () => unknown;
      } catch (e) {
        process.stderr.write(
          `bench: skipping candidate '${row.name}': code does not compile: ${(e as Error).message}\n`,
        );
        continue;
      }
      candidates.push({ name: row.name, impl });
    }
    if (!candidates.length) {
      process.stderr.write("bench: no usable candidates after validation\n");
      return 2;
    }
  } else {
    candidates = [
      {
        name: "array-index-of",
        impl: (): number => [1, 2, 3, 4, 5].indexOf(4),
      },
      { name: "includes", impl: (): boolean => [1, 2, 3, 4, 5].includes(4) },
      {
        name: "find",
        impl: (): number | undefined => [1, 2, 3, 4, 5].find((n) => n === 4),
      },
      {
        name: "sort",
        impl: (): number[] => [5, 4, 3, 2, 1].sort((a, b) => a - b),
      },
      {
        name: "tokenize-100",
        impl: (): number =>
          "aBcDeFgHiJ".toLowerCase().split(/[_]|(?<=[a-z0-9])(?=[A-Z])/).length,
      },
    ];
  }
  const result = racer.race(candidates);
  const rendered = racer.printLeaderboard(result);
  writeOut(args.flags, result, rendered);
  return 0;
}

async function cmdBorrow(args: Args): Promise<number> {
  const query = str(args.flags, "query", args._[0] ?? "");
  if (!query) {
    process.stderr.write(
      'borrow needs a query: forge borrow "agent memory eviction"\n',
    );
    return 2;
  }
  const skip = new Set<SourceName>(list(args.flags, "skip") as SourceName[]);
  const result = await borrow(query, {
    perSource: num(args.flags, "per-source", 5),
    skip,
    exaApiKey: str(args.flags, "exa-key", ""),
  });
  const rendered = renderBorrow(result, num(args.flags, "top", 10));
  writeOut(args.flags, result, rendered);
  return 0;
}

async function cmdPatternBorrow(args: Args): Promise<number> {
  const weights: PatternWeights = { ...DEFAULT_PATTERN_WEIGHTS };
  const rawW = str(args.flags, "weights", "");
  if (rawW) {
    for (const kv of rawW.split(",")) {
      const [k, v] = kv.split("=");
      if (k && v && k in DEFAULT_PATTERN_WEIGHTS) {
        weights[k as PatternFactor] = Number(v);
      }
    }
  }
  const result = await patternBorrow({
    patterns: args._.length ? args._ : undefined,
    top: num(args.flags, "top", args._.length ? args._.length : 5),
    perPage: num(args.flags, "per-page", num(args.flags, "perPage", 5)),
    weights,
    localOnly: args.flags.get("local-only") === true,
  });
  const asText = args.flags.get("text") === true;
  const rendered = renderPatternBorrow(result, asText);
  writeOut(
    args.flags,
    {
      terms: result.terms,
      topRepos: result.topRepos,
      timingMs: result.timingMs,
    },
    rendered,
  );
  return 0;
}

async function cmdSubgraph(args: Args): Promise<number> {
  const root = str(args.flags, "root", process.cwd());
  const trace = str(args.flags, "trace", "");
  if (!trace) {
    process.stderr.write(
      "subgraph needs --trace <file> holding a python traceback\n",
    );
    return 2;
  }
  const frames = extractTracebackFrames(readFileSync(trace, "utf8"));
  const inducer = new DynamicSubgraphInducer(root);
  const graph = inducer.induce(frames, {
    maxDepth: num(args.flags, "depth", 3),
  });
  const width = Math.max(...graph.nodes.map((n) => n.path.length), 10);
  const lines = [
    `=== Subgraph: ${frames.length} frames -> ${graph.nodes.length} files, ${graph.edges.length} edges (root ${root}) ===`,
  ];
  for (const node of graph.nodes) {
    const inFan = graph.fanIn.get(node.path) ?? 0;
    lines.push(
      `${node.inTraceback ? "*" : " "} d${node.depth} ${node.path.padEnd(width)} fanIn=${inFan}${node.symbols.length ? `  ${node.symbols.slice(0, 5).join(", ")}` : ""}`,
    );
  }
  writeOut(args.flags, graph, lines.join("\n"));
  return 0;
}

async function cmdMcts(args: Args): Promise<number> {
  // Candidates are verification commands. Inline: --candidates "a,b,c"
  // (whitespace-split). File: --candidates-file c.json as
  // {"candidates":[{"name":"t","cmd":["bun","test","t.ts"]},...]}.
  type Cand = { name: string; cmd: string[] };
  let cands: Cand[] = [];
  const candFile = args.flags.get("candidates-file");
  if (typeof candFile === "string" && candFile) {
    let parsed: unknown;
    try {
      parsed = await Bun.file(candFile).json();
    } catch (e) {
      process.stderr.write(
        `mcts: cannot read --candidates-file '${candFile}': ${(e as Error).message}\n`,
      );
      return 2;
    }
    const rows = (
      parsed as { candidates?: Array<{ name?: unknown; cmd?: unknown }> }
    )?.candidates;
    if (!Array.isArray(rows)) {
      process.stderr.write(
        `mcts: --candidates-file must be {"candidates":[{"name","cmd":[...]},...]}\n`,
      );
      return 2;
    }
    for (const row of rows) {
      if (
        typeof row.name === "string" &&
        Array.isArray(row.cmd) &&
        row.cmd.every((c) => typeof c === "string")
      ) {
        cands.push({ name: row.name, cmd: row.cmd });
      } else {
        process.stderr.write(
          `mcts: skipping malformed candidate ${JSON.stringify(row).slice(0, 80)}\n`,
        );
      }
    }
  } else {
    const names = list(args.flags, "candidates");
    cands = names.map((n) => ({
      name: n,
      cmd: n.split(/\s+/).filter(Boolean),
    }));
  }
  cands = cands.filter((c) => c.cmd.length > 0);
  if (!cands.length) {
    process.stderr.write(
      "mcts needs --candidates a,b,c or --candidates-file c.json\n",
    );
    return 2;
  }
  const actions: PatchAction[] = cands.map((c) => ({
    actionId: c.name,
    patch: JSON.stringify(c.cmd),
  }));
  const real = args.flags.get("real") === true;
  const timeoutS = num(args.flags, "timeout", 60);
  const engine = new SWEMcts(
    num(args.flags, "depth", 4),
    num(args.flags, "timeout", 60),
  );
  const result = await engine.search(
    async () => actions,
    async (node) => {
      if (!real) return node.stateId === "root" ? 0 : 1;
      if (!node.action) return 0;
      let cmd: string[];
      try {
        cmd = JSON.parse(node.action.patch) as string[];
      } catch {
        cmd = node.action.actionId.split(/\s+/).filter(Boolean);
      }
      return await runRealTest(cmd, timeoutS);
    },
  );
  const lines = [
    `=== MCTS: ${result.iterations} iterations, ${result.nodesExplored} nodes, ${result.elapsedS.toFixed(3)}s${result.timedOut ? " (timed out)" : ""} ===`,
    `best: ${result.bestPatch ?? "(none)"} via ${result.bestStateId ?? "-"}`,
  ];
  writeOut(args.flags, result, lines.join("\n"));
  return 0;
}

async function cmdAudit(args: Args): Promise<number> {
  const opts: AuditOptions = {
    root: (args.flags.get("root") as string) || process.cwd(),
    globs: list(args.flags, "globs"),
    top: num(args.flags, "top", 10),
    claim: args.flags.get("claim") as string | undefined,
    pattern: args.flags.get("pattern") as string | undefined,
    lang: args.flags.get("lang") as string | undefined,
    rule: args.flags.get("rule") as string | undefined,
  };
  const result = audit(opts);
  const rendered = renderAudit(result);
  writeOut(args.flags, result, rendered);
  return result.verdict === "VERIFIED"
    ? 0
    : result.verdict === "NOT-FOUND"
      ? 1
      : 2;
}

/** Reward from a real verification command; +1 pass, -1 fail, -1 timeout. */
async function runRealTest(
  cmd: readonly string[],
  timeoutS: number,
): Promise<number> {
  const [bin, ...argv] = cmd;
  if (!bin) return -1;
  try {
    const proc = Bun.spawn([bin, ...argv], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      timeout: timeoutS * 1000,
      killSignal: "SIGKILL",
    });
    return (await proc.exited) === 0 ? 1 : -1;
  } catch {
    return -1;
  }
}

function cmdPaths(_args: Args): number {
  const rows: [string, string][] = [
    ["ESTATE", P.ESTATE],
    ["RANCH", P.RANCH],
    ["VENDORED", P.VENDORED],
    ["VAR", P.VAR],
    ["MANOR", P.MANOR],
    ["SKILLS_HOME", P.SKILLS_HOME],
    ["TAU_DIR", P.TAU_DIR],
    ["PORTS_ENV", P.PORTS_ENV],
    ["KNOWLEDGEBASE", P.KNOWLEDGEBASE],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  const lines = [
    "=== resolved paths (env override -> skill-marker discovery -> candidate probe -> honest miss) ===",
  ];
  for (const [key, value] of rows) {
    const rendered =
      value === ""
        ? "(unset — no estate checkout on this host)"
        : `${value}  ${existsSync(value) ? "" : "(MISSING)"}`;
    lines.push(`${key.padEnd(width)}  ${rendered}`);
  }
  lines.push("--- estate candidate probe ---");
  for (const r of P.probeEstate()) {
    lines.push(
      `  ${r.candidate}  ${r.exists ? "exists" : "missing"}${r.selected ? "  [selected]" : ""}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return rows.every(([, v]) => existsSync(v)) ? 0 : 1;
}

async function cmdDoctor(args: Args): Promise<number> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  // Doctor speaks in its own summary lines. Leg telemetry (mcts_expand,
  // source_done, ...) would drown them — silence the emitter for the
  // duration of the checks, then restore the default stderr writer.
  setEmitter(() => {});
  try {
    const files = collectFiles(P.SKILL_DIR, {
      extensions: [...CODE_EXTS],
    }).files;
    checks.push({
      name: "scan skill dir",
      ok: files.length > 0,
      detail: `${files.length} code files under ${P.SKILL_DIR}`,
    });

    const { index, stats } = await buildIndex(P.SKILL_DIR);
    const hits = index.hybrid("race first valid winner hedge", 3);
    checks.push({
      name: "retrieve",
      ok: hits.length > 0,
      detail: `${stats.files} indexed, top=${hits[0]?.path ?? "none"}`,
    });

    const racer = new CodeRacer(2, 5);
    const raced = racer.race([
      { name: "noop", impl: () => 1 },
      {
        name: "boom",
        impl: (): never => {
          throw new Error("expected");
        },
      },
    ]);
    checks.push({
      name: "bench",
      ok: raced.winner === "noop",
      detail: `winner=${raced.winner} rows=${raced.rows.length}`,
    });

    const py = collectFiles(P.SKILL_DIR, { extensions: [...PY_EXTS] }).files;
    const frames = extractTracebackFrames(
      '  File "/x/y.py", line 3, in boom\nTraceback (most recent call last):',
    );
    checks.push({
      name: "subgraph parse",
      ok: frames.length === 1,
      detail: `frames=${frames.length} pyFiles=${py.length}`,
    });

    const mcts = new SWEMcts(2, 5);
    const searched = await mcts.search(
      async () => [{ actionId: "a", patch: "p" }],
      async () => 1,
    );
    checks.push({
      name: "mcts",
      ok: searched.bestPatch === "p",
      detail: `${searched.iterations} iters best=${searched.bestStateId}`,
    });

    const estateOk = P.ESTATE === "" || existsSync(P.ESTATE);
    checks.push({
      name: "paths",
      ok: estateOk,
      detail:
        P.ESTATE === ""
          ? "no estate checkout on this host — resolver reported the miss honestly (no blessed stale dir)"
          : `ESTATE=${P.ESTATE} (probed: ${P.probeEstate()
              .map(
                (r) =>
                  `${r.candidate}=${r.exists ? "exists" : "missing"}${r.selected ? " [selected]" : ""}`,
              )
              .join(", ")})`,
    });

    const sgBin = resolveAstGrep();
    checks.push({
      name: "audit (ast-grep)",
      ok: sgBin !== null,
      detail: sgBin ?? "ast-grep missing from PATH (set AST_GREP_BIN)",
    });

    if (args.flags.get("borrow") === true) {
      const borrowed = await borrow("mcts planning", {
        perSource: 1,
        skip: new Set(["exa"]),
      });
      const allSources = Object.values(borrowed.sources);
      const okSources = allSources.filter((s) => s?.ok);
      // Edge case: a source can report ok:true yet return ZERO items (silent
      // degradation). Count only sources that actually yielded ranks.
      const okWithItems = allSources.filter(
        (s) => s?.ok && Array.isArray(s.items) && s.items.length > 0,
      );
      checks.push({
        name: "borrow (network)",
        ok: okWithItems.length > 0,
        detail: `${okWithItems.length} sources with items / ${okSources.length} ok / ${allSources.length} total in ${borrowed.timingMs.toFixed(0)}ms`,
      });
      // Edge case: the GitHub code leg must yield real items when it claims ok.
      // borrow marks it ok even on a dead token (degrades, not fails) — flag it.
      const gh = borrowed.sources["github"];
      checks.push({
        name: "borrow github leg",
        ok:
          gh?.ok === true &&
          (Array.isArray(gh.items) ? gh.items.length > 0 : false),
        detail:
          gh?.ok === true
            ? `${Array.isArray(gh.items) ? gh.items.length : 0} github item(s)`
            : `github degraded: ${gh?.error ?? "leg disabled"}`,
      });
    }
  } finally {
    setEmitter((line) => process.stderr.write(`${line}\n`));
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = ["=== doctor ==="];
  for (const check of checks) {
    lines.push(
      `${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

// build a compact text signature from a repo dir's README/SKILL/AGENTS/package.json
function formatTag(m: {
  format: string;
  params?: string;
  type: string;
}): string {
  return [m.format, m.params].filter(Boolean).join(" ").toUpperCase() || m.type;
}

function repoSignature(dir: string, name: string): string | null {
  const candidateFiles = ["README.md", "SKILL.md", "AGENTS.md", "readme.md"];
  for (const f of candidateFiles) {
    const p = join(dir, f);
    if (existsSync(p) && statSync(p).size > 0 && statSync(p).size < 120_000) {
      try {
        return readFileSync(p, "utf8").slice(0, 2000);
      } catch {
        continue;
      }
    }
  }
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const pj = JSON.parse(readFileSync(pkg, "utf8"));
      const desc = pj?.description || "";
      if (desc) return desc.slice(0, 1200);
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function cmdHf(args: Args): Promise<number> {
  const sub = args._[0] ?? "search";
  const REST = args._.slice(1);

  // search <query> | models [--sort downloads] [--task zero-shot] | models --provider freeinference
  if (sub === "search" || sub === "models") {
    const provider = String(args.flags.get("provider") ?? "hub");
    if (sub === "models" && provider === "freeinference") {
      const models = await hf.freeinfModels();
      if (args.flags.get("json") === true) {
        process.stdout.write(
          JSON.stringify({ provider: "freeinference", models }) + "\n",
        );
        return models.length ? 0 : 1;
      }
      process.stdout.write(`FreeInference models:\n`);
      for (const m of models) process.stdout.write(`  ${m}\n`);
      return models.length ? 0 : 1;
    }
    const query = REST.join(" ");
    const sort = String(args.flags.get("sort") ?? "downloads");
    const dir = String(args.flags.get("direction") ?? "-1");
    const limit = Number(args.flags.get("limit") ?? 12);
    const task = String(args.flags.get("task") ?? "");
    const lib = String(args.flags.get("library") ?? "");
    try {
      const rows = await hf.hfSearch(query, {
        sort,
        direction: dir,
        limit,
        task,
        library: lib,
      });
      if (args.flags.get("json") === true) {
        const ranked = hf.sortByRank(rows).map((m) => ({
          id: m.id,
          task: m.task,
          downloads: m.downloads,
          likes: m.likes,
          trending: m.trending,
          modifiedAt: m.modifiedAt,
          rank: Number(hf.rankModel(m).toFixed(1)),
        }));
        process.stdout.write(
          JSON.stringify({ query, sort, results: ranked }) + "\n",
        );
        return 0;
      }
      if (!rows.length) {
        process.stdout.write(`HF: no models for '${query}'\n`);
        return 1;
      }
      const ranked = hf.sortByRank(rows);
      process.stdout.write(
        `HF search '${query}' (sort=${sort}) -> top ${rows.length} by rank:\n`,
      );
      for (const m of ranked) {
        const score = hf.rankModel(m).toFixed(1);
        process.stdout.write(
          `  ${score.padStart(5)}  ${String(m.downloads ?? 0).padStart(10)}dl ${String(m.likes ?? 0).padStart(4)}♡ ${(m.task ?? "?").padEnd(20)} ${m.id}\n`,
        );
      }
      return 0;
    } catch (e: any) {
      process.stdout.write(`HF search failed: ${e?.message ?? e}\n`);
      return 1;
    }
  }

  // classify <text> --labels a,b,c [--models m1,m2,m3] [--engine local|freeinference|hf|embed]
  if (
    sub === "classify" ||
    sub === "completions" ||
    sub === "embed" ||
    sub === "bge"
  ) {
    const text = REST.join(" ");
    const labels = String(args.flags.get("labels") ?? "")
      .split(",")
      .filter(Boolean);
    const explicit = String(args.flags.get("models") ?? "")
      .split(",")
      .filter(Boolean);
    if (!text || !labels.length) {
      process.stdout.write(
        `usage: forge hf classify "<text>" --labels repo,tool,mcp,vendor [--engine local|freeinference|hf] [--model glm-5.3-flash]\n`,
      );
      return 2;
    }
    const engine = String(
      args.flags.get("engine") ??
        (sub === "completions" ? "freeinference" : "local"),
    );
    if (
      engine === "embed" ||
      engine === "bge" ||
      sub === "embed" ||
      sub === "bge"
    ) {
      const r = await hf.embedClassify(text, labels, {
        model: String(args.flags.get("model") ?? "bge-m3"),
      });
      if (args.flags.get("json") === true) {
        process.stdout.write(
          JSON.stringify({
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
            ms: r.ms,
          }) + "\n",
        );
        return r.ok ? 0 : 2;
      }
      process.stdout.write(
        `HF classify "${text.slice(0, 50)}" [embed/${r.model} dims=${r.dims}]\n`,
      );
      for (const l of r.ranked)
        process.stdout.write(
          `  ${l.label === r.winner ? "→" : " "} ${l.label.padEnd(60)} ${l.score.toFixed(4)}\n`,
        );
      if (r.error) process.stdout.write(`  ✗ ${r.error}\n`);
      process.stdout.write(
        `\n  ${r.ok ? `winner: ${r.winner} (cos ${r.score.toFixed(4)}, +${r.margin.toFixed(4)})` : `ABSTAIN: best ${r.winner || "none"} @ ${r.score.toFixed(4)}, margin ${r.margin.toFixed(4)} too thin`}\n`,
      );
      return r.ok ? 0 : 2;
    }
    if (engine === "freeinference" || sub === "completions") {
      const model = String(args.flags.get("model") ?? "glm-5.3-flash");
      const r = await hf.completionsClassify(text, labels, { model });
      if (args.flags.get("json") === true) {
        process.stdout.write(
          JSON.stringify({
            text,
            engine: "freeinference",
            model: r.model,
            ok: r.ok,
            winner: r.winner,
            raw: r.raw,
            error: r.error,
            ms: r.ms,
          }) + "\n",
        );
        return r.ok ? 0 : 2;
      }
      process.stdout.write(
        `HF classify "${text.slice(0, 50)}" [freeinference/${r.model}]\n`,
      );
      if (r.ok) process.stdout.write(`  ✓ ${r.winner}\n`);
      else process.stdout.write(`  ✗ ${r.error ?? "no label"}\n`);
      return r.ok ? 0 : 2;
    }
    if (engine === "local") {
      const local = hf.localZeroShot(text, labels);
      if (args.flags.get("json") === true) {
        process.stdout.write(
          JSON.stringify({
            text,
            engine: "local",
            confident: local.confident,
            winner: local.winner,
            score: local.score,
            margin: local.margin,
            ranked: local.ranked,
          }) + "\n",
        );
        return local.confident ? 0 : 2;
      }
      process.stdout.write(
        `HF classify "${text.slice(0, 60)}" [pure-Bun local]\n`,
      );
      for (const l of local.ranked)
        process.stdout.write(
          `  ${l.label === local.winner ? "→" : " "} ${l.label.padEnd(60)} ${l.score.toFixed(3)}\n`,
        );
      process.stdout.write(
        `\n  ${local.confident ? `winner: ${local.winner} (${local.score.toFixed(3)}, +${local.margin.toFixed(3)})` : `ABSTAIN: best ${local.winner || "none"} @ ${local.score.toFixed(3)}, margin ${local.margin.toFixed(3)} too thin`}\n`,
      );
      return local.confident ? 0 : 2;
    }
    const winners = await hf.bestClassifyModels(explicit, labels);
    let { winner, candidates, agreed } = await hf.classifyRace(
      { text, labels },
      winners,
      3,
    );
    const okCount = candidates.filter((c) => c.verdict?.ok).length;
    if (!winner || okCount === 0) {
      const local = hf.localZeroShot(text, labels);
      if (args.flags.get("json") === true) {
        process.stdout.write(
          JSON.stringify({
            text,
            engine: "local",
            confident: local.confident,
            winner: local.winner,
            score: Number(local.score.toFixed(4)),
            margin: Number(local.margin.toFixed(4)),
            ranked: local.ranked.map((r) => ({
              label: r.label,
              score: Number(r.score.toFixed(4)),
            })),
            server: {
              ok: okCount,
              candidates: candidates.map((c) => ({
                model: c.model,
                ok: c.verdict?.ok ?? false,
                error: c.verdict?.error,
              })),
            },
          }) + "\n",
        );
        return local.confident ? 0 : 2;
      }
      process.stdout.write(`HF classify "${text.slice(0, 60)}"\n`);
      process.stdout.write(
        `  (serverless zero-shot 402-gated/offline — using pure-Bun local fallback; set --models to a free-inference id)\n`,
      );
      for (const l of local.ranked) {
        process.stdout.write(
          `  ${l.label === local.winner ? "→" : " "} ${l.label.padEnd(60)} ${l.score.toFixed(3)}\n`,
        );
      }
      process.stdout.write(
        `\n  ${local.confident ? `winner: ${local.winner} (${local.score.toFixed(3)}, +${local.margin.toFixed(3)} vs runner-up)` : `ABSTAIN: best ${local.winner || "none"} @ ${local.score.toFixed(3)}, margin ${local.margin.toFixed(3)} too thin`}\n`,
      );
      return local.confident ? 0 : 2;
    }
    process.stdout.write(`HF classify "${text.slice(0, 60)}"\n`);
    for (const c of candidates) {
      const short = c.model.slice(0, 60);
      process.stdout.write(
        `  ${c.verdict?.ok ? "✓" : "✗"} ${short.padEnd(62)} ${c.verdict?.label ?? "err"}=${c.verdict?.score?.toFixed(3) ?? "―"} ${c.verdict?.ms ?? 0}ms${c.verdict?.error ? ` [${c.verdict.error}]` : ""}\n`,
      );
    }
    process.stdout.write(
      `\n  consensus: ${winner || "none"} (${agreed}/${candidates.filter((c) => c.verdict?.ok).length} agree)\n`,
    );
    if (args.flags.get("json") === true) {
      process.stdout.write(
        JSON.stringify({
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
            error: c.verdict?.error,
          })),
        }) + "\n",
      );
    }
    return winner ? 0 : 1;
  }

  // find-classifier <text> --labels a,b [--probe "<real input>" --task zero-shot]
  if (sub === "find-classifier" || sub === "find") {
    const text = REST.join(" ");
    const labels = String(args.flags.get("labels") ?? "")
      .split(",")
      .filter(Boolean);
    const probe = String(args.flags.get("probe") ?? text);
    const task = String(args.flags.get("task") ?? "zero-shot");
    const pool = await hf.findClassifierCandidates(
      probe,
      labels,
      task,
      Number(args.flags.get("limit") ?? 8),
    );
    if (!pool.length) {
      process.stdout.write(
        "find-classifier: no candidate classifiers from HF Hub\n",
      );
      return 1;
    }
    const winners = pool.map((m) => m.model);
    const race = await hf.classifyRace({ text: probe, labels }, winners, 3);
    let winner = race.winner;
    if (!winner) {
      const local = hf.localZeroShot(probe, labels);
      winner = local.confident ? local.winner : "";
      if (args.flags.get("json") === true) {
        process.stdout.write(
          JSON.stringify({
            text: probe,
            engine: "local",
            confident: local.confident,
            winner: local.winner,
            score: Number(local.score.toFixed(4)),
            margin: Number(local.margin.toFixed(4)),
            ranked: local.ranked.map((r) => ({
              label: r.label,
              score: Number(r.score.toFixed(4)),
            })),
            candidates: pool.map((m) => m.id),
          }) + "\n",
        );
        return winner ? 0 : 2;
      }
      process.stdout.write(
        `find-classifier: ${pool.length} candidates all 402-gated; pure-Bun fallback ${local.confident ? `selects '${local.winner}' (${local.score.toFixed(3)}, +${local.margin.toFixed(3)})` : `ABSTAINS (best ${local.winner || "none"} @ ${local.score.toFixed(3)}, margin ${local.margin.toFixed(3)} too thin)`}\n`,
      );
      for (const l of local.ranked)
        process.stdout.write(
          `  ${l.label === local.winner ? "→" : " "} ${l.label.padEnd(12)} ${l.score.toFixed(3)}\n`,
        );
      return winner ? 0 : 2;
    }
    process.stdout.write(
      `find-classifier: raced ${pool.length} candidate zero-shot models on '${probe.slice(0, 50)}'\n`,
    );
    for (const c of race.candidates.sort(
      (a, b) => (b.verdict?.score ?? 0) - (a.verdict?.score ?? 0),
    )) {
      const rank = pool.find((m) => m.model === c.model)?.rank ?? 0;
      process.stdout.write(
        `  ${c.verdict?.ok ? "✓" : "✗"} rank${rank.toFixed(0).padStart(2)} ${c.verdict?.label?.padEnd(12)} ${(c.verdict?.score ?? 0).toFixed(3)} ${c.model}${c.verdict?.error ? ` [${c.verdict.error}]` : ""}\n`,
      );
    }
    process.stdout.write(`\n  recommended: ${winner}\n`);
    return winner ? 0 : 1;
  }

  // categorize --root <dir> --labels a,b,c [--write out.json] [--margin M] [--min-score S]
  if (sub === "categorize" || sub === "categorize-repos") {
    const rootArg = String(args.flags.get("root") ?? "");
    const defaultLabels = [
      {
        id: "infra",
        desc: "infrastructure, deployment, and system daemon repository: services, ports, supervisors, docker, nginx, telemetry, CI/CD",
      },
      {
        id: "tool",
        desc: "command-line tool or utility program: a CLI, script, or developer-facing utility",
      },
      {
        id: "mcp",
        desc: "MCP server: exposes agent tools and resources over the Model Context Protocol for AI coding agents",
      },
      {
        id: "agent",
        desc: "autonomous agent or agent fleet runtime: orchestrates agents, tasks, fleets, swarms, or multi-agent workflows",
      },
      {
        id: "vendor",
        desc: "third-party upstream project: a fork, vendored copy, or reference clone of an external open-source codebase",
      },
      {
        id: "tau",
        desc: "tau ecosystem: part of the tau coding-agent engine, its extensions, or its plugin marketplace",
      },
      {
        id: "ml",
        desc: "machine learning and model tooling: model serving, embeddings, LLM orchestration, fine-tuning, or inference infrastructure",
      },
      {
        id: "research",
        desc: "research, analysis, experiment, or audit repository: benchmark, probe, recon, or investigation scripts",
      },
      {
        id: "runtime",
        desc: "long-running daemon or runtime service: a background process, broker, watchdog, or distributed service",
      },
      {
        id: "website",
        desc: "website source or content repository: a public site, static site, storefront, or web application frontend",
      },
    ];
    const labels = String(
      args.flags.get("labels") ??
        "infra,tool,mcp,agent,vendor,tau,ml,research,runtime,website",
    )
      .split(",")
      .filter(Boolean);
    const labelDescs = defaultLabels
      .filter((l) => labels.includes(l.id))
      .map((l) => l.desc);
    const writePath = String(args.flags.get("write") ?? "");
    if (!rootArg || !resolve(rootArg).startsWith("/")) {
      process.stdout.write(
        `usage: forge hf categorize --root <dir> --labels a,b,c [--write out.json]\n`,
      );
      return 2;
    }
    const root = resolve(rootArg);
    if (!existsSync(root)) {
      process.stdout.write(`categorize: root not found: ${root}\n`);
      return 1;
    }
    const entries = readdirSync(root, { withFileTypes: true }).filter((e) =>
      e.isDirectory(),
    );
    // build a text signature per repo: prefer README/SKILL/AGENTS/package.json desc
    const signatures: { repo: string; text: string }[] = [];
    for (const e of entries) {
      const dir = join(root, e.name);
      const sig = repoSignature(dir, e.name);
      if (sig) signatures.push({ repo: e.name, text: sig });
    }
    if (!signatures.length) {
      process.stdout.write(
        `categorize: no repos with a readable signature under ${root}\n`,
      );
      return 1;
    }
    process.stderr.write(
      `categorize: ${signatures.length} repos × ${labels.length} labels (bge-m3, batch embed)\n`,
    );
    const res = await hf.categorizeRepos(signatures, labels, {
      labelDesc: labelDescs,
      sourceRepo: root,
    });
    if (!res.ok) {
      process.stdout.write(`categorize: embed failed — ${res.error}\n`);
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
            score: Number(r.score.toFixed(4)),
          })),
        })),
      };
      if (writePath)
        writeFileSync(
          resolve(writePath),
          JSON.stringify(payload, null, 2) + "\n",
        );
      if (args.flags.get("json") === true)
        process.stdout.write(JSON.stringify(payload) + "\n");
    } else {
      process.stdout.write(
        `model=${res.model.id} dims=${res.model.dims} repos=${res.scope.repoCount} labels=${res.labels.length}\n`,
      );
      for (const a of res.assignments) {
        process.stdout.write(
          `  ${a.confident ? "✓" : "?"} ${(a.label || "—").padEnd(14)} ${a.repo.padEnd(40)} ${a.score.toFixed(3)} +${a.margin.toFixed(3)}${a.confident ? `  (vs ${a.runnerUp})` : ""}\n`,
        );
      }
      if (writePath)
        process.stdout.write(
          `\nwrote ${resolve(writePath)} (schema estate.categorize@1)\n`,
        );
    }
    return 0;
  }

  // tree <model> [--limit N]
  if (sub === "tree") {
    const repo = REST.join(" ").trim().replace(/\/$/, "");
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      process.stdout.write(
        `usage: forge hf tree <author/model> [--limit N]   e.g. forge hf tree LiquidAI/LFM2.5-24B-A2B\n`,
      );
      return 2;
    }
    const tree = await hf.modelTree(repo, {
      limit: Number(args.flags.get("limit") ?? 40),
    });
    if (tree.error) {
      process.stdout.write(`tree: failed — ${tree.error}\n`);
      return 1;
    }
    if (args.flags.get("json") === true) {
      process.stdout.write(JSON.stringify(tree) + "\n");
      return 0;
    }
    process.stdout.write(`Model tree for ${tree.root}\n`);
    if (tree.base) process.stdout.write(`\nBase model\n  ${tree.base}\n`);
    process.stdout.write(
      `\nThis model\n  ${tree.parent.repo}  (${formatTag(tree.parent)}${tree.parent.downloads ? ` · ${tree.parent.downloads.toLocaleString()} dl · ${tree.parent.likes}♥` : ""})\n`,
    );
    if (tree.finetunes.length) {
      process.stdout.write(`\nFinetunes (${tree.finetunes.length}):\n`);
      for (const m of tree.finetunes.slice(0, 20))
        process.stdout.write(
          `  ${m.repo}  [${formatTag(m)}] · ${m.downloads.toLocaleString()} dl\n`,
        );
      if (tree.finetunes.length > 20)
        process.stdout.write(`  … and ${tree.finetunes.length - 20} more\n`);
    }
    if (tree.quantizations.length) {
      process.stdout.write(`\nQuantizations (${tree.quantizations.length}):\n`);
      for (const m of tree.quantizations.slice(0, 25))
        process.stdout.write(
          `  ${m.repo}  [${formatTag(m)}] · ${m.downloads.toLocaleString()} dl${m.isOfficial ? " (official)" : ""}\n`,
        );
      if (tree.quantizations.length > 25)
        process.stdout.write(
          `  … and ${tree.quantizations.length - 25} more\n`,
        );
    }
    if (tree.conversions.length) {
      process.stdout.write(`\nConversions (${tree.conversions.length}):\n`);
      for (const m of tree.conversions.slice(0, 15))
        process.stdout.write(
          `  ${m.repo}  [${formatTag(m)}] · ${m.downloads.toLocaleString()} dl\n`,
        );
    }
    if (tree.total === 0)
      process.stdout.write(
        `  (no family members found — check the author/model spelling)\n`,
      );
    return 0;
  }

  process.stdout.write(
    `forge hf subcommands: search | models | classify | embed | completions | find-classifier | categorize | tree\n`,
  );
  return 2;
}

const HELP = `forge — pattern-forge: retrieve, race, borrow, search. Pure Bun.

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
  {"candidates":[{"name":"includes","code":"\"abc\".includes(\"b\")"}]}
MCTS candidates JSON:
  {"candidates":[{"name":"t","cmd":["bun","test","t.ts"]}]}`;

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const command = parsed._[0] ?? "help";
  // Telemetry is opt-in: --json (machine JSONL) or --verbose/FORGE_VERBOSE=1.
  // Default runs stay quiet — leg events drowned real output at MCTS scale.
  const loud =
    parsed.flags.get("json") === true ||
    parsed.flags.get("verbose") === true ||
    process.env.FORGE_VERBOSE === "1";
  setEmitter(loud ? (line) => process.stderr.write(`${line}\n`) : () => {});
  // Positionals are relative to the subcommand. Leaving the subcommand in
  // place made `forge borrow "<query>"` search for the literal word "borrow".
  const args: Args = { _: parsed._.slice(1), flags: parsed.flags };
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
      process.stdout.write(`${HELP}\n`);
      return command === "help" ? 0 : 2;
  }
}

export { main };

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

export type { Strategy };
export type BorrowPaper = PaperItem;
export type BorrowCode = CodeItem;
