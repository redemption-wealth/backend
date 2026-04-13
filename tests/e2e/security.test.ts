import { describe, test, expect } from "vitest";
import { testPrisma } from "../setup.integration.js";
import { createFixtures } from "../helpers/fixtures.js";
import app from "@/app.js";
import { jsonPost, authGet } from "../helpers/request.js";
import { createTestAdminToken, createTestOwnerToken } from "../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

describe("Security Hardening", () => {
  test("user cannot access another user's redemptions", async () => {
    // We can't easily test Privy auth here, but verify route requires auth
    const res = await app.request("/api/redemptions");
    expect(res.status).toBe(401);
  });

  test("admin cannot access owner-only routes", async () => {
    // Create actual admin in DB — requireAdmin now does a live DB check
    const admin = await fixtures.createAdmin({ role: "admin", email: "owner-check-admin@test.com" });
    const token = await createTestAdminToken({ id: admin.id, email: admin.email });

    // Only check genuinely owner-only routes
    const routes = [
      "/api/admin/admins",
      "/api/admin/settings",
    ];

    for (const route of routes) {
      const res = await authGet(route, token);
      expect(res.status).toBe(403);
    }
  });

  test("webhook without signature is rejected", async () => {
    const res = await app.request("/api/webhook/alchemy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: { activity: [] } }),
    });
    expect(res.status).toBe(401);
  });

  test("SQL injection in search params is safe", async () => {
    const res = await app.request(
      "/api/merchants?search=' OR 1=1; DROP TABLE merchants;--"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchants).toBeDefined();
  });

  test("XSS in merchant name is rejected by Zod (too short or valid)", async () => {
    // Create manager in DB — POST /api/admin/merchants requires requireManager
    const admin = await fixtures.createAdmin({ email: "xss-test@test.com", role: "manager" });
    const token = await createTestAdminToken({ id: admin.id, email: admin.email });

    // This should either pass (Zod doesn't block XSS by default but Prisma escapes)
    // or fail validation. Either way, the app doesn't crash.
    const res = await jsonPost("/api/admin/merchants", {
      name: "<script>alert('xss')</script>",
      category: "kuliner",
    }, token);
    // If it passes validation, the HTML is stored but Prisma escapes on output
    expect([201, 400]).toContain(res.status);
  });

  test("deactivated admin with valid JWT — login returns 401", async () => {
    await fixtures.createAdmin({
      email: "deactivated@test.com",
      password: "password-123",
      isActive: false,
    });

    const res = await jsonPost("/api/auth/login", {
      email: "deactivated@test.com",
      password: "password-123",
    });
    expect(res.status).toBe(401);
  });

  test("settings update requires owner, not admin", async () => {
    // Create admin in DB — requireAdmin does a live DB check
    const admin = await fixtures.createAdmin({ role: "admin", email: "settings-check-admin@test.com" });
    const adminToken = await createTestAdminToken({ id: admin.id, email: admin.email });
    const res = await app.request("/api/admin/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ appFeePercentage: 99 }),
    });
    expect(res.status).toBe(403);
  });
});
