import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = new URL("./agent-checkpoint.ts", import.meta.url).pathname;

function ckptEnv() {
  const home = mkdtempSync(join(tmpdir(), "ckpt-test-"));
  return { home, env: { ...process.env, HOME: home } };
}

function run(args: string[], env?: Record<string, string>) {
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

function capture(home: string, env: Record<string, string>, extra: string[] = []) {
  const r = run(
    ["capture", "--agent-id", "test-agent-1", "--name", "testfox",
     "--lane", "test/lane", "--brief", "do the thing", ...extra],
    env
  );
  expect(r.code).toBe(0);
  const m = r.out.match(/Checkpoint: (\S+)/);
  expect(m).not.toBeNull();
  const cp = JSON.parse(readFileSync(m![1], "utf8"));
  return { path: m![1] as string, cp, dir: join(home, "workspace", "checkpoints") };
}

// 1. capture requires the four identity flags
test("capture without required flags exits 2", () => {
  const { env } = ckptEnv();
  const r = run(["capture", "--agent-id", "x"], env);
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/needs --agent-id/);
});

// 2. capture writes a version-2 checkpoint with agent fields
test("capture writes checkpoint JSON with agent identity", () => {
  const { home, env } = ckptEnv();
  const { cp } = capture(home, env);
  expect(cp.version).toBe(2);
  expect(cp.agent.id).toBe("test-agent-1");
  expect(cp.agent.name).toBe("testfox");
  expect(cp.agent.lane).toBe("test/lane");
  expect(cp.brief).toBe("do the thing");
  expect(typeof cp.captured_at).toBe("string");
});

// 3. capture records sha256 for artifacts
test("capture hashes artifacts", () => {
  const { home, env } = ckptEnv();
  const art = join(home, "result.txt");
  writeFileSync(art, "hello checkpoint");
  const { cp } = capture(home, env, ["--artifact", art]);
  expect(cp.artifacts).toHaveLength(1);
  expect(cp.artifacts[0].path).toBe(art);
  expect(cp.artifacts[0].exists).toBe(true);
  expect(cp.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
});

// 4. missing artifacts are recorded, not fatal
test("capture records missing artifacts as not-exists", () => {
  const { home, env } = ckptEnv();
  const { cp } = capture(home, env, ["--artifact", "/no/such/file.txt"]);
  expect(cp.artifacts[0].exists).toBe(false);
  expect(cp.artifacts[0].sha256).toBeNull();
});

// 5. repeated --pin accumulates (the Magpie bug: overwrite -> accumulate)
test("repeated --pin flags accumulate", () => {
  const { home, env } = ckptEnv();
  const { cp } = capture(home, env, ["--pin", "a=1", "--pin", "b=2", "--pin", "c=3"]);
  expect(cp.kv.pinned).toEqual({ a: "1", b: "2", c: "3" });
});

// 6. repeated --key-file accumulates
test("repeated --key-file flags accumulate", () => {
  const { home, env } = ckptEnv();
  const { cp } = capture(home, env, ["--key-file", "f1.md", "--key-file", "f2.md"]);
  expect(cp.kv.key_files).toEqual(["f1.md", "f2.md"]);
});

// 7. kv defaults: status unknown, next_step falls back to pending
test("kv defaults status/next_step", () => {
  const { home, env } = ckptEnv();
  const { cp } = capture(home, env, ["--pending", "finish the widget"]);
  expect(cp.kv.status).toBe("unknown");
  expect(cp.kv.next_step).toBe("finish the widget");
});

// 8. brief prints continuation header with name + old id
test("brief prints continuation brief", () => {
  const { home, env } = ckptEnv();
  const { path } = capture(home, env, ["--pending", "polish"]);
  const r = run(["brief", path], env);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/CONTINUATION of testfox/);
  expect(r.out).toMatch(/previous agent id test-agent-1/);
  expect(r.out).toMatch(/STEP ZERO/);
  expect(r.out).toMatch(/polish/);
});

// 9. brief on missing file exits 2
test("brief on missing checkpoint exits 2", () => {
  const { env } = ckptEnv();
  const r = run(["brief", "/no/such/checkpoint.json"], env);
  expect(r.code).toBe(2);
});

// 10. verify passes on unchanged artifacts
test("verify exits 0 when artifacts unchanged", () => {
  const { home, env } = ckptEnv();
  const art = join(home, "stable.txt");
  writeFileSync(art, "stable content");
  const { path } = capture(home, env, ["--artifact", art]);
  const r = run(["verify", path], env);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/OK/);
});

