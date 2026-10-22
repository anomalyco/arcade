import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import type { DistantEvent } from "../shared/distant"
import { nextRandom, standHeight, treesNear, type WoodsWorld } from "../shared/world"

/**
 * Eyeshine: an animal's tapetum sends a torch's light straight back at it, so from beside the torch a pair of eyes
 * glows out of the dark at 20–60 m while the animal itself stays invisible. Only where a light that is near the
 * viewer's eye lands (yours, or a camera's infrared lamp), only while the animal looks your way, gone when it blinks
 * or turns. Presentation only: rare sightings on a local seeded schedule, plus the shared distant sounds of a fox or
 * something moving in the brush when they happen close enough to be seen (`event`).
 */
export type EyeKind = "deer" | "fox" | "raccoon" | "owl"
const EYES: Record<EyeKind, { gap: number; height: number; color: readonly [number, number, number] }> = {
  // Deer: blue-green to white; foxes and raccoons yellow-green to amber; owls (no tapetum to speak of) a dull red-orange.
  deer: { gap: 0.1, height: 1.42, color: [0.78, 1, 0.74] },
  fox: { gap: 0.05, height: 0.34, color: [1, 0.93, 0.5] },
  raccoon: { gap: 0.045, height: 0.3, color: [1, 0.8, 0.38] },
  owl: { gap: 0.065, height: 0, color: [1, 0.48, 0.16] },
}
const SOUND_KIND: Partial<Record<DistantEvent["sound"], EyeKind>> = { "far.fox": "fox", "far.steps": "deer", "far.snap": "deer" }

