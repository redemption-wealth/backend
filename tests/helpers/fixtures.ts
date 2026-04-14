import { PrismaClient } from "@prisma/client";
import bcryptjs from "bcryptjs";

export function createFixtures(prisma: PrismaClient) {
  return {
    async createAdmin(overrides?: Partial<{
      email: string;
      password: string | null;
      role: "admin" | "owner" | "manager";
      isActive: boolean;
      merchantId: string;
    }>) {
      const password = overrides?.password;
      const passwordHash = password === null
        ? null
        : await bcryptjs.hash(password ?? "test-password-123", 10);
      return prisma.admin.create({
        data: {
          email: overrides?.email ?? `admin-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
          passwordHash,
          role: overrides?.role ?? "admin",
          isActive: overrides?.isActive ?? true,
          merchantId: overrides?.merchantId,
        },
      });
    },

    async createUser(overrides?: Partial<{
      email: string;
      privyUserId: string;
      walletAddress: string;
    }>) {
      const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return prisma.user.create({
        data: {
          email: overrides?.email ?? `user-${uid}@test.com`,
          privyUserId: overrides?.privyUserId ?? `privy-${uid}`,
          walletAddress: overrides?.walletAddress,
        },
      });
    },

    async createMerchant(adminId?: string, overrides?: Partial<{
      name: string;
      categoryName: string;
      isActive: boolean;
      description: string;
      logoUrl: string;
    }>) {
      // Get or create category
      const categoryName = overrides?.categoryName ?? "kuliner";
      const category = await prisma.category.upsert({
        where: { name: categoryName },
        update: {},
        create: { name: categoryName, isActive: true },
      });

      return prisma.merchant.create({
        data: {
          name: overrides?.name ?? `Test Merchant ${Date.now()}`,
          categoryId: category.id,
          isActive: overrides?.isActive ?? true,
          description: overrides?.description,
          logoUrl: overrides?.logoUrl,
          createdBy: adminId,
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
        isActive: boolean;
        startDate: Date;
        expiryDate: Date;
        createdBy: string;
      }>
    ) {
      const stock = overrides?.totalStock ?? qrCount;
      const qrPerSlot = overrides?.qrPerSlot ?? 1;
      const basePrice = overrides?.basePrice ?? 25000;

      // Calculate fee snapshot (matching voucher creation logic)
      const appFeeRate = 3; // Default app fee rate
      const gasFeeAmount = 500; // Default gas fee
      const appFeeInIdr = (basePrice * appFeeRate) / 100;
      const totalPrice = basePrice + appFeeInIdr + gasFeeAmount;

      const voucher = await prisma.voucher.create({
        data: {
          merchantId,
          title: overrides?.title ?? `Test Voucher ${Date.now()}`,
          startDate: overrides?.startDate ?? new Date("2026-01-01"),
          expiryDate: overrides?.expiryDate ?? new Date("2026-12-31"),
          totalStock: stock,
          remainingStock: stock,
          basePrice,
          appFeeRate,
          gasFeeAmount,
          totalPrice,
          qrPerSlot,
          isActive: overrides?.isActive ?? true,
          createdBy: overrides?.createdBy,
        },
      });

      // Create redemption slots
      const slots = await Promise.all(
        Array.from({ length: stock }, (_, i) =>
          prisma.redemptionSlot.create({
            data: {
              voucherId: voucher.id,
              slotIndex: i + 1,
              status: "available",
            },
          })
        )
      );

      // Create QR codes for each slot
      const qrCodes = [];
      for (const slot of slots) {
        for (let qrNum = 1; qrNum <= qrPerSlot; qrNum++) {
          const qr = await prisma.qrCode.create({
            data: {
              voucherId: voucher.id,
              slotId: slot.id,
              qrNumber: qrNum,
              imageUrl: `https://example.com/qr-${voucher.id}-${slot.slotIndex}-${qrNum}.png`,
              imageHash: `hash-${voucher.id}-${slot.slotIndex}-${qrNum}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              status: "available",
            },
          });
          qrCodes.push(qr);
        }
      }

      return { voucher, qrCodes, slots };
    },

    async createAppSettings(overrides?: Partial<{
      appFeeRate: number;
      wealthContractAddress: string;
      devWalletAddress: string;
      alchemyRpcUrl: string;
      coingeckoApiKey: string;
    }>) {
      return prisma.appSettings.upsert({
        where: { id: "singleton" },
        update: {
          ...(overrides?.appFeeRate !== undefined && {
            appFeeRate: overrides.appFeeRate,
          }),
          ...(overrides?.wealthContractAddress !== undefined && {
            wealthContractAddress: overrides.wealthContractAddress,
          }),
          ...(overrides?.devWalletAddress !== undefined && {
            devWalletAddress: overrides.devWalletAddress,
          }),
          ...(overrides?.alchemyRpcUrl !== undefined && {
            alchemyRpcUrl: overrides.alchemyRpcUrl,
          }),
          ...(overrides?.coingeckoApiKey !== undefined && {
            coingeckoApiKey: overrides.coingeckoApiKey,
          }),
        },
        create: {
          id: "singleton",
          appFeeRate: overrides?.appFeeRate ?? 3,
          wealthContractAddress: overrides?.wealthContractAddress,
          devWalletAddress: overrides?.devWalletAddress,
          alchemyRpcUrl: overrides?.alchemyRpcUrl,
          coingeckoApiKey: overrides?.coingeckoApiKey,
        },
      });
    },

    async createFeeSetting(overrides?: Partial<{
      label: string;
      amountIdr: number;
      isActive: boolean;
    }>) {
      return prisma.feeSetting.create({
        data: {
          label: overrides?.label ?? "Gas Fee",
          amountIdr: overrides?.amountIdr ?? 5000,
          isActive: overrides?.isActive ?? false,
        },
      });
    },

    async cleanDatabase() {
      // Delete in reverse dependency order
      await prisma.transaction.deleteMany();
      await prisma.redemption.deleteMany();
      await prisma.qrCode.deleteMany();
      await prisma.redemptionSlot.deleteMany();
      await prisma.voucher.deleteMany();
      await prisma.merchant.deleteMany();
      await prisma.category.deleteMany();
      await prisma.user.deleteMany();
      await prisma.admin.deleteMany();
      await prisma.appSettings.deleteMany();
      await prisma.feeSetting.deleteMany();
    },
  };
}
