#!/usr/bin/env bun
// kb-rollup.ts — per-crew KB ownership for §2 Active Crews.
//
// Each crew owns fleet/crews/<slug>.md (YAML frontmatter). The §2 table in
// docs/fleet-knowledgebase.md is a GENERATED rollup between
// <!-- KB-ROLLUP:START --> / <!-- KB-ROLLUP:END --> markers — never hand-edit it.
//
// Why: two agents registering at once used to race on the same table bytes and
// one row silently vanished (2026-09-21: Cinder row lost, squawk-feed-perf DONE
// row clobbered by a stale whole-table rewrite). Per-crew files merge cleanly;
// the table is always regenerable from them, so a lost row is impossible.
//
// Serialization: every invocation re-execs itself under `flock <kb>.lock`, so
// concurrent register/done/rollup calls serialize — the file scan and the write
// happen inside the same lock. No polling, no timers. If flock is unavailable
// the tool FAILS CLOSED (exit 3) — it never runs unlocked.
//
// Writes are atomic: content lands in a same-directory temp file first, then
// rename(2) swaps it into place — a crash mid-write can never leave a torn KB.
//
// Usage:
//   bun kb-rollup.ts [rollup] [--kb PATH]               regenerate §2 table
//   bun kb-rollup.ts migrate [--kb PATH]                one-time: table -> files
//   bun kb-rollup.ts register --name N --scope S --owner W [--kb PATH]
//   bun kb-rollup.ts done --name N --sha SHA [--kb PATH]
//
// Chris's standing correction: everything we write is Bun, not Python.

import { readdirSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const START_MARKER = "<!-- KB-ROLLUP:START -->";
const END_MARKER = "<!-- KB-ROLLUP:END -->";
const HEADER = "| Crew | Scope | Owner / coordinator | Status |";
const SEPARATOR = "|---|---|---|---|";

const GENERATED_NOTE =
  "> **GENERATED TABLE — do not edit by hand.** Source of truth is `fleet/crews/<crew>.md` " +
  "(one file per crew). Regenerate with `bun projects/ops/bin/kb-rollup.ts`. " +
  "Register via `fleet-onboard.sh --register`; mark done via `fleet-onboard.sh --done SHA`.";

const RULE_18 =
  "18. **Per-crew KB ownership (Chris 2026-09-29).** §2 Active Crews is a GENERATED rollup — " +
  "never hand-edit the table. Each crew owns `fleet/crews/<crew>.md` " +
  "(frontmatter: crew/scope/owner/status); register and mark-done through `fleet-onboard.sh`, " +
  "which writes your file and regenerates the rollup via `bun projects/ops/bin/kb-rollup.ts`. " +
  "Concurrent registrations cannot clobber each other: per-crew files merge cleanly and the " +
  "table is always regenerable. If the rollup looks stale, re-run the rollup — never hand-edit §2.";

type Crew = {
  crew: string;
  scope: string;
  owner: string;
  status: string;
  order: number;
  registered: string;
  updated: string;
  file: string;
};

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "crew";
}

// YAML single-quote style: wrap in '...', escape backslash first, then double
// embedded single quotes (Chris's lane -> 'Chris''s lane'). Exact round trip
// with unyq below. Note: old files (pre-2026-09-30) escaped `"` as `\"` —
// unyq still decodes that form, so the 97 migrated crew files keep working.
function yq(v: string): string {
  return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\n/g, "\\n") + "'";
}

// Single-pass decoder (chained replaces get escape ORDER wrong: `\"` vs `\\`
// vs `\n` collide). Handles both the new encoding and the old `\"` form.
function unescapeYq(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === "n") { out += "\n"; i++; }
      else if (n === "\\") { out += "\\"; i++; }
      else if (n === '"') { out += '"'; i++; }
      else { out += ch; }
    } else if (ch === "'" && s[i + 1] === "'") {
      out += "'"; i++;
    } else {
      out += ch;
    }
  }
  return out;
}

function unyq(v: string): string {
  let s = v.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    s = unescapeYq(s.slice(1, -1));
  }
  return s;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = text.match(FRONTMATTER_RE);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z0-9_]+):\s(.*)$/);
    if (!kv) continue;
    out[kv[1]] = unyq(kv[2]);
  }
  return out;
}

