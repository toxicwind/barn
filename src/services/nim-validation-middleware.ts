#!/usr/bin/env bun
/**
 * nim-validation-middleware.ts — Parameter validation middleware using Zod schemas
 * Validates incoming requests against NIM API schema before forwarding
 * Uses Zod schemas that match our NIM client library types
 */

import { loadEstatePorts } from "../lib/ports.ts";

loadEstatePorts();

import { z } from "zod";

const PORT = parseInt(
  process.env.NIM_VALIDATION_PORT ?? process.env.NIM_VALIDATION_PORT ?? "25191",
  10,
);
const UPSTREAM =
  process.env.NIM_VALIDATION_UPSTREAM ??
  `http://127.0.0.1:${process.env.HERD_PORT || "25100"}`;

// ──────────────────────────────────────────────────────────────
// ZOD SCHEMAS (matching NIM API spec)
// ──────────────────────────────────────────────────────────────

const MessageRole = z.enum(["system", "user", "assistant", "tool"]);

const ChatMessage = z.object({
  role: MessageRole,
  content: z.union([z.string(), z.null()]),
  name: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
});

const _ToolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const FunctionDefinition = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.unknown()),
    strict: z.boolean().optional(),
  }),
});

const ToolChoice = z.union([
  z.literal("none"),
  z.literal("auto"),
  z.literal("required"),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string() }),
  }),
]);

const ResponseFormat = z.object({
  type: z.enum(["text", "json_object", "json_schema"]),
  json_schema: z
    .object({
      name: z.string(),
      schema: z.record(z.unknown()),
      strict: z.boolean().optional(),
    })
    .optional(),
});

const StreamOptions = z.object({
  include_usage: z.boolean().optional(),
});

const ChatTemplateKwargs = z
  .object({
    reasoning_effort: z
      .enum(["none", "low", "medium", "high", "max", "xhigh"])
      .optional(),
    thinking: z.boolean().optional(),
    continuous_thinking: z.boolean().optional(),
  })
  .passthrough();

const ExtraBody = z
  .object({
    chat_template_kwargs: ChatTemplateKwargs.optional(),
  })
  .passthrough();

const ChatRequest = z.object({
  model: z.string(),
  messages: z.array(ChatMessage).min(1),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).max(65536).optional(),
  max_completion_tokens: z.number().int().min(1).optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  n: z.number().int().min(1).max(3).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  logit_bias: z.record(z.number()).optional(),
  user: z.string().optional(),
  response_format: ResponseFormat.optional(),
  tools: z.array(FunctionDefinition).optional(),
  tool_choice: ToolChoice.optional(),
  parallel_tool_calls: z.boolean().optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().min(1).max(20).optional(),
  stream_options: StreamOptions.optional(),
  chat_template_kwargs: ChatTemplateKwargs.optional(),
  extra_body: ExtraBody.optional(),
  system_prompt: z.string().optional(),
});

type ChatRequest = z.infer<typeof ChatRequest>;

// Stats
const stats = {
  requests: 0,
  valid: 0,
  invalid: 0,
  errors: 0,
  startedAt: Date.now(),
};

// ──────────────────────────────────────────────────────────────
// VALIDATION FUNCTIONS
// ──────────────────────────────────────────────────────────────

function validateChatRequest(body: unknown): {
  valid: boolean;
  errors: string[];
} {
  const result = ChatRequest.safeParse(body);
  if (result.success) {
    return { valid: true, errors: [] };
  }

  if (!result.error?.errors) {
    return { valid: false, errors: ["Unknown validation error"] };
  }

  const errors = result.error.errors.map(
    (e) => `${e.path.join(".")}: ${e.message}`,
  );
  return { valid: false, errors };
}

// ──────────────────────────────────────────────────────────────
// HTTP SERVER
// ──────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK");
    }

    // Stats endpoint
    if (url.pathname === "/admin/stats") {
      return new Response(
        JSON.stringify({
          ...stats,
          uptimeS: Math.floor((Date.now() - stats.startedAt) / 1000),
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }

    // Validation endpoint (standalone validation)
    if (url.pathname === "/v1/validate" && req.method === "POST") {
      try {
        const body = await req.json();
        const result = validateChatRequest(body);
        stats.requests++;
        if (result.valid) {
          stats.valid++;
        } else {
          stats.invalid++;
        }
        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json" },
        });
      } catch (e) {
        stats.errors++;
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
        });
      }
    }

    // Proxy with validation
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      stats.requests++;
      try {
        const body = await req.json();

        // Validate request
        const validation = validateChatRequest(body);
        if (!validation.valid) {
          stats.invalid++;
          return new Response(
            JSON.stringify({
              error: "Validation failed",
              details: validation.errors,
            }),
            {
              status: 422,
              headers: { "content-type": "application/json" },
            },
          );
        }

        stats.valid++;

        // Forward to upstream
        const response = await fetch(
          `${UPSTREAM}${url.pathname}${url.search}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: req.headers.get("Authorization") || "",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180_000),
          },
        );

        return new Response(response.body, {
          status: response.status,
          headers: response.headers,
        });
      } catch (e) {
        stats.errors++;
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
        });
      }
    }

    // Pass through other endpoints
    if (url.pathname.startsWith("/v1/")) {
      const response = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body:
          req.method !== "GET" && req.method !== "HEAD"
            ? await req.text()
            : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      return response;
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(
  `[nim-validation] listening :${server.port} → upstream=${UPSTREAM}`,
);
console.log(`[nim-validation] Zod schemas loaded for validation`);
