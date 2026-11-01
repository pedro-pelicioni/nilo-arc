// Price math for market quotes (read over HTTP). Pure: the web app reads the oracle and
// hands the quotes in. Every amount that can end up in a transaction is computed
// here with bigints, never by the model and never with floating point.
import { UNITS_PER_USDC, type AppConfig, fromUnits, toUnits } from "./config";

/** Quotes are normalized to 14 decimals, whatever exponent the oracle used. */
export const PRICE_DECIMALS = 14;
export const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);
/** A quote older than this is treated as stale (FX feeds pause on weekends, so allow some room). */
export const MAX_QUOTE_AGE_SECONDS = 3 * 86_400;

/** The price of one unit of `symbol` in USD, as the oracle reported it. */
export interface Quote {
  symbol: string;
  /** USD per unit, scaled by PRICE_SCALE. */
  priceUsd: bigint;
  /** Unix seconds of the oracle record. */
  timestamp: number;
  /** Feed that reported it; empty for USD itself. */
  oracle: string;
}

export const FIAT_SIGNS: Record<string, string> = { USD: "US$", BRL: "R$", EUR: "€" };

/** USD is the oracles' base, so it needs no lookup. */
export function usdQuote(nowSec: number): Quote {
  return { symbol: "USD", priceUsd: PRICE_SCALE, timestamp: nowSec, oracle: "" };
}

export function isFiat(config: AppConfig, symbol: string): boolean {
  return config.prices?.fiat.includes(symbol.toUpperCase()) ?? false;
}

/** Oracle symbol for an asset code. */
export function priceSymbol(_config: AppConfig, code: string): string {
  return code.trim().toUpperCase();
}

export function assertFresh(q: Quote, nowSec: number): void {
  if (q.priceUsd <= 0n) throw new Error(`The oracle reported no usable price for ${q.symbol}.`);
  if (nowSec - q.timestamp > MAX_QUOTE_AGE_SECONDS) {
    const minutes = Math.round((nowSec - q.timestamp) / 60);
    throw new Error(`The ${q.symbol} price is ${minutes} minutes old, too stale to use.`);
  }
}

/** Price of one `base` in `quote` units, scaled by PRICE_SCALE. */
export function crossRate(base: Quote, quote: Quote): bigint {
  if (quote.priceUsd <= 0n) throw new Error(`The oracle reported no usable price for ${quote.symbol}.`);
  return (base.priceUsd * PRICE_SCALE) / quote.priceUsd;
}

const FIAT_RE = /^\d+(\.\d{1,6})?$/;

/**
 * How much of the asset `fiatAmount` buys, as a 6-decimal amount string.
 * Rounds down, so the payment is never worth more than what the user asked for.
 */
export function fiatToAsset(fiatAmount: string, fiat: Quote, asset: Quote): string {
  const amount = fiatAmount.trim();
  if (!FIAT_RE.test(amount)) {
    throw new Error(`Amount "${amount}" must be a positive number with at most 6 decimal places.`);
  }
  if (asset.priceUsd <= 0n) throw new Error(`The oracle reported no usable price for ${asset.symbol}.`);
  // Both prices share the same scale, so the ratio converts 6-decimal units directly.
  const units = (toUnits(amount) * fiat.priceUsd) / asset.priceUsd;
  if (units <= 0n) throw new Error(`${amount} ${fiat.symbol} is less than the smallest ${asset.symbol} amount.`);
  return fromUnits(units);
}

/** Value of an asset amount in `fiat`, as a 6-decimal amount string (rounded down). */
export function assetToFiat(amount: string, asset: Quote, fiat: Quote): string {
  if (fiat.priceUsd <= 0n) throw new Error(`The oracle reported no usable price for ${fiat.symbol}.`);
  return fromUnits((toUnits(amount) * asset.priceUsd) / fiat.priceUsd);
}

/** Display only: rounds a scaled value to `digits` decimals (half up). */
export function formatScaled(value: bigint, scale: bigint, digits: number): string {
  const step = scale / 10n ** BigInt(digits);
  const rounded = (value + step / 2n) / step;
  const unit = 10n ** BigInt(digits);
  const whole = (rounded / unit).toLocaleString("en-US");
  if (digits === 0) return whole;
  return `${whole}.${(rounded % unit).toString().padStart(digits, "0")}`;
}

/** Display only: enough decimals that small prices (e.g. 1 BRL in BTC) don't show as 0.00. */
export function formatRate(rate: bigint): string {
  if (rate >= PRICE_SCALE || rate <= 0n) return formatScaled(rate, PRICE_SCALE, 2);
  // Below 1: keep four significant digits.
  let zeros = 0;
  for (let r = rate; r * 10n < PRICE_SCALE && zeros < PRICE_DECIMALS - 4; r *= 10n) zeros++;
  return formatScaled(rate, PRICE_SCALE, zeros + 4);
}

/** Display only: a 6-decimal amount string as money, e.g. "R$ 12.34". */
export function formatFiat(amount: string, currency: string): string {
  const sign = FIAT_SIGNS[currency] ?? currency;
  return `${sign} ${formatScaled(toUnits(amount), UNITS_PER_USDC, 2)}`;
}
