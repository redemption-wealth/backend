// DB-backed admin session helpers (integration + e2e ONLY).
//
// Admin auth migrated from a hand-signed jose JWT to Better Auth sessions:
// requireAdmin → auth.api.getSession reads the Bearer token via the bearer
// plugin and looks up a Session row by token. So a valid "admin token" must be
// a REAL Session row pointing at the Admin's userId.
//
// This module imports testPrisma, so it must NOT be imported by unit tests
// (which run without a DB). Unit tests use the pure stubs in helpers/auth.ts.
import { randomBytes } from "node:crypto";
import { testPrisma } from "../setup.integration.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Create a real Better Auth Session row for an existing Admin and return its
 * token. The `id` must be an Admin.id (as returned by fixtures.createAdmin).
 * `email`/`role` are now informational — the live Admin row governs auth.
 */
export async function createTestAdminToken(overrides?: {
  id?: string;
  email?: string;
  role?: "admin" | "owner" | "manager" | "ADMIN" | "OWNER" | "MANAGER";
  merchantId?: string;
  expiresIn?: string;
}): Promise<string> {
  const adminId = overrides?.id;
  if (!adminId) {
    throw new Error(
      "createTestAdminToken requires { id } — pass an Admin.id created via fixtures.createAdmin()",
    );
  }

  const admin = await testPrisma.admin.findUnique({
    where: { id: adminId },
    select: { userId: true },
  });
  if (!admin) {
    throw new Error(`createTestAdminToken: no Admin found with id="${adminId}"`);
  }

  const token = randomBytes(32).toString("hex");
  await testPrisma.session.create({
    data: {
      token,
      userId: admin.userId,
      expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
    },
  });
  return token;
}

export async function createTestOwnerToken(overrides?: {
  id?: string;
  email?: string;
  expiresIn?: string;
}): Promise<string> {
  return createTestAdminToken({ id: overrides?.id, email: overrides?.email });
}

export async function createTestManagerToken(overrides?: {
  id?: string;
  email?: string;
  expiresIn?: string;
}): Promise<string> {
  return createTestAdminToken({ id: overrides?.id, email: overrides?.email });
}

/**
 * Create a Session row that is already expired so getSession rejects it (401).
 * Requires an Admin id like createTestAdminToken.
 */
export async function createExpiredAdminToken(overrides?: {
  id?: string;
}): Promise<string> {
  const adminId = overrides?.id;
  if (!adminId) {
    throw new Error(
      "createExpiredAdminToken requires { id } — pass an Admin.id created via fixtures.createAdmin()",
    );
  }
  const admin = await testPrisma.admin.findUnique({
    where: { id: adminId },
    select: { userId: true },
  });
  if (!admin) {
    throw new Error(`createExpiredAdminToken: no Admin found with id="${adminId}"`);
  }
  const token = randomBytes(32).toString("hex");
  await testPrisma.session.create({
    data: {
      token,
      userId: admin.userId,
      expiresAt: new Date(Date.now() - 60 * 1000), // already expired
    },
  });
  return token;
}

/**
 * A token for which no Session row exists → getSession returns null → 401.
 * (Name kept for caller compatibility; "wrong secret" no longer applies under
 * session-based auth — any unknown token is simply rejected.)
 */
export function createTokenWithWrongSecret(): string {
  return randomBytes(32).toString("hex");
}
