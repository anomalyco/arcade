// Controls Lab: the controls, the key-cap styles and the 10 display variants. Each variant returns markup for the
// 1600×900 stage; `View` says what's been used, recalled or is contextually relevant. 1984 paper/typewriter look.

export type CapStyle = "outline" | "filled" | "typewriter" | "bracket"
export type Fade = "always" | "seconds" | "firstUse"

export type Control = { id: string; keys: string[]; word: string; context: string }
/** The only controls taught on screen (the owner's pick); E prompts are contextual, movement is intuitive. */
export const CONTROLS: Control[] = [
  { id: "crouch", keys: ["C"], word: "crouch", context: "crouch to get under" },
  { id: "torch", keys: ["F"], word: "flashlight", context: "flashlight" },
  { id: "map", keys: ["M"], word: "map", context: "check the map" },
]

export type Variant = { id: string; name: string; note: string; recall?: boolean; context?: boolean }
export const VARIANTS: Variant[] = [
  { id: "strip", name: "1. Strip, bottom-left", note: "the current style, three entries" },
  { id: "list", name: "2. Vertical list, left edge", note: "three small typewriter lines" },
  { id: "card", name: "3. Cheat card", note: "fades in at start, out after N s; H / Tab recalls", recall: true },
  { id: "index", name: "4. Procedures index card, pinned", note: "a small ruled card, handwritten keys" },
  { id: "dymo", name: "5. Dymo labels along the bottom", note: "three embossed tapes" },
  { id: "group", name: "6. Small group, bottom-right", note: "the old clusters folded into one block" },
  { id: "glyphs", name: "7. Icon + key, no words", note: "footprint, torch, map" },
  { id: "context", name: "8. Contextual only", note: "each key when it matters; nothing persistent", context: true },
  { id: "pause", name: "9. Pause screen only", note: "nothing on the HUD; Esc shows the three", recall: true },
  { id: "row", name: "10. Tight row of three, bottom-right", note: "three keys, tiny words under each" },
  { id: "stack", name: "11. Glyph + key stack, bottom-right", note: "three tiny pairs stacked" },
  { id: "under", name: "12. Under the objective, top-left", note: "typed labels under the corner line: one tidy block" },
]

export type View = { style: CapStyle; used: Set<string>; recalled: boolean; context: string | null; faded: boolean; fade: Fade }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function cap(k: string, style: CapStyle, hold = false) {
  const wide = k.length > 1 ? " wide" : ""
  const body = style === "bracket" ? `[${esc(k)}]` : esc(k)
  return `<kbd class="k k-${style}${wide}${hold ? " hold" : ""}">${body}</kbd>`
}
const keys = (c: Control, s: CapStyle) => cap(c.keys[0]!, s)
const word = (c: Control) => c.word

/** Fade class for one control: after N seconds everything goes; after first use, that control goes. */
const gone = (c: Control, v: View) => (v.fade === "firstUse" && v.used.has(c.id)) || (v.fade === "seconds" && v.faded)
const item = (c: Control, v: View, cls = "item") => `<span class="${cls}${gone(c, v) ? " gone" : ""}">${keys(c, v.style)}<span class="w">${word(c)}</span></span>`

/** A wobbly ballpoint box with a letter in it (inline SVG, seeded per letter). */
function handKey(k: string) {
  const s = [...k].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7)
  const j = (n: number) => (((s >> n) & 7) - 3) * 0.35
  const w = Math.max(30, 12 + k.length * 11)
  return `<svg class="hk" viewBox="0 0 ${w} 30" style="width:${w}px"><path d="M${3 + j(1)} ${4 + j(2)} L${w - 4 + j(3)} ${3 + j(4)} L${w - 3 + j(5)} ${26 + j(6)} L${4 + j(7)} ${27 + j(8)} Z M${3.6 + j(9)} ${5 + j(10)} L${w - 4.5 + j(11)} ${4 + j(12)}"/><text x="${w / 2}" y="21">${esc(k)}</text></svg>`
}

