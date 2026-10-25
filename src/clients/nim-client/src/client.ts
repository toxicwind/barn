/**
 * NIM Client - Main client for NVIDIA NIM API
 * Supports all 69+ parameters, retry logic, rate limiting, and streaming
 */

import OpenAI from "openai";
import { createRateLimiter, type NIMRateLimiter } from "./rate-limiter.js";
import { createRetryOptions, withRetry } from "./retry.js";
import type {
  NIMChatCompletionChunk,
  NIMChatCompletionRequest,
  NIMChatCompletionResponse,
  NIMClientConfig,
  NIMModel,
  NIMModelsResponse,
} from "./types.js";

export class NIMClient {
  private client: OpenAI;
  private rateLimiter: NIMRateLimiter;
  private config: Required<NIMClientConfig>;
  private defaultModel: string;

  constructor(config: NIMClientConfig) {
    // Validate required config
    if (!config.baseURL) {
      throw new Error("baseURL is required");
    }
    if (!config.apiKey) {
      throw new Error("apiKey is required");
    }

    // Set defaults
    this.config = {
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
      maxRetryDelayMs: config.maxRetryDelayMs ?? 30000,
      rateLimitRPM: config.rateLimitRPM ?? 20,
      rateLimitBurst: config.rateLimitBurst ?? 5,
      timeoutMs: config.timeoutMs ?? 120000,
      streamingTimeoutMs: config.streamingTimeoutMs ?? 300000,
      defaultModel: config.defaultModel ?? "meta/llama-3.1-70b-instruct",
      defaultHeaders: config.defaultHeaders ?? {},
      debug: config.debug ?? false,
    };

    this.defaultModel = this.config.defaultModel;

    // Initialize OpenAI client
    this.client = new OpenAI({
      baseURL: `${this.config.baseURL}/v1`,
      apiKey: this.config.apiKey,
      defaultHeaders: this.config.defaultHeaders,
      timeout: this.config.timeoutMs,
      maxRetries: 0, // We handle retries ourselves
    });

    // Initialize rate limiter
    this.rateLimiter = createRateLimiter(this.config);
  }

  /**
   * Create a client for herd (local router)
   */
  static forLlamaSwap(
    apiKey: string,
    baseURL = "http://127.0.0.1:25100",
  ): NIMClient {
    return new NIMClient({
      baseURL,
      apiKey,
      defaultModel: "meta/llama-3.1-70b-instruct",
    });
  }

  /**
   * Create a client for direct NVIDIA API
   */
  static forNVIDIA(
    apiKey: string,
    baseURL = "http://127.0.0.1:8000",
  ): NIMClient {
    return new NIMClient({
      baseURL,
      apiKey,
      defaultModel: "meta/llama-3.1-70b-instruct",
    });
  }

  /**
   * Chat Completion - Non-streaming
   * Supports all 69+ parameters
   */
  async chatCompletion(
    request: NIMChatCompletionRequest,
  ): Promise<NIMChatCompletionResponse> {
    // Apply defaults
    const fullRequest = this.applyDefaults(request);

    // Validate request
    this.validateRequest(fullRequest);

    // Acquire rate limit token
    await this.rateLimiter.acquire();

    // Execute with retry
    const result = await withRetry(async () => {
      const response = await this.client.chat.completions.create(
        fullRequest as any,
      );
      return this.transformResponse(response);
    }, createRetryOptions(this.config));

    if (!result.success) {
      throw result.error ?? new Error("Chat completion failed");
    }

    return result.data!;
  }

