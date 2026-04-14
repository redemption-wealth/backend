import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import bcryptjs from "bcryptjs";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.env.INITIAL_OWNER_EMAIL || "owner@wealthcrypto.fund";
  const password =
    process.env.INITIAL_OWNER_PASSWORD || "change-me-on-first-login";

  const passwordHash = await bcryptjs.hash(password, 12);

  await prisma.admin.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
      role: "owner",
    },
  });

  // Create singleton app settings
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: {
      id: "singleton",
      appFeeRate: 3,
      wealthContractAddress: process.env.WEALTH_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000",
      devWalletAddress: process.env.DEV_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000",
    },
  });

  // Create default fee setting
  const existingFee = await prisma.feeSetting.findFirst({
    where: { isActive: true },
  });
  if (!existingFee) {
    await prisma.feeSetting.create({
      data: {
        label: "Standard Gas Fee",
        amountIdr: 5000,
        isActive: true,
      },
    });
  }

  // Seed categories
  const categories = [
    { name: "kuliner" },
    { name: "hiburan" },
    { name: "event" },
    { name: "kesehatan" },
    { name: "lifestyle" },
    { name: "travel" },
  ];

  for (const category of categories) {
    await prisma.category.upsert({
      where: { name: category.name },
      update: {},
      create: category,
    });
  }

  console.log(`Seeded owner account: ${email}`);
  console.log("Seeded app settings (singleton)");
  console.log("Seeded default fee setting");
  console.log(`Seeded ${categories.length} categories`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
