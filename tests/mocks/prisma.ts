import { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";
import { beforeEach, vi } from "vitest";

vi.mock("@/db.js", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

// Import after mock setup
const { prisma } = await import("@/db.js");

beforeEach(() => {
  mockReset(prismaMock);
});

export const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
