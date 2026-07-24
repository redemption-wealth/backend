import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import {
  ignoreUnmatchedTransfer,
  manualFulfillUnmatchedTransfer,
  matchUnmatchedTransfer,
  refundUnmatchedTransfer,
} from "../../services/refund.js";

/**
 * "Perlu Tinjauan" review queue — treasury inflows the hybrid matcher could
 * not resolve to exactly one PENDING redemption. Admin picks the right
 * candidate (→ voucher issued via the normal confirm path), records a
 * verified refund, or ignores with a mandatory audit note.
 */
const unmatchedTransfers = new Hono<AuthEnv>();

const STATUSES = ["OPEN", "MATCHED", "REFUNDED", "IGNORED"] as const;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// GET /api/admin/unmatched-transfers/count — badge for the back-office menu
unmatchedTransfers.get("/count", requireManager, async (c) => {
  const open = await prisma.unmatchedTransfer.count({ where: { status: "OPEN" } });
  return c.json({ open });
});

// GET /api/admin/unmatched-transfers?status=OPEN — list with candidates
unmatchedTransfers.get("/", requireManager, async (c) => {
  const statusRaw = c.req.query("status")?.toUpperCase();
  const status = STATUSES.includes(statusRaw as never)
    ? (statusRaw as (typeof STATUSES)[number])
    : undefined;
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1") || 1);
  const limit = Math.max(1, parseInt(c.req.query("limit") ?? "20") || 20);

  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    prisma.unmatchedTransfer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.unmatchedTransfer.count({ where }),
  ]);

  // Attach the user's open PENDING candidates so the admin can pair in one
  // click. Only meaningful while the transfer is OPEN and the wallet is known.
  const withCandidates = await Promise.all(
    rows.map(async (row) => {
      if (row.status !== "OPEN" || !row.userEmail) {
        return { ...row, amount: row.amount.toString(), candidates: [] };
      }
      const candidates = await prisma.redemption.findMany({
        where: { userEmail: row.userEmail, status: "PENDING", txHash: null },
        select: {
          id: true,
          wealthAmount: true,
          createdAt: true,
          voucher: { select: { title: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      return {
        ...row,
        amount: row.amount.toString(),
        candidates: candidates.map((r) => ({
          id: r.id,
          voucherTitle: r.voucher.title,
          wealthAmount: r.wealthAmount.toString(),
          createdAt: r.createdAt,
          amountMatches: r.wealthAmount.sub(row.amount).abs().lt(1e-9),
        })),
      };
    }),
  );

  return c.json({
    transfers: withCandidates,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// POST /api/admin/unmatched-transfers/:id/match — pair with a redemption
unmatchedTransfers.post("/:id/match", requireManager, async (c) => {
  const id = c.req.param("id");
  const admin = c.get("adminAuth");
  let body: { redemptionId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.redemptionId || typeof body.redemptionId !== "string") {
    return c.json({ error: "redemptionId is required" }, 400);
  }

  try {
    const row = await matchUnmatchedTransfer(id, body.redemptionId, admin.email);
    return c.json({ transfer: { ...row, amount: row.amount.toString() } });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Match failed" }, 400);
  }
});

// POST /api/admin/unmatched-transfers/:id/fulfill — manual fulfillment: create
// a fresh CONFIRMED redemption for the chosen voucher, priced by what was
// actually paid, bound to this transfer's txHash (the productized 0x0b5f
// recovery). Body: { voucherId, userEmail }.
unmatchedTransfers.post("/:id/fulfill", requireManager, async (c) => {
  const id = c.req.param("id");
  const admin = c.get("adminAuth");
  let body: { voucherId?: unknown; userEmail?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.voucherId || typeof body.voucherId !== "string") {
    return c.json({ error: "voucherId is required" }, 400);
  }
  if (!body.userEmail || typeof body.userEmail !== "string") {
    return c.json({ error: "userEmail is required" }, 400);
  }

  try {
    const result = await manualFulfillUnmatchedTransfer(
      id,
      body.voucherId,
      body.userEmail,
      admin.email,
    );
    return c.json({
      transfer: { ...result.transfer, amount: result.transfer.amount.toString() },
      redemptionId: result.redemptionId,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Manual fulfillment failed" },
      400,
    );
  }
});

// POST /api/admin/unmatched-transfers/:id/refund — record a verified refund
unmatchedTransfers.post("/:id/refund", requireManager, async (c) => {
  const id = c.req.param("id");
  const admin = c.get("adminAuth");
  let body: { refundTxHash?: unknown; note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (
    !body.refundTxHash ||
    typeof body.refundTxHash !== "string" ||
    !TX_HASH_RE.test(body.refundTxHash)
  ) {
    return c.json({ error: "Valid refundTxHash is required" }, 400);
  }

  try {
    const row = await refundUnmatchedTransfer(
      id,
      body.refundTxHash,
      admin.email,
      typeof body.note === "string" ? body.note : undefined,
    );
    return c.json({ transfer: { ...row, amount: row.amount.toString() } });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Refund failed" }, 400);
  }
});

// POST /api/admin/unmatched-transfers/:id/ignore — close with audit note
unmatchedTransfers.post("/:id/ignore", requireManager, async (c) => {
  const id = c.req.param("id");
  const admin = c.get("adminAuth");
  let body: { note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.note || typeof body.note !== "string" || !body.note.trim()) {
    return c.json({ error: "A note explaining why is required" }, 400);
  }

  try {
    const row = await ignoreUnmatchedTransfer(id, admin.email, body.note);
    return c.json({ transfer: { ...row, amount: row.amount.toString() } });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Ignore failed" }, 400);
  }
});

export default unmatchedTransfers;
