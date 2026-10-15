import type { Gun } from "./gun"
import type { Rect } from "../sim/geom"
import { Rng, seedOf } from "../sim/rng"
import { GUNPTS } from "./soldier"
import { type Body, type PartModels, type PushPart, emitBody } from "./anim"
import { bodyJoints } from "./anim-pose"
import type { BoneId, HiddenBones } from "../human-pose"
import { type Frame, type V3, add, aimFrame, at, cross, dot, len, limb, madd, moved, norm, roll, scale, sub } from "../rig"

/**
 * Verlet ragdoll for deaths: points at the joints, a rigid torso block (hips, shoulders, backpack, chest, head),
 * jointed limbs and the dropped gun, with floor friction and wall collisions. It starts from the soldier's exact pose
 * at the moment of death and takes the killing shot's impulse.
 */
const enum P {
  hipL,
  hipR,
  shL,
  shR,
  back,
  chest,
  head,
  kneeL,
  kneeR,
  ankL,
  ankR,
  elbL,
  elbR,
  handL,
  handR,
  grip,
  muzzle,
}
const N = 17
const RADIUS = [0.1, 0.1, 0.09, 0.09, 0.1, 0.06, 0.16, 0.07, 0.07, 0.07, 0.07, 0.06, 0.06, 0.05, 0.05, 0.04, 0.035]
const RIGID = [P.hipL, P.hipR, P.shL, P.shR, P.back, P.chest, P.head]
const GRAVITY = 17
const SUB = 1 / 120

type Local = { p: V3; x: V3; y: V3; z: V3 }
type Con = { a: number; b: number; d: number; min: boolean }

export type Ragdoll = {
  hiddenBones: Set<BoneId>
  pos: V3[]
  prev: V3[]
  cons: Con[]
  attach: { pelvis: Local; torso: Local; head: Local }
  limbs: { ua: Local[]; fa: Local[]; th: Local[]; sh: Local[]; ft: Local[]; gun: Local }
  gunRoll: number
  gunSpin: number
  rects: Rect[]
  acc: number
  still: number
  age: number
}

/** How a death plays: the shot's push, a twist, and whether the knees give way first. */
export type DeathStyle = { push: number; lift: number; spin: number; buckle: number }

function tri(p: V3[]): Frame {
  const a = p[P.shL]!
  const x = norm(sub(p[P.shR]!, a))
  const c = sub(p[P.hipL]!, a)
  const y = norm(madd(c, x, -dot(c, x)))
  return { p: a, x, y, z: cross(x, y) }
}

function toLocal(t: Frame, f: Frame): Local {
  const loc = (v: V3): V3 => [dot(v, t.x), dot(v, t.y), dot(v, t.z)]
  return { p: loc(sub(f.p, t.p)), x: loc(f.x), y: loc(f.y), z: loc(f.z) }
}

function fromLocal(t: Frame, l: Local): Frame {
  const w = (v: V3): V3 => add(add(scale(t.x, v[0]), scale(t.y, v[1])), scale(t.z, v[2]))
  return { p: add(t.p, w(l.p)), x: w(l.x), y: w(l.y), z: w(l.z) }
}

