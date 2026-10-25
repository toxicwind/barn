#!/usr/bin/env bun
// estate-map.ts — generate the estate map from reality, not from memory.
//
// WHY: every agent that joins the fleet re-runs the same discovery dance —
// `ls` the home dir, grep the KB for a path, find it dead, find a second copy,
// probe a port, discover the copy is stale. That is ~15 tool calls to answer
// "where does herd actually live". This tool answers it in one read.
//
// The map is GENERATED. Never hand-edit docs/estate-map.{json,md}; they are
// rebuilt from the live filesystem, git metadata, config/ports.env,
// pitchfork.toml and the agent's own ~/.tau config. A hand-edit is a lie by
// the next run.
//
// It also DRIFTS LOUDLY. The defects that cost the most time are all silent
// ones: a stale duplicate checkout of a live repo, a config path that stopped
// existing during a flattening, a port claimed in the SSOT with nothing behind
// it. Those land in `drift[]` and `--check` exits non-zero.
//
// Usage:
//   estate-map.ts                 regenerate docs/estate-map.{json,md}
//   estate-map.ts --check         read-only drift report, exit 1 on drift
//   estate-map.ts --check --json  machine-readable drift only
//   estate-map.ts --brief         print the agent brief to stdout, write nothing
//
// Never prints secret VALUES. Credentials are reported as present/absent only.
//
// Part of ranch/ops/bin/ (toxicwind/estate-scripts-projects).

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, dirname, resolve as resolvePath, basename } from "node:path";
import { parse as parseYAML } from "yaml";

const SOV = process.env.SOV ?? "/home/toxic/estate";
const HOME = process.env.HOME ?? "/home/toxic";
const TAU_DIR = process.env.PI_CONFIG_DIR ?? join(HOME, ".tau");
const OUT_JSON = join(SOV, "docs/estate-map.json");
const OUT_MD = join(SOV, "docs/estate-map.md");

// Repos that answer "where does X actually live". A repo with no path on this
// list is not part of the map; add it when it becomes load-bearing.
const REPO_CANDIDATES = [
  { name: "estate", path: SOV, role: "control plane: pitchfork.toml, config/, bin/, bridge/, agents/, docs/, projects/" },
  { name: "ranch", path: join(SOV, "ranch"), role: "the inference estate monorepo: herd, flock, gatehouse, squawk, oracle, and the mesh provider catalog" },
  { name: "ranch", path: join(HOME, "ranch"), role: "SECOND checkout of toxicwind/ranch — duplicate, not the daemon target" },
  { name: "tau-config", path: TAU_DIR, role: "coding-agent engine config (config.yml, models.yml, model-router.json, mcp.json)" },
];

type Drift = { severity: "high" | "medium" | "low"; kind: string; detail: string; fix: string };

export type RepoEntry = {
  name: string;
  path: string;
  role: string;
  exists: boolean;
  isRepo: boolean;
  gitKind: "none" | "nested" | "submodule";
  remote: string | null;
  head: string | null;
  committedAt: string | null;
  dirtyPaths: number;
};

export type PortEntry = {
  port: number;
  ssot: string | null;
  daemons: string[];
  live: boolean;
  addr: string | null;
  process: string | null;
  pid: number | null;
};

export type PluginLink = { name: string; source: string; resolved: string; exists: boolean };
export type ProviderLink = { key: string; baseUrl: string };
export type McpLink = { name: string; target: string };
export type CredLink = { name: string; present: boolean };

export type AgentLinks = {
  plugins: PluginLink[];
  providers: ProviderLink[];
  selectors: string[];
  mcpServers: McpLink[];
  creds: CredLink[];
};

export type EstateMap = {
  generatedAt: string;
  host: { hostname: string; home: string; estateRoot: string; tauConfigDir: string };
  repos: RepoEntry[];
  ports: PortEntry[];
  agent: AgentLinks;
  drift: Drift[];
};

