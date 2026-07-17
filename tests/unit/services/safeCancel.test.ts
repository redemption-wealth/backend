import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/db.js", () => {
  const models = {
    redemption: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    appUser: { findFirst: vi.fn() },
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
import { safeCancelPendingRedemption } from "@/services/redemption.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const AMOUNT = new Prisma.Decimal("0.164100960789953904");
const WALLET = "0x1eb40c679c4922f1a90d341c3788fc362be29cf6";
const ROW = {
  id: "red1",
  status: "PENDING",
  txHash: null,
  userEmail: "rita@test.com",
  walletAddress: WALLET,
  wealthAmount: AMOUNT,
  createdAt: new Date("2026-07-17T09:52:00Z"),
};

const realFetch = globalThis.fetch;

function mockTransfersResponse(
  transfers: Array<{ hash: string; wei: bigint; ts?: string }>,
) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      result: {
        transfers: transfers.map((t) => ({
          hash: t.hash,
          rawContract: { value: `0x${t.wei.toString(16)}` },
          metadata: { blockTimestamp: t.ts ?? "2026-07-17T09:53:00Z" },
        })),
      },
    }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  process.env.ALCHEMY_RPC_URL = "https://rpc.test";
  process.env.DEV_WALLET_ADDRESS = "0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01";
  process.env.WEALTH_CONTRACT_ADDRESS =
    "0xafa702c0a2a3a0cf1bd09435db61c913ccde8546";
  // Defaults for the release/delete path.
  db.qrCode.updateMany.mockResolvedValue({ count: 0 });
  db.redemptionSlot.updateMany.mockResolvedValue({ count: 1 });
  db.redemptionSlot.count.mockResolvedValue(14);
  db.voucher.update.mockResolvedValue({});
  db.redemption.delete.mockResolvedValue({});
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("safeCancelPendingRedemption — the client's word is not proof", () => {
  test("the 0x5c18 case: chain shows the payment → RECOVER, refuse the delete", async () => {
    const paidTx = "0x" + "5c".repeat(32);
    db.redemption.findUnique
      .mockResolvedValueOnce({ ...ROW }) // load row
      .mockResolvedValueOnce(null); // hash not yet taken
    mockTransfersResponse([{ hash: paidTx, wei: 164100960789953904n }]);
    db.redemption.updateMany.mockResolvedValue({ count: 1 }); // adopt hash
    // confirmRedemption internals (best-effort; errors are deferred):
    db.redemption.findFirst.mockResolvedValue({ id: "red1", voucherId: "v1" });
    db.redemption.findUniqueOrThrow.mockResolvedValue({ id: "red1" });

    const out = await safeCancelPendingRedemption("red1");

    expect(out).toBe("recovered");
    expect(db.redemption.updateMany).toHaveBeenCalledWith({
      where: { id: "red1", status: "PENDING", txHash: null },
      data: { txHash: paidTx, walletAddress: WALLET },
    });
    expect(db.redemption.delete).not.toHaveBeenCalled();
  });

  test("RPC down → KEEP the row (never delete on doubt)", async () => {
    db.redemption.findUnique.mockResolvedValueOnce({ ...ROW });
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const out = await safeCancelPendingRedemption("red1");

    expect(out).toBe("kept");
    expect(db.redemption.delete).not.toHaveBeenCalled();
    expect(db.redemption.update).not.toHaveBeenCalled();
    expect(db.redemptionSlot.updateMany).not.toHaveBeenCalled();
  });

  test("chain clearly empty → DELETE the row (original no-clutter cancel)", async () => {
    db.redemption.findUnique
      .mockResolvedValueOnce({ ...ROW }) // load row
      .mockResolvedValueOnce({ status: "PENDING", qrCodes: [] }) // release pre-check
      .mockResolvedValueOnce({
        // inside tx: re-check
        status: "PENDING",
        voucherId: "v1",
        slotId: "slot1",
      });
    mockTransfersResponse([]);

    const out = await safeCancelPendingRedemption("red1");

    expect(out).toBe("canceled");
    expect(db.redemption.delete).toHaveBeenCalledWith({ where: { id: "red1" } });
    // Slot freed for reuse.
    expect(db.redemptionSlot.updateMany).toHaveBeenCalledWith({
      where: { id: "slot1", status: "REDEEMED" },
      data: { status: "AVAILABLE" },
    });
  });

  test("matching transfer already claimed by another redemption → delete is allowed", async () => {
    const takenTx = "0x" + "dd".repeat(32);
    db.redemption.findUnique
      .mockResolvedValueOnce({ ...ROW }) // load row
      .mockResolvedValueOnce({ id: "other" }) // hash taken
      .mockResolvedValueOnce({ status: "PENDING", qrCodes: [] })
      .mockResolvedValueOnce({ status: "PENDING", voucherId: "v1", slotId: "slot1" });
    mockTransfersResponse([{ hash: takenTx, wei: 164100960789953904n }]);

    const out = await safeCancelPendingRedemption("red1");
    expect(out).toBe("canceled");
    expect(db.redemption.updateMany).not.toHaveBeenCalled();
  });

  test("wallet unknown everywhere → delete allowed (webhook net + inflow sweep are the backstop)", async () => {
    db.redemption.findUnique
      .mockResolvedValueOnce({ ...ROW, walletAddress: null })
      .mockResolvedValueOnce({ status: "PENDING", qrCodes: [] })
      .mockResolvedValueOnce({ status: "PENDING", voucherId: "v1", slotId: "slot1" });
    db.appUser.findFirst.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await safeCancelPendingRedemption("red1");
    expect(out).toBe("canceled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("row already has a txHash → noop (on-chain money is never cancel-able)", async () => {
    db.redemption.findUnique.mockResolvedValueOnce({
      ...ROW,
      txHash: "0x" + "ee".repeat(32),
    });
    expect(await safeCancelPendingRedemption("red1")).toBe("noop");
    expect(db.redemption.delete).not.toHaveBeenCalled();
  });

  test("row not PENDING → noop", async () => {
    db.redemption.findUnique.mockResolvedValueOnce({
      ...ROW,
      status: "CONFIRMED",
    });
    expect(await safeCancelPendingRedemption("red1")).toBe("noop");
  });
});
