import { type Address, type Hex, encodeFunctionData, zeroHash } from "viem";
import { erc20Abi, paymentsAbi } from "./abi";
import { type AppConfig, toUnits } from "./config";
import type { ResolvedIntent } from "./validate";

/** One contract call the user's wallet sends as its own transaction, in order. */
export interface Call {
  to: Address;
  data: Hex;
}

export interface BuiltSend {
  calls: Call[];
  /** Unix seconds. Recipient can claim strictly before it; sender can recover from it on. */
  deadline: number;
}

/**
 * Escrows the payment in NiloPayments. When the current allowance doesn't cover the amount,
 * an approval of exactly that amount comes first.
 */
export function buildSendCalls(intent: ResolvedIntent, allowance: bigint, config: AppConfig, now: Date = new Date()): BuiltSend {
  const deadline = Math.floor(now.getTime() / 1000) + intent.deadlineSeconds;
  const amount = toUnits(intent.amount);
  const { payments, usdc } = config.network;
  const calls: Call[] = [];
  if (allowance < amount) {
    calls.push({ to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [payments, amount] }) });
  }
  calls.push({
    to: payments,
    data: encodeFunctionData({ abi: paymentsAbi, functionName: "send", args: [intent.recipient, amount, BigInt(deadline), zeroHash] }),
  });
  return { calls, deadline };
}

/** The recipient claims (before the deadline), or the sender recovers (from the deadline on). */
export function buildClaimCall(id: string, role: "recipient" | "sender", config: AppConfig): Call {
  return {
    to: config.network.payments,
    data: encodeFunctionData({ abi: paymentsAbi, functionName: role === "recipient" ? "claim" : "recover", args: [BigInt(id)] }),
  };
}
