import { overlayLook, toast, tooltips } from "@arcade/knobs/ui"
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

/** A transient notice at the bottom of the window (errors stay longer), with an optional action such as Undo. */
export function notify(message: string, isError = false, action?: { label: string; run: () => void }) {
  toast(message, { tone: isError ? "error" : "info", ...(action ? { action, linger: 5000 } : {}) })
}
