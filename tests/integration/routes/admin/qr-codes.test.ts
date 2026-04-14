import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPost, authGet } from "../../../helpers/request.js";
import { createTestAdminToken, createTestOwnerToken } from "../../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

async function createAdminWithToken(role: "admin" | "owner" = "admin", merchantId?: string) {
  const admin = await fixtures.createAdmin({ role, merchantId });
  const token = role === "owner"
    ? await createTestOwnerToken({ id: admin.id, email: admin.email })
    : await createTestAdminToken({ id: admin.id, email: admin.email, role, merchantId });
  return { admin, token };
}

describe("GET /api/admin/qr-codes", () => {
  test("lists QR codes", async () => {
    const { admin, token } = await createAdminWithToken("owner");
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createVoucherWithQrCodes(merchant.id, 3);

    const res = await authGet("/api/admin/qr-codes", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qrCodes.length).toBe(3);
  });

  test("filters by status", async () => {
    const { admin, token } = await createAdminWithToken("owner");
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createVoucherWithQrCodes(merchant.id, 3);

    const res = await authGet("/api/admin/qr-codes?status=available", token);
    const body = await res.json();
    expect(body.qrCodes.every((qr: { status: string }) => qr.status === "available")).toBe(true);
  });
});

describe("POST /api/admin/qr-codes", () => {
  test("creates QR code with valid data", async () => {
    const { admin, token } = await createAdminWithToken("owner");
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher, slots } = await fixtures.createVoucherWithQrCodes(merchant.id, 1);

    const res = await jsonPost("/api/admin/qr-codes", {
      voucherId: voucher.id,
      slotId: slots[0].id,
      qrNumber: 2,
      imageUrl: "https://example.com/qr-new.png",
      imageHash: `unique-hash-${Date.now()}`,
    }, token);
    expect(res.status).toBe(201);
  });

  test("returns 400 for invalid data", async () => {
    const { token } = await createAdminWithToken("owner");
    const res = await jsonPost("/api/admin/qr-codes", {
      voucherId: "not-a-uuid",
      slotId: "not-a-uuid",
      qrNumber: 0, // Invalid: must be >= 1
      imageUrl: "not-a-url",
      imageHash: "",
    }, token);
    expect(res.status).toBe(400);
  });

  test("returns 409 for duplicate imageHash", async () => {
    const { admin, token } = await createAdminWithToken("owner");
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher, slots } = await fixtures.createVoucherWithQrCodes(merchant.id, 1);

    const hash = `dup-hash-${Date.now()}`;
    await jsonPost("/api/admin/qr-codes", {
      voucherId: voucher.id,
      slotId: slots[0].id,
      qrNumber: 2,
      imageUrl: "https://example.com/qr1.png",
      imageHash: hash,
    }, token);

    const res = await jsonPost("/api/admin/qr-codes", {
      voucherId: voucher.id,
      slotId: slots[0].id,
      qrNumber: 2, // This would conflict with the unique constraint on (slotId, qrNumber)
      imageUrl: "https://example.com/qr2.png",
      imageHash: hash,
    }, token);
    expect(res.status).toBe(409);
  });
});

describe("POST /api/admin/qr-codes/scan", () => {
  test("scans valid redeemed QR token (owner)", async () => {
    const { admin, token } = await createAdminWithToken("owner");
    const user = await fixtures.createUser();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher, slots, qrCodes } = await fixtures.createVoucherWithQrCodes(merchant.id, 1);

    // Update the existing QR to have a token and be in redeemed state
    const qr = await testPrisma.qrCode.update({
      where: { id: qrCodes[0].id },
      data: {
        token: `test-token-${Date.now()}`,
        status: "redeemed",
        assignedToUserId: user.id,
        redeemedAt: new Date(),
      },
    });

    const res = await jsonPost("/api/admin/qr-codes/scan", { token: qr.token }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.voucherId).toBe(voucher.id);
  });

  test("returns 404 for non-existent token", async () => {
    const { token } = await createAdminWithToken("owner");
    const res = await jsonPost("/api/admin/qr-codes/scan", { token: "nonexistent-token" }, token);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("NOT_FOUND");
  });

  test("returns 409 for already-used QR", async () => {
    const { admin, token } = await createAdminWithToken("owner");
    const user = await fixtures.createUser();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher, slots, qrCodes } = await fixtures.createVoucherWithQrCodes(merchant.id, 1);

    // Update the existing QR to have a token and be in used state
    const qr = await testPrisma.qrCode.update({
      where: { id: qrCodes[0].id },
      data: {
        token: `used-token-${Date.now()}`,
        status: "used",
        assignedToUserId: user.id,
        usedAt: new Date(),
      },
    });

    const res = await jsonPost("/api/admin/qr-codes/scan", { token: qr.token }, token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("ALREADY_USED");
  });

  test("admin role returns 403 for wrong merchant QR", async () => {
    const ownerAdmin = await fixtures.createAdmin({ role: "owner" });
    const merchant1 = await fixtures.createMerchant(ownerAdmin.id);
    const merchant2 = await fixtures.createMerchant(ownerAdmin.id);
    const user = await fixtures.createUser();

    // Admin scoped to merchant1
    const scopedAdmin = await fixtures.createAdmin({ role: "admin", merchantId: merchant1.id });
    const scopedToken = await createTestAdminToken({
      id: scopedAdmin.id,
      email: scopedAdmin.email,
      role: "admin",
      merchantId: merchant1.id,
    });

    // Create QR for merchant2's voucher
    const { voucher: voucher2, slots: slots2, qrCodes: qrCodes2 } = await fixtures.createVoucherWithQrCodes(merchant2.id, 1);

    // Update the existing QR to have a token and be in redeemed state
    const qr = await testPrisma.qrCode.update({
      where: { id: qrCodes2[0].id },
      data: {
        token: `wrong-token-${Date.now()}`,
        status: "redeemed",
        assignedToUserId: user.id,
        redeemedAt: new Date(),
      },
    });

    const res = await jsonPost("/api/admin/qr-codes/scan", { token: qr.token }, scopedToken);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("WRONG_MERCHANT");
  });

  // Removed: POST /api/admin/qr-codes/:id/mark-used (endpoint removed, use /scan instead)
});