function git(dir: string, args: string[]): string | null {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return null;
  return p.stdout.toString().trim();
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// YAML comes off disk from hand-edited configs: untrusted shape. Every read
// site narrows through these guards instead of asserting a type it never had.
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

function loadYaml(path: string): unknown {
  const raw = readText(path);
  if (raw === null) return null;
  try {
    return parseYAML(raw);
  } catch {
    return null;
  }
}

// --- live TCP listeners ------------------------------------------------------
// `ss -ltnp` as the owning user: every daemon in this estate runs as `toxic`,
// so we see process names without root. Unattributable sockets stay anonymous.
type Listener = { port: number; addr: string; process: string | null; pid: number | null };

function liveListeners(): Listener[] {
  const p = Bun.spawnSync(["ss", "-ltnpH"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return [];
  const out: Listener[] = [];
  for (const line of p.stdout.toString().split("\n")) {
    const m = line.match(/LISTEN\s+\d+\s+\d+\s+(\S+?):(\d+)\s/);
    if (!m) continue;
    const port = Number(m[2]);
    if (!Number.isFinite(port)) continue;
    const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    out.push({ port, addr: m[1], process: proc ? proc[1] : null, pid: proc ? Number(proc[2]) : null });
  }
  return out;
}

// --- ports: SSOT (config/ports.env) ------------------------------------------
// SSOT names the SERVICE; pitchfork.toml names the DAEMON; `ss` names the
// PROCESS. A port can be claimed by one and dead in the others — that gap is
// exactly what the map exists to surface.
function portsFromSov(): Map<string, string> {
  const out = new Map<string, string>();
  const raw = readText(join(SOV, "config/ports.env"));
  if (raw === null) return out;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Z0-9_]+)=(\d+)/);
    if (!m) continue;
    const owner = t.match(/#\s*owner:\s*(.+)$/);
    out.set(m[2], owner ? `${m[1]} — ${owner[1].trim()}` : m[1]);
  }
  return out;
}

function pitchforkClaims(): { name: string; port: number | null; run: string; dir: string }[] {
  const raw = readText(join(SOV, "pitchfork.toml"));
  if (raw === null) return [];
  const out: { name: string; port: number | null; run: string; dir: string }[] = [];
  let cur: { name: string; port: number | null; run: string; dir: string } | null = null;
  for (const line of raw.split("\n")) {
    const sec = line.match(/^\[daemons\.([^\]]+)\]/);
    if (sec) {
      if (cur) out.push(cur);
      cur = { name: sec[1], port: null, run: "", dir: "" };
      continue;
    }
    if (line.startsWith("[") && cur) {
      out.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const port = line.match(/^\s*(?:ready_)?port\s*=\s*"?(\d+)"?/);
    if (port) cur.port = Number(port[1]);
    const run = line.match(/^\s*run\s*=\s*"(.*)"/);
    if (run) cur.run = run[1];
    const dir = line.match(/^\s*dir\s*=\s*"(.*)"/);
    if (dir) cur.dir = dir[1];
  }
  if (cur) out.push(cur);
  return out;
}

// --- the agent's own wiring (the question that started this) -----------------
// What does the coding agent actually point at? Every baseUrl and plugin
// source is resolved against $HOME, because tau's config uses `./`-relative
// paths — an unresolvable source is a plugin that silently never loads.
function agentLinks(drift: Drift[]): AgentLinks {
  const plugins: PluginLink[] = [];
  const providers: ProviderLink[] = [];
  const selectors: string[] = [];
  const mcpServers: McpLink[] = [];
  const creds: CredLink[] = [];

  const cfg = loadYaml(join(TAU_DIR, "config.yml"));

  // plugins: [{ name, source, ... }] with ./ -relative sources.
  const pluginList = Array.isArray(asRecord(cfg)?.plugins) ? (asRecord(cfg)!.plugins as unknown[]) : [];
  for (const entry of pluginList) {
    const p = asRecord(entry);
    const name = asString(p?.name);
    if (name === null) continue;
    const src = asString(p?.source) ?? "";
    const resolved = src.startsWith("./") ? resolvePath(HOME, src) : src;
    const exists = resolved !== "" && existsSync(resolved);
    plugins.push({ name, source: src, resolved, exists });
    if (src !== "" && !exists) {
      drift.push({
        severity: "high",
        kind: "agent-plugin-source-dead",
        detail: `tau plugin '${name}' source ${src} → ${resolved} does not exist`,
        fix: `point ${name}.source at the live path in docs/estate-map.json repos[]`,
      });
    }
  }

  // providers: any config node carrying a baseUrl is a routable target. The
  // walk is iterative and typed at `unknown` — config shape is not ours.
  const walkProviders = (root: unknown) => {
    const stack: { node: unknown; path: string[] }[] = [{ node: root, path: [] }];
    while (stack.length > 0) {
      const { node, path } = stack.pop()!;
      if (Array.isArray(node)) {
        node.forEach((v, i) => stack.push({ node: v, path: [...path, String(i)] }));
        continue;
      }
      const rec = asRecord(node);
      if (rec === null) continue;
      for (const [key, value] of Object.entries(rec)) {
        const url = asString(value);
        if (key === "baseUrl" && url !== null) providers.push({ key: path.join("."), baseUrl: url });
        else stack.push({ node: value, path: [...path, key] });
      }
    }
  };
  walkProviders(cfg);

  // model-router.json selectors carry the provider prefix in `a/b/model`.
  const profiles = asRecord(asRecord(loadYaml(join(TAU_DIR, "model-router.json")))?.profiles) ?? {};
  for (const prof of Object.values(profiles)) {
    const sel = asString(asRecord(prof)?.selector);
    if (sel === null || sel === "") continue;
    const provider = sel.split("/")[0];
    if (!selectors.includes(provider)) selectors.push(provider);
  }

  // mcp.json — tool servers the agent can reach.
  const servers = asRecord(asRecord(loadYaml(join(TAU_DIR, "mcp.json")))?.mcpServers) ?? {};
  for (const [name, def] of Object.entries(servers)) {
    const rec = asRecord(def);
    const url = asString(rec?.url);
    if (url !== null) {
      mcpServers.push({ name, target: url });
      continue;
    }
    const command = asString(rec?.command);
    if (command === null) continue;
    const args = Array.isArray(rec?.args) ? rec.args.map((a) => asString(a) ?? "") : [];
    mcpServers.push({ name, target: [command, ...args].join(" ") });
  }

  // Credentials: PRESENCE ONLY. The value is never read, let alone emitted.
  creds.push({
    name: "flock client key",
    present: (() => {
      try {
        return statSync(join(TAU_DIR, "flock.key")).size > 0;
      } catch {
        return false;
      }
    })(),
  });
  return { plugins, providers, selectors, mcpServers, creds };
}

