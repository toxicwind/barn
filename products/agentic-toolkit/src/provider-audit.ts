/**
 * Provider Audit Module — reusable, importable tool for LLM provider health checks
 * 
 * Usage:
 *   import { auditProviders, testProvider, ProviderResult } from './provider-audit.ts';
 *   const results = await auditProviders({ keys: secretsmithEnv() });
 */

import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  keyEnv: string;
  auth: "bearer" | "none" | "static";
  adapter: "openai" | "static" | "google";
  modelsEndpoint?: string;
  chatEndpoint?: string;
  embeddingsEndpoint?: string;
  authHeader?: "Authorization" | "x-api-key" | "api-key";
}

export interface EndpointResult {
  status: "working" | "auth-failed" | "endpoint-error" | "entitlement-gated" | "no-models";
  httpStatus: number;
  modelsCount: number;
  latencyMs: number;
  error?: string;
}

export interface ProviderResult {
  provider: string;
  status: "working" | "auth-failed" | "endpoint-error" | "entitlement-gated" | "no-models";
  httpStatus: number;
  modelsCount: number;
  latencyMs: number;
  error?: string;
  rawResponse?: string;
  endpoints: {
    models?: EndpointResult;
    chat?: EndpointResult;
    embeddings?: EndpointResult;
  };
}

export interface AuditOptions {
  keys: Record<string, string>;
  timeoutMs?: number;
  testEndpoints?: ("models" | "chat" | "embeddings")[];
  providers?: ProviderConfig[];
}

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    name: "freeinference",
    baseUrl: "https://freeinference.org/v1",
    keyEnv: "FREEINFERENCE_API_KEY",
    auth: "bearer",
    adapter: "openai",
    modelsEndpoint: "/models",
    chatEndpoint: "/chat/completions",
    embeddingsEndpoint: "/embeddings",
  },
  {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    auth: "bearer",
    adapter: "openai",
    modelsEndpoint: "/models",
    chatEndpoint: "/chat/completions",
  },
  {
    name: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    auth: "bearer",
    adapter: "openai",
    modelsEndpoint: "/models",
    chatEndpoint: "/chat/completions",
  },
  {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
    auth: "bearer",
    adapter: "openai",
    modelsEndpoint: "/models",
    chatEndpoint: "/chat/completions",
  },
  {
    name: "google",
    baseUrl: "http://127.0.0.1:25109/gemini-eap-interactions",
    keyEnv: "",
    auth: "none",
    adapter: "static",
    chatEndpoint: "",
  },
  {
    name: "github",
    baseUrl: "https://models.github.ai/inference",
    keyEnv: "GITHUB_TOKEN",
    auth: "bearer",
    adapter: "openai",
    modelsEndpoint: "/models",
    chatEndpoint: "/chat/completions",
  },
  {
    name: "parasail",
    baseUrl: "https://api.parasail.io/v1",
    keyEnv: "PARASAIL_API_KEY",
    auth: "bearer",
    adapter: "openai",
    modelsEndpoint: "/models",
    chatEndpoint: "/chat/completions",
  },
  {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    auth: "bearer",
    adapter: "openai",
    modelsEndpoint: "/models",
    chatEndpoint: "/chat/completions",
  },
  {
    name: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY",
    auth: "bearer",
    adapter: "openai",
    modelsEndpoint: "/models",
    chatEndpoint: "/chat/completions",
  },
  {
    name: "together",
    baseUrl: "https://api.together.xyz/v1",
    keyEnv: "TOGETHER_API_KEY",
    auth: "bearer",
    adapter: "openai",
    modelsEndpoint: "/models",
    chatEndpoint: "/chat/completions",
  },
];

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function buildHeaders(provider: ProviderConfig, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; ProviderAudit/1.0)",
  };
  
  if (provider.auth === "bearer" && key) {
    const headerName = provider.authHeader || "Authorization";
    headers[headerName] = `Bearer ${key}`;
  }
  return headers;
}

async function testEndpoint(
  provider: ProviderConfig,
  key: string,
  endpoint: string,
  method: "GET" | "POST",
  body?: any,
  timeoutMs = 15000
): Promise<{ status: number; data: any; latencyMs: number; error?: string }> {
  const url = `${provider.baseUrl}${endpoint}`;
  const start = performance.now();
  
  try {
    const res = await fetchWithTimeout(url, {
      method,
      headers: buildHeaders(provider, key),
      body: body ? JSON.stringify(body) : undefined,
    }, timeoutMs);
    
    const latencyMs = performance.now() - start;
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    
    return { status: res.status, data, latencyMs };
  } catch (e) {
    return { 
      status: 0, 
      data: null, 
      latencyMs: performance.now() - start, 
      error: e instanceof Error ? e.message : String(e) 
    };
  }
}

