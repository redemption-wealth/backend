import { describe, test, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const getTransactionReceipt = vi.fn();
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ getTransactionReceipt })),
  };
});

vi.mock("@/db.js", () => {
  const models = {
    redemption: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    redemptionSlot: { updateMany: vi.fn(), count: vi.fn() },
    qrCode: { updateMany: vi.fn() },
    voucher: { update: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { ...models };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

vi.mock("@/services/qr-generator.js", () => ({
  generateQrCode: vi.fn(),
  generateUploadedAsset: vi.fn(),
  deleteQrFiles: vi.fn(),
}));

import { prisma } from "@/db.js";
import { reconcileRedemptionById } from "@/services/redemption.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const TREASURY = "0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01";
const WEALTH = "0xafa702c0a2a3a0cf1bd09435db61c913ccde8546";
const PAYER = "0x404392cfcc5f2ced743066b64c28cc436c58bf34";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AMOUNT = new Prisma.Decimal("0.164100960789953904");
const TX = "0x" + "5c".repeat(32);

function pad(a: string) {
  return "0x" + a.slice(2).padStart(64, "0");
}
function transferLog(opts: { token?: string; to?: string; wei?: bigint }) {
  return {
    address: opts.token ?? WEALTH,
    topics: [TRANSFER_TOPIC, pad(PAYER), pad(opts.to ?? TREASURY)],
    data: `0x${(opts.wei ?? 164100960789953904n).toString(16)}`,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  process.env.ALCHEMY_RPC_URL = "https://rpc.test";
  process.env.ETHEREUM_CHAIN_ID = "1";
  process.env.DEV_WALLET_ADDRESS = TREASURY;
  process.env.WEALTH_CONTRACT_ADDRESS = WEALTH;
  db.redemption.findUnique.mockResolvedValue({
    id: "red1",
    status: "PENDING",
    txHash: TX,
    wealthAmount: AMOUNT,
  });
  // confirmRedemption internals (only reached on a valid payment)
  db.redemption.findFirst.mockResolvedValue({ id: "red1", voucherId: "v1" });
  db.redemption.updateMany.mockResolvedValue({ count: 1 });
  db.redemption.findUniqueOrThrow.mockResolvedValue({ id: "red1" });
  db.redemptionSlot.count.mockResolvedValue(0);
  db.voucher.update.mockResolvedValue({});
});

describe("reconcileRedemptionById — a bare success is NOT proof of payment (C1)", () => {
  test("valid $WEALTH→treasury payment of the right amount → CONFIRMED", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({})],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: true, status: "CONFIRMED" });
  });

  test("EXPLOIT: unrelated successful tx (no treasury transfer) → REFUSED, not confirmed", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [], // some random successful tx the user submitted
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
    // confirmRedemption's claim updateMany must never have run.
    expect(db.redemption.updateMany).not.toHaveBeenCalled();
  });

  test("success but transfer goes to a DIFFERENT address → REFUSED", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ to: "0x" + "99".repeat(20) })],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
  });

  test("success but wrong token → REFUSED", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ token: "0x" + "12".repeat(20) })],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
  });

  test("success but wrong amount → REFUSED", async () => {
    getTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [transferLog({ wei: 1n })],
    });
    const out = await reconcileRedemptionById("red1");
    expect(out).toEqual({ reconciled: false, reason: "not-a-payment" });
  });
});
