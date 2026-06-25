import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPost, authGet } from "../../../helpers/request.js";
import { createTestAdminToken, createTestOwnerToken } from "../../../helpers/admin-session.js";

const fixtures = createFixtures(testPrisma);

async function createOwnerWithToken() {
  const admin = await fixtures.createAdmin({ role: "owner" });
  const token = await createTestOwnerToken({ id: admin.id, email: admin.email });
  return { admin, token };
}

// ADMIN-role staff scoped to a merchant — required by POST /scan (requireAdminRole).
async function createScopedAdmin(merchantId: string) {
  const admin = await fixtures.createAdmin({ role: "admin", merchantId });
  const token = await createTestAdminToken({ id: admin.id, email: admin.email, role: "admin", merchantId });
  return { admin, token };
}

describe("GET /api/admin/qr-codes", () => {
  test("lists QR codes", async () => {
    const { token } = await createOwnerWithToken();
    const merchant = await fixtures.createMerchant();
    await fixtures.createVoucherWithQrCodes(merchant.id, 3);

    const res = await authGet("/api/admin/qr-codes", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qrCodes.length).toBe(3);
  });

  test("filters by status", async () => {
    const { token } = await createOwnerWithToken();
    const merchant = await fixtures.createMerchant();
    await fixtures.createVoucherWithQrCodes(merchant.id, 3);

    const res = await authGet("/api/admin/qr-codes?status=AVAILABLE", token);
    const body = await res.json();
    expect(body.qrCodes.every((qr: { status: string }) => qr.status === "AVAILABLE")).toBe(true);
  });
});

describe("POST /api/admin/qr-codes/scan", () => {
  test("scans a REDEEMED QR token (scoped admin)", async () => {
    const owner = await fixtures.createAdmin({ role: "owner" });
    const merchant = await fixtures.createMerchant(owner.id);
    const { voucher, qrCodes } = await fixtures.createVoucherWithQrCodes(merchant.id, 1);
    const { token } = await createScopedAdmin(merchant.id);

    const qr = await testPrisma.qrCode.update({
      where: { id: qrCodes[0].id },
      data: { status: "REDEEMED", assignedAt: new Date() },
    });

    const res = await jsonPost("/api/admin/qr-codes/scan", { token: qr.token }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.voucherId).toBe(voucher.id);
  });

  test("returns 404 for non-existent token", async () => {
    const merchant = await fixtures.createMerchant();
    const { token } = await createScopedAdmin(merchant.id);
    const res = await jsonPost("/api/admin/qr-codes/scan", { token: "nonexistent-token-1234567890" }, token);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("NOT_FOUND");
  });

  test("returns 409 for already-used QR", async () => {
    const owner = await fixtures.createAdmin({ role: "owner" });
    const merchant = await fixtures.createMerchant(owner.id);
    const { qrCodes } = await fixtures.createVoucherWithQrCodes(merchant.id, 1);
    const { token } = await createScopedAdmin(merchant.id);

    const qr = await testPrisma.qrCode.update({
      where: { id: qrCodes[0].id },
      data: { status: "USED", usedAt: new Date() },
    });

    const res = await jsonPost("/api/admin/qr-codes/scan", { token: qr.token }, token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("ALREADY_USED");
  });

  test("returns 422 SCAN_NOT_SUPPORTED for a merchant-uploaded voucher", async () => {
    const owner = await fixtures.createAdmin({ role: "owner" });
    const merchant = await fixtures.createMerchant(owner.id);
    const { qrCodes } = await fixtures.createVoucherWithQrCodes(merchant.id, 1, {
      assetSource: "MERCHANT_UPLOADED",
      format: "CODE",
      values: ["UPLOADED-1"],
    });
    const { token } = await createScopedAdmin(merchant.id);

    const qr = await testPrisma.qrCode.update({
      where: { id: qrCodes[0].id },
      data: { status: "REDEEMED", assignedAt: new Date() },
    });

    const res = await jsonPost("/api/admin/qr-codes/scan", { token: qr.token }, token);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("SCAN_NOT_SUPPORTED");
  });

  test("scoped admin gets 403 (WRONG_MERCHANT) for another merchant's QR", async () => {
    const owner = await fixtures.createAdmin({ role: "owner" });
    const merchant1 = await fixtures.createMerchant(owner.id);
    const merchant2 = await fixtures.createMerchant(owner.id);

    const { token: scopedToken } = await createScopedAdmin(merchant1.id);

    const { qrCodes } = await fixtures.createVoucherWithQrCodes(merchant2.id, 1);
    const qr = await testPrisma.qrCode.update({
      where: { id: qrCodes[0].id },
      data: { status: "REDEEMED", assignedAt: new Date() },
    });

    const res = await jsonPost("/api/admin/qr-codes/scan", { token: qr.token }, scopedToken);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("WRONG_MERCHANT");
  });
});
