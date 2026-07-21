import { describe, test, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const getTransactionReceipt = vi.fn();
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ getTransactionReceipt })),
  };
});

vi.mock("@/db.js", () => {
  const models = {
    redemption: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    redemptionSlot: { updateMany: vi.fn(), count: vi.fn() },
    qrCode: { updateMany: vi.fn() },
    voucher: { update: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { ...models };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

vi.mock("@/services/qr-generator.js", () => ({
  generateQrCode: vi.fn(),
  generateUploadedAsset: vi.fn(),
  deleteQrFiles: vi.fn(),
}));

import { prisma } from "@/db.js";
import {
  reconcileRedemptionById,
  reconcileStampedPendingRedemptions,
} from "@/services/redemption.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const TREASURY = "0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01";
const WEALTH = "0xafa702c0a2a3a0cf1bd09435db61c913ccde8546";
const PAYER = "0x404392cfcc5f2ced743066b64c28cc436c58bf34";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AMOUNT = new Prisma.Decimal("0.164100960789953904");
const TX = "0x" + "5c".repeat(32);

function pad(a: string) {
  return "0x" + a.slice(2).padStart(64, "0");
}
function transferLog(opts: { token?: string; to?: string; wei?: bigint }) {
  return {
    address: opts.token ?? WEALTH,
    topics: [TRANSFER_TOPIC, pad(PAYER), pad(opts.to ?? TREASURY)],
    data: `0x${(opts.wei ?? 164100960789953904n).toString(16)}`,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  process.env.ALCHEMY_RPC_URL = "https://rpc.test";
  process.env.ETHEREUM_CHAIN_ID = "1";
  process.env.DEV_WALLET_ADDRESS = TREASURY;
  process.env.WEALTH_CONTRACT_ADDRESS = WEALTH;
  db.redemption.findUnique.mockResolvedValue({
    id: "red1",
    status: "PENDING",
    txHash: TX,
    wealthAmount: AMOUNT,
  });
  // confirmRedemption internals (only reached on a valid payment)
  db.redemption.findFirst.mockResolvedValue({ id: "red1", voucherId: "v1" });
  db.redemption.updateMany.mockResolvedValue({ count: 1 });
  db.redemption.findUniqueOrThrow.mockResolvedValue({ id: "red1" });
  db.redemptionSlot.count.mockResolvedValue(0);
  db.voucher.update.mockResolvedValue({});
});

describe("reconcileRedemptionById — a bare success is NOT proof of payment (C1)", () => {
  test("valid $WEALTH→treasury payment of the right amount → CONFIRMED", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({})],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: true, status: "CONFIRMED" });
  });

  test("EXPLOIT: unrelated successful tx (no treasury transfer) → REFUSED, not confirmed", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [], // some random successful tx the user submitted
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
    // confirmRedemption's claim updateMany must never have run.
    expect(db.redemption.updateMany).not.toHaveBeenCalled();
  });

  test("success but transfer goes to a DIFFERENT address → REFUSED", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ to: "0x" + "99".repeat(20) })],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
  });

  test("success but wrong token → REFUSED", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ token: "0x" + "12".repeat(20) })],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
  });

  test("success but wrong amount → REFUSED", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ wei: 1n })],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
  });
});

