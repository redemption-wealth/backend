import { createMiddleware } from "hono/factory";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  keyFn: (c: { req: { header: (name: string) => string | undefined; json: () => Promise<Record<string, unknown>> } }) => Promise<string> | string;
}

function createRateLimiter(config: RateLimitConfig) {
  const store = new Map<string, RateLimitEntry>();

  // Clean up expired entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) store.delete(key);
    }
  }, 60_000).unref();

  return createMiddleware(async (c, next) => {
    const key = await config.keyFn(c as never);
    const now = Date.now();

    const entry = store.get(key);
    if (entry && now < entry.resetAt) {
      if (entry.count >= config.maxAttempts) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        c.header("Retry-After", String(retryAfter));
        return c.json({ error: "Too many requests" }, 429);
      }
      entry.count++;
    } else {
      store.set(key, { count: 1, resetAt: now + config.windowMs });
    }

    await next();
  });
}

export const loginLimiter = createRateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000, // 15 minutes
  keyFn: async (c) => {
    try {
      const body = await c.req.json();
      return `login:${body.email || "unknown"}`;
    } catch {
      return "login:unknown";
    }
  },
});

export const setPasswordLimiter = createRateLimiter({
  maxAttempts: 3,
  windowMs: 15 * 60 * 1000,
  keyFn: async (c) => {
    try {
      const body = await c.req.json();
      return `set-password:${body.email || "unknown"}`;
    } catch {
      return "set-password:unknown";
    }
  },
});

export const userSyncLimiter = createRateLimiter({
  maxAttempts: 10,
  windowMs: 60 * 1000, // 1 minute
  keyFn: (c) => {
    const ip = c.req.header("x-forwarded-for") || "unknown";
    return `user-sync:${ip}`;
  },
});
