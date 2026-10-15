import { confirm, overlayLook, toast, tooltips, type ConfirmOptions } from "@arcade/knobs/ui"
import { arcadePreset } from "../lab-knobs"

let ready = false

/** knobs' overlays (palette, confirm, toasts, tooltips) in the Lab's look; `data-tip` hints on. Once per page. */
export function setupLabOverlays() {
  if (ready) return
  ready = true
  overlayLook({ preset: arcadePreset, theme: "dark" })
  tooltips(document)
}

/** A toolbar hint: its text, and a shortcut (`"Mod+Z"`, `"Shift+V"`, `"K"`) shown as key chips. */
export function tip(el: HTMLElement, text: string, shortcut?: string) {
  el.removeAttribute("title")
  if (el.dataset.tip !== text) el.dataset.tip = text
  if (shortcut) el.dataset.tipShortcut = shortcut
  else delete el.dataset.tipShortcut
}

let asking = 0

/** knobs' confirm, counted so the workbench's keys stay out while one is open (not while it animates away). */
export async function ask(options: ConfirmOptions): Promise<boolean> {
  asking++
  try {
    return await confirm(options)
  } finally {
    asking--
  }
}

/** Whether a confirm is waiting for an answer. */
export const isAsking = () => asking > 0

/** A transient notice at the bottom of the window (errors stay longer), with an optional action such as Undo. */
export function notify(message: string, isError = false, action?: { label: string; run: () => void }) {
  toast(message, { tone: isError ? "error" : "info", ...(action ? { action, linger: 5000 } : {}) })
}

const GLYPH_MODS: Record<string, string> = { "⌘": "Mod", "⇧": "Shift", "⌥": "Alt", "⌃": "Ctrl" }

/** A command's shortcut as the Lab writes it (`⇧⌘Z`, `⌫`, `Ctrl Space`) in knobs' combo form; none for ranges like `1–9`. */
export function knobsCombo(shortcut: string | undefined): string | undefined {
  if (!shortcut || shortcut.includes("–")) return undefined
  const mods: string[] = []
  let rest = shortcut.trim()
  if (rest.startsWith("Ctrl ")) {
    mods.push("Ctrl")
    rest = rest.slice(5)
  }
  while (rest && GLYPH_MODS[rest[0]!]) {
    mods.push(GLYPH_MODS[rest[0]!]!)
    rest = rest.slice(1)
  }
  const key = rest === "⌫" ? "Backspace" : rest === "Esc" ? "Escape" : rest
  return key ? [...mods, key].join("+") : undefined
}
