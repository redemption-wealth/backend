import "dotenv/config";
import { prisma } from "../src/db.js";
import {
  expireStalePendingRedemptions,
  STALE_PENDING_EXPIRY_MS,
} from "../src/services/redemption.js";

/**
 * One-time / ad-hoc cleanup for redemptions stuck in PENDING with no txHash —
 * the user's wallet transaction failed (e.g. insufficient gas) before
 * broadcasting, so the redemption lingered as "menunggu" forever and its slot
 * stayed locked. Marks them FAILED and releases the slot + QR codes back to
 * stock (shared logic with the hourly Vercel cron).
 *
 * Usage:
 *   pnpm cleanup:stale-pending --dry-run
 *   pnpm cleanup:stale-pending --older-than-minutes=30
 *   pnpm cleanup:stale-pending            # uses the default stale window
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const minutesArg = args.find((a) => a.startsWith("--older-than-minutes="));
  const olderThanMinutes = minutesArg
    ? Number(minutesArg.split("=")[1])
    : STALE_PENDING_EXPIRY_MS / 60_000;
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
    throw new Error(`Invalid --older-than-minutes value: ${minutesArg}`);
  }
  return { dryRun, olderThanMinutes };
}

async function main() {
  const { dryRun, olderThanMinutes } = parseArgs();
  const olderThanMs = olderThanMinutes * 60_000;
  const cutoff = new Date(Date.now() - olderThanMs);

  const candidates = await prisma.redemption.findMany({
    where: { status: "PENDING", txHash: null, createdAt: { lt: cutoff } },
    select: { id: true, userEmail: true, voucherId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `Found ${candidates.length} stale PENDING redemption(s) with no txHash older than ${olderThanMinutes} min (before ${cutoff.toISOString()}).`,
  );
  for (const c of candidates.slice(0, 20)) {
    console.log(
      `  - ${c.id}  user=${c.userEmail}  voucher=${c.voucherId}  created=${c.createdAt.toISOString()}`,
    );
  }
  if (candidates.length > 20) {
    console.log(`  ... and ${candidates.length - 20} more`);
  }

  if (dryRun) {
    console.log("\n[dry-run] No changes made. Re-run without --dry-run to apply.");
    return;
  }

  if (candidates.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Drain in batches until none remain.
  let totalExpired = 0;
  const batchLimit = 100;
  for (;;) {
    const { expired } = await expireStalePendingRedemptions({
      olderThanMs,
      limit: batchLimit,
    });
    totalExpired += expired;
    if (expired < batchLimit) break;
  }

  console.log(`\nExpired ${totalExpired} redemption(s) → FAILED, slots released.`);
}

main()
  .catch((err) => {
    console.error("[expire-stale-pending] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
