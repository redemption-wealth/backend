import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { PrivyClient } from "@privy-io/server-auth";
import * as jose from "jose";
import { prisma } from "../db.js";

// --- Startup assertion: fail fast if secret is missing ---

if (!process.env.ADMIN_JWT_SECRET) {
  throw new Error("ADMIN_JWT_SECRET environment variable is required");
}

// --- Types ---

export type UserAuth = {
  type: "user";
  userId: string;
  email: string;
  privyUserId: string;
};

export type AdminAuth = {
  type: "admin";
  adminId: string;
  email: string;
  role: "owner" | "manager" | "admin";
  merchantId?: string;
};

export type AuthContext = UserAuth | AdminAuth;

export type AuthEnv = {
  Variables: {
    auth: AuthContext;
    userAuth: UserAuth;
    adminAuth: AdminAuth;
  };
};

// --- Privy Client ---

const privyClient = new PrivyClient(
  process.env.PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
);

export { privyClient };

// --- JWT helpers ---

const JWT_SECRET = new TextEncoder().encode(process.env.ADMIN_JWT_SECRET);

export async function createAdminToken(payload: {
  id: string;
  email: string;
  role: "owner" | "manager" | "admin";
  merchantId?: string;
}) {
  return new jose.SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("24h")
    .sign(JWT_SECRET);
}

async function verifyAdminToken(token: string) {
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET);
    return payload as unknown as {
      id: string;
      email: string;
      role: "owner" | "manager" | "admin";
      merchantId?: string;
    };
  } catch {
    return null;
  }
}

async function verifyPrivyToken(token: string) {
  try {
    return await privyClient.verifyAuthToken(token);
  } catch {
    return null;
  }
}

// --- Middleware: require user auth (Privy) ---

export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const token = authHeader.slice(7);
  const claims = await verifyPrivyToken(token);
  if (!claims) {
    throw new HTTPException(401, { message: "Invalid token" });
  }

  const user = await prisma.user.findUnique({
    where: { privyUserId: claims.userId },
  });
  if (!user) {
    throw new HTTPException(404, { message: "User not found. Please sync first." });
  }

  c.set("auth", {
    type: "user",
    userId: user.id,
    email: user.email,
    privyUserId: user.privyUserId,
  });
  c.set("userAuth", {
    type: "user",
    userId: user.id,
    email: user.email,
    privyUserId: user.privyUserId,
  });

  await next();
});

// --- Middleware: require admin auth (JWT + live DB validation) ---

export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const token = authHeader.slice(7);
  const decoded = await verifyAdminToken(token);
  if (!decoded) {
    throw new HTTPException(401, { message: "Invalid token" });
  }

  // DB check on every request — ensures deactivation and reassignment take effect instantly
  const admin = await prisma.admin.findUnique({
    where: { id: decoded.id },
    select: { id: true, email: true, role: true, merchantId: true, isActive: true },
  });

  if (!admin || !admin.isActive) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  // Populate context from DB record (not JWT payload)
  const adminAuth: AdminAuth = {
    type: "admin",
    adminId: admin.id,
    email: admin.email,
    role: admin.role as "owner" | "manager" | "admin",
    ...(admin.merchantId ? { merchantId: admin.merchantId } : {}),
  };

  c.set("auth", adminAuth);
  c.set("adminAuth", adminAuth);

  await next();
});

// --- Middleware: require owner role ---

export const requireOwner = createMiddleware<AuthEnv>(async (c, next) => {
  const admin = c.get("adminAuth");
  if (!admin || admin.role !== "owner") {
    throw new HTTPException(403, { message: "Owner access required" });
  }
  await next();
});

// --- Middleware: require manager or owner role ---

export const requireManager = createMiddleware<AuthEnv>(async (c, next) => {
  const admin = c.get("adminAuth");
  if (!admin || (admin.role !== "owner" && admin.role !== "manager")) {
    throw new HTTPException(403, { message: "Manager access required" });
  }
  await next();
});
