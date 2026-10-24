// TIMBER's people: Microsoft Rocketbox avatars (MIT, `docs/people.md`) on the kit's people rig, as in BARBARA. The
// lumberjack is big, in a dark red work jacket, both hands on the saw; survivors are campers with a torch in the right
// hand and the axe in the left. The downed and the dead are the game's ragdolls posed onto the person. The blocky rig
// draws anyone whose person is still loading, and everyone with Realistic people off.
import { animate, type Avatar, newAvatar } from "@arcade/kit/avatar/anim"
import { ragdollBody, type Ragdoll } from "@arcade/kit/avatar/ragdoll"
import { batchHooks } from "@arcade/kit/forest/shaders"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { HumanBody } from "@arcade/kit/human-pose"
import { CAST } from "@arcade/kit/people/cast/rocketbox.gen"
import { type HandPose, posePerson, skinMatrices } from "@arcade/kit/people/retarget"
import { People, type CastMember, type Person } from "@arcade/kit/people/view"
import type { Frame, V3 } from "@arcade/kit/rig"
import type { Jack } from "../shared/sim"
import { type SawFrame, type SawHand, turn } from "./viewmodel"

/** Rocketbox members by role: the lumberjack wears m04's dark zip jacket, recoloured; survivors take the rest. */
const JACK = CAST.find((m) => m.person === "m04") ?? CAST[0]!
const CAMPERS = CAST.filter((m) => m !== JACK)
/** His jacket: a dark oxblood work jacket; trousers darker. Linear albedo. */
const JACKET: [number, number, number] = [0.13, 0.018, 0.012]
const TROUSERS: [number, number, number] = [0.03, 0.03, 0.028]
const isTop = (piece: string) => /jacket|coat|top|shirt|hood|vest|cardigan|sweat/i.test(piece)
const isBottom = (piece: string) => /trouser|pant|jean/i.test(piece)

/** Two hands on a chainsaw held at the hip, torso-local (x forward, y up, z right): rear handle, wrap handle. */
const SAW_HANDS = { r: [0.3, 0.02, 0.17] as V3, l: [0.46, 0.17, -0.02] as V3 }

/**
 * First person: where his shoulders (their midpoint) sit in eye space for the arms on the saw. Lower and further
 * forward than a real body's, as in any first-person view, so the hands reach handles held up in the frame while the
 * chest stays below it; the head and neck fold away.
 */
const ARMS_SHOULDER: V3 = [0.08, -0.36, 0]
/** The handle sits this far from the wrist along the knuckles, and this far off the palm (m, at his size). */
const GRIP_IN = 0.1
const GRIP_OFF = 0.03
/** A tight fist round a saw handle (degrees, as the kit's `TORCH_GRIP`). */
const SAW_GRIP: HandPose = { index: [72, 90, 48], middle: [78, 94, 50], ring: [80, 94, 50], pinky: [84, 94, 50], thumbOppose: 60, thumbAlong: -40, thumb: [20, 30, 38], together: 2 }
/** Leather work gloves and a dark oxblood sleeve: multipliers on the Rocketbox hands and outfit textures. */
const GLOVES: V3 = [0.5, 0.3, 0.16]
const SLEEVES: V3 = [0.6, 0.1, 0.08]

const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
const unit = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1
  return [v[0]! / l, v[1]! / l, v[2]! / l]
}
/** An orthonormal frame (columns) from a main axis and a second one, made square to it. */
function basis(a: readonly number[], b: readonly number[]): [V3, V3, V3] {
  const x = unit(a)
  const d = b[0]! * x[0] + b[1]! * x[1] + b[2]! * x[2]
  const y = unit([b[0]! - x[0] * d, b[1]! - x[1] * d, b[2]! - x[2] * d])
  return [x, y, cross(x, y)]
}

/** Scales every frame's position in a body by `s` (world ↔ rig space). */
function scaleBody(b: HumanBody, s: number): HumanBody {
  const f = (fr: Frame): Frame => ({ ...fr, p: [fr.p[0] * s, fr.p[1] * s, fr.p[2] * s] })
  const pair = (p: [Frame, Frame]): [Frame, Frame] => [f(p[0]), f(p[1])]
  return { pelvis: f(b.pelvis), torso: f(b.torso), head: f(b.head), ua: pair(b.ua), fa: pair(b.fa), th: pair(b.th), sh: pair(b.sh), ft: pair(b.ft), ...(b.toe ? { toe: pair(b.toe) } : {}) }
}

/** Scales a person's skinning matrices by `k` about the floor under (x, z), after skinning: a bigger man. */
function grow(m: Float32Array, k: number, x: number, z: number): void {
  if (k === 1) return
  const o = [x, 0, z]
  for (let i = 0; i < m.length; i += 16) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) m[i + c * 4 + r]! *= k
    for (let r = 0; r < 3; r++) m[i + 12 + r]! += (1 - k) * o[r]!
  }
}