/** Split a markdown table row on UNESCAPED pipes; unescape \| and \\ in cells. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      cur += ch + line[i + 1];
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim().replace(/\\\|/g, "|").replace(/\\\\/g, "\\"));
}

function escCell(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function dateInStatus(status: string): string | null {
  const m = status.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function crewsDirFor(kbPath: string): string {
  // Crews live at the ESTATE ROOT (fleet/crews), not next to the KB doc.
  // Walk upward from the KB until a fleet/crews dir is found.
  let dir = dirname(kbPath);
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, "fleet", "crews");
    if (existsSync(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(dirname(kbPath), "fleet", "crews");
}

/** Atomic write: temp file in the SAME directory, then rename(2) into place. */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.tmp.${process.pid}`);
  await Bun.write(tmp, content);
  renameSync(tmp, path);
}

async function readCrews(kbPath: string): Promise<Crew[]> {
  const dir = crewsDirFor(kbPath);
  if (!existsSync(dir)) return [];
  const crews: Crew[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const text = await Bun.file(join(dir, f)).text();
    const fm = parseFrontmatter(text);
    if (!fm.crew) continue;
    crews.push({
      crew: fm.crew,
      scope: fm.scope ?? "",
      owner: fm.owner ?? "",
      status: fm.status ?? "",
      order: fm.order ? parseInt(fm.order, 10) : 1e9,
      registered: fm.registered ?? "",
      updated: fm.updated ?? "",
      file: f,
    });
  }
  crews.sort((a, b) => a.order - b.order || a.crew.localeCompare(b.crew));
  return crews;
}

function renderTable(crews: Crew[]): string[] {
  const lines = [HEADER, SEPARATOR];
  for (const c of crews) {
    lines.push(`| ${escCell(c.crew)} | ${escCell(c.scope)} | ${escCell(c.owner)} | ${escCell(c.status)} |`);
  }
  return lines;
}

function crewFileBody(c: Omit<Crew, "file">): string {
  return (
    `---\n` +
    `crew: ${yq(c.crew)}\n` +
    `scope: ${yq(c.scope)}\n` +
    `owner: ${yq(c.owner)}\n` +
    `status: ${yq(c.status)}\n` +
    `order: ${c.order}\n` +
    `registered: ${yq(c.registered)}\n` +
    `updated: ${yq(c.updated)}\n` +
    `---\n\n` +
    `# ${c.crew}\n\n` +
    `Per-crew ownership record. Edit the frontmatter above; the §2 table in\n` +
    `\`docs/fleet-knowledgebase.md\` is generated from these files — do not edit it by hand.\n` +
    `After changing this file, run \`bun projects/ops/bin/kb-rollup.ts\`.\n`
  );
}

async function writeCrewFile(dir: string, c: Omit<Crew, "file">): Promise<string> {
  const file = slug(c.crew) + ".md";
  await atomicWrite(join(dir, file), crewFileBody(c));
  return file;
}

async function cmdRollup(kbPath: string): Promise<void> {
  const crews = await readCrews(kbPath);
  const text = await Bun.file(kbPath).text();
  const lines = text.split("\n");
  const si = lines.indexOf(START_MARKER);
  const ei = lines.indexOf(END_MARKER);
  if (si === -1 || ei === -1 || ei < si) {
    console.error(`kb-rollup: markers not found in ${kbPath} — run 'migrate' first.`);
    process.exit(2);
  }
  const table = renderTable(crews);
  const next = [...lines.slice(0, si + 1), ...table, ...lines.slice(ei)];
  const out = next.join("\n");
  if (out === text) {
    console.log(`kb-rollup: §2 up-to-date (${crews.length} crews).`);
    return;
  }
  await atomicWrite(kbPath, out);
  console.log(`kb-rollup: §2 regenerated (${crews.length} crews).`);
}

