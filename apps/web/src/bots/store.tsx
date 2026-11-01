// Bots the user talks to, and each bot's chat history, kept in localStorage.
// Storage can be missing or full (private windows); everything still works in memory.
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { BOT_COLORS, type BotColorId, MASCOTS, type MascotId } from "./mascots";

export interface Bot {
  id: string;
  name: string;
  variant: MascotId;
  color: BotColorId;
  createdAt: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export const DEFAULT_BOT: Bot = { id: "nilo", name: "Nilo", variant: "classic", color: "violet", createdAt: 0 };
export const DEFAULT_PREVIEW = "USDC agent on Arc";

const BOTS_KEY = "nilo.bots.v1";
const chatKey = (botId: string) => `nilo.chat.${botId}.v1`;

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; the in-memory state still holds it.
  }
}

const isVariant = (v: unknown): v is MascotId => MASCOTS.some((s) => s.id === v);
const isColor = (v: unknown): v is BotColorId => BOT_COLORS.some((c) => c.id === v);

function loadBots(): Bot[] {
  const raw = read(BOTS_KEY);
  const saved = Array.isArray(raw)
    ? raw.filter(
        (b): b is Bot =>
          typeof b?.id === "string" && b.id !== DEFAULT_BOT.id && typeof b.name === "string" && isVariant(b.variant) && isColor(b.color),
      )
    : [];
  return [DEFAULT_BOT, ...saved];
}

export function loadChat(botId: string): ChatMessage[] {
  const raw = read(chatKey(botId));
  return Array.isArray(raw)
    ? raw.filter((m): m is ChatMessage => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
    : [];
}

const lastText = (messages: ChatMessage[]) => messages[messages.length - 1]?.content ?? null;

function loadPreviews(bots: Bot[]): Record<string, string | null> {
  return Object.fromEntries(bots.map((b) => [b.id, lastText(loadChat(b.id))]));
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

interface BotsValue {
  bots: Bot[];
  getBot: (id: string | undefined) => Bot | undefined;
  createBot: (input: Pick<Bot, "name" | "variant" | "color">) => Bot;
  deleteBot: (id: string) => void;
  /** Last message of each bot's chat, for the sidebar. */
  previews: Record<string, string | null>;
  saveChat: (botId: string, messages: ChatMessage[]) => void;
}

const BotsContext = createContext<BotsValue | null>(null);

export function BotsProvider({ children }: { children: ReactNode }) {
  const [bots, setBots] = useState(loadBots);
  const [previews, setPreviews] = useState(() => loadPreviews(bots));

  // Another tab changed the bots or a chat.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === BOTS_KEY) {
        const next = loadBots();
        setBots(next);
        setPreviews(loadPreviews(next));
      } else if (e.key?.startsWith("nilo.chat.")) {
        const id = e.key.slice("nilo.chat.".length, -".v1".length);
        setPreviews((p) => ({ ...p, [id]: lastText(loadChat(id)) }));
      }
    };
    addEventListener("storage", onStorage);
    return () => removeEventListener("storage", onStorage);
  }, []);

  const createBot = useCallback((input: Pick<Bot, "name" | "variant" | "color">) => {
    const bot: Bot = { ...input, id: newId(), createdAt: Date.now() };
    setBots((list) => {
      const next = [...list, bot];
      write(BOTS_KEY, next.slice(1));
      return next;
    });
    return bot;
  }, []);

  const deleteBot = useCallback((id: string) => {
    if (id === DEFAULT_BOT.id) return;
    setBots((list) => {
      const next = list.filter((b) => b.id !== id);
      write(BOTS_KEY, next.slice(1));
      return next;
    });
    write(chatKey(id), null);
    setPreviews(({ [id]: _, ...rest }) => rest);
  }, []);

  const saveChat = useCallback((botId: string, messages: ChatMessage[]) => {
    write(chatKey(botId), messages.length ? messages : null);
    const text = lastText(messages);
    setPreviews((p) => (p[botId] === text ? p : { ...p, [botId]: text }));
  }, []);

  const value = useMemo<BotsValue>(
    () => ({ bots, getBot: (id) => bots.find((b) => b.id === id), createBot, deleteBot, previews, saveChat }),
    [bots, createBot, deleteBot, previews, saveChat],
  );
  return <BotsContext.Provider value={value}>{children}</BotsContext.Provider>;
}

export function useBots(): BotsValue {
  const ctx = useContext(BotsContext);
  if (!ctx) throw new Error("useBots must be used inside BotsProvider");
  return ctx;
}
