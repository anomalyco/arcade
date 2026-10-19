/**
 * Action glyphs for world prompts: filled silhouettes on a 24-unit grid, drawn in `currentColor` so a HUD's palette,
 * hold colour and idle dimming apply to them like text. Pair one with a key cap instead of a verb.
 *
 *   actionGlyphHtml("door-open")                          // 24 px, aria-hidden (the row carries the label)
 *   actionGlyphHtml("lock", { size: 16, label: "Lock" })  // 16 px, role="img" with a title
 *
 * Main edges sit on whole grid units, so a glyph is pixel-exact at 24 px (DPR 1 and 2) and 16 px at DPR 1.5. Smaller
 * sizes get optical weight: fills are outlined by up to 0.9 units so thin parts keep at least a device pixel. A
 * glyph listed in `SLASHED` is its base glyph with a diagonal bar cut through it ("no battery", "no keys").
 */

export type ActionGlyph =
  | "door-open"
  | "door-close"
  | "lock"
  | "unlock"
  | "key"
  | "crowbar"
  | "peek"
  | "peek-stop"
  | "window-open"
  | "window-close"
  | "climb"
  | "vault"
  | "search"
  | "smash"
  | "take"
  | "take-all"
  | "install"
  | "tinker"
  | "read"
  | "hide"
  | "leave"
  | "disarm"
  | "string"
  | "store"
  | "deposit"
  | "drive"
  | "ride"
  | "battery"
  | "refuel"
  | "no-battery"
  | "no-keys"
  | "empty-tank"
  | "finish"
  | "radio-on"
  | "radio-off"
  | "light-on"
  | "light-off"
  | "feed"
  | "revive"

/** A fill (default) or, with `w`, a round-capped stroke of that width in grid units. */
type Shape = { d: string; w?: number; evenodd?: boolean }

