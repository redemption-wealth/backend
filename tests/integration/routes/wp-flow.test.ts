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
// HTTP-layer WEALTH-Points integration suite. Exercises the real Hono app via
// app.request(...) so routing + requireUser (Privy mock) + requireManager
// (Better-Auth DB session) + handlers + real Prisma all run against the local
// DB. Covers the cross-role loop (user redeem/convert → manager fulfill/reject →
// user sees result) plus the positive / negative / edge cases for earn, spend,
// conversion, fraud review, and error envelopes.
//
// Reliability: WP tables are wiped in beforeEach (the shared integration setup
// only cleans the redemption/merchant/admin side), and every actor uses a
// unique privyId/email so runs never collide.
// ────────────────────────────────────────────────────────────────────────────

const fixtures = createFixtures(testPrisma);

/** Point the mocked Privy client at a given user for the next requireUser call. */
function mockPrivyAs(privyUserId: string, email: string) {
  mockVerifyAuthToken.mockResolvedValue({ userId: privyUserId });
  mockGetUser.mockResolvedValue({ email: { address: email } });
}

let userSeq = 0;
function makeUser() {
  userSeq += 1;
  const uid = `${Date.now()}-${userSeq}`;
  return {
    email: `wpflow-${uid}@test.com`,
    privyUserId: `wpflow-privy-${uid}`,
    token: createTestUserToken(),
  };
}

/** Seed a MANAGER admin + a real Better-Auth session token. */
async function createManager() {
  const admin = await fixtures.createAdmin({ role: "manager" });
  const token = await createTestManagerToken({ id: admin.id, email: admin.email });
  return { admin, token };
}

/** Upsert the AppSettings singleton with the given overrides. */
async function setSettings(data: Record<string, unknown>) {
  await testPrisma.appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...data },
    update: data,
  });
}

let depositSeq = 0;
/**
 * Give `email` a CONFIRMED redemption worth `wealth` $WEALTH so the deposit gate
 * (hasDeposited) flips and the conversion deposit-cap has headroom.
 */
async function seedDeposit(email: string, wealth = 1000) {
  depositSeq += 1;
  const tag = `wpflow-dep-${Date.now()}-${depositSeq}`;
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

/** Provision the AppUser (first GET /api/wp/balance) and return the DB row. */
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

async function makeReward(overrides?: {
  wpCost?: number;
  stock?: number | null;
  isActive?: boolean;
  title?: string;
}) {
  return testPrisma.wpReward.create({
    data: {
      title: overrides?.title ?? "Test Reward",
      category: "VOUCHER",
      wpCost: overrides?.wpCost ?? 100,
      stock: overrides?.stock === undefined ? 5 : overrides.stock,
      isActive: overrides?.isActive ?? true,
    },
  });
}

beforeEach(async () => {
  // Wipe WP tables (children first — WpConversion has onDelete: Restrict on
  // AppUser). The shared setup already cleaned merchants/vouchers/redemptions.
  await testPrisma.wpConversion.deleteMany();
  await testPrisma.wpRedemption.deleteMany();
  await testPrisma.questCompletion.deleteMany();
  await testPrisma.wpLedger.deleteMany();
  await testPrisma.checkinStreak.deleteMany();
  await testPrisma.wpReward.deleteMany();
  await testPrisma.quest.deleteMany();
  await testPrisma.appUser.deleteMany();
});

// ─── EARN: check-in ──────────────────────────────────────────────────────────
describe("POST /api/quests/checkin", () => {
  test("401 without auth", async () => {
    const res = await jsonPost("/api/quests/checkin", {}, "");
    expect(res.status).toBe(401);
  });

  test("first check-in credits 1 WP; same-day repeat is idempotent (no double credit)", async () => {
    const u = makeUser();
    const appUser = await provision(u);

    mockPrivyAs(u.privyUserId, u.email);
    const first = await jsonPost("/api/quests/checkin", {}, u.token);
    expect(first.status).toBe(200);
    const b1 = await first.json();
    expect(b1.alreadyCheckedIn).toBe(false);
    expect(b1.reward).toBe(1);
    expect(b1.streak).toBe(1);
    expect(b1.balance).toBe(1);

    mockPrivyAs(u.privyUserId, u.email);
    const second = await jsonPost("/api/quests/checkin", {}, u.token);
    expect(second.status).toBe(200);
    const b2 = await second.json();
    expect(b2.alreadyCheckedIn).toBe(true);
    expect(b2.reward).toBe(0);
    expect(await balanceOf(appUser.id)).toBe(1);
  });

  test("429 when the monthly issuance cap is exhausted (does not block via 500)", async () => {
    await setSettings({ wpMonthlyCapWp: 0 });
    const u = makeUser();
    await provision(u);

    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost("/api/quests/checkin", {}, u.token);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.details).toBeUndefined(); // domain error envelope: { error } only
  });
});

