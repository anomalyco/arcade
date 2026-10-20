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
/** Stride (m) between prints, as the blood prints use, and the dead's shorter shuffle. */
export const STRIDE = 0.68
export const SHUFFLE = 0.5
/** Seconds a water print takes to dry outdoors and indoors. */
export const DRY_OUT = 45
export const DRY_IN = 120

export type GroundKind = "floor" | "hard" | "yard"
/** Ground wetness and the standing-water level (0..1), and the puddle mask at a point on ground of `kind`. */
export type PrintWeather = { wetness: number; puddles: number; puddleAt: (x: number, z: number, kind: GroundKind) => number }

type Print = { x: number; y: number; z: number; yaw: number; side: number; strength: number; mud: boolean; drag: boolean; born: number; dry: number }
type Walker = { x: number; y: number; water: number; mud: number; side: number; seen: boolean }

const fold = (v: number) => ((v % SIZE) + SIZE) % SIZE

/** What a survivor is walking on: inside a building, the street grid's road and sidewalks, or the yards. */
export function groundKind(town: Town, x: number, z: number): GroundKind {
  for (const b of town.buildings) if (inBuildingFootprint(b, x, z)) return "floor"
  const lx = fold(x)
  const lz = fold(z)
  return (lx > 37.6 && lx < 50.4) || (lz > 37.6 && lz < 50.4) ? "hard" : "yard"
}

export type DeadWalker = { readonly id: number; readonly x: number; readonly y: number; readonly state: string }

export class BootPrints {
  private readonly ring: Print[] = []
  private head = 0
  private readonly walkers = new Map<string | number, Walker>()
  /** Readout: prints made so far. */
  made = 0

  /**
   * `dead`: prints of the dead instead, who shuffle (a shorter stride) and drag one foot, so a trail out of a puddle
   * reads as theirs.
   */
  constructor(private readonly max = PRINTS_MAX, private readonly dead = false) {}

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
      this.walk(slot.id, v.x, v.y, v.vehicleId != null, time, town, weather)
    }
    this.prune(8)
  }

  /** The dead walking within `view` (grown by a few metres) print the same way, with their own gait. */
  stepDead(time: number, town: Town, weather: PrintWeather, zombies: readonly DeadWalker[], view: readonly [number, number, number, number]): void {
    for (const w of this.walkers.values()) w.seen = false
    const [x0, z0, x1, z1] = view
    for (const z of zombies) {
      if (z.state === "dead" || z.x < x0 - 6 || z.x > x1 + 6 || z.y < z0 - 6 || z.y > z1 + 6) continue
      this.walk(z.id, z.x, z.y, false, time, town, weather)
    }
    this.prune(48)
  }

  private prune(keep: number): void {
    if (this.walkers.size > keep) for (const [id, w] of this.walkers) if (!w.seen) this.walkers.delete(id)
  }

  private walk(id: string | number, x: number, y: number, riding: boolean, time: number, town: Town, weather: PrintWeather): void {
    let w = this.walkers.get(id)
    if (!w) {
      w = { x, y, water: 0, mud: 0, side: 1, seen: true }
      this.walkers.set(id, w)
    }
    w.seen = true
    const d = Math.hypot(x - w.x, y - w.y)
    // Driven, teleported or respawned: start again from here.
    if (riding || d > 3) {
      w.x = x
      w.y = y
      return
    }
    if (d < (this.dead ? SHUFFLE : STRIDE)) return
    const dx = (x - w.x) / d
    const dz = (y - w.y) / d
    w.x = x
    w.y = y
    w.side = -w.side
    // Dry out and nothing on the feet: nothing to print, and no need to look at the ground.
    if (w.water === 0 && w.mud === 0 && weather.puddles <= 0.001 && weather.wetness <= 0.45) return
    const kind = groundKind(town, x, y)
    if (weather.puddleAt(x, y, kind) > 0.35) {
      w.water = 1
      // Standing water rinses some of the mud off.
      w.mud *= 0.85
    }
    if (kind === "yard" && weather.wetness > 0.45) w.mud = 1
    // On wet ground a water print does not show (only mud does), and on the lawn nothing does.
    const wetGround = kind !== "floor" && weather.wetness >= 0.3
    const mud = w.mud > 0.12 && (wetGround || w.mud >= w.water)
    const carry = mud ? w.mud : w.water
    const shows = kind !== "yard" && carry > 0.12 && (mud || !wetGround)
    if (shows) {
      const px = x - dz * w.side * 0.1
      const pz = y + dx * w.side * 0.1
      // The dead drag the same foot every time (which one is theirs, from the id).
      const drag = this.dead && w.side === ((typeof id === "number" ? id : 0) & 1 ? 1 : -1)
      this.add({ x: px, y: supportHeight(town, px, pz) + (kind === "floor" ? 0.022 : 0.01), z: pz, yaw: Math.atan2(dz, dx), side: w.side, strength: carry, mud, drag, born: time, dry: kind === "floor" ? DRY_IN : DRY_OUT })
    }
    // Each step leaves a little less on the feet.
    w.water *= 0.8
    w.mud *= 0.84
    if (w.water < 0.05) w.water = 0
    if (w.mud < 0.05) w.mud = 0
  }

  private add(p: Print): void {
    this.made++
    if (this.ring.length < this.max) this.ring.push(p)
    else {
      this.ring[this.head] = p
      this.head = (this.head + 1) % this.max
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
      if (p.drag) {
        // A smear from the toe back along the step instead of a print.
        n = putSprite(sprites, n, p.x - c * 0.12, p.y, p.z - s * 0.12, 0.2, r, g, b, a * 0.7, 4, p.yaw, 0.22)
        continue
      }
      n = putSprite(sprites, n, p.x + c * 0.04, p.y, p.z + s * 0.04, 0.1, r, g, b, a, 4, p.yaw, 0.5)
      n = putSprite(sprites, n, p.x - c * 0.1, p.y, p.z - s * 0.1, 0.045, r, g, b, a, 4, p.yaw, 1)
    }
    return n
  }
}
