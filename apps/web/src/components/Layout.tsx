// App shell: the bot sidebar (an off-canvas drawer on phones) and the main column.
import {
  type ComponentType,
  type ReactNode,
  type Ref,
  type SVGProps,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { CreateBotModal } from "../bots/CreateBotModal";
import { DEFAULT_BOT, DEFAULT_PREVIEW, useBots } from "../bots/store";
import { MascotAvatar } from "../bots/MascotAvatar";
import { profileLabel, useProfile } from "../profile";
import { network } from "../arc";
import { WATCHING, useWallet } from "../wallet";
import { Onboarding } from "./Onboarding";
import {
  AgentIcon,
  ChartIcon,
  CoinsIcon,
  HistoryIcon,
  InboxIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  UserIcon,
  WalletIcon,
} from "./icons";

/** Chat actions the chat page runs when it is opened with this router state. */
export type ChatAction = "example" | "balance" | "price" | "fiat";
export interface ChatActionState {
  action: ChatAction;
  /** Makes a repeated click a new navigation. */
  at: number;
}

export interface QuickAction {
  title: string;
  hint: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: "violet" | "blue" | "green" | "purple";
  /** Omitted for chat actions, which run in the current bot's chat. */
  to?: string;
  action?: ChatAction;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { title: "Put my money to work", hint: "An agent that invests while you sleep", Icon: AgentIcon, tone: "violet", to: "/agent" },
  { title: "Send a payment", hint: "To a contact or any 0x… address", Icon: SendIcon, tone: "violet", action: "example" },
  { title: "Check balance", hint: "View your available funds", Icon: WalletIcon, tone: "blue", action: "balance" },
  { title: "Claim a payment", hint: "See what's waiting for you", Icon: InboxIcon, tone: "green", to: "/claim" },
  { title: "Sent payments", hint: "Track or recover what you sent", Icon: HistoryIcon, tone: "purple", to: "/sent" },
  { title: "Check a price", hint: "Live USDC, BTC, ETH, EUR and BRL rates", Icon: ChartIcon, tone: "blue", action: "price" },
  { title: "Send in reais", hint: "Pay R$ worth of USDC", Icon: CoinsIcon, tone: "violet", action: "fiat" },
];

export function useQuickAction(chatPath = `/chat/${DEFAULT_BOT.id}`) {
  const navigate = useNavigate();
  return (a: QuickAction) =>
    navigate(a.to ?? chatPath, a.action ? { state: { action: a.action, at: Date.now() } satisfies ChatActionState } : undefined);
}

/** README section that explains why the decoded explanation can be trusted. */
export const TRUST_URL = "https://github.com/pedro-pelicioni/nilo-arc#why-you-can-trust-what-you-sign";

const ShellContext = createContext<{ openDrawer: () => void; drawerOpen: boolean }>({
  openDrawer: () => {},
  drawerOpen: false,
});

export function Shell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const sidebar = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const { pathname } = useLocation();
  const { address } = useWallet();
  const [profile] = useProfile(address);
  // First sign-in of an address: ask for the profile while its account is set up.
  const [onboarding, setOnboarding] = useState<"first" | "edit" | null>(null);
  useEffect(() => {
    if (address && !WATCHING && !profile) setOnboarding("first");
  }, [address, profile]);

  useEffect(() => setDrawerOpen(false), [pathname]);
  // Move focus into the drawer when it opens, and back to the menu button when it closes.
  useEffect(() => {
    const el = sidebar.current;
    if (drawerOpen) el?.querySelector<HTMLElement>(".side-row.active, .side-row")?.focus();
    else if (wasOpen.current && (!document.activeElement || document.activeElement === document.body || el?.contains(document.activeElement)))
      document.querySelector<HTMLElement>(".menu-btn")?.focus();
    wasOpen.current = drawerOpen;
  }, [drawerOpen]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  function openCreate() {
    opener.current = document.activeElement as HTMLElement | null;
    setCreating(true);
  }
  function closeCreate() {
    setCreating(false);
    opener.current?.focus();
  }

  return (
    <ShellContext.Provider value={{ openDrawer: () => setDrawerOpen(true), drawerOpen }}>
      <div className={`app${drawerOpen ? " drawer-open" : ""}`}>
        <Sidebar
          ref={sidebar}
          onCreate={openCreate}
          onNavigate={() => setDrawerOpen(false)}
          onProfile={() => {
            setDrawerOpen(false);
            setOnboarding("edit");
          }}
        />
        <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
        <main className="main">{children}</main>
        {creating && <CreateBotModal onClose={closeCreate} />}
        {onboarding && <Onboarding mode={onboarding} onClose={() => setOnboarding(null)} />}
      </div>
    </ShellContext.Provider>
  );
}

function Sidebar({
  ref,
  onCreate,
  onNavigate,
  onProfile,
}: {
  ref: Ref<HTMLElement>;
  onCreate: () => void;
  onNavigate: () => void;
  onProfile: () => void;
}) {
  const { bots, previews } = useBots();
  const { error, address } = useWallet();
  const [profile] = useProfile(address);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = searching && q ? bots.filter((b) => b.name.toLowerCase().includes(q)) : bots;

  return (
    <aside ref={ref} className="sidebar" id="sidebar" aria-label="Bots and payments">
      <div className="side-head">
        <span className="wordmark">Nilo</span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            setSearching((s) => !s);
            setQuery("");
          }}
          aria-label="Search bots"
          aria-pressed={searching}
          title="Search bots"
        >
          <SearchIcon />
        </button>
        <button type="button" className="icon-btn" onClick={onCreate} aria-label="Create bot" title="Create bot">
          <PlusIcon />
        </button>
      </div>
      {searching && (
        <input
          className="side-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setSearching(false);
            setQuery("");
          }}
          placeholder="Search bots"
          aria-label="Search bots"
          autoFocus
        />
      )}

      <nav className="side-list">
        <NavLink to="/agent" className="side-row" onClick={onNavigate}>
          <span className="row-avatar tone-violet">
            <AgentIcon />
          </span>
          <span className="row-text">
            <strong>Agent</strong>
            <span>Invests while you sleep</span>
          </span>
        </NavLink>
        <NavLink to="/claim" className="side-row" onClick={onNavigate}>
          <span className="row-avatar tone-green">
            <InboxIcon />
          </span>
          <span className="row-text">
            <strong>Claim</strong>
            <span>Payments waiting for you</span>
          </span>
        </NavLink>
        <NavLink to="/sent" className="side-row" onClick={onNavigate}>
          <span className="row-avatar tone-blue">
            <HistoryIcon />
          </span>
          <span className="row-text">
            <strong>Sent</strong>
            <span>Track or recover what you sent</span>
          </span>
        </NavLink>

        <p className="side-label">Bots</p>
        {shown.map((b) => (
          <NavLink key={b.id} to={`/chat/${b.id}`} className="side-row" onClick={onNavigate}>
            <MascotAvatar variant={b.variant} color={b.color} size={52} />
            <span className="row-text">
              <strong>{b.name}</strong>
              <span>{previews[b.id] ?? DEFAULT_PREVIEW}</span>
            </span>
          </NavLink>
        ))}
        {shown.length === 0 && <p className="side-empty">No bots match "{query.trim()}".</p>}
      </nav>

      {error && <p className="error small side-error">{error}</p>}
      {profile && (
        <button type="button" className="profile-chip" onClick={onProfile} title="Change your investor profile">
          Profile: <strong>{profileLabel(profile)}</strong>
        </button>
      )}
      <div className="side-foot">
        <div className="me">
          <span className="me-avatar">
            <UserIcon width={18} height={18} />
          </span>
          <div className="wallet-chip">
            <WalletButton />
          </div>
        </div>
        <span className="net-chip" role="img" aria-label={network.name} title={network.name}>
          <i className="dot" />
        </span>
      </div>
    </aside>
  );
}

