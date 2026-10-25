#!/usr/bin/env bun
/**
 * Point local clients at herd SSOT (:25100) without hand-listing models.
 *
 * - Writes .state/herd-ssot.json + client-llm.env (includes MODELS_SSE)
 * - Patches OpenFang provider_urls.llama → :25100/v1
 * - Ensures Zed language_models.llama.cpp = { api_url, auto_discover: true }
 *   (strips any available_models under llama.cpp — SSE rediscovery owns the list)
 * - Does NOT invent per-model inventories for Zed
 *
 * Usage:
 *   bun run src/deploy/sync_clients_from_swap.ts
 *   bun run src/deploy/sync_clients_from_swap.ts --with-ides   # also code_insiders + ide_clients
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  clientEnvExports,
  listSwapModels,
  openaiCompatClientConfig,
  pickDefaultModel,
  swapBaseUrl,
  swapModelsSseUrl,
  swapV1Url,
} from "../lib/herd_ssot.ts";

const HOME = homedir();
const SOV = process.env.ESTATE_ROOT || join(HOME, "estate");
const outDir = join(SOV, ".state");
mkdirSync(outDir, { recursive: true });

const withIdes = process.argv.includes("--with-ides");

const { ok, models, error } = await listSwapModels();
const defaultModel = await pickDefaultModel();
const cfg = openaiCompatClientConfig(defaultModel);

const report = {
  ts: new Date().toISOString(),
  ssot: "tools/herd/config.yaml + live /v1/models + /models/sse",
  base: swapBaseUrl(),
  v1: swapV1Url(),
  models_sse: swapModelsSseUrl(),
  list_ok: ok,
  error,
  model_count: models.length,
  loaded: models.filter((m) => m.status === "loaded").map((m) => m.id),
  default_model: defaultModel,
  client: cfg,
  zed: {
    language_models: {
      "llama.cpp": {
        api_url: swapBaseUrl(),
        auto_discover: true,
      },
    },
    note: "Zed rediscovers via GET /models/sse — do not maintain available_models lists for local GGUFs",
  },
};

writeFileSync(
  join(outDir, "herd-ssot.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
writeFileSync(join(outDir, "client-llm.env"), clientEnvExports(defaultModel));

// OpenFang: ensure provider_urls.llama → :25100/v1 (do not rewrite agent model tables here)
const ofConfig = join(HOME, ".openfang/config.toml");
if (existsSync(ofConfig)) {
  let t = readFileSync(ofConfig, "utf8");
  const want = `llama = "${swapV1Url()}"`;
  if (t.includes("[provider_urls]")) {
    if (/llama\s*=/.test(t)) {
      t = t.replace(/llama\s*=\s*"[^"]*"/, want);
    } else {
      t = t.replace("[provider_urls]", `[provider_urls]\n${want}`);
    }
  }
  if (/vllm\s*=/.test(t)) {
    t = t.replace(/vllm\s*=\s*"[^"]*"/, `vllm = "${swapV1Url()}"`);
  }
  writeFileSync(ofConfig, t);
  console.log("[ssot] openfang provider_urls.llama →", swapV1Url());
}

// Zed: ensure llama.cpp auto_discover only — never rewrite whole JSONC.
// Use python3+json5 (host has it); only touch the llama.cpp object.
const zedPath = join(HOME, ".config/zed/settings.json");
let zedPatched = false;
if (existsSync(zedPath)) {
  const py = `
import json5, json, sys
from pathlib import Path
p = Path(${JSON.stringify(zedPath)})
raw = p.read_text()
data = json5.loads(raw)
lm = data.setdefault("language_models", {})
changed = False
if "estate-herd" in lm:
    del lm["estate-herd"]
    changed = True
want_url = ${JSON.stringify(swapBaseUrl())}
cur = lm.get("llama.cpp") or {}
if (
    cur.get("api_url") != want_url
    or cur.get("auto_discover") is not True
    or "available_models" in cur
):
    lm["llama.cpp"] = {"api_url": want_url, "auto_discover": True}
    changed = True
ok = (
    isinstance(lm.get("llama.cpp"), dict)
    and lm["llama.cpp"].get("auto_discover") is True
    and lm["llama.cpp"].get("api_url") == want_url
    and "available_models" not in lm["llama.cpp"]
)
if changed:
    bak = p.with_suffix(p.suffix + f".bak-ssot")
    bak.write_text(raw)
    # Surgical replace of the llama.cpp block to avoid nuking JSONC comments
    import re
    block = '''    "llama.cpp": {
      "api_url": "%s",
      "auto_discover": true
    }''' % want_url
    new, n = re.subn(
        r'"llama\\.cpp"\\s*:\\s*\\{[^}]*\\}',
        block.strip(),
        raw,
        count=1,
    )
    if n:
        p.write_text(new)
        print("PATCHED_SURGICAL")
    else:
        # fallback full json write (loses comments)
        p.write_text(json.dumps(data, indent=2) + "\\n")
        print("PATCHED_FULL")
else:
    print("OK" if ok else "BAD")
`;
  const res = Bun.spawnSync({
    cmd: ["python3", "-c", py],
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new TextDecoder().decode(res.stdout).trim();
  const err = new TextDecoder().decode(res.stderr).trim();
  if (out.includes("PATCHED")) {
    zedPatched = true;
    console.log(
      "[ssot] zed llama.cpp auto_discover ensured @",
      swapBaseUrl(),
      out,
    );
  } else if (out === "OK") {
    console.log("[ssot] zed already auto_discover-only");
  } else {
    console.error("[ssot] zed check:", out || err || res.exitCode);
  }
}

if (withIdes) {
  const ide = Bun.spawnSync({
    cmd: ["bun", "run", join(SOV, "src/deploy/ide_clients.ts")],
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (ide.exitCode !== 0) process.exit(ide.exitCode || 1);
}

console.log(
  JSON.stringify(
    {
      ok,
      model_count: models.length,
      defaultModel,
      sse: swapModelsSseUrl(),
      zed_patched: zedPatched,
      with_ides: withIdes,
    },
    null,
    2,
  ),
);
