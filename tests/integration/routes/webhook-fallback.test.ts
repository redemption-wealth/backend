import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { testPrisma } from "../../setup.integration.js";
import app from "@/app.js";

/**
 * Hybrid fallback matching through the REAL webhook HTTP path (HMAC + Alchemy
 * payload shape) — the server-side fix for the 2026-07-16 lost-redemption
 * case: tx succeeded on-chain but the app died before submit-tx, so the
 * PENDING row has no txHash and direct confirm can't find it.
 */

const SIGNING_KEY = "test-webhook-signing-key";
const WEALTH_CONTRACT = "0x1234567890123456789012345678901234567890";
const TREASURY = "0x0987654321098765432109876543210987654321";
// 100 $WEALTH in wei, as Alchemy's rawValue hex.
const AMOUNT_RAW = "0x56bc75e2d63100000";

function rand(): string {
  return Math.random().toString(36).slice(2);
}

function randomTxHash(): string {
  return (
    "0x" +
    Array.from({ length: 64 }, () =>
      "0123456789abcdef".charAt(Math.floor(Math.random() * 16)),
    ).join("")
  );
}

function webhookPost(body: unknown) {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", SIGNING_KEY).update(raw).digest("hex");
  return app.request("/api/webhook/alchemy", {
    method: "POST",
    body: raw,
    headers: new Headers({
      "Content-Type": "application/json",
      "x-alchemy-signature": signature,
    }),
  });
}

// Alchemy Address Activity entry with the exact raw amount fields the
// fallback's precision-safe parser reads.
function tokenActivity(txHash: string, fromAddress: string) {
  return {
    hash: txHash,
    category: "token",
    fromAddress,
    toAddress: TREASURY,
    asset: "WEALTH",
    value: 100,
    rawContract: {
      address: WEALTH_CONTRACT,
      rawValue: AMOUNT_RAW,
      decimals: "0x12",
    },
  };
}

/** Seed a user + voucher + a PENDING redemption WITHOUT a txHash (the app
 * never reported the hash). */
async function seedHashlessPending(opts?: {
  wealthAmount?: string;
  email?: string;
  wallet?: string;
}) {
  const email = opts?.email ?? `user-${rand()}@test.com`;
  const wallet = opts?.wallet ?? `0x${rand().padEnd(40, "a").slice(0, 40)}`;
  await testPrisma.appUser.upsert({
    where: { privyId: `privy-${email}` },
    update: { walletAddress: wallet },
    create: {
      privyId: `privy-${email}`,
      email,
      walletAddress: wallet,
      referralCode: `ref-${rand()}`,
    },
  });
  const merchant = await testPrisma.merchant.create({
    data: { name: `Merchant ${rand()}`, category: "F&B" },
  });
  const voucher = await testPrisma.voucher.create({
    data: {
      merchantId: merchant.id,
      title: "Fallback Voucher",
      basePrice: "25000",
      totalStock: 2,
      remainingStock: 2,
      qrPerSlot: 1,
      appFeeSnapshot: "3",
      gasFeeSnapshot: "500",
      startDate: new Date("2026-01-01"),
      expiryDate: new Date("2026-12-31"),
    },
  });
  const slots = await Promise.all(
    [1, 2].map((slotIndex) =>
      testPrisma.redemptionSlot.create({
        data: { voucherId: voucher.id, slotIndex },
      }),
    ),
  );
  await testPrisma.redemptionSlot.update({
    where: { id: slots[0].id },
    data: { status: "REDEEMED" },
  });
  const redemption = await testPrisma.redemption.create({
    data: {
      userEmail: email,
      voucherId: voucher.id,
      merchantId: merchant.id,
      slotId: slots[0].id,
      wealthAmount: opts?.wealthAmount ?? "100",
      priceIdrAtRedeem: 25000,
      wealthPriceIdrAtRedeem: "250",
      appFeeAmount: "3",
      gasFeeAmount: "20",
      walletAddress: wallet,
      idempotencyKey: `idm-${rand()}`,
      status: "PENDING",
      txHash: null,
    },
  });
  return { redemption, voucher, email, wallet, slots };
}

