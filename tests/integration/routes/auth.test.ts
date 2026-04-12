import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { createFixtures } from "../../helpers/fixtures.js";
import { jsonPost, authGet } from "../../helpers/request.js";
import { createTestAdminToken } from "../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await fixtures.createAdmin({
      email: "login@test.com",
      password: "test-password-123",
      role: "admin",
    });
  });

  test("returns 200 + JWT token for valid credentials", async () => {
    const res = await jsonPost("/api/auth/login", {
      email: "login@test.com",
      password: "test-password-123",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeDefined();
    expect(body.admin.email).toBe("login@test.com");
  });

  test("returns 401 for wrong password", async () => {
    const res = await jsonPost("/api/auth/login", {
      email: "login@test.com",
      password: "wrong-password-123",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid credentials");
  });

  test("returns 401 for inactive admin", async () => {
    await fixtures.createAdmin({
      email: "inactive@test.com",
      password: "test-password-123",
      isActive: false,
    });
    const res = await jsonPost("/api/auth/login", {
      email: "inactive@test.com",
      password: "test-password-123",
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 for non-existent email", async () => {
    const res = await jsonPost("/api/auth/login", {
      email: "nonexistent@test.com",
      password: "test-password-123",
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 for missing email", async () => {
    const res = await jsonPost("/api/auth/login", {
      password: "test-password-123",
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for missing password", async () => {
    const res = await jsonPost("/api/auth/login", {
      email: "login@test.com",
    });
    expect(res.status).toBe(400);
  });

  test("JWT token contains correct claims", async () => {
    const res = await jsonPost("/api/auth/login", {
      email: "login@test.com",
      password: "test-password-123",
    });
    const body = await res.json();
    expect(body.admin.role).toBe("admin");
    expect(body.admin.id).toBeDefined();
  });
});

describe("GET /api/auth/me", () => {
  test("returns 401 without token", async () => {
    const res = await authGet("/api/auth/me", "");
    expect(res.status).toBe(401);
  });

  test("returns admin context with valid token", async () => {
    const token = await createTestAdminToken();
    const res = await authGet("/api/auth/me", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admin).toBeDefined();
  });
});

describe("POST /api/auth/set-password", () => {
  test("sets password for admin with null passwordHash", async () => {
    await fixtures.createAdmin({
      email: "first-login@test.com",
      password: null,
    });

    const res = await jsonPost("/api/auth/set-password", {
      email: "first-login@test.com",
      password: "new-password-123",
      confirmPassword: "new-password-123",
    });
    expect(res.status).toBe(200);

    // Verify can now login
    const loginRes = await jsonPost("/api/auth/login", {
      email: "first-login@test.com",
      password: "new-password-123",
    });
    expect(loginRes.status).toBe(200);
  });

  test("returns 400 if password < 8 chars", async () => {
    const res = await jsonPost("/api/auth/set-password", {
      email: "test@test.com",
      password: "short",
      confirmPassword: "short",
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 if passwords don't match", async () => {
    const res = await jsonPost("/api/auth/set-password", {
      email: "test@test.com",
      password: "password-one-123",
      confirmPassword: "password-two-123",
    });
    expect(res.status).toBe(400);
  });

  test("returns 409 if admin already has password", async () => {
    await fixtures.createAdmin({
      email: "has-pass@test.com",
      password: "existing-password",
    });

    const res = await jsonPost("/api/auth/set-password", {
      email: "has-pass@test.com",
      password: "new-password-123",
      confirmPassword: "new-password-123",
    });
    expect(res.status).toBe(409);
  });

  test("returns 401 for non-existent email", async () => {
    const res = await jsonPost("/api/auth/set-password", {
      email: "nope@test.com",
      password: "new-password-123",
      confirmPassword: "new-password-123",
    });
    expect(res.status).toBe(401);
  });
});
