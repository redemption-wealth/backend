// Pure (no-DB) auth helpers — safe to import from unit tests.
//
// Admin auth is now Better Auth session-based (a valid admin token = a real
// Session row). The DB-backed session helpers live in helpers/admin-session.ts
// and are imported only by integration/e2e tests. The functions here generate
// opaque token strings for which NO Session row exists, which is exactly what
// the unit middleware tests need for negative-auth assertions (any unknown /
// malformed bearer token → getSession null → 401).
import { randomBytes } from "node:crypto";

/** Opaque random token with no backing Session row → 401 (unit-only stub). */
export function createTestAdminToken(): string {
  return randomBytes(32).toString("hex");
}

/** Opaque random token with no backing Session row → 401 (unit-only stub). */
export function createTestOwnerToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Create a mock Privy token for testing user authentication.
 * The mocked Privy client (setup.integration.ts) resolves verifyAuthToken to
 * whatever mockVerifyAuthToken returns, so the token string is just a handle.
 */
export function createTestUserToken(overrides?: {
  privyUserId?: string;
  email?: string;
}): string {
  const privyUserId = overrides?.privyUserId ?? "test-privy-user-id";
  const email = overrides?.email ?? "user@test.com";
  return `mock-privy-token-${privyUserId}-${email}`;
}

/**
 * Build the claims shape the mocked Privy verifyAuthToken should resolve to.
 */
export function mockPrivyVerification(privyUserId: string, email: string) {
  return {
    userId: privyUserId,
    email: { address: email },
  };
}