async function cmdMigrate(kbPath: string): Promise<void> {
  const dir = crewsDirFor(kbPath);
  mkdirSync(dir, { recursive: true });
  const text = await Bun.file(kbPath).text();
  const lines = text.split("\n");

  // §2 section bounds
  const secStart = lines.findIndex((l) => l.startsWith("## 2. Active crews"));
  const secEnd = lines.findIndex((l, i) => i > secStart && l.startsWith("## 3."));
  if (secStart === -1 || secEnd === -1) {
    console.error("kb-rollup: cannot find §2 section bounds.");
    process.exit(2);
  }

  // Collect existing table rows (header + data) inside §2.
  const rows: { crew: string; scope: string; owner: string; status: string }[] = [];
  let firstTableLine = -1;
  let lastTableLine = -1;
  for (let i = secStart; i < secEnd; i++) {
    if (/^\|/.test(lines[i])) {
      if (firstTableLine === -1) firstTableLine = i;
      lastTableLine = i;
      const cells = splitRow(lines[i]);
      if (cells.length === 4 && cells[0] !== "Crew" && !/^---+$/.test(cells[0])) {
        rows.push({ crew: cells[0], scope: cells[1], owner: cells[2], status: cells[3] });
      }
    }
  }
  if (firstTableLine === -1) {
    console.error("kb-rollup: no §2 table found to migrate.");
    process.exit(2);
  }
  console.log(`kb-rollup: migrating ${rows.length} §2 rows -> ${dir}`);

  // Pre-flight: resolve every slug and abort on ANY collision BEFORE writing
  // anything — a failed migration must not leave half-written crew files.
  const seen = new Set<string>();
  for (const r of rows) {
    const file = slug(r.crew) + ".md";
    if (seen.has(file)) {
      console.error(`kb-rollup: slug collision for crew '${r.crew}' — aborting before any write.`);
      process.exit(2);
    }
    seen.add(file);
  }

  // Write one file per crew (idempotent: skip existing slugs).
  let order = 0;
  for (const r of rows) {
    order += 1;
    const file = slug(r.crew) + ".md";
    if (existsSync(join(dir, file))) {
      console.log(`  skip (exists): ${file}`);
      continue;
    }
    const reg = dateInStatus(r.status) ?? today();
    await writeCrewFile(dir, {
      crew: r.crew,
      scope: r.scope,
      owner: r.owner,
      status: r.status,
      order,
      registered: reg,
      updated: today(),
    });
  }

  // Replace the old table span with markers + generated table.
  const crews = await readCrews(kbPath);
  const block = [START_MARKER, ...renderTable(crews), END_MARKER];
  const next = [...lines.slice(0, firstTableLine), ...block, ...lines.slice(lastTableLine + 1)];

  // Insert the GENERATED note after the §2 rule line (once).
  const ruleIdx = next.findIndex((l) => l.includes("**Rule: check this table"));
  if (ruleIdx !== -1 && !next.slice(ruleIdx, ruleIdx + 4).some((l) => l.includes("GENERATED TABLE"))) {
    next.splice(ruleIdx + 1, 0, "", GENERATED_NOTE);
  }

  // Append standing rule 18 (once), after rule 17.
  if (!next.some((l) => l.includes("Per-crew KB ownership"))) {
    const r17 = next.findIndex((l) => /^\d+\.\s+\*\*Cell workspace = tmp/.test(l));
    const anchor =
      r17 !== -1 ? r17 + 1 : next.findIndex((l) => l.startsWith("**Oracle-as-approval"));
    if (anchor !== -1) next.splice(anchor, 0, "", RULE_18);
  }

  await atomicWrite(kbPath, next.join("\n"));
  console.log(`kb-rollup: §2 is now a generated rollup (${crews.length} crews).`);
}

async function cmdRegister(kbPath: string, name: string, scope: string, owner: string): Promise<void> {
  const dir = crewsDirFor(kbPath);
  mkdirSync(dir, { recursive: true });
  const crews = await readCrews(kbPath);
  const lname = name.toLowerCase();
  const dup = crews.find((c) => c.crew.toLowerCase() === lname);
  if (dup) {
    console.log(`kb-rollup: '${name}' is already registered (fleet/crews/${dup.file}) — not duplicating.`);
    return;
  }
  const file = slug(name) + ".md";
  if (existsSync(join(dir, file))) {
    console.error(`kb-rollup: slug collision — ${file} exists for a different crew name. Pick a distinct --name.`);
    process.exit(2);
  }
  const t = today();
  const maxOrder = crews.reduce((m, c) => Math.max(m, c.order), 0);
  await writeCrewFile(dir, {
    crew: name,
    scope: scope.slice(0, 140),
    owner,
    status: `RUNNING (${t})`,
    order: maxOrder + 1,
    registered: t,
    updated: t,
  });
  console.log(`kb-rollup: registered '${name}' -> fleet/crews/${file}`);
  await cmdRollup(kbPath);
}

