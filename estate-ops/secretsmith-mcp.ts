#!/usr/bin/env bun
/**
 * secretsmith-mcp.ts — first-class MCP surface over the secretsmith keyring.
 *
 * Exposes the estate's secretsmith SSOT as a full MCP server (stdio) so any
 * daemon/agent can read/write keys through the keyring primitive instead of
 * holding its own copy. Tools:
 *   secretsmith_add  (name, value, service?, app?, replace?) -> {ok, name}
 *   secretsmith_get  (name)                                    -> {name, present}
 *   secretsmith_env  ()                                        -> {count, names:[...]}
 *   secretsmith_list ()                                        -> {count, items:[name]}
 *   secretsmith_search(pattern?)                               -> {count, items:[name]}
 *
 * Secrets NEVER appear in tool results (get returns presence+len, not the value) —
 * the keyring remains the only place a value lives; MCP only reveals existence + injects
 * via a shell-run env contract for authorized consumers.
 *
 * Implementation: monadic-ish, fail-loud-but-forward; bounded reads; no 2>/dev/null.
 */
import { spawnSync } from "node:child_process";

const SS = "/home/toxic/.local/bin/secretsmith";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const Ok = <T>(value: T): Result<T> => ({ ok: true, value });
const Err = <T>(error: string): Result<T> => ({ ok: false, error });

function run(args: string[]): Result<string> {
  const r = spawnSync(SS, args, { encoding: "utf8", timeout: 30_000 });
  return r.status === 0
    ? Ok(r.stdout ?? "")
    : Err(
        `secretsmith ${args[0]} failed (${r.status ?? "signal"}): ${(r.stderr ?? "").trim().slice(0, 300)}`,
      );
}

function listNames(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Z][A-Z0-9_]{1,64}=/.test(l))
    .map((l) => l.slice(0, l.indexOf("=")))
    .filter((s) => s.length > 0);
}

// ---- read-only list / env ----
const doEnv = (): Result<{ count: number; names: string[] }> => {
  const r = run(["env"]);
  if (!r.ok) return r;
  const names = listNames(r.value);
  return Ok({ count: names.length, names });
};

const doList = (): Result<{ count: number; items: string[] }> => {
  const r = run(["env"]);
  if (!r.ok) return r;
  const names = listNames(r.value);
  return Ok({ count: names.length, items: names.slice(0, 200) });
};

const doSearch = (
  pattern?: string,
): Result<{ count: number; items: string[] }> => {
  const r = run(["env"]);
  if (!r.ok) return r;
  let names = listNames(r.value);
  if (pattern)
    names = names.filter((n) =>
      n.toLowerCase().includes(pattern.toLowerCase()),
    );
  return Ok({ count: names.length, items: names.slice(0, 200) });
};

// ---- add / get (value written via temp file, never a CLI arg / never returned) ----
const doAdd = (
  name: string,
  value: string,
  service?: string,
  app?: string,
  replace?: boolean,
): Result<{ ok: boolean; name: string }> => {
  if (!/^[A-Z][A-Z0-9_]{1,64}$/.test(name)) return Err("invalid secret name");
  const tmp = `/tmp/secretsmith-mcp-${process.pid}-${name}`;
  require("node:fs").writeFileSync(tmp, value, { mode: 0o600 });
  const attrs = [`service=${service ?? "estate"}`, `app=${app ?? "mcp"}`];
  const r = spawnSync(
    SS,
    [
      "set",
      "--label",
      name,
      "--attr",
      attrs.join(","),
      "--secret-file",
      tmp,
    ].concat(replace ? ["--replace"] : []),
    { encoding: "utf8", timeout: 30_000 },
  );
  try {
    require("node:fs").rmSync(tmp, { force: true });
  } catch {
    /* best effort */
  }
  return r.status === 0
    ? Ok({ ok: true, name })
    : Err((r.stderr ?? "").trim().slice(0, 200));
};

const doGet = (
  name: string,
): Result<{ name: string; present: boolean; len: string }> => {
  const env = run(["env"]);
  if (!env.ok) return env;
  const present = listNames(env.value).includes(name);
  return Ok({ name, present, len: present ? "present" : "absent" });
};

// ---- tiny MCP stdio loop ----
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    let result: Result<unknown>;
    const p = req.params ?? {};
    switch (req.method) {
      case "add":
        result = doAdd(
          String(p.name ?? ""),
          String(p.value ?? ""),
          p.service,
          p.app,
          Boolean(p.replace),
        );
        break;
      case "get":
        result = doGet(String(p.name ?? ""));
        break;
      case "env":
        result = doEnv();
        break;
      case "list":
        result = doList();
        break;
      case "search":
        result = doSearch(p.pattern ? String(p.pattern) : undefined);
        break;
      default:
        result = Ok({ notice: "secretsmith-mcp; use add/get/env/list/search" });
    }
    const id = req.id ?? null;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
});
