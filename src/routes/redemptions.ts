import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import { reconcileRedemptionById } from "../services/redemption.js";
import { generateSignedUrl } from "../services/r2.js";

const redemptions = new Hono<AuthEnv>();

const QR_BUCKET = process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes";
const QR_SIGNED_URL_TTL_SEC = 3600;

type QrCodeWithUrl = { imageUrl: string | null; [key: string]: unknown };

async function withSignedQrUrls<T extends { qrCodes?: QrCodeWithUrl[] | null }>(
  redemption: T,
): Promise<T> {
  if (!redemption.qrCodes || redemption.qrCodes.length === 0) return redemption;
  const signed = await Promise.all(
    redemption.qrCodes.map(async (qr) => {
      if (!qr.imageUrl || /^https?:\/\//i.test(qr.imageUrl)) return qr;
      try {
        const url = await generateSignedUrl({
          bucket: QR_BUCKET,
          key: qr.imageUrl,
          expiresIn: QR_SIGNED_URL_TTL_SEC,
        });
        return { ...qr, imageUrl: url };
      } catch (err) {
        console.error("[redemptions] sign QR url failed:", err);
        return qr;
      }
    }),
  );
  return { ...redemption, qrCodes: signed };
}

// GET /api/redemptions — User: list own redemptions
redemptions.get("/", requireUser, async (c) => {
  const user = c.get("userAuth");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");
  const status = c.req.query("status");

  const where = {
    userEmail: user.userEmail,
    ...(status && { status: status as never }),
  };

  const [redemptionsList, total] = await Promise.all([
    prisma.redemption.findMany({
      where,
      include: {
        voucher: { include: { merchant: true } },
        qrCodes: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.redemption.count({ where }),
  ]);

  return c.json({
    redemptions: redemptionsList,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// GET /api/redemptions/:id — User: get own redemption detail
redemptions.get("/:id", requireUser, async (c) => {
  const id = c.req.param("id");
  const user = c.get("userAuth");

  const existing = await prisma.redemption.findFirst({
    where: { id, userEmail: user.userEmail },
    select: { id: true, status: true, txHash: true, createdAt: true },
  });

  if (!existing) {
    return c.json({ error: "Redemption not found" }, 404);
  }

  if (existing.status === "PENDING" && existing.txHash) {
    const ageMs = Date.now() - existing.createdAt.getTime();
    if (ageMs > 30_000) {
      try {
        await reconcileRedemptionById(existing.id);
      } catch (err) {
        console.error("[GET /redemptions/:id] auto-reconcile failed:", err);
      }
    }
  }

  const redemption = await prisma.redemption.findFirst({
    where: { id, userEmail: user.userEmail },
    include: {
      voucher: { include: { merchant: true } },
      qrCodes: true,
    },
  });

  return c.json({ redemption: redemption ? await withSignedQrUrls(redemption) : null });
});

// POST /api/redemptions/:id/reconcile — User: force on-chain re-check
redemptions.post("/:id/reconcile", requireUser, async (c) => {
  const id = c.req.param("id");
  const user = c.get("userAuth");

  const owned = await prisma.redemption.findFirst({
    where: { id, userEmail: user.userEmail },
    select: { id: true },
  });
  if (!owned) {
    return c.json({ error: "Redemption not found" }, 404);
  }

  let reconciled = false;
  try {
    const outcome = await reconcileRedemptionById(id);
    reconciled = outcome.reconciled;
  } catch (err) {
    console.error("[POST /redemptions/:id/reconcile] failed:", err);
  }

  const redemption = await prisma.redemption.findFirst({
    where: { id, userEmail: user.userEmail },
    include: {
      voucher: { include: { merchant: true } },
      qrCodes: true,
    },
  });

  return c.json({
    redemption: redemption ? await withSignedQrUrls(redemption) : null,
    reconciled,
  });
});

// PATCH /api/redemptions/:id/submit-tx — User: submit txHash
redemptions.patch("/:id/submit-tx", requireUser, async (c) => {
  const id = c.req.param("id");
  const user = c.get("userAuth");
  const { txHash } = await c.req.json();

  if (!txHash || typeof txHash !== "string") {
    return c.json({ error: "txHash is required" }, 400);
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return c.json({ error: "Invalid txHash format" }, 400);
  }

  const redemption = await prisma.redemption.findFirst({
    where: { id, userEmail: user.userEmail },
  });

  if (!redemption) {
    return c.json({ error: "Redemption not found" }, 404);
  }

  if (redemption.status !== "PENDING") {
    return c.json({ error: "Redemption is not pending" }, 400);
  }

  const existingTx = await prisma.redemption.findUnique({ where: { txHash } });
  if (existingTx) {
    return c.json({ error: "txHash already used" }, 400);
  }

  const updated = await prisma.redemption.update({
    where: { id: redemption.id },
    data: { txHash },
  });

  return c.json({ redemption: updated });
});

export default redemptions;
