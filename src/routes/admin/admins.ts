import { Hono } from "hono";
import bcryptjs from "bcryptjs";
import { randomBytes } from "node:crypto";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";
import { z } from "zod";

const adminAdmins = new Hono<AuthEnv>();

adminAdmins.use("/*", requireOwner);

// ─── Shared helpers ───────────────────────────────────────────────────────────

const adminSelect = {
  id: true,
  role: true,
  merchantId: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, email: true } },
  merchant: { select: { id: true, name: true } },
} as const;

// Returns { pendingSetup: true } when the admin's credential Account has no password.
async function withPendingSetup(admins: Array<{ user: { id: string } } & Record<string, unknown>>) {
  const userIds = admins.map((a) => a.user.id);
  const accounts = await prisma.account.findMany({
    where: { userId: { in: userIds }, providerId: "credential" },
    select: { userId: true, password: true },
  });
  const accountMap = new Map(accounts.map((a) => [a.userId, a]));

  return admins.map((a) => {
    const account = accountMap.get(a.user.id);
    return { ...a, pendingSetup: !account || account.password === null };
  });
}

// ─── List ─────────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  role: z.enum(["OWNER", "MANAGER", "ADMIN"]).optional(),
  isActive: z
    .string()
    .optional()
    .transform((v) => (v === "true" ? true : v === "false" ? false : undefined)),
  pendingSetup: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

adminAdmins.get("/", async (c) => {
  const query = listQuerySchema.safeParse({
    role: c.req.query("role") || undefined,
    isActive: c.req.query("isActive") || undefined,
    pendingSetup: c.req.query("pendingSetup") || undefined,
    search: c.req.query("search") || undefined,
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  if (!query.success) {
    return c.json({ error: "Validation failed", details: query.error.flatten() }, 400);
  }

  const { role, isActive, search, page, limit } = query.data;

  const where = {
    ...(role && { role }),
    ...(isActive !== undefined && { isActive }),
    ...(search && { user: { email: { contains: search, mode: "insensitive" as const } } }),
  };

  const [rows, total] = await Promise.all([
    prisma.admin.findMany({
      where,
      select: adminSelect,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.admin.count({ where }),
  ]);

  const admins = await withPendingSetup(rows);

  // pendingSetup filter is applied post-query (can't do it in Prisma without subquery)
  const filtered = query.data.pendingSetup
    ? admins.filter((a) => a.pendingSetup)
    : admins;

  return c.json({
    admins: filtered,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// ─── Detail ───────────────────────────────────────────────────────────────────

adminAdmins.get("/:id", async (c) => {
  const admin = await prisma.admin.findUnique({
    where: { id: c.req.param("id") },
    select: adminSelect,
  });
  if (!admin) return c.json({ error: "Admin not found" }, 404);

  const [enriched] = await withPendingSetup([admin]);
  return c.json({ admin: enriched });
});

// ─── Create ───────────────────────────────────────────────────────────────────

const createAdminSchema = z.object({
  email: z.string().email(),
  role: z.enum(["OWNER", "MANAGER", "ADMIN"]),
  merchantId: z.string().cuid().optional().nullable(),
});

adminAdmins.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = createAdminSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const { role, merchantId } = parsed.data;
  const email = parsed.data.email.toLowerCase();

  if (role === "ADMIN" && !merchantId) {
    return c.json({ error: "Admin role requires a merchantId" }, 422);
  }

  // Unique email check
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return c.json({ error: "Email already exists" }, 409);

  // Merchant validation
  if (merchantId) {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true },
    });
    if (!merchant) return c.json({ error: "Merchant not found" }, 404);
  }

  // Create User + credential Account (password NULL = pending setup) + Admin atomically
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, name: email, emailVerified: true },
    });

    // Credential account with NULL password (pending setup)
    await tx.account.create({
      data: {
        id: `credential-${user.id}`,
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: null,
      },
    });

    const admin = await tx.admin.create({
      data: { userId: user.id, role, merchantId: merchantId ?? null },
      select: adminSelect,
    });

    return admin;
  });

  const [enriched] = await withPendingSetup([result]);
  return c.json({ admin: enriched }, 201);
});

// ─── Update ───────────────────────────────────────────────────────────────────

const updateAdminSchema = z.object({
  isActive: z.boolean().optional(),
  merchantId: z.string().cuid().nullable().optional(),
}).strict();

