import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma, mockVerifyAuthToken, mockGetUser } from "../../setup.integration.js";
import { createFixtures } from "../../helpers/fixtures.js";
import { authGet, jsonPatch } from "../../helpers/request.js";
import { createTestUserToken } from "../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

const USER_EMAIL = "user1@test.com";
const USER_PRIVY = "privy-user-1";
const OTHER_EMAIL = "user2@test.com";

/** Point the mocked Privy client at a given user for requireUser. */
function mockPrivyAs(privyUserId: string, email: string) {
  mockVerifyAuthToken.mockResolvedValue({ userId: privyUserId });
  mockGetUser.mockResolvedValue({ email: { address: email } });
}

// Create a voucher + fresh AVAILABLE slot to satisfy Redemption.slotId @unique.
async function freshSlot(merchantId: string) {
  const { voucher, slots } = await fixtures.createVoucherWithQrCodes(merchantId, 1, {
    basePrice: 25000,
  });
  return { voucherId: voucher.id, slotId: slots[0].id, merchantId };
}

async function createRedemption(opts: {
  userEmail: string;
  merchantId: string;
  status?: "PENDING" | "CONFIRMED";
  idempotencyKey: string;
}) {
  const { voucherId, slotId } = await freshSlot(opts.merchantId);
  return testPrisma.redemption.create({
    data: {
      userEmail: opts.userEmail,
      voucherId,
      merchantId: opts.merchantId,
      slotId,
      wealthAmount: "100",
      priceIdrAtRedeem: 25000,
      wealthPriceIdrAtRedeem: "250",
      appFeeAmount: "3",
      gasFeeAmount: "20",
      idempotencyKey: opts.idempotencyKey,
      status: opts.status ?? "PENDING",
    },
  });
}

describe("GET /api/redemptions", () => {
  let userToken: string;
  let merchantId: string;

  beforeEach(async () => {
    mockPrivyAs(USER_PRIVY, USER_EMAIL);
    userToken = createTestUserToken({ privyUserId: USER_PRIVY, email: USER_EMAIL });

    const merchant = await fixtures.createMerchant();
    merchantId = merchant.id;

    await createRedemption({ userEmail: USER_EMAIL, merchantId, status: "PENDING", idempotencyKey: "idm-u1-1" });
    await createRedemption({ userEmail: USER_EMAIL, merchantId, status: "CONFIRMED", idempotencyKey: "idm-u1-2" });
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
    expect(body.redemptions.every((r: { userEmail: string }) => r.userEmail === USER_EMAIL)).toBe(true);
  });

  test("does NOT return other users' redemptions", async () => {
    await createRedemption({ userEmail: OTHER_EMAIL, merchantId, status: "PENDING", idempotencyKey: "idm-u2-1" });

    const res = await authGet("/api/redemptions", userToken);
    const body = await res.json();
    expect(body.redemptions.every((r: { userEmail: string }) => r.userEmail !== OTHER_EMAIL)).toBe(true);
  });

  test("filters by status", async () => {
    const res = await authGet("/api/redemptions?status=PENDING", userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redemptions.length).toBe(1);
    expect(body.redemptions[0].status).toBe("PENDING");
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
  let merchantId: string;
  let redemption: Awaited<ReturnType<typeof testPrisma.redemption.create>>;

  beforeEach(async () => {
    mockPrivyAs(USER_PRIVY, USER_EMAIL);
    userToken = createTestUserToken({ privyUserId: USER_PRIVY, email: USER_EMAIL });

    const merchant = await fixtures.createMerchant();
    merchantId = merchant.id;
    // CONFIRMED avoids the PENDING auto-reconcile (which calls chain RPC).
    redemption = await createRedemption({ userEmail: USER_EMAIL, merchantId, status: "CONFIRMED", idempotencyKey: "idm-detail-1" });
  });

  test("returns redemption with voucher, merchant, qrCodes", async () => {
    const res = await authGet(`/api/redemptions/${redemption.id}`, userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redemption.id).toBe(redemption.id);
    expect(body.redemption.voucher).toBeDefined();
    expect(body.redemption.voucher.merchant).toBeDefined();
    expect(body.redemption.qrCodes).toBeDefined();
  });

  test("returns 404 for another user's redemption", async () => {
    const other = await createRedemption({ userEmail: OTHER_EMAIL, merchantId, status: "CONFIRMED", idempotencyKey: "idm-detail-other" });
    const res = await authGet(`/api/redemptions/${other.id}`, userToken);
    expect(res.status).toBe(404);
  });

  test("returns 404 for non-existent ID", async () => {
    const res = await authGet("/api/redemptions/nonexistent-id", userToken);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/redemptions/:id/submit-tx", () => {
  let userToken: string;
  let merchantId: string;
  let redemption: Awaited<ReturnType<typeof testPrisma.redemption.create>>;

  beforeEach(async () => {
    mockPrivyAs(USER_PRIVY, USER_EMAIL);
    userToken = createTestUserToken({ privyUserId: USER_PRIVY, email: USER_EMAIL });

    const merchant = await fixtures.createMerchant();
    merchantId = merchant.id;
    redemption = await createRedemption({ userEmail: USER_EMAIL, merchantId, status: "PENDING", idempotencyKey: "idm-tx-1" });
  });

  test("returns 401 without auth", async () => {
    const res = await jsonPatch(
      `/api/redemptions/${redemption.id}/submit-tx`,
      { txHash: "0x" + "a".repeat(64) },
      "",
    );
    expect(res.status).toBe(401);
  });

  test("sets txHash on own pending redemption", async () => {
    const txHash = "0x" + "a".repeat(64);
    const res = await jsonPatch(`/api/redemptions/${redemption.id}/submit-tx`, { txHash }, userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redemption.txHash).toBe(txHash);
  });

  test("returns 404 for another user's redemption", async () => {
    const other = await createRedemption({ userEmail: OTHER_EMAIL, merchantId, status: "PENDING", idempotencyKey: "idm-tx-other" });
    const res = await jsonPatch(
      `/api/redemptions/${other.id}/submit-tx`,
      { txHash: "0x" + "b".repeat(64) },
      userToken,
    );
    expect(res.status).toBe(404);
  });

  test("returns 400 if redemption is not pending", async () => {
    await testPrisma.redemption.update({
      where: { id: redemption.id },
      data: { status: "CONFIRMED" },
    });

    const res = await jsonPatch(
      `/api/redemptions/${redemption.id}/submit-tx`,
      { txHash: "0x" + "c".repeat(64) },
      userToken,
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 if txHash already used", async () => {
    const txHash = "0x" + "d".repeat(64);
    await jsonPatch(`/api/redemptions/${redemption.id}/submit-tx`, { txHash }, userToken);

    const redemption2 = await createRedemption({ userEmail: USER_EMAIL, merchantId, status: "PENDING", idempotencyKey: "idm-tx-2" });
    const res = await jsonPatch(`/api/redemptions/${redemption2.id}/submit-tx`, { txHash }, userToken);
    expect(res.status).toBe(400);
  });

  test("validates txHash format", async () => {
    const res = await jsonPatch(
      `/api/redemptions/${redemption.id}/submit-tx`,
      { txHash: "invalid-hash" },
      userToken,
    );
    expect(res.status).toBe(400);
  });
});
