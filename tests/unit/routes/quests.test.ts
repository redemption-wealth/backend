import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Server-derived wallet the auth middleware attaches (Privy, not client body).
const SERVER_WALLET = "0x000000000000000000000000000000000000aaaa";

// requireUser → pass-through that injects a fixed user.
vi.mock("@/middleware/auth.js", () => ({
  requireUser: async (c: any, next: any) => {
    c.set("userAuth", {
      type: "user",
      userEmail: "a@x.com",
      privyUserId: "privy_1",
      walletAddress: "0x000000000000000000000000000000000000aaaa",
    });
    return next();
  },
}));

// Mock the service layer but keep the real error classes (for instanceof).
vi.mock("@/services/appUser.js", () => ({
  syncAppUser: vi.fn(),
  getOrCreateAppUser: vi.fn(),
  hasRedeemed: vi.fn(async () => false),
}));
vi.mock("@/services/quest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/quest.js")>();
  return {
    ...actual,
    listQuestsForUser: vi.fn(),
    checkin: vi.fn(),
    claimTask: vi.fn(),
  };
});
vi.mock("@/services/wp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/wp.js")>();
  return { ...actual, getBalance: vi.fn() };
});

import questRoutes from "@/routes/quests.js";
import { syncAppUser, getOrCreateAppUser } from "@/services/appUser.js";
import {
  listQuestsForUser,
  checkin,
  claimTask,
  QuestNotAvailableError,
} from "@/services/quest.js";
import { getBalance, WpCapExceededError } from "@/services/wp.js";

const app = new Hono().route("/api/quests", questRoutes);
const APP_USER = { id: "u1", email: "a@x.com", referralCode: "ABCD2345", hasDeposited: false };

function post(path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getOrCreateAppUser).mockResolvedValue(APP_USER as any);
  vi.mocked(getBalance).mockResolvedValue(100);
});

describe("GET /api/quests", () => {
  test("returns quest list payload", async () => {
    vi.mocked(listQuestsForUser).mockResolvedValue({
      balance: 100,
      checkin: { currentStreak: 2, checkedInToday: false, nextReward: 4 },
      quests: [],
    } as any);

    const res = await app.request("/api/quests", {
      headers: { authorization: "Bearer x" },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.checkin.currentStreak).toBe(2);
  });
});

describe("POST /api/quests/checkin", () => {
  test("returns reward + balance on success", async () => {
    vi.mocked(checkin).mockResolvedValue({
      alreadyCheckedIn: false,
      streak: 1,
      reward: 1,
    });

    const res = await post("/api/quests/checkin");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ reward: 1, streak: 1, balance: 100 });
  });

  test("maps monthly-cap errors to 429", async () => {
    vi.mocked(checkin).mockRejectedValue(new WpCapExceededError(1000, 1000));
    const res = await post("/api/quests/checkin");
    expect(res.status).toBe(429);
  });
});

describe("POST /api/quests/:key/claim", () => {
  test("returns reward on success", async () => {
    vi.mocked(claimTask).mockResolvedValue({
      alreadyClaimed: false,
      reward: 20,
      base: 20,
      referralBonus: 0,
    });
    const res = await post("/api/quests/follow-x/claim");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reward).toBe(20);
    expect(vi.mocked(claimTask).mock.calls[0][1]).toBe("follow-x");
  });

  test("maps unknown quest to 404", async () => {
    vi.mocked(claimTask).mockRejectedValue(new QuestNotAvailableError("nope"));
    const res = await post("/api/quests/nope/claim");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/quests/sync", () => {
  test("provisions the user and returns balance", async () => {
    vi.mocked(syncAppUser).mockResolvedValue(APP_USER as any);
    const res = await post("/api/quests/sync", { referralCode: "FRIEND01" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.appUser.referralCode).toBe("ABCD2345");
    expect(json.balance).toBe(100);
    // referral code forwarded to the service
    expect(vi.mocked(syncAppUser).mock.calls[0][1]).toBe("FRIEND01");
  });

  test("rejects an invalid referral code with 400", async () => {
    const res = await post("/api/quests/sync", { referralCode: "x" });
    expect(res.status).toBe(400);
    expect(vi.mocked(syncAppUser)).not.toHaveBeenCalled();
  });

  test("R2: IGNORES the body walletAddress, uses the server-derived wallet", async () => {
    // Poisoning app_users.walletAddress via the client body would let an
    // attacker set a victim's address and defeat the reconcile sender check.
    // The handler must pass the server-derived wallet only.
    vi.mocked(syncAppUser).mockResolvedValue(APP_USER as any);
    const victim = "0x000000000000000000000000000000000000bbbb";
    const res = await post("/api/quests/sync", { walletAddress: victim });
    expect(res.status).toBe(200);
    const arg = vi.mocked(syncAppUser).mock.calls[0][0];
    expect(arg.walletAddress).toBe(SERVER_WALLET);
    expect(arg.walletAddress).not.toBe(victim);
  });
});
