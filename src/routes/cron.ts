import { Hono } from "hono";
import { expireStalePendingRedemptions } from "../services/redemption.js";

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
  const ids: string[] = [];

  for (let i = 0; i < maxBatches; i += 1) {
    const { expired, ids: batchIds } = await expireStalePendingRedemptions({
      limit: batchLimit,
    });
    totalExpired += expired;
    ids.push(...batchIds);
    if (expired < batchLimit) break;
  }

  return c.json({ ok: true, expired: totalExpired, ids });
});

export default cron;
