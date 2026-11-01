import { type CSSProperties, useState } from "react";
import { type BotColorId, STROOPIES, type StroopyId, colorHex, stroopySrc } from "./stroopies";

export const NEUTRAL_TINT = "#6f6f6f";

/** Images that failed once (not generated yet); skip straight to the fallback. Retried after the window regains focus. */
const broken = new Set<string>();
addEventListener("focus", () => broken.clear());

/** Fallback silhouettes, one per variant, so bots stay tell-apart without images. */
const BLOBS = [
  "50%",
  "42% 58% 55% 45% / 50% 45% 55% 50%",
  "30%",
  "58% 42% 38% 62% / 45% 55% 45% 55%",
  "46% 54% 60% 40% / 58% 46% 54% 42%",
  "36% 64% 50% 50% / 50% 38% 62% 50%",
];

interface Props {
  variant: StroopyId;
  color?: BotColorId;
  size?: number;
  /** Gray, for unselected choices. */
  neutral?: boolean;
  className?: string;
}

/**
 * A Stroopy tinted with the bot's color: the grayscale image is used as a mask
 * over the tint and multiplied on top, so light parts take the color and the
 * dark visor and outlines stay dark.
 */
export function StroopyAvatar({ variant, color = "gray", size = 52, neutral, className }: Props) {
  const src = stroopySrc(variant);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const tint = neutral ? NEUTRAL_TINT : colorHex(color);
  const index = STROOPIES.findIndex((s) => s.id === variant);
  const box: CSSProperties = { width: size, height: size };

  if (failedSrc === src || broken.has(src)) {
    return (
      <span className={`stroopy ${className ?? ""}`} style={box} aria-hidden="true">
        <span
          className="stroopy-blob"
          style={{ background: tint, borderRadius: BLOBS[index % BLOBS.length], transform: `rotate(${(index % 3) * 8 - 8}deg)` }}
        >
          <i style={{ width: Math.max(2, size * 0.07), height: size * 0.2 }} />
          <i style={{ width: Math.max(2, size * 0.07), height: size * 0.2 }} />
        </span>
      </span>
    );
  }

  const mask = `url(${src}) center / contain no-repeat`;
  return (
    <span className={`stroopy ${className ?? ""}`} style={box} aria-hidden="true">
      <span className="stroopy-tint" style={{ background: tint, WebkitMask: mask, mask }}>
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => {
            broken.add(src);
            setFailedSrc(src);
          }}
        />
      </span>
    </span>
  );
}
