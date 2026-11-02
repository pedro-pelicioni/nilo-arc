// Wallet access through the browser wallet (MetaMask, Rabby, Coinbase Wallet…) over EIP-1193.
// The app only ever reads the public address; the wallet holds the keys and signs.
import { type Call, type VoiceProof, voiceProofExpiry, voiceProofMessage } from "@nilo/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { type Address, type TypedDataDefinition, createWalletClient, custom, numberToHex } from "viem";
import { chain, network, publicClient } from "./arc";

export class UserCancelled extends Error {}

export interface SubmitFailure {
  /** The transaction can be rebuilt and signed again. */
  retryable: boolean;
  codes: string[];
  message: string;
}

export function isSubmitFailure(e: unknown): e is SubmitFailure {
  return typeof e === "object" && e !== null && "retryable" in e && "codes" in e;
}

interface Eip1193 {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request(args: { method: string; params?: unknown[] }): Promise<any>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
}

/** A little above Arc's 20 gwei floor, so a fee estimated right at the floor still lands. */
const MIN_FEE = 25_000_000_000n;

const provider = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

/** Phone browsers (Safari, Chrome) have no wallet extension, so the page opens inside a wallet app instead. */
const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

/** This page, opened inside the MetaMask app's browser, where the wallet is injected. */
export const metaMaskLink = () => `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}`;

// Dev only: ?watch=0x… loads a public address without a wallet, to inspect pages. Signing is disabled.
const WATCH = import.meta.env.DEV ? new URLSearchParams(location.search).get("watch") : null;
/** True in the dev-only watch mode: a public address with no wallet. */
export const WATCHING = !!WATCH;

interface State {
  address: Address | null;
  chainId: number | null;
}
let state: State = { address: (WATCH as Address | null) ?? null, chainId: null };
const listeners = new Set<() => void>();
function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// Pick up an already-connected wallet and follow account / network switches.
const eth = provider();
if (eth && !WATCH) {
  eth.request({ method: "eth_accounts" }).then((a: string[]) => set({ address: (a[0] as Address) ?? null }), () => {});
  eth.request({ method: "eth_chainId" }).then((c: string) => set({ chainId: Number(c) }), () => {});
  eth.on?.("accountsChanged", (a) => set({ address: ((a as string[])[0] as Address) ?? null }));
  eth.on?.("chainChanged", (c) => set({ chainId: Number(c as string) }));
}

function rejected(e: unknown): boolean {
  const err = e as { code?: number; message?: string; cause?: { code?: number } };
  return err?.code === 4001 || err?.cause?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? "");
}

/** Switches the wallet to Arc, adding the network first if the wallet doesn't know it. */
async function ensureChain(p: Eip1193) {
  const current = Number(await p.request({ method: "eth_chainId" }));
  if (current === network.chainId) return;
  const chainId = numberToHex(network.chainId);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    if (rejected(e)) throw new UserCancelled("Switch to Arc in your wallet to continue.");
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: network.name,
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: [network.rpcUrl],
          blockExplorerUrls: [network.explorer],
        },
      ],
    });
  }
  set({ chainId: network.chainId });
}

function walletClient(p: Eip1193, account: Address) {
  return createWalletClient({ account, chain, transport: custom(p) });
}