export function ragdoll(b: Body, gun: Gun, vx: number, vy: number, dx: number, dy: number, style: DeathStyle, solids: readonly Rect[], hidden?: HiddenBones): Ragdoll {
  const rng = new Rng(seedOf(`${gun}:${b.pelvis.p.join(",")}:${dx}:${dy}`))
  const g = b.gun ?? moved(b.torso, at(b.torso, 0.3, 0.2, 0))
  // Own these points: the Verlet solver must not mutate the last living pose.
  const pos = bodyJoints(b, gun).map((p): V3 => [...p])
  const bind = (a: P, c: P, f: Frame, ref: Frame) => toLocal(limb(pos[a]!, pos[c]!, ref.x, ref.y), f)
  const limbs = {
    ua: [bind(P.shL, P.elbL, b.ua[0], b.torso), bind(P.shR, P.elbR, b.ua[1], b.torso)],
    fa: [bind(P.elbL, P.handL, b.fa[0], b.torso), bind(P.elbR, P.handR, b.fa[1], b.torso)],
    th: [bind(P.hipL, P.kneeL, b.th[0], b.pelvis), bind(P.hipR, P.kneeR, b.th[1], b.pelvis)],
    sh: [bind(P.kneeL, P.ankL, b.sh[0], b.pelvis), bind(P.kneeR, P.ankR, b.sh[1], b.pelvis)],
    ft: [bind(P.kneeL, P.ankL, b.ft[0], b.pelvis), bind(P.kneeR, P.ankR, b.ft[1], b.pelvis)],
    gun: toLocal(aimFrame(g.p, sub(pos[P.muzzle]!, g.p), [0, 1, 0]), g),
  }

  const cons: Con[] = []
  const link = (a: number, c: number, min = false, d = len(sub(pos[a]!, pos[c]!))) => cons.push({ a, b: c, d, min })
  for (let i = 0; i < RIGID.length; i++) for (let j = i + 1; j < RIGID.length; j++) link(RIGID[i]!, RIGID[j]!)
  link(P.hipL, P.kneeL)
  link(P.kneeL, P.ankL)
  link(P.hipR, P.kneeR)
  link(P.kneeR, P.ankR)
  link(P.shL, P.elbL)
  link(P.elbL, P.handL)
  link(P.shR, P.elbR)
  link(P.elbR, P.handR)
  link(P.grip, P.muzzle)
  // Joint limits as minimum spans: knees and elbows can't fold flat, legs can't pass through each other.
  link(P.hipL, P.ankL, true, 0.5)
  link(P.hipR, P.ankR, true, 0.5)
  link(P.shL, P.handL, true, 0.24)
  link(P.shR, P.handR, true, 0.24)
  link(P.kneeL, P.kneeR, true, 0.16)
  link(P.ankL, P.ankR, true, 0.12)
  link(P.chest, P.kneeL, true, 0.38)
  link(P.chest, P.kneeR, true, 0.38)
  link(P.back, P.kneeL, true, 0.4)
  link(P.back, P.kneeR, true, 0.4)

  // Initial velocities: the body's own motion plus the killing shot.
  const l = Math.hypot(dx, dy) || 1
  const d: V3 = [dx / l, 0, dy / l]
  const perp: V3 = [-d[2], 0, d[0]]
  const fwd = b.pelvis.x
  const vel: V3[] = pos.map((_, i) => b.velocities?.[i] ? [...b.velocities[i]!] : [vx, 0, vy])
  const push = (i: number, v: V3, s: number) => (vel[i] = madd(vel[i]!, v, s))
  for (const i of [P.shL, P.shR, P.back, P.chest, P.head, P.elbL, P.elbR, P.handL, P.handR]) {
    push(i, d, style.push)
    push(i, [0, 1, 0], style.lift)
  }
  for (const i of [P.hipL, P.hipR]) {
    push(i, d, style.push * 0.55)
    push(i, [0, 1, 0], style.lift * 0.7)
  }
  for (const i of [P.kneeL, P.kneeR, P.ankL, P.ankR]) push(i, d, style.push * 0.2)
  push(P.shL, perp, style.spin)
  push(P.shR, perp, -style.spin)
  push(P.head, perp, style.spin * 0.6)
  for (const i of [P.kneeL, P.kneeR]) {
    push(i, fwd, style.buckle * 1.3)
    push(i, [0, -1, 0], style.buckle)
  }
  for (const i of [P.hipL, P.hipR, P.chest, P.back]) push(i, [0, -1, 0], style.buckle * 0.6)
  // The gun is flung away, tumbling.
  const toss = madd(madd([0, 2.2, 0], perp, (rng.next() - 0.5) * 3), d, 1 + style.push * 0.4)
  push(P.grip, toss, 1)
  push(P.muzzle, toss, 1)
  push(P.muzzle, perp, (rng.next() - 0.5) * 4)

  const prev = pos.map((p, i) => madd(p, vel[i]!, -SUB))
  const t = tri(pos)
  const px = (pos[P.hipL]![0] + pos[P.hipR]![0]) / 2
  const pz = (pos[P.hipL]![2] + pos[P.hipR]![2]) / 2
  return {
    hiddenBones: new Set(hidden),
    pos,
    prev,
    cons,
    attach: { pelvis: toLocal(t, b.pelvis), torso: toLocal(t, b.torso), head: toLocal(t, b.head) },
    limbs,
    gunRoll: 0,
    gunSpin: (rng.next() < 0.5 ? -1 : 1) * (6 + rng.next() * 6),
    rects: solids.filter((r) => px > r[0] - 4 && px < r[2] + 4 && pz > r[1] - 4 && pz < r[3] + 4),
    acc: 0,
    still: 0,
    age: 0,
  }
}

