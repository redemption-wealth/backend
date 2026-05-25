import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { createFixtures } from "../../helpers/fixtures.js";
import { jsonPost, authGet } from "../../helpers/request.js";
import { createTestAdminToken } from "../../helpers/admin-session.js";

const fixtures = createFixtures(testPrisma);

describe("POST /api/auth/sign-in/email", () => {
  beforeEach(async () => {
    await fixtures.createAdmin({
      email: "login@test.com",
      password: "test-password-123",
      role: "admin",
    });
  });

  test("returns 200 + session token + user for valid credentials", async () => {
    const res = await jsonPost("/api/auth/sign-in/email", {
      email: "login@test.com",
      password: "test-password-123",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeDefined();
    expect(body.user.email).toBe("login@test.com");
    expect(body.user.role).toBe("ADMIN");
    expect(body.user.id).toBeDefined();
  });

  test("returns 401 for wrong password", async () => {
    const res = await jsonPost("/api/auth/sign-in/email", {
      email: "login@test.com",
      password: "wrong-password-123",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid email or password");
  });

  test("returns 403 + ACCOUNT_INACTIVE for inactive admin", async () => {
    await fixtures.createAdmin({
      email: "inactive@test.com",
      password: "test-password-123",
      isActive: false,
    });
    const res = await jsonPost("/api/auth/sign-in/email", {
      email: "inactive@test.com",
      password: "test-password-123",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("ACCOUNT_INACTIVE");
  });

  test("returns 401 for non-existent email", async () => {
    const res = await jsonPost("/api/auth/sign-in/email", {
      email: "nonexistent@test.com",
      password: "test-password-123",
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 for missing email", async () => {
    const res = await jsonPost("/api/auth/sign-in/email", {
      password: "test-password-123",
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for missing password", async () => {
    const res = await jsonPost("/api/auth/sign-in/email", {
      email: "login@test.com",
    });
    expect(res.status).toBe(400);
  });

  test("returns needsPasswordSetup + setupToken when admin has no password", async () => {
    await fixtures.createAdmin({
      email: "no-password@test.com",
      password: null,
      role: "admin",
    });

    const res = await jsonPost("/api/auth/sign-in/email", {
      email: "no-password@test.com",
      password: "any-password",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.needsPasswordSetup).toBe(true);
    expect(body.setupToken).toBeDefined();
  });
});

describe("GET /api/auth/get-session", () => {
  test("returns 401 without token", async () => {
    const res = await authGet("/api/auth/get-session", "");
    expect(res.status).toBe(401);
  });

  test("returns admin context with valid session token", async () => {
    const admin = await fixtures.createAdmin({ email: "me-test@test.com", role: "admin" });
    const token = await createTestAdminToken({ id: admin.id, email: admin.email, role: "admin" });
    const res = await authGet("/api/auth/get-session", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe("me-test@test.com");
    expect(body.user.role).toBe("ADMIN");
  });
});

// NOTE: setPasswordLimiter allows only 3 attempts per IP per 15min and its
// in-memory store persists across tests in the same process. Keep total
// /setup-password calls in this block at or below 3 so none hit a 429.
describe("POST /api/auth/setup-password", () => {
  test("returns 400 if password too weak (no uppercase/number, < 8)", async () => {
    // Validation runs without consuming nothing extra; still counts as 1 attempt.
    const res = await jsonPost("/api/auth/setup-password", {
      token: "some-token",
      password: "short",
      confirmPassword: "short",
    });
    expect(res.status).toBe(400);
  });

  test("returns 401 for invalid/non-existent setup token", async () => {
    const res = await jsonPost("/api/auth/setup-password", {
      token: "nonexistent-token",
      password: "NewPassword123",
      confirmPassword: "NewPassword123",
    });
    expect(res.status).toBe(401);
  });

  test("sets password via valid setup token and auto-issues session", async () => {
    await fixtures.createAdmin({
      email: "first-login@test.com",
      password: null,
    });

    // Trigger sign-in to mint a setup token
    const signIn = await jsonPost("/api/auth/sign-in/email", {
      email: "first-login@test.com",
      password: "anything",
    });
    const { setupToken } = await signIn.json();
    expect(setupToken).toBeDefined();

    const res = await jsonPost("/api/auth/setup-password", {
      token: setupToken,
      password: "NewPassword123",
      confirmPassword: "NewPassword123",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeDefined();

    // Verify can now sign in with the new password
    const loginRes = await jsonPost("/api/auth/sign-in/email", {
      email: "first-login@test.com",
      password: "NewPassword123",
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.token).toBeDefined();
  });
});
