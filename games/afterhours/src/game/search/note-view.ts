import { installHudType } from "../../world/doors/hud"
import type { Note } from "../inventory"

// A note opened to read: an off-white card in the middle of the screen with the note's text in the HUD typewriter
// face. It closes by itself after a reading time, on E or Esc, or when another opens. The clipboard (M) keeps every
// read note on its inventory page.

let el: HTMLDivElement | null = null
let timer = 0

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function ensure() {
  if (el) return el
  installHudType()
  el = document.createElement("div")
  el.className = "note-view"
  Object.assign(el.style, {
    position: "fixed",
    left: "50%",
    top: "46%",
    transform: "translate(-50%, -50%) rotate(-0.6deg)",
    maxWidth: "min(520px, 70vw)",
    padding: "22px 28px 24px",
    background: "rgba(205, 200, 186, 0.96)",
    boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
    color: "#1c1a17",
    font: '15px/1.55 "Afterhours Type", "American Typewriter", "Courier New", monospace',
    letterSpacing: "0.02em",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 0.35s ease",
    zIndex: "7",
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.append(el)
  addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (el?.style.opacity === "1" && (e.code === "KeyE" || e.code === "Escape") && !e.repeat) {
        hideNote()
        e.stopImmediatePropagation()
      }
    },
    { capture: true },
  )
  return el
}

/** Opens `note` to read; `fresh`: first time (a little longer on screen). */
export function showNote(note: Note, fresh = true) {
  const e = ensure()
  clearTimeout(timer)
  e.innerHTML =
    `<div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.55;margin-bottom:10px">${esc(note.title)}</div>` +
    note.text.map((l) => `<div style="margin:0 0 6px">${esc(l)}</div>`).join("") +
    `<div style="font-size:10px;letter-spacing:.14em;opacity:.45;margin-top:12px">E  CLOSE · KEPT ON THE CLIPBOARD (M)</div>`
  // Shown a frame later so the key that opened it doesn't close it.
  setTimeout(() => (e.style.opacity = "1"), 30)
  const words = note.text.join(" ").split(/\s+/).length
  timer = window.setTimeout(hideNote, (Math.max(5, words / 2.6) + (fresh ? 2 : 0)) * 1000)
}

export function hideNote() {
  clearTimeout(timer)
  if (el) el.style.opacity = "0"
}
