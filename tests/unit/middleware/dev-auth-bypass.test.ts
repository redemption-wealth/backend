import { describe, test, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { requireUser, type AuthEnv } from "@/middleware/auth.js";

// A tiny app that echoes back the resolved userAuth so we can assert the
// dev-bypass path produced the identity we expect (id + email default).
const app = new Hono<AuthEnv>();
app.get("/probe", requireUser, (c) => c.json({ userAuth: c.get("userAuth") }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireUser dev-auth bypass", () => {
  test("(a) bypasses Privy when NODE_ENV!=production + flag=true + header present", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEV_AUTH_BYPASS", "true");

    const res = await app.request("/probe", {
      headers: { "x-dev-user-id": "privy_dev_1" },
    });

    expect(res.status).toBe(200);
    const { userAuth } = await res.json();
    expect(userAuth).toEqual({
      type: "user",
      privyUserId: "privy_dev_1",
      // email defaults to <id>@dev.local so the email-keyed deposit gate works
      userEmail: "privy_dev_1@dev.local",
    });
  });

  test("(a') honours an explicit x-dev-user-email header", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEV_AUTH_BYPASS", "true");

    const res = await app.request("/probe", {
      headers: { "x-dev-user-id": "privy_dev_2", "x-dev-user-email": "real@x.com" },
    });

    expect(res.status).toBe(200);
    const { userAuth } = await res.json();
    expect(userAuth.userEmail).toBe("real@x.com");
    expect(userAuth.privyUserId).toBe("privy_dev_2");
  });

  test("(b) inert in production even with flag + header (falls through → 401)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_AUTH_BYPASS", "true");

    // No Authorization header → the real Privy path rejects with 401,
    // proving the bypass did NOT short-circuit auth.
    const res = await app.request("/probe", {
      headers: { "x-dev-user-id": "privy_dev_3" },
    });

    expect(res.status).toBe(401);
  });

  test("(c) inert when flag unset (falls through → 401)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEV_AUTH_BYPASS", "");

    const res = await app.request("/probe", {
      headers: { "x-dev-user-id": "privy_dev_4" },
    });

    expect(res.status).toBe(401);
  });
});
