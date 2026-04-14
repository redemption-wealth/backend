import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { beforeAll, afterAll, beforeEach, vi } from "vitest";

// Create test Prisma client with adapter for Prisma 7
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const testPrisma = new PrismaClient({ adapter });

// Mock the db module so all imports use our test client
vi.mock("@/db.js", () => ({
  prisma: testPrisma,
}));

// Mock Privy client to avoid real API calls
const mockVerifyAuthToken = vi.fn();
const mockGetUser = vi.fn();

class MockPrivyClient {
  verifyAuthToken = mockVerifyAuthToken;
  getUser = mockGetUser;
}

vi.mock("@privy-io/server-auth", () => ({
  PrivyClient: MockPrivyClient,
}));

beforeAll(async () => {
  await testPrisma.$connect();
});

beforeEach(async () => {
  // Clean all tables between tests (reverse dependency order)
  await testPrisma.transaction.deleteMany();
  await testPrisma.redemption.deleteMany();
  await testPrisma.qrCode.deleteMany();
  await testPrisma.redemptionSlot.deleteMany();
  await testPrisma.voucher.deleteMany();
  await testPrisma.merchant.deleteMany();
  await testPrisma.category.deleteMany();
  await testPrisma.user.deleteMany();
  await testPrisma.admin.deleteMany();
  await testPrisma.appSettings.deleteMany();
  await testPrisma.feeSetting.deleteMany();
});

afterAll(async () => {
  await testPrisma.$disconnect();
  await pool.end();
});

export { testPrisma, mockVerifyAuthToken, mockGetUser };
