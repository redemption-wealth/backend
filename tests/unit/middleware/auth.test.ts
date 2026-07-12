import { describe, test, expect, vi } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────
// requireAdmin does two things:
//   1. auth.api.getSession({ headers }) — Better Auth reads the Bearer token and
//      returns a Session row (or null).
//   2. prisma.admin.findUnique({ where: { userId } }) — live DB check.
// Unit-testing a *valid authenticated identity* therefore only needs those two
// seams mocked (no real DB / no real Better Auth session store). The negative
// paths fall out of the same mocks: any unknown/malformed bearer → getSession
// null → 401.

// Known valid session tokens → the userId they resolve to.
const SESSIONS: Record<string, { userId: string; email: string; sessionId: string }> = {
  "valid-admin-token": { userId: "user-admin", email: "admin@test.com", sessionId: "sess-admin" },
  "valid-owner-token": { userId: "user-owner", email: "owner@test.com", sessionId: "sess-owner" },
};

// Admin rows keyed by userId (matches the middleware's `where: { userId }`).
const ADMINS: Record<string, { id: string; role: string; merchantId: string | null; isActive: boolean }> = {
  "user-admin": { id: "admin-id-1", role: "ADMIN", merchantId: "m1", isActive: true },
  "user-owner": { id: "owner-id-1", role: "OWNER", merchantId: null, isActive: true },
};

vi.mock("@/lib/auth.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
        const authHeader = headers.get("authorization") ?? "";
        if (!authHeader.startsWith("Bearer ")) return null;
        const token = authHeader.slice(7);
        const s = SESSIONS[token];
        if (!s) return null;
        return {
          user: { id: s.userId, email: s.email },
          session: { id: s.sessionId },
        };
      }),
    },
  },
}));

vi.mock("@/db.js", () => ({
  prisma: {
    admin: {
      findUnique: vi.fn(({ where }: { where: { userId?: string } }) =>
        Promise.resolve(where?.userId ? (ADMINS[where.userId] ?? null) : null),
      ),
      findMany: vi.fn(() => Promise.resolve([])),
      count: vi.fn(() => Promise.resolve(0)),
    },
    user: { findUnique: vi.fn(() => Promise.resolve(null)) },
    session: { delete: vi.fn(() => Promise.resolve()) },
  },
}));

const { default: app } = await import("@/app.js");

describe("requireAdmin middleware", () => {
  test("returns 401 without Authorization header", async () => {
    const res = await app.request("/api/admin/merchants");
    expect(res.status).toBe(401);
  });

  test("returns 401 with non-Bearer prefix", async () => {
    const res = await app.request("/api/admin/merchants", {
      headers: { Authorization: "Basic sometoken" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 with malformed token", async () => {
    const res = await app.request("/api/admin/merchants", {
      headers: { Authorization: "Bearer not.a.valid.jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("sets adminAuth context with valid admin session token", async () => {
    const res = await app.request("/api/auth/get-session", {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeDefined();
    expect(body.user.role).toBe("ADMIN");
    expect(body.user.email).toBe("admin@test.com");
  });

  test("sets correct role for owner", async () => {
    const res = await app.request("/api/auth/get-session", {
      headers: { Authorization: "Bearer valid-owner-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.role).toBe("OWNER");
  });

  test("returns 401 when session is valid but admin row is inactive", async () => {
    // Temporarily flip the admin inactive.
    const original = ADMINS["user-admin"];
    ADMINS["user-admin"] = { ...original, isActive: false };
    try {
      const res = await app.request("/api/auth/get-session", {
        headers: { Authorization: "Bearer valid-admin-token" },
      });
      expect(res.status).toBe(401);
    } finally {
      ADMINS["user-admin"] = original;
    }
  });
});

describe("requireOwner middleware", () => {
  test("returns 403 for admin role (not owner)", async () => {
    // /api/admin/admins is guarded by requireAdmin + requireOwner.
    const res = await app.request("/api/admin/admins", {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(403);
  });

  test("passes through for owner role", async () => {
    const res = await app.request("/api/admin/admins", {
      headers: { Authorization: "Bearer valid-owner-token" },
    });
    // Owner clears requireOwner — NOT 403 (may be 200 or downstream status).
    expect(res.status).not.toBe(403);
  });
});