function build(): EstateMap {
  const drift: Drift[] = [];
  const now = new Date().toISOString();

  // --- repos -----------------------------------------------------------------
  const repos = REPO_CANDIDATES.map((c) => {
    const exists = existsSync(c.path);
    const gitDir = join(c.path, ".git");
    const isRepo = existsSync(gitDir);
    // A submodule checkout has .git as a FILE; a nested checkout has a
    // DIRECTORY. Confusing the two is how a "submodule" silently stops being
    // one, so the distinction is recorded rather than assumed.
    let gitKind: "none" | "nested" | "submodule" = "none";
    if (isRepo) {
      try {
        gitKind = statSync(gitDir).isDirectory() ? "nested" : "submodule";
      } catch {
        gitKind = "none";
      }
    }
    return {
      name: c.name,
      path: c.path,
      role: c.role,
      exists,
      isRepo,
      gitKind,
      remote: isRepo ? git(c.path, ["remote", "get-url", "origin"]) : null,
      head: isRepo ? git(c.path, ["rev-parse", "--short", "HEAD"]) : null,
      committedAt: isRepo ? git(c.path, ["log", "-1", "--format=%cI"]) : null,
      dirtyPaths: isRepo ? (git(c.path, ["status", "--porcelain"]) ?? "").split("\n").filter(Boolean).length : 0,
    };
  });

  // P2: two checkouts of one remote means every edit can silently land in the
  // tree nothing runs. The stale one is the trap.
  const byRemote = new Map<string, typeof repos>();
  for (const r of repos) {
    if (!r.isRepo || !r.remote) continue;
    const key = r.remote.replace(/\.git$/, "");
    if (!byRemote.has(key)) byRemote.set(key, []);
    byRemote.get(key)!.push(r);
  }
  for (const [remote, group] of byRemote) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (b.committedAt ?? "").localeCompare(a.committedAt ?? ""));
    const newest = sorted[0];
    for (const other of sorted.slice(1)) {
      drift.push({
        severity: "high",
        kind: "duplicate-checkout",
        detail: `${remote} checked out ${group.length}x — newest ${newest.head} @ ${newest.path}; ${other.path} @ ${other.head} (${other.committedAt})`,
        fix: `keep ${newest.path}; delete or archive ${other.path}`,
      });
    }
  }
  for (const r of repos) {
    if (!r.exists) {
      drift.push({ severity: "medium", kind: "repo-missing", detail: `${r.name}: ${r.path} absent`, fix: "update REPO_CANDIDATES in estate-map.ts" });
    }
  }

  // --- ports -----------------------------------------------------------------
  const ssot = portsFromSov();
  const claims = pitchforkClaims();
  const live = liveListeners();
  const liveByPort = new Map(live.map((l) => [l.port, l]));
  const claimByPort = new Map<number, string[]>();
  for (const c of claims) {
    if (c.port === null) continue;
    if (!claimByPort.has(c.port)) claimByPort.set(c.port, []);
    claimByPort.get(c.port)!.push(c.name);
  }

  const ports = [...new Set([...ssot.keys(), ...claimByPort.keys(), ...liveByPort.keys()])]
    .map((p) => Number(p))
    .sort((a, b) => a - b)
    .map((port) => {
      const l = liveByPort.get(port) ?? null;
      return {
        port,
        ssot: ssot.get(String(port)) ?? null,
        daemons: claimByPort.get(port) ?? [],
        live: l !== null,
        addr: l?.addr ?? null,
        process: l?.process ?? null,
        pid: l?.pid ?? null,
      };
    });

  // An SSOT entry with nothing listening is a claim, not a service. High value:
  // this is how "the router is down" stays invisible until a request fails.
  for (const p of ports) {
    if (p.ssot && !p.live && p.daemons.length === 0) {
      drift.push({
        severity: "medium",
        kind: "port-ssot-dead",
        detail: `ports.env claims ${p.port} (${p.ssot}) — no listener, no pitchfork daemon claims it`,
        fix: "start the daemon or drop the SSOT entry",
      });
    }
  }

  // pitchfork daemons whose run/dir path does not exist cannot have started.
  for (const c of claims) {
    for (const p of [c.run, c.dir]) {
      const m = typeof p === "string" ? p.match(/(\/home\/toxic\/[A-Za-z0-9_./-]+)/) : null;
      if (!m || m[1] === ".") continue;
      if (existsSync(m[1])) continue;
      drift.push({
        severity: "high",
        kind: "daemon-path-dead",
        detail: `pitchfork daemon '${c.name}' references ${m[1]} — absent`,
        fix: `update pitchfork.toml [daemons.${c.name}]`,
      });
      break;
    }
  }

  // --- the agent's wiring ----------------------------------------------------
  const links = agentLinks(drift);

  // A selected provider prefix with NO reachable baseUrl anywhere in the config
  // is the exact failure that started this: the engine asks for `flock/...` or
  // `herd/...` and nothing in the wiring answers.
  const knownUrls = new Set(links.providers.map((p) => p.baseUrl));
  const modelsRaw = readText(join(TAU_DIR, "models.yml")) ?? "";
  for (const m of modelsRaw.matchAll(/baseUrl:\s*(\S+)/g)) knownUrls.add(m[1]);
  const linkedPorts = new Set<string>();
  for (const u of knownUrls) {
    const m = u.match(/:(\d{4,5})\b/);
    if (m) linkedPorts.add(m[1]);
  }
  const servicePorts = new Map(ports.filter((p) => p.live).map((p) => [String(p.port), p]));
  for (const provider of links.selectors) {
    if (servicePorts.has(provider)) continue; // provider name == a service name, not a port
    if (linkedPorts.size === 0) continue;
    // A prefix is wired if SOME live port answers under a config key of the
    // same name, or the prefix is declared as a provider block in models.yml.
    const declared = new RegExp(`^\\s{2}${provider}:`, "m").test(modelsRaw);
    if (declared) continue;
    if ([...knownUrls].some((u) => u.includes(provider))) continue;
    drift.push({
      severity: "medium",
      kind: "selector-provider-unwired",
      detail: `model-router selects '${provider}/…' but no provider block or baseUrl in ~/.tau maps that prefix to a live port`,
      fix: `add a '${provider}:' provider block with a live baseUrl, or drop the selector`,
    });
  }

  return {
    generatedAt: now,
    host: { hostname: Bun.spawnSync(["hostname"], { stdout: "pipe" }).stdout.toString().trim(), home: HOME, estateRoot: SOV, tauConfigDir: TAU_DIR },
    repos,
    ports,
    agent: links,
    drift,
  };
}

