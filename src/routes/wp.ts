import { Hono } from "hono";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import { questClaimLimiter } from "../middleware/rate-limit.js";
import { getOrCreateAppUser } from "../services/appUser.js";
import { getBalance, InsufficientWpError } from "../services/wp.js";
import { getLedger, listUserRedemptions, NotQualifiedError } from "../services/reward.js";
import {
  convertWp,
  getConvertInfo,
  listUserConversions,
  ConversionDisabledError,
  ConversionBelowMinError,
  MonthlyWpLimitError,
  DepositCapError,
  MonthlyBudgetError,
} from "../services/wpConversion.js";
import { convertWpSchema } from "../schemas/wp.js";

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

// GET /api/wp/convert-info — limits/rate the app needs to render the convert
// screen without guessing.
wp.get("/convert-info", requireUser, async (c) => {
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  const info = await getConvertInfo({
    id: appUser.id,
    email: appUser.email,
    hasDeposited: appUser.hasDeposited,
  });
  return c.json(info);
});

// GET /api/wp/conversions — the caller's own conversion requests (newest first).
wp.get("/conversions", requireUser, async (c) => {
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const conversions = await listUserConversions(appUser.id, { limit, offset });
  return c.json({ conversions });
});

// POST /api/wp/convert — burn WP to open a PENDING $WEALTH conversion request.
wp.post("/convert", requireUser, questClaimLimiter, async (c) => {
  const parsed = convertWpSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  try {
    const conversion = await convertWp(
      { id: appUser.id, email: appUser.email, hasDeposited: appUser.hasDeposited },
      parsed.data.wpAmount,
      parsed.data.toAddress
    );
    return c.json({ conversion }, 201);
  } catch (e) {
    if (e instanceof ConversionDisabledError) return c.json({ error: e.message }, 409);
    if (e instanceof NotQualifiedError) return c.json({ error: e.message }, 403);
    if (e instanceof ConversionBelowMinError) return c.json({ error: e.message }, 400);
    if (e instanceof MonthlyWpLimitError) return c.json({ error: e.message }, 400);
    if (e instanceof DepositCapError) return c.json({ error: e.message }, 409);
    if (e instanceof MonthlyBudgetError) return c.json({ error: e.message }, 409);
    if (e instanceof InsufficientWpError) return c.json({ error: "Saldo WP tidak cukup" }, 400);
    throw e;
  }
});

export default wp;
