/**
 * herd is the master catalog for local models.
 *
 * Sources of truth (in order):
 *   1. tools/herd/config.yaml  (what can run)
 *   2. GET http://127.0.0.1:${HERD_PORT}/v1/models  (live IDs + status)
 *   3. GET /models/sse  (load/unload events — same contract Zed llama.cpp uses)
 *
 * Clients must NOT hardcode full GGUF inventories. Point base_url at :25100 and
 * list/discover via these endpoints (or SSE auto_discover for Zed).
 */
import { loadEstatePorts, requirePort } from "./ports.ts";

loadEstatePorts();

export type SwapModel = {
  id: string;
  status?: string;
  name?: string;
  meta?: Record<string, unknown>;
};

export function swapBaseUrl(): string {
  const port = requirePort("HERD_PORT");
  return `http://127.0.0.1:${port}`;
}

export function swapV1Url(): string {
  return `${swapBaseUrl()}/v1`;
}

export function swapModelsSseUrl(): string {
  return `${swapBaseUrl()}/models/sse`;
}

/** Live catalog from herd (SSOT at runtime). */
export async function listSwapModels(
  timeoutMs = 5000,
): Promise<{ ok: boolean; models: SwapModel[]; error?: string }> {
  try {
    const res = await fetch(`${swapV1Url()}/models`, {
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, models: [], error: `HTTP ${res.status}` };
    }
    const data: any = await res.json();
    const models: SwapModel[] = (data?.data || []).map((m: any) => ({
      id: m.id,
      name: m.name,
      status: m.status?.value ?? m.status,
      meta: m.meta,
    }));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: String(e) };
  }
}

/** Prefer a loaded model, else primary, else first id. */
export async function pickDefaultModel(
  preferred = process.env.HERD_MODEL || "beellama/qwen-flash-64k",
): Promise<string> {
  const { models } = await listSwapModels();
  if (!models.length) return preferred;
  const loaded = models.find(
    (m) => m.status === "loaded" && !m.id.startsWith("MODEL_PLACEHOLDER"),
  );
  if (loaded) return loaded.id;
  if (models.some((m) => m.id === preferred)) return preferred;
  const real = models.find((m) => !m.id.startsWith("MODEL_PLACEHOLDER"));
  return real?.id || preferred;
}

export type ModelSseEvent = {
  model: string;
  event: string;
  data?: { status?: string; progress?: unknown };
};

/**
 * Subscribe to herd /models/sse (Zed contract).
 * Calls onEvent for each parsed ModelEvent; returns an abort handle.
 */
export function watchSwapModelsSse(
  onEvent: (ev: ModelSseEvent) => void,
  onError?: (e: unknown) => void,
): { abort: () => void } {
  const ac = new AbortController();
  (async () => {
    try {
      const res = await fetch(swapModelsSseUrl(), {
        headers: { Accept: "text/event-stream" },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        onError?.(new Error(`SSE HTTP ${res.status}`));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (!ac.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const block of parts) {
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]" || raw === ": keep-alive") continue;
            try {
              onEvent(JSON.parse(raw) as ModelSseEvent);
            } catch {
              /* ignore non-json keepalives */
            }
          }
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) onError?.(e);
    }
  })();
  return { abort: () => ac.abort() };
}

/**
 * Debounced SSE → refresh callback. Use for clients that cannot speak SSE
 * natively (e.g. VS Code oaicopilot models array) so they stay aligned with
 * herd load/unload without hand-maintained inventories.
 */
export function watchSwapModelsSseRefresh(
  onRefresh: () => void | Promise<void>,
  opts: { debounceMs?: number; onError?: (e: unknown) => void } = {},
): { abort: () => void } {
  const debounceMs = opts.debounceMs ?? 1500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void Promise.resolve(onRefresh()).catch(opts.onError);
    }, debounceMs);
  };
  const w = watchSwapModelsSse(() => schedule(), opts.onError);
  return {
    abort: () => {
      if (timer) clearTimeout(timer);
      w.abort();
    },
  };
}

function ctxFromId(name: string): number {
  const n = name.toLowerCase();
  for (const [tok, val] of [
    ["512k", 524288],
    ["256k", 262144],
    ["192k", 196608],
    ["128k", 131072],
    ["96k", 98304],
    ["64k", 65536],
    ["32k", 32768],
  ] as const) {
    if (n.includes(tok)) return val;
  }
  const m = n.match(/(\d+)(?=k)/);
  return m ? parseInt(m[1], 10) * 1024 : 65536;
}

/** oaicopilot-shaped models from live catalog (never a static inventory file). */
export function oaicopilotModelsFromSwap(
  models: SwapModel[],
  base = swapV1Url(),
) {
  return models
    .filter((m) => m.id && !m.id.startsWith("MODEL_PLACEHOLDER"))
    .map((m) => ({
      id: m.id,
      displayName: `local/${m.id.split("/").pop()}`,
      owned_by: "herd",
      family: "oai-compatible",
      baseUrl: base,
      context_length: ctxFromId(m.id),
      vision: m.id.toLowerCase().includes("gemma"),
      max_tokens: 8192,
      max_completion_tokens: 8192,
    }));
}

/** Client wiring snippet for OpenAI-compat apps */
export function openaiCompatClientConfig(defaultModel?: string) {
  return {
    base_url: swapV1Url(),
    api_key: process.env.OPENAI_API_KEY || "not-required-for-local",
    default_model:
      defaultModel || process.env.HERD_MODEL || "beellama/qwen-flash-64k",
    models_url: `${swapV1Url()}/models`,
    models_sse_url: swapModelsSseUrl(),
    note: "Catalog is live from herd; do not ship static model inventories. Prefer SSE auto_discover when the client supports it (Zed llama.cpp).",
  };
}

/** Env exports for shells / Antigravity / IDE wrappers — SSE included. */
export function clientEnvExports(defaultModel?: string): string {
  const base = swapBaseUrl();
  const v1 = swapV1Url();
  const sse = swapModelsSseUrl();
  const dm =
    defaultModel || process.env.HERD_MODEL || "beellama/qwen-flash-64k";
  return `# Generated from herd SSOT — do not hand-edit model lists
export OPENAI_BASE_URL=${v1}
export OPENAI_API_BASE=${v1}
export LLM_BASE_URL=${v1}
export HERD_URL=${base}
export HERD_BASE=${base}
export HERD_V1=${v1}
export HERD_MODELS_URL=${v1}/models
export HERD_MODELS_SSE=${sse}
export LLAMA_MODELS_SSE_URL=${sse}
export LLAMA_CHAT_URL=${v1}/chat/completions
export HERD_MODEL=${dm}
export ESTATE_LLM=${v1}
`;
}
