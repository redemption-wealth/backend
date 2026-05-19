import { describe, test, expect, afterEach } from "vitest";
import {
  resolveChain,
  explorerTxUrl,
  explorerAddressUrl,
} from "@/lib/chain.js";

const ORIGINAL = process.env.ETHEREUM_CHAIN_ID;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ETHEREUM_CHAIN_ID;
  else process.env.ETHEREUM_CHAIN_ID = ORIGINAL;
});

// Handover §4 — network selection fail-fast, explorer derived from chain
describe("resolveChain", () => {
  test("positive: chainId 1 → Ethereum mainnet + Etherscan", () => {
    process.env.ETHEREUM_CHAIN_ID = "1";
    const c = resolveChain();
    expect(c.network).toBe("mainnet");
    expect(c.chain.id).toBe(1);
    expect(c.explorerBaseUrl).toBe("https://etherscan.io");
  });

  test("positive: chainId 11155111 → Sepolia + sepolia.etherscan", () => {
    process.env.ETHEREUM_CHAIN_ID = "11155111";
    const c = resolveChain();
    expect(c.network).toBe("sepolia");
    expect(c.chain.id).toBe(11155111);
    expect(c.explorerBaseUrl).toBe("https://sepolia.etherscan.io");
  });

  test("negative: unset throws (no silent mainnet default)", () => {
    delete process.env.ETHEREUM_CHAIN_ID;
    expect(() => resolveChain()).toThrow(/ETHEREUM_CHAIN_ID is not set/);
  });

  test("negative: empty string throws", () => {
    process.env.ETHEREUM_CHAIN_ID = "";
    expect(() => resolveChain()).toThrow(/ETHEREUM_CHAIN_ID is not set/);
  });

  test("negative: unsupported chain id (137 Polygon) throws", () => {
    process.env.ETHEREUM_CHAIN_ID = "137";
    expect(() => resolveChain()).toThrow(/Unsupported ETHEREUM_CHAIN_ID/);
  });

  test("edge: non-numeric value throws as unsupported", () => {
    process.env.ETHEREUM_CHAIN_ID = "mainnet";
    expect(() => resolveChain()).toThrow(/Unsupported ETHEREUM_CHAIN_ID/);
  });
});

describe("explorer URL helpers", () => {
  test("positive: explorerTxUrl on mainnet", () => {
    process.env.ETHEREUM_CHAIN_ID = "1";
    expect(explorerTxUrl("0xabc")).toBe("https://etherscan.io/tx/0xabc");
  });

  test("positive: explorerAddressUrl on Sepolia", () => {
    process.env.ETHEREUM_CHAIN_ID = "11155111";
    expect(explorerAddressUrl("0xdead")).toBe(
      "https://sepolia.etherscan.io/address/0xdead",
    );
  });

  test("negative: helpers propagate fail-fast when chain unset", () => {
    delete process.env.ETHEREUM_CHAIN_ID;
    expect(() => explorerTxUrl("0xabc")).toThrow(/ETHEREUM_CHAIN_ID is not set/);
  });
});
