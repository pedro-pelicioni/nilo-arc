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

const DIAGNOSTIC_MAX = 240;

/**
 * One log line. Keeps the error name, HTTP status, and a short detail or cause.
 * Drops ABI, request bodies, and secrets that may sit in an RPC error string.
 */
export function sanitizeDiagnostic(text: string, max = 160): string {
  let s = text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]*):([^\s/@]*)@/gi, "$1[redacted]@");
  s = s.replace(/\b(bearer)\s+\S+/gi, "$1 [redacted]");
  s = s.replace(/([?&])([^=&#\s]*(?:key|token|secret|password|signature|sig|auth)[^=&#\s]*)=([^&#\s]*)/gi, "$1$2=[redacted]");
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#]+)\?[^#\s]*/gi, "$1");
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s#]*)#[^\s]*/gi, "$1");
  s = s.replace(/0x[0-9a-fA-F]{16,}/g, "0x…");
  if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1))}…`;
  return s;
}

type ErrView = {
  name?: string;
  shortMessage?: string;
  message?: string;
  details?: string;
  status?: number;
  cause?: unknown;
};

function view(e: unknown): ErrView {
  if (!e || typeof e !== "object") return { message: String(e) };
  const o = e as Record<string, unknown>;
  return {
    name: typeof o.name === "string" ? o.name : undefined,
    shortMessage: typeof o.shortMessage === "string" ? o.shortMessage : undefined,
    message: typeof o.message === "string" ? o.message : undefined,
    details: typeof o.details === "string" ? o.details : undefined,
    status: typeof o.status === "number" ? o.status : undefined,
    cause: "cause" in o ? o.cause : undefined,
  };
}

/** One line, safe to write to stdout while a health probe is due. */
export function errorSummary(e: unknown): string {
  if (e instanceof ChainError) return sanitizeDiagnostic(e.message, DIAGNOSTIC_MAX);
  const top = view(e);
  const headline = sanitizeDiagnostic((top.shortMessage || top.message || "unknown error").split("\n")[0] ?? "", 160);
  const bits = [top.name && top.name !== "Error" ? `${top.name}: ${headline}` : headline];
  if (typeof top.status === "number") bits.push(`status=${top.status}`);
  if (top.details) {
    const details = sanitizeDiagnostic(top.details.split("\n")[0] ?? "", 120);
    if (details && !headline.includes(details)) bits.push(`details=${details}`);
  }
  const cause = top.cause ? view(top.cause) : undefined;
  const causeRaw = (cause?.shortMessage || cause?.message || "").split("\n")[0] ?? "";
  if (causeRaw) {
    const causeText = sanitizeDiagnostic(causeRaw, 100);
    if (causeText && !bits.some((bit) => bit.includes(causeText))) bits.push(`cause=${causeText}`);
  }
  const line = bits.join("; ");
  return line.length > DIAGNOSTIC_MAX ? `${line.slice(0, DIAGNOSTIC_MAX - 1)}…` : line;
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

const SHRINKABLE = /response body exceeded the size limit|block range is too large|block range too large|requested range too large|ranges over \d+ blocks|exceeds? (?:the )?max(?:imum)? (?:block )?range|too many (?:logs|results)|response size exceeded|query returned more than|log response size|returned more than \d+ results/i;

/** True only for an oversized eth_getLogs body or a block-range refusal. Transport failures are not included. */
export function isShrinkableHistoryError(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 4) return false;
  const top = view(e);
  if (top.name === "ResponseBodyTooLargeError") return true;
  const text = [top.shortMessage, top.details, top.message].filter((part): part is string => typeof part === "string").join("\n");
  if (SHRINKABLE.test(text)) return true;
  return isShrinkableHistoryError(top.cause, depth + 1);
}

function walkCode(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 5) return false;
  const o = e as { code?: unknown; status?: unknown; cause?: unknown; metaMessages?: unknown };
  if (o.code === 429 || o.code === -32005 || o.status === 429) return true;
  if (Array.isArray(o.metaMessages) && o.metaMessages.some((line) => line === "Status: 429")) return true;
  return walkCode(o.cause, depth + 1);
}