adminAdmins.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = updateAdminSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const target = await prisma.admin.findUnique({ where: { id }, select: { role: true } });
  if (!target) return c.json({ error: "Admin not found" }, 404);

  if (parsed.data.merchantId !== undefined && target.role !== "ADMIN") {
    return c.json({ error: "merchantId can only be set for ADMIN role" }, 422);
  }

  if (parsed.data.merchantId) {
    const merchant = await prisma.merchant.findUnique({
      where: { id: parsed.data.merchantId },
      select: { id: true },
    });
    if (!merchant) return c.json({ error: "Merchant not found" }, 404);
  }

  try {
    const admin = await prisma.admin.update({
      where: { id },
      data: {
        ...(parsed.data.isActive !== undefined && { isActive: parsed.data.isActive }),
        ...(parsed.data.merchantId !== undefined && { merchantId: parsed.data.merchantId }),
      },
      select: adminSelect,
    });
    const [enriched] = await withPendingSetup([admin]);
    return c.json({ admin: enriched });
  } catch {
    return c.json({ error: "Admin not found" }, 404);
  }
});

// ─── Toggle active ────────────────────────────────────────────────────────────

adminAdmins.post("/:id/toggle-active", async (c) => {
  const id = c.req.param("id");
  const currentAdmin = c.get("adminAuth");

  if (currentAdmin.adminId === id) {
    return c.json({ error: "Cannot deactivate yourself", code: "CANNOT_DEACTIVATE_SELF" }, 403);
  }

  const target = await prisma.admin.findUnique({
    where: { id },
    select: { isActive: true, role: true },
  });
  if (!target) return c.json({ error: "Admin not found" }, 404);

  if (!target.isActive === false && target.role === "OWNER") {
    const ownerCount = await prisma.admin.count({
      where: { role: "OWNER", isActive: true },
    });
    if (ownerCount <= 1) {
      return c.json({ error: "Cannot deactivate the last active owner" }, 403);
    }
  }

  const admin = await prisma.admin.update({
    where: { id },
    data: { isActive: !target.isActive },
    select: adminSelect,
  });
  const [enriched] = await withPendingSetup([admin]);
  return c.json({ admin: enriched });
});

// ─── Reset password ───────────────────────────────────────────────────────────
// Sets Account.password = NULL, invalidates all sessions, issues a new setup token.

adminAdmins.post("/:id/reset-password", async (c) => {
  const id = c.req.param("id");
  const currentAdmin = c.get("adminAuth");

  if (currentAdmin.adminId === id) {
    return c.json({ error: "Cannot reset your own password", code: "CANNOT_RESET_SELF" }, 403);
  }

  const target = await prisma.admin.findUnique({
    where: { id },
    select: { userId: true, role: true, isActive: true },
  });
  if (!target) return c.json({ error: "Admin not found" }, 404);

  if (target.role === "OWNER") {
    const ownerCount = await prisma.admin.count({
      where: { role: "OWNER", isActive: true },
    });
    if (ownerCount <= 1) {
      return c.json(
        { error: "Cannot reset password of the last active owner", code: "CANNOT_RESET_LAST_OWNER" },
        403
      );
    }
  }

  const setupToken = randomBytes(32).toString("hex");

  await prisma.$transaction([
    // Null out the password
    prisma.account.updateMany({
      where: { userId: target.userId, providerId: "credential" },
      data: { password: null },
    }),
    // Invalidate all sessions (auto-logout)
    prisma.session.deleteMany({ where: { userId: target.userId } }),
    // Issue a fresh setup token (5 min TTL)
    prisma.passwordSetupToken.create({
      data: {
        userId: target.userId,
        token: setupToken,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    }),
  ]);

  return c.json({ ok: true, setupToken });
});

// ─── Delete ───────────────────────────────────────────────────────────────────

adminAdmins.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const currentAdmin = c.get("adminAuth");

  if (currentAdmin.adminId === id) {
    return c.json({ error: "Cannot delete yourself", code: "CANNOT_DELETE_SELF" }, 403);
  }

  const target = await prisma.admin.findUnique({
    where: { id },
    select: { userId: true, role: true },
  });
  if (!target) return c.json({ error: "Admin not found" }, 404);

  if (target.role === "OWNER") {
    const ownerCount = await prisma.admin.count({
      where: { role: "OWNER", isActive: true },
    });
    if (ownerCount <= 1) {
      return c.json({ error: "Cannot delete the last owner", code: "CANNOT_DELETE_LAST_OWNER" }, 403);
    }
  }

  // Hard delete User → cascades to Account, Session, Admin, PasswordSetupToken
  await prisma.user.delete({ where: { id: target.userId } });
  return c.json({ ok: true });
});

export default adminAdmins;
