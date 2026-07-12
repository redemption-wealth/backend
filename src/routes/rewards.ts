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
} from "../services/reward.js";
import { InsufficientWpError } from "../services/wp.js";

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
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  try {
    const redemption = await redeemReward(appUser.id, rewardId);
    return c.json({ redemption }, 201);
  } catch (e) {
    if (e instanceof AccountUnderReviewError)
      return c.json({ error: e.message }, 403);
    if (e instanceof NotQualifiedError) return c.json({ error: e.message }, 403);
    if (e instanceof RewardNotAvailableError)
      return c.json({ error: "Reward tidak tersedia" }, 404);
    if (e instanceof OutOfStockError) return c.json({ error: e.message }, 409);
    if (e instanceof InsufficientWpError)
      return c.json({ error: "Saldo WP tidak cukup" }, 400);
    throw e;
  }
});

export default rewards;
