import { type Address, defineChain, getAddress, isAddress } from "viem";
import demo from "./demo.json";

export type NetworkId = "testnet" | "mainnet";

/** An ERC-4626 vault the agent can put USDC in (Morpho vaults listed by Circle's Earn Kit). */
export interface VaultInfo {
  address: Address;
  name: string;
  /** Which personality share it takes: "prime" is the deep, steady one, "yield" the higher-rate one. */
  slot: "prime" | "yield";
}

/** One Arc network and Nilo's contracts on it. */
export interface ArcNetwork {
  id: NetworkId;
  name: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  /** USDC's ERC-20 interface. On Arc it reads and moves the native (gas) USDC balance, with 6 decimals. */
  usdc: Address;
  /** NiloPayments: escrowed payments the recipient claims before a deadline, or the sender recovers after it. */
  payments: Address;
  /** NiloAgent: mandates that let Nilo's operator invest a user's USDC into vaults the user picked. */
  agent: Address;
  /** Nilo's operator: the only key the agent contract lets call `invest`. Also relays gasless claims. */
  operator: Address;
  vaults: VaultInfo[];
  /** Where to get test USDC, on testnet. */
  faucetUrl?: string;
}

export interface AssetSpec {
  code: string;
  address: Address;
  decimals: number;
}

export interface AppConfig {
  network: ArcNetwork;
  /** Assets the app is allowed to send. */
  assets: AssetSpec[];
  /** Fixed nickname → address list for the demo. Lowercase keys. */
  contacts: Record<string, Address>;
  prices?: PriceConfig;
}

export interface PriceConfig {
  /** Public market rates, read over HTTP. */
  ratesUrl: string;
  /** Fiat currencies a payment can be written in. */
  fiat: string[];
}

export const USDC_DECIMALS = 6;
export const UNITS_PER_USDC = 1_000_000n;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const OPERATOR = "0x59782DC984d9F4e6A37c08B9A63B0DCf77954E1f" as Address;

export const NETWORKS: Record<NetworkId, ArcNetwork> = {
  testnet: {
    id: "testnet",
    name: "Arc Testnet",
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.io",
    explorer: "https://explorer.testnet.arc.io",
    usdc: USDC,
    // Built, tested and deployed with Arc Studio; see contracts/.
    payments: "0x20376ca84c65242097b57ad1e5a122f86e12f305",
    agent: "0x16f0819135205b7d710d99ef92c69173e2d464c6",
    operator: OPERATOR,
    vaults: [
      { address: "0xaabbef1d3971c710276ed41ec791bbe14cdb8e88", name: "EarnKit USDC Vault", slot: "prime" },
      { address: "0x8f2d33b5d4b9b5f02df635ae308f7b4c9da8d2dc", name: "Morpho USDC Vault", slot: "yield" },
    ],
    faucetUrl: "https://faucet.circle.com",
  },
  mainnet: {
    id: "mainnet",
    name: "Arc",
    chainId: 5042,
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
    usdc: USDC,
    payments: ZERO,
    agent: ZERO,
    operator: OPERATOR,
    vaults: [
      { address: "0xbeef0016cb2fd5c352ea7ca08a9f54739dfa7298", name: "Steakhouse Prime USDC", slot: "prime" },
      { address: "0x10af7238c6355aa8ddb5ed60e2e9b55a72827b51", name: "Gauntlet USDC Balanced", slot: "yield" },
    ],
  },
};

export const PRICES: PriceConfig = { ratesUrl: "https://api.coinbase.com/v2/exchange-rates?currency=USD", fiat: ["USD", "BRL", "EUR"] };

export function makeConfig(id: NetworkId = "testnet"): AppConfig {
  const network = NETWORKS[id];
  return {
    network,
    assets: [{ code: "USDC", address: network.usdc, decimals: USDC_DECIMALS }],
    contacts: demo.contacts as Record<string, Address>,
    prices: PRICES,
  };
}

export const defaultConfig: AppConfig = makeConfig("testnet");

/** viem chain for an Arc network. Gas is paid in USDC, which the native balance shows with 18 decimals. */
export function arcChain(n: ArcNetwork) {
  return defineChain({
    id: n.chainId,
    name: n.name,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [n.rpcUrl] } },
    blockExplorers: { default: { name: "Arc Explorer", url: n.explorer } },
    testnet: n.id === "testnet",
  });
}

/** USDC kept aside for gas when checking a payment against the balance (gas on Arc costs fractions of a cent). */
export const GAS_BUFFER_UNITS = 10_000n;
/** Long enough that a payment built now is still valid after the approval lands (two confirmations). */
export const MIN_DEADLINE_SECONDS = 120;
export const MAX_DEADLINE_SECONDS = 30 * 24 * 3600;

export const explorerTx = (n: ArcNetwork, hash: string) => `${n.explorer}/tx/${hash}`;
export const explorerAddress = (n: ArcNetwork, address: string) => `${n.explorer}/address/${address}`;

export function sameAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** A 0x address. Mixed-case input must carry a valid checksum, which catches most typos. */
export function isEvmAddress(a: string): a is Address {
  return isAddress(a);
}

export const checksum = (a: string) => getAddress(a);

export function nicknameFor(config: AppConfig, address: string): string | undefined {
  return Object.entries(config.contacts).find(([, a]) => sameAddress(a, address))?.[0];
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "12.5" → 12500000n. Throws on more than 6 decimals. */
export function toUnits(amount: string): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  if (frac.length > USDC_DECIMALS) throw new Error(`"${amount}" has more than ${USDC_DECIMALS} decimals.`);
  return BigInt(whole || "0") * UNITS_PER_USDC + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
}

export function fromUnits(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / UNITS_PER_USDC;
  const frac = (abs % UNITS_PER_USDC).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${frac ? `${whole}.${frac}` : whole}`;
}
