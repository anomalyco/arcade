import { MAX_LIGHTS, MAX_MAP_LIGHTS, MAX_OCCLUDERS } from "../../shared/config"
import type { LightDef, LightKind, MapDef, PropKind } from "../../shared/maps"

export const LIGHT_FLOATS = 16
export const OCC_FLOATS = 8

/** Heights of solid props for shadow casting; anything not listed casts none. */
const PROP_H: Partial<Record<PropKind, number>> = {
  desk: 0.76,
  cabinet: 1.1,
  sofa: 0.62,
  table: 0.75,
  vending: 1.9,
  copier: 1.0,
  printer: 0.85,
  counter: 0.9,
  fridge: 1.85,
  cooler: 1.0,
  bookshelf: 1.9,
  crate: 0.8,
  reception: 1.05,
}

/** Apparent size of each fixture, which sets how soft its shadows are. */
const SIZE: Record<LightKind, number> = { desk: 0.12, panel: 0.5, pendant: 0.3, exit: 0.35, vending: 0.6, server: 0.45, bulb: 0.2 }
/** How bright each kind looks, relative to the rule's power. */
const GAIN: Record<LightKind, number> = { desk: 0.8, panel: 1, pendant: 0.9, exit: 1.3, vending: 0.85, server: 1, bulb: 0.9 }

export type DynLight = { x: number; y: number; h: number; r: number; color: readonly [number, number, number]; power: number; size: number }
export type Caster = { x: number; y: number }
export type ViewRect = readonly [number, number, number, number]

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Whether a light hums and stutters. Purely visual; deterministic per light so everyone sees the same flicker. */
export function flickers(l: LightDef): boolean {
  return (l.kind === "panel" || l.kind === "bulb") && hash(l.id * 3.7 + 1) < 0.12
}

/** Brightness multiplier of a flickering tube at time t (seconds). */
export function flicker(id: number, t: number): number {
  const period = 3 + hash(id) * 6
  const phase = (t + hash(id + 9) * period) % period
  if (phase > 0.9) return 0.94 + 0.06 * Math.sin(t * 50 + id)
  const seg = Math.floor(t * 18)
  const r = hash(seg * 0.37 + id * 11.3)
  return r < 0.45 ? 0.05 : r < 0.6 ? 0.45 : 1
}

/**
 * Picks the lights that matter for the current view and packs them, with only the occluders each can reach, for the
 * GPU. Per-light occluder lists are static (walls and solid furniture) and cached; people are appended per frame as
 * round casters.
 */
export class LightCuller {
  readonly lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  readonly occ = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  readonly power = new Float32Array(MAX_MAP_LIGHTS)
  lightCount = 0
  occCount = 0
  private map: MapDef | null = null
  private rects: Float32Array = new Float32Array(0)
  private grid = new Map<number, number[]>()
  private stamp = new Uint32Array(0)
  private stampN = 0
  private cache = new Map<number, Float32Array>()
  private flick: boolean[] = []
  private order: { l: LightDef; d: number }[] = []
  private static CELL = 4

