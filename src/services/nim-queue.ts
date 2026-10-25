#!/usr/bin/env bun
/**
 * nim-queue — first-class NIM rate-limit + cache-hit shared service.
 *
 * Sits in front of herd (or any NIM-compatible upstream) and:
 *   1. Looks up the prompt hash in herd's PromptCache → cache-hit
 *   2. Consults herd's rate-limit state before forwarding → no thundering herd
 *   3. Records 429s with proper Retry-After → central backoff pool
 *   4. Mirrors successful responses back into the cache → every agent benefits
 *
 * All pi-agent providers (nvidia.ts), OpenFang hands, subagents route here
 * instead of hitting integrate.api.nvidia.com directly.
 *
 * Env:
 *   NIM_QUEUE_PORT         — bind (default 25189)
 *   NIM_QUEUE_UPSTREAM     — default "http://127.0.0.1:25100/v1"
 *   NIM_QUEUE_CACHE_URL    — herd admin cache endpoint (default http://127.0.0.1:25100)
 *   NIM_QUEUE_LLAMA_ADMIN  — herd admin base (default http://127.0.0.1:25100)
 *   NIM_QUEUE_API_KEY      — NVIDIA_API_KEY (passed through)
 *   NIM_QUEUE_MAX_BACKOFF_MS — cap backoff (default 120000)
 */

import { createHash } from "node:crypto";
import { loadEstatePorts } from "../lib/ports.ts";

loadEstatePorts();

// ──────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────
const PORT = parseInt(
  process.env.NIM_QUEUE_PORT ?? process.env.NIM_QUEUE_PORT ?? "25189",
  10,
);
const UPSTREAM_BASE =
  process.env.NIM_QUEUE_UPSTREAM ??
  `http://127.0.0.1:${process.env.HERD_PORT || process.env.HERD_PORT || "25100"}`;
const UPSTREAM_HAS_V1 = UPSTREAM_BASE.endsWith("/v1");
const UPSTREAM = UPSTREAM_BASE; // alias for compatibility
const ADMIN =
  process.env.NIM_QUEUE_LLAMA_ADMIN ??
  `http://127.0.0.1:${process.env.HERD_PORT || process.env.HERD_PORT || "25100"}`;
const MAX_BACKOFF_MS = parseInt(
  process.env.NIM_QUEUE_MAX_BACKOFF_MS ?? "120000",
  10,
);
const API_KEY =
  process.env.NIM_QUEUE_API_KEY ?? process.env.NVIDIA_API_KEY ?? "";

// ──────────────────────────────────────────────────────────────
// Statistics Tracking
// ──────────────────────────────────────────────────────────────
const stats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  rateLimited: 0,
  forwarded: 0,
  errors: 0,
  startedAt: Date.now(),
};

const inflight = new Map<string, Promise<Response>>(); // dedup concurrent identical requests

// ──────────────────────────────────────────────────────────────
// Helper Functions
// ──────────────────────────────────────────────────────────────
function hashKey(model: string, body: any): string {
  const h = createHash("sha256");
  h.update(model);
  h.update("\0");
  const keys = ["messages", "tools", "temperature", "top_p", "max_tokens"];
  for (const k of keys) {
    const v = body?.[k];
    if (v === undefined) continue;
    h.update(k);
    h.update("\0");
    h.update(JSON.stringify(v));
    h.update("\xff");
  }
  return h.digest("hex");
}

async function fetchRateLimits(): Promise<
  Record<
    string,
    { provider: string; backoffUntil: number; canRequest: boolean }
  >