// ─── EARN: claim ─────────────────────────────────────────────────────────────
describe("POST /api/quests/:key/claim", () => {
  test("claims a ONCE quest, is idempotent on the second claim", async () => {
    await testPrisma.quest.create({
      data: {
        key: "follow-x",
        title: "Follow X",
        category: "SOCIAL",
        rewardWp: 20,
        cadence: "ONCE",
      },
    });
    const u = makeUser();
    const appUser = await provision(u);

    mockPrivyAs(u.privyUserId, u.email);
    const first = await jsonPost("/api/quests/follow-x/claim", {}, u.token);
    expect(first.status).toBe(200);
    const b1 = await first.json();
    expect(b1.alreadyClaimed).toBe(false);
    expect(b1.reward).toBe(20);
    expect(b1.balance).toBe(20);

    mockPrivyAs(u.privyUserId, u.email);
    const second = await jsonPost("/api/quests/follow-x/claim", {}, u.token);
    const b2 = await second.json();
    expect(b2.alreadyClaimed).toBe(true);
    expect(await balanceOf(appUser.id)).toBe(20);
  });

  test("deposited user gets the +10% self-bonus", async () => {
    await testPrisma.quest.create({
      data: { key: "bonus-q", title: "Bonus", category: "SOCIAL", rewardWp: 100, cadence: "ONCE" },
    });
    const u = makeUser();
    await seedDeposit(u.email); // flips hasDeposited before first provision
    await provision(u);

    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost("/api/quests/bonus-q/claim", {}, u.token);
    const body = await res.json();
    expect(body.reward).toBe(110); // 100 + floor(100*0.1)
    expect(body.referralBonus).toBe(10);
  });

  test("404 for an unknown / inactive quest", async () => {
    const u = makeUser();
    await provision(u);
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost("/api/quests/does-not-exist/claim", {}, u.token);
    expect(res.status).toBe(404);
  });
});

