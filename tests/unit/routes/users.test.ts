import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { Prisma } from "@prisma/client";

vi.mock("@/middleware/auth.js", () => ({
  requireUser: async (c: any, next: any) => {
    c.set("userAuth", {
      type: "user",
      userEmail: "a@x.com",
      privyUserId: "privy_1",
    });
    return next();
  },
}));

vi.mock("@/services/appUser.js", () => ({
  getOrCreateAppUser: vi.fn(),
  hasRedeemed: vi.fn(async () => false),
}));

const appUserUpdate = vi.fn();
vi.mock("@/db.js", () => ({
  prisma: { appUser: { update: (...args: any[]) => appUserUpdate(...args) } },
}));

import userRoutes from "@/routes/users.js";
import { getOrCreateAppUser } from "@/services/appUser.js";

const app = new Hono().route("/api/users", userRoutes);

const BASE_USER = {
  id: "u1",
  email: "a@x.com",
  walletAddress: null,
  name: null,
  username: null,
  phone: null,
  avatarUrl: null,
  referralCode: "ABCD2345",
  hasDeposited: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getOrCreateAppUser).mockResolvedValue({ ...BASE_USER } as any);
});

function patch(body: unknown) {
  return app.request("/api/users/me", {
    method: "PATCH",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/users/me", () => {
  test("happy path: updates fields and returns the user shape", async () => {
    appUserUpdate.mockResolvedValue({
      ...BASE_USER,
      name: "Andini",
      username: "andini_01",
      phone: "0812345678",
    });

    const res = await patch({ name: "Andini", username: "andini_01", phone: "0812345678" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user).toEqual({
      id: "u1",
      email: "a@x.com",
      walletAddress: null,
      name: "Andini",
      username: "andini_01",
      phone: "0812345678",
      avatarUrl: null,
      referralCode: "ABCD2345",
      hasDeposited: false,
    });
    // Only the provided fields are passed to Prisma (partial update).
    expect(appUserUpdate.mock.calls[0][0]).toEqual({
      where: { id: "u1" },
      data: { name: "Andini", username: "andini_01", phone: "0812345678" },
    });
  });

  test("username taken → 409 (PrismaPg driver-adapter P2002 shape)", async () => {
    // Prisma 7 + PrismaPg adapter no longer populates meta.target; the violated
    // fields live at meta.driverAdapterError.cause.constraint.fields. The old
    // meta.target?.includes("username") check returned 500 for this shape — this
    // test reproduces the real driver error so it fails-before / passes-after.
    appUserUpdate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7.7.0",
        meta: {
          driverAdapterError: {
            cause: { constraint: { fields: ["username"] } },
          },
        },
      })
    );

    const res = await patch({ username: "taken_name" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Username sudah dipakai" });
  });

  test("username taken → 409 (legacy meta.target shape still works)", async () => {
    appUserUpdate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7.7.0",
        meta: { target: ["username"] },
      })
    );

    const res = await patch({ username: "taken_name" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Username sudah dipakai" });
  });

  test("validation failure → 400 with details", async () => {
    // username too short + non-alnum
    const res = await patch({ username: "a!" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Validation failed");
    expect(json.details).toBeDefined();
    expect(appUserUpdate).not.toHaveBeenCalled();
  });
});
