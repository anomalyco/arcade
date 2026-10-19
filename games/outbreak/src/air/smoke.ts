import type { Particles, ParticleSpec } from "@arcade/kit/fx/particles"
import { carSites } from "../../shared/discovery/verbs"
import { SIZE, type Town } from "../../shared/map"
import { MANHOLES, STORM_DRAINS } from "../audio/space"
import { carPose } from "../discovery/verbs"
import type { OutbreakAirSettings } from "./settings"

/**
 * World smoke: steam venting from manholes and storm drain grates, smouldering abandoned cars (and every wreck the
 * survivors made), and a thin smoke from the odd chimney. Which sources smoke is a pure function of the town and
 * `smokeSeed` (`smokeSources`), so streamed-back chunks and co-op clients agree; the puffs themselves are local kit
 * `smoke` particles that drift on the wind and are lit only by real lights (`scene/fx-particles.ts`), so at night they
 * stay dark until the beam, a lamp or a fire finds them.
 */

export type SmokeKind = "steam" | "drain" | "car" | "chimney"

export type SmokeSource = {
  readonly key: string
  readonly kind: SmokeKind
  readonly x: number
  readonly y: number
  readonly z: number
  /** Drains: the grate's half extents, so puffs rise along it. */
  readonly hw?: number
  readonly hd?: number
}

export type SmokePlacement = Pick<OutbreakAirSettings, "smokeManholes" | "smokeDrains" | "smokeCars" | "smokeChimneys" | "smokeSeed">