// ─── SPEND: redeem + manager fulfill/reject (cross-role) ─────────────────────
describe("reward redemption cross-role loop", () => {
  test("full loop: redeem → PENDING (WP debited, stock decremented) → manager fulfills → user sees FULFILLED + note", async () => {
    const reward = await makeReward({ wpCost: 100, stock: 5 });
    const u = makeUser();
    await seedDeposit(u.email);
    const appUser = await provision(u);
    await adminAdjust(appUser.id, 500, "seed");

    // redeem
    mockPrivyAs(u.privyUserId, u.email);
    const redeem = await jsonPost(`/api/rewards/${reward.id}/redeem`, {}, u.token);
    expect(redeem.status).toBe(201);
    const { redemption } = await redeem.json();
    expect(redemption.status).toBe("PENDING");
    expect(await balanceOf(appUser.id)).toBe(400); // 500 - 100
    const afterStock = await testPrisma.wpReward.findUnique({ where: { id: reward.id } });
    expect(afterStock!.stock).toBe(4); // decremented

    // manager fulfills with a user-visible note
    const { token: mgr } = await createManager();
    const fulfill = await jsonPatch(
      `/api/admin/wp-redemptions/${redemption.id}`,
      { status: "FULFILLED", fulfillmentNote: "Kode: ABC123" },
      mgr,
    );
    expect(fulfill.status).toBe(200);

    // user sees it fulfilled with the note surfaced
    mockPrivyAs(u.privyUserId, u.email);
    const mine = await authGet("/api/wp/redemptions", u.token);
    const body = await mine.json();
    expect(body.redemptions[0].status).toBe("FULFILLED");
    expect(body.redemptions[0].fulfillmentNote).toBe("Kode: ABC123");
  });

  test("reject refunds WP and restores stock", async () => {
    const reward = await makeReward({ wpCost: 100, stock: 2 });
    const u = makeUser();
    await seedDeposit(u.email);
    const appUser = await provision(u);
    await adminAdjust(appUser.id, 200, "seed");

    mockPrivyAs(u.privyUserId, u.email);
    const redeem = await jsonPost(`/api/rewards/${reward.id}/redeem`, {}, u.token);
    const { redemption } = await redeem.json();
    expect(await balanceOf(appUser.id)).toBe(100);
    expect((await testPrisma.wpReward.findUnique({ where: { id: reward.id } }))!.stock).toBe(1);

    const { token: mgr } = await createManager();
    const reject = await jsonPatch(
      `/api/admin/wp-redemptions/${redemption.id}`,
      { status: "REJECTED", note: "stok bermasalah" },
      mgr,
    );
    expect(reject.status).toBe(200);

    expect(await balanceOf(appUser.id)).toBe(200); // refunded
    expect((await testPrisma.wpReward.findUnique({ where: { id: reward.id } }))!.stock).toBe(2); // restored
  });

  test("double-fulfill is 409 (idempotency guard, domain envelope)", async () => {
    const reward = await makeReward({ wpCost: 50, stock: 5 });
    const u = makeUser();
    await seedDeposit(u.email);
    const appUser = await provision(u);
    await adminAdjust(appUser.id, 100, "seed");
    mockPrivyAs(u.privyUserId, u.email);
    const { redemption } = await (await jsonPost(`/api/rewards/${reward.id}/redeem`, {}, u.token)).json();

    const { token: mgr } = await createManager();
    const ok = await jsonPatch(`/api/admin/wp-redemptions/${redemption.id}`, { status: "FULFILLED" }, mgr);
    expect(ok.status).toBe(200);
    const again = await jsonPatch(`/api/admin/wp-redemptions/${redemption.id}`, { status: "FULFILLED" }, mgr);
    expect(again.status).toBe(409);
    const body = await again.json();
    expect(body.error).toBeTruthy();
    expect(body.details).toBeUndefined();
  });

  test("negatives: not-deposited 403, insufficient WP 400, out-of-stock 409, unknown reward 404", async () => {
    // not deposited → 403 (anti-bot gate)
    const gated = await makeReward({ wpCost: 10, stock: 5 });
    const u1 = makeUser();
    await provision(u1);
    mockPrivyAs(u1.privyUserId, u1.email);
    const r403 = await jsonPost(`/api/rewards/${gated.id}/redeem`, {}, u1.token);
    expect(r403.status).toBe(403);

    // deposited but broke → 400
    const pricey = await makeReward({ wpCost: 1000, stock: 5 });
    const u2 = makeUser();
    await seedDeposit(u2.email);
    await provision(u2);
    mockPrivyAs(u2.privyUserId, u2.email);
    const r400 = await jsonPost(`/api/rewards/${pricey.id}/redeem`, {}, u2.token);
    expect(r400.status).toBe(400);

    // deposited, funded, but out of stock → 409
    const empty = await makeReward({ wpCost: 10, stock: 0 });
    const u3 = makeUser();
    await seedDeposit(u3.email);
    const au3 = await provision(u3);
    await adminAdjust(au3.id, 100, "seed");
    mockPrivyAs(u3.privyUserId, u3.email);
    const r409 = await jsonPost(`/api/rewards/${empty.id}/redeem`, {}, u3.token);
    expect(r409.status).toBe(409);

    // unknown reward id → 404
    mockPrivyAs(u3.privyUserId, u3.email);
    const r404 = await jsonPost(`/api/rewards/nonexistent-id/redeem`, {}, u3.token);
    expect(r404.status).toBe(404);
  });
});

