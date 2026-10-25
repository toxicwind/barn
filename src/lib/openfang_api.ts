import { OpenFangInterceptor } from "../../yote/src/lib/openfang";

export interface OfAgent {
  id: string;
  name: string;
  state?: string;
  ready?: boolean;
  model_name?: string;
  model_provider?: string;
  last_active?: string;
}

export interface OfChatResult {
  ok: boolean;
  agent: string;
  model: string;
  content: string;
  error?: string;
  raw?: unknown;
  ms: number;
  fasterRouteAttempted?: boolean;
  fallbackUsed?: string;
}

export interface RouteOption {
  agent: string;
  model: string;
  max_tokens: number;
  temperature: number;
  timeoutMs: number;
  label: string;
}

export class OpenFangClient {
  constructor(
    private baseUrl: string,
    private apiKey: string = process.env.OPENFANG_API_KEY || "",
    private defaultAgent: string = "coyote",
    private defaultRouteChain: RouteOption[] = [
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
    ],
  ) {
    this.interceptor = new OpenFangInterceptor(baseUrl, { apiKey });
  }

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
      const data = (await res.json()) as unknown;
      if (Array.isArray(data)) {
        return { ok: true, agents: data as OfAgent[] };
      }
      if (
        data &&
        typeof data === "object" &&
        "agents" in data &&
        Array.isArray((data as { agents: unknown }).agents)
      ) {
        return { ok: true, agents: (data as { agents: OfAgent[] }).agents };
      }
      return { ok: true, agents: [] };
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
      const data = (await res.json()) as unknown;
      if (
        data &&
        typeof data === "object" &&
        "data" in data &&
        Array.isArray((data as { data: unknown }).data)
      ) {
        const items = (data as { data: unknown[] }).data;
        const models: string[] = [];
        for (const item of items) {
          if (
            typeof item === "object" &&
            item !== null &&
            "id" in item &&
            typeof (item as { id: unknown }).id === "string"
          ) {
            models.push((item as { id: string }).id);
          }
        }
        return models;
      }
      return [];
    } catch {
      return [];
    }
  }

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
    const routeChain = opts.routeChain || this.defaultRouteChain;
    const t0 = performance.now();
    const messages = opts.system
      ? [
          { role: "system", content: opts.system },
          { role: "user", content: text },
        ]
      : [{ role: "user", content: text }];

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
        const raw = (await res.json().catch(() => null)) as unknown;

        let content = "";
        if (
          raw &&
          typeof raw === "object" &&
          "choices" in raw &&
          Array.isArray((raw as { choices: unknown[] }).choices)
        ) {
          const choices = (raw as { choices: unknown[] }).choices;
          if (
            choices.length > 0 &&
            typeof choices[0] === "object" &&
            choices[0] !== null
          ) {
            const choice = choices[0] as { message?: unknown; text?: string };
            if (
              choice.message &&
              typeof choice.message === "object" &&
              "content" in choice.message &&
              typeof (choice.message as { content: unknown }).content ===
                "string"
            ) {
              content = (choice.message as { content: string }).content;
            } else if (typeof choice.text === "string") {
              content = choice.text;
            }
          }
        }

        const _routeMs = Math.round(performance.now() - routeT0);
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

        if (i < routeChain.length - 1) continue;

        let errorMessage = `HTTP ${res.status}`;
        if (raw && typeof raw === "object" && "error" in raw) {
          const error = (raw as { error: unknown }).error;
          if (typeof error === "string") errorMessage = error;
          else if (
            error &&
            typeof error === "object" &&
            "message" in error &&
            typeof (error as { message: unknown }).message === "string"
          )
            errorMessage = (error as { message: string }).message;
        }

        return {
          ok: false,
          agent,
          model: route.model,
          content: "",
          error: errorMessage,
          raw,
          ms: totalMs,
          fasterRouteAttempted: i > 0,
          fallbackUsed: i > 0 ? route.label : undefined,
        };
      } catch (e) {
        const totalMs = Math.round(performance.now() - t0);
        if (i < routeChain.length - 1) continue;
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
}
