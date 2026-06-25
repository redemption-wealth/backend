import { describe, test, expect, vi } from "vitest";
import { testPrisma } from "../setup.integration.js";
import { createFixtures } from "../helpers/fixtures.js";

// Mock network-bound deps. For MERCHANT_UPLOADED + CODE there is no image, so
// generateUploadedAsset returns nulls (mirrors the real CODE path, no R2).
vi.mock("@/services/price.js", () => ({
  getWealthPrice: vi.fn(async () => ({ priceIdr: 850, cached: false })),
}));
vi.mock("@/services/qr-generator.js", () => ({
  generateQrCode: vi.fn(async (redemptionId: string, index: number) => ({
    token: `mock-token-${redemptionId}-${index}`,
    imageUrl: `qr-codes/${redemptionId}/${index}.png`,
    imageHash: `mock-hash-${redemptionId}-${index}`,
  })),
  generateUploadedAsset: vi.fn(async () => ({ imageUrl: null, imageHash: null })),
  deleteQrFiles: vi.fn(async () => {}),
}));

const fixtures = createFixtures(testPrisma);

describe("Merchant-uploaded Redemption Flow E2E", () => {
  test("CODE upload: confirm assigns the pre-stored value, no scan needed", async () => {
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 2, {
      totalStock: 2,
      qrPerSlot: 1,
      assetSource: "MERCHANT_UPLOADED",
      format: "CODE",
      values: ["CODE-A", "CODE-B"],
    });
    await fixtures.createAppSettings({ appFeeRate: 3, gasFeeAmount: 5000 });

    const user = fixtures.createUser();
    const { initiateRedemption, confirmRedemption } = await import(
      "@/services/redemption.js"
    );

    const { redemption } = await initiateRedemption({
      userEmail: user.email,
      voucherId: voucher.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(redemption.status).toBe("PENDING");

    const txHash = "0x" + "c".repeat(64);
    await testPrisma.redemption.update({
      where: { id: redemption.id },
      data: { txHash },
    });
    const confirmed = await confirmRedemption(txHash);
    expect(confirmed.status).toBe("CONFIRMED");

    const assigned = await testPrisma.qrCode.findMany({
      where: { redemptionId: redemption.id },
    });
    expect(assigned.length).toBe(1);
    expect(assigned[0].status).toBe("REDEEMED");
    // The merchant value is preserved through assignment; CODE has no image.
    expect(assigned[0].value).toMatch(/^CODE-[AB]$/);
    expect(assigned[0].imageUrl).toBeNull();

    // Stock consumed at reservation: 1 of 2 slots remains.
    const updated = await testPrisma.voucher.findUnique({ where: { id: voucher.id } });
    expect(updated!.remainingStock).toBe(1);
  });

  test("releasing a PENDING upload redemption preserves the slot value", async () => {
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 1, {
      totalStock: 1,
      qrPerSlot: 1,
      assetSource: "MERCHANT_UPLOADED",
      format: "CODE",
      values: ["KEEPME"],
    });
    await fixtures.createAppSettings({ appFeeRate: 3, gasFeeAmount: 5000 });

    const user = fixtures.createUser();
    const { initiateRedemption, releasePendingRedemption } = await import(
      "@/services/redemption.js"
    );

    const { redemption } = await initiateRedemption({
      userEmail: user.email,
      voucherId: voucher.id,
      idempotencyKey: crypto.randomUUID(),
    });

    const released = await releasePendingRedemption(redemption.id);
    expect(released).toBe(true);

    // Value survives release; slot is AVAILABLE again and stock restored.
    const qr = await testPrisma.qrCode.findFirst({ where: { voucherId: voucher.id } });
    expect(qr!.value).toBe("KEEPME");
    expect(qr!.status).toBe("AVAILABLE");
    const updated = await testPrisma.voucher.findUnique({ where: { id: voucher.id } });
    expect(updated!.remainingStock).toBe(1);
  });
});