> {
  try {
    const res = await fetch(`${ADMIN}/admin/rate-limits`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as any;
    const out: Record<
      string,
      { provider: string; backoffUntil: number; canRequest: boolean }
    > = {};
    for (const [name, info] of Object.entries(data.providers ?? {})) {
      const i = info as any;
      out[name] = {
        provider: name,
        backoffUntil: Date.now() + (i.backoff_ms ?? 0),
        canRequest: i.can_request ?? true,
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function fetchCache(
  hash: string,
  provider = "nvidia",
): Promise<{ hit: boolean; response?: any }> {
  try {
    const res = await fetch(
      `${CACHE_URL}/get?hash=${hash}&provider=${provider}`,
      {
        signal: AbortSignal.timeout(1500),
      },
    );
    if (!res.ok) return { hit: false };
    const data = (await res.json()) as any;
    if (data.hit && data.response)
      return { hit: true, response: data.response };
    return { hit: false };
  } catch {
    return { hit: false };
  }
}

async function storeCache(
  hash: string,
  provider: string,
  model: string,
  request: any,
  response: any,
): Promise<void> {
  try {
    await fetch(`${CACHE_URL}/store`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hash,
        provider,
        model,
        request,
        response:
          typeof response === "string" ? response : JSON.stringify(response),
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Non-fatal - cache store failures don't break the request
  }
}

async function forwardUpstream(
  req: Request,
  bodyText: string | undefined,
  _model: string,
): Promise<Response> {
  const init: RequestInit = {
    method: req.method,
    headers: new Headers(req.headers),
    body: bodyText,
  };
  // Strip host header
  (init.headers as Headers).delete("host");
  if (API_KEY && !(init.headers as Headers).has("authorization")) {
    (init.headers as Headers).set("authorization", `Bearer ${API_KEY}`);
  }
  // Strip /v1 from path if UPSTREAM already includes /v1 (e.g. http://127.0.0.1:25100/v1)
  const reqPath = new URL(req.url).pathname;
  const path =
    UPSTREAM_HAS_V1 && reqPath.startsWith("/v1/") ? reqPath.slice(3) : reqPath;
  const target = `${UPSTREAM}${path}${new URL(req.url).search}`;
  return await fetch(target, { ...init, signal: AbortSignal.timeout(180_000) });
}

function jsonResponse(
  body: any,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-nim-queue": "1",
      ...extra,
    },
  });
}

// ──────────────────────────────────────────────────────────────
// HTTP Server
// ──────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    // Admin/stats endpoints
    if (url.pathname === "/health") {
      return new Response("OK");
    }
    if (url.pathname === "/admin/stats") {
      return jsonResponse({
        ...stats,
        uptimeS: Math.floor((Date.now() - stats.startedAt) / 1000),
        inflight: inflight.size,
      });
    }
    if (url.pathname === "/admin/rate-limits") {
      return jsonResponse(await fetchRateLimits());
    }

    // Chat completions (cache-hit fast path + forward)
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      stats.requests++;
      const body = (await req.json()) as any;
      const model = body?.model ?? "unknown";
      const provider = (
        req.headers.get("x-nim-provider") ?? "nvidia"
      ).toString();

      // 1. Backoff check
      const limits = await fetchRateLimits();
      const lim = limits[provider];
      if (lim && !lim.canRequest && lim.backoffUntil > Date.now()) {
        stats.rateLimited++;
        const wait = Math.min(lim.backoffUntil - Date.now(), MAX_BACKOFF_MS);
        return jsonResponse(
          {
            error: "rate_limited",
            provider,
            retry_after_ms: wait,
            note: "Backed off — try another provider or wait",
          },
          429,
          { "retry-after": String(Math.ceil(wait / 1000)) },
        );
      }

      // 2. Cache lookup (only for non-streaming)
      const stream = body?.stream === true;
      const hash = hashKey(model, body);
      if (!stream) {
        const cached = await fetchCache(hash, provider);
        if (cached.hit && cached.response) {
          stats.cacheHits++;
          let parsed: any = cached.response;
          if (typeof parsed === "string") {
            try {
              parsed = JSON.parse(parsed);
            } catch {
              /* keep string */
            }
          }
          return jsonResponse({
            ...parsed,
            _x_nim_queue: { cache_hit: true, hash },
          });
        }
        stats.cacheMisses++;
      }

      // 3. Forward to upstream; record 429s in herd via header echo.
      try {
        stats.forwarded++;
        const upRes = await forwardUpstream(req, JSON.stringify(body), model);
        const status = upRes.status;

        // On success, store in cache for non-streaming
        if (status === 200 && !stream) {
          const clone = upRes.clone();
          clone
            .text()
            .then((text: string) => {
              try {
                const parsed = JSON.parse(text);
                storeCache(
                  hash,
                  provider,
                  model,
                  { model, stream: false },
                  parsed,
                ).catch(() => {});
              } catch {
                // not JSON, skip
              }
            })
            .catch(() => {});
        }

        // Echo 429 telemetry back so herd records it via Record429
        if (status === 429) {
          stats.rateLimited++;
          const retryAfterRaw = upRes.headers.get("retry-after") ?? "5";
          const retryAfterMs = Math.min(
            parseInt(retryAfterRaw, 10) * 1000 || 5000,
            120000,
          );
          const cappedRetryAfter = String(Math.ceil(retryAfterMs / 1000));
          const newHeaders = new Headers(upRes.headers);
          newHeaders.set("retry-after", cappedRetryAfter);
          newHeaders.set("x-nim-queue-429", "true");
          newHeaders.set("x-nim-queue-capped", "true");
          try {
            const bodyText = await upRes.clone().text();
            const bodyData = JSON.parse(bodyText);
            if (bodyData.retry_after_ms && bodyData.retry_after_ms > 120000) {
              bodyData.retry_after_ms = 120000;
              bodyData.note = `${bodyData.note || ""} [CAPPED at 120s max by nim-queue]`;
            }
            return new Response(JSON.stringify(bodyData), {
              status,
              headers: newHeaders,
            });
          } catch {
            return new Response(upRes.body, { status, headers: newHeaders });
          }
        }

        return upRes;
      } catch (e) {
        stats.errors++;
        return jsonResponse(
          { error: "upstream_error", detail: String(e) },
          502,
        );
      }
    }

    // Pass through other endpoints (models list etc.)
    if (url.pathname.startsWith("/v1/")) {
      const path = UPSTREAM_HAS_V1 ? url.pathname.slice(3) : url.pathname;
      const bodyText =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.text();
      return await fetch(`${UPSTREAM}${path}${url.search}`, {
        method: req.method,
        headers: new Headers(req.headers),
        body: bodyText,
        signal: AbortSignal.timeout(60_000),
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(
  `[nim-queue] listening :${server.port} → upstream=${UPSTREAM} admin=${ADMIN}`,
);
