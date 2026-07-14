// Idempotent seed for the Playwright browser-e2e suite (back-office).
//
// Ensures a known MANAGER admin exists in the LOCAL Postgres `wealth_redemption`
// DB so the e2e suite can log in via POST /api/auth/sign-in/email (Better-Auth
// bearer + our custom bcrypt credential check — see backend/src/routes/auth.ts).
//
// Creates / repairs three rows for the manager:
//   users     — the identity (email unique)
//   admins    — role=MANAGER, isActive=true
//   accounts  — providerId="credential", password=bcrypt(hash)  ← what login checks
//
// Safe to run repeatedly: every write is an upsert, so re-runs converge on the
// same known-good state (and re-hash the password in case the constants change).
//
// Credentials (also documented in back-office/e2e/README.md):
//   email    : e2e-manager@wealth.local
//   password : E2ePassw0rd!
//
// Usage:  pnpm db:seed:e2e     (from /backend)
import "dotenv/config";
import { prisma } from "../src/db.js";
import bcryptjs from "bcryptjs";

export const E2E_MANAGER_EMAIL = "e2e-manager@wealth.local";
export const E2E_MANAGER_PASSWORD = "E2ePassw0rd!";

async function seedE2eManager() {
  const passwordHash = await bcryptjs.hash(E2E_MANAGER_PASSWORD, 10);

  // 1. User (identity). Upsert on the unique email.
  const user = await prisma.user.upsert({
    where: { email: E2E_MANAGER_EMAIL },
    update: { name: "E2E Manager" },
    create: {
      name: "E2E Manager",
      email: E2E_MANAGER_EMAIL,
      emailVerified: true,
    },
  });

  // 2. Admin row — MANAGER, active, no merchant scope (global access).
  await prisma.admin.upsert({
    where: { userId: user.id },
    update: { role: "MANAGER", isActive: true, merchantId: null },
    create: { userId: user.id, role: "MANAGER", isActive: true },
  });

  // 3. Credential Account — this is what /auth/sign-in/email verifies with bcrypt.
  //    Deterministic id so re-runs update the same row.
  const credentialId = `credential-${user.id}`;
  await prisma.account.upsert({
    where: { id: credentialId },
    update: { password: passwordHash },
    create: {
      id: credentialId,
      accountId: user.id,
      providerId: "credential",
      userId: user.id,
      password: passwordHash,
    },
  });

  return user.id;
}

async function main() {
  const id = await seedE2eManager();
  console.log(
    `[seed-e2e-admin] MANAGER ready: ${E2E_MANAGER_EMAIL} (userId=${id})`,
  );
}

// Only run when invoked directly (allow importing the helper/constants elsewhere).
main()
  .catch((err) => {
    console.error("[seed-e2e-admin] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