// 11. verify fails on modified artifact
test("verify exits 1 when artifact changed", () => {
  const { home, env } = ckptEnv();
  const art = join(home, "mutable.txt");
  writeFileSync(art, "v1");
  const { path } = capture(home, env, ["--artifact", art]);
  writeFileSync(art, "v2 — changed");
  const r = run(["verify", path], env);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/DIFF/);
});

// 12. verify fails on deleted artifact
test("verify exits 1 when artifact deleted", () => {
  const { home, env } = ckptEnv();
  const art = join(home, "gone.txt");
  writeFileSync(art, "here then gone");
  const { path } = capture(home, env, ["--artifact", art]);
  const { unlinkSync } = require("node:fs");
  unlinkSync(art);
  const r = run(["verify", path], env);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/DIFF/);
});

// 13. list shows captured checkpoints
test("list shows captured checkpoint", () => {
  const { home, env } = ckptEnv();
  capture(home, env);
  const r = run(["list"], env);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/testfox/);
  expect(r.out).toMatch("test-agent-1".slice(0, 8));
});

// 14. unknown command prints usage with exit 2
test("unknown command exits 2 with usage", () => {
  const { env } = ckptEnv();
  const r = run(["frobnicate"], env);
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/agent-checkpoint/);
});

// 15. transcript tail degrades gracefully for unknown agents
test("capture notes missing session file in transcript tail", () => {
  const { home, env } = ckptEnv();
  const { cp } = capture(home, env);
  expect(cp.transcript_tail.join("\n")).toMatch(/no session file/);
});

// 16. checkpoint files land in workspace/checkpoints
test("checkpoint file lands under workspace/checkpoints", () => {
  const { home, env } = ckptEnv();
  const { path, dir } = capture(home, env);
  expect(path.startsWith(dir)).toBe(true);
  expect(readdirSync(dir).length).toBe(1);
});

// --- lane-resume: kill classification + post-mortem recover (Cinder) ---

import { mkdirSync, utimesSync } from "node:fs";

const { classifyKill } = await import(SCRIPT);

function jline(o: object): string {
  return JSON.stringify(o);
}
function sessLine(seq: number, item: object, source = "runtime"): string {
  return jline({ type: "item", seq, source, item });
}
function msg(text: string, role = "assistant"): object {
  return { type: "message", role, text };
}
function call(name: string, args = "{}"): object {
  return { type: "function_call", name, arguments: args };
}
function result(exitCode: number, stdout = "ok"): object {
  return { type: "function_call_output", output: jline({ cwd: "/tmp", exitCode, stdout }) };
}