describe("reconcileRedemptionById — verify the SENDER (round-3 #1)", () => {
  test("EXPLOIT: row has walletAddress, receipt FROM a DIFFERENT wallet → REFUSED", async () => {
    // Attacker submits SOMEONE ELSE's legit txHash (correct token/treasury/amount
    // but the transfer's `from` is the real payer, not the attacker's wallet).
    db.redemption.findUnique.mockResolvedValue({
      id: "red1",
      status: "PENDING",
      txHash: TX,
      wealthAmount: AMOUNT,
      walletAddress: "0x" + "88".repeat(20), // the attacker's own wallet
    });
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({})], // from = PAYER, not the attacker
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
    expect(db.redemption.updateMany).not.toHaveBeenCalled();
  });

  test("row walletAddress matches the transfer FROM (case-insensitive) → CONFIRMED", async () => {
    db.redemption.findUnique.mockResolvedValue({
      id: "red1",
      status: "PENDING",
      txHash: TX,
      wealthAmount: AMOUNT,
      walletAddress: PAYER.toUpperCase(), // stored differently-cased on purpose
    });
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({})], // from = PAYER
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: true, status: "CONFIRMED" });
  });

  test("legacy row (walletAddress null) with a valid transfer → CONFIRMED (FROM check skipped)", async () => {
    db.redemption.findUnique.mockResolvedValue({
      id: "red1",
      status: "PENDING",
      txHash: TX,
      wealthAmount: AMOUNT,
      walletAddress: null, // created before wallet capture
    });
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({})],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: true, status: "CONFIRMED" });
  });

  test("$WEALTH→treasury transfer is NOT logs[0] (batched tx) → still found + CONFIRMED", async () => {
    db.redemption.findUnique.mockResolvedValue({
      id: "red1",
      status: "PENDING",
      txHash: TX,
      wealthAmount: AMOUNT,
      walletAddress: PAYER,
    });
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [
        transferLog({ token: "0x" + "12".repeat(20) }), // unrelated token first
        transferLog({ to: "0x" + "99".repeat(20) }), // right token, wrong dest
        transferLog({}), // the real payment, buried
      ],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: true, status: "CONFIRMED" });
  });
});

describe("reconcileRedemptionById — fail-closed on missing env", () => {
  test("DEV_WALLET_ADDRESS unset → REFUSED, never confirms", async () => {
    delete process.env.DEV_WALLET_ADDRESS;
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({})],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
    expect(db.redemption.updateMany).not.toHaveBeenCalled();
  });

  test("WEALTH_CONTRACT_ADDRESS unset → REFUSED, never confirms", async () => {
    delete process.env.WEALTH_CONTRACT_ADDRESS;
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({})],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
    expect(db.redemption.updateMany).not.toHaveBeenCalled();
  });
});

describe("reconcileRedemptionById — reverted receipt", () => {
  test("status reverted → FAILED (releasePendingRedemption path)", async () => {
    db.redemption.findUnique.mockResolvedValue({
      id: "red1",
      status: "PENDING",
      txHash: TX,
      wealthAmount: AMOUNT,
      walletAddress: PAYER,
      voucherId: "v1",
      slotId: null,
      qrCodes: [],
    });
    getTransactionReceipt.mockResolvedValue({
      status: "reverted",
      logs: [],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: true, status: "FAILED" });
  });
});

describe("reconcileStampedPendingRedemptions — R3 cron backstop (paid-no-voucher)", () => {
  test("selects only PENDING rows with a txHash older than the min age", async () => {
    db.redemption.findMany.mockResolvedValue([]);
    await reconcileStampedPendingRedemptions();
    const where = db.redemption.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("PENDING");
    expect(where.txHash).toEqual({ not: null });
    expect(where.createdAt.lt).toBeInstanceOf(Date);
  });

  test("confirms a stamped row whose receipt actually pays the treasury", async () => {
    db.redemption.findMany.mockResolvedValue([{ id: "red1" }]);
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({})], // pays TREASURY the exact AMOUNT from PAYER
    });
    const out = await reconcileStampedPendingRedemptions();
    expect(out.confirmed).toBe(1);
    expect(out.failed).toBe(0);
    expect(out.ids).toContain("red1");
  });

  test("leaves a not-yet-mined row PENDING (retries next run)", async () => {
    db.redemption.findMany.mockResolvedValue([{ id: "red1" }]);
    getTransactionReceipt.mockResolvedValue(null); // tx not mined yet
    const out = await reconcileStampedPendingRedemptions();
    expect(out.confirmed).toBe(0);
    expect(out.pending).toBe(1);
    expect(out.ids).toEqual([]);
  });

  test("does NOT confirm a stamped row whose receipt underpays (R1 belt at reconcile)", async () => {
    db.redemption.findMany.mockResolvedValue([{ id: "red1" }]);
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ wei: 1n })], // dust, not the expected AMOUNT
    });
    const out = await reconcileStampedPendingRedemptions();
    expect(out.confirmed).toBe(0);
    expect(out.pending).toBe(1); // not-a-payment → stays PENDING
  });

  test("empty backlog → no-op", async () => {
    db.redemption.findMany.mockResolvedValue([]);
    const out = await reconcileStampedPendingRedemptions();
    expect(out).toEqual({ confirmed: 0, failed: 0, pending: 0, ids: [] });
  });
});
