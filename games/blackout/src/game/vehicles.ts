import { DT, PLAYER_RADIUS } from "../../shared/config"
import { type Rect, angleDiff } from "../../shared/geom"
import type { Rigid } from "../../shared/sim/vehicle-collide"
import { VEH } from "../../shared/sim/vehicle-rules"
import { type VehicleKind, type VehicleSpec, VEHICLES, boxOf, collideCars, distToBox, driveOf, driveStep, forwardSpeed, lateralSpeed, localToWorld, pushOutBox, rayBox, speedOf } from "../../shared/sim/vehicle"
import type { Snapshot, VehicleView } from "../../shared/sim/view"
import type { Intent } from "../../shared/sim/world"
import type { Caster, DynLight } from "../render/lighting"
import type { Renderer } from "../render/renderer"
import { LAMPS, WHEELS, vehicleModels } from "../render/vehicle-mesh"
import type { Avatar } from "./anim"

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
}

/** The vehicle you drive, predicted: the body now, before the last tick, and a correction being blended out. */
type Pred = { id: number; body: Rigid; px: number; py: number; ph: number; ox: number; oy: number; oh: number }

type Mark = { x: number; y: number; rot: number; len: number; t0: number }

const SKID_LIFE = 9

/**
 * Vehicles on this client: dead-reckoned and smoothed from snapshots, the one you drive predicted with the shared
 * physics (inputs replayed on every snapshot, like your own body on foot), and drawn with spinning, steering wheels,
 * lamps that light the street, a team-coloured light bar, exhaust, skid marks, smoke when hurt and a burning wreck.
 */
export class VehicleFx {
  draws = new Map<number, VehDraw>()
  pred: Pred | null = null
  private models: Record<VehicleKind, { body: number; wreck: number; wheel: number; lens: number; tail: number; bar: number | null }>
  private marks: Mark[] = []
  private now = 0

  constructor(renderer: Renderer) {
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
    this.marks = []
  }

