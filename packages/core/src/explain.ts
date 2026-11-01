// Turns the calls a wallet is about to send into plain English using fixed templates.
// It reads only the calldata: no LLM, no intent, no chain data. Anything that does
// not match one of the exact shapes this app builds is reported as unrecognized.
import { type Address, decodeFunctionData } from "viem";
import { erc20Abi, paymentsAbi } from "./abi";
import type { Call } from "./build";
import { type AppConfig, type AssetSpec, fromUnits, nicknameFor, sameAddress, toUnits } from "./config";
import type { ResolvedIntent } from "./validate";

export interface SendFields {
  source: string;
  recipient: string;
  recipientName?: string;
  amount: string;
  asset: AssetSpec;
  /** Unix seconds. */
  deadline: number;
  /** Set when the calls start with a USDC approval for the payments contract (always the amount itself). */
  approval?: string;
}

export interface ClaimFields {
  /** Wallet that receives the funds. */
  claimant: string;
  /** "recipient" claims before the deadline; "sender" recovers after it. */
  role: "recipient" | "sender";
  /** Payment id in NiloPayments. */
  id: string;
  /** Nilo's relayer submits it and pays the gas; the wallet only signs a message. */
  sponsored: boolean;
  /** Unix seconds the signature stays usable, for a sponsored claim. */
  validUntil?: number;
}

export type Explanation =
  | { kind: "send"; fields: SendFields; lines: string[] }
  | { kind: "claim"; fields: ClaimFields; lines: string[] }
  | { kind: "unrecognized"; reason: string; lines: string[] };

export function formatUtc(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function unrecognized(reason: string): Explanation {
  return {
    kind: "unrecognized",
    reason,
    lines: ["This transaction does not match anything this app builds.", `Reason: ${reason}`, "Do not sign it."],
  };
}

const footer = (config: AppConfig) => [
  `Network: ${config.network.name} (chain ${config.network.chainId}).`,
  "Gas is paid in USDC from your wallet and costs a fraction of a cent.",
];

function decode<T extends typeof erc20Abi | typeof paymentsAbi>(abi: T, call: Call) {
  try {
    return decodeFunctionData({ abi, data: call.data });
  } catch {
    return null;
  }
}

export function explainCalls(calls: Call[], from: Address, config: AppConfig): Explanation {
  const { payments, usdc } = config.network;
  if (calls.length === 0) return unrecognized("there is nothing to sign.");
  const last = calls[calls.length - 1];
  if (!sameAddress(last.to, payments)) return unrecognized(`it calls ${last.to}, not Nilo's payments contract.`);
  const call = decode(paymentsAbi, last);
  if (!call) return unrecognized("the call could not be decoded.");

  if (call.functionName === "send") {
    const [to, amount, claimUntil] = call.args as readonly [Address, bigint, bigint, string];
    if (calls.length > 2) return unrecognized(`it has ${calls.length} calls instead of at most 2.`);
    let approval: string | undefined;
    if (calls.length === 2) {
      const first = calls[0];
      if (!sameAddress(first.to, usdc)) return unrecognized(`the first call goes to ${first.to}, not USDC.`);
      const a = decode(erc20Abi, first);
      if (!a || a.functionName !== "approve") return unrecognized("the first call is not a USDC approval.");
      const [spender, value] = a.args as readonly [Address, bigint];
      if (!sameAddress(spender, payments)) return unrecognized("the approval lets another contract spend your USDC.");
      if (value !== amount) return unrecognized(`the approval (${fromUnits(value)} USDC) is not the payment amount.`);
      approval = fromUnits(value);
    }
    if (sameAddress(to, from)) return unrecognized("the recipient is the paying wallet.");
    const fields: SendFields = {
      source: from,
      recipient: to,
      recipientName: nicknameFor(config, to),
      amount: fromUnits(amount),
      asset: config.assets[0],
      deadline: Number(claimUntil),
      approval,
    };
    const who = fields.recipientName ? `${to} ("${fields.recipientName}")` : to;
    return {
      kind: "send",
      fields,
      lines: [
        ...(approval ? [`Lets Nilo's payments contract take exactly ${approval} USDC from your wallet, once.`] : []),
        `Sends ${fields.amount} USDC from your wallet ${from} into escrow in Nilo's payments contract ${payments}.`,
        `Recipient: ${who}.`,
        `The recipient can claim it until ${formatUtc(fields.deadline)}.`,
        `From ${formatUtc(fields.deadline)} on, the recipient can no longer claim, and only you can recover the funds.`,
        ...footer(config),
      ],
    };
  }

  if (call.functionName === "claim" || call.functionName === "recover") {
    if (calls.length !== 1) return unrecognized(`it has ${calls.length} calls instead of 1.`);
    const [id] = call.args as readonly [bigint];
    const role = call.functionName === "claim" ? "recipient" : "sender";
    const fields: ClaimFields = { claimant: from, role, id: id.toString(), sponsored: false };
    return {
      kind: "claim",
      fields,
      lines: [
        role === "recipient"
          ? `Claims payment #${id} from Nilo's payments contract into your wallet ${from}.`
          : `Recovers your unclaimed payment #${id} from Nilo's payments contract back into your wallet ${from}.`,
        "The contract only pays the wallet the payment names; nobody else can receive it.",
        ...footer(config),
      ],
    };
  }

  return unrecognized(`unexpected function ${call.functionName}.`);
}

/** A gasless claim: the wallet signs an EIP-712 message and Nilo's relayer submits `claimFor`, paying the gas. */
export function explainSponsoredClaim(id: string, sigDeadline: number, claimant: string, config: AppConfig): Explanation {
  const fields: ClaimFields = { claimant, role: "recipient", id, sponsored: true, validUntil: sigDeadline };
  return {
    kind: "claim",
    fields,
    lines: [
      `Signs a message that lets anyone submit the claim of payment #${id} to your wallet ${claimant}.`,
      "The contract only pays the wallet the payment names; whoever submits it receives nothing.",
      `Nilo's relayer submits it and pays the gas, so your balance doesn't need any USDC for this.`,
      `The signature can only be used until ${formatUtc(sigDeadline)}.`,
      `Network: ${config.network.name} (chain ${config.network.chainId}).`,
    ],
  };
}

/**
 * Compares what the calls say with what was validated. Any mismatch means the
 * builder and the explanation disagree, and the UI must refuse to sign.
 */
export function mismatches(expl: Explanation, expected: ResolvedIntent, source: string, deadline: number): string[] {
  if (expl.kind !== "send") return ["the transaction is not a send."];
  const f = expl.fields;
  const out: string[] = [];
  if (!sameAddress(f.source, source)) out.push("source account");
  if (!sameAddress(f.recipient, expected.recipient)) out.push("recipient");
  if (toUnits(f.amount) !== toUnits(expected.amount)) out.push("amount");
  if (f.asset.code !== expected.asset.code) out.push("asset");
  if (f.deadline !== deadline) out.push("deadline");
  return out;
}
