import { useEffect, useRef } from "react";
import type { VoiceLevels, VoiceState } from "../voice";

/** Relative height of each bar, so the meter reads as a waveform. */
const SHAPE = [0.55, 0.8, 1, 0.8, 0.55];
/** Assistant loudness above which it counts as speaking. */
const SPEAKING = 0.02;
/** Keep "speaking" this long after it goes quiet, so the label doesn't flicker between words. */
const HOLD_MS = 400;

const STATUS: Record<VoiceState, string> = {
  idle: "",
  connecting: "Connecting…",
  live: "Listening",
  closing: "Ending…",
};

/**
 * Shown in place of the text box while voice mode is on: a live level meter of the microphone,
 * or of the assistant while it speaks. Updated on every animation frame straight in the DOM,
 * not through React state.
 */
export function VoiceBar({ state, levels, name }: { state: VoiceState; levels: () => VoiceLevels; name: string }) {
  const root = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const read = useRef(levels);
  read.current = levels;

  useEffect(() => {
    const el = root.current;
    if (state !== "live" || !el) return;
    const bars = [...el.querySelectorAll<HTMLElement>("i")];
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let level = 0;
    let speakingUntil = 0;
    let frame = 0;
    const tick = (now: number) => {
      const { mic, out } = read.current();
      if (out > SPEAKING && out > mic) speakingUntil = now + HOLD_MS;
      const speaking = now < speakingUntil;
      el.classList.toggle("speaking", speaking);
      if (label.current) label.current.textContent = speaking ? `${name} is speaking` : STATUS.live;
      // Speech is quiet in RMS terms: the square root lifts it into a visible range.
      const target = Math.min(1, Math.sqrt(speaking ? out : mic) * 1.8);
      level += (target - level) * (target > level ? 0.5 : 0.15);
      if (!still) bars.forEach((b, i) => b.style.setProperty("--lvl", String(level * SHAPE[i])));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.classList.remove("speaking");
      bars.forEach((b) => b.style.removeProperty("--lvl"));
    };
  }, [state, name]);

  return (
    <div ref={root} className={`voice-bar ${state}`}>
      <span className="voice-meter" aria-hidden="true">
        {SHAPE.map((_, i) => (
          <i key={i} />
        ))}
      </span>
      <span ref={label} className="voice-label" aria-hidden="true">
        {STATUS[state]}
      </span>
      {/* Only the state is announced, not every change of who is speaking. */}
      <span className="sr-only" role="status">
        {state === "live" ? `Voice mode on. ${name} is listening.` : STATUS[state]}
      </span>
    </div>
  );
}
