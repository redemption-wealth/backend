import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { PrivyClient } from "@privy-io/server-auth";
import { auth } from "../lib/auth.js";
import { prisma } from "../db.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AdminRole = "OWNER" | "MANAGER" | "ADMIN";

export type UserAuth = {
  type: "user";
  userEmail: string;
  privyUserId: string;
  // Payer wallet resolved SERVER-SIDE from the Privy account — never from a
  // client-supplied field. Null if the embedded wallet isn't provisioned yet.
  walletAddress: string | null;
};

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Extract the user's embedded wallet address from the Privy user object,
 * server-side. This is the trusted source of wallet↔user ownership — the
 * client body must never be believed (it could claim someone else's wallet).
 */
export function extractPrivyWallet(privyUser: {
  wallet?: { address?: string };
  linkedAccounts?: Array<{ type?: string; address?: string }>;
}): string | null {
  const candidate =
    privyUser.wallet?.address ??
    privyUser.linkedAccounts?.find(
      (a) => a.type === "wallet" && typeof a.address === "string",
    )?.address ??
    null;
  if (!candidate || !WALLET_RE.test(candidate)) return null;
  return candidate.toLowerCase();
}

export type AdminAuth = {
  type: "admin";
  adminId: string;
  userId: string;
  sessionId: string;
  email: string;
  role: AdminRole;
  merchantId?: string;
};

export type AuthEnv = {
  Variables: {
    auth: UserAuth | AdminAuth;
    userAuth: UserAuth;
    adminAuth: AdminAuth;
  };
};

// ─── Privy (user-facing) ─────────────────────────────────────────────────────

const privyClient = new PrivyClient(
  process.env.PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
);

export { privyClient };

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  DEV-ONLY AUTH BYPASS — READ BEFORE TOUCHING                               ║
// ║                                                                           ║
// ║  This exists so local automated HTTP integration/e2e tests can            ║
// ║  authenticate offline, WITHOUT a real Privy token (no network to Privy).  ║
// ║                                                                           ║
// ║  It is active ONLY when BOTH are true:                                    ║
// ║    • process.env.NODE_ENV !== 'production'                                ║
// ║    • process.env.DEV_AUTH_BYPASS === 'true'                               ║
// ║  If either check fails, this function returns null and the normal Privy   ║
// ║  verification below runs completely unchanged. It can NEVER activate in   ║
// ║  production: even if DEV_AUTH_BYPASS were somehow set there, NODE_ENV      ║
// ║  === 'production' short-circuits it to inert.                             ║
// ║                                                                           ║
// ║  DEV_AUTH_BYPASS is intentionally NOT committed anywhere; the test runner ║
// ║  supplies it at runtime. Do not hardcode it.                              ║
// ║                                                                           ║
// ║  Mechanism: when active and the request carries `x-dev-user-id`, we skip  ║
// ║  privyClient.verifyAuthToken + privyClient.getUser and synthesize the     ║
// ║  same UserAuth the real path would, keyed to that Privy user id. Email    ║
// ║  falls back to `<id>@dev.local` so the email-keyed deposit gate works.    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
function resolveDevBypassAuth(c: {
  req: { header: (name: string) => string | undefined };
}): UserAuth | null {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DEV_AUTH_BYPASS !== "true"
  ) {
    return null;
  }
  const devUserId = c.req.header("x-dev-user-id");
  if (!devUserId) return null;

  const devEmail = c.req.header("x-dev-user-email") || `${devUserId}@dev.local`;
  const devWallet = c.req.header("x-dev-wallet");
  return {
    type: "user",
    userEmail: devEmail,
    privyUserId: devUserId,
    walletAddress:
      devWallet && WALLET_RE.test(devWallet) ? devWallet.toLowerCase() : null,
  };
}

