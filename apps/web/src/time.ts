import { useEffect, useState } from "react";

/** Current unix time in seconds, re-rendering every second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function formatLocal(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" });
}

export function formatRelative(seconds: number): string {
  const s = Math.abs(seconds);
  const parts =
    s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
    : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s`
    : `${s}s`;
  return seconds >= 0 ? `in ${parts}` : `${parts} ago`;
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}
