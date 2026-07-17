import { Hono } from "hono";
import { expireStalePendingRedemptions } from "../services/redemption.js";
import { sweepTreasuryInflows } from "../services/transferMatch.js";
import { expireStaleStreaks } from "../services/quest.js";

const cron = new Hono();

// Verify the request comes from Vercel Cron (or an authorized caller). Vercel
// automatically attaches `Authorization: Bearer ${CRON_SECRET}` when the env var
// is set. In production a missing secret is a hard failure so the endpoint can
// never run unauthenticated.
function isAuthorized(authHeader: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }
  return authHeader === `Bearer ${secret}`;
}

// GET /api/cron/expire-pending-redemptions — sweep stale PENDING redemptions
// that never broadcast a tx (e.g. insufficient gas) into FAILED and release
// their slots back to stock. Triggered by Vercel Cron (see vercel.json).
cron.get("/expire-pending-redemptions", async (c) => {
  if (!isAuthorized(c.req.header("authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Drain in bounded batches so one run can clear a backlog without an
  // unbounded query, while still capping total work per invocation.
  const batchLimit = 100;
  const maxBatches = 10;
  let totalExpired = 0;
  let totalRecovered = 0;
  let totalSkipped = 0;
  const ids: string[] = [];

  for (let i = 0; i < maxBatches; i += 1) {
    const { expired, recovered, skipped, ids: batchIds } =
      await expireStalePendingRedemptions({ limit: batchLimit });
    totalExpired += expired;
    totalRecovered += recovered;
    totalSkipped += skipped;
    ids.push(...batchIds);
    // recovered/skipped rows stay out of `expired`, so also stop when the
    // batch came back smaller than the query limit overall.
    if (expired + recovered + skipped < batchLimit) break;
  }

  // Pull-based inflow reconciliation rides the same daily invocation (Vercel
  // Hobby caps cron jobs, so no separate schedule): every recent treasury
  // inflow the DB doesn't know is auto-matched or queued for review. This is
  // the backstop for missed/failed webhook deliveries — no inflow may ever go
  // unrecorded, even when the push path fails silently.
  let inflows: Awaited<ReturnType<typeof sweepTreasuryInflows>> | null = null;
  try {
    inflows = await sweepTreasuryInflows();
  } catch (err) {
    console.error("[cron] treasury inflow sweep failed:", err);
  }

  return c.json({
    ok: true,
    expired: totalExpired,
    recovered: totalRecovered,
    skipped: totalSkipped,
    ids,
    inflows,
  });
});

// GET /api/cron/wp-daily — daily WP housekeeping: reset stale check-in streaks
// so the displayed streak stays honest. Idempotent. Triggered by Vercel Cron.
cron.get("/wp-daily", async (c) => {
  if (!isAuthorized(c.req.header("authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const streaksReset = await expireStaleStreaks();
  return c.json({ ok: true, streaksReset });
});

export default cron;
