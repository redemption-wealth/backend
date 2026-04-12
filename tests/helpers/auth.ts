import * as jose from "jose";

const TEST_JWT_SECRET = new TextEncoder().encode(
  process.env.ADMIN_JWT_SECRET || "test-secret-min-32-chars-for-vitest-testing"
);

export async function createTestAdminToken(overrides?: {
  id?: string;
  email?: string;
  role?: "admin" | "owner";
  expiresIn?: string;
}) {
  const payload = {
    id: overrides?.id ?? "test-admin-id",
    email: overrides?.email ?? "admin@test.com",
    role: overrides?.role ?? "admin",
  };

  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(overrides?.expiresIn ?? "1h")
    .sign(TEST_JWT_SECRET);
}

export async function createTestOwnerToken(overrides?: {
  id?: string;
  email?: string;
  expiresIn?: string;
}) {
  return createTestAdminToken({
    ...overrides,
    role: "owner",
    id: overrides?.id ?? "test-owner-id",
    email: overrides?.email ?? "owner@test.com",
  });
}

export async function createExpiredAdminToken() {
  const payload = { id: "test-admin-id", email: "admin@test.com", role: "admin" as const };

  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("0s")
    .sign(TEST_JWT_SECRET);
}

export async function createTokenWithWrongSecret() {
  const wrongSecret = new TextEncoder().encode("wrong-secret-that-is-also-32-chars-long");
  const payload = { id: "test-admin-id", email: "admin@test.com", role: "admin" as const };

  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(wrongSecret);
}
