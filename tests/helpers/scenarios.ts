import { PrismaClient } from "@prisma/client";
import { createFixtures } from "./fixtures.js";
import {
  createTestAdminToken,
  createTestOwnerToken,
  createTestManagerToken,
  createTestUserToken,
} from "./auth.js";

/**
 * Test Scenarios - High-level test setup builders
 *
 * These scenarios eliminate repetitive setup code across integration tests
 * by providing pre-configured test contexts for common workflows.
 *
 * Usage:
 *   const scenarios = createTestScenarios(testPrisma);
 *   const { token, merchant } = await scenarios.merchantWithVoucher(5);
 */
export function createTestScenarios(prisma: PrismaClient) {
  const fixtures = createFixtures(prisma);

  return {
    /**
     * Scenario: Authenticated admin with token
     *
     * @param role - Admin role (admin, owner, or manager)
     * @param merchantId - Optional merchant ID for admin/manager roles
     * @returns Admin record and JWT token
     */
    async authenticatedAdmin(
      role: "admin" | "owner" | "manager" = "admin",
      merchantId?: string
    ) {
      const admin = await fixtures.createAdmin({ role, merchantId });

      let token: string;
      if (role === "owner") {
        token = await createTestOwnerToken({ id: admin.id, email: admin.email });
      } else if (role === "manager") {
        token = await createTestManagerToken({
          id: admin.id,
          email: admin.email,
          merchantId: merchantId || admin.merchantId!,
        });
      } else {
        token = await createTestAdminToken({
          id: admin.id,
          email: admin.email,
          role,
          merchantId: admin.merchantId,
        });
      }

      return { admin, token };
    },

    /**
     * Scenario: Owner admin with their own merchant
     *
     * Creates an owner admin and a merchant created by that admin.
     * Useful for testing merchant management operations.
     *
     * @returns Admin, token, and merchant
     */
    async ownerWithMerchant() {
      const { admin, token } = await this.authenticatedAdmin("owner");
      const merchant = await fixtures.createMerchant(admin.id);
      return { admin, token, merchant };
    },

    /**
     * Scenario: Manager admin assigned to a specific merchant
     *
     * Creates an owner with merchant, then creates a manager assigned to that merchant.
     * Useful for testing role-based access control.
     *
     * @returns Owner, manager, token, and merchant
     */
    async managerForMerchant() {
      const { admin: owner, merchant } = await this.ownerWithMerchant();
      const { admin: manager, token } = await this.authenticatedAdmin(
        "manager",
        merchant.id
      );
      return { owner, manager, token, merchant };
    },

    /**
     * Scenario: Complete merchant setup with voucher and QR codes
     *
     * Creates owner → merchant → voucher → N QR codes in one call.
     * This is the most common setup for testing voucher and QR operations.
     *
     * @param qrCount - Number of QR codes to create (default: 5)
     * @returns Admin, token, merchant, voucher, and QR codes array
     */
    async merchantWithVoucher(qrCount = 5) {
      const { admin, token, merchant } = await this.ownerWithMerchant();
      const { voucher, qrCodes } = await fixtures.createVoucherWithQrCodes(
        merchant.id,
        qrCount
      );
      return { admin, token, merchant, voucher, qrCodes };
    },

    /**
     * Scenario: Multiple vouchers for the same merchant
     *
     * Creates a merchant with N vouchers, each with their own QR codes.
     * Useful for testing listing, filtering, and batch operations.
     *
     * @param voucherCount - Number of vouchers to create
     * @param qrPerVoucher - QR codes per voucher
     * @returns Admin, token, merchant, and vouchers array
     */
    async merchantWithMultipleVouchers(voucherCount = 3, qrPerVoucher = 5) {
      const { admin, token, merchant } = await this.ownerWithMerchant();

      const vouchers = await Promise.all(
        Array.from({ length: voucherCount }, async (_, i) => {
          const { voucher, qrCodes } = await fixtures.createVoucherWithQrCodes(
            merchant.id,
            qrPerVoucher,
            { title: `Test Voucher ${i + 1}` }
          );
          return { voucher, qrCodes };
        })
      );

      return { admin, token, merchant, vouchers };
    },

    /**
     * Scenario: Authenticated user with wallet
     *
     * Creates a user with wallet address and auth token.
     * Ready for redemption operations.
     *
     * @param walletAddress - Optional custom wallet address
     * @returns User record and JWT token
     */
    async authenticatedUser(walletAddress?: string) {
      const user = await fixtures.createUser({
        walletAddress: walletAddress || `0x${Math.random().toString(16).slice(2, 42).padEnd(40, "0")}`,
      });
      const token = await createTestUserToken({
        id: user.id,
        email: user.email,
        privyUserId: user.privyUserId,
      });
      return { user, token };
    },

    /**
     * Scenario: User without wallet (first-time login)
     *
     * Creates a user without wallet address.
     * Useful for testing first-login flow and wallet linking.
     *
     * @returns User record and JWT token
     */
    async newUserWithoutWallet() {
      const user = await fixtures.createUser({ walletAddress: undefined });
      const token = await createTestUserToken({
        id: user.id,
        email: user.email,
        privyUserId: user.privyUserId,
      });
      return { user, token };
    },

    /**
     * Scenario: Complete redemption flow setup
     *
     * Creates everything needed for a redemption test:
     * - Owner admin with merchant
     * - Voucher with QR codes
     * - User with wallet
     * - App settings (fees)
     *
     * This is the starting point for testing the core redemption flow.
     *
     * @param qrCount - Number of QR codes to create
     * @returns All entities needed for redemption
     */
    async redemptionReady(qrCount = 3) {
      const merchantSetup = await this.merchantWithVoucher(qrCount);
      const userSetup = await this.authenticatedUser();
      await fixtures.createAppSettings({ appFeePercentage: 3 });

      return {
        admin: merchantSetup.admin,
        adminToken: merchantSetup.token,
        merchant: merchantSetup.merchant,
        voucher: merchantSetup.voucher,
        qrCodes: merchantSetup.qrCodes,
        user: userSetup.user,
        userToken: userSetup.token,
      };
    },

    /**
     * Scenario: Active redemption in progress
     *
     * Creates a redemption record in "pending" or "qr_scanned" state.
     * Useful for testing redemption updates and status transitions.
     *
     * @param status - Initial redemption status
     * @returns Complete redemption context including redemption record
     */
    async activeRedemption(status: "pending" | "qr_scanned" = "pending") {
      const setup = await this.redemptionReady(3);

      // Create redemption record
      const redemption = await prisma.redemption.create({
        data: {
          userId: setup.user.id,
          voucherId: setup.voucher.id,
          status,
          totalPriceIdr: setup.voucher.priceIdr,
          qrPerRedemption: setup.voucher.qrPerRedemption,
          scannedQrCount: status === "qr_scanned" ? 1 : 0,
        },
      });

      // If QR scanned, link a QR code
      if (status === "qr_scanned") {
        await prisma.qrCode.update({
          where: { id: setup.qrCodes[0].id },
          data: {
            status: "scanned",
            redemptionId: redemption.id,
          },
        });
      }

      return { ...setup, redemption };
    },

    /**
     * Scenario: Fee settings configured
     *
     * Creates app settings and fee settings for testing pricing calculations.
     *
     * @param appFeePercentage - App fee percentage (default: 3%)
     * @param additionalFees - Additional fee settings to create
     * @returns App settings and fee settings
     */
    async withFeeSettings(
      appFeePercentage = 3,
      additionalFees: Array<{ label: string; amountIdr: number; isActive?: boolean }> = []
    ) {
      const appSettings = await fixtures.createAppSettings({ appFeePercentage });

      const feeSettings = await Promise.all(
        additionalFees.map((fee) =>
          fixtures.createFeeSetting({
            label: fee.label,
            amountIdr: fee.amountIdr,
            isActive: fee.isActive ?? true,
          })
        )
      );

      return { appSettings, feeSettings };
    },

    /**
     * Scenario: Analytics data setup
     *
     * Creates multiple completed redemptions and transactions for testing analytics.
     * Useful for testing reporting endpoints.
     *
     * @param redemptionCount - Number of completed redemptions
     * @returns Setup with redemptions and transactions
     */
    async withAnalyticsData(redemptionCount = 10) {
      const setup = await this.redemptionReady(redemptionCount);

      // Create completed redemptions
      const redemptions = await Promise.all(
        Array.from({ length: redemptionCount }, async (_, i) => {
          const redemption = await prisma.redemption.create({
            data: {
              userId: setup.user.id,
              voucherId: setup.voucher.id,
              status: "completed",
              totalPriceIdr: setup.voucher.priceIdr,
              qrPerRedemption: 1,
              scannedQrCount: 1,
            },
          });

          // Create associated transaction
          const transaction = await prisma.transaction.create({
            data: {
              redemptionId: redemption.id,
              transactionHash: `0x${Math.random().toString(16).slice(2).padEnd(64, "0")}`,
              amount: setup.voucher.priceIdr.toString(),
              status: "confirmed",
              blockNumber: 1000000 + i,
              fromAddress: setup.user.walletAddress!,
              toAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
            },
          });

          return { redemption, transaction };
        })
      );

      return { ...setup, redemptions };
    },
  };
}
