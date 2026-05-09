import { Hono } from "hono";
import bcryptjs from "bcryptjs";
import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { requireAdmin, type AuthEnv } from "../middleware/auth.js";
import { auth } from "../lib/auth.js";
import { loginLimiter, setPasswordLimiter } from "../middleware/rate-limit.js";
import { signInSchema, setupPasswordSchema, changePasswordSchema } from "../schemas/auth.js";

const authRoutes = new Hono<AuthEnv>();

// ─── POST /api/auth/sign-in/email ────────────────────────────────────────────
// Custom login: checks Admin existence, detects NULL password, verifies bcrypt.
// On success: creates a Better Auth session and returns the token.

authRoutes.post("/sign-in/email", loginLimiter, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = signInSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const { email, password } = parsed.data;

  // Find Admin + User + credential Account in one query
  const admin = await prisma.admin.findFirst({
    where: { user: { email: { equals: email, mode: "insensitive" } } },
    include: {
      user: {
        include: {
          accounts: { where: { providerId: "credential" } },
        },
      },
    },
  });

  if (!admin || !admin.isActive) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const account = admin.user.accounts[0];

  // NULL password → pending setup flow
  if (!account || account.password === null) {
    const setupToken = randomBytes(32).toString("hex");
    await prisma.passwordSetupToken.create({
      data: {
        userId: admin.userId,
        token: setupToken,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
    return c.json({ needsPasswordSetup: true, setupToken });
  }

  const isValid = await bcryptjs.compare(password, account.password);
  if (!isValid) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Create Better Auth session (written directly to sessions table)
  const sessionToken = randomBytes(32).toString("hex");
  const session = await prisma.session.create({
    data: {
      token: sessionToken,
      userId: admin.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    },
  });

  await prisma.admin.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });

  return c.json({
    token: session.token,
    user: {
      id: admin.user.id,
      email: admin.user.email,
      role: admin.role,
    },
  });
});

// ─── POST /api/auth/sign-out ──────────────────────────────────────────────────

authRoutes.post("/sign-out", requireAdmin, async (c) => {
  const { sessionId } = c.get("adminAuth");
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
  return c.json({ ok: true });
});

// ─── GET /api/auth/get-session ────────────────────────────────────────────────

authRoutes.get("/get-session", requireAdmin, async (c) => {
  const adminAuth = c.get("adminAuth");
  return c.json({
    user: {
      id: adminAuth.userId,
      email: adminAuth.email,
      role: adminAuth.role,
      merchantId: adminAuth.merchantId,
    },
    session: { id: adminAuth.sessionId },
  });
});

// ─── POST /api/auth/setup-password ───────────────────────────────────────────
// Consumes a PasswordSetupToken, sets password, auto-issues a session.

authRoutes.post("/setup-password", setPasswordLimiter, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = setupPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const { token, password } = parsed.data;

  const setupToken = await prisma.passwordSetupToken.findUnique({ where: { token } });

  if (!setupToken || setupToken.usedAt !== null || setupToken.expiresAt < new Date()) {
    return c.json({ error: "Invalid or expired setup token" }, 401);
  }

  // Check the admin linked to this token is still active
  const admin = await prisma.admin.findUnique({
    where: { userId: setupToken.userId },
    select: { id: true, role: true, isActive: true },
  });
  if (!admin || !admin.isActive) {
    return c.json({ error: "Invalid or expired setup token" }, 401);
  }

  const hashed = await bcryptjs.hash(password, 12);

  await prisma.$transaction([
    // Mark token used
    prisma.passwordSetupToken.update({
      where: { id: setupToken.id },
      data: { usedAt: new Date() },
    }),
    // Set or update the credential Account password
    prisma.account.upsert({
      where: { id: `credential-${setupToken.userId}` },
      create: {
        id: `credential-${setupToken.userId}`,
        accountId: setupToken.userId,
        providerId: "credential",
        userId: setupToken.userId,
        password: hashed,
      },
      update: { password: hashed },
    }),
    // Update lastLoginAt
    prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    }),
  ]);

  // Auto-login: create session
  const sessionToken = randomBytes(32).toString("hex");
  const session = await prisma.session.create({
    data: {
      token: sessionToken,
      userId: setupToken.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    },
  });

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: setupToken.userId },
    select: { id: true, email: true },
  });

  return c.json({
    token: session.token,
    user: { id: user.id, email: user.email, role: admin.role },
  });
});

// ─── POST /api/auth/change-password ──────────────────────────────────────────

authRoutes.post("/change-password", requireAdmin, async (c) => {
  const adminAuth = c.get("adminAuth");
  const body = await c.req.json().catch(() => ({}));
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const { currentPassword, newPassword } = parsed.data;

  const account = await prisma.account.findFirst({
    where: { userId: adminAuth.userId, providerId: "credential" },
  });

  if (!account || !account.password) {
    return c.json({ error: "Password not set — use setup-password first" }, 400);
  }

  const isValid = await bcryptjs.compare(currentPassword, account.password);
  if (!isValid) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }

  const hashed = await bcryptjs.hash(newPassword, 12);

  await prisma.$transaction([
    prisma.account.update({
      where: { id: account.id },
      data: { password: hashed },
    }),
    // Delete all sessions except current
    prisma.session.deleteMany({
      where: { userId: adminAuth.userId, id: { not: adminAuth.sessionId } },
    }),
  ]);

  return c.json({ ok: true, message: "Password changed. Other devices logged out." });
});

// ─── POST /api/auth/sign-out-others ──────────────────────────────────────────

authRoutes.post("/sign-out-others", requireAdmin, async (c) => {
  const { userId, sessionId } = c.get("adminAuth");
  await prisma.session.deleteMany({
    where: { userId, id: { not: sessionId } },
  });
  return c.json({ ok: true });
});

export default authRoutes;
