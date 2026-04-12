import { describe, test, expect } from "vitest";
import { testPrisma } from "../setup.integration.js";
import { createFixtures } from "../helpers/fixtures.js";
import { jsonPost, jsonPatch, authGet } from "../helpers/request.js";
import { createTestAdminToken, createTestOwnerToken } from "../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

describe("Full Redemption Flow E2E", () => {
  test("complete flow: create merchant → voucher → QR → redeem → confirm → mark used", async () => {
    // Create actual admin records in DB first
    const owner = await fixtures.createAdmin({ role: "owner", email: "owner@test.com" });
    const admin = await fixtures.createAdmin({ role: "admin", email: "admin@test.com" });

    const ownerToken = await createTestOwnerToken({ id: owner.id, email: owner.email });
    const adminToken = await createTestAdminToken({ id: admin.id, email: admin.email });

    // 1. Create merchant
    const merchantRes = await jsonPost("/api/admin/merchants", {
      name: "E2E Merchant",
      category: "kuliner",
    }, adminToken);
    expect(merchantRes.status).toBe(201);
    const { merchant } = await merchantRes.json();

    // 2. Create voucher
    const voucherRes = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "E2E Voucher",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      totalStock: 5,
      priceIdr: 25000,
      qrPerRedemption: 1,
    }, adminToken);
    expect(voucherRes.status).toBe(201);
    const { voucher } = await voucherRes.json();

    // 3. Upload QR codes
    for (let i = 0; i < 5; i++) {
      const qrRes = await jsonPost("/api/admin/qr-codes", {
        voucherId: voucher.id,
        imageUrl: `https://example.com/e2e-qr-${i}.png`,
        imageHash: `e2e-hash-${Date.now()}-${i}`,
      }, adminToken);
      expect(qrRes.status).toBe(201);
    }

    // 4. Activate gas fee
    const feeRes = await jsonPost("/api/admin/fee-settings", {
      label: "E2E Gas Fee",
      amountIdr: 5000,
    }, adminToken);
    const { feeSetting } = await feeRes.json();
    await jsonPost(`/api/admin/fee-settings/${feeSetting.id}/activate`, {}, ownerToken);

    // 5. Create settings
    await jsonPost("/api/admin/settings", {}, ownerToken);

    // 6. Create user directly for testing
    const user = await fixtures.createUser({ email: "e2e-user@test.com" });

    // 7. Initiate redemption (using service directly since Privy auth is mocked)
    const { initiateRedemption } = await import("@/services/redemption.js");
    const { redemption } = await initiateRedemption({
      userId: user.id,
      voucherId: voucher.id,
      idempotencyKey: crypto.randomUUID(),
      wealthPriceIdr: 850,
    });
    expect(redemption.status).toBe("pending");

    // 8. Submit txHash
    const txHash = "0x" + "a".repeat(64);
    await testPrisma.redemption.update({
      where: { id: redemption.id },
      data: { txHash },
    });

    // 9. Confirm via service (simulating webhook)
    const { confirmRedemption } = await import("@/services/redemption.js");
    const confirmed = await confirmRedemption(txHash);
    expect(confirmed.status).toBe("confirmed");

    // 10. Verify voucher stock decremented
    const updatedVoucher = await testPrisma.voucher.findUnique({
      where: { id: voucher.id },
    });
    expect(updatedVoucher!.remainingStock).toBe(4);

    // 11. Verify QR codes assigned
    const qrCodes = await testPrisma.qrCode.findMany({
      where: { redemptionId: redemption.id },
    });
    expect(qrCodes.length).toBe(1);
    expect(qrCodes[0].status).toBe("assigned");

    // 12. Mark QR as used
    const markRes = await jsonPost(
      `/api/admin/qr-codes/${qrCodes[0].id}/mark-used`,
      {},
      adminToken
    );
    expect(markRes.status).toBe(200);
    const markBody = await markRes.json();
    expect(markBody.qrCode.status).toBe("used");

    // 13. Verify transaction created
    const transaction = await testPrisma.transaction.findFirst({
      where: { redemptionId: redemption.id },
    });
    expect(transaction).toBeDefined();
    expect(transaction!.status).toBe("confirmed");
  });
});
