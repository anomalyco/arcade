import type { ExplosionPresetId } from "@arcade/kit/fx/explosion"
import { CLAYMORE, FRAG, GUNS, type Equip, type Gun } from "../../shared/config"
import { raycast, type Rect } from "../../shared/geom"
import type { MapDef } from "../../shared/maps"
import { stepGrenade, type Grenade, type Obstacles } from "../../shared/sim/gear"
import type { Snapshot } from "../../shared/sim/view"
import type { SimEvent } from "../../shared/sim/world"
import { blackoutEffects as fxSettings } from "../lab/settings"
import type { MotionKeys } from "../render/motion"
import type { Juice } from "../ui/debug-overlay"
import { animate, glow, pose, type Avatar, type PartModels, type PushPart } from "./anim"
import { deathStyle, emitRagdoll, ragdoll, ragdollCentre, stepDebris, stepRagdoll, type Corpse, type Debris } from "./ragdoll"
import type { VehicleFx } from "./vehicles"

export type Rgb3 = [number, number, number]
export type Tracer = { x0: number; y0: number; z0: number; x1: number; y1: number; t0: number; life: number; w: number; gun: Gun }
export type FlashFx = { x: number; y: number; z: number; aim: number; gun: Gun; t0: number; seed: number }
export type Particle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; t0: number; life: number; size: number; kind: "spark" | "dust" | "blood" | "splat" | "smoke" | "chip" | "fire" | "soot" | "char" | "electric"; bounced: boolean }
export type Flash = { x: number; y: number; t0: number; life: number; power: number }
export type FragFx = Grenade & { spin: number; yaw: number }
export type Boom = { x: number; y: number; t0: number; kind: Equip; aim: number; preset: ExplosionPresetId }
export type Monitor = { x: number; y: number; yaw: number; broken: boolean }
export type LooseSheet = Debris & { kind: "paper" | "glass"; phase: number }
export type BulletHole = { x: number; y: number; z: number; yaw: number; roll: number; t0: number }

export const CLAY_SCALE = 1.15

export type SpriteEmitFn = (
  add: boolean,
  x: number,
  y: number,
  z: number,
  size: number,
  r: number,
  g: number,
  b: number,
  a: number,
  kind: number,
  rot?: number,
  stretch?: number,
  extra?: number,
) => void

export function emitGearParts(opts: {
  parts: Map<number, number[]>
  t: number
  dt: number
  grenades: Map<number, FragFx>
  obstacles: Obstacles
  gear: { frag: number; claymore: number; led: number }
  snap: Snapshot | null
  motionKeys: MotionKeys
  friendlyMine: (by: string) => boolean
  colorOf: (id: string) => Rgb3
  ledColor: (c: Snapshot["claymores"][number], t: number) => [number, number, number]
}): void {
  const { parts, t, dt, grenades, obstacles, gear, snap, motionKeys, friendlyMine, colorOf, ledColor } = opts
  const put = (model: number, x: number, y: number, z: number, yaw: number, tint: readonly number[], pitch: number, roll: number, scale: number) => {
    let arr = parts.get(model)
    if (!arr) parts.set(model, (arr = []))
    arr.push(x, y, z, yaw, tint[0]!, tint[1]!, tint[2]!, scale, pitch, roll, 1, 0)
    motionKeys.record(arr, model)
  }
  for (const g of grenades.values()) {
    motionKeys.begin(g, [g.x, g.z, g.y])
    if (t > g.at + 0.3) {
      grenades.delete(g.id)
      continue
    }
    stepGrenade(g, obstacles, Math.min(dt, 0.05))
    const sp = Math.hypot(g.vx, g.vy)
    g.spin += sp * dt * (g.z > FRAG.size + 0.01 ? 9 : 14)
    put(gear.frag, g.x, g.z, g.y, g.yaw, [1, 1, 1], g.spin, g.spin * 0.37, 1.35)
  }
  motionKeys.begin()
  for (const c of snap?.claymores ?? []) {
    const strip = friendlyMine(c.by) ? glow(colorOf(c.by), 0.22) : [0.012, 0.013, 0.01]
    put(gear.claymore, c.x, 0, c.y, c.aim, strip, 0, 0, CLAY_SCALE)
    put(gear.led, c.x - Math.cos(c.aim) * 0.03, 0.146 * CLAY_SCALE, c.y - Math.sin(c.aim) * 0.03, c.aim, ledColor(c, t), 0, 0, CLAY_SCALE)
  }
}

