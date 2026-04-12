import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser, type AuthEnv } from "../middleware/auth.js";

const transactions = new Hono<AuthEnv>();

// GET /api/transactions — User: list own transactions
transactions.get("/", requireUser, async (c) => {
  const user = c.get("userAuth");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");
  const type = c.req.query("type");

  const where = {
    userId: user.userId,
    ...(type && { type: type as never }),
  };

  const [transactionsList, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.transaction.count({ where }),
  ]);

  return c.json({
    transactions: transactionsList,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

export default transactions;
