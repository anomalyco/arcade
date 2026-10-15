import { type Avatar, type Body, animate, newAvatar } from "@arcade/kit/avatar/anim"
import { poseArms } from "@arcade/kit/human-pose"
import { type Frame, type V3, RIG, at, cross, ik, lerp3, limb, moved, norm, pitch, roll, sub, yawFrame } from "@arcade/kit/rig"
import { wrapDelta } from "../../shared/arena"
import { MAX_ARROWS } from "../../shared/config"
import { type Archer, type ArrowKind, HH } from "../../shared/world"

/** Rig metres to tiles: archers are drawn a little taller than their 1.2-tile hit box so they read at arena scale. */
export const RIG_SCALE = 0.8
const S = RIG_SCALE

export type ArcherModels = {
  pelvis: number; torso: number; head: number; upperArm: number; foreArm: number; thigh: number; shin: number; foot: number; toe: number
}

/** Writes one instance: model, frame (in world tiles), tint, emissive add, colour retention, hit flash. */
export type Push = (model: number, f: Frame, scale: number, tint: readonly [number, number, number], emissive?: number, keep?: number, flash?: number) => void

const SCARF_N = 8
const SCARF_SEG = 0.115

const smooth = (u: number) => u * u * (3 - 2 * u)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

function blendFrame(a: Frame, b: Frame, k: number): Frame {
  if (k <= 0) return a
  if (k >= 1) return b
  const x = norm(lerp3(a.x, b.x, k))
  let y = lerp3(a.y, b.y, k)
  const d = x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
  y = norm([y[0] - x[0] * d, y[1] - x[1] * d, y[2] - x[2] * d])
  return { p: lerp3(a.p, b.p, k), x, y, z: cross(x, y) }
}

function blendBody(a: Body, b: Body, k: number): Body {
  if (k <= 0.001) return a
  if (k >= 0.999) return b
  const pair = (p: [Frame, Frame], q: [Frame, Frame]): [Frame, Frame] => [blendFrame(p[0], q[0], k), blendFrame(p[1], q[1], k)]
  return {
    pelvis: blendFrame(a.pelvis, b.pelvis, k), torso: blendFrame(a.torso, b.torso, k), head: blendFrame(a.head, b.head, k),
    ua: pair(a.ua, b.ua), fa: pair(a.fa, b.fa), th: pair(a.th, b.th), sh: pair(a.sh, b.sh), ft: pair(a.ft, b.ft),
    toe: a.toe && b.toe ? pair(a.toe, b.toe) : undefined, gun: null, pump: null, mag: null,
  }
}

type Pose = {
  pelvis: V3
  pelvisPitch: number
  torsoPitch: number
  headPitch: number
  footL: V3
  footR: V3
  footPitch: [number, number]
  handL: V3
  handR: V3
  roll?: number
}

/** A posed body from game-owned targets in local rig space: IK legs to the feet, IK arms to the hands. */
function buildBody(yaw: number, p: Pose): Body {
  let pelvis = yawFrame(p.pelvis, yaw)
  if (p.roll) pelvis = pitch(pelvis, p.roll)
  pelvis = pitch(pelvis, p.pelvisPitch)
  let torso = pitch(moved(pelvis, at(pelvis, 0, RIG.waist, 0)), p.torsoPitch)
  torso = roll(torso, 0)
  const head = pitch(moved(torso, at(torso, 0.02, RIG.neckY, 0)), p.headPitch)
  const th: Frame[] = [], sh: Frame[] = [], ft: Frame[] = [], toe: Frame[] = []
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1
    const hip = at(pelvis, 0, 0, side * RIG.hipW)
    const target = i === 0 ? p.footL : p.footR
    const ankle: V3 = [target[0], target[1] + RIG.ankle, target[2]]
    const pole = sub(at(pelvis, 1, 0.15, side * 0.2), pelvis.p)
    const [knee, ank] = ik(hip, ankle, RIG.thigh, RIG.shin, pole)
    th.push(limb(hip, knee, pole, pelvis.x))
    sh.push(limb(knee, ank, pole, pelvis.x))
    const f = pitch(yawFrame(ank, yaw), p.footPitch[i]! + (p.roll ?? 0))
    ft.push(f)
    toe.push(moved(f, at(f, RIG.foot, -RIG.ankle, 0)))
  }
  const { ua, fa } = poseArms(torso, p.handL, p.handR)
  return { pelvis, torso, head, ua, fa, th: [th[0]!, th[1]!], sh: [sh[0]!, sh[1]!], ft: [ft[0]!, ft[1]!], toe: [toe[0]!, toe[1]!], gun: null, pump: null, mag: null }
}