// Fixture agent dir under a temp agents root (CHECKPOINT_AGENTS_DIR override).
function fakeAgent(home: string, id: string, lines: string[], mtimeAgeMin = 60): Record<string, string> {
  const agentsDir = join(home, "agents");
  const dir = join(agentsDir, `agent-${id}`, "sessions");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id}.jsonl`);
  writeFileSync(f, lines.join("\n") + "\n");
  const past = new Date(Date.now() - mtimeAgeMin * 60000);
  utimesSync(f, past, past);
  return { CHECKPOINT_AGENTS_DIR: agentsDir };
}

function runRecover(home: string, id: string, agentsEnv: Record<string, string>, extra: string[] = []) {
  const env = { ...process.env, HOME: home, ...agentsEnv };
  return run(["recover", "--agent-id", id, "--lane", "test/lane", ...extra], env);
}

// 17. classifyKill: refusal signature in the death window => refusal-kill
test("classifyKill detects refusal-kill from tail signature", () => {
  const lines = [
    sessLine(1, call("exec")),
    sessLine(2, result(0, "did the thing")),
    sessLine(3, msg("A safety policy refused this helper's work. Do not retry it.")),
  ];
  const ev = classifyKill(lines);
  expect(ev.kind).toBe("refusal-kill");
  expect(ev.refusal_context).toMatch(/safety policy refused/i);
});

// 18. classifyKill: unanswered calls at the end => runtime-kill
test("classifyKill detects runtime-kill from unanswered calls", () => {
  const lines = [
    sessLine(1, call("exec")),
    sessLine(2, result(0, "step one done")),
    sessLine(3, call("exec", '{"command":"step two"}')),
    sessLine(4, call("exec", '{"command":"step three"}')),
  ];
  const ev = classifyKill(lines);
  expect(ev.kind).toBe("runtime-kill");
  expect(ev.last_verified_step).toMatch(/step one done/);
});

// 19. classifyKill: substantive final message => completed
test("classifyKill detects completed lanes", () => {
  const lines = [
    sessLine(1, call("exec")),
    sessLine(2, result(0, "ok")),
    sessLine(3, msg("Done. Full report written to /tmp/report.md with all findings summarized.")),
  ];
  const ev = classifyKill(lines);
  expect(ev.kind).toBe("completed");
});

// 20. classifyKill: ignores background proactivity loops
test("classifyKill ignores runtime.proactivity items", () => {
  const lines = [
    sessLine(0, msg("bg loop note"), "runtime.proactivity"),
    sessLine(1, call("worker.finish"), "runtime.proactivity"),
  ];
  const ev = classifyKill(lines);
  expect(ev.kind).toBe("unknown");
});

// 21. recover refuses a live agent (fresh session) without --force
test("recover refuses fresh sessions without --force", () => {
  const { home } = ckptEnv();
  const id = "deadbeef-1111-2222-3333-444455556666";
  const agentsEnv = fakeAgent(home, id, [sessLine(1, call("exec"))], 2);
  const r = runRecover(home, id, agentsEnv);
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/may still be alive/);
});

// 22. recover --force captures a runtime-kill checkpoint + kill-aware brief
test("recover captures runtime-kill checkpoint and brief", () => {
  const { home } = ckptEnv();
  const id = "deadbeef-1111-2222-3333-444455556667";
  const lines = [
    sessLine(1, call("exec")),
    sessLine(2, result(0, "step one done")),
    sessLine(3, call("exec", '{"command":"step two"}')),
  ];
  const agentsEnv = fakeAgent(home, id, lines, 60);
  const r = runRecover(home, id, agentsEnv, ["--force"]);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/kill: runtime-kill/);
  const m = r.out.match(/Checkpoint: (\S+)/);
  expect(m).not.toBeNull();
  const cp = JSON.parse(readFileSync(m![1], "utf8"));
  expect(cp.version).toBe(3);
  expect(cp.kill.kind).toBe("runtime-kill");
  expect(cp.kv.pinned.rephrase_required).toBe("false");
  expect(r.out).toMatch(/Resume as-is/);
  expect(r.out).toMatch(/CONTINUATION/);
});

// 23. recover on refusal-kill brief carries the rephrase-first instruction
test("recover refusal-kill brief demands behavioral rephrase", () => {
  const { home } = ckptEnv();
  const id = "deadbeef-1111-2222-3333-444455556668";
  const lines = [
    sessLine(1, call("exec")),
    sessLine(2, result(0, "step one done")),
    sessLine(3, msg("A safety policy refused this helper's work. Do not retry it.")),
  ];
  const agentsEnv = fakeAgent(home, id, lines, 60);
  const r = runRecover(home, id, agentsEnv, ["--force"]);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/kill: refusal-kill/);
  expect(r.out).toMatch(/REPHRASE/);
  expect(r.out).toMatch(/refusal is NEVER a verdict/);
  const m = r.out.match(/Checkpoint: (\S+)/);
  const cp = JSON.parse(readFileSync(m![1], "utf8"));
  expect(cp.kv.pinned.rephrase_required).toBe("true");
});

// 24. recover on a completed lane refuses to manufacture work
test("recover reports completed lanes without checkpointing", () => {
  const { home } = ckptEnv();
  const id = "deadbeef-1111-2222-3333-444455556669";
  const lines = [
    sessLine(1, call("exec")),
    sessLine(2, result(0, "ok")),
    sessLine(3, msg("Done. Everything finished and verified, report at /tmp/done.md.")),
  ];
  const agentsEnv = fakeAgent(home, id, lines, 60);
  const r = runRecover(home, id, agentsEnv, ["--force"]);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/finished normally/);
  expect(r.out).not.toMatch(/Checkpoint: /);
});

// 25. classifyKill: aborted in-flight result (killed mid-turn) => runtime-kill
test("classifyKill detects runtime-kill from aborted in-flight result", () => {
  const lines = [
    sessLine(1, call("exec")),
    sessLine(2, result(0, "step one done")),
    sessLine(3, call("exec", '{"command":"sleep 90"}')),
    sessLine(4, { type: "function_call_output", output: "aborted" }),
  ];
  const ev = classifyKill(lines);
  expect(ev.kind).toBe("runtime-kill");
  expect(ev.last_verified_step).toMatch(/step one done/);
});

// 26. classifyKill: runtime developer notices don't count as completion
test("classifyKill ignores trailing developer notices for completion", () => {
  const lines = [
    sessLine(1, call("exec")),
    sessLine(2, result(0, "ok")),
    sessLine(3, { type: "message", role: "developer", text: "The system file watcher flagged a change to ~/MEMORY.md in this long message that would otherwise look substantive enough to pass the length check." }),
  ];
  const ev = classifyKill(lines);
  expect(ev.kind).toBe("unknown");
});
