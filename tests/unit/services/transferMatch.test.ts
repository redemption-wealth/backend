import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/db.js", () => {
  const models = {
    redemption: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    appUser: { findFirst: vi.fn() },
    unmatchedTransfer: { findUnique: vi.fn(), create: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { ...models };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

vi.mock("@/services/redemption.js", () => ({
  confirmRedemption: vi.fn(),
}));

import { prisma } from "@/db.js";
import { confirmRedemption } from "@/services/redemption.js";
import {
  handleUnmatchedTreasuryTransfer,
  parseActivityAmount,
  sweepTreasuryInflows,
} from "@/services/transferMatch.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const AMOUNT = new Prisma.Decimal("0.1509659771120788");
const TRANSFER = {
  txHash: "0x" + "ab".repeat(32),
  fromAddress: "0x404392CFCC5F2CED743066B64C28CC436C58BF34", // checksummed on purpose
  toAddress: "0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01",
  tokenAddress: "0xafa702c0a2a3a0cf1bd09435db61c913ccde8546",
  amount: AMOUNT,
};

function pending(id: string, amount: Prisma.Decimal = AMOUNT) {
  return { id, wealthAmount: amount };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.redemption.findUnique.mockResolvedValue(null);
  db.redemption.findFirst.mockResolvedValue(null);
  db.unmatchedTransfer.findUnique.mockResolvedValue(null);
  db.unmatchedTransfer.create.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "ut1", ...data }),
  );
});

describe("handleUnmatchedTreasuryTransfer — hybrid matching", () => {
  test("the 0x0b5f case: exact single candidate → auto-confirm", async () => {
    db.appUser.findFirst.mockResolvedValue({ email: "raka@test.com" });
    db.redemption.findMany.mockResolvedValue([pending("red1")]);
    db.redemption.updateMany.mockResolvedValue({ count: 1 });

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);

    expect(out).toEqual({ outcome: "auto-confirmed", redemptionId: "red1" });
    // Hash adopted atomically, wallet normalized to lowercase.
    expect(db.redemption.updateMany).toHaveBeenCalledWith({
      where: { id: "red1", status: "PENDING", txHash: null },
      data: {
        txHash: TRANSFER.txHash.toLowerCase(),
        walletAddress: TRANSFER.fromAddress.toLowerCase(),
      },
    });
    expect(confirmRedemption).toHaveBeenCalledWith(TRANSFER.txHash.toLowerCase());
    expect(db.unmatchedTransfer.create).not.toHaveBeenCalled();
  });

  test("two PENDING with the same amount → queued for admin, NO auto-confirm", async () => {
    db.appUser.findFirst.mockResolvedValue({ email: "raka@test.com" });
    db.redemption.findMany.mockResolvedValue([pending("red1"), pending("red2")]);

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);

    expect(out).toMatchObject({ outcome: "queued", candidates: 2 });
    expect(confirmRedemption).not.toHaveBeenCalled();
    expect(db.redemption.updateMany).not.toHaveBeenCalled();
    expect(db.unmatchedTransfer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        txHash: TRANSFER.txHash.toLowerCase(),
        userEmail: "raka@test.com",
        status: "OPEN",
      }),
    });
  });

  test("amount differs from every candidate → queued (no guessing)", async () => {
    db.appUser.findFirst.mockResolvedValue({ email: "raka@test.com" });
    db.redemption.findMany.mockResolvedValue([
      pending("red1", new Prisma.Decimal("0.2")),
    ]);

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);
    expect(out).toMatchObject({ outcome: "queued", candidates: 0 });
    expect(confirmRedemption).not.toHaveBeenCalled();
  });

  test("unknown wallet → queued with userEmail null (money never dropped)", async () => {
    db.appUser.findFirst.mockResolvedValue(null);

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);
    expect(out).toMatchObject({ outcome: "queued", candidates: 0 });
    expect(db.unmatchedTransfer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userEmail: null, status: "OPEN" }),
    });
  });

  test("duplicate webhook delivery (hash already on a redemption) → no-op", async () => {
    db.redemption.findUnique.mockResolvedValue({ id: "red1" });

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);
    expect(out).toEqual({ outcome: "already-known" });
    expect(db.unmatchedTransfer.create).not.toHaveBeenCalled();
    expect(confirmRedemption).not.toHaveBeenCalled();
  });

  test("duplicate delivery (already queued) → no-op", async () => {
    db.unmatchedTransfer.findUnique.mockResolvedValue({ id: "ut1" });

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);
    expect(out).toEqual({ outcome: "already-known" });
    expect(db.unmatchedTransfer.create).not.toHaveBeenCalled();
  });

  test("race: another worker claims the candidate first → treated as known", async () => {
    db.appUser.findFirst.mockResolvedValue({ email: "raka@test.com" });
    db.redemption.findMany.mockResolvedValue([pending("red1")]);
    db.redemption.updateMany.mockResolvedValue({ count: 0 }); // lost the race
    // After losing, the hash is now attached by the winner:
    db.redemption.findUnique
      .mockResolvedValueOnce(null) // initial idempotency check
      .mockResolvedValueOnce({ id: "red1" }); // post-race re-check

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);
    expect(out).toEqual({ outcome: "already-known" });
    expect(confirmRedemption).not.toHaveBeenCalled();
  });

  test("concurrent queue insert (P2002) → treated as known, not an error", async () => {
    db.appUser.findFirst.mockResolvedValue(null);
    db.unmatchedTransfer.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "7",
      }),
    );

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);
    expect(out).toEqual({ outcome: "already-known" });
  });

  test("confirm failure after adoption does NOT lose the match (hash stays attached)", async () => {
    db.appUser.findFirst.mockResolvedValue({ email: "raka@test.com" });
    db.redemption.findMany.mockResolvedValue([pending("red1")]);
    db.redemption.updateMany.mockResolvedValue({ count: 1 });
    (confirmRedemption as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("QR service down"),
    );

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);
    // Still reported as auto-confirmed: the hash is attached, so the normal
    // reconcile path finishes the confirmation later.
    expect(out).toEqual({ outcome: "auto-confirmed", redemptionId: "red1" });
  });
});