/**
 * One archer on screen. Ground locomotion is the shared rig's `animate()` (unarmed, in a private rig-space lane so
 * its feet plant on a flat floor); jumps, falls, wall slides, ledge hangs and dodges are posed here with the rig's
 * IK and blended in, and the bow arms are layered over everything. Also owns the scarf (a verlet ribbon), the bow
 * string and the nocked arrow.
 */
export class ArcherView {
  readonly avatar: Avatar
  /** Unwrapped plane x, so wrapping across the arena edge doesn't teleport the rig. */
  ux = 0
  x = 0
  y = 0
  face: 1 | -1 = 1
  air = 0
  drawK = 0
  aimX = 1
  aimY = 0
  looseAt = -9
  landAt = -9
  landV = 0
  flash = 0
  body: Body | null = null
  /** World (tile) frames of the last pose. */
  world: Body | null = null
  bow: Frame | null = null
  stringTop: V3 = [0, 0, 0]
  stringBot: V3 = [0, 0, 0]
  nock: V3 = [0, 0, 0]
  scarf: V3[] = []
  private scarfPrev: V3[] = []
  private spin = 0
  private t = 0
  private dead = false
  private deadVx = 0
  private deadVy = 0
  private deadSpin = 0
  private deadRot = 0
  private deadX = 0
  private deadY = 0

  constructor(readonly id: string, x: number, y: number) {
    this.avatar = newAvatar(id, x / S, 0, 0, "rifle")
    this.avatar.unarmed = true
    this.ux = this.x = x
    this.y = y
  }

  /**
   * Advances the pose. (x, y) are the archer's interpolated feet; `a` is the sim state for state flags. Returns the
   * kit animation cues (footsteps).
   */
  update(a: Archer, x: number, y: number, dt: number, now: number, arenaW: number): number {
    this.t += dt
    const dx = wrapDelta(x - this.x, arenaW)
    this.ux += dx
    this.x = x
    this.y = y
    if (!a.alive) return this.updateDead(a, dt)
    this.dead = false
    if (a.face !== this.face) this.face = a.face
    const yaw = this.face > 0 ? 0 : Math.PI
    const grounded = a.ground && a.dodge <= 0
    this.air += ((grounded ? 0 : 1) - this.air) * Math.min(1, dt * (grounded ? 22 : 16))
    const drawing = a.drawing
    this.drawK += ((drawing ? 1 : 0) - this.drawK) * Math.min(1, dt * (drawing ? 16 : 10))
    if (drawing || this.drawK > 0.2) {
      this.aimX = a.aimX
      this.aimY = a.aimY
    }
    this.flash *= Math.exp(-dt * 18)

    // Ground: the shared locomotion, fed true plane speed so the feet stay planted.
    const lx = this.ux / S
    const ev = animate(this.avatar, dt, now, lx, 0, grounded ? a.vx / S : 0, 0, yaw)
    let body = this.avatar.body!
    // Landing squash: the pelvis dips and springs back.
    const sinceLand = now - this.landAt
    if (sinceLand < 0.25 && grounded) {
      const k = Math.sin(Math.PI * clamp01(sinceLand / 0.25)) * Math.min(1, this.landV / 18) * 0.16
      body = this.dip(body, k)
    }
    if (this.air > 0.01) body = blendBody(body, this.airPose(a, lx, yaw, dt), smooth(clamp01(this.air)))
    else this.spin = 0
    body = this.bowArms(body, a, yaw)
    this.body = body
    this.world = this.toWorld(body, lx)
    this.placeBow(a, yaw)
    this.stepScarf(dt, a)
    return ev
  }

