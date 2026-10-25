/**
 * GHAS-inspired mesh feature registry (20 features).
 * Borrowed patterns: k8s ready/live/startup, service discovery, GHAS search mesh,
 * dependency graph, version/capabilities — not reinvented greenfield.
 *
 * Mount via handleMeshRequest() on /mesh/* of any service, or run mesh-hub.
 */
import { loadEstatePorts, requirePort } from "./ports.ts";

loadEstatePorts();

export type MeshServiceId =
  | "herd"
  | "rust-web"
  | "yote"
  | "openfang"
  | "estate-router"
  | "prometheus"
  | "hf-downloader"
  | "null-g-proxy"
  | "grafana"
  | "ghas-api"
  | "ghas-mcp"
  | "mesh-hub"
  | "brand"
  | "bench-radar";

export type FeatureId =
  | "readyz"
  | "livez"
  | "startupz"
  | "healthz"
  | "version"
  | "features"
  | "status"
  | "peers"
  | "deps"
  | "mesh-graph"
  | "chain-health"
  | "discover"
  | "capabilities"
  | "metrics-lite"
  | "config-public"
  | "whoami"
  | "ping"
  | "ghas-proxy"
  | "routes"
  | "link-check";

export const FEATURE_IDS: FeatureId[] = [
  "readyz",
  "livez",
  "startupz",
  "healthz",
  "version",
  "features",
  "status",
  "peers",
  "deps",
  "mesh-graph",
  "chain-health",
  "discover",
  "capabilities",
  "metrics-lite",
  "config-public",
  "whoami",
  "ping",
  "ghas-proxy",
  "routes",
  "link-check",
];

if (FEATURE_IDS.length !== 20) {
  throw new Error(`expected 20 features, got ${FEATURE_IDS.length}`);
}

export type ServiceMeta = {
  id: MeshServiceId;
  portEnv: string;
  healthPath: string;
  role: string;
  ghas_borrow: string;
};

/** Catalog of estate services participating in the mesh */
export function serviceCatalog(): ServiceMeta[] {
  return [
    {
      id: "herd",
      portEnv: "HERD_PORT",
      healthPath: "/health",
      role: "llm-front-door",
      ghas_borrow: "openai-compat + models/sse keep-alive",
    },
    {
      id: "rust-web",
      portEnv: "RUST_WEB_PORT",
      healthPath: "/health",
      role: "ops-dashboard",
      ghas_borrow: "k8s-style /ops/api/* status surfaces",
    },
    {
      id: "yote",
      portEnv: "YOTE_PORT",
      healthPath: "/health",
      role: "telegram-bot",
      ghas_borrow: "agent health chain + overlord",
    },
    {
      id: "openfang",
      portEnv: "OPENFANG_PORT",
      healthPath: "/api/health",
      role: "agent-kernel",
      ghas_borrow: "multi-provider hand swarm",
    },
    {
      id: "estate-router",
      portEnv: "ESTATE_ROUTER_PORT",
      healthPath: "/health",
      role: "model-router",
      ghas_borrow: "circuit-breaker health DB + sticky sessions",
    },
    {
      id: "prometheus",
      portEnv: "PROMETHEUS_PORT",
      healthPath: "/-/ready",
      role: "metrics",
      ghas_borrow: "prom ready/live endpoints",
    },
    {
      id: "hf-downloader",
      portEnv: "HF_DOWNLOADER_PORT",
      healthPath: "/",
      role: "model-fetch",
      ghas_borrow: "bodaay HFD hub layout",
    },
    {
      id: "null-g-proxy",
      portEnv: "NULL_G_PROXY_PORT",
      healthPath: "/health",
      role: "edge-proxy",
      ghas_borrow: "feature-flag health banner",
    },
    {
      id: "grafana",
      portEnv: "GRAFANA_PORT",
      healthPath: "/api/health",
      role: "dashboards",
      ghas_borrow: "observability mesh leaf",
    },
    {
      id: "ghas-api",
      portEnv: "GHAS_API_PORT",
      healthPath: "/health",
      role: "github-search-api",
      ghas_borrow: "dual-engine code search + packs",
    },
    {
      id: "ghas-mcp",
      portEnv: "GHAS_MCP_PORT",
      healthPath: "/health",
      role: "github-search-mcp",
      ghas_borrow: "MCP stdio+http tool surface",
    },
    {
      id: "mesh-hub",
      portEnv: "MESH_HUB_PORT",
      healthPath: "/health",
      role: "mesh-orchestrator",
      ghas_borrow: "service-discovery hub + chain-health",
    },
    {
      id: "brand",
      portEnv: "BRAND_PORT",
      healthPath: "/health",
      role: "build-server",
      ghas_borrow: "disk-backed build queue + worker pool",
    },
    {
      id: "bench-radar",
      portEnv: "BENCH_RADAR_PORT",
      healthPath: "/health",
      role: "benchmark-regression-radar",
      ghas_borrow: "rolling median/MAD change-point detection + reactive WS push",
    },
  ];
}

