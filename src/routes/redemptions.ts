import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import {
  confirmRedemption,
  ensureQrAssigned,
  reconcileRedemptionById,
  safeCancelPendingRedemption,
  safeExpireStalePending,
  STALE_PENDING_EXPIRY_MS,
} from "../services/redemption.js";
import { generateSignedUrl } from "../services/r2.js";
import { recordRejectedTreasuryTx } from "../services/transferMatch.js";
import { waitUntil } from "@vercel/functions";

const redemptions = new Hono<AuthEnv>();

const QR_BUCKET = process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes";
const QR_SIGNED_URL_TTL_SEC = 3600;

// Valid RedemptionStatus enum values. An unrecognised ?status= must be ignored,
// not passed raw into Prisma (which throws PrismaClientValidationError → 500).
const REDEMPTION_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "FAILED",
  "EXPIRED",
  "REFUNDED",
] as const;

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

  // Expire pending entries that never received a txHash — but ONLY through the
  // chain-checked safe path: if the transfer actually happened (app died before
  // submit-tx), the row is recovered + confirmed instead of expired. The
  // attempt is kept as history (status EXPIRED), never deleted.
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
      ...staleNoTx.map((r) => safeExpireStalePending(r.id)),
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
        // No txHash reported — chain-checked expiry: recovers + confirms if
        // the transfer actually happened, expires (keeps history) otherwise.
        await safeExpireStalePending(existing.id);
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

// POST /api/redemptions/:id/cancel — User: cancel a pre-broadcast pending.
// NEVER deletes: the client's "nothing was broadcast" claim is evidence, not
// proof (Privy can throw AFTER submitting — the 2026-07-17 0x5c18 loss). The
// row is chain-checked and recovered if paid, otherwise marked EXPIRED and
// KEPT, so a payment that lands after cancel is still recorded by the
// webhook/sweep and the money is never lost.
redemptions.post("/:id/cancel", requireUser, async (c) => {
  const id = c.req.param("id");
  const user = c.get("userAuth");

  const owned = await prisma.redemption.findFirst({
    where: { id, userEmail: user.userEmail },
    select: { id: true },
  });
  if (!owned) {
    return c.json({ error: "Redemption not found" }, 404);
  }

  const outcome = await safeCancelPendingRedemption(id);
  // "expired" (kept as history) and "recovered" (was actually paid) are both a
  // successful, non-lossy resolution; "kept" means retry-later (RPC down).
  return c.json({ ok: outcome === "expired" || outcome === "recovered", outcome });
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

  // Idempotent re-submit of the hash this row already carries (retry bridge,
  // double flush) — fine regardless of status.
  if (redemption.txHash === txHash) {
    return c.json({ redemption });
  }

  if (redemption.status !== "PENDING") {
    return c.json({ error: "Redemption is not pending" }, 400);
  }

  // NEVER overwrite an already-attached hash: the webhook auto-matcher may
  // have adopted a different on-chain transfer onto this row between broadcast
  // and this call. Overwriting would orphan that adopted tx — the recorded
  // money would silently vanish (suspected path of the 2026-07-17 0x5c18
  // loss). The tx submitted here is still recorded server-side: its own
  // webhook delivery fails direct confirm and lands in the fallback/queue.
  if (redemption.txHash) {
    // The row already carries a different hash (webhook auto-adopted one, or
    // this is a second payment). Do NOT overwrite — but the rejected hash is a
    // real on-chain transfer, so record it directly through the matcher instead
    // of trusting only the webhook (fix: a rejected hash used to be dropped).
    // waitUntil keeps the serverless instance alive until this finishes — a
    // bare fire-and-forget promise is frozen after the 409 returns. We use
    // @vercel/functions' `waitUntil` rather than Hono's `c.executionCtx`: the
    // entry (api/index.ts) exports the raw Hono app (no hono/vercel adapter),
    // so `c.executionCtx` THROWS on Vercel's Node runtime and would fall back
    // to a bare (frozen) promise. `@vercel/functions` is the documented
    // Vercel-Node way to keep a promise alive after the response — outside
    // Vercel it degrades to a no-op / runs the promise inline.
    waitUntil(
      recordRejectedTreasuryTx(txHash).catch((err) =>
        console.error("[submit-tx] recordRejectedTreasuryTx failed:", err),
      ),
    );
    return c.json(
      { error: "Redemption is already linked to a different transaction" },
      409,
    );
  }

  const existingTx = await prisma.redemption.findUnique({ where: { txHash } });
  if (existingTx) {
    return c.json({ error: "txHash already used" }, 400);
  }

  // Claim-first write: guard the update on the SAME predicate we read above.
  // The findFirst..status check is a TOCTOU — between it and here a parallel
  // GET can lazy-expire this row (safeExpireStalePending), or a racing submit
  // can stamp it. A bare `update where {id}` would then write txHash onto a
  // non-PENDING row, and confirmRedemption only matches {txHash, status:PENDING}
  // — the money would be recorded on-chain but never confirm the voucher (the
  // silent-loss class this PR exists to kill). Scope the write to PENDING+null
  // and act on the row count.
  const claim = await prisma.redemption.updateMany({
    where: { id: redemption.id, status: "PENDING", txHash: null },
    data: { txHash },
  });
  if (claim.count === 0) {
    // Row was expired/claimed between the read and here. The tx is a real
    // on-chain transfer, so record it through the matcher (never drop it) and
    // let the webhook/queue resolve it — same recovery path as the 409 above.
    waitUntil(
      recordRejectedTreasuryTx(txHash).catch((err) =>
        console.error("[submit-tx] recordRejectedTreasuryTx failed:", err),
      ),
    );
    return c.json({ error: "Redemption is no longer pending" }, 409);
  }
  const updated = await prisma.redemption.findUniqueOrThrow({
    where: { id: redemption.id },
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
