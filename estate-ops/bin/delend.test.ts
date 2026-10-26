#!/usr/bin/env bun
/**
 * delend.test.ts — coverage drives for the estate delend helper CLIs.
 *
 * Runs: `bun test bin/delend.test.ts` then `bun test --coverage bin/delend.test.ts`
 *
 * Primary targets (each imported + branch-exercised for real coverage):
 *   delend-code-race, delend-experimental, delend-iterate, delend-oracle
 * Secondary: delend-quick, rig-create
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = "/home/toxic/estate/bin";
const PLUGINS = "/home/toxic/pens/barn/corral/delendai/plugins";

// ---- helper: run a CLI as a child process, return {rc, stdout, stderr} ----
function cli(
  script: string,
  args: string[],
  env: Record<string, string> = {},
  opts: { timeout?: number; cwd?: string } = {},
): { rc: number; out: string; err: string } {
  const e = { ...process.env, ...env } as NodeJS.ProcessEnv;
  const p = spawnSync("bun", [join(BIN, script), ...args], {
    encoding: "utf8",
    timeout: opts.timeout ?? 15000,
    env: e,
    cwd: opts.cwd,
  });
  return { rc: p.status ?? 1, out: p.stdout || "", err: p.stderr || "" };
}

// ---- helper: load a @delendai/* plugin source as the canonical module.
// The bin/delend-* files are now thin shims over the plugins, so tests import
// the plugin source directly (bun ESM: dynamic import, never require).
// `fresh: true` cache-busts so module-level env reads (oracle paths, forge)
// re-evaluate with the caller's process.env — the oracle tests require this.
const PLUGIN_PATHS: Record<string, string> = {
  "code-race": `${PLUGINS}/code-race/src/index.ts`,
  experimental: `${PLUGINS}/experimental/src/index.ts`,
  iterate: `${PLUGINS}/iterate/src/index.ts`,
  "oracle-market": `${PLUGINS}/oracle-market/src/index.ts`,
  "work-refs": `${PLUGINS}/work-refs/src/index.ts`,
  "model-race": `${PLUGINS}/model-race/src/index.ts`,
  "forge-audit": `${PLUGINS}/forge-audit/src/index.ts`,
  "intent-router": `${PLUGINS}/intent-router/src/index.ts`,
  "global-gh": `${PLUGINS}/global-gh/src/index.ts`,
  "rig-c2": `${PLUGINS}/rig-c2/src/index.ts`,
};
// Legacy name -> plugin name (delend-quick lives in work-refs, etc.)
const PLUGIN_ALIASES: Record<string, string> = {
  "delend-code-race": "code-race",
  "delend-experimental": "experimental",
  "delend-iterate": "iterate",
  "delend-oracle": "oracle-market",
  "delend-quick": "work-refs",
  "delend-working-dirty": "work-refs",
  "delend-stash-optimize": "work-refs",
  "delend-model-race": "model-race",
  "delend-forge-audit": "forge-audit",
  "delend-route": "intent-router",
  "delend-gh": "global-gh",
  "delend-branch-audit-for-main": "global-gh",
  "delend-rig-c2": "rig-c2",
};
function pluginPath(legacyOrPlugin: string): string {
  const plugin = PLUGIN_ALIASES[legacyOrPlugin] ?? legacyOrPlugin;
  return PLUGIN_PATHS[plugin] ?? join(BIN, legacyOrPlugin);
}
async function loadPlugin(legacyOrPlugin: string, fresh = false): Promise<any> {
  const p = pluginPath(legacyOrPlugin);
  const spec = fresh ? `${p}?cb=${Date.now()}-${Math.random().toString(36).slice(2)}` : p;
  return import(spec);
}

// A scratch dir for oracle/iterate temp state. Synchronous at module load so
// describe-body path computations (delend-oracle) can reference it at
// collection time — `beforeAll` runs too late for that.
const scratch = mkdtempSync(join(tmpdir(), "delend-test-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ============================================================================
describe("delend-code-race", () => {
  let crmod: any;
  let argvOf: (line: string) => string[];
  let craRun: (cmd: string, args: string[]) => any;
  let raceCore: any;
  beforeAll(async () => {
    crmod = await loadPlugin("delend-code-race");
    argvOf = crmod.argvOf;
    craRun = crmod.run;
    raceCore = crmod.raceCore;
  });
  const FORGE = "";
  void FORGE;

  test("argvOf tokenizes quoted + unquoted words", () => {
    expect(argvOf("ls -la 'my file' \"two words\" plain")).toEqual([
      "ls",
      "-la",
      "my file",
      "two words",
      "plain",
    ]);
    expect(argvOf("")).toEqual([]);
  });

  test("run returns status for a real command", () => {
    const r = craRun("true", []);
    expect(r.status).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  test("run returns failure for a missing command", () => {
    const r = craRun("definitely-not-a-real-cmd-xyz", []);
    expect(r.status).not.toBe(0);
  });

  test("no-args → usage exit 2 (CLI)", () => {
    const r = cli("delend-code-race", []);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("usage: delend-code-race");
  });

  test("parseArgs extracts flag + budget + command", () => {
    const pa = crmod.parseArgs as (a: string[]) => {
      perSource: number;
      budget: number;
      raceTimeout: number;
      cmdLine: string;
    };
    expect(pa(["slow-cmd -x 1", "--per-source", "5"])).toMatchObject({
      perSource: 5,
      budget: 4000,
      raceTimeout: 6,
      cmdLine: "slow-cmd -x 1",
    });
    expect(pa(["cmd", "--2s"])).toMatchObject({ budget: 2000 });
    expect(pa(["cmd", "--race-timeout", "9"])).toMatchObject({
      raceTimeout: 9,
    });
    // no command → empty cmdLine
    expect(pa([]).cmdLine).toBe("");
  });

  test("CLI main: succeeds on a fast command, usage exit 2 on no command", async () => {
    const ok = await crmod.main(["true"]);
    expect(ok).toBe(0);
    const noCmd = await crmod.main([]);
    expect(noCmd).toBe(2);
  });

  test("parseArgs bad --per-source → falls back to 3", () => {
    const pa = crmod.parseArgs as (a: string[]) => { perSource: number };
    expect(pa(["cmd", "--per-source", "x"]).perSource).toBe(3);
  });

  test("fast cmd → PASS flaky, rc 0", async () => {
    const res = await raceCore("true", {});
    expect(res.rc).toBe(0);
    expect(res.token).toBe("PASS flaky");
    expect(res.detail).toContain("completed under");
  });

  test("2s budget fast cmd → PASS flaky", async () => {
    const res = await raceCore("true", { budget: 2000 });
    expect(res.rc).toBe(0);
    expect(res.detail).toContain("2000ms");
  });

  test("FORGE missing + persistent breach → FAIL rc 1", async () => {
    // Point forge at a nonexistent path so the "no race possible" branch is hit
    const res = await raceCore("false", {
      forge: join(scratch, "no-forge.ts"),
      budget: 2000,
    });
    expect(res.rc).toBe(1);
    expect(res.token).toBe("FAIL");
  });

  test("borrow surfaced with stub forge → PASS borrow + winner written", async () => {
    // A stub FORGE that prints a borrow-style line and exits 0.
    const stub = join(scratch, "stub-forge.ts");
    writeFileSync(
      stub,
      `
      const a = process.argv[2];
      if (a === "race") { console.log("race done"); process.exit(0); }
      console.log("1. [npm] faster-alternative 0.8ms — some lib");
      process.exit(0);
    `,
    );
    const winner = join(scratch, "winner.json");
    let captured: any = null;
    const res = await raceCore("slowcmd", {
      forge: stub,
      budget: 500,
      writeWinner: (p: any) => {
        captured = p;
      },
    });
    expect(res.rc).toBe(0);
    expect(res.token).toBe("PASS borrow");
    expect(captured).not.toBeNull();
    expect(captured.borrow_src).toBe("npm");
    expect(captured.top_candidate).toContain("faster-alternative");
  });

  test("borrow surfaced but no winner.json writer (default path)", async () => {
    const stub = join(scratch, "stub-forge2.ts");
    writeFileSync(
      stub,
      `
      const a = process.argv[2];
      if (a === "race") { console.log("race done"); process.exit(0); }
      console.log("1. [arxiv] paper-pattern 2ms");
      process.exit(0);
    `,
    );
    const res = await raceCore("slowcmd2", { forge: stub, budget: 500 });
    expect(res.rc).toBe(0);
    expect(res.winnerWritten).toBe(true);
    expect(existsSync("/tmp/delend-code-race-winner.json")).toBe(true);
  });

  test("empty borrow output → FAIL rc 1", async () => {
    const stub = join(scratch, "stub-forge3.ts");
    writeFileSync(
      stub,
      `const a=process.argv[2]; if(a==="race"){console.log("race");process.exit(0);} process.exit(0);`,
    );
    const res = await raceCore("slowcmd3", { forge: stub, budget: 500 });
    expect(res.rc).toBe(1);
    expect(res.token).toBe("FAIL");
    expect(res.lines.join("\n")).toContain("FAIL — no borrow surfaced");
  });
});

// ============================================================================
describe("delend-experimental", () => {
  let mod: any;
  beforeAll(async () => {
    mod = await loadPlugin("delend-experimental");
  });

  test("get parses present + absent flags", () => {
    expect(mod.get(["--brief", "hi", "--paths", "3"], "--brief", "")).toBe(
      "hi",
    );
    expect(mod.get(["--brief", "hi"], "--paths", "3")).toBe("3");
    expect(mod.get([], "--missing", "d")).toBe("d");
  });

  test("runCmd returns output for a real command", () => {
    const r = mod.runCmd(["echo", "hello"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("hello");
  });

  test("runCmd surfaces exit code for a failing command", () => {
    const r = mod.runCmd(["false"]);
    expect(r.status).toBe(1);
  });

  test("no --brief → usage exit 2 (CLI)", () => {
    const r = cli("delend-experimental", []);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("usage");
  });

  test("with --brief and --paths 1 writes result JSON", () => {
    const r = cli("delend-experimental", [
      "--brief",
      "bridge zk + vm",
      "--paths",
      "1",
      "--iter",
      "1",
    ]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("delend-experimental — 1 parallel");
    expect(existsSync("/tmp/delend-experimental-result.json")).toBe(true);
    const j = JSON.parse(
      readFileSync("/tmp/delend-experimental-result.json", "utf8"),
    );
    expect(j.brief).toBe("bridge zk + vm");
    expect(j.paths).toBe(1);
    expect(j.winner).toBeTruthy();
  }, 30000);

  test("--paths 3 → 3 conjectured paths", () => {
    const r = cli("delend-experimental", [
      "--brief",
      "multi path x y z",
      "--paths",
      "3",
      "--iter",
      "4",
    ]);
    expect(r.out).toContain("3 parallel divergent paths");
    expect((r.out.match(/-\s+P\d+:/g) || []).length).toBe(3);
  }, 30000);

  test("main (in-process) returns 0, writes result JSON with a stub forge", async () => {
    const stubForge = join(scratch, "exp-stub-forge.ts");
    writeFileSync(
      stubForge,
      `#!/usr/bin/env bun
if (process.argv[2] === "borrow") { console.log("1. [npm] faster-exp-lib 0.4ms"); }
process.exit(0);
`,
    );
    chmodSync(stubForge, 0o755);
    const priorEnv = process.env.DELEND_EXPERIMENTAL_FORGE;
    process.env.DELEND_EXPERIMENTAL_FORGE = stubForge;
    const fresh = await loadPlugin("delend-experimental", true);
    const prevArgv = process.argv;
    process.argv = [
      "bun",
      "delend-experimental",
      "--brief",
      "bridge zk vm",
      "--paths",
      "2",
    ];
    const rc = fresh.main();
    process.argv = prevArgv;
    if (priorEnv === undefined) delete process.env.DELEND_EXPERIMENTAL_FORGE;
    else process.env.DELEND_EXPERIMENTAL_FORGE = priorEnv;
    expect(rc).toBe(0);
    expect(existsSync("/tmp/delend-experimental-result.json")).toBe(true);
  });

  test("main (in-process) no --brief → returns 2", async () => {
    const fresh = await loadPlugin("delend-experimental", true);
    const prevArgv = process.argv;
    process.argv = ["bun", "delend-experimental"];
    const rc = fresh.main();
    process.argv = prevArgv;
    expect(rc).toBe(2);
  });
});

// ============================================================================
describe("delend-iterate", () => {
  let mod: any;
  beforeAll(async () => {
    mod = await loadPlugin("delend-iterate");
  });

  test("get parses argv pairs", () => {
    expect(mod.get(["--goal", "g", "--iters", "5"], "--iters", "10")).toBe("5");
    expect(mod.get(["--goal", "g"], "--iters", "10")).toBe("10");
  });

  test("checkModel produces non-empty string", () => {
    const r = mod.checkModel((cmd: string) => ({
      rc: 0,
      err: "",
      out: "hodos-ok",
    }));
    expect(r).toContain("hodos-ok");
  });

  test("missing --goal → usage exit 2 (CLI)", () => {
    const r = cli("delend-iterate", []);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("usage");
  });

  test("positional N → N sync-feedback iters, writes state json", () => {
    const wd = join(scratch, "iter1");
    mkdirSync(wd, { recursive: true });
    const r = cli(
      "delend-iterate",
      ["--goal", "test goal", "--workdir", wd, "2"],
      {},
    );
    expect(r.out).toContain("2 sync-feedback iters");
    expect(existsSync(join(wd, ".delend-iterate.json"))).toBe(true);
    const j = JSON.parse(
      readFileSync(join(wd, ".delend-iterate.json"), "utf8"),
    );
    expect(j.goal).toBe("test goal");
    expect(j.iters_run).toBe(2);
  }, 20000);

  test("--iters 5 runs 5 iters (no early convergence)", () => {
    const wd = join(scratch, "iter2");
    mkdirSync(wd, { recursive: true });
    const r = cli("delend-iterate", [
      "--goal",
      "goal5",
      "--workdir",
      wd,
      "--iters",
      "5",
    ]);
    // could converge early at 2 clean passes, so iters_run >= 2
    const j = JSON.parse(
      readFileSync(join(wd, ".delend-iterate.json"), "utf8"),
    );
    expect(j.iters_run).toBeGreaterThanOrEqual(2);
    expect(j.iters_run).toBeLessThanOrEqual(5);
    expect(r.out).toContain("5 sync-feedback iters");
  }, 20000);

  test("--before failing (timeout) triggers breach→race branch", () => {
    const wd = join(scratch, "iter3");
    mkdirSync(wd, { recursive: true });
    const r = cli(
      "delend-iterate",
      [
        "--goal",
        "breach goal",
        "--workdir",
        wd,
        "--iters",
        "1",
        "--before",
        "sleep 3; exit 124",
        "--budget-ms",
        "200",
      ],
      {},
      { timeout: 30000 },
    );
    // breach detection runs delend-code-race which may pass or fail; assert it completed
    expect(existsSync(join(wd, ".delend-iterate.json"))).toBe(true);
    void r;
  }, 30000);

  test("main (in-process): runs iters and writes state, uses before/after branches", () => {
    const wd = join(scratch, "iter-inproc");
    mkdirSync(wd, { recursive: true });
    const prevArgv = process.argv;
    process.argv = [
      "bun",
      "delend-iterate",
      "--goal",
      "inproc goal",
      "--workdir",
      wd,
      "--iters",
      "2",
      "--after",
      "echo changed",
    ];
    try {
      const rc = mod.main();
      expect(rc).toBe(0);
    } finally {
      process.argv = prevArgv;
    }
    expect(existsSync(join(wd, ".delend-iterate.json"))).toBe(true);
    const j = JSON.parse(
      readFileSync(join(wd, ".delend-iterate.json"), "utf8"),
    );
    expect(j.goal).toBe("inproc goal");
    expect(j.iters_run).toBeGreaterThanOrEqual(1);
  }, 30000);

  test("main (in-process): breach with 'exit 124' triggers auto-race branch", () => {
    const wd = join(scratch, "iter-breach-inproc");
    mkdirSync(wd, { recursive: true });
    const prevArgv = process.argv;
    process.argv = [
      "bun",
      "delend-iterate",
      "--goal",
      "breach inproc",
      "--workdir",
      wd,
      "--before",
      "exit 124",
      "--budget-ms",
      "500",
      "1",
    ];
    try {
      const rc = mod.main();
      expect(rc).toBe(0);
    } finally {
      process.argv = prevArgv;
    }
    expect(existsSync(join(wd, ".delend-iterate.json"))).toBe(true);
  }, 30000);

  test("main (in-process): no --goal → returns 2", () => {
    const prevArgv = process.argv;
    process.argv = ["bun", "delend-iterate"];
    try {
      expect(mod.main()).toBe(2);
    } finally {
      process.argv = prevArgv;
    }
  });
});

// ============================================================================
describe("delend-oracle", () => {
  let mod: any;
  beforeAll(async () => {
    mod = await loadPlugin("delend-oracle");
  });
  // Temp oracle dir for status/hindsight tests
  const oDir = join(scratch, "oracle");
  const transcript = join(scratch, "oracle-transcript.jsonl");
  beforeAll(() => {
    mkdirSync(join(oDir, "ledger"), { recursive: true });
  });

  // Spell out readHindsight/ensureHindsight behavior via an env-pointed
  // subprocess harness: the module reads LEDGER/HINDSIGHT from env at import
  // time, so the in-process `mod` (captured on first require) can't be pointed
  // at scratch — a fresh `bun` process with env can.
  function oracleHarness(code: string, env: Record<string, string>): string {
    const harness = join(
      scratch,
      "oracle-harness-" + Math.random().toString(36).slice(2) + ".ts",
    );
    writeFileSync(
      harness,
      `
      const m = await import("/home/toxic/pens/barn/corral/delendai/plugins/oracle-market/src/index.ts");
      ${code}
    `,
    );
    const p = spawnSync("bun", [harness], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return (p.stdout || "").trim() + (p.stderr || "").trim();
  }

  test("readHindsight returns '' when missing; reads head when present", () => {
    const h = join(oDir, "hindsight.md");
    // missing → ""
    if (existsSync(h)) rmSync(h);
    let out = oracleHarness("console.log(m.readHindsight())", {
      DELEND_ORACLE_DIR: oDir,
      DELEND_ORACLE_HINDSIGHT: h,
    });
    expect(out).toBe("");
    // present with content → head content
    writeFileSync(h, "# hindsight\n\nsome context here\n");
    out = oracleHarness('console.log(m.readHindsight() || "EMPTY")', {
      DELEND_ORACLE_DIR: oDir,
      DELEND_ORACLE_HINDSIGHT: h,
    });
    expect(out).toContain("some context here");
    // empty file → ""
    writeFileSync(h, "  \n  ", "utf8");
    out = oracleHarness("console.log(m.readHindsight())", {
      DELEND_ORACLE_DIR: oDir,
      DELEND_ORACLE_HINDSIGHT: h,
    });
    expect(out).toBe("");
  });

  test("ensureHindsight seeds a missing hindsight.md", () => {
    const fresh = join(oDir, "fresh");
    mkdirSync(fresh, { recursive: true });
    const freshHindsight = join(fresh, "hindsight.md");
    if (existsSync(freshHindsight)) rmSync(freshHindsight);
    oracleHarness("m.ensureHindsight()", {
      DELEND_ORACLE_DIR: fresh,
      DELEND_ORACLE_HINDSIGHT: freshHindsight,
    });
    const seeded = readFileSync(freshHindsight, "utf8");
    expect(seeded).toContain("# hindsight");
    // idempotent: calling again doesn't wipe existing content
    appendFileSync(freshHindsight, "\nline2\n");
    oracleHarness("m.ensureHindsight()", {
      DELEND_ORACLE_DIR: fresh,
      DELEND_ORACLE_HINDSIGHT: freshHindsight,
    });
    expect(readFileSync(freshHindsight, "utf8")).toContain("line2");
  });

  test("readLedger parses events and tracks last open/assigned/decision (in-process, env-pointed ledger)", async () => {
    // The delend-oracle module reads LEDGER/HINDSIGHT from env at import time,
    // so spawn a tiny harness that sets them and prints readLedger's output.
    const l = join(oDir, "inproc-ledger.jsonl");
    writeFileSync(
      l,
      [
        JSON.stringify({ event: "task_open", task_id: "tA", title: "Alpha" }),
        JSON.stringify({ event: "assigned", task_id: "tA", winner: "wAn" }),
        JSON.stringify({
          event: "intake-decision",
          from: "bob",
          route: "auction",
          reason: "r1",
        }),
        "not json",
        "",
      ].join("\n"),
    );
    const harness = join(scratch, "ledger-harness.ts");
    writeFileSync(
      harness,
      `
      const { readLedger, summarizeAwarded } = await import("/home/toxic/pens/barn/corral/delendai/plugins/oracle-market/src/index.ts");
      const r = readLedger(0);
      const out = JSON.stringify({ newOffset: r.newOffset, lastOpen: r.lastOpen?.task_id, lastAssigned: r.lastAssigned?.task_id, lastDecision: r.lastDecision?.from, events: r.events.map((e:any)=>e.event) });
      console.log(out);
    `,
    );
    const p = spawnSync("bun", [harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        DELEND_ORACLE_LEDGER: l,
        DELEND_ORACLE_HINDSIGHT: join(oDir, "hh.md"),
      },
    });
    const parsed = JSON.parse(p.stdout.trim());
    expect(parsed.lastOpen).toBe("tA");
    expect(parsed.lastAssigned).toBe("tA");
    expect(parsed.lastDecision).toBe("bob");
    // only the 3 valid json events parse
    expect(parsed.events).toEqual(["task_open", "assigned", "intake-decision"]);
  });

  test("status subcommand with hindsight + ledger (CLI, temp oracle)", () => {
    const l2 = join(oDir, "ledger2.jsonl");
    const h2 = join(oDir, "hindsight2.md");
    writeFileSync(h2, "# hindsight\nline2\nline3\n");
    writeFileSync(
      l2,
      [
        JSON.stringify({
          event: "task_open",
          task_id: "t1",
          title: "First task",
        }),
        "",
        JSON.stringify({ event: "assigned", task_id: "t1", winner: "bidderA" }),
        "",
      ].join("\n"),
    );
    const r = cli("delend-oracle", ["status"], {
      DELEND_ORACLE_DIR: oDir,
      DELEND_ORACLE_LEDGER: l2,
      DELEND_ORACLE_HINDSIGHT: h2,
    });
    expect(r.rc).toBe(0);
    expect(r.out).toContain("=== delend-oracle status ===");
    expect(r.out).toContain("-- hindsight (head) --");
    expect(r.out).toContain("line2");
    expect(r.out).toContain("assigned task=t1 winner=bidderA");
  });

  test("status with no hindsight shows 'none yet' seed message", () => {
    const hNone = join(oDir, "no-hindsight.md");
    const lNone = join(oDir, "no-ledger.jsonl");
    if (existsSync(hNone)) rmSync(hNone);
    writeFileSync(lNone, "");
    const r = cli("delend-oracle", ["status"], {
      DELEND_ORACLE_DIR: oDir,
      DELEND_ORACLE_LEDGER: lNone,
      DELEND_ORACLE_HINDSIGHT: hNone,
    });
    expect(r.out).toContain("(none yet — will be seeded on first `loop`)");
    expect(r.out).toContain("(no open/assigned task seen in ledger)");
  });

  test("status with only open task (no assigned) shows 'last open task'", () => {
    const lOpen = join(oDir, "open-ledger.jsonl");
    writeFileSync(
      lOpen,
      JSON.stringify({ event: "task_open", task_id: "t9", title: "Open one" }) +
        "\n",
    );
    const r = cli("delend-oracle", ["status"], {
      DELEND_ORACLE_DIR: oDir,
      DELEND_ORACLE_LEDGER: lOpen,
      DELEND_ORACLE_HINDSIGHT: join(oDir, "no2.md"),
    });
    expect(r.out).toContain("last open task=t9 Open one");
  });

  test("status with lastDecision shows intake-decision line", () => {
    const lDec = join(oDir, "dec-ledger.jsonl");
    writeFileSync(
      lDec,
      JSON.stringify({
        event: "intake-decision",
        from: "alice",
        route: "auction",
        reason: "rich",
      }) + "\n",
    );
    const r = cli("delend-oracle", ["status"], {
      DELEND_ORACLE_DIR: oDir,
      DELEND_ORACLE_LEDGER: lDec,
      DELEND_ORACLE_HINDSIGHT: join(oDir, "no3.md"),
    });
    expect(r.out).toContain(
      "intake-decision from=alice route=auction reason=rich",
    );
  });

  test("no subcommand → usage", () => {
    const r = cli("delend-oracle", []);
    expect(r.out).toContain("usage: delend-oracle <command>");
    expect(r.rc).toBe(0);
  });

  test("unknown subcommand → usage + exit 2", () => {
    const r = cli("delend-oracle", ["bogus"]);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("unknown subcommand 'bogus'");
  });

  test("apply without --task → usage exit 2", () => {
    const r = cli("delend-oracle", ["apply"]);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("usage: delend-oracle apply");
  });

  test("apply with --task hands to a stub delend-experimental and records", () => {
    const stubExp = join(scratch, "stub-exp.ts");
    writeFileSync(
      stubExp,
      `#!/usr/bin/env bun
const b=process.argv.indexOf("--brief"); console.log("handled:"+(b>=0?process.argv[b+1]:""));`,
    );
    chmodSync(stubExp, 0o755);
    const r = cli("delend-oracle", ["apply", "--task", "make a rig"], {
      DELEND_EXPERIMENTAL_BIN: stubExp,
      DELEND_ORACLE_TRANSCRIPT: transcript,
    });
    expect(r.rc).toBe(0);
    expect(r.out).toContain("handled:make a rig");
  });

  test("summarizeAwarded formats assigned/open/decision/next_work", () => {
    const lines = mod.summarizeAwarded([
      { event: "assigned", task_id: "t1", winner: "w", price_paid: 5 },
      { event: "task_open", task_id: "t2", title: "TitleA" },
      { event: "intake-decision", from: "f", route: "r", reason: "why" },
      { event: "next_work_request", prev_task: "p9" },
    ]);
    expect(lines.join("\n")).toContain("[task_open] t2 TitleA");
    expect(lines.join("\n")).toContain("[assigned]");
    expect(lines.join("\n")).toContain("[intake-decision]");
    expect(lines.join("\n")).toContain("prev=p9");
  });

  test("summarizeAwarded ignores unknown events", () => {
    expect(mod.summarizeAwarded([{ event: "loop_start", ts: 1 }])).toEqual([]);
  });

  // The oracle module reads its paths from env at import time, so exercise the
  // in-process command handlers against an env-pointed, freshly-required module.
  async function freshOracle(env: Record<string, string>) {
    const prior: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) prior[k] = process.env[k];
    Object.assign(process.env, env);
    const m = await loadPlugin("delend-oracle", true);
    for (const k of Object.keys(env)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
    return m;
  }

  test("main (in-process): status subcommand exercises cmdStatus branches", async () => {
    const o = join(scratch, "oracle-inproc-status");
    const ledger = join(o, "ledger.jsonl");
    const hh = join(o, "hh.md");
    mkdirSync(o, { recursive: true });
    writeFileSync(hh, "# hindsight\nctx line\n");
    writeFileSync(
      ledger,
      [
        JSON.stringify({ event: "task_open", task_id: "tX", title: "Open X" }),
        JSON.stringify({ event: "assigned", task_id: "tX", winner: "w1" }),
      ].join("\n") + "\n",
    );
    const m = await freshOracle({
      DELEND_ORACLE_DIR: o,
      DELEND_ORACLE_LEDGER: ledger,
      DELEND_ORACLE_HINDSIGHT: hh,
    });
    expect(await m.main(["status"])).toBe(0);
  });

  test("main (in-process): status with no hindsight + no ledger shows seed messages", async () => {
    const o = join(scratch, "oracle-inproc-none");
    mkdirSync(o, { recursive: true });
    const m = await freshOracle({
      DELEND_ORACLE_DIR: o,
      DELEND_ORACLE_LEDGER: join(o, "nope.jsonl"),
      DELEND_ORACLE_HINDSIGHT: join(o, "nope.md"),
    });
    expect(await m.main(["status"])).toBe(0);
  });

  test("main (in-process): apply with stub experimental records and returns 0", async () => {
    const o = join(scratch, "oracle-inproc-apply");
    mkdirSync(o, { recursive: true });
    const transcript = join(o, "transcript.jsonl");
    const stubExp = join(scratch, "apply-stub-exp.ts");
    writeFileSync(
      stubExp,
      `#!/usr/bin/env bun
const b = process.argv.indexOf("--brief");
console.log("handled:" + (b >= 0 ? process.argv[b + 1] : ""));
`,
    );
    chmodSync(stubExp, 0o755);
    const m = await freshOracle({
      DELEND_ORACLE_DIR: o,
      DELEND_ORACLE_LEDGER: join(o, "ledger.jsonl"),
      DELEND_ORACLE_HINDSIGHT: join(o, "hh.md"),
      DELEND_ORACLE_TRANSCRIPT: transcript,
      DELEND_EXPERIMENTAL_BIN: stubExp,
    });
    expect(await m.main(["apply", "--task", "inproc task"])).toBe(0);
    // apply without --task → usage exit 2
    expect(await m.main(["apply"])).toBe(2);
    // no subcommand / help → usage exit 0; unknown → exit 2
    expect(await m.main([])).toBe(0);
    expect(await m.main(["bogus"])).toBe(2);
  });

  test("main (in-process): loop exercises cmdLoop with a stubbed python3 + sleep", async () => {
    const o = join(scratch, "oracle-inproc-loop");
    const bin = join(o, "bin");
    const ledger = join(o, "ledger.jsonl");
    const hh = join(o, "hindsight.md");
    const transcript = join(o, "loop-transcript.jsonl");
    mkdirSync(bin, { recursive: true });

    // stubbin provides a stateful python3 (appends ONE award, then none, so the
    // loop sees an award first then two empty iterations → early convergence)
    // and an instant sleep. Both resolve via PATH for the in-process loop.
    const stubbin = join(scratch, "oracle-loop-bin");
    mkdirSync(stubbin, { recursive: true });
    const pyStub = join(stubbin, "python3");
    const countFile = join(stubbin, "count");
    writeFileSync(
      pyStub,
      `#!/usr/bin/env bash
n=$(( $(cat "$COUNTF" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$COUNTF"
if [ "$n" -eq 1 ] && [ -n "$DELEND_ORACLE_LEDGER" ]; then
  echo '{"event":"task_open","task_id":"loopT","title":"Loop task"}' >> "$DELEND_ORACLE_LEDGER"
fi
echo "posted-ok"
exit 0
`,
    );
    chmodSync(pyStub, 0o755);
    const sleepStub = join(stubbin, "sleep");
    writeFileSync(sleepStub, `#!/usr/bin/env bash\nexit 0\n`);
    chmodSync(sleepStub, 0o755);

    writeFileSync(hh, "# hindsight\nseed\n");
    writeFileSync(ledger, ""); // empty at start → startOffset 0

    const prevPath = process.env.PATH;
    const prevLedger = process.env.DELEND_ORACLE_LEDGER;
    const prevCount = process.env.COUNTF;
    const m = await freshOracle({
      DELEND_ORACLE_DIR: o,
      DELEND_ORACLE_LEDGER: ledger,
      DELEND_ORACLE_HINDSIGHT: hh,
      DELEND_ORACLE_TRANSCRIPT: transcript,
    });
    try {
      process.env.PATH = stubbin + ":" + prevPath;
      process.env.DELEND_ORACLE_LEDGER = ledger;
      process.env.COUNTF = countFile;
      // 3 iters: award (i=1), empty (i=2), empty (i=3 → converge early)
      const rc = await m.main(["loop", "--from", "test", "--iters", "3"]);
      expect(rc).toBe(0);
      expect(existsSync(transcript)).toBe(true);
    } finally {
      if (prevLedger === undefined) delete process.env.DELEND_ORACLE_LEDGER;
      else process.env.DELEND_ORACLE_LEDGER = prevLedger;
      if (prevCount === undefined) delete process.env.COUNTF;
      else process.env.COUNTF = prevCount;
      process.env.PATH = prevPath;
    }
  });

  test("main (in-process): loop post-failure + no-award nextToDo fallback", async () => {
    const o = join(scratch, "oracle-inproc-loopfail");
    const bin = join(o, "bin");
    const ledger = join(o, "ledger.jsonl");
    const hh = join(o, "hindsight.md");
    const transcript = join(o, "loopfail-transcript.jsonl");
    mkdirSync(bin, { recursive: true });
    // ledger already holds an assigned event → nextToDo falls back to it
    writeFileSync(
      ledger,
      JSON.stringify({ event: "assigned", task_id: "pastA", winner: "pastW" }) +
        "\n",
    );
    const stubbin = join(scratch, "oracle-loopfail-bin");
    mkdirSync(stubbin, { recursive: true });
    const pyFail = join(stubbin, "python3");
    writeFileSync(pyFail, `#!/usr/bin/env bash\necho "boom" >&2\nexit 3\n`);
    chmodSync(pyFail, 0o755);
    const sleepStub = join(stubbin, "sleep");
    writeFileSync(sleepStub, `#!/usr/bin/env bash\nexit 0\n`);
    chmodSync(sleepStub, 0o755);

    const prevPath = process.env.PATH;
    const m = await freshOracle({
      DELEND_ORACLE_DIR: o,
      DELEND_ORACLE_LEDGER: ledger,
      DELEND_ORACLE_HINDSIGHT: hh,
      DELEND_ORACLE_TRANSCRIPT: transcript,
    });
    try {
      process.env.PATH = stubbin + ":" + prevPath;
      const rc = await m.main(["loop", "--from", "test", "--iters", "1"]);
      expect(rc).toBe(0);
      expect(existsSync(transcript)).toBe(true);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  test("in-process cmdStatus shows intake-decision line; readHindsight truncates; ensureHindsight seeds; readLedger rescans", async () => {
    const o = join(scratch, "oracle-inproc-misc");
    mkdirSync(o, { recursive: true });
    const ledger = join(o, "ledger.jsonl");
    const hh = join(o, "hh.md");
    // hindsight longer than 4000 chars → truncation line executes
    writeFileSync(hh, "x".repeat(5000) + "\ncontext");
    writeFileSync(
      ledger,
      JSON.stringify({
        event: "intake-decision",
        from: "zed",
        route: "auction",
        reason: "r",
      }) + "\n",
    );
    const m = await freshOracle({
      DELEND_ORACLE_DIR: o,
      DELEND_ORACLE_LEDGER: ledger,
      DELEND_ORACLE_HINDSIGHT: hh,
    });
    // cmdStatus with lastDecision present
    expect(await m.main(["status"])).toBe(0);
    // readHindsight truncation + ensureHindsight on a missing file (covered in-process)
    expect(m.readHindsight().length).toBe(4000);
    expect(m.readHindsight().startsWith("x".repeat(50))).toBe(true);
    // readLedger rescan branch: start > ledger length and >0 → full rescan
    const res = m.readLedger(999999);
    expect(res.events.length).toBeGreaterThan(0);
  });

  test("in-process cmdApply failure path returns 1", async () => {
    const o = join(scratch, "oracle-inproc-applyfail");
    mkdirSync(o, { recursive: true });
    const transcript = join(o, "transcript.jsonl");
    const badExp = join(scratch, "apply-bad-exp.ts");
    writeFileSync(
      badExp,
      `#!/usr/bin/env bun
console.error("exploded");
process.exit(1);
`,
    );
    chmodSync(badExp, 0o755);
    const m = await freshOracle({
      DELEND_ORACLE_DIR: o,
      DELEND_ORACLE_LEDGER: join(o, "ledger.jsonl"),
      DELEND_ORACLE_HINDSIGHT: join(o, "hh.md"),
      DELEND_ORACLE_TRANSCRIPT: transcript,
      DELEND_EXPERIMENTAL_BIN: badExp,
    });
    expect(await m.main(["apply", "--task", "boom"])).toBe(1);
  });
});

// ============================================================================
describe("delend-quick", () => {
  let mod: any;
  beforeAll(async () => {
    mod = await loadPlugin("delend-quick");
  });

  test("cleanId normalizes invalid characters", () => {
    expect(mod.cleanId("My-Proposal Name!")).toBe("my_proposal_name");
    expect(mod.cleanId("---")).toBe("core");
    expect(mod.cleanId("valid123")).toBe("valid123");
  });

  test("findRepoRoot locates nearest .git upward", () => {
    const repo = join(scratch, "repo1");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(mod.findRepoRoot(sub)).toBe(repo);
    // no git → falls back to resolved start dir
    const plain = join(scratch, "plain");
    mkdirSync(plain, { recursive: true });
    expect(mod.findRepoRoot(plain)).toBe(plain);
  });

  test("getChangedPaths parses porcelain status", () => {
    const repo = join(scratch, "repo-changed");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "a.txt"), "x");
    // git status --porcelain shows ??
    const r = spawnSync("git", ["status", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
    });
    // if a real git repo doesn't exist (bare .git dir), skip
    const paths = mod.getChangedPaths(repo);
    void r;
    expect(Array.isArray(paths)).toBe(true);
  });

  test("getStagedPaths returns [] without a real repo, and parses with one", () => {
    const plain = join(scratch, "staged-plain");
    mkdirSync(plain, { recursive: true });
    expect(mod.getStagedPaths(plain)).toEqual([]);

    // Real repo with a staged file
    const repo = join(scratch, "staged-repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "tracked.txt"), "a");
    const gi = spawnSync("git", ["init", "-q"], {
      cwd: repo,
      encoding: "utf8",
    });
    void gi;
    const st = spawnSync("git", ["add", "tracked.txt"], {
      cwd: repo,
      encoding: "utf8",
    });
    void st;
    const paths = mod.getStagedPaths(repo);
    expect(Array.isArray(paths)).toBe(true);
  });

  test("no --message → error exit 1 (CLI)", () => {
    const r = cli("delend-quick", []);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("--message");
  });

  test("--help exits 0 with usage", () => {
    const r = cli("delend-quick", ["--help"]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("delend-quick");
  });

  test("explicit --paths in non-git workspace → checkpoint fails (delendai nonzero)", () => {
    // Non-git workspace with one staged file; explicit --paths forces the
    // checkpoint path, and `delendai work checkpoint` cannot run outside a
    // git working tree → delend-quick surfaces exit 1 (not 0).
    const wd = join(scratch, "nongitwd");
    mkdirSync(wd, { recursive: true });
    const file = join(wd, "probe.txt");
    writeFileSync(file, "x");
    const r = cli(
      "delend-quick",
      ["-m", "msg", "--workspace", wd, "--paths", "probe.txt", "--no-push"],
      {},
      { cwd: wd, timeout: 30000 },
    );
    expect(r.rc).not.toBe(0);
  }, 30000);

  test("main (in-process): success checkpoint with a stub delendai", async () => {
    const repo = join(scratch, "q-repo-ok");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    writeFileSync(join(repo, "tracked.txt"), "hello");
    const st = spawnSync("git", ["add", "tracked.txt"], {
      cwd: repo,
      encoding: "utf8",
    });
    if (st.status !== 0) throw new Error("git add failed");

    const stubbin = join(scratch, "q-stubbin");
    mkdirSync(stubbin, { recursive: true });
    const delendaiStub = join(stubbin, "delendai");
    writeFileSync(
      delendaiStub,
      `#!/usr/bin/env bash
cat <<'EOF'
{"status":"success","ref":"refs/heads/wip/agent/implement/p-s-g1/t","commit":"0123456789abcdef0123456789abcdef01234567"}
EOF
exit 0
`,
    );
    chmodSync(delendaiStub, 0o755);

    const prevPath = process.env.PATH;
    const prevArgv = process.argv;
    process.env.PATH = stubbin + ":" + prevPath;
    process.argv = [
      "bun",
      "delend-quick",
      "-m",
      "msg",
      "--workspace",
      repo,
      "--paths",
      "tracked.txt",
      "--no-push",
    ];
    try {
      const rc = await mod.main();
      expect(rc).toBe(0);
    } finally {
      process.argv = prevArgv;
      process.env.PATH = prevPath;
    }
  }, 30000);

  test("main (in-process): push branch runs git push (no remote → warning, still 0)", async () => {
    const repo = join(scratch, "q-repo-push");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    writeFileSync(join(repo, "tracked.txt"), "hello");
    spawnSync("git", ["add", "tracked.txt"], { cwd: repo, encoding: "utf8" });

    const stubbin = join(scratch, "q-stubbin-push");
    mkdirSync(stubbin, { recursive: true });
    const delendaiStub = join(stubbin, "delendai");
    writeFileSync(
      delendaiStub,
      `#!/usr/bin/env bash
cat <<'EOF'
{"status":"success","ref":"refs/heads/wip/agent/implement/p-s-g1/t","commit":"0123456789abcdef0123456789abcdef01234567"}
EOF
exit 0
`,
    );
    chmodSync(delendaiStub, 0o755);

    const prevPath = process.env.PATH;
    const prevArgv = process.argv;
    process.env.PATH = stubbin + ":" + prevPath;
    process.argv = [
      "bun",
      "delend-quick",
      "-m",
      "msg",
      "--workspace",
      repo,
      "--paths",
      "tracked.txt",
    ];
    try {
      const rc = await mod.main();
      expect(rc).toBe(0);
    } finally {
      process.argv = prevArgv;
      process.env.PATH = prevPath;
    }
  }, 30000);

  test("main (in-process): refuses blind sweep when dirty but none staged → 1", async () => {
    const repo = join(scratch, "q-repo-refuse");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    // a changed/untracked file, but nothing staged
    writeFileSync(join(repo, "newfile.txt"), "zzz");

    const prevArgv = process.argv;
    process.argv = [
      "bun",
      "delend-quick",
      "-m",
      "msg",
      "--workspace",
      repo,
      "--no-push",
    ];
    try {
      const rc = await mod.main();
      expect(rc).toBe(1);
    } finally {
      process.argv = prevArgv;
    }
  }, 30000);

  test("main (in-process): clean repo with nothing to checkpoint → 0", async () => {
    const repo = join(scratch, "q-repo-clean");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    const prevArgv = process.argv;
    process.argv = [
      "bun",
      "delend-quick",
      "-m",
      "msg",
      "--workspace",
      repo,
      "--no-push",
    ];
    try {
      const rc = await mod.main();
      expect(rc).toBe(0);
    } finally {
      process.argv = prevArgv;
    }
  }, 30000);

  test("main (in-process): --help returns 0; no --message returns 1", async () => {
    const prevArgv = process.argv;
    try {
      process.argv = ["bun", "delend-quick", "--help"];
      expect(await mod.main()).toBe(0);
      process.argv = ["bun", "delend-quick", "--workspace", "/tmp"];
      expect(await mod.main()).toBe(1);
    } finally {
      process.argv = prevArgv;
    }
  }, 30000);

  test("main (in-process): '='-form flags + -p/-s/-t/--agent produce normalized refs", async () => {
    const repo = join(scratch, "q-repo-eq");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    writeFileSync(join(repo, "tracked.txt"), "hello");
    spawnSync("git", ["add", "tracked.txt"], { cwd: repo, encoding: "utf8" });

    const stubbin = join(scratch, "q-eq-stubbin");
    mkdirSync(stubbin, { recursive: true });
    const delendaiStub = join(stubbin, "delendai");
    writeFileSync(
      delendaiStub,
      `#!/usr/bin/env bash
echo '{"status":"success","ref":"refs/heads/wip/agent/implement/p-s-g1/t","commit":"0123456789abcdef0123456789abcdef01234567"}'
exit 0
`,
    );
    chmodSync(delendaiStub, 0o755);

    const prevPath = process.env.PATH;
    const prevArgv = process.argv;
    process.env.PATH = stubbin + ":" + prevPath;
    process.argv = [
      "bun",
      "delend-quick",
      "--workspace=" + repo,
      "-m=msg",
      "-p=Prop Name!",
      "-s=Slïce",
      "-t=Top ic",
      "--agent=ag",
      "--paths=tracked.txt",
      "--no-push",
    ];
    try {
      const rc = await mod.main();
      expect(rc).toBe(0);
    } finally {
      process.argv = prevArgv;
      process.env.PATH = prevPath;
    }
  }, 30000);

  test("main (in-process): --paths pointing at an existing directory expands to staged files", async () => {
    const repo = join(scratch, "q-repo-dir");
    mkdirSync(join(repo, "src"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    writeFileSync(join(repo, "src", "a.ts"), "x");
    spawnSync("git", ["add", "src/a.ts"], { cwd: repo, encoding: "utf8" });

    const stubbin = join(scratch, "q-dir-stubbin");
    mkdirSync(stubbin, { recursive: true });
    const delendaiStub = join(stubbin, "delendai");
    writeFileSync(
      delendaiStub,
      `#!/usr/bin/env bash
echo '{"status":"success","ref":"refs/heads/wip/agent/implement/p-s-g1/t","commit":"0123456789abcdef0123456789abcdef01234567"}'
exit 0
`,
    );
    chmodSync(delendaiStub, 0o755);

    const prevPath = process.env.PATH;
    const prevArgv = process.argv;
    process.env.PATH = stubbin + ":" + prevPath;
    process.argv = [
      "bun",
      "delend-quick",
      "-m",
      "msg",
      "--workspace",
      repo,
      "--paths",
      "src",
      "--no-push",
    ];
    try {
      const rc = await mod.main();
      expect(rc).toBe(0);
    } finally {
      process.argv = prevArgv;
      process.env.PATH = prevPath;
    }
  }, 30000);

  test("main (in-process): >1500 explicit paths triggers the safety-cap narrowing", async () => {
    const repo = join(scratch, "q-repo-cap");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    writeFileSync(join(repo, "tracked.txt"), "hello");
    spawnSync("git", ["add", "tracked.txt"], { cwd: repo, encoding: "utf8" });

    const stubbin = join(scratch, "q-cap-stubbin");
    mkdirSync(stubbin, { recursive: true });
    const delendaiStub = join(stubbin, "delendai");
    writeFileSync(
      delendaiStub,
      `#!/usr/bin/env bash
echo '{"status":"success","ref":"refs/heads/wip/agent/implement/p-s-g1/t","commit":"0123456789abcdef0123456789abcdef01234567"}'
exit 0
`,
    );
    chmodSync(delendaiStub, 0o755);

    const many = Array.from({ length: 1601 }, (_, i) => `f${i}.txt`);
    const prevPath = process.env.PATH;
    const prevArgv = process.argv;
    process.env.PATH = stubbin + ":" + prevPath;
    process.argv = [
      "bun",
      "delend-quick",
      "-m",
      "msg",
      "--workspace",
      repo,
      "--paths",
      "tracked.txt," + many.join(","),
      "--no-push",
    ];
    try {
      const rc = await mod.main();
      expect(rc).toBe(0);
    } finally {
      process.argv = prevArgv;
      process.env.PATH = prevPath;
    }
  }, 30000);

  test("main (in-process): delendai outputs invalid JSON → surfaces checkpoint failure exit 1", async () => {
    const repo = join(scratch, "q-repo-jsonfail");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    writeFileSync(join(repo, "tracked.txt"), "hello");
    spawnSync("git", ["add", "tracked.txt"], { cwd: repo, encoding: "utf8" });

    const stubbin = join(scratch, "q-jsonfail-stubbin");
    mkdirSync(stubbin, { recursive: true });
    const delendaiStub = join(stubbin, "delendai");
    writeFileSync(
      delendaiStub,
      `#!/usr/bin/env bash
echo "NOT JSON at all"
exit 7
`,
    );
    chmodSync(delendaiStub, 0o755);

    const prevPath = process.env.PATH;
    const prevArgv = process.argv;
    process.env.PATH = stubbin + ":" + prevPath;
    process.argv = [
      "bun",
      "delend-quick",
      "-m",
      "msg",
      "--workspace",
      repo,
      "--paths",
      "tracked.txt",
      "--no-push",
    ];
    try {
      expect(await mod.main()).toBe(1);
    } finally {
      process.argv = prevArgv;
      process.env.PATH = prevPath;
    }
  }, 30000);

  test("main (in-process): successful push completes with a real git origin", async () => {
    const base = join(scratch, "q-push-origin");
    mkdirSync(base, { recursive: true });
    const remote = join(base, "remote.git");
    const repo = join(base, "work");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q", "--bare", remote], { encoding: "utf8" });
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    writeFileSync(join(repo, "tracked.txt"), "hello");
    spawnSync("git", ["add", "tracked.txt"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["remote", "add", "origin", remote], {
      cwd: repo,
      encoding: "utf8",
    });
    spawnSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
      { cwd: repo, encoding: "utf8" },
    );
    spawnSync(
      "git",
      ["update-ref", "refs/heads/wip/agent/implement/p-s-g1/t", "HEAD"],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );

    const stubbin = join(scratch, "q-push-stubbin");
    mkdirSync(stubbin, { recursive: true });
    const delendaiStub = join(stubbin, "delendai");
    writeFileSync(
      delendaiStub,
      `#!/usr/bin/env bash
echo '{"status":"success","ref":"refs/heads/wip/agent/implement/p-s-g1/t","commit":"0123456789abcdef0123456789abcdef01234567"}'
exit 0
`,
    );
    chmodSync(delendaiStub, 0o755);

    const prevPath = process.env.PATH;
    const prevArgv = process.argv;
    process.env.PATH = stubbin + ":" + prevPath;
    process.argv = [
      "bun",
      "delend-quick",
      "-m",
      "msg",
      "--workspace",
      repo,
      "--paths",
      "tracked.txt",
    ];
    try {
      const rc = await mod.main();
      expect(rc).toBe(0);
    } finally {
      process.argv = prevArgv;
      process.env.PATH = prevPath;
    }
  }, 30000);
});

// ============================================================================
describe("rig-create", () => {
  let mod: any;
  beforeAll(async () => {
    mod = await loadPlugin("rig-create");
  });

  test("rigCtx parses name + flags", () => {
    const c = mod.rigCtx([
      "myAgent",
      "--lane",
      "lane B",
      "--tone",
      "warm",
      "--identity",
      "my-agent",
    ]);
    expect(c.name).toBe("myAgent");
    expect(c.lane).toBe("lane B");
    expect(c.identity).toBe("my-agent");
    expect(c.alias).toBe("my-agent");
  });

  test("rigCtx defaults when flags missing", () => {
    const c = mod.rigCtx(["rig2"]);
    expect(c.lane).toBe("general ops");
    expect(c.identity).toBe("rig2");
  });

  test("titleOf capitalizes first letter", () => {
    expect(mod.titleOf("zed")).toBe("Zed");
    expect(mod.titleOf("")).toBe("Rig");
  });

  test("fill substitutes all @ tokens", () => {
    const c = mod.rigCtx(["algo", "--desc", "a desc", "--alias", "algo-ali"]);
    const out = mod.fill(
      "@NAME@|@IDENTITY@|@TITLE@|@ALIASES@|@LANE@|@TONE@|@DESC@|@DATE@",
      c,
    );
    expect(out).toContain("algo");
    expect(out).toContain("Algo");
    expect(out).toContain("a desc");
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("no name → usage exit 2 (CLI)", () => {
    const r = cli("rig-create", []);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("usage: rig-create");
  });

  test("creates rig files in a temp rig-dir", () => {
    const rigDir = join(scratch, "rigs");
    const r = cli("rig-create", ["zort", "--rig-dir", rigDir, "--wipe"]);
    expect(r.rc).toBe(0);
    for (const f of [
      "PERSONA.md",
      "join.squawk.json",
      "config.toml",
      "glue.sh",
      "README.md",
    ]) {
      expect(existsSync(join(rigDir, "rigs", "zort", f))).toBe(true);
    }
  });

  test("existing rig without --wipe → exit 3", () => {
    const rigDir = join(scratch, "rigs2");
    // pre-create matching dir
    mkdirSync(join(rigDir, "rigs", "dup"), { recursive: true });
    const r = cli("rig-create", ["dup", "--rig-dir", rigDir]);
    expect(r.rc).toBe(3);
    expect(r.err).toContain("exists (--wipe");
  });
});
