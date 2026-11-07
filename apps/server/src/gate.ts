// Caps how many outbound RPCs run at once, and stops a 429 from being retried
// into a larger burst. Waiters are capped so a stuck slot cannot grow a queue.

import { limits } from "./limits";

function aborted(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? Object.assign(new Error("The request was aborted."), { name: "AbortError" });
}

export function rateLimitError(): Error {
  return Object.assign(new Error("Arc's public RPC is rate limited."), { name: "RateLimitError" });
}

export function busyError(): Error {
  return Object.assign(new Error("Arc RPC is busy."), { name: "RpcBusyError" });
}

/** Milliseconds to stay quiet after a 429. Unusable Retry-After values use the fallback. */
export function cooldownFromRetryAfter(header: string | null, now: number, fallbackMs: number, maxMs: number): number {
  const fallback = Math.min(Math.max(fallbackMs, 0), maxMs);
  if (!header) return fallback;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (seconds <= 0) return fallback;
    return Math.min(seconds * 1000, maxMs);
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return fallback;
  const delta = when - now;
  if (delta <= 0) return fallback;
  return Math.min(delta, maxMs);
}

interface Waiter {
  signal?: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

export type GatedFetch = typeof fetch & { cooldownRemainingMs: (now?: number) => number };

export function createGatedFetch(
  limit: number,
  inner: typeof fetch = fetch,
  options?: { maxWaiters?: number; fallbackCooldownMs?: number; maxCooldownMs?: number; now?: () => number },
): GatedFetch {
  if (limit < 1) throw new Error("RPC concurrency limit must be at least 1.");
  const maxWaiters = options?.maxWaiters ?? limits.maxRpcWaiters;
  const now = options?.now ?? Date.now;
  let active = 0;
  let coolUntil = 0;
  const waiters: Waiter[] = [];

  function release() {
    while (waiters.length) {
      const next = waiters.shift()!;
      next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) {
        next.reject(aborted(next.signal));
        continue;
      }
      next.resolve();
      return;
    }
    active--;
  }

  function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(aborted(signal));
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, onAbort: () => undefined };
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(aborted(signal));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
    });
  }

  const gated = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const signal = init?.signal ?? undefined;
    if (now() < coolUntil) throw rateLimitError();
    if (active >= limit && waiters.length >= maxWaiters) throw busyError();
    await acquire(signal);
    try {
      const response = await inner(input, init);
      if (response.status === 429) {
        const pause = cooldownFromRetryAfter(
          response.headers.get("retry-after"),
          now(),
          options?.fallbackCooldownMs ?? limits.rpcCooldownMs,
          options?.maxCooldownMs ?? limits.rpcCooldownMaxMs,
        );
        coolUntil = Math.max(coolUntil, now() + pause);
      }
      return response;
    } finally {
      release();
    }
  };
  return Object.assign(gated, {
    cooldownRemainingMs(at = Date.now()) {
      return Math.max(0, coolUntil - at);
    },
  });
}
