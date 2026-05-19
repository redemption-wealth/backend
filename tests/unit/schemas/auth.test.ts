import { describe, test, expect } from "vitest";
import {
  signInSchema,
  setupPasswordSchema,
  changePasswordSchema,
} from "@/schemas/auth.js";

// UAT B1/B2 — login validation
describe("signInSchema", () => {
  test("positive: valid email + password passes", () => {
    expect(
      signInSchema.safeParse({ email: "owner@test.com", password: "secret" })
        .success,
    ).toBe(true);
  });

  test("negative: invalid email format fails", () => {
    expect(
      signInSchema.safeParse({ email: "not-an-email", password: "secret" })
        .success,
    ).toBe(false);
  });

  test("negative: missing email fails", () => {
    expect(signInSchema.safeParse({ password: "secret" }).success).toBe(false);
  });

  test("negative: empty password fails (min 1)", () => {
    expect(
      signInSchema.safeParse({ email: "a@b.com", password: "" }).success,
    ).toBe(false);
  });

  test("edge: 128-char password passes, 129 fails", () => {
    expect(
      signInSchema.safeParse({ email: "a@b.com", password: "x".repeat(128) })
        .success,
    ).toBe(true);
    expect(
      signInSchema.safeParse({ email: "a@b.com", password: "x".repeat(129) })
        .success,
    ).toBe(false);
  });
});

// UAT B4/B5 — set password via token (strong password rules)
describe("setupPasswordSchema", () => {
  const ok = {
    token: "tok_123",
    password: "Password1",
    confirmPassword: "Password1",
  };

  test("positive: strong password + matching confirm passes", () => {
    expect(setupPasswordSchema.safeParse(ok).success).toBe(true);
  });

  test("negative: missing token fails", () => {
    expect(setupPasswordSchema.safeParse({ ...ok, token: "" }).success).toBe(
      false,
    );
  });

  test("negative: password mismatch fails on confirmPassword path", () => {
    const r = setupPasswordSchema.safeParse({
      ...ok,
      confirmPassword: "Other1",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => i.path.includes("confirmPassword")),
      ).toBe(true);
    }
  });

  test("negative: no uppercase fails", () => {
    expect(
      setupPasswordSchema.safeParse({
        token: "t",
        password: "password1",
        confirmPassword: "password1",
      }).success,
    ).toBe(false);
  });

  test("negative: no digit fails", () => {
    expect(
      setupPasswordSchema.safeParse({
        token: "t",
        password: "Password",
        confirmPassword: "Password",
      }).success,
    ).toBe(false);
  });

  test("edge: exactly 8 chars with upper+digit passes; 7 fails", () => {
    expect(
      setupPasswordSchema.safeParse({
        token: "t",
        password: "Passwo1d",
        confirmPassword: "Passwo1d",
      }).success,
    ).toBe(true);
    expect(
      setupPasswordSchema.safeParse({
        token: "t",
        password: "Pass1wd",
        confirmPassword: "Pass1wd",
      }).success,
    ).toBe(false);
  });
});

// UAT B6 — change password
describe("changePasswordSchema", () => {
  test("positive: valid current + strong new + match passes", () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: "old",
        newPassword: "NewPass1",
        confirmPassword: "NewPass1",
      }).success,
    ).toBe(true);
  });

  test("negative: weak new password fails", () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: "old",
        newPassword: "weak",
        confirmPassword: "weak",
      }).success,
    ).toBe(false);
  });

  test("negative: new/confirm mismatch fails", () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: "old",
        newPassword: "NewPass1",
        confirmPassword: "NewPass2",
      }).success,
    ).toBe(false);
  });
});
