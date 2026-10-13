import { DT, PLAYER_RADIUS } from "../../shared/config"
import { type Rect, angleDiff, gridOf } from "../../shared/geom"
import { type Contact, type Rigid, collideShapes, orientedShape, rectShape } from "../../shared/sim/vehicle-collide"
import { VEH } from "../../shared/sim/vehicle-rules"
import { type VehicleKind, type VehicleSpec, VEHICLES, boxOf, collideCars, distToBox, driveOf, driveStep, forwardSpeed, localToWorld, pushOutBox, rayBox, speedOf } from "../../shared/sim/vehicle"
import type { Snapshot, VehicleView } from "../../shared/sim/view"
import type { Intent } from "../../shared/sim/world"
import type { Caster, DynLight } from "../render/lighting"
import type { Renderer } from "../render/renderer"
import { LAMPS, vehicleModels } from "../render/vehicle-mesh"
import type { Avatar } from "./anim"
import { VehiclePresentation, groundHeight } from "./vehicle-presentation"
import { blackoutEffects } from "../lab/settings"
import { VehicleEmissions } from "@arcade/kit/vehicle/emissions"
import { Fx } from "@arcade/kit/vehicle/fx"
import { drawLamps } from "@arcade/kit/vehicle/lights"
import type { SpriteSink } from "@arcade/kit/vehicle/types"
import type { Juice } from "../ui/debug-overlay"

type Rgb3 = [number, number, number]
type FxKind = "spark" | "dust" | "smoke" | "fire" | "soot" | "chip" | "char"
export type FxFn = (x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, kind: FxKind) => void
export type SpriteFn = (add: boolean, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot?: number, stretch?: number, extra?: number) => void
export type PartFn = (model: number, x: number, y: number, z: number, yaw: number, tint: Rgb3, pitch: number, roll: number, flash: number, alpha?: number) => void

/** A vehicle as drawn: the pose on screen, the server's latest, and the bits that only exist for looks. */
export type VehDraw = {
  id: number
  kind: VehicleKind
  spec: VehicleSpec
  x: number
  y: number
  h: number
  vx: number
  vy: number
  w: number
  /** Latest server state and when it arrived (seconds); the drawn pose dead-reckons from it. */
  s: VehicleView
  at: number
  /** Wheel spin, steering angle, body roll and pitch, hit flash (all smoothed), forward speed last frame. */
  spin: number
  steer: number
  roll: number
  pitch: number
  flash: number
  vf: number
  puff: number
  smoke: number
  /** Last skid mark end, for joining marks into a trail. */
  skid: { x: number; y: number }[] | null
  presentation: VehiclePresentation
  scrapeAt: number
}

/** The vehicle you drive, predicted: the body now, before the last tick, and a correction being blended out. */
type Pred = { id: number; body: Rigid; px: number; py: number; ph: number; ox: number; oy: number; oh: number }

/**
 * Vehicles on this client: dead-reckoned and smoothed from snapshots, the one you drive predicted with the shared
 * physics (inputs replayed on every snapshot, like your own body on foot), and drawn with spinning, steering wheels,
 * lamps that light the street, a team-coloured light bar, exhaust, skid marks, smoke when hurt and a burning wreck.
 */
export class VehicleFx {
  draws = new Map<number, VehDraw>()
  pred: Pred | null = null
  private models: Record<VehicleKind, { body: number; wreck: number; wheel: number; lens: number; tail: number; bar: number | null }>
  readonly emissions = new VehicleEmissions()
  readonly fx = new Fx()
  private readonly alpha = new Float32Array(3000 * 12)
  private readonly add = new Float32Array(3000 * 12)
  private near: number[] = []
  onPop?: (d: VehDraw) => void
  private now = 0