const ICONS: Record<string, string> = {
  crouch: `<path d="M11 5c-3 0-4 4-4 8s1 9 4 11c2 1 4 0 4-3 0-4-2-6-2-10 0-3 0-6-2-6z M19 13c-2 0-3 3-3 5s1 6 3 7c2 0 3-1 3-3 0-3-1-4-1-6 0-2 0-3-2-3z"/>`,
  torch: `<path d="M6 12h10l3-4h5v14h-5l-3-4H6z M26 11l3-2M26 15h3M26 19l3 2"/>`,
  map: `<path d="M4 7l7-3 8 3 7-3v19l-7 3-8-3-7 3z M11 4v19M19 7v19"/>`,
}
const icon = (id: string) => `<svg class="ic" viewBox="0 0 30 30">${ICONS[id] ?? ""}</svg>`

/** The recall card / pause page: the three on a slip of paper. */
function sheet(v: View, title: string, subtitle: string) {
  return `<div class="sheet"><h3>${esc(title)}</h3><small>${esc(subtitle)}</small><ul>${CONTROLS.map((c) => `<li>${keys(c, v.style)}<span class="w">${word(c)}</span></li>`).join("")}</ul></div>`
}

const all = (v: View, cls = "item") => CONTROLS.map((c) => item(c, v, cls)).join("")

export function controlsHtml(id: string, v: View) {
  switch (id) {
    case "strip":
      return `<div class="ctl ctl-strip">${all(v)}</div>`
    case "list":
      return `<div class="ctl ctl-list">${all(v)}</div>`
    case "card":
      return `<div class="ctl ctl-card${v.faded && !v.recalled ? " gone" : ""}">${sheet(v, "Controls", "H or Tab to show again")}</div>`
    case "index":
      return `<div class="ctl ctl-index"><i class="pin"></i><h4>PROCEDURES</h4><ul>${CONTROLS.map((c) => `<li class="${gone(c, v) ? "gone" : ""}">${handKey(c.keys[0]!)}<span>${esc(c.word)}</span></li>`).join("")}</ul></div>`
    case "dymo":
      return `<div class="ctl ctl-dymo">${CONTROLS.map((c) => `<span class="tape${gone(c, v) ? " gone" : ""}"><b>${esc(c.keys[0]!)}</b>${esc(c.word.toUpperCase())}</span>`).join("")}</div>`
    case "group":
      return `<div class="ctl ctl-group">${all(v)}</div>`
    case "glyphs":
      return `<div class="ctl ctl-glyphs">${CONTROLS.map((c) => `<span class="g${gone(c, v) ? " gone" : ""}" title="${esc(c.word)}">${icon(c.id)}${cap(c.keys[0]!, v.style)}</span>`).join("")}</div>`
    case "context": {
      const c = CONTROLS.find((x) => x.id === v.context)
      return c && !v.used.has(c.id) ? `<div class="ctl ctl-context">${keys(c, v.style)}<span class="w">${esc(c.context)}</span></div>` : ""
    }
    case "pause":
      return v.recalled
        ? `<div class="ctl ctl-pause"><div class="pause-head">PAUSED</div><div class="pause-menu"><b>Resume</b><span>Settings</span><span>Quit to title</span></div>${sheet(v, "Controls", "Esc to resume")}</div>`
        : ""
    case "row":
      return `<div class="ctl ctl-row">${CONTROLS.map((c) => `<span class="rk${gone(c, v) ? " gone" : ""}">${cap(c.keys[0]!, v.style)}<span class="w">${word(c)}</span></span>`).join("")}</div>`
    case "stack":
      return `<div class="ctl ctl-stack">${CONTROLS.map((c) => `<span class="g${gone(c, v) ? " gone" : ""}">${cap(c.keys[0]!, v.style)}${icon(c.id)}</span>`).join("")}</div>`
    case "under":
      return `<div class="ctl ctl-under">${all(v)}</div>`
    default:
      return ""
  }
}
