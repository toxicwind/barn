#!/usr/bin/env bun
/**
 * Sync VS Code Insiders → herd via oaicopilot plugin settings (Bun).
 *
 * Catalog SSOT = live GET :25100/v1/models (not a hand-written inventory).
 * oaicopilot has no native /models/sse auto_discover (unlike Zed llama.cpp),
 * so we mirror the live catalog into oaicopilot.models. Optional --watch
 * re-syncs on herd SSE load/unload events.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  listSwapModels,
  oaicopilotModelsFromSwap,
  pickDefaultModel,
  swapV1Url,
  watchSwapModelsSseRefresh,
} from "../lib/herd_ssot.ts";

const settingsPath =
  process.env.VSCODE_INSIDERS_SETTINGS ||
  join(homedir(), ".config/Code - Insiders/User/settings.json");
const clmPath =
  process.env.VSCODE_INSIDERS_CHAT_LM ||
  join(homedir(), ".config/Code - Insiders/User/chatLanguageModels.json");

async function syncOnce(): Promise<{
  ok: boolean;
  n: number;
  base: string;
  utility: string;
  error?: string;
}> {
  const base = swapV1Url();
  const { ok, models, error } = await listSwapModels();
  if (!ok || !models.length) {
    return { ok: false, n: 0, base, utility: "", error: error || "no models" };
  }

  const oaicopilotModels = oaicopilotModelsFromSwap(models, base);
  const defaultModel = await pickDefaultModel();

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await Bun.file(settingsPath).text());
  } catch {
    settings = {};
  }

  settings["oaicopilot.baseUrl"] = base;
  settings["oaicopilot.models"] = oaicopilotModels;
  settings["oaicopilot.logLevel"] = settings["oaicopilot.logLevel"] || "info";
  settings["chat.utilitySmallModel"] = `oaicopilot/${defaultModel}`;
  // Discovery metadata for tools that can poll / subscribe
  settings["estate.llamaSwap.baseUrl"] = base.replace(/\/v1$/, "");
  settings["estate.llamaSwap.modelsUrl"] = `${base}/models`;
  settings["estate.llamaSwap.modelsSse"] = base.replace(/\/v1$/, "/models/sse");
  delete settings["oai-compatible-copilot.providers"];

  await Bun.write(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await Bun.write(clmPath, "[]\n");

  return {
    ok: true,
    n: oaicopilotModels.length,
    base,
    utility: String(settings["chat.utilitySmallModel"]),
  };
}

const watch = process.argv.includes("--watch");
const result = await syncOnce();
if (!result.ok) {
  console.error("sync failed:", result.error);
  process.exit(1);
}
console.log(
  `port_base=${result.base} models=${result.n} (live /v1/models) utility=${result.utility}`,
);
console.log(`settings=${settingsPath}`);
console.log("chatLanguageModels=[]");
console.log(
  "note=oaicopilot has no native SSE auto_discover; catalog mirrored from herd live API",
);

if (watch) {
  console.log("watching /models/sse for load/unload → re-sync…");
  watchSwapModelsSseRefresh(
    async () => {
      const r = await syncOnce();
      console.log(
        `[sse-refresh] ok=${r.ok} models=${r.n} ${new Date().toISOString()}`,
      );
    },
    {
      onError: (e) => console.error("[sse-refresh] error", e),
    },
  );
  // keep process alive
  await new Promise(() => {});
}
