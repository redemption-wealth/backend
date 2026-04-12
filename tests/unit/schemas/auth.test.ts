import { describe, test, expect } from "vitest";
import { loginSchema, setPasswordSchema } from "@/schemas/auth.js";

describe("loginSchema", () => {
  test("valid login data passes", () => {
    const result = loginSchema.safeParse({
      email: "admin@test.com",
      password: "password123",
    });
    expect(result.success).toBe(true);
  });

  test("missing email fails", () => {
    const result = loginSchema.safeParse({ password: "password123" });
    expect(result.success).toBe(false);
  });

  test("missing password fails", () => {
    const result = loginSchema.safeParse({ email: "admin@test.com" });
    expect(result.success).toBe(false);
  });

  test("invalid email format fails", () => {
    const result = loginSchema.safeParse({
      email: "not-an-email",
      password: "password123",
    });
    expect(result.success).toBe(false);
  });

  test("password < 8 chars fails", () => {
    const result = loginSchema.safeParse({
      email: "admin@test.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  test("password > 128 chars fails", () => {
    const result = loginSchema.safeParse({
      email: "admin@test.com",
      password: "a".repeat(129),
    });
    expect(result.success).toBe(false);
  });

  test("empty email fails", () => {
    const result = loginSchema.safeParse({
      email: "",
      password: "password123",
    });
    expect(result.success).toBe(false);
  });

  test("empty password fails", () => {
    const result = loginSchema.safeParse({
      email: "admin@test.com",
      password: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("setPasswordSchema", () => {
  test("valid set-password data passes", () => {
    const result = setPasswordSchema.safeParse({
      email: "admin@test.com",
      password: "newpassword123",
      confirmPassword: "newpassword123",
    });
    expect(result.success).toBe(true);
  });

  test("password mismatch fails", () => {
    const result = setPasswordSchema.safeParse({
      email: "admin@test.com",
      password: "newpassword123",
      confirmPassword: "differentpassword",
    });
    expect(result.success).toBe(false);
  });

  test("password < 8 chars fails", () => {
    const result = setPasswordSchema.safeParse({
      email: "admin@test.com",
      password: "short",
      confirmPassword: "short",
    });
    expect(result.success).toBe(false);
  });

  test("password > 128 chars fails", () => {
    const long = "a".repeat(129);
    const result = setPasswordSchema.safeParse({
      email: "admin@test.com",
      password: long,
      confirmPassword: long,
    });
    expect(result.success).toBe(false);
  });

  test("missing email fails", () => {
    const result = setPasswordSchema.safeParse({
      password: "newpassword123",
      confirmPassword: "newpassword123",
    });
    expect(result.success).toBe(false);
  });

  test("missing confirmPassword fails", () => {
    const result = setPasswordSchema.safeParse({
      email: "admin@test.com",
      password: "newpassword123",
    });
    expect(result.success).toBe(false);
  });
});
