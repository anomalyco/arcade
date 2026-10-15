import { type Avatar, type Body, type PartModels, animate, emitBody, glow, newAvatar } from "@arcade/kit/avatar/anim"
import type { Mesh } from "@arcade/kit/gpu/mesh"
import type { AbilityDef } from "@arcade/kit/sim/abilities"
import { type Frame, type V3, add, emit, rot, sub } from "@arcade/kit/rig"
import { ROSTER } from "../../shared/characters"
import { LOOKS } from "../looks/roster"
import type { FrameParts } from "../render/frame-parts"

type Rgb = readonly [number, number, number]

/** A character's registered models. */
export type FighterModels = { parts: PartModels; prop: number; scale: number }

/** Everyone is drawn a little larger than life, so they read from the arena camera; hit boxes don't change. */
export const FIGURE_SCALE = 1.2

/** Registers every character's parts once; the unused weapon slots of the shared rig all point at the first set. */
export function registerFighters(addModel: (m: Mesh) => number): Record<string, FighterModels> {
  const out: Record<string, FighterModels> = {}
  let shared: Pick<PartModels, "gun" | "mag" | "casing" | "pump" | "hole"> | null = null
  for (const c of ROSTER) {
    const look = LOOKS[c.id]!
    const p = look.parts()
    shared ??= {
      gun: { rifle: addModel(p.gun.rifle), shotgun: addModel(p.gun.shotgun), sniper: addModel(p.gun.sniper) },
      mag: { rifle: addModel(p.mag.rifle), shotgun: addModel(p.mag.shotgun), sniper: addModel(p.mag.sniper) },
      casing: { rifle: addModel(p.casing.rifle), shotgun: addModel(p.casing.shotgun), sniper: addModel(p.casing.sniper) },
      pump: addModel(p.pump),
      hole: addModel(p.hole),
    }
    const parts: PartModels = {
      pelvis: addModel(p.pelvis), torso: addModel(p.torso), head: addModel(p.head), upperArm: addModel(p.upperArm), foreArm: addModel(p.foreArm),
      thigh: addModel(p.thigh), shin: addModel(p.shin), foot: addModel(p.foot), toe: addModel(p.toe), ...shared,
    }
    out[c.id] = { parts, prop: look.prop ? addModel(look.prop()) : -1, scale: look.scale * FIGURE_SCALE }
  }
  return out
}

/** How the arms move for an ability, from what its first effect does. */
export type PoseKind = "swing" | "throw" | "lob" | "raise" | "point" | "grab" | "charge"

export function poseKind(def: AbilityDef): PoseKind {
  const e = def.effects[0]!
  switch (e.kind) {
    case "melee":
      return "swing"
    case "projectile":
      return e.lob ? "lob" : "throw"
    case "swarm":
      return "point"
    case "grab":
      return "grab"
    case "dash":
      return "charge"
    default:
      return "raise"
  }
}

type Hands = { l?: V3; r?: V3 }
/** Hand targets in torso space (x forward, y up, z right): wound up, then struck. */
const POSES: Record<PoseKind, { wind: Hands; strike: Hands }> = {
  swing: { wind: { r: [-0.05, 0.62, 0.45] }, strike: { r: [0.55, 0.32, -0.22] } },
  throw: { wind: { r: [-0.25, 0.78, 0.35] }, strike: { r: [0.62, 0.48, 0.12] } },
  lob: { wind: { r: [-0.2, 0.02, 0.35] }, strike: { r: [0.45, 0.78, 0.15] } },
  raise: { wind: { l: [0.08, 0.98, -0.2], r: [0.08, 0.98, 0.2] }, strike: { l: [0.25, 0.72, -0.56], r: [0.25, 0.72, 0.56] } },
  point: { wind: { r: [0.15, 0.8, 0.32] }, strike: { r: [0.62, 0.55, 0.1] } },
  grab: { wind: { l: [0.35, 0.42, -0.32], r: [0.35, 0.42, 0.32] }, strike: { l: [0.56, 0.36, -0.12], r: [0.56, 0.36, 0.12] } },
  charge: { wind: { l: [0.3, 0.3, -0.26], r: [0.3, 0.3, 0.26] }, strike: { l: [0.5, 0.32, -0.16], r: [0.5, 0.32, 0.16] } },
}
const CARRY: Hands = { l: [0.1, 0.98, -0.2], r: [0.1, 0.98, 0.2] }

