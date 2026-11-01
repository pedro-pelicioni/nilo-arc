// The NiloAgent mandate: what a user lets Nilo's agent do with their USDC while
// they are away, and the contract calls that set it up or act on it. Pure: no network.
import { type Address, encodeFunctionData } from "viem";
import { agentAbi, erc20Abi, erc4626Abi } from "./abi";
import type { Call } from "./build";
import { type ArcNetwork, type VaultInfo, UNITS_PER_USDC, sameAddress } from "./config";

export type PersonalityId = "guardian" | "balanced" | "explorer";
export const PROFILE_CODES: Record<PersonalityId, number> = { guardian: 0, balanced: 1, explorer: 2 };

/** Presets for people who don't want to write their own rules. */
export interface Personality {
  id: PersonalityId;
  name: string;
  /** Matches the investor profile from onboarding. */
  profile: "conservative" | "moderate" | "aggressive";
  summary: string;
  /** Share of each investment per vault slot, in basis points (sums to 10,000). */
  weights: Partial<Record<VaultInfo["slot"], number>>;
  /** Most the agent may invest per week, in USDC. */
  weeklyLimit: number;
  /** USDC the agent always leaves in the wallet (it also pays your gas on Arc). */
  keep: number;
}

export const PERSONALITIES: Personality[] = [
  {
    id: "guardian",
    name: "Guardian",
    profile: "conservative",
    summary: "Everything in the deepest, steadiest Morpho USDC vault.",
    weights: { prime: 10_000 },
    weeklyLimit: 50,
    keep: 2,
  },
  {
    id: "balanced",
    name: "Balanced",
    profile: "moderate",
    summary: "Mostly the steady vault; some in a higher-yield Morpho vault.",
    weights: { prime: 6_000, yield: 4_000 },
    weeklyLimit: 100,
    keep: 1,
  },
  {
    id: "explorer",
    name: "Explorer",
    profile: "aggressive",
    summary: "Most in the higher-yield Morpho vault; the rest in the steady one.",
    weights: { prime: 3_000, yield: 7_000 },
    weeklyLimit: 250,
    keep: 0.5,
  },
];

export const personalityFor = (profile: Personality["profile"]) => PERSONALITIES.find((p) => p.profile === profile)!;
export const personality = (id: string) => PERSONALITIES.find((p) => p.id === id);
export const personalityByCode = (code: number) => PERSONALITIES.find((p) => PROFILE_CODES[p.id] === code);

/** What the contract stores for a user. Amounts in 6-decimal USDC units. */
export interface Mandate {
  limit: bigint;
  period: number;
  expiresAt: number;
  reserve: bigint;
  profile: number;
  vaults: Address[];
}

export const WEEK_SECONDS = 7 * 86_400;

export const usdcToUnits = (usdc: number) => BigInt(Math.round(usdc * 1e6));
export const unitsToUsdc = (units: bigint) => Number(units) / 1e6;

export function vaultsFor(p: Personality, n: ArcNetwork): VaultInfo[] {
  return n.vaults.filter((v) => (p.weights[v.slot] ?? 0) > 0);
}

export const vaultInfo = (n: ArcNetwork, address: string) => n.vaults.find((v) => sameAddress(v.address, address));

/** Bounds for rules a user writes in the chat. */
export const MAX_WEEKLY_LIMIT = 1_000;
export const MAX_MANDATE_DAYS = 90;

/** A mandate from a personality, optionally with the user's own weekly limit and length. Throws on rules out of bounds. */
export function mandateFrom(p: Personality, n: ArcNetwork, now: number, days = 30, weeklyLimit = p.weeklyLimit): Mandate {
  if (!Number.isInteger(days) || days < 1 || days > MAX_MANDATE_DAYS) {
    throw new Error(`A mandate lasts a whole number of days, from 1 to ${MAX_MANDATE_DAYS}.`);
  }
  if (!Number.isFinite(weeklyLimit) || weeklyLimit < 0.01 || weeklyLimit > MAX_WEEKLY_LIMIT) {
    throw new Error(`The weekly limit must be between 0.01 and ${MAX_WEEKLY_LIMIT} USDC.`);
  }
  return {
    limit: usdcToUnits(weeklyLimit),
    period: WEEK_SECONDS,
    expiresAt: now + days * 86_400,
    reserve: usdcToUnits(p.keep),
    profile: PROFILE_CODES[p.id],
    vaults: vaultsFor(p, n).map((v) => v.address),
  };
}