  constructor(private readonly renderer: Pick<Renderer, "addModel"> & Partial<Pick<Renderer, "setSmoke">>) {
    const m = vehicleModels()
    const reg = (x: Parameters<Renderer["addModel"]>[0]) => renderer.addModel(x)
    const out = {} as typeof this.models
    for (const kind of Object.keys(m) as VehicleKind[]) {
      const k = m[kind]
      out[kind] = { body: reg(k.body), wreck: reg(k.wreck), wheel: reg(k.wheel), lens: reg(k.lens), tail: reg(k.tail), bar: k.bar ? reg(k.bar) : null }
    }
    this.models = out
  }

  clear(): void {
    this.draws.clear()
    this.pred = null
    this.fx.clearSkids(); this.fx.add.length = 0; this.emissions.reset()
  }

  ingest(s: Pick<Snapshot,"vehicles">, now: number): void {
    this.now = now
    const live = new Set<number>()
    for (const v of s.vehicles ?? []) {
      live.add(v.id)
      let d = this.draws.get(v.id)
      // New, or back from a wreck at its spot: start it there.
      if (!d || (d.s.wreck && !v.wreck)) {
        d = { id: v.id, kind: v.kind, spec: VEHICLES[v.kind], x: v.x, y: v.y, h: v.h, vx: v.vx, vy: v.vy, w: v.w, s: v, at: now, spin: 0, steer: 0, roll: 0, pitch: 0, flash: 0, vf: 0, puff: 0, smoke: 0, skid: null, presentation: new VehiclePresentation(v), scrapeAt: -10 }
        this.draws.set(v.id, d)
      }
      d.s = v
      d.at = now
    }
    for (const id of [...this.draws.keys()]) if (!live.has(id)) this.draws.delete(id)
    if (this.pred && !live.has(this.pred.id)) this.pred = null
  }

  /** Who rides where, from the latest snapshot. */
  riderOf(id: string): { d: VehDraw; seat: number } | null {
    for (const d of this.draws.values()) {
      if (d.s.wreck) continue
      const seat = d.s.seats.indexOf(id)
      if (seat >= 0) return { d, seat }
    }
    return null
  }

  /** How far a rider is drawn below standing height (negative: above, out of a roof hatch). */
  sinkOf(id: string): number {
    const r = this.riderOf(id)
    return r ? (r.d.spec.seats[r.seat]?.sink ?? 0) : 0
  }

  /** Where a seat is on the drawn vehicle. */
  seatAt(d: VehDraw, seat: number): { x: number; y: number } {
    const s = d.spec.seats[seat] ?? d.spec.seats[0]!
    return localToWorld(d, s.f, s.s)
  }

  // Prediction ---------------------------------------------------------------------------------------------------

  /**
   * A snapshot while you drive: start from the server's vehicle and replay your inputs it hasn't seen yet. The jump
   * from where the prediction was is blended out of the drawn pose; a big one snaps.
   */
  reconcile(id: number, pending: readonly { i: Intent }[], solids: readonly Rect[]): void {
    const d = this.draws.get(id)
    if (!d || d.s.wreck) {
      this.pred = null
      return
    }
    const v = d.s
    const body: Rigid = { x: v.x, y: v.y, h: v.h, vx: v.vx, vy: v.vy, w: v.w }
    for (const p of pending) this.step(body, d, p.i, solids)
    const old = this.pred && this.pred.id === id ? this.pred : null
    if (old && Math.hypot(body.x - old.body.x, body.y - old.body.y) < 3) {
      const dx = body.x - old.body.x
      const dy = body.y - old.body.y
      const dh = angleDiff(body.h, old.body.h)
      old.px += dx
      old.py += dy
      old.ph += dh
      old.ox -= dx
      old.oy -= dy
      old.oh -= dh
      old.body = body
    } else this.pred = { id, body, px: body.x, py: body.y, ph: body.h, ox: 0, oy: 0, oh: 0 }
  }

  /** One predicted tick of the vehicle you drive. */
  tick(i: Intent, solids: readonly Rect[]): void {
    const p = this.pred
    const d = p ? this.draws.get(p.id) : null
    if (!p || !d) return
    p.px = p.body.x
    p.py = p.body.y
    p.ph = p.body.h
    this.step(p.body, d, i, solids)
  }

