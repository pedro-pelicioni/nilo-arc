import { useEffect, useRef, useState } from "react";
import type { VoiceLevels, VoiceState } from "../voice";
import { CloseIcon } from "./icons";
import { VoiceOrb } from "./VoiceOrb";

/**
 * Voice mode as a voice-only view filling the chat panel: the orb, the state and what the
 * assistant is doing, no transcript. The conversation still goes to the chat history, which
 * shows again when voice mode ends.
 */
export function VoiceOverlay({
  state,
  levels,
  spectrum,
  task,
  name,
  onEnd,
}: {
  state: VoiceState;
  levels: () => VoiceLevels;
  spectrum: (side: "mic" | "out", into: Uint8Array<ArrayBuffer>) => boolean;
  /** What a running tool is doing, e.g. "Checking your balance…". */
  task: string | null;
  name: string;
  onEnd: () => void;
}) {
  const [speaking, setSpeaking] = useState(false);
  const end = useRef<HTMLButtonElement>(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    end.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onEndRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mood = state === "live" ? (speaking ? "speaking" : "listening") : state;
  const title =
    state === "connecting" ? "Connecting…" : state === "closing" ? "Ending…" : speaking ? `${name} is speaking` : "Listening…";
  const subtitle =
    task ??
    (state === "connecting"
      ? "Setting up a secure session"
      : state === "closing"
        ? "Closing the session"
        : speaking
          ? "Interrupt anytime"
          : "Speak naturally. I'm here to help.");

  return (
    <div className={`voice-overlay ${mood}`} role="region" aria-label="Voice mode">
      <p className="voice-tag">Voice mode</p>

      <div className="voice-main">
        <VoiceOrb state={state} speaking={speaking} levels={levels} spectrum={spectrum} onSpeakingChange={setSpeaking} />
        <div className="voice-text">
          <p className="voice-title" aria-hidden="true">
            {title}
          </p>
          <p className="voice-subtitle" aria-live="polite">
            {subtitle}
          </p>
          {/* Only the state is announced, not every change of who is speaking. */}
          <span className="sr-only" role="status">
            {state === "live" ? `Voice mode on. ${name} is listening.` : title}
          </span>
        </div>
      </div>

      <div className="voice-cancel">
        <button
          ref={end}
          type="button"
          onClick={onEnd}
          disabled={state === "closing"}
          aria-label="End voice mode"
          title="End voice mode (Esc)"
        >
          <CloseIcon />
        </button>
        <span aria-hidden="true">Cancel</span>
      </div>
    </div>
  );
}
