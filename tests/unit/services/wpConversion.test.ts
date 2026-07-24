import { describe, test, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// Shared mock so `tx` inside $transaction is the same object as `prisma`.
vi.mock("@/db.js", () => {
  const wpConversion = {
    aggregate: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  };
  const wpLedger = { aggregate: vi.fn(), create: vi.fn(), updateMany: vi.fn() };
  const appSettings = { findUnique: vi.fn() };
  const redemption = { aggregate: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    wpConversion,
    wpLedger,
    appSettings,
    redemption,
    $executeRaw: vi.fn(),
  };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

import { prisma } from "@/db.js";
import {
  convertWp,
  fulfillConversion,
  rejectConversion,
  ConversionDisabledError,
  ConversionBelowMinError,
  MonthlyWpLimitError,
  DepositCapError,
  MonthlyBudgetError,
  ConversionNotPendingError,
} from "@/services/wpConversion.js";
import { NotQualifiedError, AccountUnderReviewError } from "@/services/reward.js";
import { InsufficientWpError } from "@/services/wp.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const D = (n: number | string) => new Prisma.Decimal(n);

const SETTINGS = {
  wpConversionEnabled: true,
  wpConversionRate: 1000,
  wpConvertMinWp: 1000,
  wpConvertMaxWpPerMonth: 100_000,
  wpConversionMonthlyBudgetWealth: D(10_000),
};

const USER = {
  id: "u1",
  email: "a@b.com",
  fraudReviewStatus: "NONE" as const,
};

// Route wpConversion.aggregate calls by what they select / filter on.
function mockConversionAggs(opts: {
  usedWp?: number;
  cumulativeWealth?: number;
  globalWealth?: number;
}) {
  db.wpConversion.aggregate.mockImplementation((arg: any) => {
    if (arg._sum?.wpBurned) {
      return Promise.resolve({ _sum: { wpBurned: opts.usedWp ?? 0 } });
    }
    // _sum.wealthAmount: per-user cumulative has where.appUserId; global does not.
    if (arg.where?.appUserId) {
      return Promise.resolve({ _sum: { wealthAmount: D(opts.cumulativeWealth ?? 0) } });
    }
    return Promise.resolve({ _sum: { wealthAmount: D(opts.globalWealth ?? 0) } });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  db.appSettings.findUnique.mockResolvedValue(SETTINGS);
  db.redemption.aggregate.mockResolvedValue({ _sum: { wealthAmount: D(1000) } });
  db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 1_000_000 } }); // balance
  db.wpLedger.create.mockResolvedValue({ id: "l1" });
  db.wpLedger.updateMany.mockResolvedValue({ count: 1 });
  db.wpConversion.create.mockImplementation(({ data }: any) =>
    Promise.resolve({ id: "c1", ...data })
  );
  mockConversionAggs({});
});

describe("convertWp — happy path", () => {
  test("burns WP and opens a PENDING conversion at the 4dp rate", async () => {
    const conv = await convertWp(USER, 5000, "0x" + "a".repeat(40));

    // WP burned (negative ledger row, CONVERT_SPEND).
    const spendCall = db.wpLedger.create.mock.calls[0][0];
    expect(spendCall.data.amount).toBe(-5000);
    expect(spendCall.data.type).toBe("CONVERT_SPEND");
    expect(db.$executeRaw).toHaveBeenCalled(); // per-user advisory lock

    // Conversion row created PENDING with 5000/1000 = 5 $WEALTH.
    const created = db.wpConversion.create.mock.calls[0][0].data;
    expect(created.status).toBe("PENDING");
    expect(created.wpBurned).toBe(5000);
    expect(created.rate).toBe(1000);
    expect(new Prisma.Decimal(created.wealthAmount).toString()).toBe("5");
    expect(conv).toMatchObject({ status: "PENDING", wpBurned: 5000 });
  });
});

describe("convertWp — gates & caps", () => {
  test("rejects when conversion is disabled", async () => {
    db.appSettings.findUnique.mockResolvedValue({ ...SETTINGS, wpConversionEnabled: false });
    await expect(convertWp(USER, 5000, "0x" + "a".repeat(40))).rejects.toBeInstanceOf(
      ConversionDisabledError
    );
    expect(db.wpConversion.create).not.toHaveBeenCalled();
  });

  test("rejects a user who has not deposited (anti-bot gate)", async () => {
    // Eligibility is LIVE: zero confirmed-deposit total → not eligible to convert.
    db.redemption.aggregate.mockResolvedValue({ _sum: { wealthAmount: D(0) } });
    await expect(
      convertWp(USER, 5000, "0x" + "a".repeat(40))
    ).rejects.toBeInstanceOf(NotQualifiedError);
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("blocks a FLAGGED user (fraud-review gate) with a 403 message", async () => {
    await expect(
      convertWp({ ...USER, fraudReviewStatus: "FLAGGED" }, 5000, "0x" + "a".repeat(40))
    ).rejects.toThrow(
      "Akun kamu sedang ditinjau. Penukaran & konversi dinonaktifkan sementara."
    );
    await expect(
      convertWp({ ...USER, fraudReviewStatus: "FLAGGED" }, 5000, "0x" + "a".repeat(40))
    ).rejects.toBeInstanceOf(AccountUnderReviewError);
    // No WP burned, no conversion opened.
    expect(db.wpLedger.create).not.toHaveBeenCalled();
    expect(db.wpConversion.create).not.toHaveBeenCalled();
  });

  test.each(["NONE", "REVIEWING", "CLEARED"] as const)(
    "%s is a pure label — convert works normally",
    async (status) => {
      const conv = await convertWp(
        { ...USER, fraudReviewStatus: status },
        5000,
        "0x" + "a".repeat(40)
      );
      expect(conv).toMatchObject({ status: "PENDING", wpBurned: 5000 });
    }
  );

  test("reversible: flipping FLAGGED → NONE restores conversion access", async () => {
    await expect(
      convertWp({ ...USER, fraudReviewStatus: "FLAGGED" }, 5000, "0x" + "a".repeat(40))
    ).rejects.toBeInstanceOf(AccountUnderReviewError);

    const conv = await convertWp(
      { ...USER, fraudReviewStatus: "NONE" },
      5000,
      "0x" + "a".repeat(40)
    );
    expect(conv).toMatchObject({ status: "PENDING", wpBurned: 5000 });
  });

  test("rejects below the minimum", async () => {
    await expect(convertWp(USER, 500, "0x" + "a".repeat(40))).rejects.toBeInstanceOf(
      ConversionBelowMinError
    );
  });

  test("rejects over the per-user monthly WP ceiling", async () => {
    mockConversionAggs({ usedWp: 96_000 }); // remaining 4000 < 5000
    await expect(convertWp(USER, 5000, "0x" + "a".repeat(40))).rejects.toBeInstanceOf(
      MonthlyWpLimitError
    );
    expect(db.wpConversion.create).not.toHaveBeenCalled();
  });

  test("rejects over the anti-sybil deposit cap", async () => {
    // Confirmed-deposit total only 2 $WEALTH but the request is 5 $WEALTH.
    db.redemption.aggregate.mockResolvedValue({ _sum: { wealthAmount: D(2) } });
    await expect(convertWp(USER, 5000, "0x" + "a".repeat(40))).rejects.toBeInstanceOf(
      DepositCapError
    );
    expect(db.wpConversion.create).not.toHaveBeenCalled();
  });

  test("rejects over the global monthly $WEALTH budget", async () => {
    mockConversionAggs({ globalWealth: 9998 }); // 9998 + 5 > 10000
    await expect(convertWp(USER, 5000, "0x" + "a".repeat(40))).rejects.toBeInstanceOf(
      MonthlyBudgetError
    );
    expect(db.wpConversion.create).not.toHaveBeenCalled();
  });

  test("rejects when the WP balance is insufficient", async () => {
    db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 100 } }); // < 5000
    await expect(convertWp(USER, 5000, "0x" + "a".repeat(40))).rejects.toBeInstanceOf(
      InsufficientWpError
    );
    expect(db.wpConversion.create).not.toHaveBeenCalled();
  });
});

