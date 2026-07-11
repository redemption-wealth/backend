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
  // Social tasks (claim once)
  { key: "social-follow-x", title: "Follow X @thewealthcrypto", category: "SOCIAL", rewardWp: 20, cadence: "ONCE", actionUrl: "https://twitter.com/thewealthcrypto" },
  { key: "social-follow-ig", title: "Follow Instagram Wealth", category: "SOCIAL", rewardWp: 20, cadence: "ONCE", actionUrl: "https://instagram.com/" },
  { key: "social-follow-tiktok", title: "Follow TikTok Wealth", category: "SOCIAL", rewardWp: 20, cadence: "ONCE", actionUrl: "https://tiktok.com/" },
  { key: "social-follow-telegram", title: "Follow Telegram Channel", category: "SOCIAL", rewardWp: 20, cadence: "ONCE", actionUrl: "https://t.me/thewealthcrypto" },
  { key: "social-join-telegram", title: "Join Telegram Community", category: "SOCIAL", rewardWp: 25, cadence: "ONCE", actionUrl: "https://t.me/thewealthcrypto" },
  // Milestone quests (auto-awarded once the running count hits targetCount).
  { key: "invite-5-friends", title: "Undang 5 teman yang deposit", category: "INVITE", rewardWp: 250, cadence: "ONCE", targetCount: 5 },
  { key: "redeem-3-times", title: "Tukar reward 3 kali", category: "REDEEM", rewardWp: 150, cadence: "ONCE", targetCount: 3 },
] as const;

const REWARDS = [
  { title: "Voucher Diskon F&B Rp 50.000", category: "VOUCHER", partnerName: "Dreamville Beach Club", wpCost: 500, stock: null },
  { title: "Voucher Kopi Rp 25.000", category: "VOUCHER", partnerName: "Partner F&B", wpCost: 300, stock: null },
  { title: "T-Shirt $WEALTH Limited", category: "MERCH", partnerName: "Wealth Merchandise", wpCost: 1500, stock: 50 },
  { title: "Beras Premium 5 kg", category: "SEMBAKO", partnerName: "Sembako", wpCost: 2000, stock: 100 },
] as const;

async function main() {
  let sortOrder = 0;
  for (const q of QUESTS) {
    const actionUrl = "actionUrl" in q ? q.actionUrl : null;
    const targetCount = "targetCount" in q ? q.targetCount : 1;
    await prisma.quest.upsert({
      where: { key: q.key },
      update: {
        title: q.title,
        category: q.category,
        rewardWp: q.rewardWp,
        cadence: q.cadence,
        actionUrl,
        targetCount,
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

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
