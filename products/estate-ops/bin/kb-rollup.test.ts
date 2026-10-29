// kb-rollup.test.ts — 15 permanent tests for the per-crew KB migration.
// Run: bun test projects/ops/bin/kb-rollup.test.ts  (on yote; needs flock)
// Every test builds its own fixture KB in a tmpdir — never touches the real KB.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = new URL("./kb-rollup.ts", import.meta.url).pathname;

// Hermetic bin dir for the fail-closed lock test: bun resolvable, flock absent.
// (Blanking PATH outright also hides bun itself, which breaks the spawn.)
const NOFLOCK_BIN = mkdtempSync(join(tmpdir(), "kb-rollup-noflock-"));
symlinkSync(process.execPath, join(NOFLOCK_BIN, "bun"));
const START = "<!-- KB-ROLLUP:START -->";
const END = "<!-- KB-ROLLUP:END -->";

function fixture(rows: string[]): string {
  return [
    "# Fleet Knowledgebase (test fixture)",
    "",
    "## 1. Intro",
    "",
    "## 2. Active crews",
    "",
    "**Rule: check this table first.**",
    "",
    "| Crew | Scope | Owner / coordinator | Status |",
    "|---|---|---|---|",
    ...rows,
    "",
    "17. **Cell workspace = tmp** — the cell is scratch.",
    "",
    "## 3. Next",
    "",
  ].join("\n");
}

function setup(rows: string[]): { kb: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "kb-rollup-test-"));
  const kb = join(dir, "fleet-knowledgebase.md");
  writeFileSync(kb, fixture(rows));
  return { kb, dir };
}

