import { describe, test, expect } from "vitest";
import {
  createQrCodeSchema,
  scanQrSchema,
  qrCodeQuerySchema,
} from "@/schemas/qr-code.js";

const CUID = "clh1234567890abcdefghijkl";

describe("createQrCodeSchema", () => {
  const ok = {
    voucherId: CUID,
    slotId: CUID,
    qrNumber: 1,
    imageUrl: "https://cdn.example.com/qr.png",
    imageHash: "hash123",
  };

  test("positive: valid payload passes", () => {
    expect(createQrCodeSchema.safeParse(ok).success).toBe(true);
  });

  test("negative: non-cuid voucherId rejected", () => {
    expect(
      createQrCodeSchema.safeParse({ ...ok, voucherId: "123" }).success,
    ).toBe(false);
  });

  test("edge: qrNumber 1 and 2 accepted, 0 and 3 rejected", () => {
    expect(createQrCodeSchema.safeParse({ ...ok, qrNumber: 2 }).success).toBe(
      true,
    );
    expect(createQrCodeSchema.safeParse({ ...ok, qrNumber: 0 }).success).toBe(
      false,
    );
    expect(createQrCodeSchema.safeParse({ ...ok, qrNumber: 3 }).success).toBe(
      false,
    );
  });

  test("negative: non-URL imageUrl rejected", () => {
    expect(
      createQrCodeSchema.safeParse({ ...ok, imageUrl: "x" }).success,
    ).toBe(false);
  });

  test("negative: empty imageHash rejected", () => {
    expect(
      createQrCodeSchema.safeParse({ ...ok, imageHash: "" }).success,
    ).toBe(false);
  });
});

// UAT B24/B27 — scan QR / manual token input
describe("scanQrSchema", () => {
  test("positive: non-empty token passes", () => {
    expect(scanQrSchema.safeParse({ token: "tok_abc" }).success).toBe(true);
  });

  test("negative: empty token rejected", () => {
    expect(scanQrSchema.safeParse({ token: "" }).success).toBe(false);
  });

  test("negative: missing token rejected", () => {
    expect(scanQrSchema.safeParse({}).success).toBe(false);
  });
});

describe("qrCodeQuerySchema", () => {
  test("positive: valid status enum + cuid voucherId", () => {
    expect(
      qrCodeQuerySchema.safeParse({ status: "USED", voucherId: CUID }).success,
    ).toBe(true);
  });

  test("negative: lowercase/invalid status rejected", () => {
    expect(qrCodeQuerySchema.safeParse({ status: "used" }).success).toBe(false);
  });

  test("positive: defaults applied when empty", () => {
    const r = qrCodeQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(20);
  });
});
