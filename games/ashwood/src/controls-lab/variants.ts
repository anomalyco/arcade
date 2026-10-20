// Controls Lab: the controls, the key-cap styles and the 10 display variants. Each variant returns markup for the
// 1600×900 stage; `View` says what's been used, recalled or is contextually relevant. 1984 paper/typewriter look.

export type CapStyle = "outline" | "filled" | "typewriter" | "bracket"
export type Fade = "always" | "seconds" | "firstUse"

export type Control = { id: string; keys: string[]; word: string; group: "move" | "act"; hold?: boolean; context?: string }
export const CONTROLS: Control[] = [
  { id: "move", keys: ["W", "A", "S", "D"], word: "move", group: "move" },
  { id: "run", keys: ["Shift"], word: "run", group: "move" },
  { id: "crouch", keys: ["C"], word: "crouch", group: "move", context: "crouch to get under" },
  { id: "jump", keys: ["Space"], word: "jump / climb", group: "move", context: "climb" },
  { id: "use", keys: ["E"], word: "interact", group: "act" },
  { id: "search", keys: ["E"], word: "search", group: "act", hold: true, context: "hold to search" },
  { id: "torch", keys: ["F"], word: "flashlight", group: "act", context: "flashlight" },
  { id: "map", keys: ["M"], word: "map", group: "act", context: "check the map" },
  { id: "pause", keys: ["Esc"], word: "pause", group: "act" },
]
/** The ones the owner wants taught persistently in variant 8. */
export const ESSENTIAL = ["crouch", "torch", "map"]

export type Variant = { id: string; name: string; note: string; recall?: boolean; context?: boolean }
export const VARIANTS: Variant[] = [
  { id: "strip", name: "1. Current strip, bottom-left", note: "the baseline" },
  { id: "list", name: "2. Vertical list, left edge", note: "small typewriter caps, one per line" },
  { id: "card", name: "3. Two-column cheat card", note: "fades in at start, out after ~10 s; H / Tab recalls", recall: true },
  { id: "index", name: "4. Procedures index card, pinned", note: "clipboard paper, handwritten keys" },
  { id: "dymo", name: "5. Dymo strip along the bottom", note: "embossed label tape" },
  { id: "clusters", name: "6. Grouped clusters", note: "movement bottom-left, actions bottom-right" },
  { id: "glyphs", name: "7. Icon + key glyphs, no words", note: "footprint, torch, map, hand…" },
  { id: "essential", name: "8. Only C, F, M persistent", note: "the rest on a recall screen (H / Tab)", recall: true },
  { id: "context", name: "9. Contextual only", note: "each key when it matters; nothing persistent", context: true },
  { id: "pause", name: "10. Pause screen only", note: "nothing on the HUD; Esc shows the controls page", recall: true },
]

export type View = { style: CapStyle; used: Set<string>; recalled: boolean; context: string | null; faded: boolean; fade: Fade }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function cap(k: string, style: CapStyle, hold = false) {
  const wide = k.length > 1 ? " wide" : ""
  const body = style === "bracket" ? `[${esc(k)}]` : esc(k)
  return `<kbd class="k k-${style}${wide}${hold ? " hold" : ""}">${body}</kbd>`
}
const keys = (c: Control, s: CapStyle) =>
  c.id === "move" && s !== "bracket" ? `<span class="wasd">${c.keys.map((k) => cap(k, s)).join("")}</span>` : cap(c.id === "move" ? "WASD" : c.keys[0]!, s, c.hold)
const word = (c: Control) => (c.hold ? `<em>hold</em> ${c.word}` : c.word)

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
  move: `<path d="M15 4v22M4 15h22M15 4l-4 4M15 4l4 4M15 26l-4-4M15 26l4-4M4 15l4-4M4 15l4 4M26 15l-4-4M26 15l-4 4"/>`,
  run: `<path d="M6 8l7 7-7 7M15 8l7 7-7 7"/>`,
  crouch: `<path d="M11 5c-3 0-4 4-4 8s1 9 4 11c2 1 4 0 4-3 0-4-2-6-2-10 0-3 0-6-2-6z M19 13c-2 0-3 3-3 5s1 6 3 7c2 0 3-1 3-3 0-3-1-4-1-6 0-2 0-3-2-3z"/>`,
  jump: `<path d="M15 25V6M8 13l7-7 7 7M7 26h16"/>`,
  use: `<path d="M10 16V7a2 2 0 014 0v8M14 14V5a2 2 0 014 0v10M18 14V7a2 2 0 014 0v10c0 6-3 9-7 9s-6-2-8-6l-3-5a2 2 0 013-2l3 3"/>`,
  search: `<circle cx="13" cy="13" r="7"/><path d="M18 18l7 7"/>`,
  torch: `<path d="M6 12h10l3-4h5v14h-5l-3-4H6z M26 11l3-2M26 15h3M26 19l3 2"/>`,
  map: `<path d="M4 7l7-3 8 3 7-3v19l-7 3-8-3-7 3z M11 4v19M19 7v19"/>`,
  pause: `<path d="M11 7v16M19 7v16"/>`,
}
const icon = (id: string) => `<svg class="ic" viewBox="0 0 30 30">${ICONS[id] ?? ""}</svg>`

