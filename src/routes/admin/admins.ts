import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
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

// Role/merchant contract:
//   ADMIN            → merchantId REQUIRED (scoped to one merchant)
//   MANAGER, OWNER   → merchantId MUST be absent (global scope; any value ignored)
// A missing rule surfaces as a 400 "Validation failed" instead of a 500.
export const createAdminSchema = z
  .object({
    email: z.string().email(),
    role: z.enum(["OWNER", "MANAGER", "ADMIN"]),
    // Treat "" / null (common from an unselected form field) as "no merchant".
    merchantId: z.preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z.string().cuid().optional(),
    ),
  })
  .refine((d) => d.role !== "ADMIN" || Boolean(d.merchantId), {
    path: ["merchantId"],
    message: "merchantId is required for ADMIN role",
  });

adminAdmins.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = createAdminSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const { role } = parsed.data;
  const email = parsed.data.email.toLowerCase();
  // Only ADMIN is merchant-scoped; MANAGER/OWNER are global, so any merchantId
  // they send is ignored (stored NULL).
  const merchantId = role === "ADMIN" ? (parsed.data.merchantId ?? null) : null;

  // Unique email check. Case-insensitive on purpose: we always store lowercase,
  // but the users.email unique index is case-sensitive — a legacy mixed-case row
  // would slip past an exact match and then blow up the insert (P2002) as a 500.
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return c.json({ error: "Email already exists" }, 409);

  // Merchant validation
  if (merchantId) {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true },
    });
    if (!merchant) return c.json({ error: "Merchant not found" }, 404);
  }

  // Generate a setup token so the owner can immediately share a setup link.
  // There is no email/invite provider — the token IS the invite: it is returned
  // in the response body so the owner can forward the setup link manually.
  // 24-hour TTL on initial creation (longer than reset's 5min) since the owner
  // may need time to forward the link to the new admin.
  const setupToken = randomBytes(32).toString("hex");

  try {
    // Create User + credential Account (password NULL = pending setup) + Admin + token atomically
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
        data: { userId: user.id, role, merchantId },
        select: adminSelect,
      });

      await tx.passwordSetupToken.create({
        data: {
          userId: user.id,
          token: setupToken,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      return admin;
    });

    const [enriched] = await withPendingSetup([result]);
    return c.json({ admin: enriched, setupToken }, 201);
  } catch (err) {
    // A concurrent create can still race past the pre-check above and trip the
    // unique constraint — surface that as a 409, never an unhandled 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return c.json({ error: "Email already exists" }, 409);
    }
    throw err;
  }
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
    // Issue a fresh setup token (24h TTL — owner shares the link manually,
    // so we need enough time to forward it via Slack/WA/email.)
    prisma.passwordSetupToken.create({
      data: {
        userId: target.userId,
        token: setupToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
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
