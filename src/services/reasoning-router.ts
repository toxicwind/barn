#!/usr/bin/env bun
/**
 * reasoning-router.ts — Routes requests to appropriate herd backends based on reasoning_effort
 * Integrates with herd :25100 config matrix
 */

import { loadEstatePorts } from "../lib/ports.ts";

loadEstatePorts();

const HERD_BASE = `http://127.0.0.1:${process.env.HERD_PORT || process.env.HERD_PORT || "25100"}`;
const _HERD_BASE = HERD_BASE; // alias for project-wide herd naming (tau: any pi/omp -> tau)
// ──────────────────────────────────────────────────────────────
// REASONING EFFORT → BACKEND MAPPING
// Based on herd.yaml routing matrix
// ──────────────────────────────────────────────────────────────

interface BackendSpec {
  model: string;
  fork: string;
  context: number;
  quant: string;
  vram: string;
  reasoning: boolean;
  mtp: boolean;
  dflash: boolean;
  priority: number;
}

const REASONING_ROUTES: Record<string, BackendSpec[]> = {
  none: [
    // Fast, low-latency models for no reasoning
    {
      model: "beellama/exaone-4-0-1-2b-iq4xs",
      fork: "beellama",
      context: 32768,
      quant: "IQ4_XS",
      vram: "~3.3GB",
      reasoning: false,
      mtp: false,
      dflash: false,
      priority: 35,
    },
    {
      model: "beellama/qwen-flash-64k",
      fork: "beellama",
      context: 65536,
      quant: "IQ4_XS",
      vram: "~9GB",
      reasoning: false,
      mtp: false,
      dflash: false,
      priority: 16,
    },
    {
      model: "beellama/gemma-64k",
      fork: "beellama",
      context: 65536,
      quant: "Q4_K_M",
      vram: "~8GB",
      reasoning: false,
      mtp: false,
      dflash: false,
      priority: 11,
    },
  ],
  low: [
    // Light reasoning - small models with REASONING_ON
    {
      model: "mradermacher/qwen3.5-9b-deepseek-v4-flash-i1-q4_k_s",
      fork: "beellama",
      context: 131072,
      quant: "IQ4_XS",
      vram: "~9GB",
      reasoning: true,
      mtp: false,
      dflash: false,
      priority: 29,
    },
    {
      model: "jackrong/qwen3.5-9b-deepseek-v4-flash-da-q4km",
      fork: "beellama",
      context: 131072,
      quant: "Q4_K_M",
      vram: "~9GB",
      reasoning: true,
      mtp: false,
      dflash: false,
      priority: 28,
    },
  ],
  medium: [
    // Medium reasoning - DeepSeek distilled models
    {
      model: "mradermacher/qwen3.5-9b-deepseek-v4-flash-i1-q4_k_m",
      fork: "beellama",
      context: 131072,
      quant: "IQ4_XS",
      vram: "~9GB",
      reasoning: true,
      mtp: false,
      dflash: false,
      priority: 30,
    },
    {
      model: "beellama/gemma-mtp-64k",
      fork: "beellama",
      context: 65536,
      quant: "Q4_K_M",
      vram: "~8GB",
      reasoning: false,
      mtp: true,
      dflash: false,
      priority: 12,
    },
  ],
  high: [
    // High reasoning - larger models with reasoning
    {
      model: "beellama/qwen3.5-9b-deepseek-v4-flash-da-q4km",
      fork: "beellama",
      context: 131072,
      quant: "Q4_K_M",
      vram: "~9GB",
      reasoning: true,
      mtp: false,
      dflash: false,
      priority: 28,
    },
    {
      model: "beellama/gemma-128k",
      fork: "beellama",
      context: 131072,
      quant: "Q4_K_M",
      vram: "~13GB",
      reasoning: false,
      mtp: false,
      dflash: false,
      priority: 15,
    },
  ],
  max: [
    // Maximum reasoning - largest models, DFlash, MTP
    {
      model: "qwen/27b-dflash-iq4xs",
      fork: "beellama",
      context: 32768,
      quant: "IQ4_XS",
      vram: "~17GB",
      reasoning: false,
      mtp: false,
      dflash: true,
      priority: 27,
    },
    {
      model: "turboquant/heretic-27b-128k",
      fork: "turboquant",
      context: 131072,
      quant: "Q5_K_XL",
      vram: "~16GB",
      reasoning: false,
      mtp: false,
      dflash: false,
      priority: 8,
    },
    {
      model: "ik_llama/heretic-ud-96k",
      fork: "ik_llama",
      context: 98304,
      quant: "Q5_K_XL",
      vram: "~20GB",
      reasoning: false,
      mtp: false,
      dflash: false,
      priority: 4,
    },
  ],
  xhigh: [
    // Extreme reasoning - largest models with extreme context
    {
      model: "qwen/27b-mtp-ud-q4xl",
      fork: "beellama",
      context: 98304,
      quant: "Q4_K_XL",
      vram: "~18GB",
      reasoning: false,
      mtp: true,
      dflash: false,
      priority: 25,
    },
    {
      model: "turboquant/heretic-27b-256k",
      fork: "turboquant",
      context: 262144,
      quant: "Q5_K_XL",
      vram: "~18GB",
      reasoning: false,
      mtp: false,
      dflash: false,
      priority: 7,
    },
    {
      model: "ik_turboquant/heretic-27b-256k",
      fork: "ik_turboquant",
      context: 262144,
      quant: "Q5_K_XL",
      vram: "~18GB",
      reasoning: false,
      mtp: false,
      dflash: false,
      priority: 3,
    },
  ],
};