export function useWallet() {
  const { address, chainId } = useSyncExternalStore(subscribe, () => state);
  return useMemo(() => {
    const p = provider();
    /** A phone with no wallet in this browser: connecting means opening Nilo in the MetaMask app. */
    const needsWalletApp = !p && !WATCH && MOBILE;
    const error = !p && !WATCH && !MOBILE ? "No browser wallet found. Install MetaMask or Rabby to use Nilo." : null;
    return {
      address,
      needsWalletApp,
      /** Whether the wallet is on the network Nilo uses. */
      onArc: chainId === network.chainId,
      error,
      async connect() {
        if (!p) {
          if (needsWalletApp) location.href = metaMaskLink();
          return;
        }
        try {
          const accounts: string[] = await p.request({ method: "eth_requestAccounts" });
          set({ address: (accounts[0] as Address) ?? null });
          await ensureChain(p);
        } catch (e) {
          if (!rejected(e)) console.warn("Could not connect the wallet:", (e as Error).message);
        }
      },
      /**
       * Sends each call as its own transaction, waiting for it to land before the next one,
       * and returns the hashes. Throws UserCancelled or SubmitFailure.
       */
      async sendCalls(calls: Call[], onStep?: (i: number) => void): Promise<string[]> {
        if (WATCH || !p || !address) throw { retryable: false, codes: [], message: "Connect a wallet to sign." } satisfies SubmitFailure;
        await ensureChain(p);
        const client = walletClient(p, address);
        // Arc's mempool refuses maxFeePerGas under 20 gwei and the base fee sits right at it: never let a wallet go below.
        const fees = await publicClient.estimateFeesPerGas().catch(() => null);
        const maxFeePerGas = fees && fees.maxFeePerGas > MIN_FEE ? fees.maxFeePerGas : MIN_FEE;
        const maxPriorityFeePerGas = fees?.maxPriorityFeePerGas ?? 0n;
        const hashes: string[] = [];
        for (const [i, call] of calls.entries()) {
          onStep?.(i);
          let hash: `0x${string}`;
          try {
            hash = await client.sendTransaction({ account: address, chain, to: call.to, data: call.data, maxFeePerGas, maxPriorityFeePerGas });
          } catch (e) {
            if (rejected(e)) throw new UserCancelled("Signature rejected.");
            const message = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message;
            throw { retryable: i === 0, codes: [], message } satisfies SubmitFailure;
          }
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") {
            throw { retryable: false, codes: ["reverted"], message: `The transaction ${hash} reverted on chain.` } satisfies SubmitFailure;
          }
          hashes.push(hash);
        }
        return hashes;
      },
      async signTypedData(data: TypedDataDefinition): Promise<`0x${string}`> {
        if (WATCH || !p || !address) throw new Error("Connect a wallet to sign.");
        await ensureChain(p);
        try {
          return await walletClient(p, address).signTypedData(data as Parameters<ReturnType<typeof walletClient>["signTypedData"]>[0]);
        } catch (e) {
          if (rejected(e)) throw new UserCancelled("Signature rejected.");
          throw e;
        }
      },
    };
  }, [address, chainId]);
}

/** How long a voice mode proof is valid: one signature per half day. */
const VOICE_PROOF_MS = 12 * 60 * 60_000;
const voiceProofKey = (address: string) => `nilo.voiceProof.${address.toLowerCase()}`;
/** Proofs signed in this tab, by address. */
const voiceProofs = new Map<string, VoiceProof>();

function storedVoiceProof(address: string): VoiceProof | null {
  try {
    const raw = sessionStorage.getItem(voiceProofKey(address));
    return raw ? (JSON.parse(raw) as VoiceProof) : null;
  } catch {
    return null;
  }
}

/**
 * A signed proof that the user controls `address`, which the server asks for before opening a
 * voice session (billed to its OpenAI key). The wallet signs once (EIP-191); the proof is reused
 * until shortly before it expires.
 */
export function useVoiceProof() {
  return useCallback(async (address: string): Promise<VoiceProof> => {
    const cached = voiceProofs.get(address) ?? storedVoiceProof(address);
    if (cached && (voiceProofExpiry(cached.message) ?? 0) > Date.now() + 5 * 60_000) return cached;
    const p = provider();
    if (WATCH || !p) throw new Error("Voice mode needs a connected wallet to know it's you.");
    const message = voiceProofMessage(address, new Date(Date.now() + VOICE_PROOF_MS));
    let signature: `0x${string}`;
    try {
      signature = await walletClient(p, address as Address).signMessage({ account: address as Address, message });
    } catch (e) {
      throw new Error(
        rejected(e) ? "Voice mode needs one signature to know it's you. Nothing was sent." : `Your wallet couldn't sign the voice mode check: ${(e as Error).message}`,
      );
    }
    const proof = { address, message, signature };
    voiceProofs.set(address, proof);
    try {
      sessionStorage.setItem(voiceProofKey(address), JSON.stringify(proof));
    } catch {
      // Kept in memory for this tab only.
    }
    return proof;
  }, []);
}
