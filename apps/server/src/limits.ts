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
  syncBlockBudget: 20_000n,
  /** RPC calls per history pass, including a smaller retry after a refused range. */
  syncMaxCalls: 4,
  rpcTimeoutMs: 4_000,
  rpcRetryCount: 1,
  maxRpcInflight: 4,
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
