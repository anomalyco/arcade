import { MAX_LIGHTS, MAX_MAP_LIGHTS, MAX_OCCLUDERS } from "../../shared/config"
import type { LightDef, LightKind, MapDef, MapKind, PropKind } from "../../shared/maps"
import { deskMonitorLights } from "./models"

import { LIGHT_FLOATS, OCC_FLOATS } from "@arcade/kit/gpu/limits"
export { LIGHT_FLOATS, OCC_FLOATS } from "@arcade/kit/gpu/limits"

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
  bin: 0.9,
  newsbox: 1.05,
  bench: 0.5,
  chair: 0.9,
}

/** Apparent size of each fixture, which sets how soft its shadows are. */
const SIZE: Record<LightKind, number> = { desk: 0.12, panel: 0.5, pendant: 0.3, exit: 0.35, vending: 0.6, server: 0.45, bulb: 0.2, street: 0.3, signal: 0.2, neon: 0.9, fire: 0.8, flood: 0.6, glow: 0.7 }
/** How bright each kind looks, relative to the rule's power. */
/** Visual reach relative to the rule's radius: lamps make tight pools, tubes wide ones. */
const REACH: Record<LightKind, number> = { desk: 0.9, panel: 1, pendant: 0.9, exit: 1, vending: 1, server: 1, bulb: 0.9, street: 1, signal: 1, neon: 1, fire: 1, flood: 1, glow: 1 }
/** Practical lights read more saturated than their rule colours: warm goes amber, cold goes blue. */
const SAT: Record<LightKind, number> = { desk: 1.7, panel: 1.0, pendant: 1.7, exit: 1.3, vending: 1, server: 0.8, bulb: 1.6, street: 1.5, signal: 1.2, neon: 1.2, fire: 1.4, flood: 1, glow: 1.1 }
const sat = (c: readonly [number, number, number], k: number): [number, number, number] => {
  const m = Math.max(c[0], c[1], c[2])
  return [(c[0] / m) ** k * m, (c[1] / m) ** k * m, (c[2] / m) ** k * m]
}
const GAIN: Record<LightKind, number> = { desk: 0.85, panel: 0.85, pendant: 1, exit: 2, vending: 1, server: 0.8, bulb: 1, street: 1, signal: 1.6, neon: 1.4, fire: 1.2, flood: 0.9, glow: 1 }

/** A light for this frame only (muzzle flashes, blasts, vehicle lamps); `cone` aims it like a map light's. */
/**
 * The sky's ambient light (rgb) and moonlight strength per kind of map, for the frame uniform: the office is lit by
 * the city through its windows; downtown sits under a darker sky, the moon falling on the open ground.
 */
export const AMBIENT: Record<MapKind, readonly [number, number, number, number]> = {
  office: [0.085, 0.1, 0.16, 1.0],
  downtown: [0.065, 0.078, 0.13, 0.2],
}

export type DynLight = { x: number; y: number; h: number; r: number; color: readonly [number, number, number]; power: number; size: number; cone?: readonly [number, number, number]; near?: number }
/** A round shadow caster: a person by default, or a vehicle's radius and height. */
export type Caster = { x: number; y: number; r?: number; h?: number }
export type ViewRect = readonly [number, number, number, number]

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/**
 * How unreliable a light looks, 0..1: the map's hint, or else a few tubes and bulbs picked deterministically per light
 * so everyone sees the same flicker. Purely visual.
 */
export function flickers(l: LightDef): number {
  if (l.flicker !== undefined) return l.flicker
  return (l.kind === "panel" || l.kind === "bulb") && hash(l.id * 3.7 + 1) < 0.1 ? 0.5 : 0
}

/** Brightness multiplier of a stuttering fitting at time t (seconds); worse fittings stutter longer and more often. */
export function flicker(id: number, t: number, bad: number): number {
  const period = 2 + hash(id) * 6 * (1.2 - bad)
  const phase = (t + hash(id + 9) * period) % period
  const burst = 0.25 + bad * 1.4
  if (phase > burst) return 0.95 + 0.05 * Math.sin(t * 50 + id)
  const seg = Math.floor(t * 18)
  const r = hash(seg * 0.37 + id * 11.3)
  return r < 0.3 + bad * 0.3 ? 0.04 : r < 0.75 ? 0.5 : 1
}

/**
 * Picks the lights that matter for the current view and packs them, with only the occluders each can reach, for the
 * GPU. Per-light occluder lists are static (walls and solid furniture) and cached; people are appended per frame as
 * round casters.
 */
export class LightCuller {
  warmPracticals = false
  readonly lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  readonly occ = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  readonly power = new Float32Array(MAX_MAP_LIGHTS)
  lightCount = 0
  /** Contiguous prefix with occluders; later lights never read the polar buffer. */
  shadowLightCount = 0
  monitorStart = 0
  readonly monitorBounds = new Float32Array(4)
  occCount = 0
  private map: MapDef | null = null
  private rects: Float32Array = new Float32Array(0)
  private grid = new Map<number, number[]>()
  private stamp = new Uint32Array(0)
  private stampN = 0
  private cache = new Map<number, Float32Array>()
  private flick: number[] = []
  private order: { l: LightDef; d: number }[] = []
  private monitorLights: LightDef[] = []
  private chairs = true
  monitorIntensity = 1
  private static CELL = 4

