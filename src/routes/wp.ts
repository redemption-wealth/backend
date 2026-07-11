import { Hono } from "hono";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import { getOrCreateAppUser } from "../services/appUser.js";
import { getBalance } from "../services/wp.js";
import { getLedger, listUserRedemptions } from "../services/reward.js";

const wp = new Hono<AuthEnv>();

// GET /api/wp/balance — current WP balance + deposit-gate status.
wp.get("/balance", requireUser, async (c) => {
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  return c.json({
    balance: await getBalance(appUser.id),
    hasDeposited: appUser.hasDeposited,
  });
});

// GET /api/wp/ledger — WP transaction history (newest first).
wp.get("/ledger", requireUser, async (c) => {
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const entries = await getLedger(appUser.id, { limit, offset });
  return c.json({ entries });
});

// GET /api/wp/redemptions — the caller's own reward redemptions (newest first),
// including the user-visible fulfillmentNote once fulfilled.
wp.get("/redemptions", requireUser, async (c) => {
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const redemptions = await listUserRedemptions(appUser.id, { limit, offset });
  return c.json({ redemptions });
});

export default wp;