/** Floating header of the main column: menu (phones), title pill and optional actions. */
export function PageTop({ avatar, title, actions }: { avatar: ReactNode; title: string; actions?: ReactNode }) {
  const { openDrawer, drawerOpen } = useContext(ShellContext);
  return (
    <header className="page-top">
      <button
        type="button"
        className="icon-btn menu-btn"
        onClick={openDrawer}
        aria-label="Open menu"
        aria-controls="sidebar"
        aria-expanded={drawerOpen}
      >
        <MenuIcon />
      </button>
      <div className="title-pill">
        {avatar}
        <span>{title}</span>
      </div>
      <div className="page-actions">{actions}</div>
    </header>
  );
}

/** Small round menu anchored to its button; closes on outside click or Escape. */
export function MoreMenu({ label, trigger, children }: { label: string; trigger: ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => root.current?.contains(e.target as Node) || setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("mousedown", onDown);
      removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="more" ref={root}>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
      >
        {trigger}
      </button>
      {open && (
        <div className="menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Connect button, or the connected address. The wallet itself handles accounts and disconnecting. */
function WalletButton() {
  const { address, onArc, connect, error } = useWallet();
  if (!address)
    return (
      <button type="button" className="wallet-btn" onClick={connect} disabled={!!error} title={error ?? undefined}>
        Connect wallet
      </button>
    );
  return (
    <button
      type="button"
      className="wallet-btn connected"
      onClick={onArc ? undefined : connect}
      title={onArc ? address : `Switch to ${network.name}`}
    >
      {onArc ? `${address.slice(0, 6)}…${address.slice(-4)}` : `Switch to ${network.name}`}
    </button>
  );
}