function solve(r: Ragdoll): void {
  const { pos } = r
  for (const c of r.cons) {
    const pa = pos[c.a]!
    const pb = pos[c.b]!
    const dx = pb[0] - pa[0]
    const dy = pb[1] - pa[1]
    const dz = pb[2] - pa[2]
    const l = Math.hypot(dx, dy, dz) || 1e-6
    if (c.min && l >= c.d) continue
    const k = ((l - c.d) / l) * 0.5
    pa[0] += dx * k
    pa[1] += dy * k
    pa[2] += dz * k
    pb[0] -= dx * k
    pb[1] -= dy * k
    pb[2] -= dz * k
  }
}

function collide(r: Ragdoll): void {
  for (let i = 0; i < N; i++) {
    const p = r.pos[i]!
    const q = r.prev[i]!
    const rad = RADIUS[i]!
    if (p[1] < rad) {
      const vy = p[1] - q[1]
      p[1] = rad
      q[1] = rad + vy * 0.25
      // Floor friction: bleed off most of the sliding.
      q[0] += (p[0] - q[0]) * 0.18
      q[2] += (p[2] - q[2]) * 0.18
    }
    if (p[1] > 2.4) continue
    for (const w of r.rects) {
      const x0 = w[0] - rad
      const x1 = w[2] + rad
      const z0 = w[1] - rad
      const z1 = w[3] + rad
      if (p[0] <= x0 || p[0] >= x1 || p[2] <= z0 || p[2] >= z1) continue
      const m = Math.min(p[0] - x0, x1 - p[0], p[2] - z0, z1 - p[2])
      if (m === p[0] - x0) p[0] = x0
      else if (m === x1 - p[0]) p[0] = x1
      else if (m === p[2] - z0) p[2] = z0
      else p[2] = z1
      q[1] += (p[1] - q[1]) * 0.2
    }
  }
}

/** Advances the ragdoll; it sleeps once everything has stopped moving. */
export function stepRagdoll(r: Ragdoll, dt: number): void {
  r.age += dt
  if (r.still > 0.6) return
  r.acc = Math.min(r.acc + dt, SUB * 8)
  let moving = 0
  while (r.acc >= SUB) {
    r.acc -= SUB
    for (let i = 0; i < N; i++) {
      const p = r.pos[i]!
      const q = r.prev[i]!
      const vx = (p[0] - q[0]) * 0.998
      const vy = (p[1] - q[1]) * 0.998
      const vz = (p[2] - q[2]) * 0.998
      r.prev[i] = [p[0], p[1], p[2]]
      p[0] += vx
      p[1] += vy - GRAVITY * SUB * SUB
      p[2] += vz
      moving = Math.max(moving, Math.abs(vx) + Math.abs(vy) + Math.abs(vz))
    }
    for (let it = 0; it < 6; it++) {
      solve(r)
      collide(r)
    }
  }
  const grounded = r.pos[P.grip]![1] < 0.06
  r.gunRoll += r.gunSpin * dt * (grounded ? 0.2 : 1)
  if (grounded) r.gunSpin *= Math.exp(-dt * 8)
  r.still = moving < 0.0012 ? r.still + dt : 0
}

/** The ragdoll's pose as body frames, emitted like a living soldier. `sink` lowers it into the floor to fade out. */
export function ragdollBody(r: Ragdoll, sink: number, kind: Gun): Body {
  const p = r.pos.map((v): V3 => [v[0], v[1] - sink, v[2]])
  const t = tri(p)
  const torso = fromLocal(t, r.attach.torso)
  const pelvis = fromLocal(t, r.attach.pelvis)
  const head = fromLocal(t, r.attach.head)
  const bone = (a: P, b: P, ref: Frame, local: Local) => fromLocal(limb(p[a]!, p[b]!, ref.x, ref.y), local)
  let gun = aimFrame(p[P.grip]!, sub(p[P.muzzle]!, p[P.grip]!), [0, 1, 0])
  gun = fromLocal(gun, r.limbs.gun)
  gun = roll(gun, Math.max(-1.5, Math.min(1.5, r.gunRoll)))
  return {
    pelvis,
    torso,
    head,
    ua: [bone(P.shL, P.elbL, torso, r.limbs.ua[0]!), bone(P.shR, P.elbR, torso, r.limbs.ua[1]!)],
    fa: [bone(P.elbL, P.handL, torso, r.limbs.fa[0]!), bone(P.elbR, P.handR, torso, r.limbs.fa[1]!)],
    th: [bone(P.hipL, P.kneeL, pelvis, r.limbs.th[0]!), bone(P.hipR, P.kneeR, pelvis, r.limbs.th[1]!)],
    sh: [bone(P.kneeL, P.ankL, pelvis, r.limbs.sh[0]!), bone(P.kneeR, P.ankR, pelvis, r.limbs.sh[1]!)],
    ft: [bone(P.kneeL, P.ankL, pelvis, r.limbs.ft[0]!), bone(P.kneeR, P.ankR, pelvis, r.limbs.ft[1]!)],
    gun,
    pump: kind === "shotgun" ? moved(gun, at(gun, GUNPTS.shotgun.fore, 0.005, 0)) : null,
    mag: kind === "shotgun" ? null : moved(gun, at(gun, GUNPTS[kind].mag[0], GUNPTS[kind].mag[1], GUNPTS[kind].mag[2])),
  }
}