describe("wallet→user fallback via redemption history", () => {
  test("app_users wallet NULL but a prior redemption knows the wallet → matched by that email", async () => {
    // The 2026-07-17 case: sync wiped app_users.walletAddress, but the user's
    // confirmed redemptions carry the wallet — that history must drive matching.
    db.appUser.findFirst.mockResolvedValue(null);
    db.redemption.findFirst.mockResolvedValue({ userEmail: "rita@test.com" });
    db.redemption.findMany.mockResolvedValue([pending("red9")]);
    db.redemption.updateMany.mockResolvedValue({ count: 1 });

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);

    expect(out).toEqual({ outcome: "auto-confirmed", redemptionId: "red9" });
    expect(db.redemption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userEmail: "rita@test.com" }),
      }),
    );
  });

  test("no app_user AND no redemption history → queued with userEmail null", async () => {
    db.appUser.findFirst.mockResolvedValue(null);
    db.redemption.findFirst.mockResolvedValue(null);

    const out = await handleUnmatchedTreasuryTransfer(TRANSFER);
    expect(out).toMatchObject({ outcome: "queued" });
    expect(db.unmatchedTransfer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userEmail: null }),
    });
  });
});

describe("sweepTreasuryInflows — pull-based backstop for missed webhooks", () => {
  const realFetch = globalThis.fetch;

  function mockInflowsResponse(
    transfers: Array<{ hash: string; from: string; wei: bigint; ts?: string }>,
  ) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          transfers: transfers.map((t) => ({
            hash: t.hash,
            from: t.from,
            to: "0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01",
            rawContract: {
              value: `0x${t.wei.toString(16)}`,
              address: "0xafa702c0a2a3a0cf1bd09435db61c913ccde8546",
            },
            metadata: { blockTimestamp: t.ts ?? new Date().toISOString() },
          })),
        },
      }),
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    process.env.ALCHEMY_RPC_URL = "https://rpc.test";
    process.env.DEV_WALLET_ADDRESS = "0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01";
    process.env.WEALTH_CONTRACT_ADDRESS =
      "0xafa702c0a2a3a0cf1bd09435db61c913ccde8546";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("inflow the DB already knows → counted as already-known, nothing written", async () => {
    mockInflowsResponse([
      { hash: "0x" + "11".repeat(32), from: TRANSFER.fromAddress, wei: 10n ** 17n },
    ]);
    db.redemption.findUnique.mockResolvedValue({ id: "red1" }); // hash known

    const out = await sweepTreasuryInflows();
    expect(out).toMatchObject({ scanned: 1, alreadyKnown: 1, queued: 0 });
    expect(db.unmatchedTransfer.create).not.toHaveBeenCalled();
  });

  test("unknown inflow from an unknown wallet → queued (the 0x5c18 backstop)", async () => {
    mockInflowsResponse([
      { hash: "0x" + "22".repeat(32), from: TRANSFER.fromAddress, wei: 10n ** 17n },
    ]);
    db.appUser.findFirst.mockResolvedValue(null);
    db.redemption.findFirst.mockResolvedValue(null);

    const out = await sweepTreasuryInflows();
    expect(out).toMatchObject({ scanned: 1, queued: 1 });
    expect(db.unmatchedTransfer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        txHash: "0x" + "22".repeat(32),
        status: "OPEN",
      }),
    });
  });

  test("transfers older than the window are skipped", async () => {
    mockInflowsResponse([
      {
        hash: "0x" + "33".repeat(32),
        from: TRANSFER.fromAddress,
        wei: 10n ** 17n,
        ts: "2020-01-01T00:00:00Z",
      },
    ]);

    const out = await sweepTreasuryInflows();
    expect(out).toMatchObject({ scanned: 0 });
    expect(db.unmatchedTransfer.create).not.toHaveBeenCalled();
  });

  test("missing env config → throws (never silently no-ops)", async () => {
    delete process.env.ALCHEMY_RPC_URL;
    await expect(sweepTreasuryInflows()).rejects.toThrow(/not configured/);
  });
});

describe("parseActivityAmount — exact amounts, no float loss", () => {
  test("parses raw hex value with 18 decimals exactly", () => {
    // 150965977112078800 wei
    const out = parseActivityAmount({
      rawContract: { rawValue: "0x21856c19eef69d0", decimals: "0x12" },
    });
    expect(out?.toString()).toBe("0.1509659771120788");
  });

  test("falls back to float value only when raw hex is missing", () => {
    const out = parseActivityAmount({ value: 0.5 });
    expect(out?.toString()).toBe("0.5");
  });

  test("returns null when nothing parseable", () => {
    expect(parseActivityAmount({})).toBeNull();
  });
});
