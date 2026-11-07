// What the agent remembers between runs: which users have a mandate, and a log of
// what it did for them. A JSON file in DATA_DIR. Mandates, investments and revokes
// are also rebuilt from NiloAgent's events (chainlog.ts), so losing this file
// loses only the runs that changed nothing.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Activity {
  id: string;
  /** ISO time. */
  at: string;
  user: string;
  kind: "mandate" | "invest" | "withdraw" | "revoke" | "skip" | "error";
  /** Why the agent ran: on its schedule, right after activation, or on request. */
  trigger?: "schedule" | "activate" | "manual";
  /** The vault the move went into or came out of. */
  vault?: string;
  /** USDC, as a decimal string. */
  amount?: string;
  hash?: string;
  /** Explorer link of the transaction. */
  link?: string;
  note: string;
}

interface State {
  users: string[];
  activity: Activity[];
  /** Last block whose NiloAgent events are in the log. */
  syncedBlock?: string;
}

const MAX_ACTIVITY = 1_000;
/** A larger file is ignored. Parsing it would block the process before it can answer a probe. */
const MAX_FILE_BYTES = 2_000_000;

const dir = () => process.env.DATA_DIR?.trim() || "data";
const file = () => join(dir(), "agent.json");

function empty(): State {
  return { users: [], activity: [] };
}

function load(): State {
  const path = file();
  try {
    if (statSync(path).size > MAX_FILE_BYTES) {
      console.warn(`Agent log ${path} is over ${MAX_FILE_BYTES} bytes; ignoring it. Chain history will rebuild it.`);
      return empty();
    }
  } catch {
    return empty();
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as State;
    if (!Array.isArray(parsed.users) || !Array.isArray(parsed.activity)) return empty();
    if (parsed.activity.length > MAX_ACTIVITY) parsed.activity = parsed.activity.slice(-MAX_ACTIVITY);
    return parsed;
  } catch {
    return empty();
  }
}

let state: State | null = null;
function db(): State {
  state ??= load();
  return state;
}

// Writes are queued so two checkpoints cannot rename over each other. The
// write itself is async: it must not stall the event loop the health probe uses.
let warned = false;
let writing: Promise<void> = Promise.resolve();

function persist(): Promise<void> {
  const job = writing.then(async () => {
    const snapshot = JSON.stringify(db());
    const path = file();
    await mkdir(dir(), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, snapshot);
    await rename(tmp, path);
  });
  // Return the caught chain so a fire-and-forget caller does not surface an unhandled rejection.
  writing = job.catch((e) => {
    if (!warned) console.warn(`Agent log not saved to ${file()}; keeping it in memory:`, (e as Error).message);
    warned = true;
  });
  return writing;
}

export const users = () => [...db().users];

/** Addresses are kept lowercase so each wallet is one entry whatever its casing. */
export function addUser(user: string) {
  user = user.toLowerCase();
  const current = db();
  if (!current.users.includes(user)) {
    current.users.push(user);
    void persist();
  }
}

export function log(entry: Omit<Activity, "id" | "at">): Activity {
  const a: Activity = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    ...entry,
    user: entry.user.toLowerCase(),
  };
  const current = db();
  current.activity.push(a);
  if (current.activity.length > MAX_ACTIVITY) current.activity.splice(0, current.activity.length - MAX_ACTIVITY);
  void persist();
  return a;
}

/** Adds an entry read from the chain, once: its id is the event's transaction and log index. */
export function record(entry: Activity) {
  const current = db();
  const user = entry.user.toLowerCase();
  if (current.activity.some((a) => a.id === entry.id || (entry.hash && a.hash === entry.hash && a.vault === entry.vault))) return;
  current.activity.push({ ...entry, user });
  current.activity.sort((a, b) => a.at.localeCompare(b.at));
  if (current.activity.length > MAX_ACTIVITY) current.activity.splice(0, current.activity.length - MAX_ACTIVITY);
}

export const syncedBlock = () => (db().syncedBlock ? BigInt(db().syncedBlock!) : null);

export async function setSyncedBlock(block: bigint) {
  db().syncedBlock = block.toString();
  await persist();
}

export const activityFor = (user: string, limit = 50) =>
  db().activity.filter((a) => a.user === user.toLowerCase()).slice(-limit).reverse();

export function resetStoreForTests() {
  state = empty();
  warned = false;
  writing = Promise.resolve();
}

/** Test hook: the on-disk file after the queued write. */
export function whenStored(): Promise<void> {
  return writing;
}
