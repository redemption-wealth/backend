import { describe, test, expect, vi } from "vitest";
import { testPrisma } from "../setup.integration.js";
import { createFixtures } from "../helpers/fixtures.js";

// Mock the network-bound dependencies of the redemption service: price (CMC)
// and QR generation (R2 upload). generateQrCode must return deterministic data
// so confirmRedemption -> ensureQrAssigned can assign QR codes without R2.
vi.mock("@/services/price.js", () => ({
  getWealthPrice: vi.fn(async () => ({ priceIdr: 850, cached: false })),
}));
vi.mock("@/services/qr-generator.js", () => ({
  generateQrCode: vi.fn(async (redemptionId: string, index: number) => ({
    token: `mock-token-${redemptionId}-${index}`,
    imageUrl: `qr-codes/${redemptionId}/${index}.png`,
    imageHash: `mock-hash-${redemptionId}-${index}`,
  })),
  deleteQrFiles: vi.fn(async () => {}),
}));

const fixtures = createFixtures(testPrisma);

describe("Multi-QR Redemption Flow E2E", () => {
  test("voucher with qrPerSlot=2 assigns 2 QR codes on confirm", async () => {
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    // 2 QR codes per slot, single slot of stock.
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 2, {
      qrPerSlot: 2,
      totalStock: 1,
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

    // Submit txHash, then confirm via webhook simulation.
    const txHash = "0x" + "b".repeat(64);
    await testPrisma.redemption.update({
      where: { id: redemption.id },
      data: { txHash },
    });
    const confirmed = await confirmRedemption(txHash);
    expect(confirmed.status).toBe("CONFIRMED");

    // 2 QR codes are assigned to this redemption (status REDEEMED).
    const assignedQrs = await testPrisma.qrCode.findMany({
      where: { redemptionId: redemption.id },
    });
    expect(assignedQrs.length).toBe(2);
    expect(assignedQrs.every((qr) => qr.status === "REDEEMED")).toBe(true);

    // Stock recalculated from available slots: the only slot is now reserved.
    const updatedVoucher = await testPrisma.voucher.findUnique({
      where: { id: voucher.id },
    });
    expect(updatedVoucher!.remainingStock).toBe(0);
  });
});