export function smokeHash01(town: Pick<Town, "seed">, seed: number, key: string): number {
  let h = 2166136261
  const s = `${town.seed}:smoke:${seed}:${key}`
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

/**
 * Every source in the loaded town: the manholes and drains of the macro-block `ground.ts` draws (keyed by world
 * position), the abandoned cars, the house chimneys (on the brick stack `architecture.ts` builds), and `wrecks`.
 */
export function smokeSources(town: Town, s: SmokePlacement, wrecks: readonly { id: string; x: number; y: number; h: number }[] = []): SmokeSource[] {
  const out: SmokeSource[] = []
  const roll = (key: string) => smokeHash01(town, s.smokeSeed, key)
  const ox = Math.floor((town.windowOrigin?.[0] ?? 0) / SIZE) * SIZE
  const oz = Math.floor((town.windowOrigin?.[1] ?? 0) / SIZE) * SIZE
  for (const [mx, mz] of MANHOLES) {
    const key = `mh:${(ox + mx).toFixed(1)},${(oz + mz).toFixed(1)}`
    if (roll(key) < s.smokeManholes) out.push({ key, kind: "steam", x: ox + mx, y: 0.06, z: oz + mz })
  }
  for (const [dx, dz, hw, hd] of STORM_DRAINS) {
    const key = `dr:${(ox + dx).toFixed(1)},${(oz + dz).toFixed(1)}`
    if (roll(key) < s.smokeDrains) out.push({ key, kind: "drain", x: ox + dx, y: 0.05, z: oz + dz, hw, hd })
  }
  for (const car of carSites(town)) {
    const key = `car:${car.key}`
    if (roll(key) >= s.smokeCars) continue
    const pose = carPose(car.rect)
    // Out of the engine bay, under the bonnet's front edge.
    const f = pose.halfLength * 0.62
    out.push({ key, kind: "car", x: pose.x + Math.cos(pose.yaw) * f, y: 0.92, z: pose.z + Math.sin(pose.yaw) * f })
  }
  for (const w of wrecks) {
    out.push({ key: `wreck:${w.id}`, kind: "car", x: w.x + Math.cos(w.h) * 1.2, y: 0.95, z: w.y + Math.sin(w.h) * 1.2 })
  }
  for (const b of town.buildings) {
    if (b.kind !== "house" || b.footprint) continue
    const key = `chimney:${b.id}`
    if (roll(key) >= s.smokeChimneys) continue
    const [, z0, r, z1] = b.rect
    out.push({ key, kind: "chimney", x: r - 1.6, y: 4.95, z: (z0 + z1) / 2 + 1.3 })
  }
  return out
}

/** Albedo, opacity, start size, rise and rate per kind (before the Lab's multipliers). */
const LOOK: Record<SmokeKind, { shade: number; alpha: number; size: number; vy: number; rate: number; grow: number }> = {
  steam: { shade: 0.72, alpha: 0.42, size: 0.42, vy: 1.2, rate: 3.6, grow: 1.5 },
  drain: { shade: 0.66, alpha: 0.32, size: 0.32, vy: 0.9, rate: 2.8, grow: 1.3 },
  car: { shade: 0.15, alpha: 0.42, size: 0.24, vy: 0.75, rate: 2.4, grow: 1.35 },
  chimney: { shade: 0.34, alpha: 0.26, size: 0.2, vy: 0.55, rate: 1.4, grow: 1.5 },
}

export class WorldSmoke {
  private placed: SmokeSource[] = []
  private placedKey = ""
  private readonly carry = new Map<string, number>()
  private readonly spec: ParticleSpec = { kind: "smoke", life: 4, size: 0.3, growth: 0.3, gravity: -0.25, drag: 0.9, bounce: 0, r: 0.5, g: 0.5, b: 0.5, alpha: 0.3, temperature: 0, turbulence: 0.9, ease: 1.4 }
  private readonly glow: ParticleSpec = { kind: "fireball", life: 0.8, size: 0.08, growth: 0.1, gravity: -0.4, drag: 2, bounce: 0, r: 0.35, g: 1, b: 1, alpha: 0.8, temperature: 0.4, turbulence: 0.9, ease: 2 }
  private seed = 0x51ed27
  private readonly random = () => {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 4294967296
  }
  /** Proof readout of the last frame. */
  readonly shown = { sources: 0, placed: 0 }

  reset(): void {
    this.placedKey = ""
    this.carry.clear()
  }

  /**
   * Emits this frame's puffs into `p` and sets its wind. `sun` is daylight (0..1); `interior` drops chimneys while the
   * roofs are cut away.
   */
  emit(
    p: Particles,
    town: Town,
    s: OutbreakAirSettings,
    dt: number,
    at: { x: number; y: number },
    sun: number,
    interior: boolean,
    support: (x: number, z: number) => number,
    wrecks: readonly { id: string; x: number; y: number; h: number }[],
  ): void {
    const a = (s.smokeWindAngle * Math.PI) / 180
    p.windX = Math.cos(a) * s.smokeWind
    p.windZ = Math.sin(a) * s.smokeWind
    this.shown.sources = 0
    if (!s.worldSmoke || s.smokeDensity <= 0 || s.smokeMaxSources <= 0) return
    const wreckKey = wrecks.map((w) => w.id).join(",")
    const key = `${town.seed}:${town.windowOrigin?.[0] ?? 0}:${town.windowOrigin?.[1] ?? 0}:${town.buildings.length}:${s.smokeSeed}:${s.smokeManholes}:${s.smokeDrains}:${s.smokeCars}:${s.smokeChimneys}:${wreckKey}`
    if (key !== this.placedKey) {
      this.placedKey = key
      this.placed = smokeSources(town, s, wrecks)
      this.shown.placed = this.placed.length
    }
    const range2 = s.smokeRange * s.smokeRange
    const near: { src: SmokeSource; d2: number }[] = []
    for (const src of this.placed) {
      if (interior && src.kind === "chimney") continue
      const d2 = (src.x - at.x) ** 2 + (src.z - at.y) ** 2
      if (d2 < range2) near.push({ src, d2 })
    }
    near.sort((l, r) => l.d2 - r.d2)
    const n = Math.min(near.length, Math.round(s.smokeMaxSources))
    const day = 1 - Math.max(0, Math.min(1, s.smokeDayThin)) * sun
    const life = Math.max(0.5, s.smokeLife)
    const r = this.random
    const sp = this.spec
    for (let i = 0; i < n; i++) {
      const src = near[i]!.src
      const look = LOOK[src.kind]
      let c = (this.carry.get(src.key) ?? r()) + look.rate * s.smokeRate * dt
      const births = Math.min(16, Math.floor(c))
      c -= births
      this.carry.set(src.key, c)
      this.shown.sources++
      const g = src.kind === "chimney" ? 0 : support(src.x, src.z)
      for (let b = 0; b < births; b++) {
        const jx = src.hw !== undefined ? (r() - 0.5) * 2 * src.hw : (r() - 0.5) * 0.4
        const jz = src.hd !== undefined ? (r() - 0.5) * 2 * src.hd : (r() - 0.5) * 0.4
        const size = look.size * s.smokeSize
        sp.life = life * (0.8 + 0.4 * r())
        sp.size = size * (0.8 + 0.4 * r())
        sp.growth = (size * look.grow * 3) / sp.life
        sp.r = look.shade
        sp.g = look.shade * 0.98
        sp.b = look.shade * 0.95
        sp.alpha = Math.min(1, look.alpha * s.smokeDensity * day * (0.8 + 0.4 * r()))
        if (sp.alpha < 0.01) continue
        p.spawn(sp, src.x + jx, g + src.y, src.z + jz, (r() - 0.5) * 0.3, look.vy * (0.75 + 0.5 * r()), (r() - 0.5) * 0.3, r() * 6.283)
      }
      // A smouldering car shows a dull red glow in the engine bay at night.
      if (src.kind === "car" && sun < 0.6 && r() < dt * 2.2) {
        this.glow.temperature = 0.36 + 0.1 * r()
        p.spawn(this.glow, src.x + (r() - 0.5) * 0.5, g + 0.72, src.z + (r() - 0.5) * 0.5, 0, 0.15, 0, r() * 6.283)
      }
    }
    if (this.carry.size > 256) this.carry.clear()
  }
}