export function urlFor(meta: ServiceMeta, path = ""): string {
  const port = requirePort(meta.portEnv);
  const p = path.startsWith("/") ? path : path ? `/${path}` : "";
  return `http://127.0.0.1:${port}${p}`;
}

const startedAt = Date.now();

async function probe(
  url: string,
  timeoutMs = 1200,
): Promise<{ ok: boolean; status: number; ms: number; body?: string }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // Avoid brotli/zlib traps when mesh-front re-proxies compressed backends
      headers: { "accept-encoding": "identity", accept: "*/*" },
    });
    const body = (await res.text()).slice(0, 240);
    return {
      ok: res.ok,
      status: res.status,
      ms: Math.round(performance.now() - t0),
      body,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Math.round(performance.now() - t0),
      body: String(e).slice(0, 160),
    };
  }
}

export type MeshCtx = {
  service: MeshServiceId;
  /** optional local health check override */
  localHealthy?: () => boolean | Promise<boolean>;
  version?: string;
  extra?: Record<string, unknown>;
};

function baseMeta(ctx: MeshCtx): ServiceMeta {
  const m = serviceCatalog().find((s) => s.id === ctx.service);
  if (!m) throw new Error(`unknown mesh service ${ctx.service}`);
  return m;
}

/** Execute one of the 20 features for a service context */
export async function runFeature(
  feature: FeatureId,
  ctx: MeshCtx,
  url?: URL,
): Promise<{ status: number; body: unknown }> {
  const self = baseMeta(ctx);
  const cat = serviceCatalog();
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const localOk = ctx.localHealthy ? await ctx.localHealthy() : true;

  switch (feature) {
    case "readyz": {
      const ok = localOk;
      return {
        status: ok ? 200 : 503,
        body: { feature, service: ctx.service, ready: ok, ghas: "k8s-readyz" },
      };
    }
    case "livez":
      return {
        status: 200,
        body: { feature, service: ctx.service, live: true, pid: process.pid },
      };
    case "startupz":
      return {
        status: uptime > 0 ? 200 : 503,
        body: {
          feature,
          service: ctx.service,
          started: true,
          uptime_s: uptime,
        },
      };
    case "healthz": {
      const p = await probe(urlFor(self, self.healthPath));
      return {
        status: p.ok ? 200 : 503,
        body: {
          feature,
          service: ctx.service,
          healthy: p.ok,
          probe: p,
          role: self.role,
        },
      };
    }
    case "version":
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          version: ctx.version || process.env.ESTATE_VERSION || "mesh-1.0.0",
          node: process.version,
          bun: typeof Bun !== "undefined" ? Bun.version : null,
        },
      };
    case "features":
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          count: FEATURE_IDS.length,
          features: FEATURE_IDS,
          ghas_origin:
            "kubernetes apiserver ready/live + GHAS dual-engine search mesh",
        },
      };
    case "status":
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          role: self.role,
          port: requirePort(self.portEnv),
          uptime_s: uptime,
          local_ok: localOk,
          ghas_borrow: self.ghas_borrow,
          extra: ctx.extra || {},
        },
      };
    case "peers": {
      const peers = cat
        .filter((s) => s.id !== ctx.service)
        .map((s) => ({
          id: s.id,
          url: urlFor(s),
          mesh: `${urlFor(s)}/mesh/features`,
          role: s.role,
        }));
      return {
        status: 200,
        body: { feature, service: ctx.service, peers, count: peers.length },
      };
    }
    case "deps": {
      // Link graph edges used by this service
      const edges: Record<MeshServiceId, MeshServiceId[]> = {
        "herd": [],
        "rust-web": ["herd", "hf-downloader", "prometheus"],
        yote: ["openfang", "herd"],
        openfang: ["herd"],
        "estate-router": ["herd"],
        prometheus: [],
        "hf-downloader": [],
        "null-g-proxy": ["herd", "estate-router"],
        grafana: ["prometheus"],
        "ghas-api": ["ghas-mcp"],
        "ghas-mcp": [],
        "mesh-hub": cat.map((c) => c.id).filter((id) => id !== "mesh-hub"),
        "brand": [],
        "bench-radar": [],
      };
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          depends_on: edges[ctx.service] || [],
        },
      };
    }
    case "mesh-graph": {
      const nodes = cat.map((s) => ({
        id: s.id,
        port: Number(process.env[s.portEnv] || 0),
        role: s.role,
      }));
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          nodes,
          edges_note: "see /mesh/deps on each node",
        },
      };
    }
    case "chain-health": {
      const results: Record<string, unknown> = {};
      let all = true;
      await Promise.all(
        cat.map(async (s) => {
          const r = await probe(urlFor(s, s.healthPath));
          results[s.id] = r;
          if (!r.ok && s.id !== "mesh-hub") all = false;
        }),
      );
      return {
        status: all ? 200 : 207,
        body: {
          feature,
          service: ctx.service,
          all_ok: all,
          results,
          ghas: "meshcore-health-check style fan-out",
        },
      };
    }
    case "discover":
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          catalog: cat.map((s) => ({
            id: s.id,
            base: urlFor(s),
            health: urlFor(s, s.healthPath),
            mesh_prefix: `${urlFor(s)}/mesh`,
            role: s.role,
          })),
        },
      };
    case "capabilities":
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          capabilities: {
            mesh: true,
            ghas_linked: true,
            hot_reload: true,
            openai_compat: [
              "herd",
              "estate-router",
              "null-g-proxy",
              "yote",
              "openfang",
            ].includes(ctx.service),
            search: ctx.service.startsWith("ghas"),
          },
        },
      };
    case "metrics-lite":
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          uptime_s: uptime,
          rss: process.memoryUsage?.().rss ?? null,
          pid: process.pid,
        },
      };
    case "config-public":
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          public: {
            port_env: self.portEnv,
            health_path: self.healthPath,
            role: self.role,
            llm_base: process.env.LLM_BASE_URL || null,
            ghas_api: process.env.GHAS_API_PORT
              ? `http://127.0.0.1:${process.env.GHAS_API_PORT}`
              : null,
          },
        },
      };
    case "whoami":
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          host: "127.0.0.1",
          port: requirePort(self.portEnv),
          role: self.role,
          ghas_borrow: self.ghas_borrow,
        },
      };
    case "ping": {
      const echo = url?.searchParams.get("echo") || "pong";
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          echo,
          ts: Date.now(),
        },
      };
    }
    case "ghas-proxy": {
      // Thin link to GHAS HTTP API (feature #18) — real GHAS, not reimplemented
      const q = url?.searchParams.get("q") || "estate mesh";
      const ghasPort = process.env.GHAS_API_PORT || "25112";
      const ghasUrl = `http://127.0.0.1:${ghasPort}/health`;
      const health = await probe(ghasUrl);
      let search: unknown = null;
      if (health.ok && url?.searchParams.get("search") === "1") {
        try {
          const sr = await fetch(
            `http://127.0.0.1:${ghasPort}/api/search?q=${encodeURIComponent(q)}&per_page=3`,
            { signal: AbortSignal.timeout(8000) },
          );
          search = await sr.json().catch(() => ({ status: sr.status }));
        } catch (e) {
          search = { error: String(e) };
        }
      }
      return {
        status: health.ok ? 200 : 503,
        body: {
          feature,
          service: ctx.service,
          ghas_health: health,
          ghas_url: `http://127.0.0.1:${ghasPort}`,
          query: q,
          search,
          note: "Use ?search=1&q=term to fan-out to GHAS API",
        },
      };
    }
    case "routes":
      return {
        status: 200,
        body: {
          feature,
          service: ctx.service,
          routes: FEATURE_IDS.map((f) => `/mesh/${f}`),
          alias: ["/mesh", "/mesh/", "/mesh/features"],
        },
      };
    case "link-check": {
      // Verify bidirectional mesh advertisement for this service + hub
      const hubPort = process.env.MESH_HUB_PORT || "25115";
      const hub = await probe(`http://127.0.0.1:${hubPort}/health`);
      const selfProbe = await probe(urlFor(self, self.healthPath));
      return {
        status: hub.ok && selfProbe.ok ? 200 : 207,
        body: {
          feature,
          service: ctx.service,
          self: selfProbe,
          mesh_hub: hub,
          linked: hub.ok && selfProbe.ok,
        },
      };
    }
    default:
      return { status: 404, body: { error: "unknown feature", feature } };
  }
}

