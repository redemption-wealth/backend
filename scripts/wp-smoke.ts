import "dotenv/config";
import { prisma } from "../src/db.js";
import { seedWp } from "./seed-wp.js";
import { syncAppUser } from "../src/services/appUser.js";
import { checkin, claimTask } from "../src/services/quest.js";
import { getBalance, adminAdjust } from "../src/services/wp.js";
import {
  redeemReward,
  fulfillRedemption,
  rejectRedemption,
  listUserRedemptions,
  NotQualifiedError,
  AccountUnderReviewError,
} from "../src/services/reward.js";
import {
  claimMilestoneTier,
  claimAllMilestoneTiers,
  TierLockedError,
  listQuestsForUser,
} from "../src/services/quest.js";
import {
  getOverview,
  listAppUsers,
  getAppUserDetail,
  getFraudReport,
  setFraudReviewStatus,
} from "../src/services/wpAdmin.js";
import {
  convertWp,
  fulfillConversion,
  rejectConversion,
  getConvertInfo,
} from "../src/services/wpConversion.js";

const PRIVY_ID = "e2e-wp-test-user";
const EMAIL = "e2e-wp-test@example.com";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function cleanup(appUserId?: string) {
  const id =
    appUserId ??
    (await prisma.appUser.findUnique({ where: { privyId: PRIVY_ID } }))?.id;
  // Tear down the seeded confirmed-deposit + REDEEM-milestone fixtures regardless.
  // The on-chain redemptions carry appUserId, so they must go before the appUser.
  await teardownConfirmedDeposit();
  await teardownOnchainRedemptions();
  if (!id) return;
  await prisma.wpConversion.deleteMany({ where: { appUserId: id } });
  await prisma.wpRedemption.deleteMany({ where: { appUserId: id } });
  await prisma.questCompletion.deleteMany({ where: { appUserId: id } });
  await prisma.wpLedger.deleteMany({ where: { appUserId: id } });
  await prisma.checkinStreak.deleteMany({ where: { appUserId: id } });
  await prisma.appUser.deleteMany({ where: { id } });
}

const DEPOSIT_MERCHANT = "smoke-convert-merchant";

// Seed a CONFIRMED redemption for the smoke ACCOUNT so the anti-sybil deposit
// cap has headroom. The cap is keyed by appUserId (not the shared email), so the
// row must carry appUserId — mirroring how vouchers.ts stamps it at redeem time.
async function seedConfirmedDeposit(appUserId: string) {
  await teardownConfirmedDeposit();
  const merchant = await prisma.merchant.create({ data: { name: DEPOSIT_MERCHANT } });
  const voucher = await prisma.voucher.create({
    data: {
      merchantId: merchant.id,
      title: "smoke-convert-voucher",
      basePrice: 1,
      totalStock: 1,
      remainingStock: 1,
      appFeeSnapshot: 0,
      gasFeeSnapshot: 0,
      startDate: new Date("2020-01-01"),
      expiryDate: new Date("2030-01-01"),
    },
  });
  const slot = await prisma.redemptionSlot.create({
    data: { voucherId: voucher.id, slotIndex: 0 },
  });
  await prisma.redemption.create({
    data: {
      userEmail: EMAIL,
      appUserId,
      voucherId: voucher.id,
      merchantId: merchant.id,
      slotId: slot.id,
      wealthAmount: 1000, // 1000 $WEALTH confirmed deposit → ample cap headroom
      priceIdrAtRedeem: 1,
      wealthPriceIdrAtRedeem: 1,
      appFeeAmount: 0,
      gasFeeAmount: 0,
      idempotencyKey: `smoke-convert-${Date.now()}`,
      status: "CONFIRMED",
      confirmedAt: new Date(),
    },
  });
}

async function teardownConfirmedDeposit() {
  const merchant = await prisma.merchant.findFirst({ where: { name: DEPOSIT_MERCHANT } });
  if (!merchant) return;
  await prisma.redemption.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.redemptionSlot.deleteMany({ where: { voucher: { merchantId: merchant.id } } });
  await prisma.voucher.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.merchant.delete({ where: { id: merchant.id } });
}

const REDEEM_MILESTONE_MERCHANT = "smoke-redeem-milestone-merchant";

