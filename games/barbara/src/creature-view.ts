import { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import type { Batch, Renderer } from "@arcade/kit/gpu/renderer"
import { add, emit, limb, madd, rot, type V3 } from "@arcade/kit/rig"
import type { CreatureEvent } from "../shared/creature"
import { groundHeight, type WoodsWorld } from "../shared/world"

/**
 * The creature as drawn: a tall, too-thin runner with arms and legs too long, leaning into a gait a little too fast
 * and too smooth. No face, no lit detail: every part is unlit black (`MAT.glow` with no glow), so it only shows where
 * it stands in front of lit mist or a beam, and the fog in front of it is the only thing on it. It writes depth like
 * any model, so the forest's fog march stops at it and the shaft behind it goes dark in its shape. Its batches go into
 * the TAA reactive mask, so it smears across the frame instead of leaving a ghost.
 */

const BLACK = [0, 0, 0] as const

/** Body (m) at seed 0.5; the seed stretches it ±5%. */
const BODY = { thigh: 0.66, shin: 0.66, foot: 0.2, torso: 0.8, neck: 0.2, head: 0.27, upper: 0.56, fore: 0.6, fingers: 0.26, hipW: 0.1, shoulderW: 0.17, stride: 3.9, lean: 0.42 }

type Part = { model: number; length: number }
type Run = { e: CreatureEvent; start: number }

export class CreatureView {
  private fp = new FrameParts()
  private parts: Record<"thigh" | "shin" | "foot" | "torso" | "neck" | "head" | "upper" | "fore" | "fingers", Part>
  private runs: Run[] = []
  /** Drawn this frame (automation): the creature's chest in world space, or null. */
  readonly last: { at: V3 | null; seq: number; drawn: number } = { at: null, seq: -1, drawn: 0 }
  /** Automation only: draw it white (0..1) to find it in a frame. */
  debugFlash = 0

  constructor(renderer: Renderer) {
    const seg = (length: number, top: number, bottom: number, sides = 6): Part => {
      const m = new Mesh()
      m.prism(0, 0, bottom, top, -length, 0, sides, [...BLACK], MAT.glow, 0)
      m.prism(0, 0, 0.0005, bottom, -length - bottom * 0.6, -length, sides, [...BLACK], MAT.glow, 0, false)
      return { model: renderer.addModel(m), length }
    }
    const head = new Mesh()
    // A narrow skull with a long jaw: two tapered prisms, hanging down from the crown.
    head.prism(0, 0, 0.1, 0.055, -0.1, 0, 7, [...BLACK], MAT.glow, 0)
    head.prism(0, 0, 0.045, 0.1, -BODY.head, -0.1, 7, [...BLACK], MAT.glow, 0)
    this.parts = {
      // Thin for its length, but thick enough to cover a pixel at 45–80 m, or the far limbs would just vanish.
      thigh: seg(BODY.thigh, 0.1, 0.062),
      shin: seg(BODY.shin, 0.062, 0.036),
      foot: seg(BODY.foot, 0.04, 0.016, 4),
      torso: seg(BODY.torso, 0.17, 0.1, 7),
      neck: seg(BODY.neck, 0.05, 0.042, 5),
      head: { model: renderer.addModel(head), length: BODY.head },
      upper: seg(BODY.upper, 0.058, 0.044),
      fore: seg(BODY.fore, 0.044, 0.028),
      fingers: seg(BODY.fingers, 0.026, 0.006, 4),
    }
  }

  /** A sighting from the session. `now` is the page clock (s); `elapsed` is how much of it already went by. */
  start(e: CreatureEvent, now: number, elapsed = 0): void {
    if (this.runs.some((r) => r.e.seq === e.seq && r.e.at === e.at)) return
    this.runs.push({ e, start: now - Math.max(0, Math.min(elapsed, e.dur * 0.5)) })
  }

  get active(): boolean {
    return this.runs.length > 0
  }

  /** Poses whatever is running at page time `now` and returns its batches (reactive). */
  frame(world: WoodsWorld, now: number): Batch[] {
    this.fp.begin()
    this.last.at = null
    this.runs = this.runs.filter((r) => now - r.start <= r.e.dur + 0.05)
    for (const r of this.runs) {
      const u = (now - r.start) / r.e.dur
      if (u < 0 || u > 1) continue
      this.pose(world, r.e, u)
      this.last.seq = r.e.seq
      this.last.drawn++
    }
    return this.fp.batches().map((b) => ({ ...b, reactive: true }))
  }

  private pose(world: WoodsWorld, e: CreatureEvent, u: number): void {
    const s = 0.95 + 0.1 * e.seed
    const B = BODY
    const dx = e.x1 - e.x0, dz = e.z1 - e.z0
    const length = Math.hypot(dx, dz) || 1
    const f: V3 = [dx / length, 0, dz / length]
    const right: V3 = [-f[2], 0, f[0]]
    const up: V3 = [0, 1, 0]
    const down: V3 = [0, -1, 0]
    const x = e.x0 + dx * u, z = e.z0 + dz * u
    // Gait phase from distance run; a second, slower phase keeps it from looking like a loop.
    const phase = ((length * u) / (B.stride * s)) * Math.PI * 2 + e.seed * 6.28
    const sway = Math.sin(phase) * 0.03
    const lean = B.lean + 0.04 * Math.sin(phase * 2)
    const spine = rot(up, right, -lean)

    // Legs relative to the hip, then the body lifted so the lower foot just touches the ground (no IK at 60 m).
    const leg = (ph: number) => {
      const thigh = 0.82 * Math.sin(ph) + 0.12
      const knee = 0.22 + 1.35 * Math.max(0, Math.cos(ph + 0.3)) ** 1.3
      const kneeDir = rot(down, right, thigh)
      const shinDir = rot(down, right, thigh - knee)
      const k = kneeDir.map((v) => v * B.thigh * s) as V3
      const a = madd(k, shinDir, B.shin * s)
      const footDir = rot(shinDir, right, -1.2 - 0.4 * Math.max(0, Math.sin(ph)))
      return { k, a, footDir }
    }
    const L = leg(phase), R = leg(phase + Math.PI)
    const ground = groundHeight(world, x, z)
    const lowest = Math.min(L.a[1], R.a[1])
    const hip: V3 = [x + right[0] * sway, ground - lowest + 0.05 + 0.015 * Math.cos(phase * 2), z + right[2] * sway]
    const push = this.fp.push
    const seg = (part: Part, from: V3, to: V3) => emit(push, part.model, limb(from, to, f, up), BLACK, this.debugFlash)
    for (const [side, g] of [[-1, L], [1, R]] as const) {
      const h = madd(hip, right, side * B.hipW * s)
      const knee = add(h, g.k), ankle = add(h, g.a)
      seg(this.parts.thigh, h, knee)
      seg(this.parts.shin, knee, ankle)
      seg(this.parts.foot, ankle, madd(ankle, g.footDir, B.foot * s))
    }
    const neckBase = madd(hip, spine, B.torso * s)
    seg(this.parts.torso, neckBase, hip)
    // The head juts forward of the shoulders on a long neck.
    const neckDir = rot(up, right, -lean * 1.9)
    const crownBase = madd(neckBase, neckDir, B.neck * s)
    seg(this.parts.neck, crownBase, neckBase)
    const headDir = rot(up, right, -lean * 1.2)
    seg(this.parts.head, madd(crownBase, headDir, B.head * s), crownBase)
    // Arms swing wide against the legs and reach forward, hands hanging past the knees.
    for (const [side, ph] of [[-1, phase + Math.PI], [1, phase]] as const) {
      const shoulder = madd(madd(neckBase, right, side * B.shoulderW * s), spine, -0.06)
      const swing = 0.95 * Math.sin(ph) + 0.3 + lean * 0.6
      const out = rot(down, f, side * -0.12)
      const upperDir = rot(out, right, swing)
      const elbow = madd(shoulder, upperDir, B.upper * s)
      const bend = 0.35 + 0.45 * Math.max(0, Math.sin(ph))
      const foreDir = rot(upperDir, right, bend)
      const wrist = madd(elbow, foreDir, B.fore * s)
      const tip = madd(wrist, rot(foreDir, right, 0.35), B.fingers * s)
      seg(this.parts.upper, shoulder, elbow)
      seg(this.parts.fore, elbow, wrist)
      seg(this.parts.fingers, wrist, tip)
    }
    this.last.at = madd(hip, spine, B.torso * s * 0.6)
  }
}
