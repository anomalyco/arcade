import type { SecretRun } from "../../shared/secrets/select"

/**
 * What a secret looks like held up close (the glance): SVG drawings, no words. Numbers are drawn where a real
 * calendar or clock has them. Every drawing is 200 × 250.
 */
export type GlanceKind = "calendar" | "clock" | "photo" | "page" | "map" | "phone"

const W = 200
const H = 250
const svg = (body: string, bg: string) =>
  `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="${W}" height="${H}" fill="${bg}"/>${body}</svg>`

/** A hand-drawn wobble: deterministic jitter so strokes are not ruler-straight. */
function wob(seed: number, i: number): number {
  const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453
  return (x - Math.floor(x) - 0.5) * 1.6
}

/** Days crossed off after the circled one, before people stopped: two or three. */
export const crossedAfter = (run: Pick<SecretRun, "seed" | "houseSeed">) => 2 + ((run.seed ^ run.houseSeed) & 1)

/** The kitchen calendar: a lake under a hill (the reservoir, if you know), the month, the day circled in red. */
export function calendarSvg(run: SecretRun): string {
  let s = ""
  s += `<rect x="0" y="0" width="${W}" height="12" fill="#7a1d18"/>`
  for (let i = 0; i < 9; i++) s += `<circle cx="${18 + i * 20}" cy="6" r="2.2" fill="#d8cfb6"/>`
  // The month's picture: hills, a lake, a small pump house with a chimney on the far shore.
  s += `<rect x="12" y="20" width="176" height="82" fill="#8fa08a"/>`
  s += `<path d="M12 70 Q50 40 90 62 T188 52 V102 H12Z" fill="#5d6a52"/>`
  s += `<path d="M12 84 Q90 74 188 86 V102 H12Z" fill="#6f8a99"/>`
  s += `<rect x="128" y="64" width="12" height="9" fill="#3f3a33"/><rect x="136" y="56" width="2.5" height="9" fill="#3f3a33"/>`
  const x0 = 16
  const y0 = 118
  const cw = 24
  const ch = 24
  for (let c = 0; c <= 7; c++) s += `<line x1="${x0 + c * cw}" y1="${y0}" x2="${x0 + c * cw}" y2="${y0 + 5 * ch}" stroke="#9b927c" stroke-width="0.8"/>`
  for (let r = 0; r <= 5; r++) s += `<line x1="${x0}" y1="${y0 + r * ch}" x2="${x0 + 7 * cw}" y2="${y0 + r * ch}" stroke="#9b927c" stroke-width="0.8"/>`
  const last = run.day + crossedAfter(run)
  for (let d = 1; d <= 30; d++) {
    const i = run.firstWeekday + d - 1
    if (i >= 35) break
    const cx = x0 + (i % 7) * cw
    const cy = y0 + Math.floor(i / 7) * ch
    s += `<text x="${cx + 3}" y="${cy + 9}" font-family="Georgia, serif" font-size="8" fill="#3a3833">${d}</text>`
    if (d <= last && d !== run.day) {
      const k = d * 3.1
      s += `<path d="M${cx + 5 + wob(k, 1)} ${cy + 6 + wob(k, 2)} L${cx + cw - 4 + wob(k, 3)} ${cy + ch - 4 + wob(k, 4)} M${cx + cw - 5 + wob(k, 5)} ${cy + 6 + wob(k, 6)} L${cx + 5 + wob(k, 7)} ${cy + ch - 4 + wob(k, 8)}" stroke="#2d2b28" stroke-width="1.3" fill="none" stroke-linecap="round"/>`
    }
    if (d === run.day) {
      s += `<path d="M${cx + 2} ${cy + 13} C${cx - 2} ${cy + 1}, ${cx + cw + 3} ${cy - 1}, ${cx + cw - 1} ${cy + 13} C${cx + cw + 1} ${cy + ch + 2}, ${cx - 3} ${cy + ch + 3}, ${cx + 4} ${cy + 7}" stroke="#b3241c" stroke-width="2.4" fill="none" stroke-linecap="round"/>`
    }
  }
  return svg(s, "#e8dfc8")
}

