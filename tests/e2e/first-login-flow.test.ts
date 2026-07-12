import { describe, test, expect } from "vitest";
import { testPrisma } from "../setup.integration.js";
import { createFixtures } from "../helpers/fixtures.js";
import { jsonPost, authGet } from "../helpers/request.js";
import { createTestOwnerToken } from "../helpers/admin-session.js";

const fixtures = createFixtures(testPrisma);

describe("First-Login Admin Flow E2E", () => {
  test("owner creates admin → setup-password → sign-in → CRUD", async () => {
    // Owner authenticates via a real session (requireAdmin does a live DB check).
    const owner = await fixtures.createAdmin({
      role: "owner",
      email: "first-login-owner@test.com",
    });
    const ownerToken = await createTestOwnerToken({
      id: owner.id,
      email: owner.email,
    });

    // 1. Owner creates a MANAGER admin (no password yet). createAdminSchema
    //    requires a role; MANAGER does not need a merchantId. The response
    //    carries the one-time setupToken.
    const createRes = await jsonPost(
      "/api/admin/admins",
      { email: "new-admin@test.com", role: "MANAGER" },
      ownerToken,
    );
    expect(createRes.status).toBe(201);
    const { admin, setupToken } = await createRes.json();
    expect(admin).toBeDefined();
    expect(setupToken).toBeDefined();

    // 2. New admin sets their password using the setupToken. The endpoint
    //    auto-issues a session token on success.
    const setupRes = await jsonPost("/api/auth/setup-password", {
      token: setupToken,
      password: "SecurePass123",
      confirmPassword: "SecurePass123",
    });
    expect(setupRes.status).toBe(200);
    const setupBody = await setupRes.json();
    expect(setupBody.token).toBeDefined();

    // 3. Admin signs in with the new password.
    const loginRes = await jsonPost("/api/auth/sign-in/email", {
      email: "new-admin@test.com",
      password: "SecurePass123",
    });
    expect(loginRes.status).toBe(200);
    const { token } = await loginRes.json();
    expect(token).toBeDefined();

    // 4. The session token authenticates the admin.
    const sessionRes = await authGet("/api/auth/get-session", token);
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.user.email).toBe("new-admin@test.com");

    // 5. The manager can create a merchant.
    const merchantRes = await jsonPost(
      "/api/admin/merchants",
      { name: "First Login Merchant", category: "F&B" },
      token,
    );
    expect(merchantRes.status).toBe(201);
    const merchantBody = await merchantRes.json();
    expect(merchantBody.merchant.name).toBe("First Login Merchant");
  });
});
