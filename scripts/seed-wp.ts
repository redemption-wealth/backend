import "dotenv/config";
import { prisma } from "../src/db.js";

// Seeds the default WEALTH Points quests + reward catalog (plan §2). Idempotent:
// quests upsert by `key`, rewards dedupe by `title`. Safe to run repeatedly.
//
//   pnpm tsx scripts/seed-wp.ts

const QUESTS = [
  // Daily tasks (reset per WIB day)
  { key: "daily-tweet", title: "Tweet tentang $WEALTH & mention @thewealthcrypto", category: "DAILY", rewardWp: 15, cadence: "DAILY", actionUrl: "https://twitter.com/intent/tweet?text=%24WEALTH%20%40thewealthcrypto" },
  { key: "daily-gm-telegram", title: "GM / GN di Telegram Community", category: "DAILY", rewardWp: 5, cadence: "DAILY", actionUrl: "https://t.me/thewealthcrypto" },
  { key: "daily-upvote-cmc", title: "Upvote & comment $WEALTH di CoinMarketCap", category: "DAILY", rewardWp: 10, cadence: "DAILY", actionUrl: "https://coinmarketcap.com/" },
  // Social tasks (claim once). Honor-based → intentionally low WP (Phase 3 social
  // tuning): social follows are self-attested, so they pay a small nudge only.
  { key: "social-follow-x", title: "Follow X @thewealthcrypto", category: "SOCIAL", rewardWp: 5, cadence: "ONCE", actionUrl: "https://twitter.com/thewealthcrypto" },
  { key: "social-follow-ig", title: "Follow Instagram Wealth", category: "SOCIAL", rewardWp: 5, cadence: "ONCE", actionUrl: "https://instagram.com/" },
  { key: "social-follow-tiktok", title: "Follow TikTok Wealth", category: "SOCIAL", rewardWp: 5, cadence: "ONCE", actionUrl: "https://tiktok.com/" },
  { key: "social-follow-telegram", title: "Follow Telegram Channel", category: "SOCIAL", rewardWp: 5, cadence: "ONCE", actionUrl: "https://t.me/thewealthcrypto" },
  { key: "social-join-telegram", title: "Join Telegram Community", category: "SOCIAL", rewardWp: 8, cadence: "ONCE", actionUrl: "https://t.me/thewealthcrypto" },
  // Tiered milestone quests (Phase 3): user-claimed per ladder rung. Reward for
  // tier T = T * milestoneBaseWp. INVITE counts qualified referrals; REDEEM counts
  // CONFIRMED on-chain redemptions (by email).
  { key: "invite-5-friends", title: "Undang teman yang deposit", category: "INVITE", rewardWp: 0, cadence: "ONCE", targetCount: 1, milestoneBaseWp: 50, milestoneLadder: "1,3,5,10,20" },
  { key: "redeem-3-times", title: "Tukar reward on-chain", category: "REDEEM", rewardWp: 0, cadence: "ONCE", targetCount: 1, milestoneBaseWp: 30, milestoneLadder: "1,3,5,10" },
] as const;

const REWARDS = [
  { title: "Voucher Diskon F&B Rp 50.000", category: "VOUCHER", partnerName: "Dreamville Beach Club", wpCost: 500, stock: null },
  { title: "Voucher Kopi Rp 25.000", category: "VOUCHER", partnerName: "Partner F&B", wpCost: 300, stock: null },
  { title: "T-Shirt $WEALTH Limited", category: "MERCH", partnerName: "Wealth Merchandise", wpCost: 1500, stock: 50 },
  { title: "Beras Premium 5 kg", category: "SEMBAKO", partnerName: "Sembako", wpCost: 2000, stock: 100 },
] as const;

export async function seedWp() {
  let sortOrder = 0;
  for (const q of QUESTS) {
    const actionUrl = "actionUrl" in q ? q.actionUrl : null;
    const targetCount = "targetCount" in q ? q.targetCount : 1;
    const milestoneBaseWp = "milestoneBaseWp" in q ? q.milestoneBaseWp : null;
    const milestoneLadder = "milestoneLadder" in q ? q.milestoneLadder : null;
    await prisma.quest.upsert({
      where: { key: q.key },
      update: {
        title: q.title,
        category: q.category,
        rewardWp: q.rewardWp,
        cadence: q.cadence,
        actionUrl,
        targetCount,
        milestoneBaseWp,
        milestoneLadder,
        sortOrder: sortOrder++,
        isActive: true,
      },
      create: {
        key: q.key,
        title: q.title,
        category: q.category,
        rewardWp: q.rewardWp,
        cadence: q.cadence,
        actionUrl,
        targetCount,
        milestoneBaseWp,
        milestoneLadder,
        sortOrder: sortOrder - 1,
      },
    });
  }

  for (const r of REWARDS) {
    const existing = await prisma.wpReward.findFirst({ where: { title: r.title } });
    if (existing) {
      await prisma.wpReward.update({
        where: { id: existing.id },
        data: { category: r.category, partnerName: r.partnerName, wpCost: r.wpCost, isActive: true },
      });
    } else {
      await prisma.wpReward.create({ data: { ...r } });
    }
  }

  const [quests, rewards] = await Promise.all([
    prisma.quest.count(),
    prisma.wpReward.count(),
  ]);
  console.log(`✅ WP seed done — quests: ${quests}, rewards: ${rewards}`);
}

// Only run standalone when invoked directly (pnpm db:seed:wp / tsx scripts/seed-wp.ts),
// not when imported for its `seedWp` export (e.g. by scripts/wp-smoke.ts).
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("seed-wp.ts");
if (invokedDirectly) {
  seedWp()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => process.exit(0));
}
