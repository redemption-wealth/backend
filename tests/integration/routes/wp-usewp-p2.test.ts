import { describe, test, expect, beforeEach } from "vitest";
import {
  testPrisma,
  mockVerifyAuthToken,
  mockGetUser,
} from "../../setup.integration.js";
import { createFixtures } from "../../helpers/fixtures.js";
import { authGet, jsonPost, jsonPatch } from "../../helpers/request.js";
import { createTestUserToken } from "../../helpers/auth.js";
import { createTestManagerToken } from "../../helpers/admin-session.js";
import { adminAdjust } from "@/services/wp.js";

// ────────────────────────────────────────────────────────────────────────────
// Phase 2 "Use WP" integration suite: physical goods (shipping capture), crypto
// campaign (wallet capture + manual payout), and reward expiry/stock gates.
// Real Hono app + real Prisma against the local test DB (Privy is the only stub).
// WP tables are wiped per-test; every actor uses a unique privyId/email.
// ────────────────────────────────────────────────────────────────────────────

const fixtures = createFixtures(testPrisma);
const ADDR = "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA";

function mockPrivyAs(privyUserId: string, email: string) {
  mockVerifyAuthToken.mockResolvedValue({ userId: privyUserId });
  mockGetUser.mockResolvedValue({ email: { address: email } });
}

let userSeq = 0;
function makeUser() {
  userSeq += 1;
  const uid = `${Date.now()}-${userSeq}`;
  return {
    email: `usewp-${uid}@test.com`,
    privyUserId: `usewp-privy-${uid}`,
    token: createTestUserToken(),
  };
}

async function createManager() {
  const admin = await fixtures.createAdmin({ role: "manager" });
  const token = await createTestManagerToken({ id: admin.id, email: admin.email });
  return { admin, token };
}

let depositSeq = 0;
/** Give `email` a CONFIRMED redemption so the hasDeposited gate flips. */
async function seedDeposit(email: string, wealth = 1000) {
  depositSeq += 1;
  const tag = `usewp-dep-${Date.now()}-${depositSeq}`;
  const merchant = await testPrisma.merchant.create({ data: { name: tag } });
  const voucher = await testPrisma.voucher.create({
    data: {
      merchantId: merchant.id,
      title: `${tag}-v`,
      basePrice: 1,
      totalStock: 1,
      remainingStock: 1,
      appFeeSnapshot: 0,
      gasFeeSnapshot: 0,
      startDate: new Date("2020-01-01"),
      expiryDate: new Date("2030-01-01"),
    },
  });
  const slot = await testPrisma.redemptionSlot.create({
    data: { voucherId: voucher.id, slotIndex: 0, status: "AVAILABLE" },
  });
  await testPrisma.redemption.create({
    data: {
      userEmail: email,
      voucherId: voucher.id,
      merchantId: merchant.id,
      slotId: slot.id,
      wealthAmount: String(wealth),
      priceIdrAtRedeem: 1,
      wealthPriceIdrAtRedeem: "1",
      appFeeAmount: "0",
      gasFeeAmount: "0",
      idempotencyKey: `${tag}-idm`,
      status: "CONFIRMED",
    },
  });
}

async function provision(u: { privyUserId: string; email: string; token: string }) {
  mockPrivyAs(u.privyUserId, u.email);
  const res = await authGet("/api/wp/balance", u.token);
  expect(res.status).toBe(200);
  const row = await testPrisma.appUser.findUnique({
    where: { privyId: u.privyUserId },
  });
  return row!;
}

async function balanceOf(appUserId: string): Promise<number> {
  const agg = await testPrisma.wpLedger.aggregate({
    _sum: { amount: true },
    where: { appUserId },
  });
  return agg._sum.amount ?? 0;
}

/** Deposited + funded user ready to redeem. */
async function fundedUser(wp = 1000) {
  const u = makeUser();
  await seedDeposit(u.email);
  const appUser = await provision(u);
  if (wp > 0) await adminAdjust(appUser.id, wp, "seed");
  return { u, appUser };
}

async function makeReward(data: Record<string, unknown>) {
  return testPrisma.wpReward.create({
    data: {
      title: "Reward",
      category: "VOUCHER",
      wpCost: 100,
      stock: 5,
      isActive: true,
      ...data,
    },
  });
}

