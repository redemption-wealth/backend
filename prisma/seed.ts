import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const ownerEmail = (process.env.INITIAL_OWNER_EMAIL || "owner@wealthcrypto.fund").toLowerCase();

  // Upsert the User for the owner
  const user = await prisma.user.upsert({
    where: { email: ownerEmail },
    update: {},
    create: {
      email: ownerEmail,
      name: ownerEmail,
      emailVerified: true,
    },
  });

  // Credential account with NULL password (pending setup)
  await prisma.account.upsert({
    where: { id: `credential-${user.id}` },
    update: {},
    create: {
      id: `credential-${user.id}`,
      accountId: user.id,
      providerId: "credential",
      userId: user.id,
      password: null,
    },
  });

  // Admin record
  await prisma.admin.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      role: "OWNER",
      isActive: true,
    },
  });

  // Singleton app settings
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: {
      id: "singleton",
      appFeeRate: 3,
      gasFeeAmount: 0,
    },
  });

  console.log(`\nSeeded owner: ${ownerEmail} (pending password setup)`);
  console.log("Seeded app settings singleton\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
