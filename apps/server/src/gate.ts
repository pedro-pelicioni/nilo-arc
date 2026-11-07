// Caps how many outbound RPCs run at once. Each call uses a DNS lookup and a
// socket; an uncapped burst fills Node's thread pool and then even a static
// file read waits behind it.

function aborted(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? Object.assign(new Error("The request was aborted."), { name: "AbortError" });
}

interface Waiter {
  signal?: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

export function createGatedFetch(limit: number, inner: typeof fetch = fetch): typeof fetch {
  if (limit < 1) throw new Error("RPC concurrency limit must be at least 1.");
  let active = 0;
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

  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    await acquire(signal);
    try {
      return await inner(input, init);
    } finally {
      release();
    }
  };
}
