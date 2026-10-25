// llama-server.ts — First-class llama.cpp server provider
// NOT an Ollama wrapper. Direct llama-server HTTP API.
// Core primitive: herd (distributed node failover)

export interface LlamaServerConfig {
  baseUrl: string; // e.g., http://awrawr-pc:8080
  model: string; // Model ID (must match --model loaded on server)
  slots?: number; // Parallel slots (-np)
  apiKey?: string; // Optional --api-key
  timeout?: number; // ms
}

export interface LlamaNode {
  id: string;
  baseUrl: string;
  model: string;
  slots: number;
  nCtx: number;
  status: "idle" | "busy" | "dead";
  lastSeen: number;
  latency: number;
  vram?: number;
}

// Mesh: self-healing distributed llama-server pool
export class LlamaMesh {
  private nodes: Map<string, LlamaNode> = new Map();
  private evictionMs: number = 120000;
  private heartbeatMs: number = 30000;

  register(node: LlamaNode): void {
    this.nodes.set(node.id, { ...node, lastSeen: Date.now() });
  }

  heartbeat(id: string): void {
    const n = this.nodes.get(id);
    if (n) {
      n.lastSeen = Date.now();
      n.status = "idle";
    }
  }

  evict(): void {
    const now = Date.now();
    for (const [id, n] of this.nodes) {
      if (now - n.lastSeen > this.evictionMs) {
        console.log(`[0clKiller] Evicting dead llama-server: ${id}`);
        this.nodes.delete(id);
      }
    }
  }

  startEvictionLoop(): void {
    setInterval(() => this.evict(), this.heartbeatMs);
  }

  // herd: pick best node for inference
  swap(model?: string): LlamaNode | undefined {
    const candidates = Array.from(this.nodes.values())
      .filter((n) => n.status === "idle" && (!model || n.model === model))
      .sort((a, b) => a.latency - b.latency);
    return candidates[0];
  }

  markBusy(id: string): void {
    const n = this.nodes.get(id);
    if (n) n.status = "busy";
  }

  markIdle(id: string): void {
    const n = this.nodes.get(id);
    if (n) n.status = "idle";
  }

  all(): LlamaNode[] {
    return Array.from(this.nodes.values());
  }
}

export const mesh = new LlamaMesh();

// Direct llama-server /completion endpoint (NOT Ollama /v1/chat/completions)
export async function llamaComplete(
  cfg: LlamaServerConfig,
  prompt: string,
  opts: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stop?: string[];
  } = {},
): Promise<string> {
  const url = `${cfg.baseUrl}/completion`;
  const body = {
    prompt,
    n_predict: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.7,
    top_p: opts.topP ?? 0.95,
    stop: opts.stop ?? [],
    stream: false,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeout ?? 120000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok)
      throw new Error(`llama-server ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content ?? "";
  } catch (e: any) {
    clearTimeout(t);
    if (e.name === "AbortError")
      throw new Error("llama-server timeout — node dead");
    throw e;
  }
}

// llama-server /v1/chat/completions (OpenAI-compatible mode, if --chat-template enabled)
export async function llamaChat(
  cfg: LlamaServerConfig,
  messages: { role: string; content: string }[],
  opts: { maxTokens?: number; temperature?: number; topP?: number } = {},
): Promise<string> {
  const url = `${cfg.baseUrl}/v1/chat/completions`;
  const body = {
    model: cfg.model,
    messages,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.7,
    top_p: opts.topP ?? 0.95,
    stream: false,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeout ?? 120000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok)
      throw new Error(`llama-server ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  } catch (e: any) {
    clearTimeout(t);
    if (e.name === "AbortError")
      throw new Error("llama-server timeout — node dead");
    throw e;
  }
}

// herd: try nodes until one succeeds
export async function llamaSwap(
  configs: LlamaServerConfig[],
  prompt: string,
  opts?: { maxTokens?: number; temperature?: number },
): Promise<{ content: string; node: LlamaServerConfig }> {
  for (const cfg of configs) {
    try {
      const content = await llamaComplete(cfg, prompt, opts);
      return { content, node: cfg };
    } catch (_err) {
      console.log(`[Swap] ${cfg.baseUrl} failed, next...`);
    }
  }
  throw new Error("All llama-server nodes dead — thread severed");
}

// Health check: /health or /props
export async function llamaHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

// Props: get server metadata (model, n_ctx, etc)
export async function llamaProps(baseUrl: string): Promise<any> {
  const res = await fetch(`${baseUrl}/props`);
  if (!res.ok) throw new Error(`props ${res.status}`);
  return res.json();
}

// Tokenize: /tokenize
export async function llamaTokenize(
  baseUrl: string,
  content: string,
): Promise<number[]> {
  const res = await fetch(`${baseUrl}/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`tokenize ${res.status}`);
  const data = await res.json();
  return data.tokens;
}

// Detokenize: /detokenize
export async function llamaDetokenize(
  baseUrl: string,
  tokens: number[],
): Promise<string> {
  const res = await fetch(`${baseUrl}/detokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokens }),
  });
  if (!res.ok) throw new Error(`detokenize ${res.status}`);
  const data = await res.json();
  return data.content;
}

// Embedding: /embedding
export async function llamaEmbedding(
  baseUrl: string,
  content: string,
): Promise<number[]> {
  const res = await fetch(`${baseUrl}/embedding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}`);
  const data = await res.json();
  return data.embedding;
}