// --- renderers ---------------------------------------------------------------
function renderMarkdown(map: EstateMap): string {
  const L: string[] = [];
  const high = map.drift.filter((d) => d.severity === "high");
  const other = map.drift.filter((d) => d.severity !== "high");

  L.push("# Estate Map");
  L.push("");
  L.push("**GENERATED FILE — do not hand-edit.** Rebuild with `bun projects/ops/bin/estate-map.ts`;");
  L.push("drift-check with `bun projects/ops/bin/estate-map.ts --check`.");
  L.push("");
  L.push(`Generated ${map.generatedAt} on \`${map.host.hostname}\`. Estate root \`${map.host.estateRoot}\`.`);
  L.push("");
  L.push("> **One word, one referent.** `estate/` is the control-plane tree. `ranch/` is the inference");
  L.push("> monorepo. The agent engine config lives in `~/.tau`. Every daemon runs out of the path");
  L.push("> pitchfork names — check `repos[]` below before editing anything.");
  L.push("");

  L.push("## Where things actually live");
  L.push("");
  L.push("| Repo | Path | Remote | Head | Committed | Dirty | Checkout kind |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of map.repos) {
    L.push(
      `| ${r.exists ? "🟢" : "🔴"} **${r.name}** | \`${r.path}\` | ${r.remote ?? "—"} | ${r.head ?? "—"} | ${(r.committedAt ?? "—").slice(0, 19)} | ${r.dirtyPaths} | ${r.gitKind} |`,
    );
  }
  L.push("");
  for (const r of map.repos) L.push(`- **${r.name}** (\`${r.path}\`) — ${r.role}`);
  L.push("");

  L.push("## Live services");
  L.push("");
  L.push("| Port | SSOT | Pitchfork daemon | Live | Process |");
  L.push("|---|---|---|---|---|");
  for (const p of map.ports) {
    if (!p.live && !p.ssot && p.daemons.length === 0) continue;
    L.push(
      `| ${p.port} | ${p.ssot ? p.ssot.split(" — ")[0] : "—"} | ${p.daemons.join(", ") || "—"} | ${p.live ? "🟢" : "⚪️"} | ${p.process ?? "—"} |`,
    );
  }
  L.push("");

  L.push("## Agent wiring");
  L.push("");
  L.push(`Config dir: \`${map.host.tauConfigDir}\``);
  L.push("");
  L.push("| Plugin | Source | Resolved | Exists |");
  L.push("|---|---|---|---|");
  for (const p of map.agent.plugins) {
    L.push(`| ${p.name} | \`${p.source}\` | \`${p.resolved}\` | ${p.exists ? "🟢" : "🔴 DEAD"} |`);
  }
  L.push("");
  L.push("| Provider key | baseUrl |");
  L.push("|---|---|");
  for (const p of map.agent.providers) L.push(`| \`${p.key}\` | \`${p.baseUrl}\` |`);
  L.push("");
  L.push(`- **Model-router selectors use:** ${map.agent.selectors.map((s) => `\`${s}\``).join(", ") || "none"}`);
  L.push(`- **MCP servers:** ${map.agent.mcpServers.map((s) => `\`${s.name}\` → ${s.target || "(inline)"}`).join(" · ") || "none"}`);
  L.push(`- **Credentials present:** ${map.agent.creds.map((c) => `${c.name}: ${c.present ? "yes" : "no"}`).join(" · ")}`);
  L.push("");

  L.push("## Drift");
  L.push("");
  if (map.drift.length === 0) {
    L.push("🟢 No drift. Every plugin source, daemon path, and SSOT port claim resolves.");
  } else {
    L.push(`${map.drift.length} finding(s) — **${high.length} high.** These are silent defects: each one is`);
    L.push("something that looks wired and is not.");
    L.push("");
    L.push("| Sev | Kind | Detail | Fix |");
    L.push("|---|---|---|---|");
    for (const d of [...high, ...other]) {
      L.push(`| ${d.severity} | \`${d.kind}\` | ${d.detail} | ${d.fix} |`);
    }
  }
  L.push("");
  return L.join("\n");
}