type ReasoningEffort = "none" | "low" | "medium" | "high" | "max" | "xhigh";

interface RouteRequest {
  reasoning_effort?: ReasoningEffort;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  messages: Array<{ role: string; content: string }>;
  chat_template_kwargs?: { reasoning_effort?: ReasoningEffort };
}

interface RouteResponse {
  selected_model: string;
  backend: BackendSpec;
  fallback_models: string[];
  routing_reason: string;
}

// ──────────────────────────────────────────────────────────────
// ROUTER LOGIC
// ──────────────────────────────────────────────────────────────

function extractReasoningEffort(request: RouteRequest): ReasoningEffort {
  // Check chat_template_kwargs first (NIM standard)
  if (request.chat_template_kwargs?.reasoning_effort) {
    return request.chat_template_kwargs.reasoning_effort;
  }
  // Check top-level (OpenAI style)
  if ((request as any).reasoning_effort) {
    return (request as any).reasoning_effort;
  }
  // Default to medium
  return "medium";
}

function selectBackend(
  effort: ReasoningEffort,
  preferredModel?: string,
): RouteResponse {
  const backends = REASONING_ROUTES[effort] || REASONING_ROUTES.medium;

  // If user specified a model, try to use it if compatible
  if (preferredModel) {
    const exactMatch = backends.find((b) => b.model === preferredModel);
    if (exactMatch) {
      return {
        selected_model: exactMatch.model,
        backend: exactMatch,
        fallback_models: backends
          .filter((b) => b.model !== preferredModel)
          .map((b) => b.model),
        routing_reason: `Exact model match for ${effort} reasoning`,
      };
    }

    // Check if preferred model is in any tier
    for (const [tier, tierBackends] of Object.entries(REASONING_ROUTES)) {
      const match = tierBackends.find((b) => b.model === preferredModel);
      if (match) {
        return {
          selected_model: match.model,
          backend: match,
          fallback_models: backends.map((b) => b.model),
          routing_reason: `Preferred model ${preferredModel} found in ${tier} tier, using for ${effort} reasoning`,
        };
      }
    }
  }

  // Select highest priority backend for the effort tier
  const selected = backends.reduce((best, current) =>
    current.priority > best.priority ? current : best,
  );

  return {
    selected_model: selected.model,
    backend: selected,
    fallback_models: backends
      .filter((b) => b.model !== selected.model)
      .map((b) => b.model),
    routing_reason: `Selected highest priority (${selected.priority}) backend for ${effort} reasoning: ${selected.model}`,
  };
}

// ──────────────────────────────────────────────────────────────
// HTTP SERVER
// ──────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: parseInt(process.env.REASONING_ROUTER_PORT || "25190", 10),
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK");
    }

    // Route endpoint
    if (url.pathname === "/v1/route" && req.method === "POST") {
      try {
        const body = (await req.json()) as RouteRequest;

        // Extract reasoning effort
        const effort = extractReasoningEffort(body);

        // Select backend
        const route = selectBackend(effort, body.model);

        // Also check herd for model availability
        let available = true;
        try {
          const modelsRes = await fetch(`${HERD_BASE}/v1/models`, {
            signal: AbortSignal.timeout(2000),
          });
          if (modelsRes.ok) {
            const modelsData = await modelsRes.json();
            const models = (modelsData as any).models || [];
            available = models.some((m: any) => m.id === route.selected_model);
          }
        } catch {
          // If can't check, assume available
        }

        return new Response(
          JSON.stringify({
            ...route,
            available,
            effort,
            timestamp: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
        });
      }
    }

    // Proxy chat completions with automatic routing
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = (await req.json()) as RouteRequest;
        const effort = extractReasoningEffort(body);
        const route = selectBackend(effort, body.model);

        // Forward to herd with selected model
        const forwardBody = {
          ...body,
          model: route.selected_model,
        };

        // Remove routing-specific fields
        delete (forwardBody as any).chat_template_kwargs?.reasoning_effort;
        delete (forwardBody as any).reasoning_effort;

        const response = await fetch(`${HERD_BASE}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: req.headers.get("Authorization") || "",
          },
          body: JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(180_000),
        });

        // Add routing headers
        const newHeaders = new Headers(response.headers);
        newHeaders.set("x-reasoning-effort", effort);
        newHeaders.set("x-routed-model", route.selected_model);
        newHeaders.set("x-routing-reason", route.routing_reason);

        return new Response(response.body, {
          status: response.status,
          headers: newHeaders,
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
        });
      }
    }

    // List routing table
    if (url.pathname === "/v1/routing-table" && req.method === "GET") {
      return new Response(
        JSON.stringify({
          tiers: Object.fromEntries(
            Object.entries(REASONING_ROUTES).map(([effort, backends]) => [
              effort,
              backends.map((b) => ({
                model: b.model,
                fork: b.fork,
                context: b.context,
                quant: b.quant,
                vram: b.vram,
                priority: b.priority,
                reasoning: b.reasoning,
                mtp: b.mtp,
                dflash: b.dflash,
              })),
            ]),
          ),
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(
  `[reasoning-router] listening :${server.port} → herd=${HERD_BASE}`,
);
console.log(
  `[reasoning-router] Routing tiers: ${Object.keys(REASONING_ROUTES).join(", ")}`,
);
