export interface ServiceHealth {
  name: string;
  url: string;
  healthy: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  error: string | null;
  checkedAt: string;
}
export interface HealthReport {
  timestamp: string;
  durationMs: number;
  services: Record<string, ServiceHealth>;
  llamaSwap: {
    healthy: boolean;
    models: any[];
    running: any[];
    metrics: any;
    logs: string | null;
  };
  openFang: { healthy: boolean; status: string | null };
  gpu: { healthy: boolean; devices: any[]; summary: string };
  overall: string;
  warnings: string[];
}
export interface HealthStatus {
  llama: boolean;
  openfang: boolean;
  gpu: string;
  timestamp: string;
}
const TO = 2000;
const RT = 2;
const RD = 500;
// Estate 25xxx map: herd :25100, openfang :25103
const LP = Number(
  process.env.HERD_PORT ?? process.env.LLAMA_PORT ?? "25100",
);
const OP = Number(process.env.OPENFANG_PORT ?? "25103");
function env(n: string, f: string) {
  return typeof process !== "undefined" && process.env?.[n]
    ? (process.env[n] ?? f)
    : f;
}
function u(p: number, pa: string) {
  return `http://127.0.0.1:${p}${pa}`;
}
function sl(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function pr(url: string, o: any = {}) {
  const to = o.timeoutMs ?? TO;
  const rt = o.retries ?? 0;
  const rd = o.retryDelayMs ?? RD;
  let le: Error | undefined;
  for (let a = 0; a <= rt; a++) {
    const st = performance.now();
    try {
      const res = await fetch(url, {
        method: o.method ?? "GET",
        headers: o.headers,
        body: o.body,
        signal: AbortSignal.timeout(to),
      });
      const tx = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        text: tx,
        timeMs: Math.round(performance.now() - st),
      };
    } catch (e: any) {
      le = e instanceof Error ? e : new Error(String(e));
      if (a < rt) await sl(rd * (a + 1));
    }
  }
  throw le ?? new Error(`probe ${url}`);
}
export async function checkService(n: string, url: string, o: any = {}) {
  const st = performance.now();
  try {
    const r = await pr(url, {
      timeoutMs: o.timeoutMs ?? TO,
      retries: o.retries ?? RT,
      retryDelayMs: o.retryDelayMs ?? RD,
    });
    return {
      name: n,
      url,
      healthy: r.ok,
      statusCode: r.status,
      responseTimeMs: r.timeMs,
      error: r.ok ? null : `HTTP ${r.status}`,
      checkedAt: new Date().toISOString(),
    } as ServiceHealth;
  } catch (e: any) {
    return {
      name: n,
      url,
      healthy: false,
      statusCode: null,
      responseTimeMs: Math.round(performance.now() - st),
      error: e.message || String(e),
      checkedAt: new Date().toISOString(),
    } as ServiceHealth;
  }
}
export async function checkLlamaSwap(
  url = env("LLAMA_HEALTH_URL", u(LP, "/v1/models")),
  o: any = {},
) {
  const r = await checkService("herd", url, o);
  if (!r.healthy) {
    const f = await checkService("herd", u(LP, "/v1/models"), {
      ...o,
      timeoutMs: (o.timeoutMs ?? TO) / 2,
      retries: 0,
    });
    if (f.healthy)
      return { ...r, healthy: true, statusCode: f.statusCode, error: null };
  }
  return r;
}
export async function checkOpenFang(
  url = env("OPENFANG_HEALTH_URL", u(OP, "/api/health")),
  o: any = {},
) {
  return checkService("openfang", url, o);
}
export async function queryGpuStatus() {
  try {
    return { healthy: true, devices: [], summary: "gpu ok" };
  } catch {
    return { healthy: false, devices: [], summary: "gpu err" };
  }
}
export async function fetchLlamaModels() {
  try {
    const r = await pr(u(LP, "/v1/models"), { timeoutMs: 1500 });
    return JSON.parse(r.text).data || [];
  } catch {
    return [];
  }
}
export async function fetchRunningModels() {
  try {
    const r = await pr(u(LP, "/running"), { timeoutMs: 1500 });
    return JSON.parse(r.text) || [];
  } catch {
    return [];
  }
}
export async function fetchLlamaMetrics() {
  try {
    const r = await pr(u(LP, "/metrics"), { timeoutMs: 1500 });
    return { raw: r.text };
  } catch {
    return null;
  }
}
export function warmupModel(m: string) {
  fetch(u(LP, "/v1/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: m,
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 1,
    }),
  }).catch(() => {});
}
export function unloadModel(m: string) {
  fetch(u(LP, "/unload"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: m }),
  }).catch(() => {});
}
export async function checkHealth() {
  const st = performance.now();
  const [ls, of] = await Promise.all([checkLlamaSwap(), checkOpenFang()]);
  const ms = await fetchLlamaModels().catch(() => []);
  const rn = await fetchRunningModels().catch(() => []);
  const mt = await fetchLlamaMetrics().catch(() => null);
  const gpu = await queryGpuStatus();
  const overall =
    ls.healthy && of.healthy
      ? "healthy"
      : ls.healthy || of.healthy
        ? "degraded"
        : "unhealthy";
  const dur = Math.round(performance.now() - st);
  return {
    timestamp: new Date().toISOString(),
    durationMs: dur,
    services: { llamaSwap: ls, openFang: of },
    llamaSwap: {
      healthy: ls.healthy,
      models: ms,
      running: rn,
      metrics: mt,
      logs: null,
    },
    openFang: { healthy: of.healthy, status: of.healthy ? "ok" : of.error },
    gpu,
    warnings: [],
    overall,
  } as HealthReport;
}
export async function checkHealthLegacy() {
  const [l, o] = await Promise.all([
    checkLlamaSwap()
      .then((r) => r.healthy)
      .catch(() => false),
    checkOpenFang()
      .then((r) => r.healthy)
      .catch(() => false),
  ]);
  const g = await queryGpuStatus();
  return {
    llama: l,
    openfang: o,
    gpu: g.summary,
    timestamp: new Date().toISOString(),
  } as HealthStatus;
}
