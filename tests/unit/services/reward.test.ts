import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/db.js", () => {
  const models = {
    appUser: { findUnique: vi.fn() },
    wpReward: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    wpRedemption: { create: vi.fn() },
    wpLedger: { aggregate: vi.fn(), create: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { ...models, $executeRaw: vi.fn() };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

import { prisma } from "@/db.js";
import {
  redeemReward,
  NotQualifiedError,
  AccountUnderReviewError,
  OutOfStockError,
} from "@/services/reward.js";
import { InsufficientWpError } from "@/services/wp.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const REWARD = {
  id: "r1",
  isActive: true,
  stock: 5,
  wpCost: 300,
  title: "Voucher Kopi",
};

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  db.wpLedger.create.mockResolvedValue({ id: "l1" });
  db.wpReward.update.mockResolvedValue({});
  db.wpRedemption.create.mockImplementation(({ data }: any) =>
    Promise.resolve({ id: "wr1", status: "PENDING", ...data })
  );
});

describe("redeemReward — anti-bot gate", () => {
  test("rejects a user who has not deposited", async () => {
    db.appUser.findUnique.mockResolvedValue({ hasDeposited: false });

    await expect(redeemReward("u1", "r1")).rejects.toBeInstanceOf(
      NotQualifiedError
    );
    expect(db.wpLedger.create).not.toHaveBeenCalled();
    expect(db.wpRedemption.create).not.toHaveBeenCalled();
  });
});

describe("redeemReward — fraud-review gate (FLAGGED)", () => {
  test("blocks a FLAGGED user before spending WP", async () => {
    db.appUser.findUnique.mockResolvedValue({
      hasDeposited: true,
      fraudReviewStatus: "FLAGGED",
    });

    await expect(redeemReward("u1", "r1")).rejects.toBeInstanceOf(
      AccountUnderReviewError
    );
    // No WP spent, no request created — gate is early.
    expect(db.wpLedger.create).not.toHaveBeenCalled();
    expect(db.wpRedemption.create).not.toHaveBeenCalled();
  });

  test("carries the Indonesian message for the app to surface", async () => {
    db.appUser.findUnique.mockResolvedValue({
      hasDeposited: true,
      fraudReviewStatus: "FLAGGED",
    });
    await expect(redeemReward("u1", "r1")).rejects.toThrow(
      "Akun kamu sedang ditinjau. Penukaran & konversi dinonaktifkan sementara."
    );
  });

  test.each(["NONE", "REVIEWING", "CLEARED"] as const)(
    "%s is a pure label — redeem works normally",
    async (status) => {
      db.appUser.findUnique.mockResolvedValue({
        hasDeposited: true,
        fraudReviewStatus: status,
      });
      db.wpReward.findUnique.mockResolvedValue(REWARD);
      db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 1000 } });

      const res = await redeemReward("u1", "r1");
      expect(res).toMatchObject({ status: "PENDING", wpSpent: 300 });
    }
  );

  test("reversible: flipping FLAGGED → NONE restores access", async () => {
    // First call: FLAGGED → blocked.
    db.appUser.findUnique.mockResolvedValueOnce({
      hasDeposited: true,
      fraudReviewStatus: "FLAGGED",
    });
    await expect(redeemReward("u1", "r1")).rejects.toBeInstanceOf(
      AccountUnderReviewError
    );

    // Admin resets to NONE → next read succeeds (no state to undo).
    db.appUser.findUnique.mockResolvedValue({
      hasDeposited: true,
      fraudReviewStatus: "NONE",
    });
    db.wpReward.findUnique.mockResolvedValue(REWARD);
    db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 1000 } });

    const res = await redeemReward("u1", "r1");
    expect(res).toMatchObject({ status: "PENDING", wpSpent: 300 });
  });
});

describe("redeemReward — success", () => {
  test("qualified user spends WP, decrements stock, creates a PENDING request", async () => {
    db.appUser.findUnique.mockResolvedValue({ hasDeposited: true });
    db.wpReward.findUnique.mockResolvedValue(REWARD);
    db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 1000 } });

    const res = await redeemReward("u1", "r1");

    // WP debited by the reward cost
    expect(db.wpLedger.create.mock.calls[0][0].data.amount).toBe(-300);
    // limited stock decremented
    expect(db.wpReward.update).toHaveBeenCalledTimes(1);
    expect(db.wpReward.update.mock.calls[0][0].data.stock).toEqual({
      decrement: 1,
    });
    // request row created
    expect(res).toMatchObject({ status: "PENDING", wpSpent: 300 });
  });

  test("does not touch stock for unlimited rewards", async () => {
    db.appUser.findUnique.mockResolvedValue({ hasDeposited: true });
    db.wpReward.findUnique.mockResolvedValue({ ...REWARD, stock: null });
    db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 1000 } });

    await redeemReward("u1", "r1");
    expect(db.wpReward.update).not.toHaveBeenCalled();
  });
});

describe("redeemReward — failures", () => {
  test("rejects when out of stock", async () => {
    db.appUser.findUnique.mockResolvedValue({ hasDeposited: true });
    db.wpReward.findUnique.mockResolvedValue({ ...REWARD, stock: 0 });

    await expect(redeemReward("u1", "r1")).rejects.toBeInstanceOf(
      OutOfStockError
    );
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("rejects when the WP balance is insufficient", async () => {
    db.appUser.findUnique.mockResolvedValue({ hasDeposited: true });
    db.wpReward.findUnique.mockResolvedValue(REWARD);
    db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 100 } }); // < 300

    await expect(redeemReward("u1", "r1")).rejects.toBeInstanceOf(
      InsufficientWpError
    );
    expect(db.wpRedemption.create).not.toHaveBeenCalled();
    expect(db.wpReward.update).not.toHaveBeenCalled();
  });
});
