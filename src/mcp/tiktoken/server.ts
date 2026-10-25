#!/usr/bin/env bun
/**
 * TikToken MCP Server - Dynamic token counting for pi-agent
 * 
 * Provides accurate token counting using tiktoken (OpenAI tokenizer).
 * Supports multiple encodings for different models.
 * Helps with context window management and compaction decisions.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { get_encoding, encoding_for_model } from "tiktoken";

// Model-to-encoding mapping
const MODEL_ENCODINGS: Record<string, string> = {
  // OpenAI models
  "gpt-4o": "o200k_base",
  "gpt-4o-mini": "o200k_base",
  "gpt-4": "cl100k_base",
  "gpt-3.5-turbo": "cl100k_base",
  // Claude models (approximate with cl100k)
  "claude-3": "cl100k_base",
  "claude-3.5": "cl100k_base",
  "claude-3.7": "cl100k_base",
  // Longcat (unknown, use cl100k as default)
  "longcat-2.0-free": "cl100k_base",
  // Default
  "default": "cl100k_base",
};

function getEncoding(model: string) {
  // Try model-specific encoding first
  if (MODEL_ENCODINGS[model]) {
    return get_encoding(MODEL_ENCODINGS[model]);
  }
  // Try tiktoken's built-in model detection
  try {
    return encoding_for_model(model);
  } catch {
    // Fall back to cl100k_base
    return get_encoding("cl100k_base");
  }
}

// Create MCP server
const server = new Server(
  {
    name: "tiktoken",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "count_tokens",
        description: "Count tokens in text using the appropriate tokenizer for the model",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to count tokens for" },
            model: { type: "string", description: "Model name (default: longcat-2.0-free)" },
          },
          required: ["text"],
        },
      },
      {
        name: "estimate_context_usage",
        description: "Estimate how much of the context window is used",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Full conversation text" },
            model: { type: "string", description: "Model name (default: longcat-2.0-free)" },
            context_window: { type: "number", description: "Context window size (default: 1000000)" },
          },
          required: ["text"],
        },
      },
      {
        name: "get_encoding_info",
        description: "Get information about the tokenizer encoding for a model",
        inputSchema: {
          type: "object",
          properties: {
            model: { type: "string", description: "Model name (default: longcat-2.0-free)" },
          },
          required: ["model"],
        },
      },
    ],
  };
});

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const model = (args?.model as string) || "longcat-2.0-free";

  switch (name) {
    case "count_tokens": {
      const text = args?.text as string;
      const enc = getEncoding(model);
      const tokens = enc.encode(text);
      enc.free();
      return {
        content: [{ type: "text", text: JSON.stringify({ token_count: tokens.length, model }) }],
      };
    }
    case "estimate_context_usage": {
      const text = args?.text as string;
      const contextWindow = (args?.context_window as number) || 1000000;
      const enc = getEncoding(model);
      const tokens = enc.encode(text);
      const usage = (tokens.length / contextWindow) * 100;
      enc.free();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            token_count: tokens.length,
            context_window: contextWindow,
            usage_percent: usage.toFixed(2),
            remaining_tokens: contextWindow - tokens.length,
            model,
          }),
        }],
      };
    }
    case "get_encoding_info": {
      const enc = getEncoding(model);
      // Test encoding
      const test = enc.encode("Hello world");
      enc.free();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            model,
            encoding: MODEL_ENCODINGS[model] || "cl100k_base (fallback)",
            test_token_count: test.length,
          }),
        }],
      };
    }
    default:
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[tiktoken] MCP server started (default model: longcat-2.0-free)`);