beforeEach(async () => {
  await testPrisma.wpRewardAsset.deleteMany();
  await testPrisma.wpConversion.deleteMany();
  await testPrisma.wpRedemption.deleteMany();
  await testPrisma.questCompletion.deleteMany();
  await testPrisma.wpLedger.deleteMany();
  await testPrisma.checkinStreak.deleteMany();
  await testPrisma.wpReward.deleteMany();
  await testPrisma.quest.deleteMany();
  await testPrisma.appUser.deleteMany();
});

// ─── REQ 1: Admin CRYPTO reward category + fields ────────────────────────────
describe("admin: CRYPTO reward category + fields", () => {
  async function createReward(body: Record<string, unknown>) {
    const { token } = await createManager();
    return jsonPost("/api/admin/rewards", body, token);
  }

  test("valid CRYPTO reward is created and persists crypto fields", async () => {
    const res = await createReward({
      title: "Airdrop 5 USDC",
      category: "CRYPTO",
      wpCost: 500,
      cryptoAsset: "USDC",
      cryptoAmount: "5",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const { reward } = await res.json();
    expect(reward.category).toBe("CRYPTO");
    expect(reward.cryptoAsset).toBe("USDC");
    expect(reward.cryptoAmount).toBe("5");
    expect(new Date(reward.expiresAt).getFullYear()).toBe(2999);
    const row = await testPrisma.wpReward.findUnique({ where: { id: reward.id } });
    expect(row!.cryptoAsset).toBe("USDC");
    expect(row!.cryptoAmount).toBe("5");
    expect(row!.expiresAt).not.toBeNull();
  });

  test("CRYPTO missing expiresAt → 400", async () => {
    const res = await createReward({
      title: "Airdrop",
      category: "CRYPTO",
      wpCost: 500,
      cryptoAsset: "USDC",
      cryptoAmount: "5",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).details).toBeDefined();
  });

  test("CRYPTO missing cryptoAsset/cryptoAmount → 400", async () => {
    const res = await createReward({
      title: "Airdrop",
      category: "CRYPTO",
      wpCost: 500,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).details).toBeDefined();
  });

  test("unknown category → 400", async () => {
    const res = await createReward({ title: "X", category: "BOGUS", wpCost: 10 });
    expect(res.status).toBe(400);
    expect((await res.json()).details).toBeDefined();
  });

  test("non-CRYPTO (VOUCHER) reward still works without crypto fields", async () => {
    const res = await createReward({ title: "Voucher", category: "VOUCHER", wpCost: 10 });
    expect(res.status).toBe(201);
    const { reward } = await res.json();
    expect(reward.cryptoAsset).toBeNull();
  });
});

// ─── REQ 2: Expiry + stock enforcement on redeem (all models) ────────────────
describe("redeem: expiry + stock gates", () => {
  test("expired reward is rejected (409)", async () => {
    const reward = await makeReward({
      category: "VOUCHER",
      expiresAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost(`/api/rewards/${reward.id}/redeem`, {}, u.token);
    expect(res.status).toBe(409);
  });

  test("out-of-stock reward is rejected (409)", async () => {
    const reward = await makeReward({ category: "VOUCHER", stock: 0 });
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost(`/api/rewards/${reward.id}/redeem`, {}, u.token);
    expect(res.status).toBe(409);
  });

  test("valid non-expired in-stock reward → 201", async () => {
    const reward = await makeReward({
      category: "VOUCHER",
      stock: 5,
      expiresAt: new Date("2999-01-01T00:00:00.000Z"),
    });
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost(`/api/rewards/${reward.id}/redeem`, {}, u.token);
    expect(res.status).toBe(201);
  });
});

// ─── REQ 3: Physical goods (MERCH/SEMBAKO) shipping capture ──────────────────
describe("redeem: physical goods shipping capture", () => {
  const SHIP = {
    recipientName: "Budi",
    recipientPhone: "08123456789",
    shippingAddress: "Jl. Merdeka 1, Jakarta",
  };

  test("MERCH without shipping → 400", async () => {
    const reward = await makeReward({ category: "MERCH" });
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost(`/api/rewards/${reward.id}/redeem`, {}, u.token);
    expect(res.status).toBe(400);
  });

  test("MERCH with partial shipping (missing address) → 400", async () => {
    const reward = await makeReward({ category: "MERCH" });
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost(
      `/api/rewards/${reward.id}/redeem`,
      { recipientName: "Budi", recipientPhone: "0812" },
      u.token,
    );
    expect(res.status).toBe(400);
  });

  test("MERCH with full shipping → PENDING row stores the fields", async () => {
    const reward = await makeReward({ category: "MERCH" });
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost(`/api/rewards/${reward.id}/redeem`, SHIP, u.token);
    expect(res.status).toBe(201);
    const { redemption } = await res.json();
    expect(redemption.status).toBe("PENDING");
    const row = await testPrisma.wpRedemption.findUnique({ where: { id: redemption.id } });
    expect(row!.recipientName).toBe(SHIP.recipientName);
    expect(row!.recipientPhone).toBe(SHIP.recipientPhone);
    expect(row!.shippingAddress).toBe(SHIP.shippingAddress);
    expect(row!.walletAddress).toBeNull();
  });

  test("SEMBAKO also requires shipping", async () => {
    const reward = await makeReward({ category: "SEMBAKO" });
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    expect((await jsonPost(`/api/rewards/${reward.id}/redeem`, {}, u.token)).status).toBe(400);
  });

  test("shipping fields are IGNORED for non-physical (VOUCHER) rewards", async () => {
    const reward = await makeReward({ category: "VOUCHER" });
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost(`/api/rewards/${reward.id}/redeem`, SHIP, u.token);
    expect(res.status).toBe(201);
    const { redemption } = await res.json();
    const row = await testPrisma.wpRedemption.findUnique({ where: { id: redemption.id } });
    expect(row!.recipientName).toBeNull();
    expect(row!.shippingAddress).toBeNull();
  });

  test("shipping fields are immutable: admin fulfill does not change them", async () => {
    const reward = await makeReward({ category: "MERCH" });
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    const { redemption } = await (
      await jsonPost(`/api/rewards/${reward.id}/redeem`, SHIP, u.token)
    ).json();

    const { token: mgr } = await createManager();
    await jsonPatch(
      `/api/admin/wp-redemptions/${redemption.id}`,
      { status: "FULFILLED", fulfillmentNote: "Dikirim JNE" },
      mgr,
    );
    const row = await testPrisma.wpRedemption.findUnique({ where: { id: redemption.id } });
    expect(row!.status).toBe("FULFILLED");
    expect(row!.recipientName).toBe(SHIP.recipientName);
    expect(row!.shippingAddress).toBe(SHIP.shippingAddress);
  });
});

// ─── REQ 4: Crypto campaign wallet capture + manual payout ───────────────────
describe("redeem: crypto campaign wallet + payout", () => {
  function cryptoReward(overrides?: Record<string, unknown>) {
    return makeReward({
      category: "CRYPTO",
      cryptoAsset: "USDC",
      cryptoAmount: "5",
      expiresAt: new Date("2999-01-01T00:00:00.000Z"),
      ...overrides,
    });
  }

  test("missing wallet → 400", async () => {
    const reward = await cryptoReward();
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    expect((await jsonPost(`/api/rewards/${reward.id}/redeem`, {}, u.token)).status).toBe(400);
  });

  test("non-0x / wrong-length wallet → 400", async () => {
    const reward = await cryptoReward();
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    expect(
      (await jsonPost(`/api/rewards/${reward.id}/redeem`, { walletAddress: "not-an-address" }, u.token)).status,
    ).toBe(400);
    mockPrivyAs(u.privyUserId, u.email);
    expect(
      (await jsonPost(`/api/rewards/${reward.id}/redeem`, { walletAddress: "0x1234" }, u.token)).status,
    ).toBe(400);
    mockPrivyAs(u.privyUserId, u.email);
    expect(
      (await jsonPost(`/api/rewards/${reward.id}/redeem`, { walletAddress: "" }, u.token)).status,
    ).toBe(400);
  });

  test("valid wallet → PENDING with walletAddress stored", async () => {
    const reward = await cryptoReward();
    const { u, appUser } = await fundedUser(1000);
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost(`/api/rewards/${reward.id}/redeem`, { walletAddress: ADDR }, u.token);
    expect(res.status).toBe(201);
    const { redemption } = await res.json();
    expect(redemption.status).toBe("PENDING");
    const row = await testPrisma.wpRedemption.findUnique({ where: { id: redemption.id } });
    expect(row!.walletAddress).toBe(ADDR);
    expect(row!.recipientName).toBeNull();
    expect(await balanceOf(appUser.id)).toBe(900); // WP debited
  });

  test("fulfill records payoutTxHash → FULFILLED", async () => {
    const reward = await cryptoReward();
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    const { redemption } = await (
      await jsonPost(`/api/rewards/${reward.id}/redeem`, { walletAddress: ADDR }, u.token)
    ).json();

    const { token: mgr } = await createManager();
    const res = await jsonPatch(
      `/api/admin/wp-redemptions/${redemption.id}`,
      { status: "FULFILLED", payoutTxHash: "0xdeadbeef" },
      mgr,
    );
    expect(res.status).toBe(200);
    const row = await testPrisma.wpRedemption.findUnique({ where: { id: redemption.id } });
    expect(row!.status).toBe("FULFILLED");
    expect(row!.payoutTxHash).toBe("0xdeadbeef");
  });

  test("reject refunds WP (reuses rejectRedemption)", async () => {
    const reward = await cryptoReward();
    const { u, appUser } = await fundedUser(1000);
    mockPrivyAs(u.privyUserId, u.email);
    const { redemption } = await (
      await jsonPost(`/api/rewards/${reward.id}/redeem`, { walletAddress: ADDR }, u.token)
    ).json();
    expect(await balanceOf(appUser.id)).toBe(900);

    const { token: mgr } = await createManager();
    const res = await jsonPatch(
      `/api/admin/wp-redemptions/${redemption.id}`,
      { status: "REJECTED", note: "wallet salah" },
      mgr,
    );
    expect(res.status).toBe(200);
    expect(await balanceOf(appUser.id)).toBe(1000); // refunded
  });

  test("state machine: reject after fulfill is disallowed (409)", async () => {
    const reward = await cryptoReward();
    const { u } = await fundedUser();
    mockPrivyAs(u.privyUserId, u.email);
    const { redemption } = await (
      await jsonPost(`/api/rewards/${reward.id}/redeem`, { walletAddress: ADDR }, u.token)
    ).json();

    const { token: mgr } = await createManager();
    expect(
      (await jsonPatch(`/api/admin/wp-redemptions/${redemption.id}`, { status: "FULFILLED", payoutTxHash: "0xabc" }, mgr)).status,
    ).toBe(200);
    expect(
      (await jsonPatch(`/api/admin/wp-redemptions/${redemption.id}`, { status: "REJECTED", note: "late" }, mgr)).status,
    ).toBe(409);
  });
});

// ─── REQ 5: Gating parity — all models require hasDeposited && !FLAGGED ───────
describe("redeem: gating parity across models", () => {
  test("CRYPTO redeem by not-deposited user → 403", async () => {
    const reward = await makeReward({
      category: "CRYPTO",
      cryptoAsset: "USDC",
      cryptoAmount: "5",
      expiresAt: new Date("2999-01-01T00:00:00.000Z"),
    });
    const u = makeUser();
    await provision(u); // not deposited
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost(`/api/rewards/${reward.id}/redeem`, { walletAddress: ADDR }, u.token);
    expect(res.status).toBe(403);
  });

  test("MERCH redeem by FLAGGED user → 403", async () => {
    const reward = await makeReward({ category: "MERCH" });
    const { u, appUser } = await fundedUser();
    await testPrisma.appUser.update({
      where: { id: appUser.id },
      data: { fraudReviewStatus: "FLAGGED" },
    });
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost(
      `/api/rewards/${reward.id}/redeem`,
      { recipientName: "A", recipientPhone: "0812", shippingAddress: "Jl X" },
      u.token,
    );
    expect(res.status).toBe(403);
  });
});
