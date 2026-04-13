import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma, mockVerifyAuthToken } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { createTestScenarios } from "../../../helpers/scenarios.js";
import { authGet } from "../../../helpers/request.js";
import { mockPrivyVerification } from "../../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);
const scenarios = createTestScenarios(testPrisma);

describe("GET /api/redemptions", () => {
  let userToken: string;
  let userId: string;
  let voucherId: string;

  beforeEach(async () => {
    // Setup: User with merchant and voucher
    const { user, token, voucher } = await scenarios.redemptionReady(5);
    userToken = token;
    userId = user.id;
    voucherId = voucher.id;

    // Mock Privy token verification
    mockVerifyAuthToken.mockResolvedValue(
      mockPrivyVerification(user.privyUserId, user.email)
    );

    // Create multiple redemptions for this user
    await testPrisma.redemption.create({
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

    await testPrisma.redemption.create({
      data: {
        userId: user.id,
        voucherId: voucher.id,
        wealthAmount: "200",
        priceIdrAtRedeem: 50000,
        wealthPriceIdrAtRedeem: "250",
        appFeeAmount: "6",
        gasFeeAmount: "20",
        idempotencyKey: `idm-${user.id}-2`,
        status: "confirmed",
      },
    });
  });

  test("returns 401 without auth", async () => {
    const res = await authGet("/api/redemptions", "");
    expect(res.status).toBe(401);
  });

  test("returns only authenticated user's redemptions", async () => {
    const res = await authGet("/api/redemptions", userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redemptions.length).toBe(2);
    expect(body.redemptions.every((r: { userId: string }) => r.userId === userId)).toBe(true);
  });

  test("does NOT return other users' redemptions", async () => {
    // Create another user with their own redemption
    const { user: user2, voucher: voucher2 } = await scenarios.redemptionReady(3);

    await testPrisma.redemption.create({
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

    const res = await authGet("/api/redemptions", userToken);
    const body = await res.json();
    expect(body.redemptions.every((r: { userId: string }) => r.userId !== user2.id)).toBe(true);
  });

  test("filters by status", async () => {
    const res = await authGet("/api/redemptions?status=pending", userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redemptions.length).toBe(1);
    expect(body.redemptions[0].status).toBe("pending");
  });

  test("pagination works", async () => {
    const res = await authGet("/api/redemptions?page=1&limit=1", userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(1);
    expect(body.redemptions.length).toBe(1);
  });
});
