import { ChainError } from "./chain";
import { limits } from "./limits";

const recent = new Map<string, number>();

/** Names and short reasons only. Never the viem call dump (ABI, args, formattedArgs). */
export function errorText(e: unknown): string {
  const parts: string[] = [];
  const visit = (err: unknown, depth: number) => {
    if (!err || depth > 5) return;
    if (typeof err === "string") {
      parts.push(err);
      return;
    }
    if (typeof err !== "object") return;
    const o = err as Record<string, unknown>;
    for (const key of ["shortMessage", "details", "reason", "errorName"] as const) {
      if (typeof o[key] === "string") parts.push(o[key]);
    }
    const data = o.data;
    if (data && typeof data === "object" && typeof (data as { errorName?: unknown }).errorName === "string") {
      parts.push((data as { errorName: string }).errorName);
    }
    if (Array.isArray(o.metaMessages)) {
      for (const line of o.metaMessages) if (typeof line === "string") parts.push(line);
    }
    if ("cause" in o) visit(o.cause, depth + 1);
  };
  visit(e, 0);
  return parts.join("\n");
}

/** One line, safe to write to stdout while a health probe is due. */
export function errorSummary(e: unknown): string {
  if (e instanceof ChainError) return e.message;
  if (typeof e === "object" && e && typeof (e as { shortMessage?: unknown }).shortMessage === "string") {
    return ((e as { shortMessage: string }).shortMessage.split("\n")[0] ?? "").slice(0, 240);
  }
  const message = e instanceof Error ? e.message : String(e);
  return (message.split("\n")[0] ?? message).slice(0, 240);
}

export function logError(prefix: string, e: unknown) {
  const summary = errorSummary(e);
  const key = `${prefix}:${summary}`;
  const now = Date.now();
  if (now - (recent.get(key) ?? 0) < limits.logRepeatMs) return;
  recent.set(key, now);
  if (recent.size > 200) recent.clear();
  console.error(`${prefix}: ${summary}`);
}

export function resetLogsForTests() {
  recent.clear();
}

export function isTimeout(e: unknown): boolean {
  const name = typeof e === "object" && e ? (e as { name?: string }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

/** The public Arc RPC answered 429 / -32005 ("rate limit exceeded") for mandateOf. */
export function isRateLimit(e: unknown): boolean {
  const name = typeof e === "object" && e ? (e as { name?: string }).name : undefined;
  if (name === "RateLimitError") return true;
  const text = errorText(e);
  if (/rate limit exceeded|request exceeds defined limit/i.test(text)) return true;
  return walkCode(e);
}

function walkCode(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 5) return false;
  const o = e as { code?: unknown; status?: unknown; cause?: unknown; metaMessages?: unknown };
  if (o.code === 429 || o.code === -32005 || o.status === 429) return true;
  if (Array.isArray(o.metaMessages) && o.metaMessages.some((line) => line === "Status: 429")) return true;
  return walkCode(o.cause, depth + 1);
}
