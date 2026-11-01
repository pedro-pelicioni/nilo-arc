import type { Address } from "viem";
import {
  type AppConfig,
  type AssetSpec,
  GAS_BUFFER_UNITS,
  MAX_DEADLINE_SECONDS,
  MIN_DEADLINE_SECONDS,
  fromUnits,
  isEvmAddress,
  sameAddress,
  toUnits,
} from "./config";
import type { SendIntent } from "./intent";

/** What validation needs to know about the sender's wallet. */
export interface AccountSnapshot {
  address: Address;
  /** USDC balance in 6-decimal units. On Arc this same balance pays the gas. */
  usdc: bigint;
}

/** An intent after every deterministic check passed. */
export interface ResolvedIntent {
  amount: string;
  asset: AssetSpec;
  recipient: Address;
  recipientName?: string;
  deadlineSeconds: number;
}

export type ValidationResult = { ok: true; intent: ResolvedIntent } | { ok: false; reason: string };

const AMOUNT_RE = /^\d+(\.\d{1,6})?$/;

export function resolveRecipient(config: AppConfig, input: string): { address: Address; name?: string } | null {
  const trimmed = input.trim();
  const name = trimmed.toLowerCase();
  if (config.contacts[name]) return { address: config.contacts[name], name };
  if (isEvmAddress(trimmed)) return { address: trimmed };
  return null;
}

export function validateIntent(intent: SendIntent, account: AccountSnapshot, config: AppConfig): ValidationResult {
  const recipient = resolveRecipient(config, intent.recipient);
  if (!recipient) {
    return { ok: false, reason: `"${intent.recipient}" is not a valid wallet address (0x…) or a known contact.` };
  }
  if (sameAddress(recipient.address, account.address)) {
    return { ok: false, reason: "You cannot send to your own wallet." };
  }
  if (/^0x0{40}$/i.test(recipient.address)) {
    return { ok: false, reason: "That is the zero address: nobody can ever claim from it." };
  }

  const asset = config.assets.find((a) => a.code.toUpperCase() === intent.asset.trim().toUpperCase());
  if (!asset) {
    const allowed = config.assets.map((a) => a.code).join(", ");
    return { ok: false, reason: `Asset "${intent.asset}" is not supported. Allowed: ${allowed}.` };
  }

  const amount = intent.amount.trim();
  if (!AMOUNT_RE.test(amount)) {
    return { ok: false, reason: `Amount "${amount}" must be a positive number with at most 6 decimal places.` };
  }
  const units = toUnits(amount);
  if (units <= 0n) {
    return { ok: false, reason: "Amount must be greater than zero." };
  }

  if (intent.deadlineSeconds < MIN_DEADLINE_SECONDS || intent.deadlineSeconds > MAX_DEADLINE_SECONDS) {
    return { ok: false, reason: "The deadline must be between 2 minutes and 30 days." };
  }

  if (account.usdc < units + GAS_BUFFER_UNITS) {
    return {
      ok: false,
      reason:
        `Insufficient USDC: this needs ${amount} USDC plus about ${fromUnits(GAS_BUFFER_UNITS)} USDC for gas, ` +
        `and you have ${fromUnits(account.usdc)} USDC.`,
    };
  }

  return {
    ok: true,
    intent: { amount, asset, recipient: recipient.address, recipientName: recipient.name, deadlineSeconds: intent.deadlineSeconds },
  };
}
