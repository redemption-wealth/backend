import { Hono } from "hono";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import { getOrCreateAppUser, hasRedeemed } from "../services/appUser.js";
import { prisma } from "../db.js";
import { updateProfileSchema } from "../schemas/user.js";
import { uniqueViolationOn } from "../lib/prisma-errors.js";

const users = new Hono<AuthEnv>();

// The public user shape returned by both GET and PATCH /api/users/me. Kept in
// one place so the two endpoints stay contract-identical for the app team.
function toUserResponse(u: {
  id: string;
  email: string;
  walletAddress: string | null;
  name: string | null;
  username: string | null;
  phone: string | null;
  avatarUrl: string | null;
  referralCode: string;
  hasDeposited: boolean;
}) {
  return {
    id: u.id,
    email: u.email,
    walletAddress: u.walletAddress,
    name: u.name,
    username: u.username,
    phone: u.phone,
    avatarUrl: u.avatarUrl,
    referralCode: u.referralCode,
    hasDeposited: u.hasDeposited,
  };
}

// GET /api/users/me — the caller's own profile. Provisions the AppUser on first
// sight via getOrCreateAppUser (same path as every other user endpoint).
users.get("/me", requireUser, async (c) => {
  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });
  return c.json({
    user: toUserResponse({
      ...appUser,
      hasDeposited: await hasRedeemed(appUser.id),
    }),
  });
});

// PATCH /api/users/me — partial profile update. Username uniqueness → 409.
users.patch("/me", requireUser, async (c) => {
  const parsed = updateProfileSchema.safeParse(
    await c.req.json().catch(() => ({}))
  );
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const user = c.get("userAuth");
  const appUser = await getOrCreateAppUser({
    privyUserId: user.privyUserId,
    userEmail: user.userEmail,
  });

  try {
    const updated = await prisma.appUser.update({
      where: { id: appUser.id },
      data: parsed.data,
    });
    return c.json({
      user: toUserResponse({
        ...updated,
        hasDeposited: await hasRedeemed(updated.id),
      }),
    });
  } catch (e) {
    // Unique constraint on username → someone already took it. Reads both the
    // legacy meta.target and the PrismaPg driver-adapter constraint shape.
    if (uniqueViolationOn(e, "username")) {
      return c.json({ error: "Username sudah dipakai" }, 409);
    }
    throw e;
  }
});

export default users;
