#!/usr/bin/env bun
/**
 * MCP: herd - env only, no file reads
 * All config via env, no VSCode settings.json reads
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSovereignPorts, requireEnv } from "../lib/ports.ts";

loadSovereignPorts();

// ENV ONLY - no homedir reads
const DEFAULT_BASE = (
  process.env.HERD_BASE ||
  (process.env.LLM_BASE_URL || "").replace(/\/v1\/?$/, "") ||
  `http://127.0.0.1:${requireEnv("HERD_PORT")}`
).replace(/\/$/, "");

const DEFAULT_MODEL = process.env.HERD_MODEL || "beellama/qwen-flash-64k";

function j(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

async function httpJson(
  method: string,
  url: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<{ code: number; parsed: unknown; raw: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body
        ? { Accept: "application/json", "Content-Type": "application/json" }
        : { Accept: "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    return { code: res.status, parsed, raw };
  } catch (e) {
    return { code: 0, parsed: null, raw: `request_failed: ${e}` };
  } finally {
    clearTimeout(t);
  }
}

export async function llamaSwapHealth(baseUrl = DEFAULT_BASE) {
  const base = baseUrl.replace(/\/$/, "");
  const { code, parsed, raw } = await httpJson(
    "GET",
    `${base}/health`,
    undefined,
    5000,
  );
  return { http_status: code, body: parsed ?? raw.slice(0, 500) };
}

export async function llamaSwapModels(baseUrl = DEFAULT_BASE) {
  const base = baseUrl.replace(/\/$/, "");
  const { code, parsed, raw } = await httpJson(
    "GET",
    `${base}/v1/models`,
    undefined,
    10_000,
  );
  if (!parsed || typeof parsed !== "object") {
    return { http_status: code, error: raw.slice(0, 800) };
  }
  const data = (parsed as { data?: Array<Record<string, unknown>> }).data || [];
  const models = data.map((m) => {
    let st: unknown = m.status;
    if (st && typeof st === "object" && st !== null && "value" in st) {
      st = (st as { value: unknown }).value;
    }
    return { id: m.id, status: st };
  });
  return { http_status: code, count: models.length, models };
}

export async function llamaSwapChat(opts: {
  prompt?: string;
  model?: string;
  base_url?: string;
  max_tokens?: number;
  stream?: boolean;
}) {
  const base = (opts.base_url || DEFAULT_BASE).replace(/\/$/, "");
  const model = opts.model || DEFAULT_MODEL;
  const body = {
    model,
    messages: [
      { role: "user", content: opts.prompt ?? "Reply with exactly: OK" },
    ],
    max_tokens: opts.max_tokens ?? 16,
    stream: opts.stream ?? false,
  };
  const { code, parsed, raw } = await httpJson(
    "POST",
    `${base}/v1/chat/completions`,
    body,
    120_000,
  );
  if (!parsed || typeof parsed !== "object") {
    return {
      http_status: code,
      ok: false,
      reason: "non_json_or_empty",
      raw_prefix: raw.slice(0, 600),
    };
  }
  const p = parsed as {
    choices?: Array<{
      message?: { content?: string };
      delta?: { content?: string };
    }>;
    model?: string;
    error?: unknown;
  };
  const choices = p.choices;
  const n = Array.isArray(choices) ? choices.length : 0;
  let content: string | undefined;
  if (n && choices?.[0]) {
    const msg = choices?.[0].message || choices?.[0].delta || {};
    content = msg.content;
  }
  return {
    http_status: code,
    ok: n >= 1 && code === 200,
    choices_count: n,
    model_requested: model,
    model_returned: p.model,
    content_preview: (content || "").slice(0, 200),
    error: p.error,
  };
}

export async function llamaSwapChatStream(opts: {
  prompt?: string;
  model?: string;
  base_url?: string;
  max_tokens?: number;
}) {
  const base = (opts.base_url || DEFAULT_BASE).replace(/\/$/, "");
  const body = {
    model: opts.model || DEFAULT_MODEL,
    messages: [{ role: "user", content: opts.prompt ?? "Say OK" }],
    max_tokens: opts.max_tokens ?? 8,
    stream: true,
  };
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let chunks = 0;
    const samples: string[] = [];
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const obj = JSON.parse(payload);
        if (Array.isArray(obj.choices) && obj.choices.length) {
          chunks++;
          if (samples.length < 3) samples.push(payload.slice(0, 180));
        }
      } catch {}
    }
    return { ok: chunks > 0, sse_chunks_with_choices: chunks, samples };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// NEW: this is what was failing - now requires operation
export async function upstreamServers(opts: {
  operation: "list" | "get" | "health";
  name?: string;
  base_url?: string;
}) {
  const base = (opts.base_url || DEFAULT_BASE).replace(/\/$/, "");
  if (opts.operation === "health") return await llamaSwapHealth(base);
  if (opts.operation === "list") return await llamaSwapModels(base);
  if (opts.operation === "get") {
    const all = await llamaSwapModels(base);
    const found = (all as any).models?.find((m: any) => m.id === opts.name);
    return found
      ? { found }
      : { error: `not found: ${opts.name}`, available: (all as any).models };
  }
  return { error: "invalid operation" };
}

async function mcpMain() {
  const server = new McpServer({
    name: "herd-test",
    version: "2.0.0-env-only",
  });

  server.tool(
    "herd_health",
    "GET {base}/health",
    { base_url: z.string().optional() },
    async ({ base_url }) => ({
      content: [
        {
          type: "text",
          text: j(await llamaSwapHealth(base_url || DEFAULT_BASE)),
        },
      ],
    }),
  );

  server.tool(
    "herd_models",
    "GET {base}/v1/models",
    { base_url: z.string().optional() },
    async ({ base_url }) => ({
      content: [
        {
          type: "text",
          text: j(await llamaSwapModels(base_url || DEFAULT_BASE)),
        },
      ],
    }),
  );

  server.tool(
    "herd_chat",
    "POST chat/completions",
    {
      prompt: z.string().optional(),
      model: z.string().optional(),
      base_url: z.string().optional(),
      max_tokens: z.number().optional(),
      stream: z.boolean().optional(),
    },
    async (args) => ({
      content: [{ type: "text", text: j(await llamaSwapChat(args)) }],
    }),
  );

  server.tool(
    "herd_chat_stream",
    "POST streaming",
    {
      prompt: z.string().optional(),
      model: z.string().optional(),
      base_url: z.string().optional(),
      max_tokens: z.number().optional(),
    },
    async (args) => ({
      content: [{ type: "text", text: j(await llamaSwapChatStream(args)) }],
    }),
  );

  server.tool(
    "upstream_servers",
    "List/check herd upstreams. REQUIRES operation param.",
    {
      operation: z
        .enum(["list", "get", "health"])
        .describe("Required: list, get, or health"),
      name: z.string().optional().describe("Required when operation=get"),
      base_url: z.string().optional(),
    },
    async (args) => ({
      content: [{ type: "text", text: j(await upstreamServers(args as any)) }],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const mode = process.argv[2];
if (mode === "mcp" || (!process.argv[2] && process.stdin.isTTY === false)) {
  await mcpMain();
} else {
  const cmd = process.argv[2] || "mcp";
  if (cmd === "health") console.log(j(await llamaSwapHealth()));
  else if (cmd === "models") console.log(j(await llamaSwapModels()));
  else if (cmd === "e2e")
    console.log(
      j({ models: await llamaSwapModels(), health: await llamaSwapHealth() }),
    );
  else await mcpMain();
}
