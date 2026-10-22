/** Dressing props shipped in `public/look/props/` (sources and licences in `public/CREDITS.md`), texture size in px. */
export const LOOK_PROP_FILES = [
  { file: "mug", texture: 256 },
  { file: "paper-stack", texture: 256 },
  { file: "paper-sheet", texture: 256 },
  { file: "yellow-pad", texture: 256 },
  { file: "sticky-note", texture: 256 },
  { file: "phone-alt", texture: 256 },
  { file: "desk-lamp", texture: 256 },
  { file: "dead-plant", texture: 256 },
  { file: "waste-bin", texture: 256 },
  { file: "file-box", texture: 256 },
  { file: "cardboard-box", texture: 512 },
  { file: "letter-tray", texture: 256 },
  { file: "clipboard", texture: 256 },
  { file: "stapler", texture: 256 },
  { file: "wall-clock", texture: 256 },
  { file: "pen-cup-ph", texture: 256 },
] as const
export type LookPropFile = typeof LOOK_PROP_FILES[number]["file"]
