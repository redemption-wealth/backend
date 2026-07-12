import { describe, test, expect, vi, beforeEach } from "vitest";

// Shared mock objects so `tx` inside $transaction is the same as `prisma`.
vi.mock("@/db.js", () => {
  const wpLedger = { aggregate: vi.fn(), create: vi.fn() };
  const appSettings = { findUnique: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { wpLedger, appSettings, $executeRaw: vi.fn() };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

import { prisma } from "@/db.js";
import {
  getBalance,
  credit,
  spend,
  adminAdjust,
  InsufficientWpError,
  WpCapExceededError,
} from "@/services/wp.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

// Aggregate is used for two distinct purposes: monthly-issuance (where.type set)
// and balance (where.appUserId only). Route each by inspecting the where clause.
function mockAggregate({ issued, balance }: { issued?: number; balance?: number }) {
  db.wpLedger.aggregate.mockImplementation(({ where }: any) => {
    if (where?.type) return Promise.resolve({ _sum: { amount: issued ?? 0 } });
    return Promise.resolve({ _sum: { amount: balance ?? 0 } });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
});

describe("getBalance", () => {
  test("sums ledger amounts", async () => {
    mockAggregate({ balance: 123 });
    expect(await getBalance("u1")).toBe(123);
  });

  test("returns 0 for an empty ledger", async () => {
    db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: null } });
    expect(await getBalance("u1")).toBe(0);
  });
});

describe("credit", () => {
  test("mints WP when under the monthly cap", async () => {
    db.appSettings.findUnique.mockResolvedValue({ wpMonthlyCapWp: 1000 });
    mockAggregate({ issued: 100, balance: 250 });
    db.wpLedger.create.mockResolvedValue({ id: "l1" });

    const res = await credit({ appUserId: "u1", amount: 50, type: "TASK" });

    expect(db.wpLedger.create).toHaveBeenCalledTimes(1);
    const arg = db.wpLedger.create.mock.calls[0][0];
    expect(arg.data.amount).toBe(50); // positive
    expect(arg.data.type).toBe("TASK");
    expect(res).toEqual({ ledgerId: "l1", balance: 250 });
  });

  test("rejects an issuance that would exceed the monthly cap", async () => {
    db.appSettings.findUnique.mockResolvedValue({ wpMonthlyCapWp: 100 });
    mockAggregate({ issued: 80 });

    await expect(
      credit({ appUserId: "u1", amount: 50, type: "CHECKIN" })
    ).rejects.toBeInstanceOf(WpCapExceededError);
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("does not apply the cap to non-issuance credits (e.g. refunds)", async () => {
    // No appSettings/issuance lookup needed for refunds.
    mockAggregate({ balance: 10 });
    db.wpLedger.create.mockResolvedValue({ id: "l2" });

    await credit({ appUserId: "u1", amount: 999999, type: "REDEEM_REFUND" });

    expect(db.appSettings.findUnique).not.toHaveBeenCalled();
    expect(db.wpLedger.create).toHaveBeenCalledTimes(1);
  });

  test("rejects a non-positive amount", async () => {
    await expect(
      credit({ appUserId: "u1", amount: 0, type: "TASK" })
    ).rejects.toThrow(/positive/);
  });

  test("edge: issuance landing exactly on the cap is allowed (issued + amount === cap)", async () => {
    db.appSettings.findUnique.mockResolvedValue({ wpMonthlyCapWp: 100 });
    mockAggregate({ issued: 80, balance: 20 });
    db.wpLedger.create.mockResolvedValue({ id: "l-edge" });

    // 80 + 20 === 100 → NOT over cap (guard is strictly `>`).
    await expect(
      credit({ appUserId: "u1", amount: 20, type: "TASK" })
    ).resolves.toMatchObject({ ledgerId: "l-edge" });
    expect(db.wpLedger.create).toHaveBeenCalledTimes(1);
  });

  test("edge: one WP over the cap is rejected", async () => {
    db.appSettings.findUnique.mockResolvedValue({ wpMonthlyCapWp: 100 });
    mockAggregate({ issued: 80 });

    await expect(
      credit({ appUserId: "u1", amount: 21, type: "TASK" })
    ).rejects.toBeInstanceOf(WpCapExceededError);
  });
});

describe("spend", () => {
  test("debits WP when the balance is sufficient and takes the advisory lock", async () => {
    mockAggregate({ balance: 100 });
    db.wpLedger.create.mockResolvedValue({ id: "l3" });

    const res = await spend({
      appUserId: "u1",
      amount: 30,
      type: "REDEEM_SPEND",
      refType: "reward",
      refId: "r1",
    });

    expect(db.$executeRaw).toHaveBeenCalledTimes(1); // per-user serialization
    const arg = db.wpLedger.create.mock.calls[0][0];
    expect(arg.data.amount).toBe(-30); // negative
    expect(res).toEqual({ ledgerId: "l3", balance: 70 });
  });

  test("rejects when the balance is insufficient", async () => {
    mockAggregate({ balance: 20 });

    await expect(
      spend({ appUserId: "u1", amount: 30, type: "REDEEM_SPEND" })
    ).rejects.toBeInstanceOf(InsufficientWpError);
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("edge: spending exactly the balance succeeds (balance === amount)", async () => {
    mockAggregate({ balance: 30 });
    db.wpLedger.create.mockResolvedValue({ id: "l-exact" });

    const res = await spend({ appUserId: "u1", amount: 30, type: "REDEEM_SPEND" });
    expect(res.balance).toBe(0);
    expect(db.wpLedger.create.mock.calls[0][0].data.amount).toBe(-30);
  });

  test("rejects a non-positive spend amount", async () => {
    await expect(
      spend({ appUserId: "u1", amount: 0, type: "REDEEM_SPEND" })
    ).rejects.toThrow(/positive/);
  });
});

describe("adminAdjust", () => {
  test("grants WP (positive) without a cap check", async () => {
    mockAggregate({ balance: 150 });
    db.wpLedger.create.mockResolvedValue({ id: "adj1" });

    const res = await adminAdjust("u1", 100, "goodwill");

    const arg = db.wpLedger.create.mock.calls[0][0];
    expect(arg.data.amount).toBe(100);
    expect(arg.data.type).toBe("ADMIN_ADJUST");
    expect(db.appSettings.findUnique).not.toHaveBeenCalled();
    expect(res.balance).toBe(150);
  });

  test("allows a negative clawback", async () => {
    mockAggregate({ balance: -5 });
    db.wpLedger.create.mockResolvedValue({ id: "adj2" });

    await adminAdjust("u1", -50);
    expect(db.wpLedger.create.mock.calls[0][0].data.amount).toBe(-50);
  });

  test("rejects a zero delta", async () => {
    await expect(adminAdjust("u1", 0)).rejects.toThrow();
  });

  test("rejects a non-integer delta", async () => {
    await expect(adminAdjust("u1", 10.5)).rejects.toThrow(/integer/);
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });
});
