import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import {
  confirmRedemption,
  ensureQrAssigned,
  reconcileRedemptionById,
  releasePendingRedemption,
  STALE_PENDING_EXPIRY_MS,
} from "../services/redemption.js";
import { generateSignedUrl } from "../services/r2.js";

const redemptions = new Hono<AuthEnv>();

const QR_BUCKET = process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes";
const QR_SIGNED_URL_TTL_SEC = 3600;

// Valid RedemptionStatus enum values. An unrecognised ?status= must be ignored,
// not passed raw into Prisma (which throws PrismaClientValidationError → 500).
const REDEMPTION_STATUSES = ["PENDING", "CONFIRMED", "FAILED", "EXPIRED"] as const;

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
  // Guard against NaN/≤0 (e.g. ?page=abc) which would flow into Prisma's
  // skip/take as NaN and throw → 500.
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1") || 1);
  const limit = Math.max(1, parseInt(c.req.query("limit") ?? "20") || 20);
  const statusRaw = c.req.query("status");
  const status = REDEMPTION_STATUSES.includes(statusRaw as never)
    ? (statusRaw as (typeof REDEMPTION_STATUSES)[number])
    : undefined;

  const where = {
    userEmail: user.userEmail,
    ...(status && { status }),
  };

  const fetchPage = () =>
    Promise.all([
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

  let [redemptionsList, total] = await fetchPage();

  // Lazily reconcile stale pending entries so the list reflects on-chain truth
  // even when the confirmation webhook misses them. Bounded to avoid RPC overuse.
  const stalePending = redemptionsList
    .filter(
      (r) =>
        r.status === "PENDING" &&
        r.txHash &&
        Date.now() - r.createdAt.getTime() > 30_000,
    )
    .slice(0, 10);

  // Release pending entries that never received a txHash (wallet tx failed before
  // broadcast, e.g. insufficient gas) so the slot + stock recover and the
  // abandoned attempt disappears instead of lingering as "menunggu" forever.
  const staleNoTx = redemptionsList
    .filter(
      (r) =>
        r.status === "PENDING" &&
        !r.txHash &&
        Date.now() - r.createdAt.getTime() > STALE_PENDING_EXPIRY_MS,
    )
    .slice(0, 10);

  if (stalePending.length > 0 || staleNoTx.length > 0) {
    await Promise.allSettled([
      ...stalePending.map((r) => reconcileRedemptionById(r.id)),
      ...staleNoTx.map((r) => releasePendingRedemption(r.id)),
    ]);
    [redemptionsList, total] = await fetchPage();
  }

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
    select: {
      id: true,
      voucherId: true,
      status: true,
      txHash: true,
      createdAt: true,
      qrCodes: { select: { id: true, imageUrl: true, slotId: true } },
    },
  });

  if (!existing) {
    return c.json({ error: "Redemption not found" }, 404);
  }

  if (existing.status === "PENDING") {
    const ageMs = Date.now() - existing.createdAt.getTime();
    try {
      if (existing.txHash && ageMs > 30_000) {
        await reconcileRedemptionById(existing.id);
      } else if (!existing.txHash && ageMs > STALE_PENDING_EXPIRY_MS) {
        // Wallet tx never broadcast (e.g. insufficient gas) — release + delete.
        await releasePendingRedemption(existing.id);
      }
    } catch (err) {
      console.error("[GET /redemptions/:id] auto-reconcile failed:", err);
    }
  } else if (existing.status === "CONFIRMED") {
    // Lazy-heal: finish QR generation if it didn't complete right after
    // confirmation (idempotent), so the user always gets their QR.
    try {
      await ensureQrAssigned(existing.id);
    } catch (err) {
      console.error("[GET /redemptions/:id] ensureQrAssigned failed:", err);
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

// POST /api/redemptions/:id/cancel — User: cancel a pre-broadcast pending
// (e.g. wallet signature failed on insufficient gas) so it leaves no history.
redemptions.post("/:id/cancel", requireUser, async (c) => {
  const id = c.req.param("id");
  const user = c.get("userAuth");

  const owned = await prisma.redemption.findFirst({
    where: { id, userEmail: user.userEmail },
    select: { id: true, status: true, txHash: true },
  });
  if (!owned) {
    return c.json({ error: "Redemption not found" }, 404);
  }
  // Only cancel a PENDING redemption that never broadcast a transaction. Once a
  // txHash exists the transfer is on-chain — leave it for confirm/reconcile.
  if (owned.status !== "PENDING" || owned.txHash) {
    return c.json({ ok: false });
  }

  const released = await releasePendingRedemption(id);
  return c.json({ ok: released });
});

// PATCH /api/redemptions/:id/submit-tx — User: submit txHash
redemptions.patch("/:id/submit-tx", requireUser, async (c) => {
  const id = c.req.param("id");
  const user = c.get("userAuth");
  // A malformed/empty body must be a 400, not an unhandled JSON.parse throw → 500.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const txHash = (body as { txHash?: unknown } | null)?.txHash;

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

  // LOCAL DEMO ONLY (gated by env, never on in prod): confirm immediately so the
  // local backend (new multi-format code) assigns the asset before the production
  // webhook (old code) can render a QR. Lets a full create→redeem demo show the
  // real barcode/code. Safe to leave off — defaults to disabled.
  if (process.env.DEMO_INSTANT_CONFIRM === "true") {
    try {
      await confirmRedemption(txHash);
    } catch (err) {
      console.error("[DEMO_INSTANT_CONFIRM] failed:", err);
    }
  }

  return c.json({ redemption: updated });
});

export default redemptions;