  /**
   * Chat Completion - Streaming
   * Returns async iterator of chunks
   */
  async *chatCompletionStream(
    request: NIMChatCompletionRequest,
  ): AsyncIterableIterator<NIMChatCompletionChunk> {
    // Apply defaults
    const fullRequest = this.applyDefaults({ ...request, stream: true });

    // Validate request
    this.validateRequest(fullRequest);

    // Acquire rate limit token
    await this.rateLimiter.acquire();

    // Execute with retry
    const result = await withRetry(async () => {
      const stream = await this.client.chat.completions.create(
        fullRequest as any,
      );
      return stream;
    }, createRetryOptions(this.config));

    if (!result.success) {
      throw result.error ?? new Error("Streaming chat completion failed");
    }

    // Transform and yield chunks
    for await (const chunk of result.data as any) {
      yield this.transformChunk(chunk);
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<NIMModelsResponse> {
    await this.rateLimiter.acquire();

    const result = await withRetry(async () => {
      const response = await this.client.models.list();
      return this.transformModelsResponse(response);
    }, createRetryOptions(this.config));

    if (!result.success) {
      throw result.error ?? new Error("Failed to list models");
    }

    return result.data!;
  }

  /**
   * Get a specific model
   */
  async getModel(modelId: string): Promise<NIMModel> {
    await this.rateLimiter.acquire();

    const result = await withRetry(async () => {
      const response = await this.client.models.retrieve(modelId);
      return this.transformModel(response);
    }, createRetryOptions(this.config));

    if (!result.success) {
      throw result.error ?? new Error(`Failed to get model ${modelId}`);
    }

    return result.data!;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.rateLimiter.acquire();
      const response = await fetch(`${this.config.baseURL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get rate limiter status
   */
  getRateLimiterStatus(): { tokens: number; waitTimeMs: number } {
    return {
      tokens: this.rateLimiter.getTokens(),
      waitTimeMs: this.rateLimiter.getWaitTimeMs(),
    };
  }

  /**
   * Reset rate limiter (useful for testing)
   */
  resetRateLimiter(): void {
    this.rateLimiter.reset();
  }

  /**
   * Update default model
   */
  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  /**
   * Get default model
   */
  getDefaultModel(): string {
    return this.defaultModel;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private applyDefaults(
    request: NIMChatCompletionRequest,
  ): NIMChatCompletionRequest {
    const model = request.model ?? this.defaultModel;

    // Handle system_prompt convenience parameter
    let messages = request.messages;
    if (
      request.system_prompt &&
      messages.length > 0 &&
      messages[0].role !== "system"
    ) {
      messages = [
        { role: "system", content: request.system_prompt },
        ...messages,
      ];
    } else if (request.system_prompt && messages.length === 0) {
      messages = [{ role: "system", content: request.system_prompt }];
    }

    return {
      ...request,
      model,
      messages,
    };
  }

  private validateRequest(request: NIMChatCompletionRequest): void {
    if (!request.model) {
      throw new Error("model is required");
    }
    if (!request.messages || request.messages.length === 0) {
      throw new Error("messages array cannot be empty");
    }

    // Validate temperature
    if (request.temperature !== undefined) {
      if (request.temperature < 0 || request.temperature > 2) {
        throw new Error("temperature must be between 0 and 2");
      }
    }

    // Validate top_p
    if (request.top_p !== undefined) {
      if (request.top_p < 0 || request.top_p > 1) {
        throw new Error("top_p must be between 0 and 1");
      }
    }

    // Validate max_tokens
    if (request.max_tokens !== undefined) {
      if (request.max_tokens < 1 || request.max_tokens > 65536) {
        throw new Error("max_tokens must be between 1 and 65536");
      }
    }

    // Validate presence_penalty
    if (request.presence_penalty !== undefined) {
      if (request.presence_penalty < -2 || request.presence_penalty > 2) {
        throw new Error("presence_penalty must be between -2 and 2");
      }
    }

    // Validate frequency_penalty
    if (request.frequency_penalty !== undefined) {
      if (request.frequency_penalty < -2 || request.frequency_penalty > 2) {
        throw new Error("frequency_penalty must be between -2 and 2");
      }
    }

    // Validate n
    if (request.n !== undefined) {
      if (request.n < 1 || request.n > 3) {
        throw new Error("n must be between 1 and 3");
      }
    }

    // Validate top_logprobs
    if (request.top_logprobs !== undefined) {
      if (request.top_logprobs < 1 || request.top_logprobs > 20) {
        throw new Error("top_logprobs must be between 1 and 20");
      }
    }

    // Validate stop sequences
    if (request.stop !== undefined) {
      const stops = Array.isArray(request.stop) ? request.stop : [request.stop];
      if (stops.length > 4) {
        throw new Error("stop sequences cannot exceed 4");
      }
    }
  }

  private transformResponse(response: any): NIMChatCompletionResponse {
    return {
      id: response.id,
      object: response.object,
      created: response.created,
      model: response.model,
      system_fingerprint: response.system_fingerprint,
      choices: response.choices.map((choice: any) => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        },
        finish_reason: choice.finish_reason,
        logprobs: choice.logprobs
          ? this.transformLogprobs(choice.logprobs)
          : undefined,
      })),
      usage: {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
        reasoning_tokens: response.usage.reasoning_tokens,
      },
    };
  }

  private transformChunk(chunk: any): NIMChatCompletionChunk {
    return {
      id: chunk.id,
      object: chunk.object,
      created: chunk.created,
      model: chunk.model,
      system_fingerprint: chunk.system_fingerprint,
      choices: chunk.choices.map((choice: any) => ({
        index: choice.index,
        delta: {
          role: choice.delta.role,
          content: choice.delta.content,
          tool_calls: choice.delta.tool_calls,
        },
        finish_reason: choice.finish_reason,
        logprobs: choice.logprobs
          ? this.transformLogprobs(choice.logprobs)
          : undefined,
      })),
    };
  }

  private transformLogprobs(logprobs: any): any {
    return {
      content: logprobs.content.map((item: any) => ({
        token: item.token,
        logprob: item.logprob,
        bytes: item.bytes,
        top_logprobs: item.top_logprobs?.map((top: any) => ({
          token: top.token,
          logprob: top.logprob,
          bytes: top.bytes,
        })),
      })),
    };
  }

  private transformModelsResponse(response: any): NIMModelsResponse {
    return {
      object: response.object,
      data: response.data.map((model: any) => this.transformModel(model)),
    };
  }

  private transformModel(model: any): NIMModel {
    return {
      id: model.id,
      object: model.object,
      created: model.created,
      owned_by: model.owned_by,
      permission: model.permission,
      root: model.root,
      parent: model.parent,
    };
  }
}

/**
 * Convenience function for simple chat completions
 */
export async function quickChat(
  client: NIMClient,
  prompt: string,
  options: Partial<NIMChatCompletionRequest> = {},
): Promise<string> {
  const response = await client.chatCompletion({
    model: options.model ?? client.getDefaultModel(),
    messages: [{ role: "user", content: prompt }],
    ...options,
  });

  return response.choices[0]?.message?.content ?? "";
}

/**
 * Convenience function for streaming chat
 */
export async function* quickChatStream(
  client: NIMClient,
  prompt: string,
  options: Partial<NIMChatCompletionRequest> = {},
): AsyncIterableIterator<string> {
  for await (const chunk of client.chatCompletionStream({
    model: options.model ?? client.getDefaultModel(),
    messages: [{ role: "user", content: prompt }],
    ...options,
  })) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      yield content;
    }
  }
}
