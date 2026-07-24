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
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    appUser: { findFirst: vi.fn() },
    unmatchedTransfer: { findUnique: vi.fn(), update: vi.fn() },
    qrCode: { updateMany: vi.fn() },
    redemptionSlot: { updateMany: vi.fn(), count: vi.fn() },
    voucher: { update: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { ...models };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

import { prisma } from "@/db.js";
import {
  verifyRefundOnChain,
  refundRedemption,
  ignoreUnmatchedTransfer,
  manualFulfillUnmatchedTransfer,
} from "@/services/refund.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const TREASURY = "0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01";
const WEALTH = "0xafa702c0a2a3a0cf1bd09435db61c913ccde8546";
const PAYER = "0x404392cfcc5f2ced743066b64c28cc436c58bf34";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AMOUNT = new Prisma.Decimal("0.1509659771120788");
const REFUND_TX = "0x" + "aa".repeat(32);

function pad(addr: string) {
  return "0x" + addr.slice(2).padStart(64, "0");
}

function transferLog(opts: {
  token?: string;
  from?: string;
  to?: string;
  wei?: bigint;
}) {
  return {
    address: opts.token ?? WEALTH,
    topics: [TRANSFER_TOPIC, pad(opts.from ?? TREASURY), pad(opts.to ?? PAYER)],
    data: `0x${(opts.wei ?? 150965977112078800n).toString(16)}`,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  process.env.ALCHEMY_RPC_URL = "https://rpc.test";
  process.env.ETHEREUM_CHAIN_ID = "1";
  process.env.DEV_WALLET_ADDRESS = TREASURY;
  process.env.WEALTH_CONTRACT_ADDRESS = WEALTH;
});

describe("verifyRefundOnChain — nothing on faith", () => {
  test("accepts a correct treasury→payer $WEALTH transfer of the full amount", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({})],
    });

    const out = await verifyRefundOnChain(REFUND_TX, PAYER, AMOUNT);
    expect(out.to).toBe(PAYER);
    expect(out.amount.toString()).toBe(AMOUNT.toString());
  });

  test("rejects a reverted tx", async () => {
    getTransactionReceipt.mockResolvedValue({ status: "reverted", logs: [] });
    await expect(verifyRefundOnChain(REFUND_TX, PAYER, AMOUNT)).rejects.toThrow(
      /reverted/,
    );
  });

  test("rejects when the sender is not the treasury", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ from: PAYER })], // wrong direction
    });
    await expect(verifyRefundOnChain(REFUND_TX, PAYER, AMOUNT)).rejects.toThrow(
      /No \$WEALTH transfer/,
    );
  });

  test("rejects the wrong token", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ token: "0x" + "12".repeat(20) })],
    });
    await expect(verifyRefundOnChain(REFUND_TX, PAYER, AMOUNT)).rejects.toThrow(
      /No \$WEALTH transfer/,
    );
  });

  test("rejects a partial refund (full-total policy)", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ wei: 100000000000000000n })], // 0.1, not full
    });
    await expect(verifyRefundOnChain(REFUND_TX, PAYER, AMOUNT)).rejects.toThrow(
      /amount mismatch/i,
    );
  });

  test("rejects a transfer to the wrong recipient", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ to: "0x" + "99".repeat(20) })],
    });
    await expect(verifyRefundOnChain(REFUND_TX, PAYER, AMOUNT)).rejects.toThrow(
      /No \$WEALTH transfer/,
    );
  });
});

describe("refundRedemption", () => {
  const REDEMPTION = {
    id: "red1",
    status: "PENDING",
    txHash: "0x" + "0b".repeat(32),
    walletAddress: PAYER,
    userEmail: "raka@test.com",
    wealthAmount: AMOUNT,
    voucherId: "v1",
    slotId: "slot1",
  };

  beforeEach(() => {
    db.qrCode.updateMany.mockResolvedValue({ count: 0 });
    db.redemptionSlot.updateMany.mockResolvedValue({ count: 1 });
    db.redemptionSlot.count.mockResolvedValue(15);
    db.voucher.update.mockResolvedValue({});
    db.redemption.update.mockResolvedValue({});
  });

  test("verified refund → REFUNDED, slot detached & freed, stock recounted", async () => {
    db.redemption.findUnique.mockResolvedValue(REDEMPTION);
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({})],
    });

    const out = await refundRedemption("red1", REFUND_TX, "manager@wealth");
    expect(out.refundTxHash).toBe(REFUND_TX.toLowerCase());
    expect(db.redemption.update).toHaveBeenCalledWith({
      where: { id: "red1" },
      data: expect.objectContaining({
        status: "REFUNDED",
        refundTxHash: REFUND_TX.toLowerCase(),
        slotId: null,
      }),
    });
    expect(db.voucher.update).toHaveBeenCalled();
  });

  test("never paid on-chain → refuse (nothing to refund)", async () => {
    db.redemption.findUnique.mockResolvedValue({ ...REDEMPTION, txHash: null });
    await expect(
      refundRedemption("red1", REFUND_TX, "manager@wealth"),
    ).rejects.toThrow(/never paid/);
  });

  test("already refunded → refuse (no double refunds)", async () => {
    db.redemption.findUnique.mockResolvedValue({
      ...REDEMPTION,
      status: "REFUNDED",
    });
    await expect(
      refundRedemption("red1", REFUND_TX, "manager@wealth"),
    ).rejects.toThrow(/Already refunded/);
  });

  test("failed on-chain verification blocks the record entirely", async () => {
    db.redemption.findUnique.mockResolvedValue(REDEMPTION);
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ wei: 1n })], // wrong amount
    });
    await expect(
      refundRedemption("red1", REFUND_TX, "manager@wealth"),
    ).rejects.toThrow(/amount mismatch/i);
    expect(db.redemption.update).not.toHaveBeenCalled();
  });
});

