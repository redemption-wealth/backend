// Idempotent seed for back-office login accounts (demo / review).
//
// Creates OWNER, MANAGER, and ADMIN admins, each with a ready-to-use bcrypt
// credential password so they can log in immediately via
// POST /api/auth/sign-in/email (see backend/src/routes/auth.ts).
//
// Every write is an upsert — safe to re-run, never deletes existing data.
//
// Usage:  npx tsx scripts/seed-backoffice-logins.ts     (from /backend)
import "dotenv/config";
import { prisma } from "../src/db.js";
import bcryptjs from "bcryptjs";
import type { AdminRole } from "@prisma/client";

const ACCOUNTS: { email: string; name: string; role: AdminRole; password: string }[] = [
  { email: "owner@wealth.local", name: "Demo Owner", role: "OWNER", password: "Owner12345!" },
  { email: "manager@wealth.local", name: "Demo Manager", role: "MANAGER", password: "Manager12345!" },
  { email: "admin@wealth.local", name: "Demo Admin", role: "ADMIN", password: "Admin12345!" },
];

async function seedOne(email: string, name: string, role: AdminRole, password: string) {
  const passwordHash = await bcryptjs.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: { name },
    create: { name, email, emailVerified: true },
  });

  await prisma.admin.upsert({
    where: { userId: user.id },
    update: { role, isActive: true, merchantId: null },
    create: { userId: user.id, role, isActive: true },
  });

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
  for (const a of ACCOUNTS) {
    const id = await seedOne(a.email, a.name, a.role, a.password);
    console.log(`[seed-backoffice-logins] ${a.role.padEnd(8)} ready: ${a.email} / ${a.password} (userId=${id})`);
  }
}

main()
  .catch((err) => {
    console.error("[seed-backoffice-logins] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