/** The recall screen / pause page: every control in two columns on a sheet of paper. */
function sheet(v: View, title: string, subtitle: string) {
  const col = (g: Control["group"]) => CONTROLS.filter((c) => c.group === g).map((c) => `<li>${keys(c, v.style)}<span class="w">${word(c)}</span></li>`).join("")
  return `<div class="sheet"><h3>${esc(title)}</h3><small>${esc(subtitle)}</small><div class="cols"><ul>${col("move")}</ul><ul>${col("act")}</ul></div></div>`
}

export function controlsHtml(id: string, v: View) {
  switch (id) {
    case "strip":
      return `<div class="ctl ctl-strip">${CONTROLS.filter((c) => c.id !== "search").map((c) => item(c, v)).join("")}</div>`
    case "list":
      return `<div class="ctl ctl-list">${CONTROLS.map((c) => item(c, v)).join("")}</div>`
    case "card":
      return `<div class="ctl ctl-card${v.faded && !v.recalled ? " gone" : ""}">${sheet(v, "Controls", "H or Tab to show again")}</div>`
    case "index": {
      const rows = CONTROLS.map((c) => `<li class="${gone(c, v) ? "gone" : ""}">${handKey(c.id === "move" ? "WASD" : c.keys[0]!)}<span>${c.hold ? "hold " : ""}${esc(c.word)}</span></li>`).join("")
      return `<div class="ctl ctl-index"><i class="pin"></i><h4>PROCEDURES</h4><ul>${rows}</ul></div>`
    }
    case "dymo":
      return `<div class="ctl ctl-dymo">${CONTROLS.filter((c) => c.id !== "search")
        .map((c) => `<span class="tape${gone(c, v) ? " gone" : ""}"><b>${esc(c.id === "move" ? "WASD" : c.keys[0]!)}</b>${esc(c.word.toUpperCase())}</span>`)
        .join("")}</div>`
    case "clusters":
      return `<div class="ctl ctl-cl ctl-cl-move">${CONTROLS.filter((c) => c.group === "move").map((c) => item(c, v)).join("")}</div>
        <div class="ctl ctl-cl ctl-cl-act">${CONTROLS.filter((c) => c.group === "act").map((c) => item(c, v)).join("")}</div>`
    case "glyphs":
      return `<div class="ctl ctl-glyphs">${CONTROLS.map((c) => `<span class="g${gone(c, v) ? " gone" : ""}" title="${esc(c.word)}">${icon(c.id)}${cap(c.id === "move" ? "WASD" : c.keys[0]!, v.style, c.hold)}</span>`).join("")}</div>`
    case "essential":
      return `<div class="ctl ctl-list ctl-ess">${CONTROLS.filter((c) => ESSENTIAL.includes(c.id)).map((c) => item(c, v)).join("")}<span class="item more">${cap("H", v.style)}<span class="w">all controls</span></span></div>${
        v.recalled ? `<div class="ctl ctl-recall">${sheet(v, "Controls", "H or Tab to close")}</div>` : ""
      }`
    case "context": {
      const c = CONTROLS.find((x) => x.id === v.context)
      return c && !v.used.has(c.id) ? `<div class="ctl ctl-context">${keys(c, v.style)}<span class="w">${esc(c.context ?? c.word)}</span></div>` : ""
    }
    case "pause":
      return v.recalled
        ? `<div class="ctl ctl-pause"><div class="pause-head">PAUSED</div><div class="pause-menu"><b>Resume</b><span>Controls</span><span>Settings</span><span>Quit to title</span></div>${sheet(v, "Controls", "Esc to resume")}</div>`
        : ""
    default:
      return ""
  }
}
