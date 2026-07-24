import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { beforeAll, afterAll, beforeEach, vi } from "vitest";
import { resolveTestDatabaseUrl } from "./helpers/assert-local-db.js";

// Guarded: refuses any non-local DB so beforeEach deleteMany() can never wipe
// the shared Supabase DEV/PROD data.
const pool = new pg.Pool({
  connectionString: resolveTestDatabaseUrl(),
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
  // Clean ALL tables between tests in FK-safe order (children first). This is
  // the single source of truth for isolation — no test file needs its own
  // cleanup, and it removes the ordering fragility where a file that leaves e.g.
  // a WpConversion row makes the NEXT file's appUser wipe hit a FK violation
  // (CI runs files in a different order than local). No integration test relies
  // on beforeAll-persisted rows, so a full wipe each test is safe.
  await testPrisma.wpConversion.deleteMany();
  await testPrisma.wpRedemption.deleteMany();
  await testPrisma.wpLedger.deleteMany();
  await testPrisma.questCompletion.deleteMany();
  await testPrisma.checkinStreak.deleteMany();
  await testPrisma.wpRewardAsset.deleteMany();
  await testPrisma.redemption.deleteMany();
  await testPrisma.qrCode.deleteMany();
  await testPrisma.redemptionSlot.deleteMany();
  await testPrisma.voucher.deleteMany();
  await testPrisma.merchant.deleteMany();
  await testPrisma.wpReward.deleteMany();
  await testPrisma.quest.deleteMany();
  await testPrisma.appUser.deleteMany();
  await testPrisma.user.deleteMany();
  await testPrisma.admin.deleteMany();
  await testPrisma.appSettings.deleteMany();
});

afterAll(async () => {
  await testPrisma.$disconnect();
  await pool.end();
});

export { testPrisma, mockVerifyAuthToken, mockGetUser };
