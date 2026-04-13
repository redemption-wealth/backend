import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createTestScenarios } from "../../../helpers/scenarios.js";
import { jsonPatch } from "../../../helpers/request.js";

const scenarios = createTestScenarios(testPrisma);

describe("PATCH /api/redemptions/:id/submit-tx", () => {
  let userToken: string;
  let userId: string;
  let redemptionId: string;

  beforeEach(async () => {
    // Setup: User with merchant and voucher
    const { user, token, voucher } = await scenarios.redemptionReady(5);
    userToken = token;
    userId = user.id;

    // Create a pending redemption
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

  test("returns 401 without auth", async () => {
    const res = await jsonPatch(
      `/api/redemptions/${redemptionId}/submit-tx`,
      { txHash: "0x" + "a".repeat(64) },
      ""
    );
    expect(res.status).toBe(401);
  });

  test("sets txHash on own pending redemption", async () => {
    const txHash = "0x" + "a".repeat(64);
    const res = await jsonPatch(
      `/api/redemptions/${redemptionId}/submit-tx`,
      { txHash },
      userToken
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redemption.txHash).toBe(txHash);
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

    const res = await jsonPatch(
      `/api/redemptions/${otherRedemption.id}/submit-tx`,
      { txHash: "0x" + "b".repeat(64) },
      userToken
    );
    expect(res.status).toBe(404);
  });

  test("returns 400 if redemption is not pending", async () => {
    await testPrisma.redemption.update({
      where: { id: redemptionId },
      data: { status: "confirmed" },
    });

    const res = await jsonPatch(
      `/api/redemptions/${redemptionId}/submit-tx`,
      { txHash: "0x" + "c".repeat(64) },
      userToken
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 if txHash already used", async () => {
    const txHash = "0x" + "d".repeat(64);

    // First submission
    await jsonPatch(`/api/redemptions/${redemptionId}/submit-tx`, { txHash }, userToken);

    // Create another pending redemption for same user
    const { voucher } = await scenarios.redemptionReady(5);

    const redemption2 = await testPrisma.redemption.create({
      data: {
        userId,
        voucherId: voucher.id,
        wealthAmount: "100",
        priceIdrAtRedeem: 25000,
        wealthPriceIdrAtRedeem: "250",
        appFeeAmount: "3",
        gasFeeAmount: "20",
        idempotencyKey: `idm-${userId}-2`,
        status: "pending",
      },
    });

    // Try to use same txHash
    const res = await jsonPatch(
      `/api/redemptions/${redemption2.id}/submit-tx`,
      { txHash },
      userToken
    );
    expect(res.status).toBe(400);
  });

  test("validates txHash format", async () => {
    const res = await jsonPatch(
      `/api/redemptions/${redemptionId}/submit-tx`,
      { txHash: "invalid-hash" },
      userToken
    );
    expect(res.status).toBe(400);
  });
});