describe("fulfillConversion", () => {
  test("marks a PENDING conversion FULFILLED and records txHash", async () => {
    db.wpConversion.findUnique.mockResolvedValue({ id: "c1", status: "PENDING" });
    db.wpConversion.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: "c1", ...data })
    );

    const res = await fulfillConversion("c1", { txHash: "0xabc", fulfilledBy: "admin@x" });
    expect(res.status).toBe("FULFILLED");
    const upd = db.wpConversion.update.mock.calls[0][0].data;
    expect(upd.txHash).toBe("0xabc");
    expect(upd.fulfilledBy).toBe("admin@x");
    // No WP refund on fulfill.
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("is idempotent — a non-PENDING conversion is rejected", async () => {
    db.wpConversion.findUnique.mockResolvedValue({ id: "c1", status: "FULFILLED" });
    await expect(
      fulfillConversion("c1", { fulfilledBy: "admin@x" })
    ).rejects.toBeInstanceOf(ConversionNotPendingError);
    expect(db.wpConversion.update).not.toHaveBeenCalled();
  });
});

describe("rejectConversion", () => {
  test("refunds the burned WP (CONVERT_REFUND) and marks REJECTED", async () => {
    db.wpConversion.findUnique.mockResolvedValue({
      id: "c1",
      status: "PENDING",
      appUserId: "u1",
      wpBurned: 5000,
    });
    db.wpConversion.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: "c1", ...data })
    );

    const res = await rejectConversion("c1", { note: "invalid addr", fulfilledBy: "admin@x" });
    expect(res.status).toBe("REJECTED");

    // Refund is a positive CONVERT_REFUND ledger row.
    const refund = db.wpLedger.create.mock.calls[0][0].data;
    expect(refund.amount).toBe(5000);
    expect(refund.type).toBe("CONVERT_REFUND");
    expect(refund.refId).toBe("c1");
  });

  test("is idempotent — a non-PENDING conversion is not refunded", async () => {
    db.wpConversion.findUnique.mockResolvedValue({ id: "c1", status: "REJECTED" });
    await expect(
      rejectConversion("c1", { fulfilledBy: "admin@x" })
    ).rejects.toBeInstanceOf(ConversionNotPendingError);
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });
});