export function emitGearSprites(opts: {
  t: number
  grenades: Map<number, FragFx>
  trips: Map<number, number>
  booms: readonly Boom[]
  snap: Snapshot | null
  friendlyMine: (by: string) => boolean
  ledColor: (c: Snapshot["claymores"][number], t: number) => [number, number, number]
  sprite: SpriteEmitFn
}): void {
  const { t, grenades, trips, booms, snap, friendlyMine, ledColor, sprite } = opts
  for (const g of grenades.values()) {
    const left = g.at - t
    const rate = left < 0.6 ? 14 : left < 1.2 ? 8 : 4
    const on = Math.sin(t * rate * Math.PI) > 0
    sprite(true, g.x, g.z + 0.08, g.y, on ? 0.22 : 0.1, 1.5, 0.12, 0.05, on ? 1 : 0.5, 0)
    if (g.z < 0.4) sprite(true, g.x, 0.03, g.y, FRAG.kill, 1, 0.12, 0.06, 0.35 + (on ? 0.25 : 0), 5, t * 0.8, 0.04)
  }
  for (const c of snap?.claymores ?? []) {
    const lx = c.x - Math.cos(c.aim) * 0.03
    const ly = c.y - Math.sin(c.aim) * 0.03
    const led = ledColor(c, t)
    if (led[0] > 0.5) sprite(true, lx, 0.17 * CLAY_SCALE + 0.02, ly, led[0] > 4 ? 0.16 : 0.05, led[0] * 0.2, led[1] * 0.2, led[2] * 0.2, 1, 0)
    if (!c.armed || !friendlyMine(c.by)) continue
    const tripped = c.tripped || trips.has(c.id)
    sprite(true, c.x, 0.04, c.y, CLAYMORE.range, 1, 0.08, 0.06, tripped ? 0.5 : 0.12, 8, c.aim, 1, CLAYMORE.cone)
  }
  for (const b of booms) {
    const age = t - b.t0
    if (b.kind === "claymore" && age < 0.35) {
      const u = age / 0.35
      sprite(true, b.x, 0.05, b.y, CLAYMORE.blast * (0.4 + u * 0.8), 2, 0.9, 0.4, (1 - u) ** 2, 8, b.aim, 1, CLAYMORE.blastCone)
    }
  }
}

