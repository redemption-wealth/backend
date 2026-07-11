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
  if (!id) return;
  await prisma.wpRedemption.deleteMany({ where: { appUserId: id } });
  await prisma.questCompletion.deleteMany({ where: { appUserId: id } });
  await prisma.wpLedger.deleteMany({ where: { appUserId: id } });
  await prisma.checkinStreak.deleteMany({ where: { appUserId: id } });
  await prisma.appUser.deleteMany({ where: { id } });
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
  assert(overview.monthlyCapWp > 0 && overview.capUsedPct >= 0, "overview cap fields present");

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