const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}h${w}v${h}h${-w}Z`
const rrect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`
const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`
const round = (n: number) => Math.round(n * 100) / 100
const poly = (points: readonly (readonly [number, number])[]) => `M${points.map(([x, y]) => `${round(x)} ${round(y)}`).join("L")}Z`

/** A burst: points alternate between the outer radii given and `inner`. */
function burst(cx: number, cy: number, outer: readonly number[], inner: number): string {
  const n = outer.length
  const pts: [number, number][] = []
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n
    const r = i % 2 ? inner : outer[i / 2]!
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return poly(pts)
}

/** A gear with `teeth` square-ish teeth and a round hole. */
function gear(cx: number, cy: number, teeth: number, outer: number, root: number, hole: number): string {
  const pts: [number, number][] = []
  const step = (Math.PI * 2) / teeth
  for (let i = 0; i < teeth; i++) {
    const a = -Math.PI / 2 + i * step
    for (const [da, r] of [[-0.3, root], [-0.2, outer], [0.2, outer], [0.3, root]] as const) {
      pts.push([cx + r * Math.cos(a + da * step * 1.6), cy + r * Math.sin(a + da * step * 1.6)])
    }
  }
  return poly(pts) + circle(cx, cy, hole)
}

const doorFrame: Shape = { d: "M8 2H20V22H18V4H8Z" }
const lockBody: Shape = { d: rrect(4.5, 10.5, 15, 11.5, 2) + "M10.53 16.4A1.9 1.9 0 1 1 13.47 16.4L14 19.2H10Z", evenodd: true }
const ring: Shape = { d: circle(12, 12, 10.5) + circle(12, 12, 8.5), evenodd: true }
const windowFrame: Shape = { d: rect(3, 3, 18, 18) + rect(5, 5, 14, 14), evenodd: true }
const hand = (dy = 0): Shape[] => [
  { d: `M22 ${5.5 + dy}H15C13.3 ${5.5 + dy} 12 ${6.8 + dy} 12 ${8.5 + dy}V${12 + dy}C12 ${13.7 + dy} 13.3 ${15 + dy} 15 ${15 + dy}H22Z` + rect(18.5, 5.5 + dy, 1.2, 9.5), evenodd: true },
  { d: `M13 ${7.3 + dy}H7.5C5.8 ${7.3 + dy} 4.6 ${8.5 + dy} 4.6 ${10.3 + dy}`, w: 3 },
  { d: `M13 ${13.6 + dy}C11.5 ${15.6 + dy} 10 ${16.6 + dy} 8.6 ${16.4 + dy}`, w: 3 },
]
const box: Shape = { d: rect(3, 12, 18, 10) + rect(9, 15, 6, 2), evenodd: true }
const wardrobe = (x: number, w: number): Shape[] => [{ d: rect(x, 2, w, 18) }, { d: rect(x + 1, 20, 2.5, 2.5) + rect(x + w - 3.5, 20, 2.5, 2.5) }]

const radio: Shape[] = [{ d: "M5 9L11 3.5", w: 1.6 }, { d: rrect(2, 9, 15, 12, 1.5) + circle(7, 15, 3) + rect(11.5, 12, 3.5, 2), evenodd: true }, { d: circle(7, 15, 1.2) }]

/** A bulb: glass globe over a ribbed screw base. */
const bulb: Shape[] = [{ d: "M12 3.5A6 6 0 0 1 15.5 14.4V16.5H8.5V14.4A6 6 0 0 1 12 3.5Z" }, { d: rect(8.75, 17.5, 6.5, 1.5) + rect(9.25, 20, 5.5, 1.5) }]

const GLYPHS: Record<Exclude<ActionGlyph, "no-battery" | "no-keys" | "empty-tank" | "radio-off" | "light-off">, Shape[]> = {
  "door-open": [doorFrame, { d: "M3 4.5L9.5 2.5V21.5L3 19.5Z" + circle(5.6, 12, 1.2), evenodd: true }],
  "door-close": [{ d: rect(5, 2, 14, 20) + rect(8, 5, 8, 5) + rect(8, 13, 8, 6), evenodd: true }],
  lock: [{ d: "M7 11V8A5 5 0 0 1 17 8V11H14.5V8A2.5 2.5 0 0 0 9.5 8V11Z" }, lockBody],
  unlock: [{ d: "M7 11V6A5 5 0 0 1 17 6V7.5H14.5V6A2.5 2.5 0 0 0 9.5 6V11Z" }, lockBody],
  key: [
    { d: circle(7, 12, 5) + circle(7, 12, 2), evenodd: true },
    { d: rect(11.5, 10.5, 10.5, 3) + rect(16.5, 13.5, 2.5, 3.5) + rect(19.5, 13.5, 2.5, 2.5) },
  ],
  crowbar: [{ d: "M4.5 20.5L15.5 6.8C17 4.8 19.6 4.9 20.4 7.2", w: 3 }, { d: "M4.5 20.5L3 18", w: 3 }],
  peek: [ring, { d: "M5 12Q12 5.5 19 12Q12 18.5 5 12Z" + circle(12, 12, 2.4), evenodd: true }, { d: circle(12, 12, 1.1) }],
  "peek-stop": [ring, { d: "M6 11Q12 16.5 18 11", w: 2.2 }, { d: "M8.3 14.2L7.3 16.3M12 15.3V17.6M15.7 14.2L16.7 16.3", w: 1.8 }],
  "window-open": [
    windowFrame,
    { d: rect(5, 5, 14, 6.5) + rect(7, 6.5, 4, 3.5) + rect(13, 6.5, 4, 3.5), evenodd: true },
    { d: "M12 13L16.5 17.5H14V19H10V17.5H7.5Z" },
  ],
  "window-close": [{ d: rect(3, 3, 18, 18) + rect(5, 5, 6, 6) + rect(13, 5, 6, 6) + rect(5, 13, 6, 6) + rect(13, 13, 6, 6), evenodd: true }],
  climb: [{ d: rect(9, 3, 12, 18) + rect(11, 5, 8, 14), evenodd: true }, { d: rect(2, 10.5, 11, 3) }, { d: "M12 6.5L18 12L12 17.5Z" }],
  vault: [
    { d: rect(4, 13, 2.5, 9) + rect(10.75, 13, 2.5, 9) + rect(17.5, 13, 2.5, 9) },
    { d: rect(2.5, 15, 19, 2) + rect(2.5, 19, 19, 2) },
    { d: "M4 10.5Q11 1.5 18.4 7.8", w: 2.5 },
    { d: poly([[21.4, 10.6], [16.7, 9.9], [20.2, 5.7]]) },
  ],
  search: [
    { d: rect(4, 2, 16, 3) },
    { d: "M4.5 12L6.5 7H17.5L19.5 12H17L15.8 9.3H8.2L7 12Z" },
    { d: rect(9.5, 9.8, 5, 2.2) },
    { d: rrect(3, 12, 18, 9, 1) + rect(9, 15, 6, 2), evenodd: true },
  ],
  smash: [{ d: burst(12, 12, [10.8, 9, 10.5, 8.6, 10.8, 9.2, 10.2, 8.8], 4.4) }],
  take: [...hand(), { d: circle(5.2, 14.6, 2.1) }],
  "take-all": [...hand(-3), { d: circle(5.2, 11.6, 2.1) }, { d: rrect(2, 18, 9, 2.5, 1) + rrect(12.5, 18, 9, 2.5, 1) + rrect(7, 21, 9, 2.5, 1) }],
  install: [{ d: "M17.51 3.38A5.5 5.5 0 1 0 20.62 6.49L17.41 9.7L14.3 6.59Z" }, { d: "M4.5 19.5L12 12", w: 3.2 }],
  tinker: [{ d: gear(12, 12, 8, 10.5, 7.6, 3.2), evenodd: true }],
  read: [{ d: "M5 2H15L20 7V22H5Z" + rect(8, 9.5, 9, 2) + rect(8, 13.5, 9, 2) + rect(8, 17.5, 6, 2), evenodd: true }],
  hide: [{ d: rect(4, 2, 16, 18) + rect(11.25, 4, 1.5, 14) + circle(9.5, 11, 1) + circle(14.5, 11, 1), evenodd: true }, { d: rect(5, 20, 2.5, 2.5) + rect(16.5, 20, 2.5, 2.5) }],
  leave: [
    { d: rect(2, 3, 11, 17) + rect(4, 5, 7, 13), evenodd: true },
    { d: rect(3, 20, 2.5, 2.5) + rect(9.5, 20, 2.5, 2.5) },
    { d: rect(6, 10.5, 10, 3) + "M15 6.5L21 12L15 17.5Z" },
  ],
  disarm: [
    { d: "M2 6.5Q5.5 7.7 9 8.2M15 8.2Q18.5 7.7 22 6.5", w: 1.6 },
    { d: rrect(2.5, 9.5, 4, 5.5, 0.8) + rrect(17.5, 9.5, 4, 5.5, 0.8) },
    { d: "M10 5.5L14.5 14M14 5.5L9.5 14", w: 2.2 },
    { d: circle(9, 17.5, 2.6) + circle(9, 17.5, 1.1) + circle(15, 17.5, 2.6) + circle(15, 17.5, 1.1), evenodd: true },
  ],
  string: [{ d: "M2 7H22", w: 1.8 }, { d: rrect(3, 9, 4.5, 7, 0.8) + rrect(9.75, 9, 4.5, 7, 0.8) + rrect(16.5, 9, 4.5, 7, 0.8) }, { d: rect(4.75, 7, 1, 2) + rect(11.5, 7, 1, 2) + rect(18.25, 7, 1, 2) }],
  store: [box, { d: "M12 10.5L7 5.5H10V1.5H14V5.5H17Z" }],
  deposit: [box, { d: rrect(4, 7.5, 7, 3, 1) + rrect(13, 7.5, 7, 3, 1) + rrect(8.5, 3, 7, 3, 1) }],
  drive: [{ d: circle(12, 12, 10) + circle(12, 12, 7), evenodd: true }, { d: circle(12, 12, 2.6) + rect(5, 10.75, 4.5, 2.5) + rect(14.5, 10.75, 4.5, 2.5) + rect(10.75, 14.5, 2.5, 4.5) }],
  ride: [
    { d: "M6.2 4.5C6.2 3.1 7.1 2.2 8.5 2.2H9.5C10.8 2.2 11.6 3 11.7 4.4L12.3 13.5H18.5C20 13.5 21 14.5 21 16V18H8.5C7.1 18 6.4 17.2 6.3 15.8Z" },
    { d: rect(9, 18, 2.5, 4) + rect(16.5, 18, 2.5, 4) },
  ],
  battery: [
    { d: rrect(3, 7, 18, 14, 1.5) + "M6.5 13H8.25V11.25H10.25V13H12V15H10.25V16.75H8.25V15H6.5Z" + rect(13.5, 13, 4.5, 2), evenodd: true },
    { d: rect(5, 4.5, 3.5, 2.5) + rect(15.5, 4.5, 3.5, 2.5) },
  ],
  refuel: [
    { d: "M6 7L10.5 2.5H19C19.6 2.5 20 2.9 20 3.5V21C20 21.6 19.6 22 19 22H5C4.4 22 4 21.6 4 21V9Z" + rect(12.5, 4.5, 5, 2.5) + "M8 11L9.5 9.5L17 17L15.5 18.5Z" + "M15.5 9.5L17 11L9.5 18.5L8 17Z", evenodd: true },
    { d: "M7 5L3.5 2", w: 2.4 },
  ],
  "radio-on": [...radio, { d: "M19.4 11.5Q21.2 15 19.4 18.5", w: 1.6 }, { d: "M21.6 9.8Q24 15 21.6 20.2", w: 1.6 }],
  "light-on": [...bulb, { d: "M12 0.8V1.8M3.6 4.2L4.4 5M20.4 4.2L19.6 5M1.5 10H2.6M21.4 10H22.5", w: 1.5 }],
  feed: [{ d: circle(5, 9.5, 2.6) + circle(5, 14.5, 2.6) + circle(19, 9.5, 2.6) + circle(19, 14.5, 2.6) }, { d: rect(5, 10.25, 14, 3.5) }],
  revive: [
    {
      d:
        circle(12, 12, 10.5) +
        poly([[10, 5.5], [14, 5.5], [14, 10], [18.5, 10], [18.5, 14], [14, 14], [14, 18.5], [10, 18.5], [10, 14], [5.5, 14], [5.5, 10], [10, 10]]),
      evenodd: true,
    },
  ],
  finish: [
    { d: "M8 2H15V11.5L20.5 14C21.6 14.5 22 15.4 22 16.5V18.5H6V15C6 14 6.6 13.3 7.6 13.2L8 13.1Z" },
    { d: rrect(5.5, 19, 17, 2.5, 1) },
    { d: "M2.5 22.5L4.2 20.8M2 18.5L3.8 18.2", w: 1.5 },
  ],
}

/** Glyphs drawn as another glyph with a bar cut through it. */
export const SLASHED: Readonly<Record<"no-battery" | "no-keys" | "empty-tank" | "radio-off" | "light-off", ActionGlyph>> = {
  "no-battery": "battery",
  "no-keys": "key",
  "empty-tank": "refuel",
  "radio-off": "radio-on",
  "light-off": "light-on",
}

export const ACTION_GLYPHS: readonly ActionGlyph[] = [...(Object.keys(GLYPHS) as ActionGlyph[]), ...(Object.keys(SLASHED) as ActionGlyph[])]

export type ActionGlyphOptions = {
  /** CSS pixels; 16, 20 and 24 are tuned. Default 24. */
  size?: number
  /** Accessible name. Without one the glyph is aria-hidden and the surrounding row must carry the label. */
  label?: string
  className?: string
}

/** Optical weight for a size: smaller glyphs get a thicker outline on their fills, in grid units. */
export function glyphWeight(size: number): number {
  if (size <= 16) return 0.9
  if (size <= 20) return 0.45
  return 0
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function shapesSvg(shapes: readonly Shape[], weight: number): string {
  return shapes
    .map((s) => {
      if (s.w) return `<path d="${s.d}" fill="none" stroke="currentColor" stroke-width="${round(s.w + weight)}"/>`
      const rule = s.evenodd ? ` fill-rule="evenodd"` : ""
      const outline = weight ? ` stroke-width="${weight}"` : ` stroke="none"`
      return `<path d="${s.d}"${rule}${outline}/>`
    })
    .join("")
}

/** The bar for slashed glyphs, and the gap cut around it (drawn as a clip so the base keeps its own cutouts). */
const SLASH_BAR = "M3.2 4.6L4.6 3.2L20.8 19.4L19.4 20.8Z"
const SLASH_GAP = "M0 0H24V24H0Z M1.1 4.6L4.6 1.1L22.9 19.4L19.4 22.9Z"

/** The glyph's inner SVG markup (no outer element), for embedding in another SVG. */
export function actionGlyphBody(glyph: ActionGlyph, size = 24): string {
  const weight = glyphWeight(size)
  const base = (SLASHED as Record<string, ActionGlyph>)[glyph]
  if (!base) return shapesSvg(GLYPHS[glyph as keyof typeof GLYPHS], weight)
  const id = `agl-gap-${glyph}-${size}`
  return `<clipPath id="${id}"><path d="${SLASH_GAP}" clip-rule="evenodd"/></clipPath><g clip-path="url(#${id})">${shapesSvg(GLYPHS[base as keyof typeof GLYPHS], weight)}</g><path d="${SLASH_BAR}" stroke-width="${weight || 0}"/>`
}

/** One glyph as an inline `<svg>` sized in whole CSS pixels. */
export function actionGlyphHtml(glyph: ActionGlyph, options: ActionGlyphOptions = {}): string {
  const size = Math.round(options.size ?? 24)
  const cls = `agl${options.className ? ` ${options.className}` : ""}`
  const a11y = options.label ? ` role="img" aria-label="${esc(options.label)}"` : ` aria-hidden="true"`
  const title = options.label ? `<title>${esc(options.label)}</title>` : ""
  return `<svg class="${cls}" data-glyph="${glyph}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"${a11y}>${title}${actionGlyphBody(glyph, size)}</svg>`
}
