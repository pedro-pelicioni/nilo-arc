// Nilo's mascot for bots: a little arch (Arc) with a ring around it (Circle). Each image is grayscale on a
// transparent background; the app tints it with the bot's color, so one file serves every color. The first
// four are hand-drawn SVGs; the accessory variants were generated with Higgsfield from the Classic drawing and
// keyed out of a chroma background. Add an entry only once its file exists in public/mascots/.

export const MASCOTS = [
  { id: "classic", label: "Classic", file: "classic.svg" },
  { id: "sleepy", label: "Sleepy", file: "sleepy.svg" },
  { id: "sprout", label: "Sprout", file: "sprout.svg" },
  { id: "graduate", label: "Graduate", file: "graduate.svg" },
  { id: "shades", label: "Shades", file: "shades.png" },
  { id: "support", label: "Support", file: "support.png" },
  { id: "crown", label: "Crown", file: "crown.png" },
  { id: "cap", label: "Cap", file: "cap.png" },
] as const;

export type MascotId = (typeof MASCOTS)[number]["id"];

export const mascotSrc = (id: MascotId) => `/mascots/${MASCOTS.find((m) => m.id === id)?.file ?? "classic.svg"}`;

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
