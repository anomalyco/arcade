import type { ImpactSurface } from "@arcade/kit/audio"
import type { CombatShotEvent } from "../shared/combat"
import type { Town } from "../shared/map"
import { impactDelay, shotImpacts } from "./audio/impacts"

/** Pushes one additive sprite: position, size, colour, alpha, sprite kind (0 glow, 4 streak), rotation and stretch. */
export type PushSprite = (
  x: number,
  y: number,
  z: number,
  size: number,
  r: number,
  g: number,
  b: number,
  a: number,
  kind: number,
  rot: number,
  stretch: number,
  extra: number,
) => void

type Look = { rgb: readonly [number, number, number]; flash: number; sparks: number; dust: number }

/** Metal and glass throw bright sparks or glints; masonry throws a few chips; wood and plaster mostly dust. */
const LOOK: Record<ImpactSurface, Look> = {
  metal: { rgb: [1, 0.86, 0.58], flash: 1, sparks: 4, dust: 0 },
  glass: { rgb: [0.84, 0.92, 1], flash: 0.8, sparks: 4, dust: 0 },
  concrete: { rgb: [0.98, 0.8, 0.58], flash: 0.75, sparks: 3, dust: 0.7 },
  wood: { rgb: [0.92, 0.7, 0.46], flash: 0.55, sparks: 1, dust: 1 },
  plaster: { rgb: [0.9, 0.86, 0.78], flash: 0.5, sparks: 0, dust: 1 },
}

type Impact = { x: number; z: number; at: number; dir: number; surface: ImpactSurface; seed: number; through: boolean }

/** How long an impact draws (s): the flash is over in 70 ms, sparks in 120 ms, dust in 260 ms. */
export const IMPACT_LIFE = 0.26
const BULLET_HEIGHT = 1.3
const MAX_IMPACTS = 24

/**
 * The visual half of a missed round: a flash, sparks and dust where `shotImpacts` says it struck (the same points the
 * sound director plays `impact.bullet.<surface>` at), timed to the round's arrival. Presentation only.
 */
export class BulletImpactFx {
  private readonly impacts: Impact[] = []

  get count(): number {
    return this.impacts.length
  }

  reset(): void {
    this.impacts.length = 0
  }

  emit(town: Town, shot: CombatShotEvent, barricaded: (id: string) => number = () => 0): void {
    for (const hit of shotImpacts(town, shot, barricaded)) {
      if (this.impacts.length >= MAX_IMPACTS) this.impacts.shift()
      this.impacts.push({
        x: hit.x,
        z: hit.y,
        at: shot.time + impactDelay(hit.t),
        // Debris flies back toward the shooter; a pane the round went through sprays forward.
        dir: hit.through ? shot.aim : shot.aim + Math.PI,
        surface: hit.surface,
        seed: (shot.seed ^ Math.floor(hit.t * 997)) >>> 0,
        through: hit.through,
      })
    }
  }

  /** Draws live impacts as additive sprites and drops spent ones. `scale` is the Lab's Bullet impact flash. */
  collect(time: number, support: (x: number, z: number) => number, push: PushSprite, scale = 1): void {
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i]!
      const age = time - im.at
      if (age > IMPACT_LIFE || age < -1) {
        this.impacts.splice(i, 1)
        continue
      }
      if (age < 0 || scale <= 0) continue
      const look = LOOK[im.surface]
      const [r, g, b] = look.rgb
      const y = support(im.x, im.z) + BULLET_HEIGHT
      const k = im.through ? 0.6 : 1
      if (age < 0.07) {
        const u = 1 - age / 0.07
        push(im.x, y, im.z, 0.42 * scale * k * (0.6 + 0.4 * u), r, g, b, look.flash * u, 0, 0, 1, 0)
      }
      if (age < 0.12) {
        const u = 1 - age / 0.12
        for (let s = 0; s < look.sparks; s++) {
          const h = hash(im.seed + s * 7919)
          const ang = im.dir + (h - 0.5) * 2.2
          const dist = (2.5 + 5 * hash(im.seed + s * 104729)) * age
          push(im.x + Math.cos(ang) * dist, y - 3 * age * age, im.z + Math.sin(ang) * dist, 0.16 * scale * (0.4 + 0.6 * u), r, g, b, u, 4, ang, 0.14, 0)
        }
      }
      if (look.dust > 0) {
        const u = 1 - age / IMPACT_LIFE
        const drift = 0.35 * age
        push(
          im.x + Math.cos(im.dir) * drift,
          y - 0.1 * age,
          im.z + Math.sin(im.dir) * drift,
          (0.28 + 1.4 * age) * scale * k,
          r * 0.62,
          g * 0.6,
          b * 0.56,
          0.3 * look.dust * u * u,
          0,
          0,
          1,
          0,
        )
      }
    }
  }
}

function hash(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}
