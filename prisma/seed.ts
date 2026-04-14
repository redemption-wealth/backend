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
  // Seed categories first (required for merchant FK)
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

  // Owner account
  const ownerEmail = process.env.INITIAL_OWNER_EMAIL || "owner@wealthcrypto.fund";
  const ownerPassword = process.env.INITIAL_OWNER_PASSWORD || "change-me-on-first-login";
  const ownerPasswordHash = await bcryptjs.hash(ownerPassword, 12);

  const owner = await prisma.admin.upsert({
    where: { email: ownerEmail },
    update: {},
    create: {
      email: ownerEmail,
      passwordHash: ownerPasswordHash,
      role: "owner",
    },
  });

  // Create test merchant for manager/admin testing
  const testMerchant = await prisma.merchant.upsert({
    where: { name: "Test Merchant" },
    update: {},
    create: {
      name: "Test Merchant",
      address: "Jl. Test No. 123, Jakarta",
      phone: "+6281234567890",
      categoryId: "kuliner",
      createdBy: owner.id,
    },
  });

  // Manager account (assigned to test merchant)
  const managerEmail = "manager@wealthcrypto.fund";
  const managerPassword = "manager-test-password";
  const managerPasswordHash = await bcryptjs.hash(managerPassword, 12);

  await prisma.admin.upsert({
    where: { email: managerEmail },
    update: {},
    create: {
      email: managerEmail,
      passwordHash: managerPasswordHash,
      role: "manager",
      merchantId: testMerchant.id,
    },
  });

  // Admin account (assigned to test merchant)
  const adminEmail = "admin@wealthcrypto.fund";
  const adminPassword = "admin-test-password";
  const adminPasswordHash = await bcryptjs.hash(adminPassword, 12);

  await prisma.admin.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: adminPasswordHash,
      role: "admin",
      merchantId: testMerchant.id,
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

  console.log(`\n✅ Seeded test accounts:`);
  console.log(`   Owner: ${ownerEmail} / ${ownerPassword}`);
  console.log(`   Manager: manager@wealthcrypto.fund / manager-test-password`);
  console.log(`   Admin: admin@wealthcrypto.fund / admin-test-password`);
  console.log(`\n✅ Seeded test merchant: Test Merchant (ID: ${testMerchant.id})`);
  console.log(`✅ Seeded app settings (singleton)`);
  console.log(`✅ Seeded default fee setting`);
  console.log(`✅ Seeded ${categories.length} categories\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
