import "dotenv/config";
import { prisma } from "../src/db.js";
import { syncAppUser } from "../src/services/appUser.js";
import { checkin, claimTask } from "../src/services/quest.js";
import { getBalance, adminAdjust } from "../src/services/wp.js";
import {
  redeemReward,
  fulfillRedemption,
  rejectRedemption,
  listUserRedemptions,
  NotQualifiedError,
} from "../src/services/reward.js";
import { evaluateMilestoneQuests, listQuestsForUser } from "../src/services/quest.js";
import { getOverview } from "../src/services/wpAdmin.js";
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
  // Tear down the seeded confirmed-deposit fixtures (by email) regardless.
  await teardownConfirmedDeposit();
  if (!id) return;
  await prisma.wpConversion.deleteMany({ where: { appUserId: id } });
  await prisma.wpRedemption.deleteMany({ where: { appUserId: id } });
  await prisma.questCompletion.deleteMany({ where: { appUserId: id } });
  await prisma.wpLedger.deleteMany({ where: { appUserId: id } });
  await prisma.checkinStreak.deleteMany({ where: { appUserId: id } });
  await prisma.appUser.deleteMany({ where: { id } });
}

const DEPOSIT_MERCHANT = "smoke-convert-merchant";

// Seed a CONFIRMED redemption for EMAIL so the anti-sybil deposit cap has
// headroom (the deposit total is SUM of the user's CONFIRMED redemptions).
async function seedConfirmedDeposit() {
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

async function main() {
  await cleanup();

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

  // 3. Claim a seeded ONCE quest (+20)
  const claim1 = await claimTask(user.id, "social-follow-x");
  assert(claim1.reward === 20, "claim social-follow-x gives +20 (no self-bonus, not deposited)");
  const claim2 = await claimTask(user.id, "social-follow-x");
  assert(claim2.alreadyClaimed, "re-claim same quest is idempotent");
  assert((await getBalance(user.id)) === 21, "balance = 21 after claim");

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

  // 5. Simulate deposit + grant WP
  await prisma.appUser.update({
    where: { id: user.id },
    data: { hasDeposited: true, qualifiedAt: new Date() },
  });
  await adminAdjust(user.id, 600, "e2e top-up");
  assert((await getBalance(user.id)) === 621, "balance = 621 after grant");

  // 6. Redeem A → fulfill
  const redA = await redeemReward(user.id, reward.id);
  assert(redA.status === "PENDING" && redA.wpSpent === reward.wpCost, "redeem A creates PENDING request");
  assert((await getBalance(user.id)) === 621 - reward.wpCost, "WP debited after redeem A");
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

  // 9. REDEEM milestone quest (redeem-3-times, target 3): below target after 1
  //    fulfilled redemption → NOT awarded; then push to 3 → auto-awarded once.
  await evaluateMilestoneQuests(user.id);
  await adminAdjust(user.id, 2 * reward.wpCost, "milestone top-up"); // fund 2 more redeems
  const balBeforeMilestone = await getBalance(user.id);
  const redeem3 = await prisma.quest.findUnique({ where: { key: "redeem-3-times" } });
  assert(!!redeem3, "redeem-3-times milestone quest is seeded");
  const doneAt1 = await prisma.questCompletion.findFirst({
    where: { appUserId: user.id, questId: redeem3!.id },
  });
  assert(!doneAt1, "milestone NOT completed at 1/3 fulfilled");

  // Fulfill two more redemptions to reach 3 FULFILLED total.
  for (let i = 0; i < 2; i++) {
    const r = await redeemReward(user.id, reward.id);
    await fulfillRedemption(r.id, "admin@e2e", `code-${i}`);
  }
  const doneAt3 = await prisma.questCompletion.findFirst({
    where: { appUserId: user.id, questId: redeem3!.id },
  });
  assert(!!doneAt3, "REDEEM milestone auto-completed at 3/3 fulfilled");
  const gained = (await getBalance(user.id)) - balBeforeMilestone;
  // 2 more spends (-2*wpCost) plus the milestone reward (+rewardWp).
  assert(
    gained === redeem3!.rewardWp - 2 * reward.wpCost,
    "milestone reward credited exactly once on completion",
  );

  // 10. Quest listing surfaces milestone progress/target for the "3/5" chip.
  const listing = await listQuestsForUser(user.id);
  const redeemState = listing.quests.find((q) => q.key === "redeem-3-times") as
    | { progress?: number; target?: number; claimed: boolean }
    | undefined;
  assert(redeemState?.progress === 3 && redeemState?.target === 3, "REDEEM quest exposes progress 3/3");
  assert(redeemState?.claimed === true, "completed milestone shows as claimed");

  // 11. Admin overview aggregate returns a coherent snapshot.
  const overview = await getOverview();
  assert(typeof overview.totalWpOutstanding === "number", "overview.totalWpOutstanding is numeric");
  assert(overview.pendingRedemptions >= 0, "overview.pendingRedemptions present");
  assert(overview.pendingConversions >= 0, "overview.pendingConversions present");
  assert(overview.monthlyCapWp > 0 && overview.capUsedPct >= 0, "overview cap fields present");

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
  await seedConfirmedDeposit();

  const TO_ADDR = "0x" + "a".repeat(40);
  const convUser = { id: user.id, email: EMAIL, hasDeposited: true };

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