export type Held = { saw?: { p: V3; aim: number }; axe?: { p: V3 }; torch?: Frame }

export class TimberPeople {
  readonly people: People
  private avatars = new Map<number, Avatar>()
  private persons = new Map<number, Person>()
  private cast = new Map<number, CastMember>()
  /** First person: his own arms on the saw, a person of their own, posed standing at the origin facing +x. */
  private armsPerson: Person | null = null
  private armsAvatar: Avatar | null = null
  private armsAnchor: V3 | null = null
  private armsFolded: number[] = []
  private armsHands: number[][] = []
  private armsLit = -1
  /** What the arm solve misses each wrist by (the rig's arm isn't the mesh's), fed back into its target. */
  private armsCorr: [V3, V3] = [[0, 0, 0], [0, 0, 0]]

  constructor(renderer: Renderer) {
    this.people = new People(renderer.passContext, batchHooks)
    renderer.addPass("opaque", this.people.pass)
  }

  private member(j: Jack): CastMember {
    let m = this.cast.get(j.id)
    if (!m || (j.role === "lumberjack") !== (m === JACK)) {
      m = j.role === "lumberjack" ? JACK : CAMPERS[j.id % CAMPERS.length]!
      this.cast.set(j.id, m)
      const old = this.persons.get(j.id)
      if (old) {
        this.people.remove(old)
        this.persons.delete(j.id)
        this.avatars.delete(j.id)
      }
      const mm = m
      this.people.load(mm).catch((e) => console.error(`people: ${mm.id} failed to load`, e))
    }
    return m
  }

  /** Fetches every member TIMBER uses; resolves when they can be drawn (never rejects). */
  preload(): Promise<void> {
    return Promise.all([JACK, ...CAMPERS].map((m) => this.people.load(m).catch(() => {}))).then(() => {})
  }

  private person(j: Jack, aim: number): { person: Person; a: Avatar; s: number } | null {
    const m = this.member(j)
    const s = this.people.scale(m)
    if (s === null) return null
    let a = this.avatars.get(j.id)
    let person = this.persons.get(j.id)
    if (!a || !person) {
      a = newAvatar(`person-${j.id}`, j.x / s, j.y / s, aim, "rifle")
      person = this.people.spawn(m)!
      if (j.role === "lumberjack")
        for (const mat of person.inst.model.asset.materials) {
          if (isTop(mat.piece)) person.inst.tint(mat.piece, JACKET)
          else if (isBottom(mat.piece)) person.inst.tint(mat.piece, TROUSERS)
        }
      this.avatars.set(j.id, a)
      this.persons.set(j.id, person)
    }
    return { person, a, s }
  }

  /**
   * Poses `j` standing and moving, or returns null while their person loads (draw them blocky). `hidden` keeps them
   * out of the frame (you, in first person) while still posing them. Returns where the held things go.
   */
  stand(j: Jack, o: { dt: number; t: number; scale: number; torchDir: V3 | null; chop: number; cutting: boolean; eye: V3; hidden: boolean; lift: number }): Held | null {
    const got = this.person(j, j.aim)
    if (!got) return null
    const { person, a, s } = got
    const lj = j.role === "lumberjack"
    if (lj) a.reach = { ...SAW_HANDS, k: 1 }
    else if (o.chop > 0) {
      // Both hands on the axe and a swing at the trunk.
      const sw = Math.sin(o.chop * Math.PI * 2)
      a.reach = { l: [0.35 + sw * 0.12, 0.3 + sw * 0.25, 0.05], r: [0.32 + sw * 0.12, 0.22 + sw * 0.25, 0.12], k: 1 }
    } else a.reach = undefined
    animate(a, o.dt, o.t, j.x / s, j.y / s, j.vx / s, j.vy / s, j.aim)
    const torch = this.people.drive(person, a, {
      dt: o.dt, time: o.t, rise: o.lift, eye: o.eye, look: { yaw: 0, pitch: o.cutting ? -0.35 : 0 },
      ...(o.torchDir && o.chop <= 0 ? { torch: { side: 1 as const, dir: o.torchDir } } : {}),
    })
    if (lj) grow(person.inst.matrices, o.scale, j.x, j.y)
    person.inst.visible = !o.hidden
    const handR = this.hand(person, 1, lj ? o.scale : 1, j)
    const handL = this.hand(person, 0, lj ? o.scale : 1, j)
    if (lj) return { saw: { p: handR, aim: j.aim } }
    return { axe: { p: handL }, ...(torch ? { torch } : {}) }
  }

  private hand(person: Person, side: 0 | 1, k: number, j: Jack): V3 {
    const p = person.pose.pos[person.rest.arms[side]!.end]!
    return [j.x + (p[0] - j.x) * k, p[1] * k, j.y + (p[2] - j.y) * k]
  }

