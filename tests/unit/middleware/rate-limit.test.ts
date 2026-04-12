import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Create a simple rate limiter for testing (inline to avoid module mocking issues)
function createTestRateLimiter(maxAttempts: number, windowMs: number) {
  const store = new Map<string, { count: number; resetAt: number }>();

  return async (key: string): Promise<{ blocked: boolean; retryAfter?: number }> => {
    const now = Date.now();
    const entry = store.get(key);

    if (entry && now < entry.resetAt) {
      if (entry.count >= maxAttempts) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        return { blocked: true, retryAfter };
      }
      entry.count++;
      return { blocked: false };
    }

    store.set(key, { count: 1, resetAt: now + windowMs });
    return { blocked: false };
  };
}

describe("Rate Limiter Logic", () => {
  test("allows requests under limit", async () => {
    const limiter = createTestRateLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) {
      const result = await limiter("test-key");
      expect(result.blocked).toBe(false);
    }
  });

  test("blocks when limit exceeded", async () => {
    const limiter = createTestRateLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) {
      await limiter("test-key");
    }
    const result = await limiter("test-key");
    expect(result.blocked).toBe(true);
    expect(result.retryAfter).toBeDefined();
    expect(result.retryAfter!).toBeGreaterThan(0);
  });

  test("rate limits per key, not globally", async () => {
    const limiter = createTestRateLimiter(2, 60_000);
    await limiter("key-a");
    await limiter("key-a");
    const resultA = await limiter("key-a");
    expect(resultA.blocked).toBe(true);

    // key-b should still be allowed
    const resultB = await limiter("key-b");
    expect(resultB.blocked).toBe(false);
  });

  test("includes Retry-After value", async () => {
    const limiter = createTestRateLimiter(1, 30_000);
    await limiter("test-key");
    const result = await limiter("test-key");
    expect(result.blocked).toBe(true);
    expect(result.retryAfter).toBeLessThanOrEqual(30);
    expect(result.retryAfter).toBeGreaterThan(0);
  });
});
