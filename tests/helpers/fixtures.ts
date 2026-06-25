import { PrismaClient, type AdminRole, type MerchantCategory } from "@prisma/client";
import bcryptjs from "bcryptjs";

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeRole(role?: string): AdminRole {
  switch ((role ?? "admin").toUpperCase()) {
    case "OWNER":
      return "OWNER";
    case "MANAGER":
      return "MANAGER";
    case "ADMIN":
    default:
      return "ADMIN";
  }
}

const VALID_CATEGORIES = new Set<MerchantCategory>([
  "kuliner",
  "hiburan",
  "event",
  "kesehatan",
  "lifestyle",
  "lainnya",
]);

function normalizeCategory(value?: string): MerchantCategory {
  if (!value) return "kuliner";
  return VALID_CATEGORIES.has(value as MerchantCategory)
    ? (value as MerchantCategory)
    : "lainnya";
}

export function createFixtures(prisma: PrismaClient) {
  return {
    /**
     * Create a User (+ optional credential Account) + Admin.
     * Returns the Admin row augmented with `email` and `userId` so callers can
     * use `.id` (Admin.id), `.email`, and `.userId`.
     */
    async createAdmin(overrides?: Partial<{
      email: string;
      password: string | null;
      role: "admin" | "owner" | "manager" | "ADMIN" | "OWNER" | "MANAGER";
      isActive: boolean;
      merchantId: string;
    }>) {
      const email = overrides?.email ?? `admin-${uniqueSuffix()}@test.com`;
      const password = overrides?.password;

      const user = await prisma.user.create({
        data: {
          name: "Test Admin",
          email,
          emailVerified: true,
        },
      });

      if (password !== null) {
        const passwordHash = await bcryptjs.hash(password ?? "test-password-123", 10);
        await prisma.account.create({
          data: {
            accountId: user.id,
            providerId: "credential",
            userId: user.id,
            password: passwordHash,
          },
        });
      }

      const admin = await prisma.admin.create({
        data: {
          userId: user.id,
          role: normalizeRole(overrides?.role),
          isActive: overrides?.isActive ?? true,
          merchantId: overrides?.merchantId,
        },
      });

      return { ...admin, email, userId: user.id };
    },

    /**
     * The app user is authenticated via the mocked Privy client and
     * Redemption.userEmail is just a denormalized string (no FK, no User row).
     * Return a plain object for tests to feed into mockVerifyAuthToken /
     * mockGetUser. Does NOT touch the DB.
     */
    createUser(overrides?: Partial<{
      email: string;
      privyUserId: string;
      walletAddress: string;
    }>) {
      const uid = uniqueSuffix();
      return {
        email: overrides?.email ?? `user-${uid}@test.com`,
        privyUserId: overrides?.privyUserId ?? `privy-${uid}`,
        walletAddress: overrides?.walletAddress ?? `0x${randomHex(40)}`,
      };
    },

    async createMerchant(
      _adminId?: string, // kept for signature compat — unused (no createdBy column)
      overrides?: Partial<{
        name: string;
        category: string;
        categoryName: string;
        isActive: boolean;
        description: string;
        logoUrl: string;
      }>,
    ) {
      const category = normalizeCategory(overrides?.category ?? overrides?.categoryName);
      return prisma.merchant.create({
        data: {
          name: overrides?.name ?? `Test Merchant ${uniqueSuffix()}`,
          category,
          isActive: overrides?.isActive ?? true,
          description: overrides?.description,
          logoUrl: overrides?.logoUrl,
        },
      });
    },

    async createVoucherWithQrCodes(
      merchantId: string,
      qrCount: number = 5,
      overrides?: Partial<{
        title: string;
        basePrice: number;
        totalStock: number;
        qrPerSlot: number;
        appFeeSnapshot: number;
        gasFeeSnapshot: number;
        isActive: boolean;
        startDate: Date;
        expiryDate: Date;
        format: "QR" | "CODE" | "BARCODE";
        assetSource: "WEALTH_GENERATED" | "MERCHANT_UPLOADED";
        barcodeSymbology: string;
        values: string[];
      }>,
    ) {
      const stock = overrides?.totalStock ?? qrCount;
      const qrPerSlot = overrides?.qrPerSlot ?? 1;
      const basePrice = overrides?.basePrice ?? 25000;
      const appFeeSnapshot = overrides?.appFeeSnapshot ?? 3;
      const gasFeeSnapshot = overrides?.gasFeeSnapshot ?? 500;
      const format = overrides?.format ?? "QR";
      const assetSource = overrides?.assetSource ?? "WEALTH_GENERATED";
      const values = overrides?.values;

      const voucher = await prisma.voucher.create({
        data: {
          merchantId,
          title: overrides?.title ?? `Test Voucher ${uniqueSuffix()}`,
          startDate: overrides?.startDate ?? new Date("2026-01-01"),
          expiryDate: overrides?.expiryDate ?? new Date("2026-12-31"),
          totalStock: stock,
          remainingStock: stock,
          basePrice,
          appFeeSnapshot,
          gasFeeSnapshot,
          qrPerSlot,
          format,
          assetSource,
          barcodeSymbology: overrides?.barcodeSymbology ?? null,
          isActive: overrides?.isActive ?? true,
        },
      });

      const slots = await Promise.all(
        Array.from({ length: stock }, (_, i) =>
          prisma.redemptionSlot.create({
            data: {
              voucherId: voucher.id,
              slotIndex: i + 1,
              status: "AVAILABLE",
            },
          }),
        ),
      );

      const qrCodes = [];
      for (const slot of slots) {
        for (let qrNum = 1; qrNum <= qrPerSlot; qrNum++) {
          const uid = uniqueSuffix();
          // CSV row order: slot N, qr M → values[(N-1) * qrPerSlot + (M-1)].
          const value = values
            ? (values[(slot.slotIndex - 1) * qrPerSlot + (qrNum - 1)] ?? null)
            : null;
          const qr = await prisma.qrCode.create({
            data: {
              voucherId: voucher.id,
              slotId: slot.id,
              qrNumber: qrNum,
              token: `tok-${voucher.id}-${slot.slotIndex}-${qrNum}-${uid}`,
              value,
              imageUrl: `https://example.com/qr-${voucher.id}-${slot.slotIndex}-${qrNum}.png`,
              imageHash: `hash-${voucher.id}-${slot.slotIndex}-${qrNum}-${uid}`,
              status: "AVAILABLE",
            },
          });
          qrCodes.push(qr);
        }
      }

      return { voucher, qrCodes, slots };
    },

    async createAppSettings(overrides?: Partial<{
      appFeeRate: number;
      gasFeeAmount: number;
    }>) {
      return prisma.appSettings.upsert({
        where: { id: "singleton" },
        update: {
          ...(overrides?.appFeeRate !== undefined && { appFeeRate: overrides.appFeeRate }),
          ...(overrides?.gasFeeAmount !== undefined && { gasFeeAmount: overrides.gasFeeAmount }),
        },
        create: {
          id: "singleton",
          appFeeRate: overrides?.appFeeRate ?? 3,
          gasFeeAmount: overrides?.gasFeeAmount ?? 0,
        },
      });
    },

    async cleanDatabase() {
      // FK-safe order: children first.
      await prisma.redemption.deleteMany();
      await prisma.qrCode.deleteMany();
      await prisma.redemptionSlot.deleteMany();
      await prisma.voucher.deleteMany();
      await prisma.merchant.deleteMany();
      await prisma.session.deleteMany();
      await prisma.account.deleteMany();
      await prisma.passwordSetupToken.deleteMany();
      await prisma.admin.deleteMany();
      await prisma.user.deleteMany();
      await prisma.appSettings.deleteMany();
    },
  };
}

function randomHex(len: number) {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}