  /** Poses `j` from their ragdoll (downed or dead), world space, the head raised by `look` (rad). False while their
   * person loads. */
  lie(j: Jack, rd: Ragdoll, dt: number, scale: number, eye: V3, look = 0): boolean {
    const got = this.person(j, j.aim)
    if (!got) return false
    const { person, s } = got
    const body = scaleBody(ragdollBody(rd, 0, "rifle"), 1 / s)
    posePerson(person.rest, { body, lift: 0, dt, look: { yaw: 0, pitch: look } }, person.pose)
    skinMatrices(person.rest, person.pose, person.inst.matrices)
    if (j.role === "lumberjack") grow(person.inst.matrices, scale, j.x, j.y)
    person.inst.lod = 0
    person.inst.visible = true
    void eye
    return true
  }

  /**
   * His arms on the first-person saw: hands on its grips (eye space) and everything placed by the saw's frame, so the
   * arms move with the saw. Null hides them. False while the person loads (draw the gloves).
   */
  arms(o: { frame: SawFrame; hands: { l: SawHand; r: SawHand }; scale: number; lit: number; dt: number; t: number } | null): boolean {
    if (!o) {
      if (this.armsPerson) this.armsPerson.inst.visible = false
      return false
    }
    const s = this.people.scale(JACK)
    if (s === null) return false
    if (!this.armsPerson) {
      const p = this.people.spawn(JACK)
      if (!p) return false
      const { parent } = p.rest.skeleton
      const under = (root: number) => parent.map((_, i) => i).filter((i) => {
        for (let q = i; q >= 0; q = parent[q]!) if (q === root) return true
        return false
      })
      this.armsFolded = under(p.rest.idx.neck_01 ?? p.rest.idx.head!)
      this.armsHands = [under(p.rest.arms[0]!.end), under(p.rest.arms[1]!.end)]
      this.armsLit = -1
      this.armsPerson = p
      this.armsAvatar = newAvatar("arms", 0, 0, 0, "rifle")
    }
    const p = this.armsPerson
    const a = this.armsAvatar!
    // Dimmed like the saw: half a metre under the helmet lamp they would blow out.
    if (o.lit !== this.armsLit) {
      this.armsLit = o.lit
      for (const mat of p.inst.model.asset.materials) {
        const c = mat.piece === "hands" ? GLOVES : isTop(mat.piece) || mat.piece === "outfit" ? SLEEVES : null
        if (c) p.inst.tint(mat.piece, [c[0] * o.lit, c[1] * o.lit, c[2] * o.lit])
      }
    }
    /** Where the wrist goes for a hand: back from the handle along the knuckles and off it on the palm's side. */
    const wristOf = (h: SawHand): V3 => [0, 1, 2].map((i) => h.p[i]! - h.dir[i]! * GRIP_IN * k - h.palm[i]! * GRIP_OFF * k) as V3
    const k = o.scale
    const anchor = this.armsAnchor
    // Eye space to the standing body's world, and back.
    const toBody = (q: V3): V3 => [anchor![0] + (q[0] - ARMS_SHOULDER[0]) / k, anchor![1] + (q[1] - ARMS_SHOULDER[1]) / k, anchor![2] + (q[2] - ARMS_SHOULDER[2]) / k]
    const toEye = (c: V3): V3 => [ARMS_SHOULDER[0] + (c[0] - anchor![0]) * k, ARMS_SHOULDER[1] + (c[1] - anchor![1]) * k, ARMS_SHOULDER[2] + (c[2] - anchor![2]) * k]
    if (anchor && a.body) {
      const t = a.body.torso
      const reach = (h: SawHand, side: 0 | 1): V3 => {
        const want = wristOf(h), e = this.armsCorr[side]
        const c = toBody([want[0] + e[0], want[1] + e[1], want[2] + e[2]])
        const r: V3 = [c[0] / s - t.p[0], c[1] / s - t.p[1], c[2] / s - t.p[2]]
        const dot = (v: V3) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]
        return [dot(t.x), dot(t.y), dot(t.z)]
      }
      a.reach = { l: reach(o.hands.l, 0), r: reach(o.hands.r, 1), k: 1 }
    }
    animate(a, o.dt, o.t, 0, 0, 0, 0, 0)
    if (!a.body) return false
    posePerson(p.rest, { body: a.body, lift: 0, dt: o.dt, look: { yaw: 0, pitch: 0 }, grip: [SAW_GRIP, SAW_GRIP] }, p.pose)
    skinMatrices(p.rest, p.pose, p.inst.matrices)
    const pos = p.pose.pos
    if (!anchor) {
      const l = pos[p.rest.arms[0]!.upper]!, r = pos[p.rest.arms[1]!.upper]!
      this.armsAnchor = [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2, (l[2] + r[2]) / 2]
      p.inst.visible = false
      return false
    }
    for (const side of [0, 1] as const) {
      const want = wristOf(side === 0 ? o.hands.l : o.hands.r), got = toEye(pos[p.rest.arms[side]!.end]!), e = this.armsCorr[side]
      for (let i = 0; i < 3; i++) e[i] = Math.max(-0.15, Math.min(0.15, e[i]! + (want[i]! - got[i]!) * 0.5))
    }
    const m = p.inst.matrices
    // Each hand turned round its wrist to close on its handle: knuckles along `dir`, index to little finger as the
    // palm's side gives (mirrored left and right).
    for (const side of [0, 1] as const) {
      const h = side === 0 ? o.hands.l : o.hands.r
      const sfx = side === 0 ? "l" : "r"
      const ix = p.rest.idx
      const knuckle = ix[`middle_01_${sfx}`], index = ix[`index_01_${sfx}`], pinky = ix[`pinky_01_${sfx}`]
      if (knuckle === undefined || index === undefined || pinky === undefined) continue
      const w = pos[p.rest.arms[side]!.end]!
      const C = basis([pos[knuckle]![0] - w[0], pos[knuckle]![1] - w[1], pos[knuckle]![2] - w[2]], [pos[index]![0] - pos[pinky]![0], pos[index]![1] - pos[pinky]![1], pos[index]![2] - pos[pinky]![2]])
      const D = basis(h.dir, side === 0 ? cross(h.palm, h.dir) : cross(h.dir, h.palm))
      // R = D Cᵀ, row r column c.
      const R = [0, 1, 2].map((r) => [0, 1, 2].map((c) => D[0][r]! * C[0][c]! + D[1][r]! * C[1][c]! + D[2][r]! * C[2][c]!))
      const rot = (v: readonly number[]) => [0, 1, 2].map((r) => R[r]![0]! * v[0]! + R[r]![1]! * v[1]! + R[r]![2]! * v[2]!)
      for (const i of this.armsHands[side]!) {
        for (let c = 0; c < 3; c++) {
          const v = rot([m[i * 16 + c * 4]!, m[i * 16 + c * 4 + 1]!, m[i * 16 + c * 4 + 2]!])
          for (let r = 0; r < 3; r++) m[i * 16 + c * 4 + r] = v[r]!
        }
        const t = rot([m[i * 16 + 12]! - w[0], m[i * 16 + 13]! - w[1], m[i * 16 + 14]! - w[2]])
        for (let r = 0; r < 3; r++) m[i * 16 + 12 + r] = t[r]! + w[r]!
      }
    }
    // The head and neck fold to a point at the neck, out of the frame.
    const neck = pos[this.armsFolded[0]!]!
    for (const i of this.armsFolded) {
      m.fill(0, i * 16, i * 16 + 12)
      m[i * 16 + 12] = neck[0]
      m[i * 16 + 13] = neck[1]
      m[i * 16 + 14] = neck[2]
      m[i * 16 + 15] = 1
    }
    // Into the world: eye space by the shoulders' anchor and his size, then the saw's frame.
    const f = o.frame
    const ax = turn([1, 0, 0], f.yaw, f.pitch, f.roll), ay = turn([0, 1, 0], f.yaw, f.pitch, f.roll), az = turn([0, 0, 1], f.yaw, f.pitch, f.roll)
    const R = [ax, ay, az]
    for (let i = 0; i < m.length; i += 16) {
      for (let c = 0; c < 3; c++) {
        const v = [m[i + c * 4]! * k, m[i + c * 4 + 1]! * k, m[i + c * 4 + 2]! * k]
        for (let r = 0; r < 3; r++) m[i + c * 4 + r] = R[0]![r]! * v[0]! + R[1]![r]! * v[1]! + R[2]![r]! * v[2]!
      }
      const q = toEye([m[i + 12]!, m[i + 13]!, m[i + 14]!])
      for (let r = 0; r < 3; r++) m[i + 12 + r] = f.at[r]! + R[0]![r]! * q[0] + R[1]![r]! * q[1] + R[2]![r]! * q[2]
    }
    p.inst.lod = 0
    p.inst.visible = true
    return true
  }

  /** Hides everyone not drawn this frame. */
  hideExcept(ids: Set<number>): void {
    for (const [id, p] of this.persons) if (!ids.has(id)) p.inst.visible = false
  }

  reset(): void {
    for (const p of this.persons.values()) this.people.remove(p)
    if (this.armsPerson) this.people.remove(this.armsPerson)
    this.armsPerson = this.armsAvatar = this.armsAnchor = null
    this.armsCorr = [[0, 0, 0], [0, 0, 0]]
    this.persons.clear()
    this.avatars.clear()
    this.cast.clear()
  }
}