// ─── CONVERSION: convert + manager fulfill/reject (cross-role) ───────────────
describe("WP → $WEALTH conversion cross-role loop", () => {
  async function enabledSettings(overrides?: Record<string, unknown>) {
    await setSettings({
      wpMonthlyCapWp: 1_000_000,
      wpConversionEnabled: true,
      wpConversionRate: 1000,
      wpConvertMinWp: 1000,
      wpConvertMaxWpPerMonth: 100_000,
      wpConversionMonthlyBudgetWealth: "10000",
      ...overrides,
    });
  }
  const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  test("full loop: convert burns WP → PENDING → manager fulfills with txHash → user sees FULFILLED", async () => {
    await enabledSettings();
    const u = makeUser();
    await seedDeposit(u.email, 1000);
    const appUser = await provision(u);
    await adminAdjust(appUser.id, 5000, "seed");

    mockPrivyAs(u.privyUserId, u.email);
    const conv = await jsonPost("/api/wp/convert", { wpAmount: 5000, toAddress: ADDR }, u.token);
    expect(conv.status).toBe(201);
    const { conversion } = await conv.json();
    expect(conversion.status).toBe("PENDING");
    expect(String(conversion.wealthAmount)).toBe("5"); // 5000 / 1000
    expect(await balanceOf(appUser.id)).toBe(0); // burned

    const { token: mgr } = await createManager();
    const fulfill = await jsonPatch(
      `/api/admin/wp-conversions/${conversion.id}`,
      { status: "FULFILLED", txHash: "0xdeadbeef" },
      mgr,
    );
    expect(fulfill.status).toBe(200);
    // fulfill does NOT refund
    expect(await balanceOf(appUser.id)).toBe(0);

    mockPrivyAs(u.privyUserId, u.email);
    const mine = await authGet("/api/wp/conversions", u.token);
    const body = await mine.json();
    expect(body.conversions[0].status).toBe("FULFILLED");
    expect(body.conversions[0].txHash).toBe("0xdeadbeef");
  });

  test("reject issues a CONVERT_REFUND restoring the balance", async () => {
    await enabledSettings();
    const u = makeUser();
    await seedDeposit(u.email, 1000);
    const appUser = await provision(u);
    await adminAdjust(appUser.id, 3000, "seed");

    mockPrivyAs(u.privyUserId, u.email);
    const { conversion } = await (
      await jsonPost("/api/wp/convert", { wpAmount: 2000, toAddress: ADDR }, u.token)
    ).json();
    expect(await balanceOf(appUser.id)).toBe(1000);

    const { token: mgr } = await createManager();
    const reject = await jsonPatch(
      `/api/admin/wp-conversions/${conversion.id}`,
      { status: "REJECTED", note: "budaya" },
      mgr,
    );
    expect(reject.status).toBe(200);
    expect(await balanceOf(appUser.id)).toBe(3000); // fully refunded
    const refund = await testPrisma.wpLedger.findFirst({
      where: { appUserId: appUser.id, type: "CONVERT_REFUND" },
    });
    expect(refund).not.toBeNull();
  });

  test("double-fulfill conversion → 409", async () => {
    await enabledSettings();
    const u = makeUser();
    await seedDeposit(u.email, 1000);
    const appUser = await provision(u);
    await adminAdjust(appUser.id, 2000, "seed");
    mockPrivyAs(u.privyUserId, u.email);
    const { conversion } = await (
      await jsonPost("/api/wp/convert", { wpAmount: 1000, toAddress: ADDR }, u.token)
    ).json();
    const { token: mgr } = await createManager();
    expect((await jsonPatch(`/api/admin/wp-conversions/${conversion.id}`, { status: "FULFILLED" }, mgr)).status).toBe(200);
    expect((await jsonPatch(`/api/admin/wp-conversions/${conversion.id}`, { status: "FULFILLED" }, mgr)).status).toBe(409);
  });

  test("negatives + edges: disabled 409, not-deposited 403, below-min 400, bad address 400, insufficient 400, exactly-at-min 201", async () => {
    const ADDR2 = ADDR;

    // disabled → 409
    await setSettings({ wpConversionEnabled: false });
    const uD = makeUser();
    await seedDeposit(uD.email, 1000);
    const auD = await provision(uD);
    await adminAdjust(auD.id, 5000, "s");
    mockPrivyAs(uD.privyUserId, uD.email);
    expect((await jsonPost("/api/wp/convert", { wpAmount: 1000, toAddress: ADDR2 }, uD.token)).status).toBe(409);

    // enabled from here on
    await enabledSettings();

    // not deposited → 403
    const uN = makeUser();
    const auN = await provision(uN);
    await adminAdjust(auN.id, 5000, "s");
    mockPrivyAs(uN.privyUserId, uN.email);
    expect((await jsonPost("/api/wp/convert", { wpAmount: 1000, toAddress: ADDR2 }, uN.token)).status).toBe(403);

    // below-min → 400
    const uB = makeUser();
    await seedDeposit(uB.email, 1000);
    const auB = await provision(uB);
    await adminAdjust(auB.id, 5000, "s");
    mockPrivyAs(uB.privyUserId, uB.email);
    expect((await jsonPost("/api/wp/convert", { wpAmount: 500, toAddress: ADDR2 }, uB.token)).status).toBe(400);

    // bad address → 400 with validation envelope { error, details }
    mockPrivyAs(uB.privyUserId, uB.email);
    const badAddr = await jsonPost("/api/wp/convert", { wpAmount: 1000, toAddress: "not-an-address" }, uB.token);
    expect(badAddr.status).toBe(400);
    const badBody = await badAddr.json();
    expect(badBody.error).toBeTruthy();
    expect(badBody.details).toBeDefined(); // validation envelope

    // zero amount → 400 (schema positive)
    mockPrivyAs(uB.privyUserId, uB.email);
    expect((await jsonPost("/api/wp/convert", { wpAmount: 0, toAddress: ADDR2 }, uB.token)).status).toBe(400);

    // insufficient WP → 400 (deposited, funded 0)
    const uI = makeUser();
    await seedDeposit(uI.email, 1000);
    const auI = await provision(uI); // 0 balance
    void auI;
    mockPrivyAs(uI.privyUserId, uI.email);
    expect((await jsonPost("/api/wp/convert", { wpAmount: 1000, toAddress: ADDR2 }, uI.token)).status).toBe(400);

    // exactly at min → 201
    const uMin = makeUser();
    await seedDeposit(uMin.email, 1000);
    const auMin = await provision(uMin);
    await adminAdjust(auMin.id, 1000, "s");
    mockPrivyAs(uMin.privyUserId, uMin.email);
    expect((await jsonPost("/api/wp/convert", { wpAmount: 1000, toAddress: ADDR2 }, uMin.token)).status).toBe(201);
  });

  test("over per-user monthly WP ceiling → 400", async () => {
    await enabledSettings({ wpConvertMaxWpPerMonth: 1000 });
    const u = makeUser();
    await seedDeposit(u.email, 1000);
    const appUser = await provision(u);
    await adminAdjust(appUser.id, 5000, "s");
    mockPrivyAs(u.privyUserId, u.email);
    expect((await jsonPost("/api/wp/convert", { wpAmount: 2000, toAddress: ADDR }, u.token)).status).toBe(400);
  });

  test("over anti-sybil deposit cap → 409", async () => {
    await enabledSettings();
    const u = makeUser();
    await seedDeposit(u.email, 1); // only 1 $WEALTH deposited
    const appUser = await provision(u);
    await adminAdjust(appUser.id, 5000, "s");
    mockPrivyAs(u.privyUserId, u.email);
    // 2000 WP → 2 $WEALTH > 1 deposited
    expect((await jsonPost("/api/wp/convert", { wpAmount: 2000, toAddress: ADDR }, u.token)).status).toBe(409);
  });

  test("over global monthly $WEALTH budget → 409", async () => {
    await enabledSettings({ wpConversionMonthlyBudgetWealth: "0" });
    const u = makeUser();
    await seedDeposit(u.email, 1000);
    const appUser = await provision(u);
    await adminAdjust(appUser.id, 5000, "s");
    mockPrivyAs(u.privyUserId, u.email);
    expect((await jsonPost("/api/wp/convert", { wpAmount: 2000, toAddress: ADDR }, u.token)).status).toBe(409);
  });
});

