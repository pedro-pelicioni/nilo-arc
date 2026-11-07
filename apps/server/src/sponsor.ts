// Sponsored claims: on Arc the gas is paid in USDC, so a recipient whose wallet is empty
// couldn't claim a payment sent to them. The recipient signs an EIP-712 message instead,
// and Nilo's operator submits claimFor and pays the gas. The contract only ever pays the
// payment's recipient; the server checks the payment and the signature before spending gas.
import { type Address, type Hex, isAddress } from "viem";
import { CLAIM_TYPES, PAYMENT_PENDING, claimDomain, erc20Abi, paymentsAbi, sameAddress } from "@nilo/core";
import { z } from "zod";
import { ChainError, chain, getRpc, network, operator, operatorWallet, requireContract, serial, txLink } from "./chain";

export const SponsorRequest = z.object({
  id: z.string().regex(/^\d{1,30}$/),
  /** Unix seconds the signature is valid until. */
  sigDeadline: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/).max(2000),
  claimant: z.string().refine((s) => isAddress(s, { strict: false }), "not a 0x address"),
});

export { ChainError as SponsorError };

const HOUR = 60 * 60_000;
export const LIMITS = {
  /** A signature may be valid for at most this long. */
  maxSigSeconds: 3600,
  /** Relayed claims per recipient per hour. */
  perClaimant: 10,
  /** Relayed claims for the whole server per hour: anyone can make a new wallet. */
  perHour: 120,
  /** Relayed claims of payments from one sender per hour, so one sender can't drain the relayer through many wallets. */
  perSender: 20,
  /** Only wallets below this (6-decimal units) get a free claim: the rest can pay their own gas. */
  emptyBelow: 50_000n,
  /** A claim must leave this much time before the deadline, so one mined a block late still counts. */
  deadlineMarginSeconds: 5,
};

/** Recipient → times of relayed claims in the last hour. */
const byClaimant = new Map<string, number[]>();
/** Sender → times of relayed claims of their payments in the last hour. */
const bySender = new Map<string, number[]>();
let recent: number[] = [];
/** Payment ids relayed or being relayed: each is claimed at most once. */
const relayed = new Set<string>();

function prune(now: number) {
  for (const map of [byClaimant, bySender]) {
    for (const [address, times] of map) {
      const kept = times.filter((t) => t > now - HOUR);
      if (kept.length) map.set(address, kept);
      else map.delete(address);
    }
  }
  recent = recent.filter((t) => t > now - HOUR);
}

/** Takes a slot in every limit at once, before any await, so concurrent requests can't all pass. Returns the undo. */
function reserve(claimant: string, now: number): () => void {
  byClaimant.set(claimant, [...(byClaimant.get(claimant) ?? []), now]);
  recent.push(now);
  return () => {
    const times = byClaimant.get(claimant) ?? [];
    times.splice(times.lastIndexOf(now), 1);
    recent.splice(recent.lastIndexOf(now), 1);
  };
}

