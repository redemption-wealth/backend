import { PrismaClient } from "@prisma/client";
import bcryptjs from "bcryptjs";

export function createFixtures(prisma: PrismaClient) {
  return {
    async createAdmin(overrides?: Partial<{
      email: string;
      password: string | null;
      role: "admin" | "owner";
      isActive: boolean;
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
      category: string;
      isActive: boolean;
      description: string;
      logoUrl: string;
    }>) {
      return prisma.merchant.create({
        data: {
          name: overrides?.name ?? `Test Merchant ${Date.now()}`,
          category: (overrides?.category ?? "kuliner") as never,
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
        priceIdr: number;
        totalStock: number;
        qrPerRedemption: number;
        isActive: boolean;
        startDate: Date;
        endDate: Date;
      }>
    ) {
      const stock = overrides?.totalStock ?? qrCount;
      const voucher = await prisma.voucher.create({
        data: {
          merchantId,
          title: overrides?.title ?? `Test Voucher ${Date.now()}`,
          startDate: overrides?.startDate ?? new Date("2026-01-01"),
          endDate: overrides?.endDate ?? new Date("2026-12-31"),
          totalStock: stock,
          remainingStock: stock,
          priceIdr: overrides?.priceIdr ?? 25000,
          qrPerRedemption: overrides?.qrPerRedemption ?? 1,
          isActive: overrides?.isActive ?? true,
        },
      });

      const qrCodes = await Promise.all(
        Array.from({ length: qrCount }, (_, i) =>
          prisma.qrCode.create({
            data: {
              voucherId: voucher.id,
              imageUrl: `https://example.com/qr-${voucher.id}-${i}.png`,
              imageHash: `hash-${voucher.id}-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              status: "available",
            },
          })
        )
      );

      return { voucher, qrCodes };
    },

    async createAppSettings(overrides?: Partial<{
      appFeePercentage: number;
      tokenContractAddress: string;
      treasuryWalletAddress: string;
    }>) {
      return prisma.appSettings.upsert({
        where: { id: "singleton" },
        update: {
          ...(overrides?.appFeePercentage !== undefined && {
            appFeePercentage: overrides.appFeePercentage,
          }),
          ...(overrides?.tokenContractAddress !== undefined && {
            tokenContractAddress: overrides.tokenContractAddress,
          }),
          ...(overrides?.treasuryWalletAddress !== undefined && {
            treasuryWalletAddress: overrides.treasuryWalletAddress,
          }),
        },
        create: {
          id: "singleton",
          appFeePercentage: overrides?.appFeePercentage ?? 3,
          tokenContractAddress: overrides?.tokenContractAddress,
          treasuryWalletAddress: overrides?.treasuryWalletAddress,
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
      await prisma.voucher.deleteMany();
      await prisma.merchant.deleteMany();
      await prisma.user.deleteMany();
      await prisma.admin.deleteMany();
      await prisma.appSettings.deleteMany();
      await prisma.feeSetting.deleteMany();
    },
  };
}