const smooth = (u: number) => u * u * (3 - 2 * u)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const mix = (a: V3 | undefined, b: V3 | undefined, k: number): V3 | undefined => (!a ? b : !b ? a : [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k])

/** Arm targets `e` seconds into a cast of `def` (wind up over the wind-up, strike at release, then let go). */
export function castReach(def: AbilityDef, e: number, hold = 0): Avatar["reach"] {
  const pose = POSES[poseKind(def)]
  const rel = e - def.windup
  const tail = 0.28 + hold
  if (rel > tail) return undefined
  if (rel < 0) {
    const k = smooth(clamp01(e / Math.min(Math.max(def.windup, 0.05), 0.14)))
    return { ...pose.wind, k }
  }
  const strike = smooth(clamp01(rel / 0.07))
  const k = rel < 0.12 + hold ? 1 : 1 - smooth(clamp01((rel - 0.12 - hold) / 0.16))
  return { l: mix(pose.wind.l, pose.strike.l, strike), r: mix(pose.wind.r, pose.strike.r, strike), k }
}

export const carryReach = (): Avatar["reach"] => ({ ...CARRY, k: 1 })

/** Rotates every part of a pose about `pivot` (axis, angle), then moves it by `shift`. */
export function turnBody(b: Body, pivot: V3, axis: V3, angle: number, shift: V3 = [0, 0, 0]): Body {
  const tf = (f: Frame): Frame => ({ p: add(add(pivot, rot(sub(f.p, pivot), axis, angle)), shift), x: rot(f.x, axis, angle), y: rot(f.y, axis, angle), z: rot(f.z, axis, angle) })
  const two = (a: [Frame, Frame]): [Frame, Frame] => [tf(a[0]), tf(a[1])]
  return { ...b, pelvis: tf(b.pelvis), torso: tf(b.torso), head: tf(b.head), ua: two(b.ua), fa: two(b.fa), th: two(b.th), sh: two(b.sh), ft: two(b.ft), toe: b.toe ? two(b.toe) : undefined, gun: null, pump: null, mag: null }
}

/** One fighter on screen: its avatar, and what the client tracks to animate it. */
export class FighterDraw {
  readonly a: Avatar
  char: string
  castAt = -10
  castSlot = -1
  fallAt = 0
  /** Smoothed tumble while flying, 0..1. */
  tumble = 0
  /** Spin while falling or flying (radians). */
  spin = 0

  constructor(id: string, char: string, x: number, y: number, aim: number, scale: number) {
    this.char = char
    this.a = newAvatar(id, x / scale, y / scale, aim, "rifle")
    this.a.unarmed = true
  }
}

export type DrawOpts = {
  /** Height offset (falling into the pit, carried overhead). */
  lift: number
  /** Whole-body rotation: axis (world) and angle, about the pelvis. */
  turn?: { axis: V3; angle: number }
  alpha: number
  color: Rgb
}

/** Animates and emits one fighter at plan (x, y): the rig runs at unit scale and the pose is scaled to the character. */
export function drawFighter(fp: FrameParts, m: FighterModels, d: FighterDraw, dt: number, t: number, x: number, y: number, vx: number, vy: number, aim: number, o: DrawOpts): void {
  const s = m.scale
  animate(d.a, dt, t, x / s, y / s, vx / s, vy / s, aim)
  let b = d.a.body
  if (!b) return
  if (o.turn && Math.abs(o.turn.angle) > 1e-3) b = turnBody(b, [x / s, 0.9, y / s], o.turn.axis, o.turn.angle)
  const push = fp.scaled(s, 0, 0, o.lift)
  emitBody(push, b, "rifle", o.color, m.parts, d.a.flash, o.alpha)
  if (m.prop >= 0) emit(push, m.prop, b.fa[1], glow(o.color), d.a.flash, o.alpha)
}