  setMap(map: MapDef, chairs = this.chairs): void {
    this.chairs = chairs
    this.map = map
    this.monitorLights = deskMonitorLights(map)
    this.cache.clear()
    this.grid.clear()
    const list: number[] = []
    for (const w of map.walls) list.push(...w.rect, w.h)
    for (const p of map.props) {
      if (p.kind === "chair" && !chairs) continue
      const h = p.solid || p.kind === "chair" ? PROP_H[p.kind] : undefined
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

  setChairShadows(enabled: boolean): void {
    if (enabled !== this.chairs && this.map) this.setMap(this.map, enabled)
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
  update(view: ViewRect, t: number, dyn: readonly DynLight[], casters: readonly Caster[], monitors = true, broken: readonly Caster[] = []): void {
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
      P[i] = this.flick[i]! > 0 ? flicker(l.id, t, this.flick[i]!) : 1
      const dx = Math.max(vx0 - l.x, 0, l.x - vx1)
      const dy = Math.max(vy0 - l.y, 0, l.y - vy1)
      if (dx * dx + dy * dy > l.r * l.r || l.power <= 0) continue
      order.push({ l, d: Math.hypot(l.x - cx, l.y - cy) })
    }
    order.sort((a, b) => a.d - b.d)
    const room = MAX_LIGHTS - Math.min(dyn.length, 16)
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
        const cr = c.r ?? 0.2
        if (dx * dx + dy * dy > (r + 0.3 + cr) * (r + 0.3 + cr) || dx * dx + dy * dy < near * near) continue
        this.occ.set([c.x, c.y, cr, 0, c.h ?? 1.75, 1, 0, 0], no * OCC_FLOATS)
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
      const c = sat(l.color, SAT[l.kind])
      if (this.warmPracticals) {
        if (l.kind === "panel") {
          // Warm-white tubes, with a stable per-fixture temperature rather than blue-white wash.
          const warm = hash(l.id * 7.3) * 0.08
          c[0] = 1; c[1] = 0.85 + warm; c[2] = 0.64 + warm
        } else if (l.kind === "desk" || l.kind === "pendant" || l.kind === "bulb") {
          c[0] = 1; c[1] = 0.43 + hash(l.id) * 0.08; c[2] = 0.13
        } else if (l.kind === "exit") {
          c[0] = 1; c[1] = 0.035; c[2] = 0.018
        }
      }
      L.set([l.x, l.h, l.y, l.r * REACH[l.kind], c[0], c[1], c[2], pw, l.cone?.[0] ?? 0, l.cone?.[1] ?? 0, l.cone?.[2] ?? 0, l.cone ? 1 : 0, off, cnt, SIZE[l.kind], l.id], nl * LIGHT_FLOATS)
      nl++
    }
    for (const f of dyn) {
      if (nl >= MAX_LIGHTS) break
      const [off, cnt] = pushOcc(f.x, f.y, f.r, this.gather(f.x, f.y, f.r), f.near ?? 1.1)
      L.set([f.x, f.h, f.y, f.r, f.color[0], f.color[1], f.color[2], f.power, f.cone?.[0] ?? 0, f.cone?.[1] ?? 0, f.cone?.[2] ?? 0, f.cone ? 1 : 0, off, cnt, f.size, -1], nl * LIGHT_FLOATS)
      nl++
    }
    // Partition in-place: polar rows and light indices stay identical for every shadowed light.
    let shadowed = 0
    for (let i = 0; i < nl; i++) if (L[i * LIGHT_FLOATS + 13]! > 0) {
      if (i !== shadowed) for (let k = 0; k < LIGHT_FLOATS; k++) {
        const a = shadowed * LIGHT_FLOATS + k, b = i * LIGHT_FLOATS + k
        const value = L[a]!
        L[a] = L[b]!
        L[b] = value
      }
      shadowed++
    }
    this.shadowLightCount = shadowed
    this.monitorStart = nl
    this.monitorBounds.set([1e9, 1e9, -1e9, -1e9])
    // Tight unshadowed pools: no occluder gathering, polar rays, or shadow-map reads.
    if (monitors && this.monitorIntensity > 0) for (const l of this.monitorLights) {
      if (nl >= MAX_LIGHTS) break
      const radius = 1.65
      const dx = Math.max(vx0 - l.x, 0, l.x - vx1), dy = Math.max(vy0 - l.y, 0, l.y - vy1)
      if (dx * dx + dy * dy > radius * radius || broken.some((b) => b.x === l.x && b.y === l.y)) continue
      L.set([l.x, l.h, l.y, radius, ...l.color, l.power * this.monitorIntensity, ...(l.cone ?? [0, 0, 0]), 1, 0, 0, SIZE.desk, l.id], nl * LIGHT_FLOATS)
      const bound = radius + 0.001 // Outward pad covers float32 position/radius rounding on the GPU.
      this.monitorBounds[0] = Math.min(this.monitorBounds[0]!, l.x - bound)
      this.monitorBounds[1] = Math.min(this.monitorBounds[1]!, l.y - bound)
      this.monitorBounds[2] = Math.max(this.monitorBounds[2]!, l.x + bound)
      this.monitorBounds[3] = Math.max(this.monitorBounds[3]!, l.y + bound)
      nl++
    }
    this.lightCount = nl
    this.occCount = no
  }
}
