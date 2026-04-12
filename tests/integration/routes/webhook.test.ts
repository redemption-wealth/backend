import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { createFixtures } from "../../helpers/fixtures.js";
import app from "@/app.js";

const fixtures = createFixtures(testPrisma);

// Helper to send webhook request with signature
function webhookPost(body: unknown) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-alchemy-signature": "mock-signature",
  });
  return app.request("/api/webhook/alchemy", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}

describe("POST /api/webhook/alchemy", () => {
  let appSettings: Awaited<ReturnType<typeof testPrisma.appSettings.create>>;

  beforeEach(async () => {
    appSettings = await testPrisma.appSettings.create({
      data: {
        appFeePercentage: "3",
        tokenContractAddress: "0x1234567890123456789012345678901234567890",
        treasuryWalletAddress: "0x0987654321098765432109876543210987654321",
      },
    });
  });

  test("returns 401 without signature header", async () => {
    const res = await app.request("/api/webhook/alchemy", {
      method: "POST",
      body: JSON.stringify({
        event: {
          activity: [
            {
              hash: "0x" + "a".repeat(64),
              category: "token",
              typeTraceAddress: "CALL",
            },
          ],
        },
      }),
      headers: new Headers({ "Content-Type": "application/json" }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 for missing event.activity", async () => {
    const res = await webhookPost({ event: {} });
    expect(res.status).toBe(400);
  });

  test("confirms redemption for valid token transfer", async () => {
    // Create test data
    const user = await fixtures.createUser();
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher, qrCodes } = await fixtures.createVoucherWithQrCodes(merchant.id, 5);

    const txHash = "0x" + "b".repeat(64);

    // Create pending redemption with txHash
    const redemption = await testPrisma.redemption.create({
      data: {
        userId: user.id,
        voucherId: voucher.id,
        wealthAmount: "100",
        priceIdrAtRedeem: 25000,
        wealthPriceIdrAtRedeem: "250",
        appFeeAmount: "3",
        gasFeeAmount: "20",
        idempotencyKey: `idm-${user.id}-1`,
        status: "pending",
        txHash,
      },
    });

    // Assign QR codes
    await testPrisma.qrCode.update({
      where: { id: qrCodes[0].id },
      data: { redemptionId: redemption.id, status: "assigned" },
    });

    // Simulate Alchemy webhook
    const payload = {
      event: {
        activity: [
          {
            hash: txHash,
            category: "token",
            typeTraceAddress: "CALL",
            asset: appSettings.tokenContractAddress,
          },
        ],
      },
    };

    // Note: Signature verification is TODO in webhook.ts, so we just send with header
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set("x-alchemy-signature", "mock-signature");

    const res = await webhookPost(payload);

    expect(res.status).toBe(200);

    // Verify redemption was confirmed
    const updated = await testPrisma.redemption.findUnique({
      where: { id: redemption.id },
    });
    expect(updated?.status).toBe("confirmed");
    expect(updated?.confirmedAt).toBeDefined();

    // Verify stock was decremented
    const updatedVoucher = await testPrisma.voucher.findUnique({
      where: { id: voucher.id },
    });
    expect(updatedVoucher?.remainingStock).toBe(voucher.remainingStock - 1);

    // Verify transaction was created
    const transaction = await testPrisma.transaction.findFirst({
      where: { redemptionId: redemption.id },
    });
    expect(transaction).toBeDefined();
    expect(transaction?.status).toBe("confirmed");
  });

  test("handles unknown txHash gracefully", async () => {
    const payload = {
      event: {
        activity: [
          {
            hash: "0x" + "c".repeat(64), // Unknown txHash
            category: "token",
            typeTraceAddress: "CALL",
          },
        ],
      },
    };

    const res = await webhookPost(payload);

    // Should not crash
    expect(res.status).toBe(200);
  });

  test("handles multiple activities in one payload", async () => {
    const user = await fixtures.createUser();
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher, qrCodes } = await fixtures.createVoucherWithQrCodes(merchant.id, 5);

    const txHash1 = "0x" + "d".repeat(64);
    const txHash2 = "0x" + "e".repeat(64);

    // Create two pending redemptions
    const redemption1 = await testPrisma.redemption.create({
      data: {
        userId: user.id,
        voucherId: voucher.id,
        wealthAmount: "100",
        priceIdrAtRedeem: 25000,
        wealthPriceIdrAtRedeem: "250",
        appFeeAmount: "3",
        gasFeeAmount: "20",
        idempotencyKey: `idm-${user.id}-1`,
        status: "pending",
        txHash: txHash1,
      },
    });

    const redemption2 = await testPrisma.redemption.create({
      data: {
        userId: user.id,
        voucherId: voucher.id,
        wealthAmount: "200",
        priceIdrAtRedeem: 50000,
        wealthPriceIdrAtRedeem: "250",
        appFeeAmount: "6",
        gasFeeAmount: "20",
        idempotencyKey: `idm-${user.id}-2`,
        status: "pending",
        txHash: txHash2,
      },
    });

    await testPrisma.qrCode.update({
      where: { id: qrCodes[0].id },
      data: { redemptionId: redemption1.id, status: "assigned" },
    });

    await testPrisma.qrCode.update({
      where: { id: qrCodes[1].id },
      data: { redemptionId: redemption2.id, status: "assigned" },
    });

    const payload = {
      event: {
        activity: [
          {
            hash: txHash1,
            category: "token",
            typeTraceAddress: "CALL",
          },
          {
            hash: txHash2,
            category: "token",
            typeTraceAddress: "CALL",
          },
        ],
      },
    };

    const res = await webhookPost(payload);

    expect(res.status).toBe(200);

    // Verify both were confirmed
    const updated1 = await testPrisma.redemption.findUnique({
      where: { id: redemption1.id },
    });
    const updated2 = await testPrisma.redemption.findUnique({
      where: { id: redemption2.id },
    });

    expect(updated1?.status).toBe("confirmed");
    expect(updated2?.status).toBe("confirmed");
  });

  test("idempotent: duplicate webhook doesn't create duplicate transaction", async () => {
    const user = await fixtures.createUser();
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher, qrCodes } = await fixtures.createVoucherWithQrCodes(merchant.id, 5);

    const txHash = "0x" + "f".repeat(64);

    const redemption = await testPrisma.redemption.create({
      data: {
        userId: user.id,
        voucherId: voucher.id,
        wealthAmount: "100",
        priceIdrAtRedeem: 25000,
        wealthPriceIdrAtRedeem: "250",
        appFeeAmount: "3",
        gasFeeAmount: "20",
        idempotencyKey: `idm-${user.id}-1`,
        status: "pending",
        txHash,
      },
    });

    await testPrisma.qrCode.update({
      where: { id: qrCodes[0].id },
      data: { redemptionId: redemption.id, status: "assigned" },
    });

    const payload = {
      event: {
        activity: [
          {
            hash: txHash,
            category: "token",
            typeTraceAddress: "CALL",
          },
        ],
      },
    };

    // Send webhook twice
    await webhookPost(payload);
    await webhookPost(payload);

    // Should only have one transaction
    const transactions = await testPrisma.transaction.findMany({
      where: { redemptionId: redemption.id },
    });

    expect(transactions.length).toBe(1);
  });
});