export function stepAndEmitCombatFx(opts: {
  t: number
  adt: number
  juice: Juice
  models: PartModels
  sheetModels: { paper: number; glass: number; brass: number; screen: number }
  solids: readonly Rect[]
  blockers: readonly Rect[]
  me: { x: number; y: number } | null
  debris: Debris[]
  sheets: LooseSheet[]
  corpses: Corpse[]
  holes: BulletHole[]
  flashFx: FlashFx[]
  tracers: Tracer[]
  particles: Particle[]
  motionKeys: MotionKeys
  spriteKeys: MotionKeys
  push: PushPart
  emit: (model: number, data: number[], alpha?: boolean) => void
  sprite: SpriteEmitFn
  colorOf: (id: string) => Rgb3
  onClink: (dx: number, dy: number, isMag: boolean) => void
  onGearParts: () => void
  onGearAndModeSprites: () => void
}): {
  debris: Debris[]
  sheets: LooseSheet[]
  corpses: Corpse[]
  holes: BulletHole[]
  flashFx: FlashFx[]
  tracers: Tracer[]
  particles: Particle[]
} {
  const {
    t,
    adt,
    juice,
    models,
    sheetModels,
    solids,
    blockers,
    me,
    motionKeys,
    spriteKeys,
    push,
    emit,
    sprite,
    colorOf,
    onClink,
    onGearParts,
    onGearAndModeSprites,
  } = opts

  // Casings and magazines on the floor.
  motionKeys.begin()
  spriteKeys.begin()
  const debris = opts.debris.filter((d) => t - d.t0 < d.life)
  for (const d of debris) {
    if (d.model === sheetModels.brass && !juice.casings) continue
    motionKeys.begin(d, [d.p[0], d.p[1], d.p[2]])
    if (stepDebris(d, adt, solids) && me && Math.hypot(d.p[0] - me.x, d.p[2] - me.y) < 10) {
      onClink(d.p[0] - me.x, d.p[2] - me.y, d.model === models.mag.rifle || d.model === models.mag.sniper)
    }
    const sink = Math.max(0, t - d.t0 - (d.life - 0.5)) * 0.12
    push(d.model, d.p[0], d.p[1] - sink, d.p[2], d.yaw, [1, 1, 1], d.pitch, d.roll, 0)
  }

  const sheets = opts.sheets.filter((d) => t - d.t0 < d.life)
  for (const d of sheets) {
    if (!juice[d.kind]) continue
    motionKeys.begin(d, [d.p[0], d.p[1], d.p[2]])
    const age = t - d.t0
    if (d.kind === "paper") {
      if (d.p[1] > 0.02) {
        d.v[1] -= fxSettings.paper.gravity * adt
        const drag = Math.exp(-adt * fxSettings.paper.drag)
        d.v[0] *= drag
        d.v[2] *= drag
        d.p[0] += (d.v[0] + Math.sin(age * 5 + d.phase) * fxSettings.paper.flutter) * adt
        d.p[1] = Math.max(0.016, d.p[1] + d.v[1] * adt)
        d.p[2] += (d.v[2] + Math.cos(age * 4 + d.phase) * fxSettings.paper.flutter) * adt
        d.yaw += adt * 0.7
        d.pitch = Math.sin(age * 7 + d.phase) * 0.65
        d.roll = Math.sin(age * 5 + d.phase) * 0.85
      } else {
        d.pitch *= Math.exp(-adt * 12)
        d.roll *= Math.exp(-adt * 12)
      }
    } else stepDebris(d, adt, blockers)
    push(d.model, d.p[0], d.p[1], d.p[2], d.yaw, [1, 1, 1], d.pitch, d.roll, 0)
  }

  onGearParts()

  // Corpses: ragdolls that settle, their stripes dimming and a pool spreading, then sink away before the respawn.
  const bodies = new Map<number, number[]>()
  const pushBody: PushPart = (model, x, y, z, yaw, tint, pitch, roll, flash, alpha = 1) => {
    let arr = bodies.get(model)
    if (!arr) bodies.set(model, (arr = []))
    arr.push(x, y, z, yaw, tint[0], tint[1], tint[2], 1, pitch, roll, alpha, flash)
    motionKeys.record(arr, model)
  }
  const corpses = opts.corpses.filter((c) => t - c.t0 < fxSettings.corpse.life)
  for (const c of corpses) {
    motionKeys.begin(c)
    const age = t - c.t0
    stepRagdoll(c.rd, adt)
    const col = colorOf(c.id)
    const dim = 0.2 + 0.8 * Math.exp(-age * 1.2)
    const sink = Math.max(0, age - fxSettings.corpse.sinkAt) ** 2 * 0.6
    const pool = Math.max(0, Math.min(1, (age - fxSettings.corpse.poolDelay) / fxSettings.corpse.poolTime))
    if (pool > 0) {
      const bc = ragdollCentre(c.rd)
      sprite(false, bc.x, 0.012, bc.y, 0.1 + fxSettings.corpse.poolRadius * Math.sqrt(pool), 0.07, 0.0, 0.004, 0.9 * Math.max(0, 1 - sink * 4), 6)
    }
    const m = models
    const pb: PushPart = c.bare ? (model, ...rest) => void (model !== m.gun[c.gun] && model !== m.mag[c.gun] && model !== m.pump && pushBody(model, ...rest)) : pushBody
    emitRagdoll(pb, c.rd, c.gun, [col[0] * dim, col[1] * dim, col[2] * dim], models, 0, 1, sink)
  }
  for (const [model, data] of bodies) emit(model, data)

  // Bullet holes glow hot for a moment, then fade out after a while.
  const holes = opts.holes.filter((hl) => t - hl.t0 < fxSettings.holes.life)
  const holeData: number[] = []
  for (const hl of holes) {
    const age = t - hl.t0
    holeData.push(hl.x, hl.z, hl.y, hl.yaw, 1, 1, 1, 1, 0, hl.roll, Math.min(1, (fxSettings.holes.life - age) / fxSettings.holes.fade), Math.max(0, fxSettings.holes.heat - age * fxSettings.holes.coolRate))
  }
  emit(models.hole, holeData, true)

  // Muzzle flashes: a hot core, petals along the barrel and, for the sniper, the brake's side jets.
  const flashFx = opts.flashFx.filter((f) => t - f.t0 < (f.gun === "rifle" ? fxSettings.muzzle.rifleLife : fxSettings.muzzle.heavyLife))
  for (const f of flashFx) {
    spriteKeys.begin(f, [f.x, f.z, f.y])
    const life = f.gun === "rifle" ? fxSettings.muzzle.rifleLife : fxSettings.muzzle.heavyLife
    const p = (t - f.t0) / life
    const fa = 1 - p
    const big = f.gun === "shotgun" ? 1.7 : f.gun === "sniper" ? 1.4 : 1
    const c = Math.cos(f.aim)
    const sn = Math.sin(f.aim)
    sprite(true, f.x + c * 0.08, f.z, f.y + sn * 0.08, (fxSettings.muzzle.coreSize + f.seed * 0.12) * big, 1, 0.85, 0.55, fa, 0)
    const petal = (rot: number, l: number, wd: number, a: number) => {
      const half = l / 2
      sprite(true, f.x + Math.cos(rot) * half, f.z, f.y + Math.sin(rot) * half, half, 1, 0.75, 0.4, a, 4, rot, wd / half)
    }
    const len = (fxSettings.muzzle.petalLength + f.seed * 0.25) * big * (1 - p * 0.4)
    petal(f.aim, len, 0.07 * big, fa)
    petal(f.aim + 0.45 + f.seed * 0.2, len * 0.45, 0.04 * big, fa * 0.8)
    petal(f.aim - 0.45 - (1 - f.seed) * 0.2, len * 0.45, 0.04 * big, fa * 0.8)
    if (f.gun === "shotgun") petal(f.aim, len * 0.8, 0.25, fa * 0.5)
    if (f.gun === "sniper") {
      petal(f.aim + Math.PI / 2, 0.35, 0.05, fa)
      petal(f.aim - Math.PI / 2, 0.35, 0.05, fa)
    }
  }

  // Tracers: rifle and shotgun rounds are short streaks flying down the line; the sniper leaves a lingering beam.
  const tracers = opts.tracers.filter((tr) => t - tr.t0 < tr.life)
  for (const tr of tracers) {
    spriteKeys.begin(tr, [tr.x0, tr.z0, tr.y0], 32)
    const len = Math.hypot(tr.x1 - tr.x0, tr.y1 - tr.y0)
    if (len < 0.05) continue
    const rot = Math.atan2(tr.y1 - tr.y0, tr.x1 - tr.x0)
    const age = t - tr.t0
    const line = (u0: number, u1: number, w: number, r: number, g: number, b: number, a: number) => {
      const seg = ((u1 - u0) * len) / 2
      if (seg < 0.01) return
      const um = (u0 + u1) / 2
      sprite(true, tr.x0 + (tr.x1 - tr.x0) * um, tr.z0, tr.y0 + (tr.y1 - tr.y0) * um, seg, r, g, b, a, 4, rot, w / seg)
    }
    if (tr.gun === "sniper") {
      const p = age / tr.life
      const a = (1 - p) * (1 - p)
      line(0, 1, tr.w * (1 - p * 0.6), 0.85, 0.92, 1, a)
      line(0, 1, tr.w * 4, 0.4, 0.55, 1, a * 0.3)
    } else {
      const head = Math.min(1, (age * fxSettings.tracer.speed) / len)
      const tail = Math.max(0, (age * fxSettings.tracer.speed - fxSettings.tracer.length) / len)
      line(tail, head, tr.w, 1, 0.9, 0.6, 1)
      line(tail, head, tr.w * 4, 1, 0.55, 0.2, 0.22)
    }
  }

  spriteKeys.begin()
  onGearAndModeSprites()

  const particles = opts.particles.filter((p) => t - p.t0 < p.life)
  for (const p of particles) {
    const age = t - p.t0
    const a = 1 - age / p.life
    if (p.kind === "dust" || p.kind === "smoke" || p.kind === "fire" || p.kind === "soot" || p.kind === "char") {
      const drag = Math.exp(-adt * (p.kind === "fire" ? 7 : p.kind === "soot" || p.kind === "char" ? 2.2 : 3))
      p.vx *= drag
      p.vy *= drag
      p.vz = p.vz * drag + adt * (p.kind === "dust" || p.kind === "smoke" ? 0.25 : 0.6)
    } else if (p.kind !== "splat") p.vz -= 9.8 * adt
    p.x += p.vx * adt
    p.y += p.vy * adt
    p.z += p.vz * adt
    if (p.z < 0.02) {
      p.z = 0.02
      if (p.kind === "blood") {
        p.kind = "splat"
        p.t0 = t
        p.life = fxSettings.splats.life + Math.random() * fxSettings.splats.lifeSpread
        p.size *= fxSettings.splats.size + Math.random() * fxSettings.splats.sizeSpread
        p.z = 0.011
      } else if (p.kind === "spark" && !p.bounced) {
        p.vz = -p.vz * fxSettings.impact.bounce
        p.bounced = true
      } else {
        p.vz = 0
        p.vx *= 0.7
        p.vy *= 0.7
      }
    }
    if (juice.volumes && (p.kind === "soot" || p.kind === "char")) continue
    if (p.kind === "electric") { if (juice.sparks) sprite(true, p.x, p.z, p.y, p.size * (1 + a), 0.5, 0.85, 1.4, a, 0) }
    else if (p.kind === "spark") sprite(true, p.x, p.z, p.y, p.size * (p.life < 0.1 ? 1 : 1 + a), 1, 0.72, 0.3, a, 0)
    else if (p.kind === "dust") sprite(false, p.x, p.z, p.y, p.size * (1.2 + age * fxSettings.dust.growth), 0.5, 0.48, 0.46, a * a * fxSettings.dust.opacity, 0)
    else if (p.kind === "smoke") sprite(false, p.x, p.z, p.y, p.size * (1.5 + age * 4), 0.55, 0.55, 0.58, a * a * 0.25, 0)
    else if (p.kind === "fire") {
      const u = age / p.life
      const g = u < 0.1 ? 0.85 : Math.max(0.1, 0.62 - u * 0.7)
      sprite(true, p.x, p.z, p.y, p.size * (0.8 + u * 1.4), 1.7, g, u < 0.1 ? 0.45 : 0.06, (1 - u) ** 2 * 0.9, 0)
    } else if (p.kind === "char") sprite(false, p.x, p.z, p.y, p.size * (1 + age * 0.7), 0.025, 0.024, 0.026, Math.min(1, age * 4) * a * 0.8, 1, 0, 0, p.size * 40)
    else if (p.kind === "soot") sprite(false, p.x, p.z, p.y, p.size * (1 + age * 0.9), 0.13, 0.125, 0.12, Math.min(1, age * 6) * a * a * 0.75, 1, 0, 0, p.size * 40)
    else if (p.kind === "chip") sprite(false, p.x, p.z, p.y, p.size, 0.25, 0.26, 0.3, Math.min(1, a * 4), 6)
    else if (p.kind === "splat") sprite(false, p.x, p.z, p.y, p.size, 0.08, 0.0, 0.005, Math.min(1, a * 3) * 0.9, 6)
    else sprite(false, p.x, p.z, p.y, p.size * 1.6, 0.16, 0.0, 0.008, 1, 0)
  }
  if (particles.length > 1500) particles.splice(0, particles.length - 1500)

  return { debris, sheets, corpses, holes, flashFx, tracers, particles }
}