// ─── FRAUD REVIEW: status transitions; never blocks earn ─────────────────────
describe("admin fraud review", () => {
  test("sets each valid status; invalid status 400; unknown user 404", async () => {
    const u = makeUser();
    const appUser = await provision(u);
    const { token: mgr } = await createManager();

    for (const status of ["REVIEWING", "FLAGGED", "CLEARED", "NONE"]) {
      const res = await jsonPatch(`/api/admin/wp-fraud/${appUser.id}/review`, { status }, mgr);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.fraudReviewStatus).toBe(status);
    }

    const bad = await jsonPatch(`/api/admin/wp-fraud/${appUser.id}/review`, { status: "BOGUS" }, mgr);
    expect(bad.status).toBe(400);
    expect((await bad.json()).details).toBeDefined();

    const missing = await jsonPatch(`/api/admin/wp-fraud/nonexistent/review`, { status: "FLAGGED" }, mgr);
    expect(missing.status).toBe(404);
  });

  test("flagging a user does NOT block their earning", async () => {
    const u = makeUser();
    const appUser = await provision(u);
    const { token: mgr } = await createManager();
    await jsonPatch(`/api/admin/wp-fraud/${appUser.id}/review`, { status: "FLAGGED" }, mgr);

    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost("/api/quests/checkin", {}, u.token);
    expect(res.status).toBe(200);
    expect((await res.json()).reward).toBe(1); // still earns
  });
});

// ─── users/me: real PrismaPg P2002 username conflict ─────────────────────────
describe("PATCH /api/users/me", () => {
  test("partial update succeeds; duplicate username → real 409", async () => {
    const u1 = makeUser();
    await provision(u1);
    mockPrivyAs(u1.privyUserId, u1.email);
    const set = await jsonPatch("/api/users/me", { username: "takenname" }, u1.token);
    expect(set.status).toBe(200);
    expect((await set.json()).user.username).toBe("takenname");

    const u2 = makeUser();
    await provision(u2);
    mockPrivyAs(u2.privyUserId, u2.email);
    const conflict = await jsonPatch("/api/users/me", { username: "takenname" }, u2.token);
    expect(conflict.status).toBe(409); // triggered by the real P2002 unique violation
    const body = await conflict.json();
    expect(body.error).toBeTruthy();
    expect(body.details).toBeUndefined();
  });

  test("validation error → 400 with { error, details }", async () => {
    const u = makeUser();
    await provision(u);
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPatch("/api/users/me", { username: "a" }, u.token); // too short
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.details).toBeDefined();
  });
});
