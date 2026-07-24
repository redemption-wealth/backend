import { Hono } from "hono";
import { prisma } from "../db.js";
import {
  expireStalePendingRedemptions,
  reconcileStampedPendingRedemptions,
} from "../services/redemption.js";
import { sweepTreasuryInflows } from "../services/transferMatch.js";
import { expireStaleStreaks } from "../services/quest.js";

const cron = new Hono();

// The sweep runs daily; consider it stale (alert-worthy) after this long.
const SWEEP_STALE_MS = 30 * 60 * 60 * 1000; // 30h (> daily cadence + slack)

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

  // The treasury inflow sweep runs FIRST: it is the money-critical backstop
  // (no inflow may go unrecorded), whereas the pending-expiry drain is mere
  // housekeeping. If a long drain timed out the invocation, the sweep would be
  // skipped — so do the sweep up front. (Both share one daily invocation; the
  // Vercel Hobby cron cap means no separate schedule. maxDuration is raised in
  // vercel.json so neither starves the other.)
  let inflows: Awaited<ReturnType<typeof sweepTreasuryInflows>> | null = null;
  try {
    inflows = await sweepTreasuryInflows();
    // Heartbeat: record a successful sweep so /health can detect if it ever
    // silently stops (e.g. CRON_SECRET rotated → 401 → this never runs).
    // upsert (not update): if the singleton row is absent, `update` throws
    // P2025, which gets swallowed as "sweep failed" and makes /health
    // false-positive 503. Create the row with the timestamp when missing.
    const now = new Date();
    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      update: { lastInflowSweepAt: now },
      create: { id: "singleton", lastInflowSweepAt: now },
    });
  } catch (err) {
    console.error("[cron] treasury inflow sweep failed:", err);
  }

  // R3 backstop: reconcile rows that broadcast a tx (txHash set) but are still
  // PENDING because their confirmation webhook was dropped and the user never
  // reopened the QR page. Without this they are paid-but-no-voucher forever
  // (expiry skips txHash rows; the sweep treats a known hash as handled).
  let stampedReconcile:
    | Awaited<ReturnType<typeof reconcileStampedPendingRedemptions>>
    | null = null;
  try {
    stampedReconcile = await reconcileStampedPendingRedemptions({ limit: 50 });
  } catch (err) {
    console.error("[cron] stamped-pending reconcile failed:", err);
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

  return c.json({
    ok: true,
    expired: totalExpired,
    recovered: totalRecovered,
    skipped: totalSkipped,
    ids,
    inflows,
    stampedReconcile,
  });
});

// GET /api/cron/health — PUBLIC heartbeat (no secret; non-sensitive). Reports
// how long since the treasury-inflow sweep last completed. Point an external
// uptime monitor here and alert when `stale` is true — this is what catches a
// silently-dead sweep (the CRON_SECRET-rotated-to-401 failure mode).
cron.get("/health", async (c) => {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { lastInflowSweepAt: true },
  });
  const last = settings?.lastInflowSweepAt ?? null;
  const ageMs = last ? Date.now() - last.getTime() : null;
  const stale = ageMs === null || ageMs > SWEEP_STALE_MS;
  return c.json(
    {
      inflowSweep: {
        lastAt: last,
        ageHours: ageMs === null ? null : Math.round(ageMs / 3_600_000),
        stale,
      },
    },
    stale ? 503 : 200,
  );
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
