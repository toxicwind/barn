/**
 * Retry Logic with Exponential Backoff for NIM API
 * Handles 429 (rate limit), 5xx (server errors), and network failures
 */

import type { NIMClientConfig } from "./types.js";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatusCodes: number[];
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  totalDelayMs: number;
}

const DEFAULT_RETRYABLE_CODES = [429, 500, 502, 503, 504];
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

/**
 * Check if an error is retryable
 */
export function isRetryableError(
  error: unknown,
  retryableCodes: number[] = DEFAULT_RETRYABLE_CODES,
): boolean {
  // Network errors (fetch failures, timeouts, etc.)
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }

  if (error instanceof DOMException && error.name === "TimeoutError") {
    return true;
  }

  // HTTP errors with status codes
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    return retryableCodes.includes(status);
  }

  // Response objects with status
  if (error && typeof error === "object" && "response" in error) {
    const response = (error as { response: { status: number } }).response;
    if (response && typeof response === "object" && "status" in response) {
      return retryableCodes.includes(response.status);
    }
  }

  // Check for Retry-After header in error
  if (error && typeof error === "object" && "headers" in error) {
    const headers = (error as { headers: Headers }).headers;
    if (headers instanceof Headers && headers.has("retry-after")) {
      return true;
    }
  }

  return false;
}

/**
 * Extract Retry-After delay from error (in milliseconds)
 */
export function getRetryAfterDelay(error: unknown): number | null {
  if (error && typeof error === "object" && "headers" in error) {
    const headers = (error as { headers: Headers }).headers;
    if (headers instanceof Headers) {
      const retryAfter = headers.get("retry-after");
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds)) {
          return seconds * 1000;
        }
      }
    }
  }

  if (error && typeof error === "object" && "response" in error) {
    const response = (error as { response: { headers: Headers } }).response;
    if (response && response.headers instanceof Headers) {
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds)) {
          return seconds * 1000;
        }
      }
    }
  }

  return null;
}

/**
 * Calculate exponential backoff delay with jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs: number | null = null,
): number {
  // If server provided Retry-After, use that (with small jitter)
  if (retryAfterMs !== null) {
    const jitter = Math.random() * 1000; // 0-1s jitter
    return Math.min(retryAfterMs + jitter, maxDelayMs);
  }

  // Exponential backoff: baseDelay * 2^attempt + jitter
  const exponentialDelay = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs; // 0 to baseDelay jitter
  const delay = exponentialDelay + jitter;

  return Math.min(delay, maxDelayMs);
}

/**
 * Execute a function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<RetryResult<T>> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    retryableStatusCodes = DEFAULT_RETRYABLE_CODES,
    onRetry,
  } = options;

  let lastError: Error | null = null;
  let totalDelayMs = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const data = await fn();
      return {
        success: true,
        data,
        attempts: attempt + 1,
        totalDelayMs,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Check if error is retryable
      if (!isRetryableError(error, retryableStatusCodes)) {
        break;
      }

      // Calculate delay
      const retryAfterMs = getRetryAfterDelay(error);
      const delayMs = calculateBackoffDelay(
        attempt,
        baseDelayMs,
        maxDelayMs,
        retryAfterMs,
      );

      totalDelayMs += delayMs;

      // Call retry callback if provided
      if (onRetry) {
        onRetry(attempt + 1, lastError, delayMs);
      }

      // Wait before retrying
      await sleep(delayMs);
    }
  }

  return {
    success: false,
    error: lastError ?? new Error("Unknown error"),
    attempts: maxRetries + 1,
    totalDelayMs,
  };
}

/**
 * Create retry options from client config
 */
export function createRetryOptions(config: NIMClientConfig): RetryOptions {
  return {
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: config.retryDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: config.maxRetryDelayMs ?? DEFAULT_MAX_DELAY_MS,
    retryableStatusCodes: DEFAULT_RETRYABLE_CODES,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
