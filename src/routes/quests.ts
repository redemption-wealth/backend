import { Hono } from "hono";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import { questClaimLimiter } from "../middleware/rate-limit.js";
import { syncSchema } from "../schemas/quest.js";
import { syncAppUser, getOrCreateAppUser } from "../services/appUser.js";
import {
  listQuestsForUser,
  checkin,
  claimTask,
  QuestNotAvailableError,
} from "../services/quest.js";
import { getBalance, WpCapExceededError } from "../services/wp.js";

const quests = new Hono<AuthEnv>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function publicAppUser(u: any) {
  return {
    id: u.id,
    email: u.email,
    walletAddress: u.walletAddress,
    referralCode: u.referralCode,
    hasDeposited: u.hasDeposited,
    qualifiedAt: u.qualifiedAt,
  };
}

const CAP_MESSAGE = "Kuota WP bulan ini sudah habis, coba lagi bulan depan.";

// POST /api/quests/sync — provision/refresh the AppUser, capture referral code.
quests.post("/sync", requireUser, async (c) => {
  const user = c.get("userAuth");
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const parsed = syncSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Input tidak valid", details: parsed.error.flatten() },
      400
    );
  }

  const appUser = await syncAppUser(
    {
      privyUserId: user.privyUserId,
      userEmail: user.userEmail,
      // Server-derived wallet ONLY — the body's walletAddress is ignored. This
      // value becomes the redemption's `expectedFrom` for the reconcile sender
      // check; trusting the client body here would let an attacker poison
      // app_users.walletAddress with a victim's address and defeat it (round-5
      // R2). Mirrors the sibling `user-sync` hardening in auth.ts.
      walletAddress: user.walletAddress,
    },
    parsed.data.referralCode ?? null
  );
  const balance = await getBalance(appUser.id);
  return c.json({ appUser: publicAppUser(appUser), balance });
});

// GET /api/quests — quests + this user's state + balance + check-in status.
quests.get("/", requireUser, async (c) => {
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  const data = await listQuestsForUser(appUser.id);
  return c.json(data);
});

// POST /api/quests/checkin — daily check-in (idempotent per WIB day).
quests.post("/checkin", requireUser, questClaimLimiter, async (c) => {
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  try {
    const result = await checkin(appUser.id);
    const balance = await getBalance(appUser.id);
    return c.json({ ...result, balance });
  } catch (e) {
    if (e instanceof WpCapExceededError) return c.json({ error: CAP_MESSAGE }, 429);
    throw e;
  }
});

// POST /api/quests/:key/claim — claim a task (honor-based, idempotent per period).
quests.post("/:key/claim", requireUser, questClaimLimiter, async (c) => {
  const user = c.get("userAuth");
  const key = c.req.param("key");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  try {
    const result = await claimTask(appUser.id, key);
    const balance = await getBalance(appUser.id);
    return c.json({ ...result, balance });
  } catch (e) {
    if (e instanceof QuestNotAvailableError)
      return c.json({ error: "Quest tidak tersedia" }, 404);
    if (e instanceof WpCapExceededError) return c.json({ error: CAP_MESSAGE }, 429);
    throw e;
  }
});

export default quests;
