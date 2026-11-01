// Fixed-template explanations for the calls a user signs around NiloAgent, read only from the
// calldata. Like explainCalls(), anything that is not exactly a call this app builds is
// reported as unrecognized: wrong contract, wrong function, or an approval to anyone else.
import { type Address, decodeFunctionData } from "viem";
import { agentAbi, erc20Abi, erc4626Abi } from "./abi";
import { type Mandate, mandateFromChain, personalityByCode, unitsToUsdc, vaultInfo } from "./agent";
import type { Call } from "./build";
import { type AppConfig, fromUnits, sameAddress } from "./config";
import { formatUtc } from "./explain";

export type AgentAction = "set_mandate" | "revoke" | "withdraw";

export interface AgentFields {
  action: AgentAction;
  user: string;
  mandate?: Mandate;
  /** USDC (6-decimal units) the agent may draw in total (set_mandate). */
  allowance?: bigint;
  /** Vaults redeemed and shares (withdraw). */
  redeems?: { vault: string; shares: bigint }[];
}

export type AgentExplanation =
  | { kind: "agent"; fields: AgentFields; lines: string[] }
  | { kind: "unrecognized"; reason: string; lines: string[] };

function unrecognized(reason: string): AgentExplanation {
  return { kind: "unrecognized", reason, lines: ["This transaction does not match anything this app builds.", `Reason: ${reason}`, "Do not sign it."] };
}

const usdc = (units: bigint) => `${fromUnits(units)} USDC`;

