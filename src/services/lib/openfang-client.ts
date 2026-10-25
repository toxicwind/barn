/**
 * OpenFang external API client for Yote.
 *
 * Yote talks to OpenFang ONLY over HTTP (public mesh port :25103), never by
 * sharing OpenFang process env / internal secrets. Auth: optional Bearer from
 * OPENFANG_API_KEY if OpenFang has api_key configured.
 */
export type OfAgent = {
  id: string;
  name: string;
  state?: string;
  ready?: boolean;
  model_name?: string;
  model_provider?: string;
  last_active?: string;
};

export type OfChatResult = {
  ok: boolean;
  agent: string;
  model: string;
  content: string;
  error?: string;
  raw?: unknown;
  ms: number;
  fasterRouteAttempted?: boolean;
  fallbackUsed?: string;
};

export type RouteOption = {
  agent: string;
  model: string;
  max_tokens: number;
  temperature: number;
  timeoutMs: number;
  label: string;
};

const DEFAULT_BASE =
  process.env.OPENFANG_URL?.replace(/\/$/, "") || "http://127.0.0.1:25103";

/** Universal 20s timeout for "find faster route" — first-class operation */
const _UNIVERSAL_ROUTE_TIMEOUT_MS = 20_000;

/** Default route chain: try fast local models first, then escalate */
const DEFAULT_ROUTE_CHAIN: RouteOption[] = [
  {
    agent: "coyote",
    model: "openfang:coyote",
    max_tokens: 512,
    temperature: 0.3,
    timeoutMs: 8000,
    label: "fast-local",
  },
  {
    agent: "coyote",
    model: "openfang:coyote",
    max_tokens: 1024,
    temperature: 0.4,
    timeoutMs: 15000,
    label: "balanced",
  },
  {
    agent: "coyote",
    model: "openfang:coyote",
    max_tokens: 2048,
    temperature: 0.5,
    timeoutMs: 30000,
    label: "thorough",
  },
];

