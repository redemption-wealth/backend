import { describe, test, expect } from "vitest";
import { testPrisma } from "../setup.integration.js";
import { createFixtures } from "../helpers/fixtures.js";

const fixtures = createFixtures(testPrisma);

describe("Multi-QR Redemption Flow E2E", () => {
  test("voucher with qrPerRedemption=2 assigns 2 QR codes", async () => {
    // Create merchant + voucher with qrPerRedemption=2
    // QR codes are now generated on-demand by initiateRedemption — no pre-upload needed
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(
      merchant.id,
      0,  // no pre-created QR codes
      { qrPerRedemption: 2, totalStock: 2 }
    );

    // Create settings
    await fixtures.createAppSettings({ appFeePercentage: 3 });
    await fixtures.createFeeSetting({ label: "Gas Fee", amountIdr: 5000, isActive: true });

    // Create user
    const user = await fixtures.createUser();

    // Redeem
    const { initiateRedemption, confirmRedemption } = await import("@/services/redemption.js");
    const { redemption } = await initiateRedemption({
      userId: user.id,
      voucherId: voucher.id,
      idempotencyKey: crypto.randomUUID(),
      wealthPriceIdr: 850,
    });

    // Verify 2 QR codes were generated and assigned to this redemption
    const assignedQrs = await testPrisma.qrCode.findMany({
      where: { redemptionId: redemption.id },
    });
    expect(assignedQrs.length).toBe(2);
    expect(assignedQrs.every((qr) => qr.status === "assigned")).toBe(true);

    // Confirm via webhook
    const txHash = "0x" + "b".repeat(64);
    await testPrisma.redemption.update({
      where: { id: redemption.id },
      data: { txHash },
    });
    const confirmed = await confirmRedemption(txHash);
    expect(confirmed.status).toBe("confirmed");

    // Stock decremented by 1
    const updatedVoucher = await testPrisma.voucher.findUnique({
      where: { id: voucher.id },
    });
    expect(updatedVoucher!.remainingStock).toBe(1);
  });
});
