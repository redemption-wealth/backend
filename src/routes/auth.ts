import { Hono } from "hono";
import bcryptjs from "bcryptjs";
import { prisma } from "../db.js";
import {
  createAdminToken,
  requireUser,
  requireAdmin,
  privyClient,
} from "../middleware/auth.js";

const auth = new Hono();

// POST /api/auth/login — Admin login
auth.post("/login", async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  const admin = await prisma.admin.findUnique({ where: { email } });

  if (!admin || !admin.isActive) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const isValid = await bcryptjs.compare(password, admin.passwordHash);
  if (!isValid) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const token = await createAdminToken({
    id: admin.id,
    email: admin.email,
    role: admin.role,
  });

  return c.json({
    token,
    admin: {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      isActive: admin.isActive,
      createdAt: admin.createdAt,
      updatedAt: admin.updatedAt,
    },
  });
});

// GET /api/auth/me — Get current admin
auth.get("/me", requireAdmin, (c) => {
  const admin = c.get("adminAuth");
  return c.json({ admin });
});

// POST /api/auth/user-sync — Sync Privy user to database
// No requireUser middleware here — first-time users don't exist in DB yet
auth.post("/user-sync", async (c) => {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.slice(7);

  let claims;
  try {
    claims = await privyClient.verifyAuthToken(token);
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }

  const privyUser = await privyClient.getUser(claims.userId);
  const email = privyUser.email?.address;
  const wallet = privyUser.wallet?.address;

  if (!email) {
    return c.json({ error: "Email not found" }, 400);
  }

  const user = await prisma.user.upsert({
    where: { privyUserId: claims.userId },
    update: {
      email,
      walletAddress: wallet ?? undefined,
    },
    create: {
      privyUserId: claims.userId,
      email,
      walletAddress: wallet,
    },
  });

  return c.json({ user });
});

export default auth;
