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
import { safeExpireStalePending } from "@/services/redemption.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const AMOUNT = new Prisma.Decimal("0.1509659771120788");
const WALLET = "0x404392cfcc5f2ced743066b64c28cc436c58bf34";
const ROW = {
  id: "red1",
  status: "PENDING",
  txHash: null,
  userEmail: "raka@test.com",
  walletAddress: WALLET,
  wealthAmount: AMOUNT,
  createdAt: new Date("2026-07-16T02:40:00Z"),
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
          metadata: { blockTimestamp: t.ts ?? "2026-07-16T02:41:00Z" },
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
  // Defaults for the release path.
  db.qrCode.updateMany.mockResolvedValue({ count: 0 });
  db.redemptionSlot.updateMany.mockResolvedValue({ count: 1 });
  db.redemptionSlot.count.mockResolvedValue(14);
  db.voucher.update.mockResolvedValue({});
  db.redemption.update.mockResolvedValue({});
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("safeExpireStalePending — never destroy on doubt", () => {
  test("chain says user paid (the 0x0b5f case) → RECOVER, never expire", async () => {
    const paidTx = "0x" + "0b".repeat(32);
    db.redemption.findUnique
      .mockResolvedValueOnce({ ...ROW, slotId: "slot1", voucherId: "v1" }) // load row
      .mockResolvedValueOnce(null); // hash not yet taken
    mockTransfersResponse([{ hash: paidTx, wei: 150965977112078800n }]);
    db.redemption.updateMany.mockResolvedValue({ count: 1 }); // adopt hash
    // confirmRedemption internals:
    db.redemption.findFirst.mockResolvedValue({ id: "red1", voucherId: "v1" });
    db.redemption.findUniqueOrThrow.mockResolvedValue({ id: "red1" });

    const out = await safeExpireStalePending("red1");

    expect(out).toBe("recovered");
    expect(db.redemption.updateMany).toHaveBeenCalledWith({
      where: { id: "red1", status: "PENDING", txHash: null },
      data: { txHash: paidTx, walletAddress: WALLET },
    });
    // The release path must NOT have run.
    expect(db.redemption.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "EXPIRED" }) }),
    );
    expect(db.redemption.delete).not.toHaveBeenCalled();
  });

  test("RPC down → SKIP, row untouched (fail-safe)", async () => {
    db.redemption.findUnique.mockResolvedValueOnce({ ...ROW });
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const out = await safeExpireStalePending("red1");

    expect(out).toBe("skipped");
    expect(db.redemption.update).not.toHaveBeenCalled();
    expect(db.redemption.delete).not.toHaveBeenCalled();
    expect(db.redemptionSlot.updateMany).not.toHaveBeenCalled();
  });

  test("chain clearly empty → EXPIRE but KEEP the row (slot detached, history preserved)", async () => {
    db.redemption.findUnique
      .mockResolvedValueOnce({ ...ROW }) // load row
      .mockResolvedValueOnce({
        // inside releasePendingRedemption: pre-check
        status: "PENDING",
        qrCodes: [],
      })
      .mockResolvedValueOnce({
        // inside tx: re-check
        status: "PENDING",
        voucherId: "v1",
        slotId: "slot1",
      });
    mockTransfersResponse([]); // no transfers at all

    const out = await safeExpireStalePending("red1");

    expect(out).toBe("expired");
    // KEEP semantics: update to EXPIRED + slotId null — never delete.
    expect(db.redemption.update).toHaveBeenCalledWith({
      where: { id: "red1" },
      data: expect.objectContaining({ status: "EXPIRED", slotId: null }),
    });
    expect(db.redemption.delete).not.toHaveBeenCalled();
    // Slot freed for reuse.
    expect(db.redemptionSlot.updateMany).toHaveBeenCalledWith({
      where: { id: "slot1", status: "REDEEMED" },
      data: { status: "AVAILABLE" },
    });
  });

  test("transfer exists but amount differs → not ours, expire (money still caught by webhook net)", async () => {
    db.redemption.findUnique
      .mockResolvedValueOnce({ ...ROW })
      .mockResolvedValueOnce({ status: "PENDING", qrCodes: [] })
      .mockResolvedValueOnce({ status: "PENDING", voucherId: "v1", slotId: "slot1" });
    mockTransfersResponse([{ hash: "0x" + "cc".repeat(32), wei: 999n }]);

    const out = await safeExpireStalePending("red1");
    expect(out).toBe("expired");
  });

  test("transfer hash already claimed by another redemption → expire this one", async () => {
    const takenTx = "0x" + "dd".repeat(32);
    db.redemption.findUnique
      .mockResolvedValueOnce({ ...ROW }) // load row
      .mockResolvedValueOnce({ id: "other" }) // hash taken
      .mockResolvedValueOnce({ status: "PENDING", qrCodes: [] })
      .mockResolvedValueOnce({ status: "PENDING", voucherId: "v1", slotId: "slot1" });
    mockTransfersResponse([{ hash: takenTx, wei: 150965977112078800n }]);

    const out = await safeExpireStalePending("red1");
    expect(out).toBe("expired");
    expect(db.redemption.updateMany).not.toHaveBeenCalled();
  });

  test("wallet unknown everywhere → expire is allowed (webhook net is the backstop)", async () => {
    db.redemption.findUnique
      .mockResolvedValueOnce({ ...ROW, walletAddress: null })
      .mockResolvedValueOnce({ status: "PENDING", qrCodes: [] })
      .mockResolvedValueOnce({ status: "PENDING", voucherId: "v1", slotId: "slot1" });
    db.appUser.findFirst.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await safeExpireStalePending("red1");
    expect(out).toBe("expired");
    expect(fetchSpy).not.toHaveBeenCalled(); // nothing to ask the chain about
  });

  test("row already confirmed/has hash → noop", async () => {
    db.redemption.findUnique.mockResolvedValueOnce({
      ...ROW,
      status: "CONFIRMED",
    });
    expect(await safeExpireStalePending("red1")).toBe("noop");

    db.redemption.findUnique.mockResolvedValueOnce({
      ...ROW,
      txHash: "0x" + "ee".repeat(32),
    });
    expect(await safeExpireStalePending("red1")).toBe("noop");
  });
});