/** The stopped clock, close: the hour and the minute every clock in town shows. */
export function clockSvg(run: SecretRun): string {
  const cx = W / 2
  const cy = H / 2
  let s = `<circle cx="${cx}" cy="${cy}" r="88" fill="#3b2a1c"/><circle cx="${cx}" cy="${cy}" r="80" fill="#ddd6c1"/>`
  for (let i = 1; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2
    s += `<text x="${cx + Math.sin(a) * 64}" y="${cy - Math.cos(a) * 64 + 5}" text-anchor="middle" font-family="Georgia, serif" font-size="15" fill="#2a2724">${i}</text>`
  }
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2
    const r0 = i % 5 ? 76 : 73
    s += `<line x1="${cx + Math.sin(a) * r0}" y1="${cy - Math.cos(a) * r0}" x2="${cx + Math.sin(a) * 79}" y2="${cy - Math.cos(a) * 79}" stroke="#2a2724" stroke-width="${i % 5 ? 0.7 : 1.4}"/>`
  }
  const ha = ((run.hour % 12) + run.minute / 60) / 12 * Math.PI * 2
  const ma = (run.minute / 60) * Math.PI * 2
  s += `<line x1="${cx}" y1="${cy}" x2="${cx + Math.sin(ha) * 42}" y2="${cy - Math.cos(ha) * 42}" stroke="#151412" stroke-width="5" stroke-linecap="round"/>`
  s += `<line x1="${cx}" y1="${cy}" x2="${cx + Math.sin(ma) * 62}" y2="${cy - Math.cos(ma) * 62}" stroke="#151412" stroke-width="3" stroke-linecap="round"/>`
  // The second hand, stuck a tick short of where it keeps trying to go.
  const sa = ((run.minute * 7 + 13) % 60) / 60 * Math.PI * 2
  s += `<line x1="${cx - Math.sin(sa) * 14}" y1="${cy + Math.cos(sa) * 14}" x2="${cx + Math.sin(sa) * 70}" y2="${cy - Math.cos(sa) * 70}" stroke="#a2261d" stroke-width="1.2"/>`
  s += `<circle cx="${cx}" cy="${cy}" r="4" fill="#151412"/>`
  // A crack across the glass.
  s += `<path d="M${cx + 30} ${cy - 76} L${cx + 18} ${cy - 40} L${cx + 26} ${cy - 22}" stroke="#ffffff70" stroke-width="1" fill="none"/>`
  return svg(s, "#1b1612")
}

/** A family photo; the `scratched` one (1-based, 0 none) has had their face scored out. */
export function photoSvg(faces: number, scratched: number, seed: number): string {
  let s = `<rect x="14" y="30" width="172" height="190" fill="#3d2a1b"/><rect x="24" y="40" width="152" height="170" fill="#b59c74"/>`
  s += `<rect x="24" y="150" width="152" height="60" fill="#8f7b5c"/>`
  const span = 130
  for (let i = 0; i < faces; i++) {
    const x = 35 + (span * (i + 0.5)) / faces
    const tall = i < 2 ? 1 : 0.72
    const head = 168 - 92 * tall
    s += `<path d="M${x - 15} 206 L${x - 13} ${head + 22} Q${x} ${head + 14} ${x + 13} ${head + 22} L${x + 15} 206Z" fill="#4e3a2a"/>`
    s += `<circle cx="${x}" cy="${head}" r="${11 * (0.8 + 0.2 * tall)}" fill="#d8bf98"/>`
    if (i + 1 !== scratched) {
      s += `<circle cx="${x - 3.5}" cy="${head - 1}" r="1.1" fill="#3a2b20"/><circle cx="${x + 3.5}" cy="${head - 1}" r="1.1" fill="#3a2b20"/>`
      s += `<path d="M${x - 3} ${head + 4} Q${x} ${head + 6.5} ${x + 3} ${head + 4}" stroke="#3a2b20" stroke-width="1" fill="none"/>`
    } else {
      let d = ""
      for (let k = 0; k < 16; k++) {
        const y = head - 11 + k * 1.5 + wob(seed + k, 1)
        d += `M${x - 13 + wob(seed + k, 2) * 2} ${y} L${x + 13 + wob(seed + k, 3) * 2} ${y + 3 + wob(seed + k, 4) * 3} `
      }
      s += `<path d="${d}" stroke="#f5f1e8" stroke-width="1.6" fill="none" stroke-linecap="round"/>`
    }
  }
  return svg(s, "#e6e3d8")
}

/** The radio man's notebook page: the lock's three dials, with a clock over the first, a calendar over the second and a radio over the third. */
export function pageSvg(): string {
  let s = ""
  for (let y = 34; y < H; y += 16) s += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#b9c7cf" stroke-width="0.7"/>`
  s += `<line x1="26" y1="0" x2="26" y2="${H}" stroke="#d29a92" stroke-width="0.8"/>`
  const pencil = `stroke="#47453f" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`
  // The padlock: shackle and body with three dial windows.
  s += `<path d="M72 168 V140 Q72 116 100 116 Q128 116 128 140 V168" ${pencil}/>`
  s += `<rect x="52" y="166" width="96" height="62" rx="5" ${pencil}/>`
  const xs = [70, 100, 130]
  for (const x of xs) s += `<rect x="${x - 10}" y="184" width="20" height="26" ${pencil}/>`
  // What goes in each dial, drawn above it with an arrow down.
  const c0 = xs[0]!
  s += `<circle cx="${c0}" cy="62" r="15" ${pencil}/><path d="M${c0} 62 V52 M${c0} 62 L${c0 + 7} 66" ${pencil}/>`
  const c1 = xs[1]!
  s += `<rect x="${c1 - 14}" y="46" width="28" height="30" ${pencil}/><path d="M${c1 - 14} 54 H${c1 + 14} M${c1 - 5} 54 V76 M${c1 + 5} 54 V76 M${c1 - 14} 65 H${c1 + 14}" stroke="#47453f" stroke-width="0.9" fill="none"/>`
  s += `<circle cx="${c1 - 0.5}" cy="70" r="5.5" stroke="#b3241c" stroke-width="1.8" fill="none"/>`
  const c2 = xs[2]!
  s += `<rect x="${c2 - 15}" y="52" width="30" height="22" rx="3" ${pencil}/><path d="M${c2 + 8} 52 L${c2 + 16} 34 M${c2 - 9} 59 h6 M${c2 - 9} 64 h6 M${c2 - 9} 69 h6" ${pencil}/><circle cx="${c2 + 7}" cy="63" r="4.5" ${pencil}/>`
  for (const x of xs) s += `<path d="M${x} 86 V104 M${x - 5} 98 L${x} 105 L${x + 5} 98" ${pencil}/>`
  return svg(s, "#ece6d2")
}

