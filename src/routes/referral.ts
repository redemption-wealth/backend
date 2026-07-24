import { Hono } from "hono";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import {
  getOrCreateAppUser,
  getReferralInfo,
  applyReferralCode,
  ReferralCodeError,
} from "../services/appUser.js";
import { applyReferralCodeSchema } from "../schemas/quest.js";

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

// POST /api/referral/apply-code — manually attach a friend's referral code
// (fallback for word-of-mouth codes). Set-once, pre-qualify, no self-referral.
referral.post("/apply-code", requireUser, async (c) => {
  const parsed = applyReferralCodeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      { error: "Kode referral tidak valid", details: parsed.error.flatten() },
      400
    );
  }
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  try {
    const info = await applyReferralCode(appUser.id, parsed.data.code);
    return c.json(info);
  } catch (e) {
    if (e instanceof ReferralCodeError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

export default referral;
