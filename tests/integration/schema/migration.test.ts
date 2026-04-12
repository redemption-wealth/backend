import { describe, test, expect } from "vitest";
import { testPrisma } from "../../setup.integration.js";

// Helper to create merchant with category
async function createMerchantWithCategory(adminId: string) {
  const category = await testPrisma.category.upsert({
    where: { name: "kuliner" },
    update: {},
    create: { name: "kuliner", isActive: true },
  });

  return testPrisma.merchant.create({
    data: {
      name: `Test-${Date.now()}`,
      categoryId: category.id,
      createdBy: adminId,
    },
  });
}

describe("Schema Migration - Phase 2 Changes", () => {
  // --- Admin: nullable passwordHash ---
  test("Admin can be created with passwordHash = null (first-login flow)", async () => {
    const admin = await testPrisma.admin.create({
      data: {
        email: "first-login@test.com",
        passwordHash: null,
        role: "admin",
      },
    });
    expect(admin.passwordHash).toBeNull();
    expect(admin.email).toBe("first-login@test.com");
  });

  test("Admin can be created with a passwordHash (normal flow)", async () => {
    const admin = await testPrisma.admin.create({
      data: {
        email: "normal@test.com",
        passwordHash: "$2a$10$hashedpassword",
        role: "admin",
      },
    });
    expect(admin.passwordHash).toBe("$2a$10$hashedpassword");
  });

  // --- Voucher: qrPerRedemption ---
  test("Voucher has qrPerRedemption field with default 1", async () => {
    const admin = await testPrisma.admin.create({
      data: { email: "admin@test.com", passwordHash: "hash", role: "admin" },
    });
    const merchant = await createMerchantWithCategory(admin.id);
    const voucher = await testPrisma.voucher.create({
      data: {
        merchantId: merchant.id,
        title: "Test Voucher",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        totalStock: 10,
        remainingStock: 10,
        priceIdr: 25000,
        // qrPerRedemption not specified — should default to 1
      },
    });
    expect(voucher.qrPerRedemption).toBe(1);
  });

  test("Voucher can be created with qrPerRedemption = 2", async () => {
    const admin = await testPrisma.admin.create({
      data: { email: "admin2@test.com", passwordHash: "hash", role: "admin" },
    });
    const merchant = await createMerchantWithCategory(admin.id);
    const voucher = await testPrisma.voucher.create({
      data: {
        merchantId: merchant.id,
        title: "Multi-QR Voucher",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        totalStock: 10,
        remainingStock: 10,
        priceIdr: 50000,
        qrPerRedemption: 2,
      },
    });
    expect(voucher.qrPerRedemption).toBe(2);
  });

  // --- QrCode: redemptionId FK (replaces 1:1) ---
  test("QrCode has redemptionId nullable FK", async () => {
    const admin = await testPrisma.admin.create({
      data: { email: "admin3@test.com", passwordHash: "hash", role: "admin" },
    });
    const merchant = await createMerchantWithCategory(admin.id);
    const voucher = await testPrisma.voucher.create({
      data: {
        merchantId: merchant.id,
        title: "V",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        totalStock: 10,
        remainingStock: 10,
        priceIdr: 10000,
      },
    });
    const qr = await testPrisma.qrCode.create({
      data: {
        voucherId: voucher.id,
        imageUrl: "https://example.com/qr.png",
        imageHash: "hash-unique-1",
        // redemptionId not set — should be null
      },
    });
    expect(qr.redemptionId).toBeNull();
  });

  // --- Redemption: one-to-many QrCodes, appFeeAmount, gasFeeAmount ---
  test("Redemption has appFeeAmount and gasFeeAmount fields", async () => {
    const user = await testPrisma.user.create({
      data: { email: "user@test.com", privyUserId: "privy-1" },
    });
    const admin = await testPrisma.admin.create({
      data: { email: "admin4@test.com", passwordHash: "hash", role: "admin" },
    });
    const merchant = await createMerchantWithCategory(admin.id);
    const voucher = await testPrisma.voucher.create({
      data: {
        merchantId: merchant.id,
        title: "V",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        totalStock: 10,
        remainingStock: 10,
        priceIdr: 25000,
      },
    });
    const redemption = await testPrisma.redemption.create({
      data: {
        userId: user.id,
        voucherId: voucher.id,
        wealthAmount: 30.5,
        priceIdrAtRedeem: 25000,
        wealthPriceIdrAtRedeem: 850,
        appFeeAmount: 0.915,
        gasFeeAmount: 5.882,
        idempotencyKey: "idem-1",
        status: "pending",
      },
    });
    expect(redemption.appFeeAmount.toString()).toBeTruthy();
    expect(redemption.gasFeeAmount.toString()).toBeTruthy();
  });

  test("Redemption can have multiple QrCodes (one-to-many)", async () => {
    const user = await testPrisma.user.create({
      data: { email: "user2@test.com", privyUserId: "privy-2" },
    });
    const admin = await testPrisma.admin.create({
      data: { email: "admin5@test.com", passwordHash: "hash", role: "admin" },
    });
    const merchant = await createMerchantWithCategory(admin.id);
    const voucher = await testPrisma.voucher.create({
      data: {
        merchantId: merchant.id,
        title: "V2",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        totalStock: 10,
        remainingStock: 10,
        priceIdr: 50000,
        qrPerRedemption: 2,
      },
    });
    const redemption = await testPrisma.redemption.create({
      data: {
        userId: user.id,
        voucherId: voucher.id,
        wealthAmount: 60,
        priceIdrAtRedeem: 50000,
        wealthPriceIdrAtRedeem: 850,
        appFeeAmount: 1.8,
        gasFeeAmount: 5.882,
        idempotencyKey: "idem-2",
        status: "pending",
      },
    });

    // Assign 2 QR codes to same redemption
    await testPrisma.qrCode.create({
      data: {
        voucherId: voucher.id,
        imageUrl: "https://example.com/qr1.png",
        imageHash: "multi-qr-hash-1",
        status: "assigned",
        assignedToUserId: user.id,
        redemptionId: redemption.id,
      },
    });
    await testPrisma.qrCode.create({
      data: {
        voucherId: voucher.id,
        imageUrl: "https://example.com/qr2.png",
        imageHash: "multi-qr-hash-2",
        status: "assigned",
        assignedToUserId: user.id,
        redemptionId: redemption.id,
      },
    });

    const result = await testPrisma.redemption.findUnique({
      where: { id: redemption.id },
      include: { qrCodes: true },
    });
    expect(result!.qrCodes).toHaveLength(2);
  });

  // --- AppSettings: appFeePercentage (renamed) ---
  test("AppSettings uses appFeePercentage field", async () => {
    const settings = await testPrisma.appSettings.create({
      data: {
        id: "singleton",
        appFeePercentage: 3,
      },
    });
    expect(settings.appFeePercentage.toString()).toBe("3");
  });

  // --- FeeSetting: new model ---
  test("FeeSetting model exists with label, amountIdr, isActive", async () => {
    const fee = await testPrisma.feeSetting.create({
      data: {
        label: "Gas Fee Standard",
        amountIdr: 5000,
        isActive: false,
      },
    });
    expect(fee.label).toBe("Gas Fee Standard");
    expect(fee.amountIdr).toBe(5000);
    expect(fee.isActive).toBe(false);
    expect(fee.id).toBeDefined();
    expect(fee.createdAt).toBeDefined();
    expect(fee.updatedAt).toBeDefined();
  });

  test("Only one FeeSetting can be active at a time (app-level constraint)", async () => {
    const fee1 = await testPrisma.feeSetting.create({
      data: { label: "Fee A", amountIdr: 3000, isActive: true },
    });
    const fee2 = await testPrisma.feeSetting.create({
      data: { label: "Fee B", amountIdr: 5000, isActive: false },
    });

    // Activate fee2 and deactivate fee1 in a transaction
    await testPrisma.$transaction([
      testPrisma.feeSetting.updateMany({ where: { isActive: true }, data: { isActive: false } }),
      testPrisma.feeSetting.update({ where: { id: fee2.id }, data: { isActive: true } }),
    ]);

    const activeFees = await testPrisma.feeSetting.findMany({ where: { isActive: true } });
    expect(activeFees).toHaveLength(1);
    expect(activeFees[0].label).toBe("Fee B");

    // Verify fee1 is now inactive
    const updatedFee1 = await testPrisma.feeSetting.findUnique({ where: { id: fee1.id } });
    expect(updatedFee1!.isActive).toBe(false);
  });
});