  setMap(map: MapDef): void {
    this.map = map
    this.cache.clear()
    this.grid.clear()
    const list: number[] = []
    for (const w of map.walls) list.push(...w.rect, w.h)
    for (const p of map.props) {
      const h = p.solid ? PROP_H[p.kind] : undefined
      if (h !== undefined) list.push(...p.rect, p.kind === "crate" ? Math.min(p.rect[2] - p.rect[0], p.rect[3] - p.rect[1]) * 0.9 : h)
    }
    this.rects = new Float32Array(list)
    const n = list.length / 5
    this.stamp = new Uint32Array(n)
    const C = LightCuller.CELL
    for (let i = 0; i < n; i++) {
      const o = i * 5
      const cx0 = Math.floor(this.rects[o]! / C)
      const cy0 = Math.floor(this.rects[o + 1]! / C)
      const cx1 = Math.floor(this.rects[o + 2]! / C)
      const cy1 = Math.floor(this.rects[o + 3]! / C)
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cy * 4096 + cx
          let cell = this.grid.get(k)
          if (!cell) this.grid.set(k, (cell = []))
          cell.push(i)
        }
    }
    this.flick = map.lights.map(flickers)
  }

  /** Occluders within reach of a light at (x, y), radius r, packed. */
  private gather(x: number, y: number, r: number): Float32Array {
    const C = LightCuller.CELL
    const out: number[] = []
    this.stampN++
    const R = this.rects
    for (let cy = Math.floor((y - r) / C); cy <= Math.floor((y + r) / C); cy++)
      for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) {
        const cell = this.grid.get(cy * 4096 + cx)
        if (!cell) continue
        for (const i of cell) {
          if (this.stamp[i] === this.stampN) continue
          this.stamp[i] = this.stampN
          const o = i * 5
          const dx = Math.max(R[o]! - x, 0, x - R[o + 2]!)
          const dy = Math.max(R[o + 1]! - y, 0, y - R[o + 3]!)
          if (dx * dx + dy * dy > r * r) continue
          out.push(R[o]!, R[o + 1]!, R[o + 2]!, R[o + 3]!, R[o + 4]!, 0, 0, 0)
        }
      }
    return new Float32Array(out)
  }

  /** Builds this frame's light and occluder buffers and the per-map-light fixture brightness. */
  update(view: ViewRect, t: number, dyn: readonly DynLight[], casters: readonly Caster[]): void {
    const map = this.map
    if (!map) return
    const [vx0, vy0, vx1, vy1] = view
    const cx = (vx0 + vx1) / 2
    const cy = (vy0 + vy1) / 2
    const P = this.power
    const order = this.order
    order.length = 0
    const n = Math.min(map.lights.length, MAX_MAP_LIGHTS)
    for (let i = 0; i < n; i++) {
      const l = map.lights[i]!
      P[i] = this.flick[i] ? flicker(l.id, t) : 1
      const dx = Math.max(vx0 - l.x, 0, l.x - vx1)
      const dy = Math.max(vy0 - l.y, 0, l.y - vy1)
      if (dx * dx + dy * dy > l.r * l.r || l.power <= 0) continue
      order.push({ l, d: Math.hypot(l.x - cx, l.y - cy) })
    }
    order.sort((a, b) => a.d - b.d)
    const room = MAX_LIGHTS - Math.min(dyn.length, 8)
    const L = this.lights
    L.fill(0)
    let nl = 0
    let no = 0
    const pushOcc = (x: number, y: number, r: number, list: Float32Array, near: number): [number, number] => {
      const off = no
      const fit = Math.min(list.length / OCC_FLOATS, MAX_OCCLUDERS - no)
      this.occ.set(fit === list.length / OCC_FLOATS ? list : list.subarray(0, fit * OCC_FLOATS), no * OCC_FLOATS)
      no += fit
      for (const c of casters) {
        if (no >= MAX_OCCLUDERS) break
        const dx = c.x - x
        const dy = c.y - y
        if (dx * dx + dy * dy > (r + 0.5) * (r + 0.5) || dx * dx + dy * dy < near * near) continue
        this.occ.set([c.x, c.y, 0.2, 0, 1.75, 1, 0, 0], no * OCC_FLOATS)
        no++
      }
      return [off, no - off]
    }
    for (const { l } of order) {
      if (nl >= room) break
      let list = this.cache.get(l.id)
      if (!list) this.cache.set(l.id, (list = this.gather(l.x, l.y, l.r)))
      const [off, cnt] = pushOcc(l.x, l.y, l.r, list, 0.3)
      const pw = l.power * GAIN[l.kind] * (l.id < n ? P[l.id]! : 1)
      L.set([l.x, l.h, l.y, l.r, l.color[0], l.color[1], l.color[2], pw, l.cone?.[0] ?? 0, l.cone?.[1] ?? 0, l.cone?.[2] ?? 0, l.cone ? 1 : 0, off, cnt, SIZE[l.kind], l.id], nl * LIGHT_FLOATS)
      nl++
    }
    for (const f of dyn) {
      if (nl >= MAX_LIGHTS) break
      const [off, cnt] = pushOcc(f.x, f.y, f.r, this.gather(f.x, f.y, f.r), 1.1)
      L.set([f.x, f.h, f.y, f.r, f.color[0], f.color[1], f.color[2], f.power, 0, 0, 0, 0, off, cnt, f.size, -1], nl * LIGHT_FLOATS)
      nl++
    }
    this.lightCount = nl
    this.occCount = no
  }
}
