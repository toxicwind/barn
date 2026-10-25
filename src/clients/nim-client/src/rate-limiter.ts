/**
 * Token Bucket Rate Limiter for NIM API
 * Supports 20 RPM (1 request per 3 seconds) with burst allowance
 */

import type { NIMClientConfig, RateLimiterState } from "./types.js";

export class NIMRateLimiter {
  private state: RateLimiterState;
  private readonly rpm: number;
  private readonly burst: number;
  private readonly refillRatePerMs: number;

  constructor(config: NIMClientConfig) {
    this.rpm = config.rateLimitRPM ?? 20;
    this.burst = config.rateLimitBurst ?? 5;
    this.refillRatePerMs = this.rpm / 60000; // tokens per millisecond

    this.state = {
      tokens: this.burst,
      lastRefill: Date.now(),
    };
  }

  /**
   * Acquire a token, blocking until one is available
   */
  async acquire(): Promise<void> {
    while (true) {
      this.refill();

      if (this.state.tokens >= 1) {
        this.state.tokens -= 1;
        return;
      }

      // Calculate time until next token
      const tokensNeeded = 1 - this.state.tokens;
      const waitMs = tokensNeeded / this.refillRatePerMs;

      // Wait with a small buffer
      await this.sleep(Math.ceil(waitMs) + 10);
    }
  }

  /**
   * Try to acquire a token without blocking
   * Returns true if successful, false if rate limited
   */
  tryAcquire(): boolean {
    this.refill();

    if (this.state.tokens >= 1) {
      this.state.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Get current token count (for debugging/monitoring)
   */
  getTokens(): number {
    this.refill();
    return this.state.tokens;
  }

  /**
   * Get time until next token is available (ms)
   */
  getWaitTimeMs(): number {
    this.refill();

    if (this.state.tokens >= 1) {
      return 0;
    }

    const tokensNeeded = 1 - this.state.tokens;
    return Math.ceil(tokensNeeded / this.refillRatePerMs);
  }

  /**
   * Reset the rate limiter (useful for testing)
   */
  reset(): void {
    this.state = {
      tokens: this.burst,
      lastRefill: Date.now(),
    };
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.state.lastRefill;

    if (elapsed > 0) {
      const newTokens = elapsed * this.refillRatePerMs;
      this.state.tokens = Math.min(this.burst, this.state.tokens + newTokens);
      this.state.lastRefill = now;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a rate limiter from config
 */
export function createRateLimiter(config: NIMClientConfig): NIMRateLimiter {
  return new NIMRateLimiter(config);
}
