// Stroopy avatars for bots. Each image is a grayscale Stroopy on a transparent
// background; the app tints it with the bot's color, so one file serves every color.
// Add an entry only once public/stroopies/<id>.png exists.

export const STROOPIES = [
  { id: "classic", label: "Classic" },
  { id: "antenna", label: "Antenna" },
  { id: "beanie", label: "Beanie" },
  { id: "graduate", label: "Graduate" },
] as const;

export type StroopyId = (typeof STROOPIES)[number]["id"];

export const stroopySrc = (id: StroopyId) => `/stroopies/${id}.png`;

export const BOT_COLORS = [
  { id: "white", hex: "#f2f2f2" },
  { id: "brown", hex: "#9b6a43" },
  { id: "red", hex: "#e5484d" },
  { id: "orange", hex: "#ea7234" },
  { id: "amber", hex: "#eba13c" },
  { id: "green", hex: "#5bc17b" },
  { id: "teal", hex: "#4fb3a5" },
  { id: "blue", hex: "#3d85f0" },
  { id: "violet", hex: "#8b5cf6" },
  { id: "pink", hex: "#e5489a" },
  { id: "gray", hex: "#7c7c7c" },
] as const;

export type BotColorId = (typeof BOT_COLORS)[number]["id"];

export const colorHex = (id: BotColorId) => BOT_COLORS.find((c) => c.id === id)?.hex ?? "#7c7c7c";
