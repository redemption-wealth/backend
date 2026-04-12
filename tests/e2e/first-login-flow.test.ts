import { describe, test, expect } from "vitest";
import { testPrisma } from "../setup.integration.js";
import { createFixtures } from "../helpers/fixtures.js";
import { jsonPost, authGet } from "../helpers/request.js";
import { createTestOwnerToken } from "../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

describe("First-Login Admin Flow E2E", () => {
  test("owner creates admin → set-password → login → CRUD", async () => {
    const ownerToken = await createTestOwnerToken();

    // 1. Owner creates admin with no password
    const createRes = await jsonPost("/api/admin/admins", {
      email: "new-admin@test.com",
    }, ownerToken);
    expect(createRes.status).toBe(201);

    // 2. New admin sets password
    const setPassRes = await jsonPost("/api/auth/set-password", {
      email: "new-admin@test.com",
      password: "secure-password-123",
      confirmPassword: "secure-password-123",
    });
    expect(setPassRes.status).toBe(200);

    // 3. Admin logs in with new password
    const loginRes = await jsonPost("/api/auth/login", {
      email: "new-admin@test.com",
      password: "secure-password-123",
    });
    expect(loginRes.status).toBe(200);
    const { token } = await loginRes.json();
    expect(token).toBeDefined();

    // 4. Admin performs operations
    const meRes = await authGet("/api/auth/me", token);
    expect(meRes.status).toBe(200);

    // 5. Admin can create a merchant
    const category = await testPrisma.category.upsert({
      where: { name: "kuliner" },
      update: {},
      create: { name: "kuliner", isActive: true },
    });

    const merchantRes = await jsonPost("/api/admin/merchants", {
      name: "First Login Merchant",
      categoryId: category.id,
    }, token);
    expect(merchantRes.status).toBe(201);
  });
});
