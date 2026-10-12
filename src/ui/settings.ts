import type { Quality } from "../sim/types"

export interface Settings {
  name: string
  quality: Quality
  muted: boolean
  volume: number
  sensitivity: number
  invertY: boolean
  /** Direct (Daxship-style rate steering, default) or War Thunder-style mouse-aim. */
  controlStyle: "direct" | "aim"
  /** Pilot control scheme (see input.ts CONTROL_SCHEMES); default "point". */
  controlScheme?: "point" | "battlefield" | "aim"
  /** Bots per team for offline practice (0 = free flight). */
  practiceBots?: number
}

const KEY = "wings.settings"
type Listener = (s: Settings) => void
const listeners: Listener[] = []

function defaults(): Settings {
  const lowEnd = (navigator.hardwareConcurrency ?? 8) <= 4 || /Mobi|Android/i.test(navigator.userAgent)
  return { name: "", quality: lowEnd ? "low" : "balanced", muted: false, volume: 0.8, sensitivity: 1, invertY: false, controlStyle: "direct", controlScheme: "point", practiceBots: 0 }
}

function load(): Settings {
  const base = defaults()
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) Object.assign(base, JSON.parse(raw))
  } catch {}
  if (base.controlStyle !== "direct" && base.controlStyle !== "aim") base.controlStyle = "direct"
  if (base.controlScheme !== "point" && base.controlScheme !== "battlefield" && base.controlScheme !== "aim") base.controlScheme = base.controlStyle === "aim" ? "aim" : "point"
  base.practiceBots = Math.max(0, Math.min(10, Math.round(Number(base.practiceBots ?? 0)) || 0))
  if (base.quality !== "low" && base.quality !== "balanced" && base.quality !== "high") base.quality = "balanced"
  return base
}

export const settings: Settings = load()

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch)
  try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch {}
  for (const l of listeners) l(settings)
}

export function onSettings(l: Listener): () => void {
  listeners.push(l)
  return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1) }
}

const ADJ = ["GRIM", "PALE", "HOLLOW", "SILENT", "ASHEN", "DROWNED", "STARLESS", "IRON", "WEEPING", "NAMELESS"]
const NOUN = ["HERON", "MOTH", "WRAITH", "KESTREL", "LANTERN", "VIGIL", "OMEN", "TIDE", "SHRIKE", "WARDEN"]

export function randomCallsign(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)]
  const n = NOUN[Math.floor(Math.random() * NOUN.length)]
  return `${a} ${n}`.slice(0, 16)
}

export function callsign(): string {
  return (settings.name || "").trim().slice(0, 16) || randomCallsign()
}