function analyzeResult(provider: ProviderConfig, _key: string, endpointType: string, result: any): EndpointResult {
  const { status, data, latencyMs, error } = result;
  
  if (error) return { status: "endpoint-error", httpStatus: 0, modelsCount: 0, latencyMs, error };
  
  if (status === 401 || status === 403) {
    return { status: "auth-failed", httpStatus: status, modelsCount: 0, latencyMs, error: "Authentication failed" };
  }
  
  if (status >= 500) {
    return { status: "endpoint-error", httpStatus: status, modelsCount: 0, latencyMs, error: `HTTP ${status}` };
  }
  
  if (endpointType === "models") {
    const models = data?.data || data?.models || [];
    if (models.length === 0) {
      return { status: "no-models", httpStatus: status, modelsCount: 0, latencyMs, error: "No models returned" };
    }
    if (provider.name === "nvidia" && models.length > 0) {
      return { status: "entitlement-gated", httpStatus: status, modelsCount: models.length, latencyMs };
    }
    return { status: "working", httpStatus: status, modelsCount: models.length, latencyMs };
  }
  
  if (endpointType === "chat") {
    const finishReason = data?.choices?.[0]?.finish_reason;
    if (finishReason === "length") {
      return { status: "endpoint-error", httpStatus: status, modelsCount: 0, latencyMs, error: "finish_reason: length (max_tokens too low)" };
    }
    return { status: "working", httpStatus: status, modelsCount: 1, latencyMs };
  }
  
  if (endpointType === "embeddings") {
    const dims = data?.data?.[0]?.embedding?.length || 0;
    return { status: dims > 0 ? "working" : "endpoint-error", httpStatus: status, modelsCount: 1, latencyMs, error: dims > 0 ? undefined : "No embeddings returned" };
  }
  
  return { status: "working", httpStatus: status, modelsCount: 0, latencyMs };
}

export async function auditProviders(options: AuditOptions): Promise<ProviderResult[]> {
  const { keys, timeoutMs = 15000, testEndpoints = ["models", "chat", "embeddings"], providers = DEFAULT_PROVIDERS } = options;
  
  const results: ProviderResult[] = [];
  
  for (const provider of providers) {
    const key = provider.keyEnv ? keys[provider.keyEnv] : "";
    const endpoints: ProviderResult["endpoints"] = {};
    
    if (testEndpoints.includes("models") && provider.modelsEndpoint) {
      const res = await testEndpoint(provider, key, provider.modelsEndpoint, "GET", undefined, timeoutMs);
      endpoints.models = analyzeResult(provider, key, "models", res);
    }
    
    if (testEndpoints.includes("chat") && provider.chatEndpoint) {
      const res = await testEndpoint(provider, key, provider.chatEndpoint, "POST", {
        model: provider.name === "freeinference" ? "qwen3.6-35b" : "test",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 10,
      }, timeoutMs);
      endpoints.chat = analyzeResult(provider, key, "chat", res);
    }
    
    if (testEndpoints.includes("embeddings") && provider.embeddingsEndpoint) {
      const res = await testEndpoint(provider, key, provider.embeddingsEndpoint, "POST", {
        model: "bge-m3",
        input: ["test"],
      }, timeoutMs);
      endpoints.embeddings = analyzeResult(provider, key, "embeddings", res);
    }
    
    const workingEndpoints = Object.values(endpoints).filter(e => e?.status === "working").length;
    const totalEndpoints = Object.values(endpoints).filter(e => e).length;
    
    let overallStatus: ProviderResult["status"] = "working";
    if (workingEndpoints === 0) overallStatus = "auth-failed";
    else if (workingEndpoints < totalEndpoints) overallStatus = "endpoint-error";
    
    results.push({
      provider: provider.name,
      status: overallStatus,
      httpStatus: endpoints.models?.httpStatus || 0,
      modelsCount: endpoints.models?.modelsCount || 0,
      latencyMs: Math.min(...Object.values(endpoints).map(e => e?.latencyMs || Infinity)),
      endpoints,
    });
  }
  
  return results;
}

export async function loadSecretsmithKeys(): Promise<Record<string, string>> {
  try {
    const { execSync } = await import("child_process");
    const output = execSync("secretsmith env 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
    const keys: Record<string, string> = {};
    for (const line of output.split("\n")) {
      const match = line.match(/^([A-Z_]+)=['"]?([^'"]*)['"]?$/);
      if (match) keys[match[1]] = match[2];
    }
    return keys;
  } catch {
    return {};
  }
}

export async function loadTauConfig(): Promise<any> {
  try {
    const content = await readFile("/home/toxic/.tau/agent/config.yml", "utf-8");
    return parse(content);
  } catch {
    return {};
  }
}

// CLI entry point
if (import.meta.main) {
  const keys = await loadSecretsmithKeys();
  console.log(`Loaded ${Object.keys(keys).length} keys from secretsmith`);
  
  const results = await auditProviders({ keys });
  
  console.log("\n=== PROVIDER AUDIT RESULTS ===\n");
  for (const r of results) {
    const statusIcon = r.status === "working" ? "✅" : r.status === "entitlement-gated" ? "⚠️" : "❌";
    console.log(`${statusIcon} ${r.provider}: ${r.status} (${r.modelsCount} models, ${r.latencyMs.toFixed(0)}ms)`);
    if (r.endpoints.models) console.log(`    models: ${r.endpoints.models.status} (HTTP ${r.endpoints.models.httpStatus})`);
    if (r.endpoints.chat) console.log(`    chat: ${r.endpoints.chat.status} (HTTP ${r.endpoints.chat.httpStatus})`);
    if (r.endpoints.embeddings) console.log(`    embeddings: ${r.endpoints.embeddings.status} (HTTP ${r.endpoints.embeddings.httpStatus})`);
  }
  
  const working = results.filter(r => r.status === "working");
  console.log(`\nWorking: ${working.length}/${results.length} providers`);
  process.exit(working.length > 0 ? 0 : 1);
}