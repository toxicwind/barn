#!/usr/bin/env bun
/**
 * Align OpenFang providers with herd :25100.
 * provider id "llama" is preferred; "vllm" kept only as alias URL → same swap.
 * Never points at real vLLM :8000.
 */
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEstatePorts, requireEnv } from "../lib/ports.ts";

loadEstatePorts();
const HOME = homedir();
const OF = join(HOME, ".openfang");
const BACKUP = join(
  HOME,
  "estate/backup/reorg_2026-07-11_bun/openfang_pre_llama_provider",
);
const SWAP = `http://127.0.0.1:${requireEnv("HERD_PORT")}/v1`;

function walkToml(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkToml(p, acc);
    else if (name.endsWith(".toml")) acc.push(p);
  }
  return acc;
}

function ensureBackup() {
  mkdirSync(BACKUP, { recursive: true });
  for (const f of ["config.toml", "custom_models.json", "routing.toml"]) {
    const src = join(OF, f);
    try {
      copyFileSync(src, join(BACKUP, f));
    } catch {
      /* */
    }
  }
}

ensureBackup();

// --- agents: provider = "llama" ---
let agentsPatched = 0;
for (const p of walkToml(join(OF, "agents"))) {
  let t = readFileSync(p, "utf8");
  const orig = t;
  t = t.replace(/^provider\s*=\s*"vllm"\s*$/gm, 'provider = "llama"');
  t = t.replaceAll("127.0.0.1:25001", "127.0.0.1:25100");
  t = t.replaceAll("127.0.0.1:25021", "127.0.0.1:25100");
  t = t.replaceAll("localhost:8000", "127.0.0.1:25100");
  if (t !== orig) {
    writeFileSync(p, t);
    agentsPatched++;
  }
}

// --- custom_models.json ---
const cmPath = join(OF, "custom_models.json");
const cm = JSON.parse(readFileSync(cmPath, "utf8")) as Array<
  Record<string, unknown>
>;
for (const m of cm) {
  // model id "llama" must use provider "llama" (OpenAI-compat id → provider_urls.llama)
  if (m.provider === "vllm" || m.id === "llama") {
    m.provider = "llama";
  }
}
writeFileSync(cmPath, `${JSON.stringify(cm, null, 2)}\n`);

// --- routing.toml ---
const rtPath = join(OF, "routing.toml");
let rt = readFileSync(rtPath, "utf8");
rt = rt.replace(
  /default\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/v1"/,
  `default = "${SWAP}"`,
);
rt = rt.replace(
  /target\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/v1"/g,
  `target = "${SWAP}"`,
);
writeFileSync(rtPath, rt);

// --- config.toml provider_urls + default_model ---
const cfgPath = join(OF, "config.toml");
let cfg = readFileSync(cfgPath, "utf8");
cfg = cfg.replace(/^provider\s*=\s*"vllm"\s*$/gm, 'provider = "llama"');
// rewrite provider_urls block
if (cfg.includes("[provider_urls]")) {
  const lines = cfg.split("\n");
  const out: string[] = [];
  let inPu = false;
  let wrote = false;
  for (const line of lines) {
    if (line.trim() === "[provider_urls]") {
      inPu = true;
      out.push(line);
      out.push(`llama = "${SWAP}"`);
      out.push(`vllm = "${SWAP}"`); // residual alias → same swap, not real vLLM
      wrote = true;
      continue;
    }
    if (inPu) {
      if (line.startsWith("[")) {
        inPu = false;
        out.push(line);
      }
      // skip old keys inside provider_urls
      continue;
    }
    out.push(line);
  }
  if (!wrote) {
    out.push("");
    out.push("[provider_urls]");
    out.push(`llama = "${SWAP}"`);
    out.push(`vllm = "${SWAP}"`);
  }
  cfg = out.join("\n");
  if (!cfg.endsWith("\n")) cfg += "\n";
} else {
  cfg += `\n[provider_urls]\nllama = "${SWAP}"\nvllm = "${SWAP}"\n`;
}
writeFileSync(cfgPath, cfg);

// --- verify ---
let vllm = 0;
let llama = 0;
let bad = 0;
for (const p of walkToml(join(OF, "agents"))) {
  const t = readFileSync(p, "utf8");
  if (/^provider\s*=\s*"vllm"\s*$/m.test(t)) vllm++;
  if (/^provider\s*=\s*"llama"\s*$/m.test(t)) llama++;
  if (/25001|25021|localhost:8000/.test(t)) {
    bad++;
    console.log("bad_url", p);
  }
}

console.log(
  JSON.stringify(
    {
      agents_patched: agentsPatched,
      agent_provider_vllm: vllm,
      agent_provider_llama: llama,
      bad_urls: bad,
      custom_models: cm,
      routing: readFileSync(rtPath, "utf8"),
      provider_urls: readFileSync(cfgPath, "utf8")
        .split("\n")
        .filter(
          (l) =>
            l.includes("provider") || l.includes("25100") || l.startsWith("["),
        )
        .join("\n"),
      backup: BACKUP,
      swap: SWAP,
    },
    null,
    2,
  ),
);

if (vllm > 0 || bad > 0) process.exit(1);
