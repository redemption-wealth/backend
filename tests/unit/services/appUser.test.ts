import { describe, test, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// Mock the DB layer — these are pure logic tests, no real Postgres.
vi.mock("@/db.js", () => {
  const models = {
    appUser: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    redemption: { count: vi.fn() },
    wpLedger: { findFirst: vi.fn(), aggregate: vi.fn(), create: vi.fn() },
    wpRedemption: { count: vi.fn() },
    quest: { findMany: vi.fn() },
    questCompletion: { findUnique: vi.fn(), create: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { ...models, $executeRaw: vi.fn() };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

import { prisma } from "@/db.js";
import { syncAppUser, generateReferralCode } from "@/services/appUser.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  // Milestone eval (runs after a referee qualifies) — no milestone quests by default.
  db.quest.findMany.mockResolvedValue([]);
  // creditWithTx dependencies (cap check + balance) — permissive defaults.
  db.appSettings.findUnique.mockResolvedValue({ wpMonthlyCapWp: 1_000_000 });
});

describe("generateReferralCode", () => {
  test("returns an 8-char code from the unambiguous alphabet", () => {
    const code = generateReferralCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    // no ambiguous glyphs
    expect(code).not.toMatch(/[IO01]/);
  });
});

describe("syncAppUser", () => {
  test("creates a new AppUser with a generated referral code", async () => {
    db.redemption.count.mockResolvedValue(0);
    db.appUser.findUnique.mockResolvedValue(null); // privyId lookup → not found
    db.appUser.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: "u1", ...data })
    );

    const res = await syncAppUser({
      privyUserId: "privy_1",
      userEmail: "a@x.com",
    });

    expect(db.appUser.create).toHaveBeenCalledTimes(1);
    const arg = db.appUser.create.mock.calls[0][0];
    expect(arg.data.referralCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(arg.data.hasDeposited).toBe(false);
    expect(arg.data.qualifiedAt).toBeNull();
    expect(res.id).toBe("u1");
    expect(db.appUser.update).not.toHaveBeenCalled();
  });

  test("retries on a referral-code collision (PrismaPg driver-adapter P2002 shape)", async () => {
    db.redemption.count.mockResolvedValue(0);
    db.appUser.findUnique.mockResolvedValue(null); // privyId lookup → not found
    // First create() collides on referralCode via the driver-adapter shape
    // (meta.target is undefined under PrismaPg); the second succeeds. The old
    // meta.target-only guard would not retry and would throw instead.
    let calls = 0;
    db.appUser.create.mockImplementation(({ data }: any) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "7.7.0",
            meta: {
              driverAdapterError: {
                cause: { constraint: { fields: ["referralCode"] } },
              },
            },
          })
        );
      }
      return Promise.resolve({ id: "u1", ...data });
    });

    const res = await syncAppUser({
      privyUserId: "privy_1",
      userEmail: "a@x.com",
    });

    expect(db.appUser.create).toHaveBeenCalledTimes(2); // retried after collision
    expect(res.id).toBe("u1");
  });

  test("is idempotent: an existing user syncs via update, never re-creates", async () => {
    db.redemption.count.mockResolvedValue(1);
    db.appUser.findUnique.mockResolvedValue({
      id: "u1",
      hasDeposited: true,
      referredById: null,
    });
    db.appUser.update.mockResolvedValue({ id: "u1", referredById: null });

    const res = await syncAppUser({
      privyUserId: "privy_1",
      userEmail: "a@x.com",
    });

    expect(db.appUser.create).not.toHaveBeenCalled();
    expect(db.appUser.update).toHaveBeenCalledTimes(1);
    expect(res.id).toBe("u1");
  });

  test("records the referrer once, from a normalized referral code, on creation", async () => {
    db.redemption.count.mockResolvedValue(0);
    db.appUser.findUnique.mockImplementation(({ where }: any) => {
      if (where.privyId) return Promise.resolve(null);
      if (where.referralCode) return Promise.resolve({ id: "ref1" });
      return Promise.resolve(null);
    });
    db.appUser.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: "u2", ...data })
    );

    await syncAppUser({ privyUserId: "privy_2", userEmail: "b@x.com" }, "friend01");

    const createArg = db.appUser.create.mock.calls[0][0];
    expect(createArg.data.referredById).toBe("ref1");
    // lookup used the trimmed + uppercased code
    const refLookup = db.appUser.findUnique.mock.calls.find(
      (c: any) => c[0]?.where?.referralCode
    );
    expect(refLookup[0].where.referralCode).toBe("FRIEND01");
  });

  test("does not change the referrer for an existing user (set-once)", async () => {
    db.redemption.count.mockResolvedValue(0);
    db.appUser.findUnique.mockResolvedValue({
      id: "u1",
      hasDeposited: false,
      referredById: null,
    });
    db.appUser.update.mockResolvedValue({ id: "u1", referredById: null });

    await syncAppUser(
      { privyUserId: "privy_1", userEmail: "a@x.com" },
      "SOMECODE"
    );

    // referral lookup must NOT happen for existing users
    const refLookup = db.appUser.findUnique.mock.calls.find(
      (c: any) => c[0]?.where?.referralCode
    );
    expect(refLookup).toBeUndefined();
    const updateArg = db.appUser.update.mock.calls[0][0];
    expect(updateArg.data.referredById).toBeUndefined();
  });

  test("pays flat two-sided referral bonuses when a referee first qualifies", async () => {
    db.redemption.count.mockResolvedValue(1); // referee now has a CONFIRMED redemption
    db.appUser.findUnique.mockResolvedValue({
      id: "u3",
      hasDeposited: false, // was not qualified
      referredById: "ref1",
    });
    db.appUser.update.mockResolvedValue({ id: "u3", referredById: "ref1" });
    db.wpLedger.findFirst.mockResolvedValue(null); // neither leg paid yet
    db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 300 } });
    // Flat amounts come from settings (defaults 50/50 when columns are absent).
    db.appSettings.findUnique.mockResolvedValue({
      wpMonthlyCapWp: 1_000_000,
      wpReferrerBonusWp: 50,
      wpRefereeWelcomeWp: 50,
    });
    db.wpLedger.create.mockResolvedValue({ id: "l1" });

    await syncAppUser({ privyUserId: "privy_3", userEmail: "c@x.com" });

    // Two rows: flat referrer bonus + flat referee welcome. Amount is FLAT, not a
    // % of the referee's 300 WP balance.
    expect(db.wpLedger.create).toHaveBeenCalledTimes(2);
    const referrerArg = db.wpLedger.create.mock.calls[0][0];
    expect(referrerArg.data.appUserId).toBe("ref1"); // credited to the referrer
    expect(referrerArg.data.amount).toBe(50); // flat, not floor(300 * 0.1)
    expect(referrerArg.data.type).toBe("REFERRAL_BONUS");
    expect(referrerArg.data.refType).toBe("referral");
    expect(referrerArg.data.refId).toBe("u3"); // one bonus per referee
    const refereeArg = db.wpLedger.create.mock.calls[1][0];
    expect(refereeArg.data.appUserId).toBe("u3"); // welcome to the referee
    expect(refereeArg.data.amount).toBe(50);
    expect(refereeArg.data.refType).toBe("referral_welcome");
  });

  test("does not double-pay the referral bonus", async () => {
    db.redemption.count.mockResolvedValue(1);
    db.appUser.findUnique.mockResolvedValue({
      id: "u3",
      hasDeposited: false,
      referredById: "ref1",
    });
    db.appUser.update.mockResolvedValue({ id: "u3", referredById: "ref1" });
    db.wpLedger.findFirst.mockResolvedValue({ id: "existing-bonus" }); // already paid

    await syncAppUser({ privyUserId: "privy_3", userEmail: "c@x.com" });

    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("referral bonus counts against the monthly cap (skipped when exhausted)", async () => {
    db.redemption.count.mockResolvedValue(1);
    db.appUser.findUnique.mockResolvedValue({
      id: "u3",
      hasDeposited: false,
      referredById: "ref1",
    });
    db.appUser.update.mockResolvedValue({ id: "u3", referredById: "ref1" });
    db.wpLedger.findFirst.mockResolvedValue(null); // no prior bonus
    // referee balance 50 → bonus 5, but this month's issuance is already at cap
    db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 50 } });
    db.appSettings.findUnique.mockResolvedValue({ wpMonthlyCapWp: 50 });

    await syncAppUser({ privyUserId: "privy_3", userEmail: "c@x.com" });

    // Routed through the capped credit path → WpCapExceededError swallowed, no row.
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });
});
