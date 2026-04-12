import { describe, test, expect } from "vitest";
import { createAdminSchema, updateAdminSchema } from "@/schemas/admin.js";

describe("createAdminSchema", () => {
  test("valid admin data passes", () => {
    const result = createAdminSchema.safeParse({
      email: "admin@test.com",
      password: "password123",
    });
    expect(result.success).toBe(true);
  });

  test("admin without password passes (first-login flow)", () => {
    const result = createAdminSchema.safeParse({
      email: "admin@test.com",
    });
    expect(result.success).toBe(true);
  });

  test("defaults role to admin", () => {
    const result = createAdminSchema.safeParse({
      email: "admin@test.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("admin");
    }
  });

  test("owner role passes", () => {
    const result = createAdminSchema.safeParse({
      email: "admin@test.com",
      role: "owner",
    });
    expect(result.success).toBe(true);
  });

  test("invalid role enum fails", () => {
    const result = createAdminSchema.safeParse({
      email: "admin@test.com",
      role: "superadmin",
    });
    expect(result.success).toBe(false);
  });

  test("weak password fails", () => {
    const result = createAdminSchema.safeParse({
      email: "admin@test.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  test("invalid email fails", () => {
    const result = createAdminSchema.safeParse({
      email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  test("missing email fails", () => {
    const result = createAdminSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("updateAdminSchema", () => {
  test("valid isActive passes", () => {
    const result = updateAdminSchema.safeParse({ isActive: false });
    expect(result.success).toBe(true);
  });

  test("missing isActive fails", () => {
    const result = updateAdminSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("non-boolean isActive fails", () => {
    const result = updateAdminSchema.safeParse({ isActive: "yes" });
    expect(result.success).toBe(false);
  });
});
