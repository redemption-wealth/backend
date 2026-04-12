import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcryptjs from "bcryptjs";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});

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
      appFeePercentage: 3,
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

  console.log(`Seeded owner account: ${email}`);
  console.log("Seeded app settings (singleton)");
  console.log("Seeded default fee setting");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