async function cmdDone(kbPath: string, name: string, sha: string): Promise<void> {
  const dir = crewsDirFor(kbPath);
  const crews = await readCrews(kbPath);
  const lname = name.toLowerCase();
  const c = crews.find((y) => y.crew.toLowerCase() === lname);
  if (!c) {
    console.error(`kb-rollup: '${name}' has no per-crew file to mark DONE.`);
    process.exit(2);
  }
  const t = today();
  const path = join(dir, c.file);
  const text = await Bun.file(path).text();
  const m = text.match(FRONTMATTER_RE);
  if (!m || m.index === undefined) {
    console.error(`kb-rollup: '${c.file}' has no parseable frontmatter — refusing to rewrite.`);
    process.exit(2);
  }
  const fm = parseFrontmatter(text);
  fm.status = `DONE (${t}) — ${sha}`;
  fm.updated = t;
  const rest = text.slice(m.index + m[0].length);
  const head =
    `---\n` +
    `crew: ${yq(fm.crew ?? c.crew)}\n` +
    `scope: ${yq(fm.scope ?? c.scope)}\n` +
    `owner: ${yq(fm.owner ?? c.owner)}\n` +
    `status: ${yq(fm.status)}\n` +
    `order: ${fm.order ?? c.order}\n` +
    `registered: ${yq(fm.registered ?? c.registered)}\n` +
    `updated: ${yq(fm.updated)}\n` +
    `---`;
  await atomicWrite(path, head + rest);
  console.log(`kb-rollup: marked DONE '${name}' (${sha})`);
  await cmdRollup(kbPath);
}

function usage(): void {
  console.log(`usage:
  bun kb-rollup.ts [rollup] [--kb PATH]
  bun kb-rollup.ts migrate [--kb PATH]
  bun kb-rollup.ts register --name N --scope S --owner W [--kb PATH]
  bun kb-rollup.ts done --name N --sha SHA [--kb PATH]`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let cmd = "rollup";
  let kb = "";
  let name = "", scope = "", owner = "", sha = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "rollup" || a === "migrate" || a === "register" || a === "done") cmd = a;
    else if (a === "--kb") kb = args[++i] ?? "";
    else if (a === "--name") name = args[++i] ?? "";
    else if (a === "--scope") scope = args[++i] ?? "";
    else if (a === "--owner") owner = args[++i] ?? "";
    else if (a === "--sha") sha = args[++i] ?? "";
    else if (a === "-h" || a === "--help") { usage(); return; }
    else { console.error(`unknown arg: ${a}`); usage(); process.exit(2); }
  }
  if (!kb) {
    // Walk up from the script dir: the KB lives at <estate>/docs/fleet-knowledgebase.md,
    // but this script now runs from inside the nested ranch repo (projects/ retirement),
    // where git toplevel stops at ranch/. Probe upward instead of trusting git.
    let dir = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 8; i++) {
      const cand = join(dir, "docs", "fleet-knowledgebase.md");
      if (existsSync(cand)) { kb = cand; break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!kb) { console.error("kb-rollup: cannot find fleet-knowledgebase.md upward; pass --kb PATH."); process.exit(2); }
  }
  if (!existsSync(kb)) { console.error(`kb-rollup: KB not found at ${kb}`); process.exit(2); }

  // Serialize all invocations through flock so concurrent register/done/rollup
  // calls can't interleave their read-modify-write cycles. The file scan and
  // the write both happen inside the lock (in the child process).
  // FAIL CLOSED: if flock is unavailable or the lock can't be taken, exit 3 —
  // never run unlocked, never silently serialize-nothing.
  if (!process.env.KB_ROLLUP_LOCKED) {
    const lockPath = kb + ".lock";
    let child: ReturnType<typeof Bun.spawnSync>;
    try {
      child = Bun.spawnSync(
        ["flock", lockPath, "bun", Bun.main, ...args],
        {
          env: { ...process.env, KB_ROLLUP_LOCKED: "1" },
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }
      );
    } catch (e) {
      console.error(`kb-rollup: FATAL — flock unavailable (${(e as Error)?.message ?? e}); refusing to run unlocked.`);
      process.exit(3);
    }
    process.exit(child.exitCode ?? 1);
  }

  if (cmd === "migrate") await cmdMigrate(kb);
  else if (cmd === "rollup") await cmdRollup(kb);
  else if (cmd === "register") {
    if (!name || !scope || !owner) { console.error("register needs --name, --scope, --owner"); process.exit(2); }
    await cmdRegister(kb, name, scope, owner);
  } else if (cmd === "done") {
    if (!name || !sha) { console.error("done needs --name, --sha"); process.exit(2); }
    await cmdDone(kb, name, sha);
  }
}
main().catch((e) => { console.error(`kb-rollup: ${e?.message ?? e}`); process.exit(1); });
