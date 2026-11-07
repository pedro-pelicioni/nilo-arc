// The market line of the agent's morning briefing: BTC and ETH now and over the last 24 hours,
// from Coinbase's public exchange API. Fetched by the server (no CORS, one cached call for everyone).
import { limits } from "./limits";

const PRODUCTS = [
  { symbol: "BTC", product: "BTC-USD" },
  { symbol: "ETH", product: "ETH-USD" },
];
const TTL_MS = 5 * 60_000;

export interface MarketAsset {
  symbol: string;
  /** USD, last trade. */
  price: number;
  /** Percent change from 24 hours ago. */
  change24h: number;
}

export interface Market {
  at: string;
  source: "Coinbase";
  assets: MarketAsset[];
}

let cached: { at: number; value: Market } | null = null;
let inflight: Promise<Market> | null = null;

async function stats(product: string): Promise<{ open: number; last: number }> {
  const res = await fetch(`https://api.exchange.coinbase.com/products/${product}/stats`, { signal: AbortSignal.timeout(limits.marketTimeoutMs) });
  if (!res.ok) throw new Error(`Coinbase ${product}: ${res.status}`);
  const json = (await res.json()) as { open?: string; last?: string };
  const open = Number(json.open);
  const last = Number(json.last);
  if (!(open > 0) || !(last > 0)) throw new Error(`Coinbase ${product}: no price`);
  return { open, last };
}

async function load(): Promise<Market> {
  const assets = await Promise.all(
    PRODUCTS.map(async ({ symbol, product }) => {
      const { open, last } = await stats(product);
      return { symbol, price: last, change24h: ((last - open) / open) * 100 };
    }),
  );
  const value: Market = { at: new Date().toISOString(), source: "Coinbase", assets };
  cached = { at: Date.now(), value };
  return value;
}

export async function market(): Promise<Market> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  // One refresh for every caller. A probe or a burst of page loads must not open a fetch each.
  if (!inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  try {
    return await inflight;
  } catch (e) {
    if (cached) return cached.value;
    throw e;
  }
}

export function resetMarketForTests() {
  cached = null;
  inflight = null;
}
