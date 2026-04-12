import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { PrivyClient } from "@privy-io/server-auth";
import * as jose from "jose";
import { prisma } from "../db.js";

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
  role: "admin" | "owner";
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

const JWT_SECRET = new TextEncoder().encode(
  process.env.ADMIN_JWT_SECRET || "change-me"
);

export async function createAdminToken(payload: {
  id: string;
  email: string;
  role: string;
}) {
  return new jose.SignJWT(payload)
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
      role: "admin" | "owner";
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

// --- Middleware: require admin auth (JWT) ---

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

  c.set("auth", {
    type: "admin",
    adminId: decoded.id,
    email: decoded.email,
    role: decoded.role,
  });
  c.set("adminAuth", {
    type: "admin",
    adminId: decoded.id,
    email: decoded.email,
    role: decoded.role,
  });

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
