import { describe, test, expect } from "vitest";
import { createQrCodeSchema, qrCodeQuerySchema } from "@/schemas/qr-code.js";

describe("createQrCodeSchema", () => {
  test("valid QR data passes", () => {
    const result = createQrCodeSchema.safeParse({
      voucherId: "550e8400-e29b-41d4-a716-446655440000",
      imageUrl: "https://example.com/qr.png",
      imageHash: "abc123hash",
    });
    expect(result.success).toBe(true);
  });

  test("non-UUID voucherId fails", () => {
    const result = createQrCodeSchema.safeParse({
      voucherId: "not-a-uuid",
      imageUrl: "https://example.com/qr.png",
      imageHash: "abc123hash",
    });
    expect(result.success).toBe(false);
  });

  test("invalid URL for imageUrl fails", () => {
    const result = createQrCodeSchema.safeParse({
      voucherId: "550e8400-e29b-41d4-a716-446655440000",
      imageUrl: "not-a-url",
      imageHash: "abc123hash",
    });
    expect(result.success).toBe(false);
  });

  test("empty imageHash fails", () => {
    const result = createQrCodeSchema.safeParse({
      voucherId: "550e8400-e29b-41d4-a716-446655440000",
      imageUrl: "https://example.com/qr.png",
      imageHash: "",
    });
    expect(result.success).toBe(false);
  });

  test("missing fields fails", () => {
    const result = createQrCodeSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("qrCodeQuerySchema", () => {
  test("empty query uses defaults", () => {
    const result = qrCodeQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  test("valid status filter passes", () => {
    const result = qrCodeQuerySchema.safeParse({ status: "available" });
    expect(result.success).toBe(true);
  });

  test("invalid status fails", () => {
    const result = qrCodeQuerySchema.safeParse({ status: "invalid" });
    expect(result.success).toBe(false);
  });

  test("valid voucherId filter passes", () => {
    const result = qrCodeQuerySchema.safeParse({
      voucherId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });
});