function period(seconds: number): string {
  if (seconds % 604_800 === 0) return seconds === 604_800 ? "week" : `${seconds / 604_800} weeks`;
  if (seconds % 86_400 === 0) return seconds === 86_400 ? "day" : `${seconds / 86_400} days`;
  return `${seconds} seconds`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tryDecode(abi: any, call: Call): { functionName: string; args: readonly any[] } | null {
  try {
    const d = decodeFunctionData({ abi, data: call.data });
    return { functionName: d.functionName as string, args: (d.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

export function explainAgentCalls(calls: Call[], user: Address, config: AppConfig): AgentExplanation {
  const n = config.network;
  const footer = [`Network: ${n.name} (chain ${n.chainId}).`, "Gas is paid in USDC from your wallet and costs a fraction of a cent."];
  if (calls.length === 0) return unrecognized("there is nothing to sign.");

  const approvals = calls.filter((c) => sameAddress(c.to, n.usdc));
  const agentCalls = calls.filter((c) => sameAddress(c.to, n.agent));
  const vaultCalls = calls.filter((c) => vaultInfo(n, c.to));
  if (approvals.length + agentCalls.length + vaultCalls.length !== calls.length) {
    const other = calls.find((c) => !sameAddress(c.to, n.usdc) && !sameAddress(c.to, n.agent) && !vaultInfo(n, c.to))!;
    return unrecognized(`it calls ${other.to}, which is not USDC, Nilo's agent or a vault Nilo uses.`);
  }
  let approved: bigint | undefined;
  for (const a of approvals) {
    const d = tryDecode(erc20Abi, a);
    if (!d || d.functionName !== "approve") return unrecognized("a USDC call is not an approval.");
    const [spender, value] = d.args as [Address, bigint];
    if (!sameAddress(spender, n.agent)) return unrecognized("an approval lets another contract spend your USDC.");
    approved = value;
  }

  if (vaultCalls.length > 0) {
    if (approvals.length || agentCalls.length) return unrecognized("a withdrawal is mixed with other calls.");
    const redeems: { vault: string; shares: bigint }[] = [];
    for (const c of vaultCalls) {
      const d = tryDecode(erc4626Abi, c);
      if (!d || d.functionName !== "redeem") return unrecognized("a vault call is not a redeem.");
      const [shares, receiver, owner] = d.args as [bigint, Address, Address];
      if (!sameAddress(receiver, user) || !sameAddress(owner, user)) return unrecognized("a redeem pays someone other than you.");
      redeems.push({ vault: c.to, shares });
    }
    return {
      kind: "agent",
      fields: { action: "withdraw", user, redeems },
      lines: [
        ...redeems.map((r) => `Redeems all your shares in ${vaultInfo(n, r.vault)!.name} (${r.vault}), interest included.`),
        `The USDC goes straight to your wallet ${user}. Nilo's agent is not involved.`,
        ...footer,
      ],
    };
  }

  if (agentCalls.length !== 1) return unrecognized(`it makes ${agentCalls.length} calls to Nilo's agent instead of 1.`);
  const d = tryDecode(agentAbi, agentCalls[0]);
  if (!d) return unrecognized("the agent call could not be decoded.");

  if (d.functionName === "setMandate") {
    if (approvals.length > 1 || (approvals.length === 1 && calls[0] !== approvals[0])) return unrecognized("unexpected order of calls.");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mandate = mandateFromChain(d.args[0] as any);
    if (!mandate) return unrecognized("the mandate has no expiry.");
    const unknown = mandate.vaults.find((v) => !vaultInfo(n, v));
    if (unknown) return unrecognized(`the mandate allows vault ${unknown}, which Nilo doesn't use.`);
    const p = personalityByCode(mandate.profile);
    const names = mandate.vaults.map((v) => vaultInfo(n, v)!.name).join(" and ");
    return {
      kind: "agent",
      fields: { action: "set_mandate", user, mandate, allowance: approved },
      lines: [
        ...(approved !== undefined ? [`Lets Nilo's agent contract ${n.agent} draw up to ${usdc(approved)} from your wallet in total.`] : []),
        `Lets Nilo's agent invest up to ${usdc(mandate.limit)} of your USDC per ${period(mandate.period)}, only into ${names}.`,
        `Vault shares are always minted to your own wallet ${user}; the agent can't send your USDC anywhere else.`,
        `It always leaves at least ${usdc(mandate.reserve)} in your wallet, and can only invest until ${formatUtc(mandate.expiresAt)}.`,
        `Personality: ${p ? p.name : mandate.profile}. You can revoke this at any time.`,
        ...footer,
      ],
    };
  }

  if (d.functionName === "revoke") {
    if (approvals.length > 1 || approved !== 0n || (approvals.length === 1 && calls[1] !== approvals[0])) {
      return unrecognized("a revoke must be followed by setting the agent's allowance to 0.");
    }
    return {
      kind: "agent",
      fields: { action: "revoke", user },
      lines: [
        "Ends your mandate: Nilo's agent can no longer invest your USDC, and its USDC allowance becomes 0.",
        "What is already invested stays in your wallet as vault shares, and you can withdraw it at any time.",
        ...footer,
      ],
    };
  }

  return unrecognized(`it calls ${d.functionName}, which users never sign.`);
}

/** Compares a decoded mandate with the one the app asked the user to sign. */
export function mandateMismatches(expl: AgentExplanation, user: string, expected: Mandate, allowance: bigint): string[] {
  if (expl.kind !== "agent" || expl.fields.action !== "set_mandate") return ["the transaction is not a mandate."];
  const f = expl.fields;
  const m = f.mandate!;
  const out: string[] = [];
  if (!sameAddress(f.user, user)) out.push("account");
  if (m.limit !== expected.limit) out.push("limit");
  if (m.period !== expected.period) out.push("period");
  if (m.expiresAt !== expected.expiresAt) out.push("expiry");
  if (m.reserve !== expected.reserve) out.push("reserve");
  if (m.vaults.length !== expected.vaults.length || m.vaults.some((v, i) => !sameAddress(v, expected.vaults[i]))) out.push("vaults");
  if (m.profile !== expected.profile) out.push("personality");
  if (f.allowance !== undefined && f.allowance !== allowance) out.push("allowance");
  return out;
}

export { unitsToUsdc };
