import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/db.js", () => {
  const models = {
    wpRedemption: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
    wpReward: { findUnique: vi.fn(), update: vi.fn() },
    wpLedger: { aggregate: vi.fn(), create: vi.fn() },
    // Milestone eval runs after fulfillRedemption; no milestone quests here.
    quest: { findMany: vi.fn() },
    questCompletion: { findUnique: vi.fn(), create: vi.fn() },
    appUser: { count: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { ...models, $executeRaw: vi.fn() };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

import { prisma } from "@/db.js";
import {
  fulfillRedemption,
  rejectRedemption,
  RedemptionNotPendingError,
} from "@/services/reward.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const PENDING = {
  id: "wr1",
  status: "PENDING",
  appUserId: "u1",
  rewardId: "r1",
  wpSpent: 300,
  note: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  db.wpLedger.create.mockResolvedValue({ id: "l1" });
  db.wpReward.update.mockResolvedValue({});
  db.wpRedemption.update.mockImplementation(({ data }: any) =>
    Promise.resolve({ id: "wr1", appUserId: "u1", ...data })
  );
  // Milestone eval after fulfill — no milestone quests configured by default.
  db.quest.findMany.mockResolvedValue([]);
});

describe("rejectRedemption", () => {
  test("refunds WP, restores stock, marks REJECTED", async () => {
    db.wpRedemption.findUnique.mockResolvedValue(PENDING);
    db.wpReward.findUnique.mockResolvedValue({ stock: 5 });

    const res = await rejectRedemption("wr1", "admin@x.com", "stok kosong");

    // refund credit for the full spent amount
    const credit = db.wpLedger.create.mock.calls[0][0];
    expect(credit.data.amount).toBe(300);
    expect(credit.data.type).toBe("REDEEM_REFUND");
    // stock restored
    expect(db.wpReward.update.mock.calls[0][0].data.stock).toEqual({
      increment: 1,
    });
    expect(res.status).toBe("REJECTED");
  });

  test("does not restock an unlimited reward", async () => {
    db.wpRedemption.findUnique.mockResolvedValue(PENDING);
    db.wpReward.findUnique.mockResolvedValue({ stock: null });

    await rejectRedemption("wr1", "admin@x.com");
    expect(db.wpReward.update).not.toHaveBeenCalled();
  });

  test("is idempotent — a non-pending request is not refunded again", async () => {
    db.wpRedemption.findUnique.mockResolvedValue({
      ...PENDING,
      status: "REJECTED",
    });

    await expect(rejectRedemption("wr1", "admin@x.com")).rejects.toBeInstanceOf(
      RedemptionNotPendingError
    );
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });
});

describe("fulfillRedemption", () => {
  test("marks a pending request FULFILLED with the admin email", async () => {
    db.wpRedemption.findUnique.mockResolvedValue(PENDING);
    const res = await fulfillRedemption("wr1", "admin@x.com");
    expect(res.status).toBe("FULFILLED");
    expect(res.fulfilledBy).toBe("admin@x.com");
    expect(db.wpLedger.create).not.toHaveBeenCalled(); // no refund on fulfill
  });

  test("rejects fulfilling an already-processed request", async () => {
    db.wpRedemption.findUnique.mockResolvedValue({
      ...PENDING,
      status: "FULFILLED",
    });
    await expect(
      fulfillRedemption("wr1", "admin@x.com")
    ).rejects.toBeInstanceOf(RedemptionNotPendingError);
  });
});
