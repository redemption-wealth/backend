import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPost, jsonPut, authGet, authDelete } from "../../../helpers/request.js";
import { createTestAdminToken, createTestOwnerToken, createTestManagerToken } from "../../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

async function createAdminWithToken() {
  const admin = await fixtures.createAdmin({ role: "admin" });
  const token = await createTestAdminToken({ id: admin.id, email: admin.email, role: "admin" });
  return { admin, token };
}

async function createManagerWithToken() {
  const manager = await fixtures.createAdmin({ role: "manager" });
  const token = await createTestManagerToken({ id: manager.id, email: manager.email });
  return { manager, token };
}

async function createOwnerWithToken() {
  const owner = await fixtures.createAdmin({ role: "owner" });
  const token = await createTestOwnerToken({ id: owner.id, email: owner.email });
  return { owner, token };
}

describe("GET /api/admin/fee-settings", () => {
  test("lists all fee settings", async () => {
    await fixtures.createFeeSetting({ label: "Fee A", amountIdr: 3000 });
    await fixtures.createFeeSetting({ label: "Fee B", amountIdr: 5000 });

    const { token } = await createAdminWithToken();
    const res = await authGet("/api/admin/fee-settings", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feeSettings.length).toBe(2);
  });
});

describe("POST /api/admin/fee-settings", () => {
  test("creates fee setting (isActive=false by default)", async () => {
    const { token } = await createManagerWithToken();
    const res = await jsonPost("/api/admin/fee-settings", {
      label: "New Fee",
      amountIdr: 5000,
    }, token);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.feeSetting.isActive).toBe(false);
  });

  test("validates data with Zod", async () => {
    const { token } = await createManagerWithToken();
    const res = await jsonPost("/api/admin/fee-settings", {
      label: "A",
      amountIdr: -1,
    }, token);
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/admin/fee-settings/:id", () => {
  test("updates label and amountIdr", async () => {
    const fee = await fixtures.createFeeSetting({ label: "Old", amountIdr: 3000 });
    const { token } = await createManagerWithToken();

    const res = await jsonPut(`/api/admin/fee-settings/${fee.id}`, {
      label: "Updated Fee",
      amountIdr: 7000,
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feeSetting.label).toBe("Updated Fee");
    expect(body.feeSetting.amountIdr).toBe(7000);
  });
});

describe("POST /api/admin/fee-settings/:id/activate", () => {
  test("sets fee to active, deactivates others", async () => {
    const fee1 = await fixtures.createFeeSetting({ label: "Fee A", isActive: true });
    const fee2 = await fixtures.createFeeSetting({ label: "Fee B", isActive: false });

    const { token } = await createOwnerWithToken();
    const res = await jsonPost(`/api/admin/fee-settings/${fee2.id}/activate`, {}, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feeSetting.isActive).toBe(true);

    const updated1 = await testPrisma.feeSetting.findUnique({ where: { id: fee1.id } });
    expect(updated1!.isActive).toBe(false);
  });

  test("returns 403 for non-owner", async () => {
    const fee = await fixtures.createFeeSetting();
    const { token } = await createAdminWithToken();
    const res = await jsonPost(`/api/admin/fee-settings/${fee.id}/activate`, {}, token);
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/admin/fee-settings/:id", () => {
  test("deletes inactive fee setting", async () => {
    const fee = await fixtures.createFeeSetting({ isActive: false });
    const { token } = await createOwnerWithToken();

    const res = await authDelete(`/api/admin/fee-settings/${fee.id}`, token);
    expect(res.status).toBe(200);
  });

  test("returns 400 if fee is active", async () => {
    const fee = await fixtures.createFeeSetting({ isActive: true });
    const { token } = await createOwnerWithToken();

    const res = await authDelete(`/api/admin/fee-settings/${fee.id}`, token);
    expect(res.status).toBe(400);
  });

  test("returns 403 for non-owner", async () => {
    const fee = await fixtures.createFeeSetting();
    const { token } = await createAdminWithToken();
    const res = await authDelete(`/api/admin/fee-settings/${fee.id}`, token);
    expect(res.status).toBe(403);
  });
});