// Seed `count` CONFIRMED on-chain redemptions tied to this account (appUserId) —
// the tiered REDEEM milestone counts these as progress. Distinct merchant from
// the deposit-headroom fixture so teardown is independent.
async function seedOnchainRedemptions(appUserId: string, count: number) {
  await teardownOnchainRedemptions();
  const merchant = await prisma.merchant.create({
    data: { name: REDEEM_MILESTONE_MERCHANT },
  });
  const voucher = await prisma.voucher.create({
    data: {
      merchantId: merchant.id,
      title: "smoke-redeem-milestone-voucher",
      basePrice: 1,
      totalStock: count,
      remainingStock: 0,
      appFeeSnapshot: 0,
      gasFeeSnapshot: 0,
      startDate: new Date("2020-01-01"),
      expiryDate: new Date("2030-01-01"),
    },
  });
  for (let i = 0; i < count; i++) {
    const slot = await prisma.redemptionSlot.create({
      data: { voucherId: voucher.id, slotIndex: i },
    });
    await prisma.redemption.create({
      data: {
        appUserId,
        userEmail: EMAIL,
        voucherId: voucher.id,
        merchantId: merchant.id,
        slotId: slot.id,
        wealthAmount: 1,
        priceIdrAtRedeem: 1,
        wealthPriceIdrAtRedeem: 1,
        appFeeAmount: 0,
        gasFeeAmount: 0,
        idempotencyKey: `smoke-redeem-${i}-${Date.now()}`,
        status: "CONFIRMED",
        confirmedAt: new Date(),
      },
    });
  }
}

async function teardownOnchainRedemptions() {
  const merchant = await prisma.merchant.findFirst({
    where: { name: REDEEM_MILESTONE_MERCHANT },
  });
  if (!merchant) return;
  await prisma.redemption.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.redemptionSlot.deleteMany({ where: { voucher: { merchantId: merchant.id } } });
  await prisma.voucher.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.merchant.delete({ where: { id: merchant.id } });
}