/**
 * His map: the town in pencil, the pumping station circled to the north with pipes running from it to houses, the
 * houses that went first marked in red, and beside the station, drawn small, the tall man.
 */
export function mapSvg(seed: number): string {
  const pencil = `stroke="#4a4740" fill="none" stroke-linecap="round"`
  let s = ""
  // Roads: a grid.
  for (const x of [60, 140]) s += `<path d="M${x + wob(seed, x)} 70 L${x + wob(seed, x + 1)} 240" ${pencil} stroke-width="5" opacity="0.35"/>`
  for (const y of [120, 196]) s += `<path d="M10 ${y + wob(seed, y)} L190 ${y + wob(seed, y + 1)}" ${pencil} stroke-width="5" opacity="0.35"/>`
  // Houses.
  const houses: [number, number][] = [[28, 96], [92, 94], [168, 98], [24, 150], [96, 148], [166, 156], [30, 220], [100, 222], [170, 218]]
  const red = new Set([(seed >>> 1) % 9, (seed >>> 4) % 9, (seed >>> 7) % 9])
  houses.forEach(([x, y], i) => {
    s += `<rect x="${x - 9}" y="${y - 7}" width="18" height="14" ${pencil} stroke-width="1.3"/>`
    if (red.has(i)) s += `<path d="M${x - 6} ${y - 4} L${x + 6} ${y + 4} M${x + 6} ${y - 4} L${x - 6} ${y + 4}" stroke="#b3241c" stroke-width="2.2" stroke-linecap="round"/>`
  })
  // Trees to the north, the station among them, circled hard.
  for (let i = 0; i < 14; i++) s += `<circle cx="${12 + i * 13 + wob(seed, i) * 3}" cy="${26 + (i % 3) * 9}" r="5" ${pencil} stroke-width="1"/>`
  s += `<rect x="92" y="30" width="18" height="12" fill="#4a4740"/><rect x="104" y="20" width="3" height="12" fill="#4a4740"/>`
  s += `<ellipse cx="101" cy="34" rx="24" ry="17" stroke="#b3241c" stroke-width="2.4" fill="none"/><ellipse cx="102" cy="35" rx="27" ry="19" stroke="#b3241c" stroke-width="1.2" fill="none"/>`
  // Pipes from the station to the red houses, dashed.
  houses.forEach(([x, y], i) => {
    if (red.has(i)) s += `<path d="M101 50 Q${(101 + x) / 2 + 14} ${(50 + y) / 2} ${x} ${y - 8}" stroke="#4a4740" stroke-width="1.1" stroke-dasharray="4 3" fill="none"/>`
  })
  // Him, small, beside the station: taller than it.
  s += `<path d="M140 50 V22 M140 22 v-5 M137 30 L134 44 M143 30 L146 44 M140 50 L137 62 M140 50 L143 62" stroke="#1d1c1a" stroke-width="1.5" fill="none" stroke-linecap="round"/><circle cx="140" cy="14" r="3" fill="#1d1c1a"/>`
  return svg(s, "#ddd5bd")
}

/** The phone's handset in your hand: the cord hangs, cut. */
export function phoneSvg(): string {
  let s = `<path d="M60 40 Q40 50 44 82 L58 96 Q66 88 72 80 L66 66 Q76 56 92 52 L108 60 Q116 52 120 44 L106 30 Q80 24 60 40Z" fill="#5e594d"/>`
  let d = "M84 70"
  for (let i = 0; i < 6; i++) d += ` q14 6 0 12 q-14 6 0 12`
  s += `<path d="${d}" stroke="#1f1d1b" stroke-width="5" fill="none"/>`
  s += `<path d="M84 214 L87 224" stroke="#8a6a40" stroke-width="2"/><path d="M84 214 L80 223" stroke="#b08850" stroke-width="2"/><path d="M84 214 L84 225" stroke="#c9a060" stroke-width="1.4"/>`
  return svg(s, "#141210")
}

export function glanceSvg(kind: GlanceKind, run: SecretRun, variant = 0, seed = 0): string {
  switch (kind) {
    case "calendar":
      return calendarSvg(run)
    case "clock":
      return clockSvg(run)
    case "photo":
      return photoSvg(variant & 15, variant >> 4, seed)
    case "page":
      return pageSvg()
    case "map":
      return mapSvg((run.seed ^ (run.houseSeed * 31)) >>> 0)
    case "phone":
      return phoneSvg()
  }
}
