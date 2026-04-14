import { Hono } from "hono";
import bcryptjs from "bcryptjs";
import { prisma } from "../db.js";
import {
  createAdminToken,
  requireUser,
  requireAdmin,
  privyClient,
} from "../middleware/auth.js";
import { loginSchema, setPasswordSchema, changePasswordSchema } from "../schemas/auth.js";

const auth = new Hono();

// POST /api/auth/login — Admin login
auth.post("/login", async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { email, password } = parsed.data;

  const admin = await prisma.admin.findUnique({ where: { email } });

  if (!admin || !admin.isActive) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  // Check if password not set (first-login flow)
  if (!admin.passwordHash) {
    return c.json(
      { needs_password_setup: true, email: admin.email },
      200
    );
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

// POST /api/auth/set-password — First-login password flow
auth.post("/set-password", async (c) => {
  const body = await c.req.json();
  const parsed = setPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { email, password } = parsed.data;

  const admin = await prisma.admin.findUnique({ where: { email } });

  if (!admin) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  if (admin.passwordHash) {
    return c.json({ error: "Password already set" }, 409);
  }

  const passwordHash = await bcryptjs.hash(password, 12);

  await prisma.admin.update({
    where: { id: admin.id },
    data: { passwordHash },
  });

  return c.json({ message: "Password set successfully" });
});

// GET /api/auth/me — Get current admin
auth.get("/me", requireAdmin, (c) => {
  const admin = c.get("adminAuth");
  return c.json({ admin });
});

// PATCH /api/auth/change-password — Change current admin password
auth.patch("/change-password", requireAdmin, async (c) => {
  const adminAuth = c.get("adminAuth");
  const body = await c.req.json();

  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { currentPassword, newPassword } = parsed.data;

  const admin = await prisma.admin.findUnique({
    where: { id: adminAuth.adminId },
  });

  if (!admin || !admin.passwordHash) {
    return c.json({ error: "Admin not found" }, 404);
  }

  const isValid = await bcryptjs.compare(currentPassword, admin.passwordHash);
  if (!isValid) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }

  const newPasswordHash = await bcryptjs.hash(newPassword, 12);

  await prisma.admin.update({
    where: { id: admin.id },
    data: { passwordHash: newPasswordHash },
  });

  return c.json({ message: "Password berhasil diubah" });
});

// POST /api/auth/user-sync — Sync Privy user to database
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