describe("webhook hybrid fallback (unknown txHash)", () => {
  beforeEach(() => {
    vi.stubEnv("ALCHEMY_WEBHOOK_SIGNING_KEY", SIGNING_KEY);
    vi.stubEnv("WEALTH_CONTRACT_ADDRESS", WEALTH_CONTRACT);
    vi.stubEnv("DEV_WALLET_ADDRESS", TREASURY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("the 0x0b5f case: exact single candidate → auto-confirmed end-to-end", async () => {
    const { redemption, wallet, voucher } = await seedHashlessPending();
    const txHash = randomTxHash();

    const res = await webhookPost({
      event: { activity: [tokenActivity(txHash, wallet)] },
    });
    expect(res.status).toBe(200);

    const updated = await testPrisma.redemption.findUnique({
      where: { id: redemption.id },
    });
    expect(updated?.status).toBe("CONFIRMED");
    expect(updated?.txHash).toBe(txHash);
    expect(updated?.confirmedAt).not.toBeNull();

    // Not queued — it resolved automatically.
    const queued = await testPrisma.unmatchedTransfer.findUnique({
      where: { txHash },
    });
    expect(queued).toBeNull();

    // Stock reflects the consumed slot (1 of 2 left).
    const v = await testPrisma.voucher.findUnique({ where: { id: voucher.id } });
    expect(v?.remainingStock).toBe(1);
  });

  test("two same-amount candidates → queued OPEN, nothing auto-confirmed", async () => {
    const { redemption, email, wallet, voucher, slots } =
      await seedHashlessPending();
    // Second hashless PENDING for the SAME user with the SAME amount.
    await testPrisma.redemption.create({
      data: {
        userEmail: email,
        voucherId: voucher.id,
        merchantId: redemption.merchantId,
        slotId: slots[1].id,
        wealthAmount: "100",
        priceIdrAtRedeem: 25000,
        wealthPriceIdrAtRedeem: "250",
        appFeeAmount: "3",
        gasFeeAmount: "20",
        walletAddress: wallet,
        idempotencyKey: `idm-${rand()}`,
        status: "PENDING",
        txHash: null,
      },
    });
    await testPrisma.redemptionSlot.update({
      where: { id: slots[1].id },
      data: { status: "REDEEMED" },
    });

    const txHash = randomTxHash();
    const res = await webhookPost({
      event: { activity: [tokenActivity(txHash, wallet)] },
    });
    expect(res.status).toBe(200);

    const queued = await testPrisma.unmatchedTransfer.findUnique({
      where: { txHash },
    });
    expect(queued?.status).toBe("OPEN");
    expect(queued?.userEmail).toBe(email);
    expect(queued?.amount.toString()).toBe("100");

    const still = await testPrisma.redemption.findMany({
      where: { userEmail: email },
    });
    expect(still.every((r) => r.status === "PENDING" && !r.txHash)).toBe(true);
  });

  test("unknown wallet → queued OPEN with userEmail null (money never dropped)", async () => {
    const txHash = randomTxHash();
    const strangerWallet = `0x${rand().padEnd(40, "f").slice(0, 40)}`;

    const res = await webhookPost({
      event: { activity: [tokenActivity(txHash, strangerWallet)] },
    });
    expect(res.status).toBe(200);

    const queued = await testPrisma.unmatchedTransfer.findUnique({
      where: { txHash },
    });
    expect(queued?.status).toBe("OPEN");
    expect(queued?.userEmail).toBeNull();
    expect(queued?.fromAddress).toBe(strangerWallet.toLowerCase());
  });

  test("duplicate delivery of an unmatched transfer → single queue row", async () => {
    const txHash = randomTxHash();
    const strangerWallet = `0x${rand().padEnd(40, "e").slice(0, 40)}`;
    const payload = { event: { activity: [tokenActivity(txHash, strangerWallet)] } };

    await webhookPost(payload);
    const res2 = await webhookPost(payload);
    expect(res2.status).toBe(200);

    const rows = await testPrisma.unmatchedTransfer.findMany({
      where: { txHash },
    });
    expect(rows).toHaveLength(1);
  });

  test("amount mismatch with the only candidate → queued, not guessed", async () => {
    const { redemption, wallet } = await seedHashlessPending({
      wealthAmount: "55.5",
    });
    const txHash = randomTxHash();

    const res = await webhookPost({
      event: { activity: [tokenActivity(txHash, wallet)] }, // pays 100, pending is 55.5
    });
    expect(res.status).toBe(200);

    const updated = await testPrisma.redemption.findUnique({
      where: { id: redemption.id },
    });
    expect(updated?.status).toBe("PENDING");
    const queued = await testPrisma.unmatchedTransfer.findUnique({
      where: { txHash },
    });
    expect(queued?.status).toBe("OPEN");
  });
});
