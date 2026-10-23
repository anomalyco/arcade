import type { Clue, ClueKind, NightLayout } from "../../shared/night"
import type { MapKnowledge, WoodsState } from "../../shared/sim"
import type { WoodsWorld } from "../../shared/world"
import type { Rect } from "./mips"
import { rng, SHEET, worldToSheet } from "./sheet"

/**
 * The pencil layer: what this player's map knows, drawn as graphite on a persistent canvas, appended to as it grows.
 * Your own path is a soft HB line with a slight wobble; paths copied from friends are in blue pencil in a looser,
 * dashed hand; tapes are fluorescent pink crayon crosses (the flagging tape's colour); found markers a circled
 * triangle with the number; the night's clues in red pencil with their bearings ruled out; a hand-lettered note in the
 * top margin. The alpha is graphite coverage (the shader adds the
 * paper's tooth and a dull metallic sheen). It never marks where you are.
 */

type Pt = [number, number]
type Style = { color: string; width: number; alpha: number; wobble: number; seed: number; dash?: number[] }
/** How far a trail has been drawn: points done, length so far (mm), the last wobbled point. */
type Drawn = { count: number; along: number; last: Pt | null; serial?: number }

const HAND = "Noteworthy, 'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive"
const OWN: Omit<Style, "seed"> = { color: "40,40,46", width: 0.75, alpha: 0.95, wobble: 0.28 }
const HEARD: Omit<Style, "seed"> = { color: "38,70,150", width: 0.6, alpha: 0.85, wobble: 0.45, dash: [2.4, 1.3] }
const TAPE = "230,40,135"
/** Clues and their bearings go on in red pencil, so they stand off the graphite. */
const CLUE_RED = "176,34,30"
const CLUE_WORDS: Record<ClueKind, string> = { car: "her car (unlocked!)", page: "diary page", badge: "ID badge (creek)", cassette: "tape recorder", strip: "one strip (Walt's knot?)" }

const hash = (a: number, b: number) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s) }

export class PencilLayer {
  readonly canvas = document.createElement("canvas")
  private g: CanvasRenderingContext2D
  private k = 1
  private world: WoodsWorld | null = null
  private own: Drawn = { count: 0, along: 0, last: null }
  private heard = new Map<number, Drawn>()
  private tapes = new Set<number>()
  private markers = new Set<number>()
  private clues = new Set<number>()
  /** The night the clue marks belong to (a new night clears the sheet). */
  private seed = NaN
  private dirty: [number, number, number, number] | null = null

  constructor(longSide: number) {
    this.k = longSide / SHEET.h
    this.canvas.width = Math.round(SHEET.w * this.k)
    this.canvas.height = longSide
    this.g = this.canvas.getContext("2d")!
  }

  /** Draws what this map learned since the last call. Returns the changed area in canvas pixels, or null. */
  update(world: WoodsWorld, m: MapKnowledge, state: WoodsState): Rect | null {
    const shrank = m.trail.length / 2 < this.own.count || m.heard.some((h) => { const d = this.heard.get(h.from); return !!d && (h.trail.length / 2 < d.count || d.serial !== h.serial) }) || [...this.heard.keys()].some((k) => !m.heard.some((h) => h.from === k)) || [...this.tapes].some((t) => !m.tapes.includes(t)) || [...this.markers].some((t) => !m.markers.includes(t)) || [...this.clues].some((t) => !m.clues.includes(t)) || state.night.seed !== this.seed
    if (world !== this.world || shrank) { this.reset(world); this.seed = state.night.seed }
    this.dirty = null
    const g = this.g
    g.setTransform(this.k, 0, 0, this.k, 0, 0)
    g.lineJoin = g.lineCap = "round"
    for (const h of m.heard) {
      let d = this.heard.get(h.from)
      if (!d) this.heard.set(h.from, (d = { count: 0, along: 0, last: null, serial: h.serial }))
      this.append(world, h.trail, d, { ...HEARD, seed: 17 + h.from * 31 })
    }
    this.append(world, m.trail, this.own, { ...OWN, seed: 5 })
    for (const id of m.tapes) {
      if (this.tapes.has(id)) continue
      const t = state.tapes.find((k) => k.id === id)
      if (!t) continue
      this.tapes.add(id)
      const [x, y] = worldToSheet(world, t.x, t.z)
      const r = rng(id * 13 + 7)
      for (const s of [1, -1]) this.line([[x - 1.4 + r() * 0.3, y - 1.4 * s + r() * 0.3], [x + 1.4 + r() * 0.3, y + 1.4 * s + r() * 0.3]], { color: TAPE, width: 0.62, alpha: 0.92, wobble: 0.1, seed: id + (s > 0 ? 1 : 2) })
    }
    for (const id of m.markers) {
      if (this.markers.has(id)) continue
      const k = world.markers.find((x) => x.id === id)
      if (!k) continue
      this.markers.add(id)
      const [x, y] = worldToSheet(world, k.x, k.z)
      this.line([[x, y - 1.8], [x + 1.6, y + 1.1], [x - 1.6, y + 1.1], [x + 0.1, y - 1.7]], { color: "45,45,52", width: 0.42, alpha: 0.9, wobble: 0.08, seed: id * 3 })
      const ring: Pt[] = []
      for (let i = 0; i <= 26; i++) { const a = (i / 24) * Math.PI * 2 - 0.4; ring.push([x + Math.cos(a) * (3.2 + i * 0.012), y + Math.sin(a) * (3 + i * 0.01)]) }
      this.line(ring, { color: "45,45,52", width: 0.4, alpha: 0.85, wobble: 0.12, seed: id * 7 })
      g.fillStyle = "rgba(45,45,52,0.88)"
      g.font = `4px ${HAND}`
      g.textBaseline = "middle"; g.textAlign = "left"
      g.save(); g.translate(x + 4.2, y + 0.4); g.rotate(-0.08); g.fillText(`#${id}`, 0, 0); g.restore()
      this.grow(x - 4, y - 4, x + 14, y + 4)
    }
    for (const id of m.clues) {
      if (this.clues.has(id)) continue
      const c = state.night.layout.clues.find((k) => k.id === id)
      if (!c) continue
      this.clues.add(id)
      this.clue(world, c, state.night.layout)
    }
    const d = this.dirty
    if (!d) return null
    const x0 = Math.max(0, Math.floor(d[0] * this.k)), y0 = Math.max(0, Math.floor(d[1] * this.k))
    const x1 = Math.min(this.canvas.width, Math.ceil(d[2] * this.k)), y1 = Math.min(this.canvas.height, Math.ceil(d[3] * this.k))
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
  }

