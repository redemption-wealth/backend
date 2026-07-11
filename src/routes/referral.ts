import { Hono } from "hono";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import { getOrCreateAppUser, getReferralInfo } from "../services/appUser.js";

const referral = new Hono<AuthEnv>();

// GET /api/referral — referral code, headline stats, and joined-friends list.
referral.get("/", requireUser, async (c) => {
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  const info = await getReferralInfo(appUser.id);
  return c.json(info);
});

export default referral;
