import { describe, test, expect, vi } from "vitest";
import { testPrisma } from "../setup.integration.js";
import { createFixtures } from "../helpers/fixtures.js";
import { jsonPost } from "../helpers/request.js";
import { createTestAdminToken } from "../helpers/admin-session.js";

// Mock the redemption service's network-bound deps (CMC price + R2 QR upload)
// so the full flow is deterministic and offline.
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

describe("Full Redemption Flow E2E", () => {
  test("merchant → voucher+QRs → redeem → confirm → mark used", async () => {
    await fixtures.createAppSettings({ appFeeRate: 3, gasFeeAmount: 5000 });

    // 1. Merchant + voucher with 5 single-QR slots.
    const merchant = await fixtures.createMerchant();
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 5, {
      totalStock: 5,
    });

    // QR scanning (POST /scan) requires an ADMIN-role staff scoped to the
    // merchant — see requireAdminRole + merchant-ownership check.
    const scopedAdmin = await fixtures.createAdmin({
      role: "admin",
      merchantId: merchant.id,
    });
    const adminToken = await createTestAdminToken({
      id: scopedAdmin.id,
      email: scopedAdmin.email,
      role: "admin",
      merchantId: merchant.id,
    });

    // 2. App user (denormalized email, no User row).
    const user = fixtures.createUser({ email: "e2e-user@test.com" });

    // 3. Initiate redemption via the service (real signature: userEmail).
    const { initiateRedemption, confirmRedemption } = await import(
      "@/services/redemption.js"
    );
    const { redemption } = await initiateRedemption({
      userEmail: user.email,
      voucherId: voucher.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(redemption.status).toBe("PENDING");

    // 4. Submit txHash, then confirm (simulating the chain webhook).
    const txHash = "0x" + "a".repeat(64);
    await testPrisma.redemption.update({
      where: { id: redemption.id },
      data: { txHash },
    });
    const confirmed = await confirmRedemption(txHash);
    expect(confirmed.status).toBe("CONFIRMED");

    // 5. Stock recalculated from remaining AVAILABLE slots (5 - 1 = 4).
    const updatedVoucher = await testPrisma.voucher.findUnique({
      where: { id: voucher.id },
    });
    expect(updatedVoucher!.remainingStock).toBe(4);

    // 6. One QR code is assigned to the redemption with status REDEEMED.
    const qrCodes = await testPrisma.qrCode.findMany({
      where: { redemptionId: redemption.id },
    });
    expect(qrCodes.length).toBe(1);
    expect(qrCodes[0].status).toBe("REDEEMED");

    // 7. Mark the QR used via the scan endpoint.
    const markRes = await jsonPost(
      "/api/admin/qr-codes/scan",
      { token: qrCodes[0].token },
      adminToken,
    );
    expect(markRes.status).toBe(200);
    const markBody = await markRes.json();
    expect(markBody.success).toBe(true);

    // 8. QR is now USED.
    const usedQr = await testPrisma.qrCode.findUnique({
      where: { id: qrCodes[0].id },
    });
    expect(usedQr!.status).toBe("USED");
  });
});