  private reset(world: WoodsWorld) {
    this.world = world
    this.own = { count: 0, along: 0, last: null }
    this.heard.clear(); this.tapes.clear(); this.markers.clear(); this.clues.clear()
    const g = this.g
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, this.canvas.width, this.canvas.height)
    // A note in the top margin, in the owner's hand.
    g.setTransform(this.k, 0, 0, this.k, 0, 0)
    g.fillStyle = "rgba(48,48,56,0.85)"
    g.font = `4.2px ${HAND}`; g.textAlign = "left"; g.textBaseline = "alphabetic"
    g.save(); g.translate(SHEET.map.x + 118, 19.5); g.rotate(-0.025); g.fillText("Cabin 3 — night course, stay on the ridge", 0, 0); g.restore()
    this.dirty = [0, 0, SHEET.w, SHEET.h]
  }

  /** A clue in red pencil: a ringed cross, its name, and the bearing it gives drawn out as a dashed ruled line. */
  private clue(world: WoodsWorld, c: Clue, layout: NightLayout) {
    const g = this.g
    const [x, y] = worldToSheet(world, c.x, c.z)
    const style = { color: CLUE_RED, width: 0.5, alpha: 0.92, wobble: 0.08 }
    for (const s of [1, -1]) this.line([[x - 1.5, y - 1.5 * s], [x + 1.5, y + 1.5 * s]], { ...style, seed: c.id * 5 + s })
    const ring: Pt[] = []
    for (let i = 0; i <= 26; i++) { const a = (i / 24) * Math.PI * 2 + 0.6; ring.push([x + Math.cos(a) * (2.8 + i * 0.015), y + Math.sin(a) * 2.6]) }
    this.line(ring, { ...style, width: 0.38, seed: c.id * 11 })
    g.fillStyle = `rgba(${CLUE_RED},0.9)`
    g.font = `3.6px ${HAND}`
    g.textBaseline = "middle"; g.textAlign = "left"
    g.save(); g.translate(x + 3.8, y - 2.6); g.rotate(-0.06); g.fillText(CLUE_WORDS[c.kind], 0, 0); g.restore()
    this.grow(x - 4, y - 6, x + 26, y + 4)
    const mm = SHEET.map.size / (world.params.half * 2)
    for (const l of c.leads) {
      const place = l.ridge ? layout.ridge : null
      // A bearing ruled out past where the next clue should be; the tape's lead goes all the way to the place.
      const len = place ? Math.hypot(place.x - l.x, place.z - l.z) - 6 : c.kind === "car" ? 125 : 150
      const a: Pt = [x + l.dx * 4, y + l.dz * 4], b: Pt = [x + l.dx * len * mm, y + l.dz * len * mm]
      g.setLineDash([1.8, 1.2])
      g.strokeStyle = `rgba(${CLUE_RED},0.7)`
      g.lineWidth = 0.32
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke()
      g.setLineDash([])
      // An arrowhead at the far end.
      const px = -l.dz, pz = l.dx
      this.line([[b[0] - l.dx * 2.2 + px * 1.2, b[1] - l.dz * 2.2 + pz * 1.2], b, [b[0] - l.dx * 2.2 - px * 1.2, b[1] - l.dz * 2.2 - pz * 1.2]], { ...style, width: 0.4, seed: c.id * 17 + l.to })
      if (place) {
        // Her words, under the place's printed name.
        const [qx, qy] = worldToSheet(world, place.x, place.z)
        this.line([[qx - 9, qy + 3.2], [qx + 9, qy + 3.4]], { ...style, width: 0.4, seed: 91 })
        g.save(); g.translate(qx - 8, qy + 6.4); g.rotate(-0.04); g.fillText("she was going up here (red light)", 0, 0); g.restore()
        this.grow(qx - 12, qy, qx + 50, qy + 9)
      }
      this.grow(Math.min(a[0], b[0]) - 3, Math.min(a[1], b[1]) - 3, Math.max(a[0], b[0]) + 3, Math.max(a[1], b[1]) + 3)
    }
  }

  private grow(x0: number, y0: number, x1: number, y1: number) {
    const d = this.dirty
    this.dirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1]
  }

  /** Appends a trail's new points: wobble from the arc length (stable as it grows), pressure from the point index. */
  private append(world: WoodsWorld, trail: readonly number[], d: Drawn, o: Style) {
    const n = trail.length >> 1
    if (n <= d.count) return
    const r = rng(o.seed)
    const ph = [r() * 10, r() * 10, r() * 10]
    const wob = (s: number) => o.wobble * (0.6 * Math.sin(s * 0.21 + ph[0]!) + 0.3 * Math.sin(s * 0.57 + ph[1]!) + 0.1 * Math.sin(s * 1.9 + ph[2]!))
    const at = (i: number) => worldToSheet(world, trail[i * 2]!, trail[i * 2 + 1]!)
    const g = this.g
    g.setLineDash(o.dash ?? [])
    for (let i = d.count; i < n; i++) {
      const p = at(i), prev = i ? at(i - 1) : at(Math.min(1, n - 1))
      const dx = i ? p[0] - prev[0] : prev[0] - p[0], dy = i ? p[1] - prev[1] : prev[1] - p[1], l = Math.hypot(dx, dy) || 1
      if (i) d.along += Math.hypot(p[0] - prev[0], p[1] - prev[1])
      const w = wob(d.along)
      const b: Pt = [p[0] - (dy / l) * w, p[1] + (dx / l) * w]
      const a = d.last
      d.last = b
      if (!a) continue
      const pressure = 0.7 + 0.3 * Math.sin(d.along * 0.13 + ph[1]!) + (hash(o.seed, i) - 0.5) * 0.15
      for (const pass of [0, 1]) {
        g.strokeStyle = `rgba(${o.color},${(o.alpha * pressure * (pass ? 0.45 : 1)).toFixed(3)})`
        g.lineWidth = o.width * (pass ? 0.6 : 1) * (0.85 + 0.3 * pressure)
        const off = pass ? 0.12 : 0
        g.lineDashOffset = d.along
        g.beginPath(); g.moveTo(a[0] + off, a[1] - off); g.lineTo(b[0] + off, b[1] - off); g.stroke()
      }
      const m = o.width + 0.4
      this.grow(Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m)
    }
    d.count = n
    g.setLineDash([])
  }

  /** A short hand-drawn mark drawn whole (crosses, rings). */
  private line(pts: Pt[], o: Style) {
    const d: Drawn = { count: 0, along: 0, last: null }
    const g = this.g
    g.setLineDash([])
    const r = rng(o.seed)
    const ph = [r() * 10, r() * 10]
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!, prev = pts[Math.max(0, i - 1)]!
      if (i) d.along += Math.hypot(p[0] - prev[0], p[1] - prev[1])
      const nx = pts[Math.min(pts.length - 1, i + 1)]!, q = pts[Math.max(0, i - 1)]!
      const dx = nx[0] - q[0], dy = nx[1] - q[1], l = Math.hypot(dx, dy) || 1
      const w = o.wobble * Math.sin(d.along * 0.4 + ph[0]!)
      const b: Pt = [p[0] - (dy / l) * w, p[1] + (dx / l) * w]
      const a = d.last
      d.last = b
      if (!a) continue
      const pressure = 0.75 + 0.25 * Math.sin(d.along * 0.3 + ph[1]!)
      g.strokeStyle = `rgba(${o.color},${(o.alpha * pressure).toFixed(3)})`
      g.lineWidth = o.width * (0.85 + 0.3 * pressure)
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke()
      const m = o.width + 0.4
      this.grow(Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m)
    }
  }
}
