import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";

const adminVouchers = new Hono<AuthEnv>();

// GET /api/admin/vouchers — List all vouchers
adminVouchers.get("/", async (c) => {
  const merchantId = c.req.query("merchantId");
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  const where = {
    ...(merchantId && { merchantId }),
    ...(search && {
      title: { contains: search, mode: "insensitive" as const },
    }),
  };

  const [vouchersList, total] = await Promise.all([
    prisma.voucher.findMany({
      where,
      include: { merchant: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.voucher.count({ where }),
  ]);

  return c.json({
    vouchers: vouchersList,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// POST /api/admin/vouchers — Create voucher
adminVouchers.post("/", async (c) => {
  const {
    merchantId,
    title,
    description,
    startDate,
    endDate,
    totalStock,
    priceIdr,
  } = await c.req.json();

  const voucher = await prisma.voucher.create({
    data: {
      merchantId,
      title,
      description,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      totalStock,
      remainingStock: totalStock,
      priceIdr,
    },
  });

  return c.json({ voucher }, 201);
});

// PUT /api/admin/vouchers/:id — Update voucher
adminVouchers.put("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.req.json();

  if (data.startDate) data.startDate = new Date(data.startDate);
  if (data.endDate) data.endDate = new Date(data.endDate);

  const voucher = await prisma.voucher.update({ where: { id }, data });
  return c.json({ voucher });
});

// DELETE /api/admin/vouchers/:id — Delete voucher (owner only)
adminVouchers.delete("/:id", requireOwner, async (c) => {
  const id = c.req.param("id");
  await prisma.voucher.delete({ where: { id } });
  return c.json({ ok: true });
});

export default adminVouchers;
