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

/**
 * Create a mock Privy token for testing user authentication
 * Returns a simple token string that the mocked Privy client will recognize
 */
export function createTestUserToken(overrides?: {
  privyUserId?: string;
  email?: string;
}) {
  // Return a simple token - the mock will be configured to recognize it
  const privyUserId = overrides?.privyUserId ?? "test-privy-user-id";
  const email = overrides?.email ?? "user@test.com";
  return `mock-privy-token-${privyUserId}-${email}`;
}

/**
 * Setup Privy mock to return specific user claims for a token
 * Call this in tests before making authenticated user requests
 */
export function mockPrivyVerification(privyUserId: string, email: string) {
  return {
    userId: privyUserId,
    email,
  };
}