type Sighting = { kind: EyeKind; x: number; y: number; z: number; face: number; start: number; end: number; seed: number }
/** A light near the viewer: lens, unit axis, power (cd-ish, the forest's `torchPower × 5`), half-angle (rad) and its angular profile. */
export type EyeLight = { pos: readonly number[]; dir: readonly number[]; power: number; halfAngle: number; profile: (t: number) => number }

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export class Eyeshine {
  private rng: { seed: number }
  private next = -1
  private list: Sighting[] = []
  /** Brightness of the returned light (× retroreflection); the sprite carries the energy, the exposure does the rest. */
  gain = 1

  constructor(seed: number) { this.rng = { seed: seed ^ 0x3ee7 } }

  get sightings(): readonly Sighting[] { return this.list }

  /**
   * A pair of eyes about `distance` m out where you look (the Lab's "Show eyes now"), watching for `seconds`: the
   * nearest bearing and range to that with a clear line of sight.
   */
  show(world: WoodsWorld, eye: readonly number[], yaw: number, t: number, blocked: (a: readonly number[], b: readonly number[]) => boolean, kind: EyeKind = "deer", distance = 32, seconds = 40) {
    for (const turn of [0, 0.06, -0.06, 0.12, -0.12, 0.18, -0.18, 0.25, -0.25]) for (const k of [1, 0.8, 1.25, 0.65]) {
      const a = yaw + turn, d = distance * k, x = eye[0]! - Math.sin(a) * d, z = eye[2]! - Math.cos(a) * d
      if (treesNear(world, x, z, 0.5).length || blocked(eye, [x, standHeight(world, x, z) + EYES[kind].height, z])) continue
      this.add(world, eye, kind, x, z, t, seconds)
      return
    }
    this.spawn(world, eye, yaw, t, kind, distance, 0, seconds)
  }

  clear() { this.list.length = 0; this.next = -1 }

  /** A shared distant sound close enough to see: a fox, or a deer stepping or snapping a branch. */
  event(e: DistantEvent, world: WoodsWorld, eye: readonly number[], t: number) {
    const kind = SOUND_KIND[e.sound]
    if (!kind || Math.hypot(e.x - eye[0]!, e.z - eye[2]!) > 75) return
    this.add(world, eye, kind, e.x, e.z, t, 5 + nextRandom(this.rng) * 6)
  }

  /** Rare local sightings: the first a minute or two after it's switched on, then one every two to five minutes. */
  step(world: WoodsWorld, eye: readonly number[], yaw: number, t: number) {
    if (this.next < 0) this.next = t + 60 + nextRandom(this.rng) * 90
    if (t >= this.next) {
      this.next = t + 120 + nextRandom(this.rng) * 180
      const r = nextRandom(this.rng)
      const kind: EyeKind = r < 0.45 ? "deer" : r < 0.7 ? "fox" : r < 0.85 ? "raccoon" : "owl"
      this.spawn(world, eye, yaw, t, kind, 20 + 40 * nextRandom(this.rng) ** 1.3, (nextRandom(this.rng) - 0.5) * 1.2, 6 + nextRandom(this.rng) * 8)
    }
    this.list = this.list.filter((s) => s.end > t)
  }

  /**
   * Eye sprites for this frame. `lights` are the lights beside the viewer; `blocked` says whether a trunk or the
   * ground hides one point from another; `beta` is the air's extinction (1/m), crossed twice.
   */
  draw(fp: FrameParts, eye: readonly number[], t: number, lights: readonly EyeLight[], blocked: (a: readonly number[], b: readonly number[]) => boolean, beta: number) {
    for (const s of this.list) {
      const age = t - s.start, left = s.end - t
      if (age < 0) continue
      // Head comes up, drifts a little, blinks now and then, and turns away at the end.
      const lift = smooth(0, 0.35, age)
      const face = s.face + Math.sin(age * 0.6 + s.seed * 6) * 0.25 + smooth(0.7, 0, left) * 1.7
      const window = Math.floor((age + s.seed * 3) / 3.1)
      const blinkAt = ((window * 0.61803 + s.seed) % 1) * 2.6
      const blink = (age + s.seed * 3) % 3.1 > blinkAt && (age + s.seed * 3) % 3.1 < blinkAt + 0.14 ? 0 : 1
      const fx = Math.sin(face), fz = Math.cos(face)
      const tx = eye[0]! - s.x, tz = eye[2]! - s.z, td = Math.hypot(tx, tz) || 1
      const facing = smooth(0.4, 0.9, (fx * tx + fz * tz) / td)
      const k = lift * blink * facing
      if (k <= 0.001 || blocked(eye, [s.x, s.y, s.z])) continue
      const g = EYES[s.kind].gap / 2
      for (const side of [-1, 1]) {
        const p = [s.x + fz * g * side, s.y, s.z - fx * g * side]
        let lit = 0
        for (const l of lights) {
          const dx = p[0]! - l.pos[0]!, dy = p[1]! - l.pos[1]!, dz = p[2]! - l.pos[2]!
          const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2) || 1
          const cos = (dx * l.dir[0]! + dy * l.dir[1]! + dz * l.dir[2]!) / d
          if (cos <= 0) continue
          lit += (l.power * l.profile(Math.acos(Math.min(1, cos)) / l.halfAngle)) / d2
        }
        const de = Math.hypot(p[0]! - eye[0]!, p[1]! - eye[1]!, p[2]! - eye[2]!)
        const seen = Math.min(600, (lit * 1.5e5 * this.gain) / (de * de)) * Math.exp(-2 * beta * de) * k
        if (seen < 0.05) continue
        const c = EYES[s.kind].color
        // A 12 cm quad: the glow sprite keeps its hot core at least ~1.3 px wide, so the eye stays a point at any range.
        fp.sprite(true, p[0]!, p[1]!, p[2]!, 0.12, c[0] * seen, c[1] * seen, c[2] * seen, 1, 9)
      }
    }
  }

  private spawn(world: WoodsWorld, eye: readonly number[], yaw: number, t: number, kind: EyeKind, distance: number, turn: number, seconds: number) {
    const a = yaw + turn
    this.add(world, eye, kind, eye[0]! - Math.sin(a) * distance, eye[2]! - Math.cos(a) * distance, t, seconds)
  }

  private add(world: WoodsWorld, eye: readonly number[], kind: EyeKind, x: number, z: number, t: number, seconds: number) {
    let y: number
    if (kind === "owl") {
      // Perched on the nearest trunk, on the side facing you.
      const tree = treesNear(world, x, z, 6).sort((p, q) => Math.hypot(p.x - x, p.z - z) - Math.hypot(q.x - x, q.z - z))[0]
      if (tree) {
        const dx = eye[0]! - tree.x, dz = eye[2]! - tree.z, d = Math.hypot(dx, dz) || 1
        x = tree.x + (dx / d) * (tree.radius + 0.12); z = tree.z + (dz / d) * (tree.radius + 0.12)
        y = tree.y + 3.5 + nextRandom(this.rng) * 3
      } else y = standHeight(world, x, z) + 2.5
    } else {
      // Not inside a trunk: step aside.
      for (let i = 0; i < 4 && treesNear(world, x, z, 0.5).length; i++) x += 1.2
      y = standHeight(world, x, z) + EYES[kind].height
    }
    this.list.push({ kind, x, y, z, face: Math.atan2(eye[0]! - x, eye[2]! - z), start: t, end: t + seconds, seed: nextRandom(this.rng) })
  }
}
