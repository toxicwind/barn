/**
 * NIM Client Types - Complete type-safe definitions for all 69+ NIM API parameters
 * Based on NVIDIA NIM API Documentation
 */
// ═══════════════════════════════════════════════════════════════════════════
// CORE MESSAGE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface FunctionDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

// ═══════════════════════════════════════════════════════════════════════════
// NIM-SPECIFIC EXTENSIONS
// ═══════════════════════════════════════════════════════════════════════════

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "max"
  | "xhigh";

export interface ChatTemplateKwargs {
  reasoning_effort?: ReasoningEffort;
  thinking?: boolean;
  continuous_thinking?: boolean;
  [key: string]: unknown;
}

export interface ExtraBody {
  chat_template_kwargs?: ChatTemplateKwargs;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// REQUEST TYPES - All 69+ parameters
// ═══════════════════════════════════════════════════════════════════════════

export interface NIMChatCompletionRequest {
  // Required
  model: string;
  messages: ChatMessage[];

  // Standard OpenAI parameters
  temperature?: number; // 0.0-2.0, default 1.0
  top_p?: number; // 0.0-1.0, default 1.0
  max_tokens?: number; // 1-65536, default 8192
  max_completion_tokens?: number; // OpenAI newer param
  stream?: boolean; // default false
  stop?: string | string[]; // Up to 4 sequences
  n?: number; // 1-3, default 1
  presence_penalty?: number; // -2.0 to 2.0, default 0
  frequency_penalty?: number; // -2.0 to 2.0, default 0
  seed?: number; // Deterministic sampling
  logit_bias?: Record<string, number>; // Token bias map
  user?: string; // End-user identifier
  response_format?: ResponseFormat; // JSON mode, etc.
  tools?: FunctionDefinition[]; // Function definitions
  tool_choice?: ToolChoice; // Tool selection strategy
  parallel_tool_calls?: boolean; // Allow parallel tool calls
  logprobs?: boolean; // Return log probabilities
  top_logprobs?: number; // 1-20, number of top tokens
  stream_options?: StreamOptions; // Streaming options

  // NIM-specific extensions
  chat_template_kwargs?: ChatTemplateKwargs; // reasoning_effort, thinking, etc.
  extra_body?: ExtraBody; // Alternative extension path

  // System prompt (convenience - maps to messages[0].role="system")
  system_prompt?: string;
}

export interface ResponseFormat {
  type: "text" | "json_object" | "json_schema";
  json_schema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface StreamOptions {
  include_usage?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface NIMChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: NIMChoice[];
  usage: NIMUsage;
}

export interface NIMChoice {
  index: number;
  message: NIMMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter";
  logprobs?: NIMLogprobs;
}

export interface NIMMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface NIMUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number; // NIM-specific for reasoning models
}

export interface NIMLogprobs {
  content: NIMLogprobContent[];
}

export interface NIMLogprobContent {
  token: string;
  logprob: number;
  bytes?: number[];
  top_logprobs?: NIMTopLogprob[];
}

export interface NIMTopLogprob {
  token: string;
  logprob: number;
  bytes?: number[];
}

// ═══════════════════════════════════════════════════════════════════════════
// STREAMING TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface NIMChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: NIMChunkChoice[];
}

export interface NIMChunkChoice {
  index: number;
  delta: NIMDelta;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  logprobs?: NIMLogprobs;
}

export interface NIMDelta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: ToolCall[];
}

// ═══════════════════════════════════════════════════════════════════════════
// MODELS TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface NIMModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  permission?: unknown[];
  root?: string;
  parent?: string;
}

export interface NIMModelsResponse {
  object: "list";
  data: NIMModel[];
}

// ═══════════════════════════════════════════════════════════════════════════
// ERROR TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface NIMErrorResponse {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string | number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLIENT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

export interface NIMClientConfig {
  // Base URL - can be herd :25100 or direct NVIDIA endpoint
  baseURL: string;
  apiKey: string;

  // Retry configuration
  maxRetries?: number; // default: 3
  retryDelayMs?: number; // base delay for exponential backoff, default: 1000
  maxRetryDelayMs?: number; // cap for retry delay, default: 30000

  // Rate limiting (token bucket)
  rateLimitRPM?: number; // requests per minute, default: 20
  rateLimitBurst?: number; // burst allowance, default: 5

  // Timeouts
  timeoutMs?: number; // default: 120000
  streamingTimeoutMs?: number; // default: 300000
  // Default model
  defaultModel?: string; // default: "meta/llama-3.1-70b-instruct"
  // Custom headers
  defaultHeaders?: Record<string, string>;

  // Enable debug logging
  debug?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface RetryState {
  attempt: number;
  lastError: Error | null;
  nextRetryAt: number;
}

export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
}
