import { describe, test, expect } from "vitest";

describe("Smoke Test", () => {
  test("vitest is configured correctly", () => {
    expect(1 + 1).toBe(2);
  });

  test("environment variables are set", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(process.env.ADMIN_JWT_SECRET).toBeDefined();
  });
});
