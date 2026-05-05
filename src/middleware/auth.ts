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
};

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

export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
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

  // Fetch user email from Privy for denormalization into Redemption.userEmail
  const privyUser = await privyClient.getUser(claims.userId);
  const userEmail = privyUser.email?.address;
  if (!userEmail) {
    throw new HTTPException(400, { message: "Email not found on Privy account" });
  }

  const userAuth: UserAuth = {
    type: "user",
    userEmail,
    privyUserId: claims.userId,
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