function run(args: string[], env?: Record<string, string>): { code: number; out: string } {
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

function kbRun(kb: string, args: string[], env?: Record<string, string>) {
  return run([...args, "--kb", kb], env);
}

const ALPHA = "| Alpha | first scope | Ember | RUNNING (2026-09-30) |";
const BETA_PIPE = "| Beta | second \\| piped scope | Ember | DONE (2026-09-29) |";

// 1. migrate: table -> per-crew files + markers, old table gone
test("migrate creates per-crew files, markers, and replaces the table", () => {
  const { kb, dir } = setup([ALPHA, BETA_PIPE]);
  const r = kbRun(kb, ["migrate"]);
  expect(r.code).toBe(0);
  const crewsDir = join(dir, "fleet", "crews");
  const files = readdirSync(crewsDir).filter((f) => f.endsWith(".md")).sort();
  expect(files).toEqual(["alpha.md", "beta.md"]);
  const text = readFileSync(kb, "utf8");
  expect(text).toContain(START);
  expect(text).toContain(END);
  expect(text).toContain("GENERATED TABLE");
  expect(text).toContain("Per-crew KB ownership");
  // old hand-written table span is gone (only the generated one remains)
  expect(text).not.toContain("first scope | Ember | RUNNING (2026-09-30) |\n\n17.");
});

// 2. migrate is idempotent
test("migrate twice does not duplicate or error", () => {
  const { kb, dir } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  const r2 = kbRun(kb, ["migrate"]);
  expect(r2.code).toBe(0);
  expect(r2.out).toContain("skip (exists)");
  const files = readdirSync(join(dir, "fleet", "crews"));
  expect(files.length).toBe(1);
});

// 3. rollup is idempotent (no rewrite when up-to-date)
test("rollup twice: second run is a no-op", () => {
  const { kb } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  expect(kbRun(kb, ["rollup"]).code).toBe(0);
  const m1 = statSync(kb).mtimeMs;
  const r = kbRun(kb, ["rollup"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("up-to-date");
  expect(statSync(kb).mtimeMs).toBe(m1);
});

// 4. register adds a crew file + table row
test("register creates crew file and table row", () => {
  const { kb, dir } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  const r = kbRun(kb, ["register", "--name", "Gamma", "--scope", "third scope", "--owner", "Ember"]);
  expect(r.code).toBe(0);
  expect(existsSync(join(dir, "fleet", "crews", "gamma.md"))).toBe(true);
  const text = readFileSync(kb, "utf8");
  expect(text).toContain("| Gamma | third scope | Ember | RUNNING (");
});

// 5. register duplicate (case-insensitive) refuses
test("register duplicate name is refused, not duplicated", () => {
  const { kb } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  const r = kbRun(kb, ["register", "--name", "ALPHA", "--scope", "x", "--owner", "Ember"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("already registered");
  const text = readFileSync(kb, "utf8");
  expect(text.match(/\| Alpha \|/g)!.length).toBe(1);
});

// 6. register slug collision exits 2
test("register slug collision exits 2", () => {
  const { kb } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  const r = kbRun(kb, ["register", "--name", "ALPHA?", "--scope", "x", "--owner", "Ember"]);
  expect(r.code).toBe(2);
  expect(r.out).toContain("slug collision");
});

// 7. done marks DONE with SHA
test("done marks crew DONE with the SHA", () => {
  const { kb } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  const r = kbRun(kb, ["done", "--name", "alpha", "--sha", "deadbeef"]);
  expect(r.code).toBe(0);
  const text = readFileSync(kb, "utf8");
  expect(text).toContain("DONE (");
  expect(text).toContain("deadbeef");
});

// 8. done unknown crew exits 2
test("done unknown crew exits 2", () => {
  const { kb } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  const r = kbRun(kb, ["done", "--name", "nope", "--sha", "abc"]);
  expect(r.code).toBe(2);
});

// 9. escaped pipe survives migrate -> crew file -> rollup
test("escaped pipe in scope round-trips exactly", () => {
  const { kb, dir } = setup([BETA_PIPE]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  const crew = readFileSync(join(dir, "fleet", "crews", "beta.md"), "utf8");
  expect(crew).toContain("scope: 'second | piped scope'");
  const text = readFileSync(kb, "utf8");
  expect(text).toContain("| Beta | second \\| piped scope | Ember |");
});

// 10. apostrophe round-trips
test("apostrophe in scope round-trips exactly", () => {
  const { kb } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  expect(kbRun(kb, ["register", "--name", "Delta", "--scope", "Chris's lane", "--owner", "Ember"]).code).toBe(0);
  const text = readFileSync(kb, "utf8");
  expect(text).toContain("| Delta | Chris's lane | Ember |");
});

// 11. double quotes round-trip (incl. old \" file form)
test("double quotes in scope round-trip exactly", () => {
  const { kb, dir } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  expect(kbRun(kb, ["register", "--name", "Epsi", "--scope", 'say "hi"', "--owner", "Ember"]).code).toBe(0);
  const crew = readFileSync(join(dir, "fleet", "crews", "epsi.md"), "utf8");
  expect(crew).toContain(`scope: 'say "hi"'`);
  // old-style file with \" must still decode to a bare quote
  writeFileSync(
    join(dir, "fleet", "crews", "oldq.md"),
    `---\ncrew: 'OldQ'\nscope: 'say \\"hi\\"'\nowner: 'Ember'\nstatus: 'RUNNING'\norder: 99\nregistered: '2026-09-30'\nupdated: '2026-09-30'\n---\n`
  );
  expect(kbRun(kb, ["rollup"]).code).toBe(0);
  const text = readFileSync(kb, "utf8");
  expect(text).toContain('| OldQ | say "hi" | Ember |');
});

// 12. backslash round-trips
test("backslash in scope round-trips exactly", () => {
  const { kb } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  expect(kbRun(kb, ["register", "--name", "Zeta", "--scope", "C:\\x", "--owner", "Ember"]).code).toBe(0);
  const text = readFileSync(kb, "utf8");
  // escCell doubles the backslash so the table stays unambiguous; splitRow restores it
  expect(text).toContain("| Zeta | C:\\\\x | Ember |");
});

// 13. atomic writes leave no temp files behind
test("no .tmp.* files left behind after migrate/register/done/rollup", () => {
  const { kb, dir } = setup([ALPHA]);
  expect(kbRun(kb, ["migrate"]).code).toBe(0);
  expect(kbRun(kb, ["register", "--name", "Eta", "--scope", "s", "--owner", "Ember"]).code).toBe(0);
  expect(kbRun(kb, ["done", "--name", "eta", "--sha", "abc"]).code).toBe(0);
  expect(kbRun(kb, ["rollup"]).code).toBe(0);
  const leftovers: string[] = [];
  for (const d of [dir, join(dir, "fleet", "crews")]) {
    for (const f of readdirSync(d)) if (f.includes(".tmp.")) leftovers.push(join(d, f));
  }
  expect(leftovers).toEqual([]);
});

// 14. lock acquisition fails closed (no flock -> exit 3, KB untouched)
test("missing flock fails closed with exit 3 and no write", () => {
  const { kb } = setup([ALPHA]);
  const before = readFileSync(kb, "utf8");
  const r = kbRun(kb, ["rollup"], { PATH: NOFLOCK_BIN });
  expect(r.code).toBe(3);
  expect(r.out).toMatch(/FATAL|refusing to run unlocked/);
  expect(readFileSync(kb, "utf8")).toBe(before);
});

// 15. migrate slug collision aborts
test("migrate aborts on slug collision", () => {
  const { kb, dir } = setup([
    "| Test Crew | s1 | Ember | RUNNING |",
    "| test-crew | s2 | Ember | RUNNING |",
  ]);
  const r = kbRun(kb, ["migrate"]);
  expect(r.code).toBe(2);
  expect(r.out).toContain("slug collision");
  expect(readdirSync(join(dir, "fleet", "crews")).length).toBe(0);
});
