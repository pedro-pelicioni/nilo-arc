// Claiming a pending payment, as the recipient or as the sender recovering it after the
// deadline. Used by the Claim and Sent pages and by voice mode in the chat.
import { type BalanceView, type Explanation, buildClaimCall, sameAddress } from "@nilo/core";
import type { Address } from "viem";
import { config, usdcBalance } from "./arc";
import type { Prepared } from "./components/SignPanel";

export { loadPayments } from "./arc";

/** Block times can trail the local clock by a second or two. */
export const CLOCK_MARGIN = 3;
/**
 * Below this USDC balance a recipient claims gaslessly: Nilo's relayer pays the gas. A claim costs about
 * 0.001 USDC of gas, so anyone above it pays their own, which never depends on the relayer being up.
 */
const SPONSOR_BELOW = 3_000n;
/** How long a gasless claim signature stays usable. */
const SIG_SECONDS = 10 * 60;

/** Whether the claim can be signed now; a recovery waits a few seconds past the deadline. */
export function claimReady(v: BalanceView, nowSec: number): boolean {
  return v.claimableNow && (v.role === "recipient" || !v.deadline || nowSec >= v.deadline + CLOCK_MARGIN);
}

/**
 * Builds the claim (recipient) or recovery (sender) of `v`. A recipient with almost no USDC
 * can't pay gas on Arc, so it signs a message instead and Nilo's relayer submits the claim.
 */
export async function prepareClaim(v: BalanceView, address: Address): Promise<Prepared> {
  const check = (e: Explanation) => {
    if (e.kind !== "claim") return ["transaction type"];
    const out: string[] = [];
    if (e.fields.id !== v.id) out.push("payment");
    if (!sameAddress(e.fields.claimant, address)) out.push("account");
    if (e.fields.role !== v.role) out.push("claim or recovery");
    return out;
  };
  if (v.role === "recipient" && (await usdcBalance(address)) < SPONSOR_BELOW) {
    const sigDeadline = Math.min(Math.floor(Date.now() / 1000) + SIG_SECONDS, v.deadline ?? Infinity);
    return { sponsored: { id: v.id, sigDeadline }, check };
  }
  return { calls: [buildClaimCall(v.id, v.role, config)], check };
}