  /** The shared physics, with the other vehicles as they were last seen, standing still. */
  private step(b: Rigid, d: VehDraw, i: Intent, solids: readonly Rect[]): void {
    driveStep(b, driveOf(i), d.spec, DT, solids)
    for (const o of this.draws.values()) {
      if (o === d) continue
      const ob: Rigid = { x: o.x, y: o.y, h: o.h, vx: 0, vy: 0, w: 0 }
      collideCars(b, d.spec, ob, o.spec, DT, false, true)
    }
  }

  // Queries ------------------------------------------------------------------------------------------------------

  /** Walkers can't go through vehicles (your own body's prediction). */
  pushOut(b: { x: number; y: number }): void {
    for (const d of this.draws.values()) pushOutBox(b, PLAYER_RADIUS, boxOf(d, d.spec))
  }

  /** The first vehicle along a ray, skipping `skip` (the one you're in): where it enters, or Infinity. */
  ray(ox: number, oy: number, dx: number, dy: number, maxT: number, skip: number): number {
    let best = Infinity
    for (const d of this.draws.values()) {
      if (d.id === skip) continue
      const hit = rayBox(ox, oy, dx, dy, boxOf(d, d.spec), Math.min(maxT, best))
      if (hit && hit[0] < best) best = hit[0]
    }
    return best
  }

  /** The vehicle F would get you into from (x, y), mirroring the server's rule. */
  enterable(x: number, y: number): VehDraw | null {
    let best: VehDraw | null = null
    let bd = VEH.reach
    for (const d of this.draws.values()) {
      if (d.s.wreck || !d.s.seats.includes("") || speedOf(d.s) > VEH.enterSpeed) continue
      const dist = distToBox(x, y, boxOf(d, d.spec))
      if (dist <= bd) {
        bd = dist
        best = d
      }
    }
    return best
  }

  /** A round hit the bodywork: a flash and sparks. */
  ping(id: number, x: number, y: number, dir: number, fx: FxFn): void {
    const d = this.draws.get(id)
    if (d) d.flash = 1
    for (let i = 0; i < blackoutEffects.vehicle.sparkCount; i++) {
      const a = dir + Math.PI + (Math.random() - 0.5) * 2.2
      const s = blackoutEffects.vehicle.speed + Math.random() * blackoutEffects.vehicle.speedSpread
      fx(x, y, 0.6 + Math.random() * 0.6, Math.cos(a) * s, Math.sin(a) * s, 1 + Math.random() * 3, blackoutEffects.vehicle.life + Math.random() * blackoutEffects.vehicle.lifeSpread, blackoutEffects.vehicle.size, "spark")
    }
  }

  /** Contact lookup from the vehicle-juice study, now feeding the shared spark pool. */
  crash(id: number, x: number, y: number, speed: number, solids: readonly Rect[]): void {
    const d = this.draws.get(id)
    if (d) d.presentation.view.impact = speed
    const contact = d ? this.wallContact({ x, y, h: d.s.h }, d.spec, solids) : null
    const nx = contact?.nx ?? Math.cos(d?.h ?? 0), ny = contact?.ny ?? Math.sin(d?.h ?? 0)
    const at = contact?.points[0] ?? { x, y }
    this.fx.sparks(at.x - nx * 0.15, at.y - ny * 0.15, -nx, -ny, Math.min(14, speed), 0.55)
  }