describe("manualFulfillUnmatchedTransfer — the productized 0x0b5f recovery", () => {
  const TRANSFER_ROW = {
    id: "ut1",
    status: "OPEN",
    txHash: "0x" + "0b".repeat(32),
    fromAddress: PAYER,
    amount: AMOUNT,
    userEmail: "raka.demo@gmail.com",
  };
  const VOUCHER = {
    id: "v1",
    title: "PGR VIP",
    merchantId: "m1",
    basePrice: new Prisma.Decimal(300000),
    qrPerSlot: 2,
    isActive: true,
    deletedAt: null,
    appFeeSnapshot: new Prisma.Decimal("0.7"),
    gasFeeSnapshot: new Prisma.Decimal(500),
  };

  beforeEach(() => {
    db.unmatchedTransfer.findUnique.mockResolvedValue(TRANSFER_ROW);
    db.voucher.findUnique = vi.fn().mockResolvedValue(VOUCHER);
    db.redemptionSlot.findFirst = vi.fn().mockResolvedValue({
      id: "slot1",
      qrCodes: [{ id: "q1" }, { id: "q2" }],
    });
    db.redemptionSlot.updateMany.mockResolvedValue({ count: 1 });
    db.redemption.create = vi.fn().mockResolvedValue({ id: "newred" });
    db.unmatchedTransfer.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...TRANSFER_ROW, ...data }),
    );
    // confirmRedemption internals (best-effort; failure is tolerated)
    db.redemption.findFirst = vi.fn().mockResolvedValue(null);
  });

  test("creates a CONFIRMED-bound redemption with the transfer's hash + wallet, marks MATCHED", async () => {
    const out = await manualFulfillUnmatchedTransfer(
      "ut1",
      "v1",
      "Raka.Demo@Gmail.com ",
      "manager@wealth",
    );

    expect(out.redemptionId).toBe("newred");
    expect(db.redemption.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userEmail: "raka.demo@gmail.com", // trimmed + lowercased
        voucherId: "v1",
        slotId: "slot1",
        wealthAmount: AMOUNT, // priced by what was ACTUALLY paid
        txHash: TRANSFER_ROW.txHash,
        walletAddress: PAYER,
        idempotencyKey: `manual-fulfill-${TRANSFER_ROW.txHash}`,
      }),
    });
    expect(db.unmatchedTransfer.update).toHaveBeenCalledWith({
      where: { id: "ut1" },
      data: expect.objectContaining({
        status: "MATCHED",
        matchedRedemptionId: "newred",
        resolvedBy: "manager@wealth",
      }),
    });
  });

  test("out of stock → clear error, nothing recorded", async () => {
    db.redemptionSlot.findFirst.mockResolvedValue(null);
    await expect(
      manualFulfillUnmatchedTransfer("ut1", "v1", "raka.demo@gmail.com", "mgr"),
    ).rejects.toThrow(/out of stock/i);
    expect(db.unmatchedTransfer.update).not.toHaveBeenCalled();
  });

  test("already resolved → refuse", async () => {
    db.unmatchedTransfer.findUnique.mockResolvedValue({
      ...TRANSFER_ROW,
      status: "REFUNDED",
    });
    await expect(
      manualFulfillUnmatchedTransfer("ut1", "v1", "a@b.co", "mgr"),
    ).rejects.toThrow(/already resolved/i);
  });

  test("invalid email → refuse before touching anything", async () => {
    await expect(
      manualFulfillUnmatchedTransfer("ut1", "v1", "bukan-email", "mgr"),
    ).rejects.toThrow(/userEmail/i);
    expect(db.redemption.create).not.toHaveBeenCalled();
  });

  test("POLICY: unknown wallet (no linked account) → manual fulfillment refused", async () => {
    db.unmatchedTransfer.findUnique.mockResolvedValue({
      ...TRANSFER_ROW,
      userEmail: null,
    });
    await expect(
      manualFulfillUnmatchedTransfer("ut1", "v1", "siapa@saja.com", "mgr"),
    ).rejects.toThrow(/not linked/i);
    expect(db.redemption.create).not.toHaveBeenCalled();
  });

  test("POLICY: email mismatch with the linked account → refused", async () => {
    await expect(
      manualFulfillUnmatchedTransfer("ut1", "v1", "orang.lain@gmail.com", "mgr"),
    ).rejects.toThrow(/does not match/i);
    expect(db.redemption.create).not.toHaveBeenCalled();
  });
});

describe("ignoreUnmatchedTransfer", () => {
  test("requires a non-empty audit note", async () => {
    db.unmatchedTransfer.findUnique.mockResolvedValue({
      id: "ut1",
      status: "OPEN",
    });
    await expect(
      ignoreUnmatchedTransfer("ut1", "manager@wealth", "   "),
    ).rejects.toThrow(/note/i);
  });

  test("cannot resolve twice", async () => {
    db.unmatchedTransfer.findUnique.mockResolvedValue({
      id: "ut1",
      status: "MATCHED",
    });
    await expect(
      ignoreUnmatchedTransfer("ut1", "manager@wealth", "test note"),
    ).rejects.toThrow(/already resolved/i);
  });
});
