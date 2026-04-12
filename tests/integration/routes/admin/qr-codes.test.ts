import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPost, authGet } from "../../../helpers/request.js";
import { createTestAdminToken } from "../../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

async function createAdminWithToken() {
  const admin = await fixtures.createAdmin();
  const token = await createTestAdminToken({ id: admin.id, email: admin.email });
  return { admin, token };
}

describe("GET /api/admin/qr-codes", () => {
  test("lists QR codes", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createVoucherWithQrCodes(merchant.id, 3);

    const res = await authGet("/api/admin/qr-codes", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qrCodes.length).toBe(3);
  });

  test("filters by status", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createVoucherWithQrCodes(merchant.id, 3);

    const res = await authGet("/api/admin/qr-codes?status=available", token);
    const body = await res.json();
    expect(body.qrCodes.every((qr: { status: string }) => qr.status === "available")).toBe(true);
  });
});

describe("POST /api/admin/qr-codes", () => {
  test("creates QR code with valid data", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 0);

    const res = await jsonPost("/api/admin/qr-codes", {
      voucherId: voucher.id,
      imageUrl: "https://example.com/qr-new.png",
      imageHash: `unique-hash-${Date.now()}`,
    }, token);
    expect(res.status).toBe(201);
  });

  test("returns 400 for invalid data", async () => {
    const { token } = await createAdminWithToken();
    const res = await jsonPost("/api/admin/qr-codes", {
      voucherId: "not-a-uuid",
      imageUrl: "not-a-url",
      imageHash: "",
    }, token);
    expect(res.status).toBe(400);
  });

  test("returns 409 for duplicate imageHash", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 0);

    const hash = `dup-hash-${Date.now()}`;
    await jsonPost("/api/admin/qr-codes", {
      voucherId: voucher.id,
      imageUrl: "https://example.com/qr1.png",
      imageHash: hash,
    }, token);

    const res = await jsonPost("/api/admin/qr-codes", {
      voucherId: voucher.id,
      imageUrl: "https://example.com/qr2.png",
      imageHash: hash,
    }, token);
    expect(res.status).toBe(409);
  });
});

describe("POST /api/admin/qr-codes/:id/mark-used", () => {
  test("marks assigned QR as used", async () => {
    const { admin, token } = await createAdminWithToken();
    const user = await fixtures.createUser();
    const merchant = await fixtures.createMerchant(admin.id);
    const { qrCodes } = await fixtures.createVoucherWithQrCodes(merchant.id, 1);

    await testPrisma.qrCode.update({
      where: { id: qrCodes[0].id },
      data: { status: "assigned", assignedToUserId: user.id },
    });

    const res = await jsonPost(`/api/admin/qr-codes/${qrCodes[0].id}/mark-used`, {}, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qrCode.status).toBe("used");
  });

  test("returns 400 for QR not in assigned status", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    const { qrCodes } = await fixtures.createVoucherWithQrCodes(merchant.id, 1);

    const res = await jsonPost(`/api/admin/qr-codes/${qrCodes[0].id}/mark-used`, {}, token);
    expect(res.status).toBe(400);
  });

  test("returns 404 for non-existent QR", async () => {
    const { token } = await createAdminWithToken();
    const res = await jsonPost("/api/admin/qr-codes/550e8400-e29b-41d4-a716-446655440000/mark-used", {}, token);
    expect(res.status).toBe(404);
  });
});