async function main() {
  await cleanup();
  // Ensure the default quests + reward catalog exist (idempotent). Keeps this
  // smoke self-contained — integration tests wipe the quest/reward tables, so we
  // can't assume a prior `pnpm db:seed:wp` survived.
  await seedWp();

  // 1. Sync (provision)
  const user = await syncAppUser({ privyUserId: PRIVY_ID, userEmail: EMAIL });
  assert(!!user.referralCode, "sync creates AppUser with referral code");
  assert(user.hasDeposited === false, "new user has not deposited");

  // 2. Check-in (day 1 = +1)
  const c1 = await checkin(user.id);
  assert(c1.reward === 1 && c1.streak === 1, "first check-in gives +1 WP, streak 1");
  const c2 = await checkin(user.id);
  assert(c2.alreadyCheckedIn && c2.reward === 0, "second check-in same day is idempotent");
  assert((await getBalance(user.id)) === 1, "balance = 1 after check-in");

  // 3. Claim a seeded ONCE social quest. Honor-based social follows pay a small
  //    fixed nudge (Phase 3 tuning: social-follow-x = 5 WP), no self-bonus while
  //    the user has not deposited.
  const claim1 = await claimTask(user.id, "social-follow-x");
  assert(claim1.reward === 5, "claim social-follow-x gives +5 (honor-based social, not deposited)");
  const claim2 = await claimTask(user.id, "social-follow-x");
  assert(claim2.alreadyClaimed, "re-claim same quest is idempotent");
  assert((await getBalance(user.id)) === 6, "balance = 6 after claim (1 check-in + 5 social)");

  // 4. Redeem gated — not deposited → rejected
  const reward = await prisma.wpReward.findFirstOrThrow({
    where: { title: "Voucher Kopi Rp 25.000" },
  });
  let gated = false;
  try {
    await redeemReward(user.id, reward.id);
  } catch (e) {
    gated = e instanceof NotQualifiedError;
  }
  assert(gated, "redeem rejected with NotQualifiedError before deposit (ANTI-BOT GATE)");

  // 5. Simulate deposit (a CONFIRMED on-chain redemption — eligibility is now
  //    LIVE-derived from these, not a stored flag) + grant WP.
  await seedConfirmedDeposit(user.id);
  await adminAdjust(user.id, 600, "e2e top-up");
  assert((await getBalance(user.id)) === 606, "balance = 606 after grant (6 + 600)");

  // 6. Redeem A → fulfill
  const redA = await redeemReward(user.id, reward.id);
  assert(redA.status === "PENDING" && redA.wpSpent === reward.wpCost, "redeem A creates PENDING request");
  assert((await getBalance(user.id)) === 606 - reward.wpCost, "WP debited after redeem A");
  const fulfilled = await fulfillRedemption(redA.id, "admin@e2e", "sent");
  assert(fulfilled.status === "FULFILLED", "redeem A fulfilled");

  // 7. Redeem B → reject → refund
  const balBeforeB = await getBalance(user.id);
  const redB = await redeemReward(user.id, reward.id);
  assert((await getBalance(user.id)) === balBeforeB - reward.wpCost, "WP debited after redeem B");
  const rejected = await rejectRedemption(redB.id, "admin@e2e", "stok habis");
  assert(rejected.status === "REJECTED", "redeem B rejected");
  assert((await getBalance(user.id)) === balBeforeB, "WP refunded after reject (balance restored)");

  // 8. fulfillmentNote is user-visible via listUserRedemptions (redeem A was
  //    fulfilled with note "sent").
  const myRedemptions = await listUserRedemptions(user.id);
  const fulfilledRow = myRedemptions.find((r) => r.status === "FULFILLED");
  assert(!!fulfilledRow, "user can see their fulfilled redemption");
  assert(fulfilledRow!.fulfillmentNote === "sent", "fulfillmentNote is surfaced to the end user");
  assert(fulfilledRow!.reward.title === "Voucher Kopi Rp 25.000", "redemption carries reward info");

  // 9. REDEEM milestone quest (redeem-3-times) is TIERED (Phase 3): progress =
  //    this account's CONFIRMED ON-CHAIN redemptions (by appUserId), and the user
  //    claims each ladder rung (reward = tier × milestoneBaseWp, +10% if deposited).
  const redeem3 = await prisma.quest.findUnique({ where: { key: "redeem-3-times" } });
  assert(!!redeem3, "redeem-3-times milestone quest is seeded");
  assert(redeem3!.milestoneBaseWp === 30, "redeem-3-times is tiered (base 30 WP)");

  // The deposit in step 5 is itself a CONFIRMED on-chain redemption (deposit ==
  // redeem in the live model), so REDEEM progress already sits at 1. Add 2 more
  // (distinct merchant) to reach exactly 3 total.
  await seedOnchainRedemptions(user.id, 2);

  // Listing now exposes tiered state: progress 3 + which ladder rungs (1,3,5,10)
  // are claimable. At progress 3 only tiers 1 and 3 are reached.
  const listing = await listQuestsForUser(user.id);
  const redeemState = listing.quests.find((q) => q.key === "redeem-3-times") as
    | { tiered?: boolean; progress?: number; claimableTiers?: number[] }
    | undefined;
  assert(redeemState?.tiered === true, "redeem-3-times listed as tiered");
  assert(redeemState?.progress === 3, "REDEEM progress = 3 confirmed on-chain redemptions");
  assert(
    JSON.stringify(redeemState?.claimableTiers) === JSON.stringify([1, 3]),
    "tiers 1 and 3 claimable at progress 3 (5 and 10 still locked)",
  );

  // Claim tier 1 → 1×30 = 30 base, +10% self-bonus (deposited) = 33. Idempotent.
  const balBeforeTier = await getBalance(user.id);
  const tier1 = await claimMilestoneTier(user.id, "redeem-3-times", 1);
  assert(tier1.reward === 33, "claim tier 1 credits 30 + 10% self-bonus = 33");
  const tier1Again = await claimMilestoneTier(user.id, "redeem-3-times", 1);
  assert(tier1Again.alreadyClaimed, "re-claiming tier 1 is idempotent");

  // Tier 5 not reached yet (progress 3 < 5) → locked.
  let tier5Locked = false;
  try {
    await claimMilestoneTier(user.id, "redeem-3-times", 5);
  } catch (e) {
    tier5Locked = e instanceof TierLockedError;
  }
  assert(tier5Locked, "tier 5 locked at progress 3");

  // Claim-all sweeps only the remaining reached rung (tier 3 → 3×30 = 90, +9 = 99).
  const claimAll = await claimAllMilestoneTiers(user.id, "redeem-3-times");
  assert(
    claimAll.tiers.length === 1 && claimAll.tiers[0] === 3,
    "claim-all sweeps only the reached rung (tier 3)",
  );
  assert(claimAll.reward === 99, "claim-all tier 3 credits 90 + 10% self-bonus = 99");
  const gained = (await getBalance(user.id)) - balBeforeTier;
  assert(gained === 33 + 99, "tiered milestone credited exactly tier1 + tier3 (132 WP)");

  // 10. Listing reflects claimed tiers 1 & 3 and no further claimable rungs.
  const listing2 = await listQuestsForUser(user.id);
  const redeemState2 = listing2.quests.find((q) => q.key === "redeem-3-times") as
    | { claimedTiers?: number[]; claimableTiers?: number[] }
    | undefined;
  assert(
    JSON.stringify(redeemState2?.claimedTiers) === JSON.stringify([1, 3]),
    "claimed tiers 1 & 3 reflected in listing",
  );
  assert(
    redeemState2?.claimableTiers?.length === 0,
    "no rungs claimable until more on-chain redemptions",
  );

  // 11. Admin overview aggregate returns a coherent snapshot.
  const overview = await getOverview();
  assert(typeof overview.totalWpOutstanding === "number", "overview.totalWpOutstanding is numeric");
  assert(overview.pendingRedemptions >= 0, "overview.pendingRedemptions present");
  assert(overview.pendingConversions >= 0, "overview.pendingConversions present");
  assert(overview.monthlyCapWp > 0 && overview.capUsedPct >= 0, "overview cap fields present");

  // 11b. User-admin enrichment (Wave 4): tier / earned / lastActive.
  const listed = await listAppUsers({ search: EMAIL, limit: 10 });
  const listedUser = listed.items.find((u) => u.id === user.id);
  assert(!!listedUser, "listAppUsers surfaces the smoke user");
  assert(typeof listedUser!.totalEarnedWp === "number", "list item exposes totalEarnedWp");
  assert(["Bronze", "Silver", "Gold"].includes(listedUser!.tier), "list item exposes a valid tier");
  assert(listedUser!.lastActiveAt !== undefined, "list item exposes lastActiveAt");

  const detail = await getAppUserDetail(user.id);
  assert(!!detail && typeof detail.totalEarnedWp === "number", "detail exposes totalEarnedWp");
  assert(!!detail && ["Bronze", "Silver", "Gold"].includes(detail.tier), "detail exposes a valid tier");

  // 11c. Fraud report + manual review label round-trip (Wave 4).
  const fraud = await getFraudReport(5);
  assert(typeof fraud.summary.topEarnerWp === "number", "fraud summary topEarnerWp numeric");
  assert(Array.isArray(fraud.topEarners), "fraud report has topEarners array");
  const flagged = await setFraudReviewStatus(user.id, "FLAGGED");
  assert(flagged?.fraudReviewStatus === "FLAGGED", "setFraudReviewStatus flags the user");
  const cleared = await setFraudReviewStatus(user.id, "NONE");
  assert(cleared?.fraudReviewStatus === "NONE", "review status resets to NONE (no earning block)");

  // ─── WP → $WEALTH conversion (Wave 2) ──────────────────────────────────────
  // Enable conversion + seed a confirmed deposit so the deposit cap has room.
  const prevSettings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {
      wpConversionEnabled: true,
      wpConversionRate: 1000,
      wpConvertMinWp: 1000,
      wpConvertMaxWpPerMonth: 100000,
      wpConversionMonthlyBudgetWealth: 100000,
    },
    create: {
      id: "singleton",
      wpConversionEnabled: true,
      wpConversionRate: 1000,
      wpConvertMinWp: 1000,
      wpConvertMaxWpPerMonth: 100000,
      wpConversionMonthlyBudgetWealth: 100000,
    },
  });
  await seedConfirmedDeposit(user.id);

  const TO_ADDR = "0x" + "a".repeat(40);
  const convUser = {
    id: user.id,
    email: EMAIL,
    fraudReviewStatus: "NONE" as const,
  };

  // 11d. FLAGGED fraud-review gate blocks value-out (redeem + convert) but never
  //      earning; it is reversible. Uses the real setFraudReviewStatus label.
  await setFraudReviewStatus(user.id, "FLAGGED");
  let redeemBlocked = false;
  try {
    await redeemReward(user.id, reward.id);
  } catch (e) {
    redeemBlocked = e instanceof AccountUnderReviewError;
  }
  assert(redeemBlocked, "FLAGGED user blocked from redeem (403 fraud-review gate)");
  let convertBlocked = false;
  try {
    await convertWp({ ...convUser, fraudReviewStatus: "FLAGGED" }, 5000, TO_ADDR);
  } catch (e) {
    convertBlocked = e instanceof AccountUnderReviewError;
  }
  assert(convertBlocked, "FLAGGED user blocked from convert (403 fraud-review gate)");
  // Earning is unaffected while FLAGGED.
  const flaggedClaim = await claimTask(user.id, "social-follow-ig");
  assert(flaggedClaim.reward > 0, "FLAGGED user can still EARN (claim credited)");
  // Reversible: reset to NONE restores value-out access immediately.
  await setFraudReviewStatus(user.id, "NONE");
  const afterUnflagRedeem = await redeemReward(user.id, reward.id);
  assert(afterUnflagRedeem.status === "PENDING", "FLAGGED→NONE restores redeem access");
  await rejectRedemption(afterUnflagRedeem.id, "admin@e2e", "smoke cleanup");

  // 12. convert-info exposes limits the app needs to render the screen.
  await adminAdjust(user.id, 20000, "convert top-up"); // ensure enough WP to burn
  const info = await getConvertInfo(convUser);
  assert(info.enabled === true && info.rate === 1000, "convert-info reports enabled + rate");
  assert(info.minWp === 1000 && info.maxWpPerMonth === 100000, "convert-info reports min/max");
  assert(info.remainingWpThisMonth === 100000, "convert-info remaining = full ceiling before any convert");

  // 13. convert → fulfill (admin sends $WEALTH manually, records txHash).
  const balBeforeConv = await getBalance(user.id);
  const convA = await convertWp(convUser, 5000, TO_ADDR);
  assert(convA.status === "PENDING" && convA.wpBurned === 5000, "convert A creates PENDING (WP burned)");
  assert(convA.wealthAmount.toString() === "5", "convert A owes 5000/1000 = 5 $WEALTH");
  assert((await getBalance(user.id)) === balBeforeConv - 5000, "WP debited after convert A");
  const fulfilledConv = await fulfillConversion(convA.id, { txHash: "0xdeadbeef", fulfilledBy: "admin@e2e" });
  assert(fulfilledConv.status === "FULFILLED" && fulfilledConv.txHash === "0xdeadbeef", "convert A fulfilled with txHash (no on-chain send)");
  assert((await getBalance(user.id)) === balBeforeConv - 5000, "fulfill does NOT refund (WP stays burned)");

  // 14. convert → reject → refund (frees the budget + deposit cap).
  const balBeforeConvB = await getBalance(user.id);
  const convB = await convertWp(convUser, 3000, TO_ADDR);
  assert((await getBalance(user.id)) === balBeforeConvB - 3000, "WP debited after convert B");
  const rejectedConv = await rejectConversion(convB.id, { note: "alamat salah", fulfilledBy: "admin@e2e" });
  assert(rejectedConv.status === "REJECTED", "convert B rejected");
  assert((await getBalance(user.id)) === balBeforeConvB, "WP refunded after reject (CONVERT_REFUND restores balance)");

  // 15. remaining monthly ceiling reflects only PENDING+FULFILLED (B's reject freed its WP).
  const info2 = await getConvertInfo(convUser);
  assert(info2.remainingWpThisMonth === 100000 - 5000, "convert-info remaining reflects fulfilled 5000 only (rejected B excluded)");

  // Restore prior settings.
  if (prevSettings) {
    await prisma.appSettings.update({
      where: { id: "singleton" },
      data: {
        wpConversionEnabled: prevSettings.wpConversionEnabled,
        wpConversionRate: prevSettings.wpConversionRate,
        wpConvertMinWp: prevSettings.wpConvertMinWp,
        wpConvertMaxWpPerMonth: prevSettings.wpConvertMaxWpPerMonth,
        wpConversionMonthlyBudgetWealth: prevSettings.wpConversionMonthlyBudgetWealth,
      },
    });
  }

  await cleanup(user.id);
  console.log("\n✅ E2E WP flow PASSED");
}

main()
  .catch(async (e) => {
    console.error("\n❌", e.message);
    await cleanup().catch(() => {});
    process.exit(1);
  })
  .finally(() => process.exit(0));
