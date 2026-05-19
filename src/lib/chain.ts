/**
 * Single source of truth for the on-chain network the backend reads from.
 *
 * The platform only ever runs on Ethereum mainnet (production) or the Sepolia
 * testnet. The network is selected via `ETHEREUM_CHAIN_ID`.
 *
 * Fail-fast: an unset or unsupported chain id throws a clear error instead of
 * silently defaulting to mainnet (which previously risked reading the wrong
 * network's balances / receipts). The two callers (reconcile + treasury
 * balance) already wrap this in try/catch and degrade gracefully, so a
 * misconfiguration is logged loudly rather than acted on against mainnet.
 *
 * Explorer URLs MUST be derived from here — never hardcode an explorer base
 * URL elsewhere.
 */

import { mainnet, sepolia } from "viem/chains";

const MAINNET = {
  chain: mainnet,
  network: "mainnet" as const,
  explorerBaseUrl: "https://etherscan.io",
};

const SEPOLIA = {
  chain: sepolia,
  network: "sepolia" as const,
  explorerBaseUrl: "https://sepolia.etherscan.io",
};

export function resolveChain(): typeof MAINNET | typeof SEPOLIA {
  const raw = process.env.ETHEREUM_CHAIN_ID;
  if (!raw) {
    throw new Error(
      "ETHEREUM_CHAIN_ID is not set. Set it to 1 (Ethereum mainnet) or 11155111 (Sepolia testnet).",
    );
  }
  const chainId = Number(raw);
  if (chainId === mainnet.id) return MAINNET;
  if (chainId === sepolia.id) return SEPOLIA;
  throw new Error(
    `Unsupported ETHEREUM_CHAIN_ID="${raw}". Supported: 1 (Ethereum mainnet), 11155111 (Sepolia testnet).`,
  );
}

/** Block-explorer URL for a transaction hash. */
export function explorerTxUrl(txHash: string): string {
  return `${resolveChain().explorerBaseUrl}/tx/${txHash}`;
}

/** Block-explorer URL for an address. */
export function explorerAddressUrl(address: string): string {
  return `${resolveChain().explorerBaseUrl}/address/${address}`;
}
