import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import bcryptjs from "bcryptjs";
import { randomBytes } from "node:crypto";

const email = process.argv[2];
const password = process.argv[3];
const name = process.argv[4] ?? "Owner";

if (!email || !password) {
  console.error("Usage: tsx scripts/create-owner.ts <email> <password> [name]");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const existing = await prisma.user.findUnique({
    where: { email },
    include: { admin: true, accounts: true },
  });
  if (existing) {
    console.error(`User with email ${email} already exists (id=${existing.id}).`);
    process.exit(1);
  }

  const hashed = await bcryptjs.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      id: randomBytes(16).toString("hex"),
      name,
      email,
      emailVerified: true,
      accounts: {
        create: {
          id: `credential-${randomBytes(16).toString("hex")}`,
          accountId: email,
          providerId: "credential",
          password: hashed,
        },
      },
      admin: {
        create: {
          role: "OWNER",
          isActive: true,
        },
      },
    },
    include: { admin: true },
  });

  console.log("✅ Owner created");
  console.log("   userId :", user.id);
  console.log("   adminId:", user.admin?.id);
  console.log("   email  :", user.email);
  console.log("   role   :", user.admin?.role);
}

main()
  .catch((e) => {
    console.error("Failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