// --- write (atomic, never torn) ----------------------------------------------
function writeAtomic(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function main(): number {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const brief = args.includes("--brief");
  const asJson = args.includes("--json");
  const quiet = args.includes("--quiet");

  const map = build();
  const json = JSON.stringify(map, null, 2) + "\n";

  if (check) {
    if (asJson) {
      process.stdout.write(json);
    } else if (!quiet) {
      if (map.drift.length === 0) {
        console.log("🟢 estate-map: no drift");
      } else {
        for (const d of map.drift) console.log(`${d.severity.toUpperCase()} ${d.kind}: ${d.detail}\n  fix: ${d.fix}`);
        console.log(`\n${map.drift.length} finding(s)`);
      }
    }
    return map.drift.length === 0 ? 0 : 1;
  }

  if (brief) {
    process.stdout.write(renderMarkdown(map));
    return 0;
  }

  writeAtomic(OUT_JSON, json);
  writeAtomic(OUT_MD, renderMarkdown(map));
  if (!quiet) {
    console.log(`wrote ${OUT_JSON}`);
    console.log(`wrote ${OUT_MD}`);
    console.log(`repos: ${map.repos.filter((r) => r.exists).length}/${map.repos.length} present · live ports: ${map.ports.filter((p) => p.live).length} · drift: ${map.drift.length}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main());

export { build, renderMarkdown, portsFromSov, pitchforkClaims, liveListeners, agentLinks, REPO_CANDIDATES };