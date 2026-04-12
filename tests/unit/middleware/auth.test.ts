import { describe, test, expect } from "vitest";
import app from "@/app.js";
import {
  createTestAdminToken,
  createTestOwnerToken,
  createExpiredAdminToken,
  createTokenWithWrongSecret,
} from "../../helpers/auth.js";

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

  test("returns 401 with expired token", async () => {
    const token = await createExpiredAdminToken();
    // Wait a tiny bit for token to expire
    await new Promise((r) => setTimeout(r, 100));
    const res = await app.request("/api/admin/merchants", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 with token signed by wrong secret", async () => {
    const token = await createTokenWithWrongSecret();
    const res = await app.request("/api/admin/merchants", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 with malformed token", async () => {
    const res = await app.request("/api/admin/merchants", {
      headers: { Authorization: "Bearer not.a.valid.jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("sets adminAuth context with valid token", async () => {
    const token = await createTestAdminToken();
    const res = await app.request("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admin).toBeDefined();
    expect(body.admin.role).toBe("admin");
  });

  test("sets correct role for owner", async () => {
    const token = await createTestOwnerToken();
    const res = await app.request("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admin.role).toBe("owner");
  });
});

describe("requireOwner middleware", () => {
  test("returns 403 for admin role (not owner)", async () => {
    const token = await createTestAdminToken({ role: "admin" });
    const res = await app.request("/api/admin/admins", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  test("passes through for owner role", async () => {
    const token = await createTestOwnerToken();
    const res = await app.request("/api/admin/admins", {
      headers: { Authorization: `Bearer ${token}` },
    });
    // May be 200 or another status, but NOT 403
    expect(res.status).not.toBe(403);
  });
});