  private dip(b: Body, k: number): Body {
    const down = (f: Frame): Frame => moved(f, [f.p[0], f.p[1] - k, f.p[2]])
    const pelvis = down(b.pelvis), torso = down(b.torso), head = down(b.head)
    const legs = this.reLeg(pelvis, b)
    return { ...b, pelvis, torso, head, ua: [down(b.ua[0]), down(b.ua[1])], fa: [down(b.fa[0]), down(b.fa[1])], ...legs }
  }

  /** Re-solves the legs from a moved pelvis to the same feet. */
  private reLeg(pelvis: Frame, b: Body): Pick<Body, "th" | "sh"> {
    const th: Frame[] = [], sh: Frame[] = []
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1
      const hip = at(pelvis, 0, 0, side * RIG.hipW)
      const ankle = b.ft[i]!.p
      const pole = sub(at(pelvis, 1, 0.1, side * 0.2), pelvis.p)
      const [knee, ank] = ik(hip, ankle, RIG.thigh, RIG.shin, pole)
      th.push(limb(hip, knee, pole, pelvis.x))
      sh.push(limb(knee, ank, pole, pelvis.x))
    }
    return { th: [th[0]!, th[1]!], sh: [sh[0]!, sh[1]!] }
  }

  /** Airborne, wall, ledge and dodge poses in local rig space (feet origin at (lx, 0, 0)). */
  private airPose(a: Archer, lx: number, yaw: number, dt: number): Body {
    const f = this.face
    const P = (x: number, y: number, z = 0): V3 => [lx + x * f, y, z]
    const vy = a.vy
    if (a.dodge > 0) {
      // A tight tucked somersault in the dodge direction (a flat dash on the ground).
      const dir = Math.sign(a.dodgeX || a.face)
      if (!a.ground) this.spin -= dt * 26 * dir
      const tuck: Pose = {
        pelvis: P(0, 0.62), pelvisPitch: -0.3, torsoPitch: -0.75, headPitch: -0.4,
        footL: P(0.2, 0.18, -0.1), footR: P(0.28, 0.24, 0.1), footPitch: [0.5, 0.5],
        handL: P(0.3, 0.55, -0.2), handR: P(0.35, 0.5, 0.2),
      }
      return this.spun(buildBody(yaw, tuck), P(0, 0.62))
    }
    if (a.hang) {
      // Hanging from the lip: arms up over the head, legs dangling against the wall.
      const lip = (HH * 0.82) / S
      const sway = Math.sin(this.t * 2.2) * 0.03
      return buildBody(yaw, {
        pelvis: P(-0.02 + sway, lip - 0.95), pelvisPitch: 0.05, torsoPitch: 0.05, headPitch: 0.25,
        footL: P(0.06 + sway, lip - 1.86, -0.1), footR: P(-0.06 + sway, lip - 1.82, 0.1), footPitch: [-0.5, -0.3],
        handL: P(0.2, lip + 0.02, -0.18), handR: P(0.2, lip + 0.02, 0.18),
      })
    }
    if (a.sliding) {
      // Wall slide: back to the drop, one hand and one foot dragging on the wall, the other arm out.
      const jit = Math.sin(this.t * 40) * 0.01
      return buildBody(yaw, {
        pelvis: P(-0.05, 0.86), pelvisPitch: -0.1, torsoPitch: 0.12, headPitch: 0.2,
        footL: P(0.2, 0.25 + jit, -0.1), footR: P(-0.12, 0.05, 0.12), footPitch: [-0.9, 0.2],
        handL: P(0.3, 1.5 + jit, -0.2), handR: P(-0.35, 1.05, 0.3),
      })
    }
    // Jump and fall: knees tuck on the way up, legs reach for the ground on the way down, arms balance.
    const up = clamp01(vy / 14)
    const down = clamp01(-vy / 14)
    const run = clamp01(Math.abs(a.vx) / 7)
    const t: Pose = {
      pelvis: P(0, 0.86 + 0.06 * up), pelvisPitch: -0.15 * run, torsoPitch: -0.12 * run - 0.08 * up + 0.1 * down, headPitch: 0.05 * up - 0.1 * down,
      footL: P(0.3 * up + 0.12 * down, 0.38 * up + 0.08 * down, -0.12), footR: P(-0.28 * up - 0.1 * down + 0.05, 0.12 * up + 0.02 * down, 0.12),
      footPitch: [0.4 * up - 0.3 * down, -0.6 * up - 0.2 * down],
      handL: P(0.2 + 0.1 * down, 1.15 + 0.35 * down + 0.1 * up, -0.38 - 0.1 * down),
      handR: P(-0.2 - 0.15 * down, 1.0 + 0.45 * down - 0.05 * up, 0.36 + 0.12 * down),
    }
    return buildBody(yaw, t)
  }

  /** Rotates the tucked body rigidly about its centre so the whole ball spins. */
  private spun(b: Body, c: V3): Body {
    const a = this.spin
    const ca = Math.cos(a), sa = Math.sin(a)
    const rp = (p: V3): V3 => {
      const x = p[0] - c[0], y = p[1] - c[1]
      return [c[0] + x * ca - y * sa, c[1] + x * sa + y * ca, p[2]]
    }
    const rv = (v: V3): V3 => [v[0] * ca - v[1] * sa, v[0] * sa + v[1] * ca, v[2]]
    const rf = (f: Frame): Frame => ({ p: rp(f.p), x: rv(f.x), y: rv(f.y), z: rv(f.z) })
    return {
      pelvis: rf(b.pelvis), torso: rf(b.torso), head: rf(b.head), ua: [rf(b.ua[0]), rf(b.ua[1])], fa: [rf(b.fa[0]), rf(b.fa[1])],
      th: [rf(b.th[0]), rf(b.th[1])], sh: [rf(b.sh[0]), rf(b.sh[1])], ft: [rf(b.ft[0]), rf(b.ft[1])],
      toe: b.toe ? [rf(b.toe[0]), rf(b.toe[1])] : undefined, gun: null, pump: null, mag: null,
    }
  }

  /** Bow arms: the bow arm straight out along the aim, the string hand pulling back to the cheek. */
  private bowArms(b: Body, a: Archer, yaw: number): Body {
    const k = smooth(clamp01(this.drawK))
    if (k < 0.01 || a.dodge > 0 || a.hang) return b
    const ax = this.aimX || this.face, ay = this.aimY
    const l = Math.hypot(ax, ay) || 1
    const d: V3 = [ax / l, ay / l, 0]
    // Aiming up leans the chest back, aiming down hunches it over.
    const torso0 = b.torso
    const lean = (-d[1] * 0.35) * k * this.face
    const torso = pitch(torso0, -lean * this.face * this.face)
    const sc = at(torso, 0, RIG.shoulderY, 0)
    const reach = 0.56
    const handL: V3 = [sc[0] + d[0] * reach, sc[1] + d[1] * reach, sc[2] - 0.06]
    const pull = reach - (0.16 + 0.42 * clamp01(a.drawT / 0.35))
    const handR: V3 = [sc[0] + d[0] * pull, sc[1] + d[1] * pull + 0.06, sc[2] + 0.06]
    const arms = poseArms(torso, handL, handR)
    const head = pitch(moved(b.head, at(torso, 0.02, RIG.neckY, 0)), d[1] * 0.5 * (this.face > 0 ? 1 : 1))
    void yaw
    if (k >= 0.99) return { ...b, torso, head, ...arms }
    return { ...b, torso: blendFrame(torso0, torso, k), head: blendFrame(b.head, head, k), ua: [blendFrame(b.ua[0], arms.ua[0], k), blendFrame(b.ua[1], arms.ua[1], k)], fa: [blendFrame(b.fa[0], arms.fa[0], k), blendFrame(b.fa[1], arms.fa[1], k)] }
  }

  private toWorld(b: Body, lx: number): Body {
    const ox = this.x, oy = this.y
    const tp = (p: V3): V3 => [(p[0] - lx) * S + ox, p[1] * S + oy, p[2] * S]
    const tf = (f: Frame): Frame => ({ p: tp(f.p), x: f.x, y: f.y, z: f.z })
    return {
      pelvis: tf(b.pelvis), torso: tf(b.torso), head: tf(b.head), ua: [tf(b.ua[0]), tf(b.ua[1])], fa: [tf(b.fa[0]), tf(b.fa[1])],
      th: [tf(b.th[0]), tf(b.th[1])], sh: [tf(b.sh[0]), tf(b.sh[1])], ft: [tf(b.ft[0]), tf(b.ft[1])],
      toe: b.toe ? [tf(b.toe[0]), tf(b.toe[1])] : undefined, gun: null, pump: null, mag: null,
    }
  }

  /** The bow in the left hand: carried tilted at the side, or held out square to the aim with the string drawn. */
  private placeBow(a: Archer, yaw: number): void {
    const w = this.world!
    const hand = at(w.fa[0], 0, -RIG.fore * S, 0)
    const k = smooth(clamp01(this.drawK))
    const ax = this.aimX || this.face, ay = this.aimY
    const l = Math.hypot(ax, ay) || 1
    const dAim: V3 = [ax / l, ay / l, 0]
    const dCarry: V3 = norm([this.face * 0.35, -0.15, 0])
    const d = k > 0 ? norm(lerp3(dCarry, dAim, k)) : dCarry
    // Bow frame: +x toward the archer (belly side), +y along the limbs, kept upright.
    const x: V3 = [-d[0], -d[1], 0]
    let y: V3 = d[0] * this.face >= 0 ? [-d[1] * this.face, d[0] * this.face, 0] : [d[1], -d[0], 0]
    if (y[1] < 0) y = [-y[0], -y[1], 0]
    const z = cross(x, y)
    const bow: Frame = { p: hand, x, y, z }
    this.bow = bow
    const half = 0.42 * S * 1.15
    this.stringTop = at(bow, 0.05 * S * 1.15, half, 0)
    this.stringBot = at(bow, 0.05 * S * 1.15, -half, 0)
    const rest = lerp3(this.stringTop, this.stringBot, 0.5)
    const drawHand = at(w.fa[1], 0, -RIG.fore * S, 0)
    this.nock = k > 0.05 && a.quiver.length ? lerp3(rest, drawHand, k) : rest
    void yaw
  }

  /** Scarf: a verlet chain hung from the back of the neck, dragged by motion and a little wind. */
  private stepScarf(dt: number, a: Archer): void {
    const w = this.world!
    const anchor = at(w.head, -0.1 * S, 0.02 * S, 0)
    if (this.scarf.length !== SCARF_N || Math.hypot(this.scarf[0]![0] - anchor[0], this.scarf[0]![1] - anchor[1]) > 2) {
      this.scarf = []
      this.scarfPrev = []
      for (let i = 0; i < SCARF_N; i++) {
        const p: V3 = [anchor[0] - this.face * i * SCARF_SEG, anchor[1] - i * 0.03, anchor[2] - 0.05]
        this.scarf.push(p)
        this.scarfPrev.push([...p])
      }
    }
    const h = Math.min(dt, 1 / 30)
    const g = -9, drag = 0.93
    const wind = 1.6 + Math.sin(this.t * 1.3 + this.x) * 0.8
    for (let i = 1; i < SCARF_N; i++) {
      const p = this.scarf[i]!, q = this.scarfPrev[i]!
      const flutter = Math.sin(this.t * 13 + i * 0.9) * 0.6 * (0.3 + clamp01(Math.abs(a.vx) / 7))
      const vx = (p[0] - q[0]) * drag, vy = (p[1] - q[1]) * drag
      q[0] = p[0]
      q[1] = p[1]
      p[0] += vx + wind * h * h
      p[1] += vy + g * h * h + flutter * h * h * 20
    }
    this.scarf[0] = anchor
    this.scarfPrev[0] = anchor
    for (let it = 0; it < 4; it++) {
      for (let i = 1; i < SCARF_N; i++) {
        const p = this.scarf[i - 1]!, q = this.scarf[i]!
        const ddx = q[0] - p[0], ddy = q[1] - p[1]
        const d = Math.hypot(ddx, ddy) || 1e-4
        const seg = SCARF_SEG * (1 - i * 0.03)
        const k = (d - seg) / d
        if (i === 1) {
          q[0] -= ddx * k
          q[1] -= ddy * k
        } else {
          p[0] += ddx * k * 0.5
          p[1] += ddy * k * 0.5
          q[0] -= ddx * k * 0.5
          q[1] -= ddy * k * 0.5
        }
      }
      this.scarf[0] = anchor
    }
    for (let i = 1; i < SCARF_N; i++) this.scarf[i]![2] = anchor[2] - 0.04 - i * 0.01
  }

  /** Death: the last pose flies off along the hit and tumbles, then lies where it lands. */
  private updateDead(a: Archer, dt: number): number {
    this.flash *= Math.exp(-dt * 14)
    if (!this.world) return 0
    if (!this.dead) {
      this.dead = true
      this.deadX = 0
      this.deadY = 0
      this.deadRot = 0
    }
    this.deadVy -= 30 * dt
    this.deadX += this.deadVx * dt
    this.deadY = Math.max(this.deadY + this.deadVy * dt, -0.6 - (a.y - Math.floor(a.y)))
    if (this.deadY <= -0.6) {
      this.deadVx *= 0.8
      this.deadSpin *= 0.8
    }
    this.deadRot += this.deadSpin * dt
    return 0
  }

  /** Called on the kill event with the hit direction. */
  kill(dx: number, dy: number): void {
    this.deadVx = dx * 7
    this.deadVy = 5 + Math.max(0, dy) * 4
    this.deadSpin = (dx >= 0 ? -1 : 1) * 9
    this.flash = 0.6
    this.dead = false
  }

  /** The dead body's frames: the last living pose, thrown and rolled. */
  deadWorld(): Body | null {
    const w = this.world
    if (!w) return null
    const c = w.pelvis.p
    const a = this.deadRot
    const ca = Math.cos(a), sa = Math.sin(a)
    const ox = this.deadX, oy = this.deadY
    const rp = (p: V3): V3 => {
      const x = p[0] - c[0], y = p[1] - c[1]
      return [c[0] + ox + x * ca - y * sa, c[1] + oy + x * sa + y * ca, p[2]]
    }
    const rv = (v: V3): V3 => [v[0] * ca - v[1] * sa, v[0] * sa + v[1] * ca, v[2]]
    const rf = (f: Frame): Frame => ({ p: rp(f.p), x: rv(f.x), y: rv(f.y), z: rv(f.z) })
    return {
      pelvis: rf(w.pelvis), torso: rf(w.torso), head: rf(w.head), ua: [rf(w.ua[0]), rf(w.ua[1])], fa: [rf(w.fa[0]), rf(w.fa[1])],
      th: [rf(w.th[0]), rf(w.th[1])], sh: [rf(w.sh[0]), rf(w.sh[1])], ft: [rf(w.ft[0]), rf(w.ft[1])],
      toe: w.toe ? [rf(w.toe[0]), rf(w.toe[1])] : undefined, gun: null, pump: null, mag: null,
    }
  }

  get isDead(): boolean {
    return this.dead
  }
}

/** Pushes a posed body's parts. */
export function pushBody(push: Push, b: Body, m: ArcherModels, tint: readonly [number, number, number], flash: number, ember: number): void {
  push(m.pelvis, b.pelvis, S, tint, 0, 0, flash)
  push(m.torso, b.torso, S, tint, ember, 0.9, flash)
  push(m.head, b.head, S, tint, 0, 0, flash)
  for (let i = 0; i < 2; i++) {
    push(m.upperArm, b.ua[i]!, S, tint, 0, 0, flash)
    push(m.foreArm, b.fa[i]!, S, tint, 0, 0, flash)
    push(m.thigh, b.th[i]!, S, tint, 0, 0, flash)
    push(m.shin, b.sh[i]!, S, tint, 0, 0, flash)
    push(m.foot, b.ft[i]!, S, tint, 0, 0, flash)
    if (b.toe) push(m.toe, b.toe[i]!, S, tint, 0, 0, flash)
  }
}

export const quiverFill = (a: Archer) => a.quiver.length / MAX_ARROWS
export type { ArrowKind }