/** Checks the payment and the signature, then submits the claim with the operator key. */
export async function sponsorClaim(req: z.infer<typeof SponsorRequest>): Promise<{ hash: string; link: string }> {
  const payments = requireContract("payments");
  operator();
  const id = BigInt(req.id);
  const claimant = req.claimant.toLowerCase() as Address;
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  if (req.sigDeadline <= nowSec) throw new ChainError("The signature has expired. Sign the claim again.", 409);
  if (req.sigDeadline > nowSec + LIMITS.maxSigSeconds) throw new ChainError("The signature is valid for too long (at most 1 hour).");
  if (relayed.has(req.id)) throw new ChainError("This payment is already being claimed.", 409);
  prune(now);
  if ((byClaimant.get(claimant)?.length ?? 0) >= LIMITS.perClaimant) {
    throw new ChainError("This wallet claimed too many payments for free this hour. Try again later, or claim paying the gas.", 429);
  }
  if (recent.length >= LIMITS.perHour) throw new ChainError("Free claims are busy this hour. Claim paying the gas instead.", 429);
  // Every limit is taken before the first await, so concurrent requests can't all pass the checks.
  relayed.add(req.id);
  const release = reserve(claimant, now);
  /** Set once claimFor is broadcast: from then on the id stays taken, even if waiting for the receipt fails. */
  let broadcast = false;
  try {
    // The contract reverts BadPayment for an id it never issued.
    const payment = await getRpc().readContract({ address: payments, abi: paymentsAbi, functionName: "payments", args: [id] }).catch((e) => {
      if (/BadPayment/.test(String((e as Error)?.message ?? e))) throw new ChainError("There is no such payment.", 404);
      throw e;
    });
    const { from, to, claimUntil, status } = payment;
    if (status !== PAYMENT_PENDING) throw new ChainError("This payment was already claimed or recovered.", 409);
    if (!sameAddress(to, claimant)) throw new ChainError(sameAddress(from, claimant) ? "Only the recipient's claim is sponsored." : "This payment is not for this wallet.", 409);
    if (nowSec + LIMITS.deadlineMarginSeconds >= Number(claimUntil)) {
      throw new ChainError("The deadline has passed (or is seconds away): this payment can no longer be claimed.", 409);
    }
    const sender = from.toLowerCase();
    if ((bySender.get(sender)?.length ?? 0) >= LIMITS.perSender) {
      throw new ChainError("Too many free claims of this sender's payments this hour. Claim paying the gas instead.", 429);
    }
    // Free claims are for wallets that can't pay the gas themselves.
    const balance = await getRpc().readContract({ address: network.usdc, abi: erc20Abi, functionName: "balanceOf", args: [claimant] });
    if (balance >= LIMITS.emptyBelow) throw new ChainError("Your wallet has USDC for gas, so claim paying it yourself (a fraction of a cent).", 409);

    // The public client also accepts smart-account (ERC-1271) signatures, like the contract does.
    const valid = await getRpc()
      .verifyTypedData({
        address: claimant,
        domain: claimDomain(chain.id, payments),
        types: CLAIM_TYPES,
        primaryType: "Claim",
        message: { id, deadline: BigInt(req.sigDeadline) },
        signature: req.signature as Hex,
      })
      .catch(() => false);
    if (!valid) throw new ChainError("The signature is not from this payment's recipient.", 400);

    bySender.set(sender, [...(bySender.get(sender) ?? []), now]);
    const hash = await serial(async () => {
      const { request } = await getRpc().simulateContract({
        account: operator(),
        address: payments,
        abi: paymentsAbi,
        functionName: "claimFor",
        args: [id, BigInt(req.sigDeadline), req.signature as Hex],
      });
      const sent = await operatorWallet().writeContract(request);
      broadcast = true;
      const receipt = await getRpc().waitForTransactionReceipt({ hash: sent, timeout: 30_000 });
      if (receipt.status !== "success") throw new ChainError("The claim was submitted but the network reverted it.", 409);
      return sent;
    });
    return { hash, link: txLink(hash) };
  } catch (e) {
    if (!broadcast) {
      relayed.delete(req.id);
      release();
    }
    if (e instanceof ChainError) throw e;
    const message = String((e as Error)?.message ?? e);
    if (/insufficient funds/i.test(message)) throw new ChainError("Nilo's relayer is out of gas right now. Claim paying the gas instead.", 503);
    if (/NotPending|Expired|NotRecipient/.test(message)) {
      throw new ChainError("The contract refused the claim: it was already claimed or the deadline passed.", 409);
    }
    if (/BadSignature/.test(message)) {
      throw new ChainError("The contract didn't accept this wallet's signature for a free claim. Claim paying the gas instead.", 409);
    }
    if (broadcast) throw new ChainError("The claim was sent; check the Claim page in a moment before trying again.", 409);
    throw e;
  }
}