export class OpenFangClient {
  constructor(
    public baseUrl = DEFAULT_BASE,
    public apiKey = process.env.OPENFANG_API_KEY || "",
    public defaultAgent = process.env.YOTE_OPENFANG_AGENT ||
      process.env.DEFAULT_MODEL?.replace(/^openfang:/, "") ||
      "coyote",
    public routeChain: RouteOption[] = DEFAULT_ROUTE_CHAIN,
  ) {}

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Accept-Encoding": "identity",
    };
    if (json) h["Content-Type"] = "application/json";
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async health(): Promise<{ ok: boolean; body: unknown; ms: number }> {
    const t0 = performance.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        headers: this.headers(false),
        signal: AbortSignal.timeout(4000),
      });
      const body = await res.json().catch(() => ({ status: res.status }));
      return {
        ok: res.ok,
        body,
        ms: Math.round(performance.now() - t0),
      };
    } catch (e) {
      return {
        ok: false,
        body: { error: String(e) },
        ms: Math.round(performance.now() - t0),
      };
    }
  }

  async listAgents(): Promise<{
    ok: boolean;
    agents: OfAgent[];
    error?: string;
  }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/agents`, {
        headers: this.headers(false),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return { ok: false, agents: [], error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as OfAgent[] | { agents: OfAgent[] };
      const agents = Array.isArray(data) ? data : data.agents || [];
      return { ok: true, agents };
    } catch (e) {
      return { ok: false, agents: [], error: String(e) };
    }
  }

  async listOpenAiModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.headers(false),
        signal: AbortSignal.timeout(5000),
      });
      const data: any = await res.json();
      return (data?.data || []).map((m: any) => m.id as string);
    } catch {
      return [];
    }
  }

  /** Chat a named OpenFang agent via OpenAI-compat surface openfang:<name> */
  async chat(
    text: string,
    opts: {
      agent?: string;
      max_tokens?: number;
      temperature?: number;
      system?: string;
      routeChain?: RouteOption[];
    } = {},
  ): Promise<OfChatResult> {
    const agent = (opts.agent || this.defaultAgent).replace(/^openfang:/, "");
    const routeChain = opts.routeChain || this.routeChain;
    const t0 = performance.now();
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: text });

    // Universal "find faster route" - try each route in chain with timeout
    for (let i = 0; i < routeChain.length; i++) {
      const route = routeChain[i];
      const routeT0 = performance.now();

      try {
        const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({
            model: route.model,
            messages,
            max_tokens: route.max_tokens,
            temperature: route.temperature,
          }),
          signal: AbortSignal.timeout(route.timeoutMs),
        });
        const raw: any = await res.json().catch(() => null);
        const content =
          raw?.choices?.[0]?.message?.content || raw?.choices?.[0]?.text || "";

        const routeMs = Math.round(performance.now() - routeT0);
        const totalMs = Math.round(performance.now() - t0);

        if (res.ok && String(content).trim()) {
          return {
            ok: true,
            agent,
            model: route.model,
            content: String(content).trim(),
            raw,
            ms: totalMs,
            fasterRouteAttempted: i > 0,
            fallbackUsed: i > 0 ? route.label : undefined,
          };
        }

        // If this route failed but we have more routes, continue to next
        if (i < routeChain.length - 1) {
          console.log(
            `[openfang-client] Route ${route.label} failed (${routeMs}ms), trying next...`,
          );
          continue;
        }

        // Last route failed - return error
        return {
          ok: false,
          agent,
          model: route.model,
          content: "",
          error: raw?.error?.message || raw?.error || `HTTP ${res.status}`,
          raw,
          ms: totalMs,
          fasterRouteAttempted: i > 0,
          fallbackUsed: i > 0 ? route.label : undefined,
        };
      } catch (e) {
        const routeMs = Math.round(performance.now() - routeT0);
        const totalMs = Math.round(performance.now() - t0);

        // If this route timed out or errored but we have more routes, continue
        if (i < routeChain.length - 1) {
          console.log(
            `[openfang-client] Route ${route.label} error (${routeMs}ms): ${String(e)}, trying next...`,
          );
          continue;
        }

        // Last route failed - return error
        return {
          ok: false,
          agent,
          model: route.model,
          content: "",
          error: String(e),
          ms: totalMs,
          fasterRouteAttempted: i > 0,
          fallbackUsed: i > 0 ? route.label : undefined,
        };
      }
    }

    // Should never reach here, but TypeScript needs it
    return {
      ok: false,
      agent,
      model: "openfang:coyote",
      content: "",
      error: "All routes exhausted",
      ms: Math.round(performance.now() - t0),
      fasterRouteAttempted: true,
      fallbackUsed: "exhausted",
    };
  }

  /**
   * Probe every agent that is ready/running with a tiny ping.
   * Returns per-agent results (does not fail-fast).
   */
  async probeAllAgents(
    prompt = "Reply with exactly: AGENT_OK",
    maxTokens = 32,
  ): Promise<{
    total: number;
    pass: number;
    fail: number;
    results: Array<OfChatResult & { state?: string; ready?: boolean }>;
  }> {
    const { agents } = await this.listAgents();
    const results: Array<OfChatResult & { state?: string; ready?: boolean }> =
      [];
    for (const a of agents) {
      // Only probe agents that claim ready/running
      if (a.ready === false && a.state && a.state !== "Running") {
        results.push({
          ok: false,
          agent: a.name,
          model: `openfang:${a.name}`,
          content: "",
          error: `skipped state=${a.state} ready=${a.ready}`,
          ms: 0,
          state: a.state,
          ready: a.ready,
        });
        continue;
      }
      const r = await this.chat(prompt, {
        agent: a.name,
        max_tokens: maxTokens,
        temperature: 0,
      });
      results.push({
        ...r,
        state: a.state,
        ready: a.ready,
      });
    }
    const pass = results.filter((r) => r.ok).length;
    return {
      total: results.length,
      pass,
      fail: results.length - pass,
      results,
    };
  }
}

export const openfang = new OpenFangClient();
