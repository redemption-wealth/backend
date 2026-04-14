import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma, mockVerifyAuthToken } from "../../setup.integration.js";
import { createFixtures } from "../../helpers/fixtures.js";
import { authGet, jsonPatch } from "../../helpers/request.js";
import { createTestUserToken, mockPrivyVerification } from "../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

// Helper to create a test voucher with proper schema
async function createTestVoucher(merchantId: string, qrCount: number = 5) {
  return fixtures.createVoucherWithQrCodes(merchantId, qrCount, {
    basePrice: 25000,
    expiryDate: new Date("2026-12-31"),
    qrPerSlot: 1,
  });
}

describe("GET /api/redemptions", () => {
  let userToken: string;
  let user: Awaited<ReturnType<typeof fixtures.createUser>>;

  beforeEach(async () => {
    // Create user
    user = await fixtures.createUser({
      privyUserId: "privy-user-1",
      email: "user1@test.com",
    });

    // Mock Privy token verification
    mockVerifyAuthToken.mockResolvedValue(
      mockPrivyVerification("privy-user-1", "user1@test.com")
    );

    userToken = createTestUserToken({
      privyUserId: "privy-user-1",
      email: "user1@test.com",
    });

    // Create test data
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await createTestVoucher(merchant.id, 5);

    // Create redemptions for this user
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
    expect(body.redemptions.every((r: { userId: string }) => r.userId === user.id)).toBe(true);
  });

  test("does NOT return other users' redemptions", async () => {
    // Create another user
    const user2 = await fixtures.createUser({
      privyUserId: "privy-user-2",
      email: "user2@test.com",
    });

    const admin = await fixtures.createAdmin({ email: "admin2@test.com" });
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await createTestVoucher(merchant.id, 5);

    await testPrisma.redemption.create({
      data: {
        userId: user2.id,
        voucherId: voucher.id,
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

describe("GET /api/redemptions/:id", () => {
  let userToken: string;
  let user: Awaited<ReturnType<typeof fixtures.createUser>>;
  let redemption: Awaited<ReturnType<typeof testPrisma.redemption.create>>;

  beforeEach(async () => {
    user = await fixtures.createUser({
      privyUserId: "privy-user-1",
      email: "user1@test.com",
    });

    mockVerifyAuthToken.mockResolvedValue(
      mockPrivyVerification("privy-user-1", "user1@test.com")
    );

    userToken = createTestUserToken({
      privyUserId: "privy-user-1",
      email: "user1@test.com",
    });

    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await createTestVoucher(merchant.id, 5);

    redemption = await testPrisma.redemption.create({
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
  });

  test("returns redemption with voucher, merchant, qrCodes, transaction", async () => {
    const res = await authGet(`/api/redemptions/${redemption.id}`, userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redemption.id).toBe(redemption.id);
    expect(body.redemption.voucher).toBeDefined();
    expect(body.redemption.voucher.merchant).toBeDefined();
    expect(body.redemption.qrCodes).toBeDefined();
  });

  test("returns 404 for another user's redemption", async () => {
    const user2 = await fixtures.createUser({
      privyUserId: "privy-user-2",
      email: "user2@test.com",
    });

    const admin = await fixtures.createAdmin({ email: "admin2@test.com" });
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await createTestVoucher(merchant.id, 5);

    const otherRedemption = await testPrisma.redemption.create({
      data: {
        userId: user2.id,
        voucherId: voucher.id,
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

describe("PATCH /api/redemptions/:id/submit-tx", () => {
  let userToken: string;
  let user: Awaited<ReturnType<typeof fixtures.createUser>>;
  let redemption: Awaited<ReturnType<typeof testPrisma.redemption.create>>;

  beforeEach(async () => {
    user = await fixtures.createUser({
      privyUserId: "privy-user-1",
      email: "user1@test.com",
    });

    mockVerifyAuthToken.mockResolvedValue(
      mockPrivyVerification("privy-user-1", "user1@test.com")
    );

    userToken = createTestUserToken({
      privyUserId: "privy-user-1",
      email: "user1@test.com",
    });

    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await createTestVoucher(merchant.id, 5);

    redemption = await testPrisma.redemption.create({
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
  });

  test("returns 401 without auth", async () => {
    const res = await jsonPatch(
      `/api/redemptions/${redemption.id}/submit-tx`,
      { txHash: "0x" + "a".repeat(64) },
      ""
    );
    expect(res.status).toBe(401);
  });

  test("sets txHash on own pending redemption", async () => {
    const txHash = "0x" + "a".repeat(64);
    const res = await jsonPatch(
      `/api/redemptions/${redemption.id}/submit-tx`,
      { txHash },
      userToken
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redemption.txHash).toBe(txHash);
  });

  test("returns 404 for another user's redemption", async () => {
    const user2 = await fixtures.createUser({
      privyUserId: "privy-user-2",
      email: "user2@test.com",
    });

    const admin = await fixtures.createAdmin({ email: "admin2@test.com" });
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await createTestVoucher(merchant.id, 5);

    const otherRedemption = await testPrisma.redemption.create({
      data: {
        userId: user2.id,
        voucherId: voucher.id,
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
      where: { id: redemption.id },
      data: { status: "confirmed" },
    });

    const res = await jsonPatch(
      `/api/redemptions/${redemption.id}/submit-tx`,
      { txHash: "0x" + "c".repeat(64) },
      userToken
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 if txHash already used", async () => {
    const txHash = "0x" + "d".repeat(64);

    // First submission
    await jsonPatch(`/api/redemptions/${redemption.id}/submit-tx`, { txHash }, userToken);

    // Create another pending redemption
    const admin = await fixtures.createAdmin({ email: "admin3@test.com" });
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await createTestVoucher(merchant.id, 5);

    const redemption2 = await testPrisma.redemption.create({
      data: {
        userId: user.id,
        voucherId: voucher.id,
        wealthAmount: "100",
        priceIdrAtRedeem: 25000,
        wealthPriceIdrAtRedeem: "250",
        appFeeAmount: "3",
        gasFeeAmount: "20",
        idempotencyKey: `idm-${user.id}-2`,
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
      `/api/redemptions/${redemption.id}/submit-tx`,
      { txHash: "invalid-hash" },
      userToken
    );
    expect(res.status).toBe(400);
  });
});
