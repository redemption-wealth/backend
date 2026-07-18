/**
 * Backfill `redemptions.walletAddress` from ON-CHAIN truth.
 *
 * Why: prod `app_users` is EMPTY (user-sync never worked) and 22/23 redemptions
 * have walletAddress = NULL, so the wallet-based safety net (webhook fallback,
 * inflow sweep) has NO data to attribute treasury inflows to users. The prior
 * `backfill_app_user_wallets.sql` copied from `app_users` → backfilled nothing.
 *
 * This derives each paid redemption's payer wallet from its CONFIRMED txHash:
 * read the receipt, take the `from` of the $WEALTH→treasury transfer log. That
 * is unspoofable ground truth (the wallet that actually paid), unlike a synced
 * value. After this runs, transferMatch's redemptions.walletAddress fallback can
 * attribute future orphan inflows to the right user.
 *
 * Idempotent + read-then-write only the NULLs. DRY RUN by default.
 *   npx tsx scripts/backfill-wallets-onchain.ts            # dry run
 *   EXECUTE=true npx tsx scripts/backfill-wallets-onchain.ts
 */
import "dotenv/config";
import { createPublicClient, http } from "viem";
import { prisma } from "../src/db.js";
import { resolveChain } from "../src/lib/chain.js";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const EXECUTE = process.env.EXECUTE === "true";

async function main() {
  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  const treasury = process.env.DEV_WALLET_ADDRESS?.toLowerCase();
  const wealth = process.env.WEALTH_CONTRACT_ADDRESS?.toLowerCase();
  if (!rpcUrl || !treasury || !wealth) {
    throw new Error("ALCHEMY_RPC_URL / DEV_WALLET_ADDRESS / WEALTH_CONTRACT_ADDRESS required");
  }
  const client = createPublicClient({
    chain: resolveChain().chain,
    transport: http(rpcUrl),
  });

  const rows = await prisma.redemption.findMany({
    where: { txHash: { not: null }, walletAddress: null },
    select: { id: true, txHash: true, userEmail: true },
  });
  console.log(`Mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"} — ${rows.length} rows to backfill`);

  let done = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const receipt = await client.getTransactionReceipt({
        hash: r.txHash as `0x${string}`,
      });
      let from: string | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== wealth) continue;
        if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
        const to = `0x${log.topics[2]!.slice(-40)}`.toLowerCase();
        if (to !== treasury) continue;
        from = `0x${log.topics[1]!.slice(-40)}`.toLowerCase();
        break;
      }
      if (!from) {
        console.warn(`  ${r.id} ${r.txHash}: no $WEALTH→treasury transfer in receipt — skip`);
        failed += 1;
        continue;
      }
      console.log(`  ${r.id} (${r.userEmail}) → ${from}`);
      if (EXECUTE) {
        await prisma.redemption.update({
          where: { id: r.id },
          data: { walletAddress: from },
        });
      }
      done += 1;
    } catch (err) {
      console.error(`  ${r.id} ${r.txHash}: ${err instanceof Error ? err.message : err}`);
      failed += 1;
    }
  }
  console.log(`\n${EXECUTE ? "Backfilled" : "Would backfill"} ${done}, failed ${failed}.`);
  if (!EXECUTE) console.log("Re-run with EXECUTE=true to apply.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
