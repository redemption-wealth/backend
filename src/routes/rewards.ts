import { Hono } from "hono";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import { questClaimLimiter } from "../middleware/rate-limit.js";
import { getOrCreateAppUser } from "../services/appUser.js";
import {
  listRewards,
  redeemReward,
  NotQualifiedError,
  AccountUnderReviewError,
  RewardNotAvailableError,
  OutOfStockError,
  RewardExpiredError,
  ShippingRequiredError,
  WalletAddressRequiredError,
} from "../services/reward.js";
import { InsufficientWpError } from "../services/wp.js";
import { redeemRewardSchema } from "../schemas/wp.js";

const rewards = new Hono<AuthEnv>();

// GET /api/rewards — active reward catalog.
rewards.get("/", requireUser, async (c) => {
  const items = await listRewards();
  return c.json({ rewards: items });
});

// POST /api/rewards/:id/redeem — spend WP for a reward (gated on hasDeposited).
rewards.post("/:id/redeem", requireUser, questClaimLimiter, async (c) => {
  const user = c.get("userAuth");
  const rewardId = c.req.param("id");
  // Optional fulfilment payload (shipping for physical goods, wallet for crypto).
  // Transport-level validation only; required-per-category is enforced in the
  // service against the reward's actual category.
  const parsed = redeemRewardSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  try {
    const redemption = await redeemReward(appUser.id, rewardId, parsed.data);
    return c.json({ redemption }, 201);
  } catch (e) {
    if (e instanceof AccountUnderReviewError)
      return c.json({ error: e.message }, 403);
    if (e instanceof NotQualifiedError) return c.json({ error: e.message }, 403);
    if (e instanceof RewardNotAvailableError)
      return c.json({ error: "Reward tidak tersedia" }, 404);
    if (e instanceof RewardExpiredError) return c.json({ error: e.message }, 409);
    if (e instanceof OutOfStockError) return c.json({ error: e.message }, 409);
    if (e instanceof ShippingRequiredError || e instanceof WalletAddressRequiredError)
      return c.json({ error: e.message }, 400);
    if (e instanceof InsufficientWpError)
      return c.json({ error: "Saldo WP tidak cukup" }, 400);
    throw e;
  }
});

export default rewards;
