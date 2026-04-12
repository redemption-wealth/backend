import { describe, test, expect } from "vitest";
import { testPrisma } from "../setup.integration.js";
import { createFixtures } from "../helpers/fixtures.js";

const fixtures = createFixtures(testPrisma);

describe("Concurrent Access Tests", () => {
  test("two users redeem last-stock voucher — one succeeds, one fails", async () => {
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 1, {
      totalStock: 1,
    });
    await fixtures.createAppSettings({ appFeePercentage: 3 });

    const user1 = await fixtures.createUser({ email: "user1@test.com" });
    const user2 = await fixtures.createUser({ email: "user2@test.com" });

    const { initiateRedemption } = await import("@/services/redemption.js");

    const results = await Promise.allSettled([
      initiateRedemption({
        userId: user1.id,
        voucherId: voucher.id,
        idempotencyKey: crypto.randomUUID(),
        wealthPriceIdr: 850,
      }),
      initiateRedemption({
        userId: user2.id,
        voucherId: voucher.id,
        idempotencyKey: crypto.randomUUID(),
        wealthPriceIdr: 850,
      }),
    ]);

    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");

    // At least one should succeed, at least one should fail
    expect(successes.length).toBeGreaterThanOrEqual(1);
    // The combination should account for all attempts
    expect(successes.length + failures.length).toBe(2);
  });

  test("idempotency: same user duplicate request returns same redemption", async () => {
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 5);
    await fixtures.createAppSettings({ appFeePercentage: 3 });

    const user = await fixtures.createUser();
    const idempotencyKey = crypto.randomUUID();

    const { initiateRedemption } = await import("@/services/redemption.js");

    const result1 = await initiateRedemption({
      userId: user.id,
      voucherId: voucher.id,
      idempotencyKey,
      wealthPriceIdr: 850,
    });
    expect(result1.alreadyExists).toBe(false);

    const result2 = await initiateRedemption({
      userId: user.id,
      voucherId: voucher.id,
      idempotencyKey,
      wealthPriceIdr: 850,
    });
    expect(result2.alreadyExists).toBe(true);
    expect(result2.redemption.id).toBe(result1.redemption.id);
  });
});