  private wallContact(b: { x: number; y: number; h: number }, spec: VehicleSpec, solids: readonly Rect[]): Contact | null {
    const r = Math.hypot(spec.length / 2, spec.width / 2) + 0.12
    const grid = gridOf(solids)
    const near = grid ? grid.query(b.x - r, b.y - r, b.x + r, b.y + r, this.near) : null
    const shell = orientedShape(b.x, b.y, b.h, spec.length * 0.48 + 0.1, spec.width * 0.48 + 0.1)
    for (let i = 0; i < (near ? near.length : solids.length); i++) {
      const rect = solids[near ? near[i]! : i]!
      if (b.x < rect[0] - r || b.x > rect[2] + r || b.y < rect[1] - r || b.y > rect[3] + r) continue
      const contact = collideShapes(shell, rectShape(rect))
      if (contact) return contact
    }
    return null
  }

  /** A vehicle blowing up: the extra fire, black smoke and flung panels on top of a frag-sized blast. */
  burst(x: number, y: number, fx: FxFn): void {
    const R = Math.random
    for (let i = 0; i < 26; i++) {
      const a = R() * Math.PI * 2
      const s = 1 + R() * 5
      fx(x + Math.cos(a) * 0.6, y + Math.sin(a) * 0.6, 0.6 + R() * 1.2, Math.cos(a) * s, Math.sin(a) * s, 1.5 + R() * 4, 0.45 + R() * 0.5, 0.45 + R() * 0.5, "fire")
    }
    for (let i = 0; i < 30; i++) {
      const a = R() * Math.PI * 2
      const s = 0.5 + R() * 3
      fx(x + Math.cos(a) * 0.8, y + Math.sin(a) * 0.8, 1 + R() * 1.5, Math.cos(a) * s, Math.sin(a) * s, 0.8 + R() * 1.2, 3 + R() * 2.5, 0.5 + R() * 0.5, i % 2 ? "soot" : "char")
    }
    for (let i = 0; i < 24; i++) {
      const a = R() * Math.PI * 2
      const s = 3 + R() * 8
      fx(x, y, 0.8, Math.cos(a) * s, Math.sin(a) * s, 3 + R() * 6, 1.2 + R() * 0.8, 0.07 + R() * 0.08, "chip")
    }
  }

  // Per frame ----------------------------------------------------------------------------------------------------

  /**
   * Moves every drawn vehicle: yours between the last two predicted ticks plus the fading correction, the others
   * dead-reckoned from their last snapshot and eased toward it.
   */
  frame(dt: number, alpha: number, now: number): void {
    this.now = now
    const k = 1 - Math.exp(-dt * 14)
    const p = this.pred
    if (p) {
      const kc = Math.exp(-dt * 9)
      p.ox *= kc
      p.oy *= kc
      p.oh *= kc
    }
    for (const d of this.draws.values()) {
      const px = d.x
      const py = d.y
      const ph = d.h
      if (p && p.id === d.id) {
        d.x = p.px + (p.body.x - p.px) * alpha + p.ox
        d.y = p.py + (p.body.y - p.py) * alpha + p.oy
        d.h = p.ph + angleDiff(p.body.h, p.ph) * alpha + p.oh
      } else {
        const s = d.s
        const ahead = Math.min(0.25, now - d.at)
        const tx = s.x + s.vx * ahead
        const ty = s.y + s.vy * ahead
        const th = s.h + s.w * ahead
        if (Math.hypot(tx - d.x, ty - d.y) > 6) {
          d.x = tx
          d.y = ty
          d.h = th
        } else {
          d.x += (tx - d.x) * k
          d.y += (ty - d.y) * k
          d.h += angleDiff(th, d.h) * k
        }
      }
      if (dt > 0) {
        const vx = (d.x - px) / dt
        const vy = (d.y - py) / dt
        const kv = 1 - Math.exp(-dt * 10)
        d.vx += (vx - d.vx) * kv
        d.vy += (vy - d.vy) * kv
        d.w += (angleDiff(d.h, ph) / dt - d.w) * kv
      }
    }
  }

