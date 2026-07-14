import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";

const adminSearch = new Hono<AuthEnv>();
adminSearch.use("*", requireManager);

const PER_TYPE_LIMIT = 6;

// GET /api/admin/search?q= — global search across merchants, vouchers and app
// users. Case-insensitive substring match; a small capped set per type for the
// topbar command palette / omnisearch.
adminSearch.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 1) {
    return c.json({ merchants: [], vouchers: [], users: [] });
  }
  const contains = { contains: q, mode: "insensitive" as const };

  const [merchants, vouchers, users] = await Promise.all([
    prisma.merchant.findMany({
      where: { deletedAt: null, name: contains },
      select: { id: true, name: true, logoUrl: true, category: true, isActive: true },
      take: PER_TYPE_LIMIT,
      orderBy: { name: "asc" },
    }),
    prisma.voucher.findMany({
      where: { deletedAt: null, title: contains },
      select: {
        id: true,
        title: true,
        isActive: true,
        merchant: { select: { id: true, name: true } },
      },
      take: PER_TYPE_LIMIT,
      orderBy: { title: "asc" },
    }),
    prisma.appUser.findMany({
      where: {
        OR: [{ email: contains }, { name: contains }, { username: contains }],
      },
      select: { id: true, email: true, name: true, username: true },
      take: PER_TYPE_LIMIT,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return c.json({
    merchants: merchants.map((m) => ({
      id: m.id,
      name: m.name,
      logoUrl: m.logoUrl,
      category: m.category,
      isActive: m.isActive,
    })),
    vouchers: vouchers.map((v) => ({
      id: v.id,
      title: v.title,
      isActive: v.isActive,
      merchantId: v.merchant.id,
      merchantName: v.merchant.name,
    })),
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      username: u.username,
    })),
  });
});

export default adminSearch;
