import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = new URL("./lane-resume", import.meta.url).pathname;

function testEnv() {
  const home = mkdtempSync(join(tmpdir(), "laneresume-test-"));
  const agentsDir = join(home, "agents");
  const registry = join(home, "lane-registry.json");
  const env = { ...process.env, HOME: home, CHECKPOINT_AGENTS_DIR: agentsDir, LANE_REGISTRY: registry };
  return { home, agentsDir, registry, env };
}

function run(args: string[], env: Record<string, string>) {
  const p = Bun.spawnSync(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    code: p.exitCode ?? 1,
    out: (p.stdout?.toString() ?? "") + (p.stderr?.toString() ?? ""),
  };
}

function jline(o: object): string {
  return JSON.stringify(o);
}
function sessLine(seq: number, item: object): string {
  return jline({ type: "item", seq, source: "runtime", item });
}
function fakeAgent(agentsDir: string, id: string, lines: string[], mtimeAgeMin = 60) {
  const dir = join(agentsDir, `agent-${id}`, "sessions");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id}.jsonl`);
  writeFileSync(f, lines.join("\n") + "\n");
  const past = new Date(Date.now() - mtimeAgeMin * 60000);
  utimesSync(f, past, past);
}

const DEAD_ID = "aaaabbbb-1111-2222-3333-444455556666";
function deadLines(): string[] {
  return [
    sessLine(1, { type: "function_call", name: "exec", arguments: "{}" }),
    sessLine(2, { type: "function_call_output", output: jline({ exitCode: 0, stdout: "step one" }) }),
    sessLine(3, { type: "function_call", name: "exec", arguments: '{"command":"sleep 90"}' }),
    sessLine(4, { type: "function_call_output", output: "aborted" }),
  ];
}

// 1. register records the spawn
test("register records name/lane/brief in the registry", () => {
  const { registry, env } = testEnv();
  const r = run(
    ["register", "--agent-id", DEAD_ID, "--name", "regfox", "--lane", "test/reglane", "--brief", "do the reg thing"],
    env
  );
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/registered regfox/);
  const reg = JSON.parse(readFileSync(registry, "utf8"));
  expect(reg[DEAD_ID].name).toBe("regfox");
  expect(reg[DEAD_ID].lane).toBe("test/reglane");
  expect(reg[DEAD_ID].brief).toBe("do the reg thing");
  expect(reg[DEAD_ID].status).toBe("active");
});

// 2. register requires identity flags
test("register without lane exits 2", () => {
  const { env } = testEnv();
  const r = run(["register", "--agent-id", DEAD_ID, "--name", "x"], env);
  expect(r.code).toBe(2);
});

// 3. recover uses the registry when flags are absent
test("recover resolves name/lane/brief from the registry", () => {
  const { agentsDir, env } = testEnv();
  fakeAgent(agentsDir, DEAD_ID, deadLines());
  let r = run(
    ["register", "--agent-id", DEAD_ID, "--name", "regfox", "--lane", "test/reglane", "--brief", "do the reg thing"],
    env
  );
  expect(r.code).toBe(0);
  r = run(["recover", DEAD_ID], env);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/kill: runtime-kill/);
  expect(r.out).toMatch(/regfox/);
  expect(r.out).toMatch(/test\/reglane/);
  expect(r.out).toMatch(/do the reg thing/);
});

// 4. recover marks the registry entry recovered
test("recover marks the registry entry recovered with checkpoint path", () => {
  const { agentsDir, registry, env } = testEnv();
  fakeAgent(agentsDir, DEAD_ID, deadLines());
  run(["register", "--agent-id", DEAD_ID, "--name", "regfox", "--lane", "test/reglane"], env);
  const r = run(["recover", DEAD_ID], env);
  const m = r.out.match(/Checkpoint: (\S+)/);
  expect(m).not.toBeNull();
  const reg = JSON.parse(readFileSync(registry, "utf8"));
  expect(reg[DEAD_ID].status).toBe("recovered");
  expect(reg[DEAD_ID].checkpoint).toBe(m![1]);
});

// 5. scan --recover captures the dead and skips them on the second run
test("scan --recover sweeps the dead and dedups via the registry", () => {
  const { agentsDir, env } = testEnv();
  fakeAgent(agentsDir, DEAD_ID, deadLines());
  run(["register", "--agent-id", DEAD_ID, "--name", "regfox", "--lane", "test/reglane"], env);
  let r = run(["scan", "--since-hours", "24", "--recover"], env);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/dead mid-turn/);
  expect(r.out).toMatch(/recovered aaaabbbb \(runtime-kill\)/);
  expect(r.out).toMatch(/1 captured, 0 already recovered, 0 refused/);
  r = run(["scan", "--since-hours", "24", "--recover"], env);
  expect(r.out).toMatch(/already recovered/);
  expect(r.out).toMatch(/0 captured, 1 already recovered, 0 refused/);
});

// 6. scan --recover refuses fresh sessions (fail-closed guard holds in sweeps)
test("scan --recover refuses agents that may still be alive", () => {
  const { agentsDir, env } = testEnv();
  fakeAgent(agentsDir, DEAD_ID, deadLines(), 2); // 2 minutes old -> live
  const r = run(["scan", "--since-hours", "24", "--recover"], env);
  expect(r.out).toMatch(/0 captured, 0 already recovered, 1 refused/);
});