  /**
   * Draws them: bodies, wheels, lamps and light bars as parts; their lights, round shadow casters, a soft contact
   * shadow, skid marks, exhaust, smoke and fire. `teamColor` is the colour of the team holding a vehicle, or null.
   */
  emit(t: number, dt: number, push: PartFn, sprite: SpriteFn, fx: FxFn, dyn: DynLight[], casters: Caster[], teamColor: (d: VehDraw) => Rgb3 | null, begin: ((d: VehDraw) => void) | undefined, juice: Juice, solids: readonly Rect[], eye: ArrayLike<number>): void {
    this.fx.update(dt); this.emissions.update(dt)
    this.emissions.skids = juice.vehicleSkids ? this.fx : null
    const sharedSprite: SpriteSink = (list, x, y, z, size, r, g, b, a, kind, rot = 0, stretch = 1, extra = 0) => sprite(list === "d", x, y, z, size, r, g, b, a, kind + 32, rot, stretch, extra)
    for (const d of this.draws.values()) { begin?.(d); this.draw(d, t, dt, push, sprite, fx, dyn, casters, teamColor(d), juice, solids, eye, sharedSprite) }
    const counts = this.fx.emit(this.alpha, 0, this.add, 0, 3000, juice.vehicleSkids)
    this.emissions.emit(this.alpha, counts.alpha, this.add, counts.add, 3000, true)
    for (const [data, count, list] of [[this.alpha, this.emissions.alphaCount, "a"], [this.add, this.emissions.addCount, "d"]] as const) {
      for (let i = 0; i < count; i++) {
        const o = i * 12, p = data
        sharedSprite(list, p[o]!, p[o + 1]!, p[o + 2]!, p[o + 3]!, p[o + 4]!, p[o + 5]!, p[o + 6]!, p[o + 7]!, p[o + 8]!, p[o + 9]!, p[o + 10]!, p[o + 11]!)
      }
    }
    this.emissions.trail.prepare()
    this.renderer.setSmoke?.(this.emissions.trail, juice.tyreSmoke)
  }

