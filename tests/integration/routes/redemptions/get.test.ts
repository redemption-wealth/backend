import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma, mockVerifyAuthToken } from "../../../setup.integration.js";
import { createTestScenarios } from "../../../helpers/scenarios.js";
import { authGet } from "../../../helpers/request.js";
import { mockPrivyVerification } from "../../../helpers/auth.js";

const scenarios = createTestScenarios(testPrisma);

describe("GET /api/redemptions/:id", () => {
  let userToken: string;
  let userId: string;
  let redemptionId: string;

  beforeEach(async () => {
    // Setup: User with merchant and voucher
    const { user, token, voucher } = await scenarios.redemptionReady(5);
    userToken = token;
    userId = user.id;

    // Mock Privy token verification
    mockVerifyAuthToken.mockResolvedValue(
      mockPrivyVerification(user.privyUserId, user.email)
    );

    // Create a redemption
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
      },
    });

    redemptionId = redemption.id;
  });

  test("returns redemption with voucher, merchant, qrCodes, transaction", async () => {
    const res = await authGet(`/api/redemptions/${redemptionId}`, userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redemption.id).toBe(redemptionId);
    expect(body.redemption.voucher).toBeDefined();
    expect(body.redemption.voucher.merchant).toBeDefined();
    expect(body.redemption.qrCodes).toBeDefined();
  });

  test("returns 404 for another user's redemption", async () => {
    // Create another user with their own redemption
    const { user: user2, voucher: voucher2 } = await scenarios.redemptionReady(3);

    const otherRedemption = await testPrisma.redemption.create({
      data: {
        userId: user2.id,
        voucherId: voucher2.id,
        wealthAmount: "50",
        priceIdrAtRedeem: 10000,
        wealthPriceIdrAtRedeem: "200",
        appFeeAmount: "1.5",
        gasFeeAmount: "25",
        idempotencyKey: `idm-${user2.id}-1`,
        status: "pending",
      },
    });

    const res = await authGet(`/api/redemptions/${otherRedemption.id}`, userToken);
    expect(res.status).toBe(404);
  });

  test("returns 404 for non-existent ID", async () => {
    const res = await authGet("/api/redemptions/550e8400-e29b-41d4-a716-446655440000", userToken);
    expect(res.status).toBe(404);
  });
});
