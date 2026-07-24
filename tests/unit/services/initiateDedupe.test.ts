import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/db.js", () => {
  const models = {
    redemption: { findFirst: vi.fn() },
    appSettings: { findUnique: vi.fn() },
    appUser: { findFirst: vi.fn() },
    voucher: { findUnique: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { ...models };
  prisma.$executeRaw = vi.fn();
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

vi.mock("@/services/price.js", () => ({
  getWealthPrice: vi.fn().mockResolvedValue({ priceIdr: 67000 }),
}));

import { prisma } from "@/db.js";
import { initiateRedemption } from "@/services/redemption.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const PENDING_ROW = {
  id: "red-inflight",
  userEmail: "rita@test.com",
  voucherId: "v1",
  status: "PENDING",
  txHash: null,
  createdAt: new Date(),
};

const PARAMS = {
  userEmail: "rita@test.com",
  voucherId: "v1",
  idempotencyKey: "fresh-key-from-second-tap",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  db.appSettings.findUnique.mockResolvedValue(null);
  db.appUser.findFirst.mockResolvedValue(null);
});

describe("initiateRedemption — double-click / double-submit dedupe", () => {
  test("fast path: an in-flight PENDING row for the same voucher is REUSED, not duplicated", async () => {
    db.redemption.findFirst
      .mockResolvedValueOnce(null) // idempotencyKey check (fresh key per tap)
      .mockResolvedValueOnce(PENDING_ROW); // in-flight pending check

    const out = await initiateRedemption(PARAMS);

    expect(out).toEqual({ redemption: PENDING_ROW, alreadyExists: true });
    // Short-circuited before any create work.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.voucher.findUnique).not.toHaveBeenCalled();
  });

  test("raced taps: the second request settles under the advisory lock and reuses the first row", async () => {
    db.redemption.findFirst
      .mockResolvedValueOnce(null) // idempotency check
      .mockResolvedValueOnce(null) // fast path: nothing yet (race window)
      .mockResolvedValueOnce(PENDING_ROW); // re-check under the lock: winner's row

    const out = await initiateRedemption(PARAMS);

    expect(out).toEqual({ redemption: PENDING_ROW, alreadyExists: true });
    // The lock was taken and no second row was attempted.
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.voucher.findUnique).not.toHaveBeenCalled();
  });

  test("same idempotencyKey replay still short-circuits first (original behavior)", async () => {
    db.redemption.findFirst.mockResolvedValueOnce(PENDING_ROW);

    const out = await initiateRedemption(PARAMS);
    expect(out).toEqual({ redemption: PENDING_ROW, alreadyExists: true });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  test("in-flight rows are matched per user+voucher and only while PENDING without txHash — with NO age bound (resume-not-duplicate)", async () => {
    db.redemption.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    // No pending row → proceeds into the create path (voucher lookup runs and
    // fails here because we did not mock a voucher — that is fine, the
    // assertion is about the filter used for the dedupe lookup).
    db.voucher.findUnique.mockResolvedValue(null);

    await expect(initiateRedemption(PARAMS)).rejects.toThrow("Voucher not found");

    const dedupeCall = db.redemption.findFirst.mock.calls[1][0];
    expect(dedupeCall.where).toMatchObject({
      userEmail: "rita@test.com",
      voucherId: "v1",
      status: "PENDING",
      txHash: null,
    });
    // Resume-not-duplicate: the lookup must NOT be bounded by createdAt — any
    // unsettled pending (regardless of age) is reused, closing the cross-device
    // double-charge (device B tapping long after device A resumes A's row).
    expect(dedupeCall.where.createdAt).toBeUndefined();
  });

  test("resume-not-duplicate: an OLD (any-age) PENDING txHash-null row is REUSED, never duplicated (cross-device double-charge)", async () => {
    // Device A's pending row created well outside the old 30s window (35s+ ago).
    const OLD_PENDING_ROW = {
      ...PENDING_ROW,
      id: "red-device-a",
      createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
    };
    // Device B taps with a fresh idempotency key; idempotency check misses,
    // the fast-path resume check finds device A's still-unsettled pending.
    db.redemption.findFirst
      .mockResolvedValueOnce(null) // idempotencyKey check (fresh key from device B)
      .mockResolvedValueOnce(OLD_PENDING_ROW); // resume check finds A's old row

    const out = await initiateRedemption(PARAMS);

    // Device B resumes device A's row — no second row, no second slot reserved.
    expect(out).toEqual({ redemption: OLD_PENDING_ROW, alreadyExists: true });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.voucher.findUnique).not.toHaveBeenCalled();
  });
});
