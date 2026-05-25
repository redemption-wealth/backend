import { describe, test, expect, vi } from "vitest";
import { testPrisma } from "../setup.integration.js";
import { createFixtures } from "../helpers/fixtures.js";

// The redemption service fetches the WEALTH price from CMC server-side and
// (on confirm) uploads QR images to R2. Mock both so the flow is deterministic
// and never touches the network in tests.
vi.mock("@/services/price.js", () => ({
  getWealthPrice: vi.fn(async () => ({ priceIdr: 850, cached: false })),
}));

const fixtures = createFixtures(testPrisma);

describe("Concurrent Access Tests", () => {
  test("two users redeem last-stock voucher — one succeeds, one fails", async () => {
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 1, {
      totalStock: 1,
    });
    await fixtures.createAppSettings({ appFeeRate: 3 });

    const user1 = fixtures.createUser({ email: "user1@test.com" });
    const user2 = fixtures.createUser({ email: "user2@test.com" });

    const { initiateRedemption } = await import("@/services/redemption.js");

    const results = await Promise.allSettled([
      initiateRedemption({
        userEmail: user1.email,
        voucherId: voucher.id,
        idempotencyKey: crypto.randomUUID(),
      }),
      initiateRedemption({
        userEmail: user2.email,
        voucherId: voucher.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    ]);

    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");

    // Exactly one slot exists, so exactly one initiation reserves it.
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(successes.length + failures.length).toBe(2);

    // The successful redemption is PENDING with a reserved slot.
    const fulfilled = successes[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof initiateRedemption>>
    >;
    expect(fulfilled.value.redemption.status).toBe("PENDING");
  });

  test("idempotency: same user duplicate request returns same redemption", async () => {
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 5);
    await fixtures.createAppSettings({ appFeeRate: 3 });

    const user = fixtures.createUser();
    const idempotencyKey = crypto.randomUUID();

    const { initiateRedemption } = await import("@/services/redemption.js");

    const result1 = await initiateRedemption({
      userEmail: user.email,
      voucherId: voucher.id,
      idempotencyKey,
    });
    expect(result1.alreadyExists).toBe(false);

    const result2 = await initiateRedemption({
      userEmail: user.email,
      voucherId: voucher.id,
      idempotencyKey,
    });
    expect(result2.alreadyExists).toBe(true);
    expect(result2.redemption.id).toBe(result1.redemption.id);
  });
});
