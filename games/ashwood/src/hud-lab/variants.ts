import { keyCapHtml } from "@arcade/kit/client/key-cap"

// HUD Lab variants: each draws into the 1600×900 stage. Objectives get the text and whether it's arriving (entrance
// animation); hints and prompts are static markup with CSS entrances. Everything stays in the 1984 paper, typewriter
// and ballpoint world of the clipboard map. No em dashes.

export const OBJECTIVES = ["Find the radio room: 3-08", "Report what you found", "Check the body at the desk", "Hide.", "Find the truck keys"]

export type Variant = { id: string; name: string; note?: string }

export const OBJECTIVE_VARIANTS: Variant[] = [
  { id: "current", name: "Current (top centre typewriter line)", note: "today's HUD, for comparison" },
  { id: "note", name: "Handwritten note, taped top-right", note: "the map's ballpoint on a torn slip" },
  { id: "dymo", name: "Dymo label strip, top-left", note: "embossed white on black tape" },
  { id: "smallcaps", name: "Plain small caps, top-left corner", note: "no box, quiet" },
  { id: "transient", name: "Transient centred title", note: "types in, fades out completely; back on M" },
  { id: "tab", name: "Clipboard tab at the right edge", note: "a corner of the map peeking in" },
  { id: "teletype", name: "Radio teletype line", note: "a strip of yellowed paper tape, typed in" },
  { id: "serif", name: "Minimal serif, bottom centre", note: "one italic line" },
  { id: "none", name: "None (only on the map)", note: "nothing on screen; M shows the map" },
]

export const HINT_VARIANTS: Variant[] = [
  { id: "corner", name: "Tiny key caps, bottom-left", note: "always there, very quiet" },
  { id: "context", name: "Contextual, near the centre", note: "once, when it matters, then gone" },
  { id: "strip", name: "Strip that fades after first use", note: "each key leaves once used" },
  { id: "hand", name: "Hand-drawn keys, margin note", note: "ballpoint boxes and words" },
  { id: "none", name: "None" },
]

export const PROMPT_VARIANTS: Variant[] = [
  { id: "current", name: "Current (key cap on a soft backing)" },
  { id: "slip", name: "Typed slip (paper label)" },
  { id: "hand", name: "Ballpoint (boxed E, handwritten)" },
]

export const HINT_KEYS = [
  { code: "KeyC", key: "C", word: "crouch", context: "crouch to get under" },
  { code: "KeyF", key: "F", word: "flashlight", context: "flashlight" },
  { code: "KeyM", key: "M", word: "map", context: "check the map" },
]

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
/** A seeded wobble per string, so a slip looks the same each time it draws. */
const seed = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)

export function objectiveHtml(id: string, text: string) {
  const t = esc(text)
  const r = (seed(text) % 7) - 3
  switch (id) {
    case "current":
      return `<div class="obj obj-current"><span class="typed" data-text="${t}">${t}</span></div>`
    case "note":
      return `<div class="obj obj-note" style="--rot:${(r * 0.6 - 1.5).toFixed(1)}deg"><i class="tape"></i><span>${t}</span></div>`
    case "dymo":
      return `<div class="obj obj-dymo">${[...text.toUpperCase()].map((c, i) => `<b style="--i:${i}">${c === " " ? "&nbsp;" : esc(c)}</b>`).join("")}</div>`
    case "smallcaps":
      return `<div class="obj obj-smallcaps"><small>objective</small><span class="typed" data-text="${t}">${t}</span></div>`
    case "transient":
      return `<div class="obj obj-transient"><span class="typed" data-text="${t}">${t}</span></div>`
    case "tab":
      return `<div class="obj obj-tab"><i class="clip"></i><span class="paper"><small>A-001 · OBJ.</small>${t}</span></div>`
    case "teletype": {
      const line = `IOPS DIST2 0152  ${text.toUpperCase().replace(/[.:]/g, "").trim()} STOP`
      return `<div class="obj obj-teletype"><span class="typed" data-text="${esc(line)}">${esc(line)}</span></div>`
    }
    case "serif":
      return `<div class="obj obj-serif">${t}</div>`
    default:
      return ""
  }
}

/** A wobbly ballpoint square around a key letter (an inline SVG). */
function handKey(k: string) {
  const s = seed(k)
  const j = (n: number) => (((s >> n) & 7) - 3) * 0.35
  return `<svg class="hk" viewBox="0 0 30 30"><path d="M${3 + j(1)} ${4 + j(2)} L${26 + j(3)} ${3 + j(4)} L${27 + j(5)} ${26 + j(6)} L${4 + j(7)} ${27 + j(8)} Z M${3.6 + j(9)} ${5 + j(10)} L${25.5 + j(11)} ${4 + j(12)}"/><text x="15" y="21">${k}</text></svg>`
}

export function hintsHtml(id: string, used: Set<string>, context: number | null) {
  const cap = (code: string) => keyCapHtml(code, { minimal: true })
  const keys = HINT_KEYS.filter((k) => k.key !== "M" || used.has("withMap"))
  switch (id) {
    case "corner":
      return `<div class="hint hint-corner akc-minimal">${keys.map((k) => `<span>${cap(k.code)}${k.word}</span>`).join("")}</div>`
    case "context": {
      const k = context === null ? null : HINT_KEYS[context]!
      return k ? `<div class="hint hint-context akc-minimal">${cap(k.code)}<span>${k.context}</span></div>` : ""
    }
    case "strip":
      return `<div class="hint hint-strip akc-minimal">${keys.map((k) => `<span class="${used.has(k.key) ? "gone" : ""}">${cap(k.code)}${k.word}</span>`).join("")}</div>`
    case "hand":
      return `<div class="hint hint-hand">${keys.map((k) => `<span class="${used.has(k.key) ? "gone" : ""}">${handKey(k.key)}<em>${k.word}</em></span>`).join("")}</div>`
    default:
      return ""
  }
}

export function promptHtml(id: string, verb: string) {
  const v = esc(verb)
  switch (id) {
    case "slip":
      return `<div class="prompt prompt-slip"><b>E</b><span>${v}</span></div>`
    case "hand":
      return `<div class="prompt prompt-hand">${handKey("E")}<em>${v.toLowerCase()}</em></div>`
    default:
      return `<div class="prompt prompt-current akc-minimal">${keyCapHtml("KeyE", { minimal: true })}<span>${v}</span></div>`
  }
}
