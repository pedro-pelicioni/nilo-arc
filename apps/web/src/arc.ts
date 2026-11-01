// Read-only Arc access. Signing goes through the user's own wallet (see wallet.tsx).
import {
  type BalanceView,
  type NetworkId,
  type OnchainPayment,
  arcChain,
  erc20Abi,
  erc4626Abi,
  explorerTx as txLink,
  makeConfig,
  paymentsAbi,
  viewBalance,
} from "@nilo/core";
import { type Address, createPublicClient, http, zeroAddress } from "viem";

const NETWORK = ((import.meta.env.VITE_ARC_NETWORK as string | undefined) ?? "testnet") as NetworkId;

export const config = makeConfig(NETWORK);
export const network = config.network;
export const chain = arcChain(network);
export const publicClient = createPublicClient({ chain, transport: http(network.rpcUrl) });

/** False until Nilo's contracts are deployed on this network. */
export const contractsReady = network.payments !== zeroAddress && network.agent !== zeroAddress;

export const explorerTx = (hash: string) => txLink(network, hash);

/** USDC in the wallet, 6-decimal units. On Arc this is also the gas balance. */
export function usdcBalance(address: Address): Promise<bigint> {
  return publicClient.readContract({ address: network.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });
}

export function usdcAllowance(owner: Address, spender: Address): Promise<bigint> {
  return publicClient.readContract({ address: network.usdc, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
}

/** Vault shares the address holds. */
export function vaultShares(vault: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: vault, abi: erc4626Abi, functionName: "balanceOf", args: [owner] });
}

/** Every payment the address sent or received, newest first (settled ones included). */
export async function fetchPayments(address: Address): Promise<{ id: bigint; payment: OnchainPayment }[]> {
  if (!contractsReady) return [];
  const [sent, received] = await Promise.all([
    publicClient.readContract({ address: network.payments, abi: paymentsAbi, functionName: "sentBy", args: [address] }),
    publicClient.readContract({ address: network.payments, abi: paymentsAbi, functionName: "receivedBy", args: [address] }),
  ]);
  const ids = [...new Set([...sent, ...received])].sort((a, b) => (a > b ? -1 : 1)).slice(0, 100);
  if (ids.length === 0) return [];
  const rows = await publicClient.readContract({ address: network.payments, abi: paymentsAbi, functionName: "getPayments", args: [ids] });
  return rows.map((p, i) => ({ id: ids[i], payment: { ...p, amount: BigInt(p.amount) } }));
}

/** Pending payments where the address is on `role`'s side, newest first. */
export async function loadPayments(address: Address, role: BalanceView["role"], nowSec: number): Promise<BalanceView[]> {
  const rows = await fetchPayments(address);
  return rows.map((r) => viewBalance(r.id, r.payment, address, nowSec, config)).filter((v): v is BalanceView => v?.role === role);
}

/** Has Nilo's relayer submit a claim the recipient signed (EIP-712), paying the gas. Returns the tx hash. */
export async function requestSponsoredClaim(body: { id: string; sigDeadline: number; signature: string; claimant: string }): Promise<string> {
  const res = await fetch("/api/sponsor-claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || typeof json.hash !== "string") throw new Error(json.message ?? `Relayer unavailable (${res.status}).`);
  return json.hash;
}

/** Below this, the app points new users at Circle's faucet. */
export const FAUCET_BELOW = 1_000_000n;