export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
  // Dev-only bypass (see the loud block above). Inert unless NODE_ENV is
  // non-production AND DEV_AUTH_BYPASS === 'true' AND the header is present.
  const devAuth = resolveDevBypassAuth(c);
  if (devAuth) {
    c.set("auth", devAuth);
    c.set("userAuth", devAuth);
    await next();
    return;
  }

  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const token = authHeader.slice(7);

  let claims;
  try {
    claims = await privyClient.verifyAuthToken(token);
  } catch {
    throw new HTTPException(401, { message: "Invalid token" });
  }

  // Fetch user email from Privy for denormalization into Redemption.userEmail.
  // getUser hits auth.privy.io over the network on every request, so a Privy
  // outage/timeout must surface as a 503 (retryable) — NOT an unhandled throw
  // that the global onError turns into a generic 500.
  let privyUser;
  try {
    privyUser = await privyClient.getUser(claims.userId);
  } catch (err) {
    console.error("[auth] privy getUser failed:", err);
    throw new HTTPException(503, { message: "Auth provider unavailable" });
  }
  const userEmail = privyUser.email?.address;
  if (!userEmail) {
    throw new HTTPException(400, { message: "Email not found on Privy account" });
  }

  const userAuth: UserAuth = {
    type: "user",
    userEmail,
    privyUserId: claims.userId,
    walletAddress: extractPrivyWallet(privyUser),
  };
  c.set("auth", userAuth);
  c.set("userAuth", userAuth);

  await next();
});

// ─── Admin auth (Better Auth sessions) ───────────────────────────────────────

export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  // auth.api.getSession reads Bearer token via the bearer plugin,
  // then looks up the session row in DB by token.
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  // Live DB check: ensures deactivation takes effect immediately.
  const admin = await prisma.admin.findUnique({
    where: { userId: session.user.id },
    select: { id: true, role: true, merchantId: true, isActive: true },
  });

  if (!admin || !admin.isActive) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const adminAuth: AdminAuth = {
    type: "admin",
    adminId: admin.id,
    userId: session.user.id,
    sessionId: session.session.id,
    email: session.user.email,
    role: admin.role as AdminRole,
    ...(admin.merchantId ? { merchantId: admin.merchantId } : {}),
  };

  c.set("auth", adminAuth);
  c.set("adminAuth", adminAuth);

  await next();
});

// ─── Role guards (run after requireAdmin) ────────────────────────────────────

// Owner-only. Owner does NOT have access to Manager routes.
export const requireOwner = createMiddleware<AuthEnv>(async (c, next) => {
  const admin = c.get("adminAuth");
  if (!admin || admin.role !== "OWNER") {
    throw new HTTPException(403, { message: "Owner access required" });
  }
  await next();
});

// Owner OR Manager — read endpoints both oversight (owner) and operations
// (manager) need, e.g. the redemptions list behind Activity Log & Transaksi.
export const requireOwnerOrManager = createMiddleware<AuthEnv>(async (c, next) => {
  const admin = c.get("adminAuth");
  if (!admin || (admin.role !== "OWNER" && admin.role !== "MANAGER")) {
    throw new HTTPException(403, { message: "Owner or Manager access required" });
  }
  await next();
});

// Manager-only. Owner does NOT have access to Manager routes.
export const requireManager = createMiddleware<AuthEnv>(async (c, next) => {
  const admin = c.get("adminAuth");
  if (!admin || admin.role !== "MANAGER") {
    throw new HTTPException(403, { message: "Manager access required" });
  }
  await next();
});

// Admin role only (merchant-level staff who scan QR codes)
export const requireAdminRole = createMiddleware<AuthEnv>(async (c, next) => {
  const admin = c.get("adminAuth");
  if (!admin || admin.role !== "ADMIN") {
    throw new HTTPException(403, { message: "Admin access required" });
  }
  await next();
});

// Manager OR Admin (for endpoints accessible to both operational roles)
export const requireManagerOrAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  const admin = c.get("adminAuth");
  if (!admin || (admin.role !== "MANAGER" && admin.role !== "ADMIN")) {
    throw new HTTPException(403, { message: "Manager or Admin access required" });
  }
  await next();
});
