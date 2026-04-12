import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma, mockVerifyAuthToken } from "../../setup.integration.js";
import { createFixtures } from "../../helpers/fixtures.js";
import { authGet } from "../../helpers/request.js";
import { createTestUserToken, mockPrivyVerification } from "../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

describe("GET /api/transactions", () => {
  let userToken: string;
  let user: Awaited<ReturnType<typeof fixtures.createUser>>;

  beforeEach(async () => {
    // Create user
    user = await fixtures.createUser({
      privyUserId: "privy-user-1",
      email: "user1@test.com",
    });

    // Mock Privy token verification
    mockVerifyAuthToken.mockResolvedValue(
      mockPrivyVerification("privy-user-1", "user1@test.com")
    );

    userToken = createTestUserToken({
      privyUserId: "privy-user-1",
      email: "user1@test.com",
    });

    // Create test transactions
    await testPrisma.transaction.create({
      data: {
        userId: user.id,
        type: "redeem",
        amountWealth: "100",
        txHash: "0x" + "a".repeat(64),
        status: "confirmed",
      },
    });

    await testPrisma.transaction.create({
      data: {
        userId: user.id,
        type: "redeem",
        amountWealth: "200",
        txHash: "0x" + "b".repeat(64),
        status: "confirmed",
      },
    });

    await testPrisma.transaction.create({
      data: {
        userId: user.id,
        type: "redeem",
        amountWealth: "50",
        status: "pending",
      },
    });
  });

  test("returns 401 without auth", async () => {
    const res = await authGet("/api/transactions", "");
    expect(res.status).toBe(401);
  });

  test("returns only authenticated user's transactions", async () => {
    const res = await authGet("/api/transactions", userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions.length).toBe(3);
    expect(body.transactions.every((t: { userId: string }) => t.userId === user.id)).toBe(true);
  });

  test("filters by type", async () => {
    const res = await authGet("/api/transactions?type=redeem", userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions.every((t: { type: string }) => t.type === "redeem")).toBe(true);
  });

  test("pagination works", async () => {
    const res = await authGet("/api/transactions?page=1&limit=2", userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(2);
    expect(body.transactions.length).toBe(2);
  });

  test("transactions ordered by createdAt desc", async () => {
    const res = await authGet("/api/transactions", userToken);
    const body = await res.json();
    const dates = body.transactions.map((t: { createdAt: string }) => new Date(t.createdAt));

    // Check that dates are in descending order
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i].getTime()).toBeGreaterThanOrEqual(dates[i + 1].getTime());
    }
  });

  test("does NOT return other users' transactions", async () => {
    // Create another user with transactions
    const user2 = await fixtures.createUser({
      privyUserId: "privy-user-2",
      email: "user2@test.com",
    });

    await testPrisma.transaction.create({
      data: {
        userId: user2.id,
        type: "redeem",
        amountWealth: "300",
        txHash: "0x" + "c".repeat(64),
        status: "confirmed",
      },
    });

    const res = await authGet("/api/transactions", userToken);
    const body = await res.json();
    expect(body.transactions.every((t: { userId: string }) => t.userId !== user2.id)).toBe(true);
  });
});
