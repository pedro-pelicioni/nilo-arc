import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CloseIcon } from "../components/icons";
import { useBots } from "./store";
import { StroopyAvatar } from "./StroopyAvatar";
import { BOT_COLORS, type BotColorId, STROOPIES, type StroopyId, colorHex } from "./stroopies";

/** The caller returns focus to the opener in `onClose`. */
export function CreateBotModal({ onClose }: { onClose: () => void }) {
  const { createBot } = useBots();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [variant, setVariant] = useState<StroopyId>("classic");
  const [color, setColor] = useState<BotColorId>("orange");
  const dialog = useRef<HTMLDivElement>(null);
  // On the document, so Escape and the Tab trap still work after a click leaves focus outside a control.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = dialog.current;
      if (!el) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        const items = el.querySelectorAll<HTMLElement>("button:not(:disabled), input");
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!active || active === el || !el.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const trimmed = name.trim();

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // Otherwise the mousedown blurs the opener that onClose just refocused.
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-bot-title"
        tabIndex={-1}
      >
        <header className="modal-head">
          <h2 id="create-bot-title">Create new bot</h2>
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed) return;
            const bot = createBot({ name: trimmed, variant, color });
            onClose();
            navigate(`/chat/${bot.id}`);
          }}
        >
          <div className="modal-body">
            <StroopyAvatar variant={variant} color={color} size={140} className="modal-preview" />
            <input
              className="bot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name your bot"
              aria-label="Bot name"
              maxLength={32}
              autoFocus
            />
            <div className="variant-grid" role="group" aria-label="Avatar">
              {STROOPIES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="variant-tile"
                  aria-label={s.label}
                  aria-pressed={variant === s.id}
                  title={s.label}
                  onClick={() => setVariant(s.id)}
                >
                  <StroopyAvatar variant={s.id} color={color} neutral={variant !== s.id} size={52} />
                </button>
              ))}
            </div>
            <div className="swatches" role="group" aria-label="Color">
              {BOT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="swatch"
                  style={{ color: colorHex(c.id) }}
                  aria-label={c.id}
                  aria-pressed={color === c.id}
                  title={c.id}
                  onClick={() => setColor(c.id)}
                />
              ))}
            </div>
          </div>
          <footer className="modal-foot">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={!trimmed}>
              Create
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
