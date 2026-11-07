// Bounds for work that shares the process with Render's health probe.
// A probe fails when the process does not answer within 5 seconds. These caps
// keep one chain read, one history pass, or one stalled request from holding
// that process open. Tests reset the object; the HTTP transport reads the
// numbers once, when the client is created.
export const limitDefaults = {
  /** Status and market handlers give up before a 5s HTTP probe would. */
  routeBudgetMs: 2_500,
  /** Agent status reads in flight. Further callers get 503 immediately. */
  maxStatusInflight: 4,
  /** NiloAgent blocks read per history pass. The chain is resumed on the next pass. */
  syncBlockBudget: 50_000n,
  /** RPC calls per history pass, including a smaller retry after a refused range. */
  syncMaxCalls: 12,
  rpcTimeoutMs: 4_000,
  /**
   * viem retries HTTP 429 and JSON-RPC -32005 by default. The live failure was
   * that retry. Zero means one attempt, then our cooldown, not another burst.
   */
  rpcRetryCount: 0,
  maxRpcInflight: 4,
  /** Calls waiting for a free RPC slot. Further calls fail instead of queueing. */
  maxRpcWaiters: 8,
  /** Used when a 429 has no usable Retry-After. */
  rpcCooldownMs: 15_000,
  /** Upper bound so a long Retry-After cannot pause the process's RPC for minutes. */
  rpcCooldownMaxMs: 30_000,
  /** A larger eth_getLogs body is refused so JSON.parse cannot stall the process. */
  maxResponseBodySize: 1_048_576,
  /** Pause between history passes that made progress, so probes can run. */
  syncContinueMs: 50,
  /** Pause after a failed pass, so a dead RPC is not retried in a tight loop. */
  syncRetryMs: 15_000,
  marketTimeoutMs: 2_500,
  /** Identical error lines inside this window are not written again. */
  logRepeatMs: 5_000,
};

export const limits = { ...limitDefaults };

export function resetLimits() {
  Object.assign(limits, limitDefaults);
}
