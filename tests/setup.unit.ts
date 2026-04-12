import { vi } from "vitest";

// Mock Privy client for unit tests
class MockPrivyClient {
  verifyAuthToken = vi.fn();
  getUser = vi.fn();
}

vi.mock("@privy-io/server-auth", () => ({
  PrivyClient: MockPrivyClient,
}));
