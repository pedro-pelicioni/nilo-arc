// Read-only market rates over HTTP (Coinbase's public exchange rates). Nothing is signed or
// submitted; the quotes are normalized to the 14-decimal scale the price math in @nilo/core uses.
import { PRICE_DECIMALS, PRICE_SCALE, type Quote, assertFresh, usdQuote } from "@nilo/core";
import { config } from "./arc";

const RATES_URL = config.prices!.ratesUrl;
/** Symbols Nilo prices; EURC is priced as EUR. */
const SYMBOLS: Record<string, string> = { USDC: "USDC", BTC: "BTC", ETH: "ETH", EUR: "EUR", EURC: "EUR", BRL: "BRL" };
/** Rates move by the minute; a minute of caching keeps the chat snappy. */
const CACHE_MS = 60_000;
let cache: { at: number; rates: Record<string, string> } | null = null;

/** "5.4393" units per USD → USD per unit, scaled by PRICE_SCALE, with bigints only. */
function usdPerUnit(perUsd: string): bigint {
  const [whole, frac = ""] = perUsd.split(".");
  const digits = frac.slice(0, PRICE_DECIMALS).padEnd(PRICE_DECIMALS, "0");
  const scaled = BigInt(whole) * PRICE_SCALE + BigInt(digits);
  return scaled > 0n ? (PRICE_SCALE * PRICE_SCALE) / scaled : 0n;
}

/** USD price of a symbol; throws if missing or stale. */
export async function getQuote(symbol: string): Promise<Quote> {
  const sym = symbol.trim().toUpperCase();
  const now = Math.floor(Date.now() / 1000);
  if (sym === "USD") return usdQuote(now);
  const code = SYMBOLS[sym];
  if (!code) throw new Error(`Nilo has no price for ${sym}. Available: USD, ${Object.keys(SYMBOLS).join(", ")}.`);
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const res = await fetch(RATES_URL);
    if (!res.ok) throw new Error(`The rates service answered ${res.status}.`);
    const body = (await res.json()) as { data?: { rates?: Record<string, string> } };
    if (!body.data?.rates) throw new Error("The rates service returned no rates.");
    cache = { at: Date.now(), rates: body.data.rates };
  }
  const rate = cache.rates[code];
  if (!rate || !/^\d+(\.\d+)?$/.test(rate)) throw new Error(`No rate for ${sym} right now.`);
  const quote: Quote = { symbol: sym, priceUsd: usdPerUnit(rate), timestamp: Math.floor(cache.at / 1000), oracle: "" };
  assertFresh(quote, now);
  return quote;
}
