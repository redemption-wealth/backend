import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { testPrisma } from "../../setup.integration.js";
import app from "@/app.js";

const SIGNING_KEY = "test-webhook-signing-key";
const WEALTH_CONTRACT = "0x1234567890123456789012345678901234567890";
const TREASURY = "0x0987654321098765432109876543210987654321";

// Send a webhook request with a valid Alchemy HMAC signature by default.
// Pass { signature: null } to omit the header, or a string to force a value.
function webhookPost(body: unknown, opts?: { signature?: string | null }) {
  const raw = JSON.stringify(body);
  const headers = new Headers({ "Content-Type": "application/json" });
  const signature =
    opts && "signature" in opts
      ? opts.signature
      : createHmac("sha256", SIGNING_KEY).update(raw).digest("hex");
  if (signature != null) headers.set("x-alchemy-signature", signature);
  return app.request("/api/webhook/alchemy", {
    method: "POST",
    body: raw,
    headers,
  });
}

// Mirrors Alchemy's Address Activity payload for an ERC20 transfer:
// category "token", a rawContract.address + toAddress, and NO typeTraceAddress
// (Alchemy only sends that field for internal transfers).
function tokenActivity(
  txHash: string,
  overrides?: { toAddress?: string; tokenAddress?: string },
) {
  return {
    hash: txHash,
    category: "token",
    fromAddress: "0x1111111111111111111111111111111111111111",
    toAddress: overrides?.toAddress ?? TREASURY,
    asset: "WEALTH",
    value: 100,
    rawContract: {
      address: overrides?.tokenAddress ?? WEALTH_CONTRACT,
      decimals: 18,
    },
  };
}

async function seedPendingRedemption(txHash: string) {
  const merchant = await testPrisma.merchant.create({
    data: { name: `Merchant ${Math.random().toString(36).slice(2)}`, category: "F&B" },
  });
  const voucher = await testPrisma.voucher.create({
    data: {
      merchantId: merchant.id,
      title: "Test Voucher",
      basePrice: "25000",
      totalStock: 3,
      remainingStock: 3,
      qrPerSlot: 1,
      appFeeSnapshot: "3",
      gasFeeSnapshot: "500",
      startDate: new Date("2026-01-01"),
      expiryDate: new Date("2026-12-31"),
    },
  });
  const slots = await Promise.all(
    [1, 2, 3].map((slotIndex) =>
      testPrisma.redemptionSlot.create({ data: { voucherId: voucher.id, slotIndex } }),
    ),
  );
  // Reserve the first slot, mirroring what the redeem flow does on creation.
  await testPrisma.redemptionSlot.update({
    where: { id: slots[0].id },
    data: { status: "REDEEMED" },
  });
  const redemption = await testPrisma.redemption.create({
    data: {
      userEmail: `user-${Math.random().toString(36).slice(2)}@test.com`,
      voucherId: voucher.id,
      merchantId: merchant.id,
      slotId: slots[0].id,
      wealthAmount: "100",
      priceIdrAtRedeem: 25000,
      wealthPriceIdrAtRedeem: "250",
      appFeeAmount: "3",
      gasFeeAmount: "20",
      idempotencyKey: `idm-${txHash}`,
      status: "PENDING",
      txHash,
    },
  });
  return { redemption, voucher };
}

describe("POST /api/webhook/alchemy", () => {
  beforeEach(() => {
    vi.stubEnv("ALCHEMY_WEBHOOK_SIGNING_KEY", SIGNING_KEY);
    vi.stubEnv("WEALTH_CONTRACT_ADDRESS", WEALTH_CONTRACT);
    vi.stubEnv("DEV_WALLET_ADDRESS", TREASURY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns 401 when signature header is missing", async () => {
    const res = await webhookPost({ event: { activity: [] } }, { signature: null });
    expect(res.status).toBe(401);
  });

  test("returns 401 when signature is invalid", async () => {
    const res = await webhookPost({ event: { activity: [] } }, { signature: "deadbeef" });
    expect(res.status).toBe(401);
  });

  test("returns 400 when event.activity is missing", async () => {
    const res = await webhookPost({ event: {} });
    expect(res.status).toBe(400);
  });

  test("confirms redemption for a $WEALTH transfer into the treasury", async () => {
    const txHash = "0x" + "b".repeat(64);
    const { redemption } = await seedPendingRedemption(txHash);

    const res = await webhookPost({ event: { activity: [tokenActivity(txHash)] } });
    expect(res.status).toBe(200);

    const updated = await testPrisma.redemption.findUnique({ where: { id: redemption.id } });
    expect(updated?.status).toBe("CONFIRMED");
    expect(updated?.confirmedAt).not.toBeNull();

    // remainingStock is recalculated from AVAILABLE slots (2 of 3 left).
    const voucher = await testPrisma.voucher.findUnique({ where: { id: redemption.voucherId } });
    expect(voucher?.remainingStock).toBe(2);
  });

  test("does NOT confirm when the transfer goes to a different address", async () => {
    const txHash = "0x" + "c".repeat(64);
    const { redemption } = await seedPendingRedemption(txHash);

    const res = await webhookPost({
      event: { activity: [tokenActivity(txHash, { toAddress: "0x" + "9".repeat(40) })] },
    });
    expect(res.status).toBe(200);

    const updated = await testPrisma.redemption.findUnique({ where: { id: redemption.id } });
    expect(updated?.status).toBe("PENDING");
  });

  test("does NOT confirm when the token contract is not $WEALTH", async () => {
    const txHash = "0x" + "d".repeat(64);
    const { redemption } = await seedPendingRedemption(txHash);

    const res = await webhookPost({
      event: { activity: [tokenActivity(txHash, { tokenAddress: "0x" + "2".repeat(40) })] },
    });
    expect(res.status).toBe(200);

    const updated = await testPrisma.redemption.findUnique({ where: { id: redemption.id } });
    expect(updated?.status).toBe("PENDING");
  });

  test("handles an unknown txHash gracefully", async () => {
    const res = await webhookPost({
      event: { activity: [tokenActivity("0x" + "e".repeat(64))] },
    });
    expect(res.status).toBe(200);
  });

  test("is idempotent across duplicate deliveries", async () => {
    const txHash = "0x" + "f".repeat(64);
    const { redemption } = await seedPendingRedemption(txHash);

    await webhookPost({ event: { activity: [tokenActivity(txHash)] } });
    const first = await testPrisma.redemption.findUnique({ where: { id: redemption.id } });

    const res2 = await webhookPost({ event: { activity: [tokenActivity(txHash)] } });
    expect(res2.status).toBe(200);

    const second = await testPrisma.redemption.findUnique({ where: { id: redemption.id } });
    expect(second?.status).toBe("CONFIRMED");
    expect(second?.confirmedAt?.getTime()).toBe(first?.confirmedAt?.getTime());
  });
});
