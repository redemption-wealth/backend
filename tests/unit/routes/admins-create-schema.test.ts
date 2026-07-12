import { describe, test, expect } from "vitest";
import { createAdminSchema } from "@/routes/admin/admins.js";

// Contract enforced by POST /api/admin/admins:
//   ADMIN          → merchantId REQUIRED
//   MANAGER, OWNER → merchantId MUST NOT be required (ignored)
describe("createAdminSchema (admin-create contract)", () => {
  const cuid = "clh1a2b3c0000xyz1234abcd";

  test("MANAGER without merchantId is valid (regression: not a 500)", () => {
    const result = createAdminSchema.safeParse({ email: "m@test.com", role: "MANAGER" });
    expect(result.success).toBe(true);
  });

  test("OWNER without merchantId is valid", () => {
    const result = createAdminSchema.safeParse({ email: "o@test.com", role: "OWNER" });
    expect(result.success).toBe(true);
  });

  test("MANAGER with empty-string merchantId is valid (treated as absent)", () => {
    const result = createAdminSchema.safeParse({ email: "m2@test.com", role: "MANAGER", merchantId: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.merchantId).toBeUndefined();
  });

  test("ADMIN without merchantId is INVALID (regression: 400, not 422/500)", () => {
    const result = createAdminSchema.safeParse({ email: "a@test.com", role: "ADMIN" });
    expect(result.success).toBe(false);
  });

  test("ADMIN with a valid cuid merchantId is valid", () => {
    const result = createAdminSchema.safeParse({ email: "a2@test.com", role: "ADMIN", merchantId: cuid });
    expect(result.success).toBe(true);
  });

  test("invalid email fails", () => {
    const result = createAdminSchema.safeParse({ email: "nope", role: "MANAGER" });
    expect(result.success).toBe(false);
  });

  test("unknown role fails", () => {
    const result = createAdminSchema.safeParse({ email: "a@test.com", role: "SUPERADMIN" });
    expect(result.success).toBe(false);
  });
});
