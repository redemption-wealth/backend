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

  // Seed categories
  const categories = [
    {
      name: "kuliner",
      displayName: "Kuliner",
      description: "Restoran, kafe, dan tempat makan",
      icon: "🍔",
      sortOrder: 1,
    },
    {
      name: "hiburan",
      displayName: "Hiburan",
      description: "Bioskop, konser, dan hiburan lainnya",
      icon: "🎬",
      sortOrder: 2,
    },
    {
      name: "event",
      displayName: "Event",
      description: "Konferensi, workshop, dan acara khusus",
      icon: "🎉",
      sortOrder: 3,
    },
    {
      name: "kesehatan",
      displayName: "Kesehatan",
      description: "Klinik, gym, spa, dan wellness",
      icon: "💪",
      sortOrder: 4,
    },
    {
      name: "lifestyle",
      displayName: "Lifestyle",
      description: "Fashion, kecantikan, dan gaya hidup",
      icon: "✨",
      sortOrder: 5,
    },
    {
      name: "travel",
      displayName: "Travel",
      description: "Hotel, transportasi, dan wisata",
      icon: "✈️",
      sortOrder: 6,
    },
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