/** Allowance that covers every period until the mandate expires. */
export function allowanceFor(m: Mandate, now: number): bigint {
  const periods = BigInt(Math.max(1, Math.ceil((m.expiresAt - now) / m.period)));
  return m.limit * periods;
}

/** Smallest leg the agent deposits: the vault would mint almost nothing below it. */
export const MIN_LEG_UNITS = UNITS_PER_USDC / 100n;

/**
 * How the agent splits `available` units across the mandate's vaults by the personality's weights.
 * A slot the mandate doesn't include gives its share to the first vault; so does the rounding remainder.
 * A leg below MIN_LEG_UNITS joins the largest leg, so a small amount still goes somewhere whole.
 */
export function split(available: bigint, p: Personality, vaults: Address[], n: ArcNetwork): { vault: Address; amount: bigint }[] {
  const infos = vaults.map((a) => vaultInfo(n, a)).filter((v): v is VaultInfo => !!v);
  if (available < MIN_LEG_UNITS || infos.length === 0) return [];
  const legs = infos.map((v) => ({ vault: v.address, amount: (available * BigInt(p.weights[v.slot] ?? 0)) / 10_000n }));
  legs[0].amount += available - legs.reduce((s, l) => s + l.amount, 0n);
  const largest = legs.reduce((a, b) => (b.amount > a.amount ? b : a));
  for (const l of legs) {
    if (l !== largest && l.amount < MIN_LEG_UNITS) {
      largest.amount += l.amount;
      l.amount = 0n;
    }
  }
  return legs.filter((l) => l.amount > 0n);
}

const toTuple = (m: Mandate) => ({
  limit: m.limit,
  period: BigInt(m.period),
  expiresAt: BigInt(m.expiresAt),
  reserve: m.reserve,
  profile: m.profile,
  vaults: m.vaults,
});

export function mandateFromChain(v: {
  limit: bigint;
  period: bigint;
  expiresAt: bigint;
  reserve: bigint;
  profile: number;
  vaults: readonly Address[];
}): Mandate | null {
  if (v.expiresAt === 0n) return null;
  return {
    limit: v.limit,
    period: Number(v.period),
    expiresAt: Number(v.expiresAt),
    reserve: v.reserve,
    profile: Number(v.profile),
    vaults: [...v.vaults],
  };
}

/** Approval (when the current one is short) and the mandate itself: what the user signs once. */
export function setMandateCalls(m: Mandate, allowance: bigint, currentAllowance: bigint, n: ArcNetwork): Call[] {
  const calls: Call[] = [];
  if (currentAllowance !== allowance) {
    calls.push({ to: n.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [n.agent, allowance] }) });
  }
  calls.push({ to: n.agent, data: encodeFunctionData({ abi: agentAbi, functionName: "setMandate", args: [toTuple(m)] }) });
  return calls;
}

/** Ends the mandate and zeroes the agent's allowance. Vault shares stay in the wallet. */
export function revokeCalls(n: ArcNetwork): Call[] {
  return [
    { to: n.agent, data: encodeFunctionData({ abi: agentAbi, functionName: "revoke" }) },
    { to: n.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [n.agent, 0n] }) },
  ];
}

/** Redeems every vault share the user holds, straight to the user's wallet. Nilo is not involved. */
export function withdrawCalls(user: Address, positions: { vault: Address; shares: bigint }[]): Call[] {
  return positions
    .filter((p) => p.shares > 0n)
    .map((p) => ({ to: p.vault, data: encodeFunctionData({ abi: erc4626Abi, functionName: "redeem", args: [p.shares, user, user] }) }));
}

/** What the operator sends to invest `amount` of `user`'s USDC into `vault`. */
export function investCall(user: Address, vault: Address, amount: bigint, n: ArcNetwork): Call {
  return { to: n.agent, data: encodeFunctionData({ abi: agentAbi, functionName: "invest", args: [user, vault, amount] }) };
}