/** Centre of the torso on the plan, for blood pools. */
export function ragdollCentre(r: Ragdoll): { x: number; y: number } {
  const a = r.pos[P.back]!
  const b = r.pos[P.chest]!
  return { x: (a[0] + b[0]) / 2, y: (a[2] + b[2]) / 2 }
}

export function emitRagdoll(push: PushPart, r: Ragdoll, gun: Gun, color: readonly [number, number, number], models: PartModels, flash: number, alpha: number, sink: number): void {
  emitBody(push, ragdollBody(r, sink, gun), gun, color, models, flash, alpha, r.hiddenBones)
}

/** A body where someone died. t0 is seconds. */
export type Corpse = { id: string; gun: Gun; bare?: boolean; t0: number; rd: Ragdoll }

/** Death variations by the killing gun: rifles mostly crumple or fall back, shotguns throw, snipers spin. */
export function deathStyle(gun: Gun): DeathStyle {
  const r = Math.random()
  if (gun === "shotgun") return { push: 5.5 + r * 1.5, lift: 1.6, spin: (Math.random() - 0.5) * 1.5, buckle: 0 }
  if (gun === "sniper") return r < 0.5 ? { push: 4.2, lift: 0.7, spin: (Math.random() < 0.5 ? -1 : 1) * 2.4, buckle: 0.3 } : { push: 4.8, lift: 1, spin: 0.4, buckle: 0 }
  if (r < 0.4) return { push: 0.7, lift: 0, spin: (Math.random() - 0.5) * 1.2, buckle: 1.6 }
  if (r < 0.8) return { push: 1.9, lift: 0.2, spin: (Math.random() - 0.5) * 1, buckle: 0.3 }
  return { push: 1.5, lift: 0.1, spin: (Math.random() < 0.5 ? -1 : 1) * 2.2, buckle: 0.6 }
}

/** Loose bits that tumble and settle: spent casings, dropped magazines. */
export type Debris = {
  model: number
  p: V3
  v: V3
  yaw: number
  pitch: number
  roll: number
  w: V3
  t0: number
  life: number
  bounces: number
}

/** Steps debris; returns true on a bounce hard enough to hear. */
export function stepDebris(d: Debris, dt: number, rects: readonly Rect[]): boolean {
  let clink = false
  d.v[1] -= 13 * dt
  d.p = madd(d.p, d.v, dt)
  d.yaw += d.w[0] * dt
  d.pitch += d.w[1] * dt
  d.roll += d.w[2] * dt
  if (d.p[1] < 0.015) {
    d.p[1] = 0.015
    if (d.v[1] < -0.8) {
      clink = d.bounces < 3
      d.bounces++
      d.v = [d.v[0] * 0.5, -d.v[1] * 0.35, d.v[2] * 0.5]
      d.w = [d.w[0] * 0.6 + (Math.random() - 0.5) * 6, d.w[1] * 0.5, d.w[2] * 0.5]
    } else {
      d.v = [d.v[0] * Math.exp(-dt * 9), 0, d.v[2] * Math.exp(-dt * 9)]
      d.w = scale(d.w, Math.exp(-dt * 10))
      // Settle flat on the floor.
      d.pitch *= Math.exp(-dt * 12)
      d.roll += (Math.round(d.roll / Math.PI) * Math.PI - d.roll) * Math.min(1, dt * 12)
    }
  }
  for (const w of rects) {
    if (d.p[1] > 2.4 || d.p[0] <= w[0] || d.p[0] >= w[2] || d.p[2] <= w[1] || d.p[2] >= w[3]) continue
    const m = Math.min(d.p[0] - w[0], w[2] - d.p[0], d.p[2] - w[1], w[3] - d.p[2])
    if (m === d.p[0] - w[0] || m === w[2] - d.p[0]) {
      d.p[0] = m === d.p[0] - w[0] ? w[0] : w[2]
      d.v[0] *= -0.4
    } else {
      d.p[2] = m === d.p[2] - w[1] ? w[1] : w[3]
      d.v[2] *= -0.4
    }
  }
  return clink
}
