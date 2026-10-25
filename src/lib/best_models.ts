/**
 * Consume ranked best-models SSOT produced by scripts/model-rank-and-route.ts
 * and optionally refresh via herd /models/sse (no hand inventories).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  listSwapModels,
  pickDefaultModel,
  swapBaseUrl,
  watchSwapModelsSseRefresh,
} from "./herd_ssot.ts";

export type BestRoles = {
  fast?: {
    id: string;
    latency_ms?: number;
    tok_s?: number | null;
    gpu_mem_mib?: number | null;
  };
  quality?: {
    id: string;
    latency_ms?: number;
    tok_s?: number | null;
    gpu_mem_mib?: number | null;
  };
  longctx?: {
    id: string;
    latency_ms?: number;
    tok_s?: number | null;
    gpu_mem_mib?: number | null;
  };
};

export type BestModelsDoc = {
  ts?: string;
  gpu?: string;
  roles: BestRoles;
  recommended?: {
    preload?: string;
    default_chat?: string;
    long_context?: string;
    hot_path_max_vram_mib?: number;
  };
};

const SOV = process.env.ESTATE_ROOT || join(homedir(), "estate");
export const BEST_MODELS_PATH =
  process.env.BEST_MODELS_PATH || join(SOV, ".state/best-models.json");

export function loadBestModels(path = BEST_MODELS_PATH): BestModelsDoc | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BestModelsDoc;
  } catch {
    return null;
  }
}

/** Role → model id from SSOT file, else live pickDefaultModel for quality. */
export async function modelForRole(
  role: "fast" | "quality" | "longctx" | "default",
): Promise<string> {
  const doc = loadBestModels();
  if (role === "default") {
    return (
      doc?.recommended?.default_chat ||
      doc?.roles?.quality?.id ||
      (await pickDefaultModel())
    );
  }
  const id = doc?.roles?.[role]?.id;
  if (id) {
    const { models } = await listSwapModels();
    if (models.some((m) => m.id === id)) return id;
  }
  // fallbacks aligned with ranking defaults
  if (role === "fast") return "beellama/exaone-4-0-1-2b-iq4xs";
  if (role === "longctx") return "beellama/qwen-flash-256k";
  return "beellama/qwen-flash-64k";
}

/** Ensure recommended ids still exist in live catalog; rewrite path if stale. */
export async function validateBestModelsAgainstCatalog(
  path = BEST_MODELS_PATH,
): Promise<{ ok: boolean; missing: string[]; doc: BestModelsDoc | null }> {
  const doc = loadBestModels(path);
  if (!doc) return { ok: false, missing: ["no_doc"], doc: null };
  const { models } = await listSwapModels();
  const ids = new Set(models.map((m) => m.id));
  const missing: string[] = [];
  for (const role of ["fast", "quality", "longctx"] as const) {
    const id = doc.roles?.[role]?.id;
    if (id && !ids.has(id)) missing.push(`${role}:${id}`);
  }
  return { ok: missing.length === 0, missing, doc };
}

/**
 * On SSE model load/unload, re-validate catalog membership of best roles.
 * Writes a small heartbeat JSON next to best-models.
 */
export function watchBestModelsSse(path = BEST_MODELS_PATH): {
  abort: () => void;
} {
  const beat = join(SOV, ".state/best-models-sse-beat.json");
  mkdirSync(join(SOV, ".state"), { recursive: true });
  return watchSwapModelsSseRefresh(async () => {
    const v = await validateBestModelsAgainstCatalog(path);
    writeFileSync(
      beat,
      `${JSON.stringify(
        {
          ts: new Date().toISOString(),
          base: swapBaseUrl(),
          ok: v.ok,
          missing: v.missing,
        },
        null,
        2,
      )}\n`,
    );
  });
}