  ingest(s: Snapshot, now: number): void {
    this.now = now
    const live = new Set<number>()
    for (const v of s.vehicles ?? []) {
      live.add(v.id)
      let d = this.draws.get(v.id)
      // New, or back from a wreck at its spot: start it there.
      if (!d || (d.s.wreck && !v.wreck)) {
        d = { id: v.id, kind: v.kind, spec: VEHICLES[v.kind], x: v.x, y: v.y, h: v.h, vx: v.vx, vy: v.vy, w: v.w, s: v, at: now, spin: 0, steer: 0, roll: 0, pitch: 0, flash: 0, vf: 0, puff: 0, smoke: 0, skid: null }
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
    for (let i = 0; i < 6; i++) {
      const a = dir + Math.PI + (Math.random() - 0.5) * 2.2
      const s = 2 + Math.random() * 5
      fx(x, y, 0.6 + Math.random() * 0.6, Math.cos(a) * s, Math.sin(a) * s, 1 + Math.random() * 3, 0.15 + Math.random() * 0.2, 0.03, "spark")
    }
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
  emit(t: number, dt: number, push: PartFn, sprite: SpriteFn, fx: FxFn, dyn: DynLight[], casters: Caster[], teamColor: (d: VehDraw) => Rgb3 | null, begin?: (d: VehDraw) => void): void {
    this.marks = this.marks.filter((m) => t - m.t0 < SKID_LIFE)
    for (const m of this.marks) {
      const a = Math.min(1, (SKID_LIFE - (t - m.t0)) / 3) * 0.55
      sprite(false, m.x, 0.008, m.y, m.len, 0.015, 0.015, 0.018, a, 4, m.rot, 0.16 / Math.max(0.05, m.len))
    }
    for (const d of this.draws.values()) { begin?.(d); this.draw(d, t, dt, push, sprite, fx, dyn, casters, teamColor(d)) }
  }

  private draw(d: VehDraw, t: number, dt: number, push: PartFn, sprite: SpriteFn, fx: FxFn, dyn: DynLight[], casters: Caster[], team: Rgb3 | null): void {
    const s = d.s
    const M = this.models[d.kind]
    const L = LAMPS[d.kind]
    const spec = d.spec
    const wreck = !!s.wreck
    const driven = !wreck && !!s.seats[0]
    const occupied = !wreck && s.seats.some(Boolean)
    const vf = forwardSpeed(d)
    const lat = lateralSpeed(d)
    const speed = Math.hypot(d.vx, d.vy)
    const accel = dt > 0 ? (vf - d.vf) / dt : 0
    d.vf = vf
    const ke = 1 - Math.exp(-dt * 8)
    d.flash = Math.max(0, d.flash - dt * 6)
    const wheels = WHEELS[d.kind]
    d.spin += (vf * dt) / wheels[0]!.r
    d.steer += ((wreck ? 0 : s.steer * (d.kind === "scooter" ? 0.4 : 0.5)) - d.steer) * Math.min(1, dt * 12)
    // Bodies roll out of a turn on their springs, scooters lean into it; braking dips the nose, the throttle lifts it.
    const rollTo = wreck ? 0.03 : d.kind === "scooter" ? Math.max(-0.5, Math.min(0.5, d.w * speed * 0.045)) : Math.max(-0.08, Math.min(0.08, -d.w * speed * (d.kind === "van" ? 0.009 : 0.011)))
    const pitchTo = wreck ? -0.02 : Math.max(-0.05, Math.min(0.05, accel * (d.kind === "scooter" ? 0.002 : 0.004)))
    d.roll += (rollTo - d.roll) * ke
    d.pitch += (pitchTo - d.pitch) * ke
    const idle = driven ? Math.sin(t * 40 + d.id) * 0.004 : 0
    push(wreck ? M.wreck : M.body, d.x, idle, d.y, d.h, [1, 1, 1], d.pitch, d.roll, wreck ? 0 : d.flash * 0.06)
    for (const wh of wheels) {
      const at = localToWorld(d, wh.f, wh.s)
      push(M.wheel, at.x, wh.r, at.y, d.h + (wh.front ? d.steer : 0), [1, 1, 1], -d.spin, d.kind === "scooter" ? d.roll : 0, 0)
    }
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
      d.smoke += dt * 9
      while (d.smoke > 1) {
        d.smoke--
        const at = localToWorld(d, (Math.random() - 0.5) * hl * 1.4, (Math.random() - 0.5) * spec.width * 0.6)
        if (Math.random() < 0.45) fx(at.x, at.y, top + Math.random() * 0.3, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 1.2, 0.35 + Math.random() * 0.3, 0.2 + Math.random() * 0.15, "fire")
        else fx(at.x, at.y, top + 0.4, (Math.random() - 0.5) * 0.3 + 0.25, (Math.random() - 0.5) * 0.3 - 0.15, 0.9 + Math.random() * 0.6, 2.2 + Math.random() * 1.2, 0.3 + Math.random() * 0.2, "char")
      }
      return
    }
    // Lamps: headlights and tail lights glow on the bodywork when someone's at the wheel; braking or reversing brightens the tail.
    const braking = driven && ((s.thr < 0 && vf > 0.5) || !!s.hb)
    const reversing = driven && vf < -0.5
    push(M.lens, d.x, idle, d.y, d.h, driven ? [4, 3.7, 3.1] : [0.05, 0.05, 0.05], d.pitch, d.roll, 0)
    push(M.tail, d.x, idle, d.y, d.h, braking ? [5, 0.25, 0.15] : reversing ? [3, 3, 3] : driven ? [1.4, 0.06, 0.04] : [0.08, 0.01, 0.01], d.pitch, d.roll, 0)
    const c = Math.cos(d.h)
    const sn = Math.sin(d.h)
    if (driven) {
      const front = localToWorld(d, L.head[0]![0] + 0.25, 0)
      // The vehicle's own body doesn't shadow its lamps.
      const near = spec.length + 0.3
      dyn.push({ x: front.x, y: front.y, h: L.h, r: d.kind === "scooter" ? 11 : 15, color: [1, 0.9, 0.74], power: d.kind === "scooter" ? 1.3 : 1.9, size: 0.12, cone: [c, sn, Math.cos(d.kind === "scooter" ? 0.42 : 0.52)], near })
      if (braking && d.kind !== "scooter") {
        const back = localToWorld(d, L.tail[0]![0] - 0.4, 0)
        dyn.push({ x: back.x, y: back.y, h: 0.6, r: 3, color: [1, 0.12, 0.06], power: 0.3, size: 0.3, cone: [-c, -sn, 0.5], near })
      }
      for (const [f, sd] of L.head) {
        const at = localToWorld(d, f + 0.05, sd)
        sprite(true, at.x, L.h, at.y, 0.2, 1.4, 1.3, 1.1, 0.7, 0)
      }
    }
    for (const [f, sd] of L.tail) {
      if (!driven) break
      const at = localToWorld(d, f - 0.04, sd)
      sprite(true, at.x, L.h, at.y, braking ? 0.22 : 0.12, 1.5, 0.1, 0.05, braking ? 0.8 : 0.45, 0)
    }
    if (M.bar !== null && L.bar) {
      const col: Rgb3 = team ?? [1, 0.55, 0.1]
      const pulse = occupied ? 0.55 + 0.45 * Math.abs(Math.sin(t * 6 + d.id)) : 0.08
      push(M.bar, d.x, idle, d.y, d.h, [col[0] * 1.1 * pulse, col[1] * 1.1 * pulse, col[2] * 1.1 * pulse], d.pitch, d.roll, 0)
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
    // Skids: tyre smoke and black marks from the rear wheels while sliding.
    const sliding = Math.abs(lat) > 3.2 || (!!s.hb && speed > 4) || (s.thr < 0 && vf > 6)
    if (sliding && speed > 2) {
      const rear = wheels.filter((w) => !w.front)
      const marks: { x: number; y: number }[] = rear.map((w) => localToWorld(d, w.f, w.s))
      if (d.skid)
        marks.forEach((m, i) => {
          const p = d.skid![i]!
          const len = Math.hypot(m.x - p.x, m.y - p.y)
          if (len > 0.05 && len < 3) this.marks.push({ x: (m.x + p.x) / 2, y: (m.y + p.y) / 2, rot: Math.atan2(m.y - p.y, m.x - p.x), len: len / 2 + 0.04, t0: t })
        })
      d.skid = marks
      if (Math.random() < dt * 30) {
        const m = marks[Math.floor(Math.random() * marks.length)]!
        fx(m.x, m.y, 0.15, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, 0.3, 0.9 + Math.random() * 0.6, 0.18, "dust")
      }
      if (this.marks.length > 600) this.marks.splice(0, this.marks.length - 600)
    } else d.skid = null
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