/**
 * Handle HTTP for /mesh and /mesh/{feature}.
 * Returns null if path is not a mesh path (caller continues).
 */
export async function handleMeshRequest(
  req: Request,
  ctx: MeshCtx,
): Promise<Response | null> {
  const u = new URL(req.url);
  const path = u.pathname;
  // strip optional service prefix /mesh/s/{id}/...
  if (!path.startsWith("/mesh")) return null;

  if (path === "/mesh" || path === "/mesh/") {
    const { status, body } = await runFeature("features", ctx, u);
    return json(status, body);
  }

  const rest = path.slice("/mesh/".length).replace(/\/$/, "");
  if (!rest) {
    const { status, body } = await runFeature("features", ctx, u);
    return json(status, body);
  }

  // /mesh/s/{service}/{feature} for hub virtual namespaces
  if (rest.startsWith("s/")) {
    const parts = rest.split("/");
    // s, serviceId, feature?
    const sid = parts[1] as MeshServiceId;
    const feat = (parts[2] || "features") as FeatureId;
    if (!FEATURE_IDS.includes(feat) && feat !== ("features" as FeatureId)) {
      // features is in list
    }
    const f = (
      FEATURE_IDS.includes(feat as FeatureId) ? feat : "features"
    ) as FeatureId;
    const nested: MeshCtx = { ...ctx, service: sid };
    const { status, body } = await runFeature(f, nested, u);
    return json(status, body);
  }

  const feat = rest as FeatureId;
  if (!FEATURE_IDS.includes(feat)) {
    return json(404, {
      error: "unknown mesh feature",
      path,
      known: FEATURE_IDS,
    });
  }
  const { status, body } = await runFeature(feat, ctx, u);
  return json(status, body);
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "x-estate-mesh": "ghas-20",
    },
  });
}

/** Hono-compatible mount helper */
export function meshFetchFor(ctx: MeshCtx) {
  return async (req: Request): Promise<Response | null> =>
    handleMeshRequest(req, ctx);
}