  private draw(d: VehDraw, t: number, dt: number, push: PartFn, sprite: SpriteFn, fx: FxFn, dyn: DynLight[], casters: Caster[], team: Rgb3 | null, juice: Juice, solids: readonly Rect[], eye: ArrayLike<number>, sharedSprite: SpriteSink): void {
    const s = d.s
    const M = this.models[d.kind]
    const L = LAMPS[d.kind]
    const spec = d.spec
    const wreck = !!s.wreck
    const driven = !wreck && !!s.seats[0]
    const occupied = !wreck && s.seats.some(Boolean)
    const vf = forwardSpeed(d)
    const speed = Math.hypot(d.vx, d.vy)
    d.vf = vf
    d.flash = Math.max(0, d.flash - dt * 6)
    const visual = d.presentation
    visual.update(d, dt, juice.vehicleSprings && !wreck)
    d.roll = visual.chassis.roll.x; d.pitch = visual.chassis.pitch.x
    const idle = driven ? Math.sin(t * 40 + d.id) * 0.004 : 0
    visual.pose.height = (visual.pose.height ?? 0) + idle
    visual.part(push, wreck ? M.wreck : M.body, visual.pose, [1, 1, 1], wreck ? 0 : d.flash * 0.06)
    if (juice.vehicleWheels) visual.wheels(push, M.wheel)
    // Contact shadow.
    sprite(false, d.x, 0.011, d.y, spec.length * 0.55, 0, 0, 0, wreck ? 0.75 : 0.55, 4, d.h, spec.width / spec.length)
    const [hl] = [spec.length / 2]
    // Shadows: a row of round casters down the body (the shadow pass only knows rects on the grid and circles).
    const cr = spec.width * 0.42
    const n = Math.max(1, Math.round((spec.length - spec.width * 0.4) / (cr * 1.3)))
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0 : (i / (n - 1) - 0.5) * (spec.length - cr * 2.1)
      const c = localToWorld(d, f, 0)
      casters.push({ x: c.x, y: c.y, r: cr, h: d.kind === "van" ? 1.8 : d.kind === "jeep" ? 0.95 : 0.7 })
    }
    if (wreck) {
      // Burning: flames licking up out of it, black smoke, an orange flicker on everything around.
      const flick = 0.75 + 0.25 * Math.sin(t * 23 + d.id) * Math.sin(t * 7.3)
      dyn.push({ x: d.x, y: d.y, h: 1.6, r: 9, color: [1, 0.5, 0.18], power: 1.2 * flick, size: 0.4, near: spec.length * 0.5 })
      // Steady flames on the bodywork, and a column of black smoke drifting up off it.
      const top = d.kind === "van" ? 1.9 : d.kind === "jeep" ? 1.0 : 0.6
      for (let i = 0; i < (d.kind === "scooter" ? 1 : 3); i++) {
        const at = localToWorld(d, (i - 1) * hl * 0.55, ((i * 0.37) % 1 - 0.5) * spec.width * 0.4)
        const f = 0.7 + 0.3 * Math.sin(t * (11 + i * 3) + i * 2 + d.id)
        sprite(true, at.x, top + 0.15, at.y, 0.55 * f, 1.7, 0.55, 0.1, 0.75 * f, 0)
        sprite(true, at.x, top + 0.35, at.y, 0.3 * f, 1.9, 1.0, 0.4, 0.8 * f, 0)
      }
      d.smoke += dt * blackoutEffects.wreck.rate
      while (d.smoke > 1) {
        d.smoke--
        const at = localToWorld(d, (Math.random() - 0.5) * hl * 1.4, (Math.random() - 0.5) * spec.width * 0.6)
        if (Math.random() < 0.45) fx(at.x, at.y, top + Math.random() * 0.3, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 1.2, 0.35 + Math.random() * 0.3, 0.2 + Math.random() * 0.15, "fire")
        else fx(at.x, at.y, top + 0.4, (Math.random() - 0.5) * 0.3 + 0.25, (Math.random() - 0.5) * 0.3 - 0.15, 0.9 + Math.random() * 0.6, blackoutEffects.wreck.life + Math.random() * blackoutEffects.wreck.lifeSpread, blackoutEffects.wreck.size + Math.random() * blackoutEffects.wreck.sizeSpread, "char")
      }
      return
    }
    // Lamps: headlights and tail lights glow on the bodywork when someone's at the wheel; braking or reversing brightens the tail.
    const braking = driven && ((s.thr < 0 && vf > 0.5) || !!s.hb)
    const reversing = driven && vf < -0.5
    visual.part(push, M.lens, visual.pose, driven && juice.vehicleLamps ? [4, 3.7, 3.1] : [0.05, 0.05, 0.05])
    visual.part(push, M.tail, visual.pose, !juice.vehicleLamps ? [0.08, 0.01, 0.01] : braking ? [5, 0.25, 0.15] : reversing ? [3, 3, 3] : driven ? [1.4, 0.06, 0.04] : [0.08, 0.01, 0.01])
    const c = Math.cos(d.h)
    const sn = Math.sin(d.h)
    if (driven && juice.vehicleLamps) drawLamps(visual.view, visual.pose, visual.spec, juice, Number(braking), 0, 0, eye, groundHeight, sharedSprite,
      (x, h, y, r, red, green, blue, power, dx = 0, _dy = 0, dz = 0, cone = -2) => {
        const length = Math.hypot(dx, dz) || 1
        dyn.push({ x, y, h, r, color: [red, green, blue], power, size: 0.12, near: spec.length + 0.3,
          ...(cone > -1 ? { cone: [dx / length, dz / length, cone] as [number, number, number] } : {}) })
      })
    if (M.bar !== null && L.bar) {
      const col: Rgb3 = team ?? [1, 0.55, 0.1]
      const pulse = occupied ? 0.55 + 0.45 * Math.abs(Math.sin(t * 6 + d.id)) : 0.08
      visual.part(push, M.bar, visual.pose, [col[0] * 1.1 * pulse, col[1] * 1.1 * pulse, col[2] * 1.1 * pulse])
      if (occupied) {
        const at = localToWorld(d, L.bar[0], L.bar[1])
        dyn.push({ x: at.x, y: at.y, h: L.bar[2] + 0.6, r: 7, color: col, power: 0.14 * pulse, size: 0.2, near: spec.length })
        sprite(true, at.x, L.bar[2] + 0.05, at.y, 0.5, col[0] * 1.5, col[1] * 1.5, col[2] * 1.5, 0.6 * pulse, 0)
      }
    }
    // Exhaust, more on the throttle.
    if (driven) {
      d.puff += dt * (1.5 + Math.abs(s.thr) * 4)
      while (d.puff > 1) {
        d.puff--
        const at = localToWorld(d, -hl - 0.05, d.kind === "scooter" ? 0.1 : 0.55)
        fx(at.x, at.y, 0.3, -c * (0.5 + Math.random() * 0.5) + d.vx * 0.2, -sn * (0.5 + Math.random() * 0.5) + d.vy * 0.2, 0.2, 0.5 + Math.random() * 0.3, 0.045 + Math.abs(s.thr) * 0.03, "smoke")
      }
    }
    const pops = this.emissions.pops
    this.emissions.car(visual.view, visual.spec, visual.emissions, visual.input, dt, 0, juice.tyreSmoke || juice.vehicleSkids, juice.backfire)
    if (this.emissions.pops > pops) this.onPop?.(d)
    if (juice.backfire && visual.emissions.pop > 0) {
      const at = localToWorld(d, -hl - 0.2, 0)
      dyn.push({ x: at.x, y: at.y, h: 0.5, r: 2, color: [1, 0.3, 0.04], power: visual.emissions.pop / 0.11, size: 0.1, near: spec.length })
    }
    if (juice.vehicleSparks && speed > 3 && t - d.scrapeAt >= 0.05) {
      d.scrapeAt = t
      const contact = this.wallContact(d, spec, solids)
      if (contact) {
        const at = contact.points[0]!
        this.fx.sparks(at.x, at.y, -contact.nx, -contact.ny, 2, 0.24)
      }
    }
    // Hurt: smoke from the engine, and fire when it's nearly gone.
    const health = s.hp / spec.hp
    if (health < 0.45) {
      d.smoke += dt * (4 + (0.45 - health) * 40)
      while (d.smoke > 1) {
        d.smoke--
        const at = localToWorld(d, d.kind === "van" ? hl - 0.6 : hl * 0.55, (Math.random() - 0.5) * 0.4)
        const top = d.kind === "van" ? 1.1 : 1.0
        if (health < 0.2 && Math.random() < 0.35) fx(at.x, at.y, top, 0, 0, 0.8, 0.35, 0.16 + Math.random() * 0.1, "fire")
        else fx(at.x, at.y, top, (Math.random() - 0.5) * 0.3 + d.vx * 0.2, (Math.random() - 0.5) * 0.3 + d.vy * 0.2, 0.6, 1.6 + Math.random(), 0.14 + (0.45 - health) * 0.45, "char")
      }
    }
  }
}

/**
 * Keeps a rider's planted feet riding along with their vehicle: moves them by the seat's motion and turns them with the
 * vehicle, so the animation sees a soldier standing still on board instead of being dragged across the floor.
 */
export function carry(a: Avatar, from: { x: number; y: number; h: number }, to: { x: number; y: number; h: number }): void {
  const dh = angleDiff(to.h, from.h)
  const c = Math.cos(dh)
  const s = Math.sin(dh)
  const move = (p: [number, number, number]) => {
    const rx = p[0] - from.x
    const rz = p[2] - from.y
    p[0] = to.x + rx * c - rz * s
    p[2] = to.y + rx * s + rz * c
  }
  for (const f of a.feet) {
    move(f.p)
    move(f.lift)
    f.yaw += dh
    f.liftYaw += dh
  }
  a.legYaw += dh
  a.x = to.x
  a.y = to.y
}
