#!/usr/bin/env bun
/**
 * exa-mcp-server — Native Estate Exa MCP Server with Agentic JSON/Markdown Repair
 *
 * Exposes:
 *   - exa_search: Neural & keyword search with text contents
 *   - exa_find_similar: Find links semantically similar to a URL
 *   - exa_get_contents: Clean crawl and text extraction
 *
 * Implements Suture/jsonmend style auto-closing and fence-stripping for streaming
 * agent consumers (preventing tool_call argument degradation).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { repairAgenticStream } from "./auto-close-syntax.js";

const EXA_API_KEY = process.env.EXA_API_KEY || "";

async function callExa(endpoint: string, body: Record<string, unknown>) {
  if (!EXA_API_KEY) {
    throw new Error("EXA_API_KEY not configured in environment or keyring.");
  }
  const res = await fetch(`https://api.exa.ai/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": EXA_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Exa API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

const server = new Server(
  { name: "estate-exa-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "exa_search",
      description: "Search the web semantically using Exa neural search with full page content.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          numResults: { type: "number", description: "Number of results (default: 5)" },
          useAutoprompt: { type: "boolean", description: "Use Exa query optimization" },
        },
        required: ["query"],
      },
    },
    {
      name: "exa_find_similar",
      description: "Find web pages semantically similar to a given URL.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Source URL" },
          numResults: { type: "number", description: "Number of results (default: 5)" },
        },
        required: ["url"],
      },
    },
    {
      name: "exa_get_contents",
      description: "Extract clean, markdown-formatted text content from web URLs.",
      inputSchema: {
        type: "object",
        properties: {
          urls: { type: "array", items: { type: "string" }, description: "Array of URLs to crawl" },
        },
        required: ["urls"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  // Agentic repair: unwrap fenced arguments or auto-close broken JSON
  let args = rawArgs;
  if (typeof args === "string") {
    try {
      const { repaired } = repairAgenticStream(args);
      args = JSON.parse(repaired);
    } catch {}
  }

  try {
    if (name === "exa_search") {
      const q = String(args?.query ?? "");
      const numResults = Number(args?.numResults ?? 5);
      const data = await callExa("search", {
        query: q,
        numResults,
        contents: { text: { maxCharacters: 1500 } },
        useAutoprompt: args?.useAutoprompt ?? true,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    if (name === "exa_find_similar") {
      const url = String(args?.url ?? "");
      const numResults = Number(args?.numResults ?? 5);
      const data = await callExa("findSimilar", {
        url,
        numResults,
        contents: { text: { maxCharacters: 1000 } },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    if (name === "exa_get_contents") {
      const urls = (args?.urls as string[]) ?? [];
      const data = await callExa("contents", {
        urls,
        text: true,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Exa MCP Error: ${(err as Error).message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
