// How an escrowed NiloPayments payment looks from one side, and how a spoken request picks one.
import { type AppConfig, type AssetSpec, fromUnits, sameAddress, toUnits } from "./config";
import type { BalanceSelector } from "./intent";

export const PAYMENT_PENDING = 0;
export const PAYMENT_CLAIMED = 1;
export const PAYMENT_RECOVERED = 2;

/** A payment as the contract stores it. */
export interface OnchainPayment {
  from: string;
  to: string;
  amount: bigint;
  createdAt: bigint | number;
  claimUntil: bigint | number;
  status: number;
  memo: string;
}

export type BalanceStatus =
  /** Recipient, before the deadline. */
  | "claimable"
  /** Recipient, after the deadline: only the sender can take it back. */
  | "expired"
  /** Sender, after the deadline. */
  | "recoverable"
  /** Sender, before the deadline. */
  | "waiting";

export interface BalanceView {
  /** The payment id in NiloPayments, as a decimal string. */
  id: string;
  asset: AssetSpec;
  amount: string;
  role: "recipient" | "sender";
  sender?: string;
  recipient?: string;
  /** Unix seconds: the recipient can claim strictly before it, the sender can recover from it on. */
  deadline?: number;
  status: BalanceStatus;
  claimableNow: boolean;
}

/** How a pending payment looks from `me`'s side. Null when it is settled or `me` is not part of it. */
export function viewBalance(id: bigint | string, p: OnchainPayment, me: string, nowSec: number, config: AppConfig): BalanceView | null {
  if (p.status !== PAYMENT_PENDING) return null;
  const role = sameAddress(p.to, me) ? "recipient" : sameAddress(p.from, me) ? "sender" : null;
  if (!role) return null;
  const deadline = Number(p.claimUntil);
  const before = nowSec < deadline;
  const claimableNow = role === "recipient" ? before : !before;
  const status: BalanceStatus = role === "recipient" ? (before ? "claimable" : "expired") : before ? "waiting" : "recoverable";
  return {
    id: id.toString(),
    asset: config.assets[0],
    amount: fromUnits(p.amount),
    role,
    sender: p.from,
    recipient: p.to,
    deadline,
    status,
    claimableNow,
  };
}

/** The payments in `views` that match every given field of `sel`: all of them when none is given. */
export function pickBalances(views: BalanceView[], sel: BalanceSelector, config: AppConfig): BalanceView[] {
  if (sel.index !== null) {
    const v = Number.isInteger(sel.index) && sel.index >= 1 ? views[sel.index - 1] : undefined;
    views = v ? [v] : [];
  }
  const who = sel.counterparty?.trim();
  const address = who ? (config.contacts[who.toLowerCase()] ?? who) : null;
  const amount = sel.amount?.trim();
  if (amount && !/^\d+(\.\d{1,6})?$/.test(amount)) return [];
  const code = sel.asset?.trim().toUpperCase();
  return views.filter(
    (v) =>
      (!address || sameAddress(v.role === "recipient" ? v.sender : v.recipient, address)) &&
      (!code || v.asset.code === code) &&
      (!amount || toUnits(v.amount) === toUnits(amount)),
  );
}
