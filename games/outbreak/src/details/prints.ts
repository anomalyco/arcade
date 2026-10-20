import { inBuildingFootprint, SIZE, type Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { putSprite } from "./light-probe"

/**
 * Wet and muddy boot prints. A survivor who walks through standing water, or across a soaked lawn, carries it on
 * their boots for a dozen steps and prints it onto hard ground: the road, the paths, porches and the floors inside.
 * Water prints dry off in a minute or two (slower indoors); mud dries pale and stays, so the houses you went through
 * after the rain still show it. Each client prints from the replicated survivor positions.
 */

/** Most prints kept (oldest go first). */
export const PRINTS_MAX = 160
/** Stride (m) between prints, as the blood prints use. */
export const STRIDE = 0.68
/** Seconds a water print takes to dry outdoors and indoors. */
export const DRY_OUT = 45
export const DRY_IN = 120

export type GroundKind = "floor" | "hard" | "yard"
export type PrintWeather = { wetness: number; puddleAt: (x: number, z: number) => number }

type Print = { x: number; y: number; z: number; yaw: number; side: number; strength: number; mud: boolean; born: number; dry: number }
type Walker = { x: number; y: number; water: number; mud: number; side: number; seen: boolean }

const fold = (v: number) => ((v % SIZE) + SIZE) % SIZE

/** What a survivor is walking on: inside a building, the street grid's road and sidewalks, or the yards. */
export function groundKind(town: Town, x: number, z: number): GroundKind {
  for (const b of town.buildings) if (inBuildingFootprint(b, x, z)) return "floor"
  const lx = fold(x)
  const lz = fold(z)
  return (lx > 37.6 && lx < 50.4) || (lz > 37.6 && lz < 50.4) ? "hard" : "yard"
}

export class BootPrints {
  private readonly ring: Print[] = []
  private head = 0
  private readonly walkers = new Map<string, Walker>()
  /** Readout: prints made so far. */
  made = 0

  get count(): number {
    return this.ring.length
  }

  reset(): void {
    this.ring.length = 0
    this.head = 0
    this.walkers.clear()
  }

  step(time: number, town: Town, weather: PrintWeather, survivors: readonly { id: string; survivor: { x: number; y: number; vehicleId?: number | null } }[]): void {
    for (const w of this.walkers.values()) w.seen = false
    for (const slot of survivors) {
      const v = slot.survivor
      let w = this.walkers.get(slot.id)
      if (!w) {
        w = { x: v.x, y: v.y, water: 0, mud: 0, side: 1, seen: true }
        this.walkers.set(slot.id, w)
      }
      w.seen = true
      if (v.vehicleId != null) {
        w.x = v.x
        w.y = v.y
        continue
      }
      const d = Math.hypot(v.x - w.x, v.y - w.y)
      // Teleported, respawned or driven: start again from here.
      if (d > 3) {
        w.x = v.x
        w.y = v.y
        continue
      }
      if (d < STRIDE) continue
      const dx = (v.x - w.x) / d
      const dz = (v.y - w.y) / d
      w.x = v.x
      w.y = v.y
      const kind = groundKind(town, v.x, v.y)
      if (weather.puddleAt(v.x, v.y) > 0.35) w.water = 1
      if (kind === "yard" && weather.wetness > 0.45) w.mud = 1
      w.side = -w.side
      const mud = w.mud > w.water
      const carry = Math.max(w.water, w.mud)
      // On wet ground a water print does not show, and on the lawn nothing does.
      const shows = kind !== "yard" && carry > 0.12 && (mud || kind === "floor" || weather.wetness < 0.3)
      if (shows) {
        const px = v.x - dz * w.side * 0.1
        const pz = v.y + dx * w.side * 0.1
        this.add({ x: px, y: supportHeight(town, px, pz) + (kind === "floor" ? 0.022 : 0.01), z: pz, yaw: Math.atan2(dz, dx), side: w.side, strength: carry, mud, born: time, dry: kind === "floor" ? DRY_IN : DRY_OUT })
      }
      // Each step leaves a little less on the boots.
      w.water *= 0.8
      w.mud *= 0.84
      if (w.water < 0.05) w.water = 0
      if (w.mud < 0.05) w.mud = 0
    }
    if (this.walkers.size > 8) for (const [id, w] of this.walkers) if (!w.seen) this.walkers.delete(id)
  }

  private add(p: Print): void {
    this.made++
    if (this.ring.length < PRINTS_MAX) this.ring.push(p)
    else {
      this.ring[this.head] = p
      this.head = (this.head + 1) % PRINTS_MAX
    }
  }

  /** Ground-plane sole and heel sprites (alpha, darker than the ground) for the prints in `view`; returns the new count. */
  write(time: number, view: readonly [number, number, number, number], sprites: Float32Array, n: number): number {
    const [x0, z0, x1, z1] = view
    for (const p of this.ring) {
      if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) continue
      const age = time - p.born
      // Water dries away; mud dries pale and stays.
      const fade = p.mud ? Math.max(0.35, 1 - age / (p.dry * 4)) : 1 - age / p.dry
      if (fade <= 0) continue
      const a = (p.mud ? 0.42 : 0.24) * p.strength * fade
      const r = p.mud ? 0.05 : 0.0
      const g = p.mud ? 0.036 : 0.0
      const b = p.mud ? 0.022 : 0.0
      const c = Math.cos(p.yaw)
      const s = Math.sin(p.yaw)
      n = putSprite(sprites, n, p.x + c * 0.04, p.y, p.z + s * 0.04, 0.1, r, g, b, a, 4, p.yaw, 0.5)
      n = putSprite(sprites, n, p.x - c * 0.1, p.y, p.z - s * 0.1, 0.045, r, g, b, a, 4, p.yaw, 1)
    }
    return n
  }
}
