import { DT, HEAD_START_SECONDS, INTRO_SECONDS, TICK_HZ, VEHICLE_BY_ID, type Role, type Vehicle } from "../../shared/config"
import type { ClientMsg, ServerMsg } from "../../shared/protocol"
import { quantizeInput } from "../../shared/protocol"
import type { Box, City } from "../../shared/sim/city"
import { propBox } from "../../shared/sim/gadgets"
import { type Body, type Input, collideBoxes, collideCars, lateralSpeed, newBody, speedOf, stepAndCollide, toggleEngine } from "../../shared/sim/vehicle"
import type { CarView, Phase, SimEvent, WorldView } from "../../shared/sim/world"
import { lerpView } from "./interp"

/** Other cars are drawn this far in the past so there are always two snapshots to blend between. */
export const INTERP_TICKS = Math.round(0.1 * TICK_HZ)
const MAX_PENDING = 3 * TICK_HZ
const SNAP_KEEP = TICK_HZ
/** Corrections bigger than this teleport instead of sliding. */
const SNAP_DIST = 6
/** Drawn corrections ease out at CORRECT_MIN per second when tiny, up to CORRECT_MAX at CORRECT_SPAN meters and more. */
const CORRECT_MIN = 6
const CORRECT_MAX = 14
const CORRECT_SPAN = 3
/** Other cars are only extrapolated this many ticks past the latest snapshot; beyond that they wait for news. */
const PROXY_TICKS = Math.round(0.5 * TICK_HZ)
/** Other cars within NEAR meters are drawn at their predicted pose (in step with your car); beyond FAR, interpolated. */
const NEAR = 10
const FAR = 28
/** After a predicted hit on another car, its server-side impact is ignored this long (the hit already played locally). */
const HIT_HOLD = 0.5

type Snap = { tick: number; view: WorldView }
type Pending = { seq: number; input: Input }
type Pose = { x: number; z: number; h: number }

/**
 * Another car as a collision obstacle for prediction: rebuilt from each snapshot and extrapolated tick by tick in step
 * with your predicted car. It coasts with its last velocity and yaw rate, and takes the push when you hit it.
 */
type Proxy = { id: number; role: Role; spec: Vehicle; body: Body; prev: Pose; age: number; impact: number }

const clone = (b: Body): Body => ({ ...b })
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

function ease(e: Pose, dt: number) {
  const m = Math.hypot(e.x, e.z)
  const k = Math.exp(-(CORRECT_MIN + (CORRECT_MAX - CORRECT_MIN) * Math.min(1, m / CORRECT_SPAN)) * dt)
  e.x *= k
  e.z *= k
  e.h *= k
}

/**
 * Transport-free client netcode: predicts your own car from local inputs, reconciles against acked server state,
 * and interpolates everything else from buffered snapshots. NetSession wraps it with a WebSocket.
 */
export class NetClient {
  seq = 0
  pending: Pending[] = []
  body: Body | null = null
  events: SimEvent[] = []
  private prevBody: Body | null = null
  private carId = -1
  private role: Role = "cop"
  private vehicle: Vehicle | null = null
  private phase: Phase = "intro"
  private phaseT = 0
  private snaps: Snap[] = []
  private est = 0
  private acc = 0
  private err: Pose = { x: 0, z: 0, h: 0 }
  private boxes: Box[]
  private proxies: Proxy[] = []
  private proxyErr = new Map<number, Pose>()
  /** Predicted impact speed of your car over the last two ticks (shown right away instead of a round trip later). */
  private impactNow = 0
  private impactPrev = 0
  /** Live predicted hits on other cars: client clock and impact speed. */
  private localHits = new Map<number, { at: number; impact: number }>()
  private clock = 0
  private replaying = false
  /** Engine key state the server last saw (edge detection for H presses), at the ack and live. */
  private ackEngine = false
  private engineHeld = false

  constructor(
    readonly city: City,
    public myId: string,
    private send: (msg: ClientMsg) => void,
  ) {
    this.boxes = city.boxes
  }

  get latest(): Snap | null {
    return this.snaps[this.snaps.length - 1] ?? null
  }

  /** The socket was replaced. The server forgets in-flight inputs, so drop them too. */
  resetStream() {
    this.pending = []
  }

  receive(msg: ServerMsg) {
    if (msg.type === "events") this.events.push(...msg.events)
    else if (msg.type === "snapshot") this.snapshot(msg)
  }

  private snapshot(msg: Extract<ServerMsg, { type: "snapshot" }>) {
    const last = this.latest
    if (last && msg.tick <= last.tick) return
    this.snaps.push({ tick: msg.tick, view: msg.view })
    while (this.snaps.length > SNAP_KEEP) this.snaps.shift()
    const d = msg.tick - this.est
    if (!last || Math.abs(d) > TICK_HZ / 2) this.est = msg.tick
    else this.est += d * 0.1
    const acked = this.pending.find((p) => p.seq === msg.ack)
    if (acked) this.ackEngine = !!acked.input.engine
    this.pending = this.pending.filter((p) => p.seq > msg.ack)
    this.reconcile(msg.view, msg.you)
  }

  /** Resets to the server's body for the last acked input, then replays everything still in flight. */
  private reconcile(view: WorldView, you: Body | null) {
    const car = view.cars.find((c) => c.ownerId === this.myId && !c.ghost)
    const spec = car ? VEHICLE_BY_ID.get(car.vehicle) : undefined
    if (!you || !car || !spec) {
      this.body = this.prevBody = null
      this.carId = -1
      this.err = { x: 0, z: 0, h: 0 }
      this.proxies = []
      this.proxyErr.clear()
      return
    }
    const before = this.body ? this.visual() : null
    const beforeProxies = new Map(this.proxies.map((p) => [p.id, this.proxyVisual(p)]))
    const fresh = car.id !== this.carId
    this.carId = car.id
    this.role = car.role
    this.vehicle = spec
    this.phase = view.phase
    this.phaseT = view.phaseT
    const props = (view.props ?? []).map(propBox).filter((b): b is Box => b !== null)
    this.boxes = props.length ? [...this.city.boxes, ...props] : this.city.boxes
    this.body = clone(you)
    this.prevBody = clone(you)
    this.engineHeld = this.ackEngine
    this.proxies = []
    for (const c of view.cars) {
      const s = VEHICLE_BY_ID.get(c.vehicle)
      if (c.id === car.id || c.ghost || c.ownerId === this.myId || !s) continue
      const body: Body = { ...newBody(c.x, c.z, c.h), vx: c.vx, vz: c.vz, yaw: c.yaw ?? 0 }
      this.proxies.push({ id: c.id, role: c.role, spec: s, body, prev: { x: c.x, z: c.z, h: c.h }, age: 0, impact: 0 })
    }
    this.proxies.sort((a, b) => a.id - b.id)
    this.replaying = true
    for (const p of this.pending) this.advance(p.input)
    this.replaying = false
    const errs = new Map<number, Pose>()
    if (!fresh)
      for (const p of this.proxies) {
        const was = beforeProxies.get(p.id)
        if (!was) continue
        const now = this.proxyVisual(p, false)
        const e = { x: was.x - now.x, z: was.z - now.z, h: wrap(was.h - now.h) }
        if (Math.hypot(e.x, e.z) < SNAP_DIST) errs.set(p.id, e)
      }
    this.proxyErr = errs
    if (!before || fresh) {
      this.err = { x: 0, z: 0, h: 0 }
      return
    }
    const after = this.visual()
    const ex = before.x - after.x
    const ez = before.z - after.z
    if (Math.hypot(ex, ez) > SNAP_DIST) this.err = { x: 0, z: 0, h: 0 }
    else this.err = { x: ex, z: ez, h: wrap(before.h - after.h) }
  }

  /** One predicted tick, following World.step: phase clock first, then drive or hold still. Waiting never advances on its own. */
  private advance(input: Input) {
    const b = this.body
    if (!b || !this.vehicle) return
    this.prevBody = clone(b)
    const press = !!input.engine && !this.engineHeld
    this.engineHeld = !!input.engine
    this.phaseT += DT
    if (this.phase === "end") return
    if (this.phase === "intro" && this.phaseT >= INTRO_SECONDS) {
      this.phase = "headstart"
      this.phaseT = 0
    } else if (this.phase === "headstart" && this.phaseT >= HEAD_START_SECONDS) {
      this.phase = "chase"
      this.phaseT = 0
    }
    const moving = this.phase === "waiting" || this.phase === "chase" || (this.phase === "headstart" && this.role === "robber")
    for (const p of this.proxies) this.coast(p)
    if (!moving) {
      b.vx *= 0.85
      b.vz *= 0.85
      return
    }
    if (press) toggleEngine(b)
    let impact = stepAndCollide(b, input, this.vehicle, DT, this.boxes)
    // Same order as World.stepCars: cars pair up by id, then anything shoved gets settled against the city.
    let touched = false
    for (const p of this.proxies) {
      p.impact = 0
      const fixed = !this.moves(p.role)
      const hit = p.id < this.carId ? collideCars(p.body, p.spec, b, this.vehicle, DT, fixed, false) : collideCars(b, this.vehicle, p.body, p.spec, DT, false, fixed)
      if (!hit) continue
      touched = true
      impact = Math.max(impact, hit.impact)
      p.impact = hit.impact
      if (!this.replaying) this.localHits.set(p.id, { at: this.clock, impact: hit.impact })
    }
    if (touched) collideBoxes(b, this.vehicle, this.boxes)
    this.impactPrev = this.impactNow
    this.impactNow = impact
  }

  /** Mirrors World.moving for the predicted phase. */
  private moves(role: Role) {
    return this.phase === "waiting" || this.phase === "chase" || (this.phase === "headstart" && role === "robber")
  }

  /** One tick of a proxy: it keeps its speed and yaw rate (its velocity turning with it) while it is moving this phase. */
  private coast(p: Proxy) {
    const k = p.body
    p.prev = { x: k.x, z: k.z, h: k.h }
    if (!this.moves(p.role) || ++p.age > PROXY_TICKS) {
      k.vx = k.vz = k.yaw = 0
      return
    }
    const dh = k.yaw * DT
    const c = Math.cos(dh)
    const s = Math.sin(dh)
    const vx = k.vx * c + k.vz * s
    k.vz = -k.vx * s + k.vz * c
    k.vx = vx
    k.h += dh
    k.x += k.vx * DT
    k.z += k.vz * DT
  }

  /** A proxy's pose blended between its last two ticks like your car, plus its decaying correction. */
  private proxyVisual(p: Proxy, withErr = true): Pose {
    const t = this.acc / DT
    const e = withErr ? this.proxyErr.get(p.id) : undefined
    return {
      x: p.prev.x + (p.body.x - p.prev.x) * t + (e?.x ?? 0),
      z: p.prev.z + (p.body.z - p.prev.z) * t + (e?.z ?? 0),
      h: p.prev.h + wrap(p.body.h - p.prev.h) * t + (e?.h ?? 0),
    }
  }

  /** Predicted pose for rendering: blended between the last two ticks plus the decaying correction. */
  private visual() {
    const b = this.body!
    const a = this.prevBody ?? b
    const t = this.acc / DT
    return {
      x: a.x + (b.x - a.x) * t + this.err.x,
      z: a.z + (b.z - a.z) * t + this.err.z,
      h: a.h + wrap(b.h - a.h) * t + this.err.h,
    }
  }

  /** Runs fixed 30 Hz input ticks (sending each input), then builds the view to draw. Null until the first snapshot. */
  update(dt: number, raw: Input): WorldView | null {
    this.est += dt * TICK_HZ
    this.acc = Math.min(this.acc + dt, 0.25)
    const input = quantizeInput(raw)
    while (this.acc >= DT) {
      this.acc -= DT
      const seq = ++this.seq
      this.send({ type: "input", seq, input })
      this.pending.push({ seq, input })
      if (this.pending.length > MAX_PENDING) this.pending.shift()
      this.advance(input)
    }
    this.clock += dt
    ease(this.err, dt)
    for (const e of this.proxyErr.values()) ease(e, dt)
    return this.view()
  }

  /** Snapshots bracketing (estimated server tick - INTERP_TICKS), blended, with your predicted car merged in. */
  view(): WorldView | null {
    const latest = this.latest
    if (!latest) return null
    const target = this.est - INTERP_TICKS
    let a = this.snaps[0]!
    let b = a
    for (const s of this.snaps) {
      if (s.tick <= target) a = s
      b = s
      if (s.tick >= target) break
    }
    let view = a === b ? b.view : lerpView(a.view, b.view, Math.max(0, Math.min(1, (target - a.tick) / (b.tick - a.tick))))
    if (view.round !== latest.view.round) view = latest.view
    return this.merge(view, latest.view)
  }

  private merge(view: WorldView, latest: WorldView): WorldView {
    const b = this.body
    if (!b) return view
    const base = view.cars.find((c) => c.id === this.carId) ?? latest.cars.find((c) => c.id === this.carId)
    if (!base) return view
    const p = this.visual()
    const impact = Math.max(this.impactNow, this.impactPrev)
    const mine: CarView = { ...base, x: p.x, z: p.z, h: p.h, vx: b.vx, vz: b.vz, speed: speedOf(b), drift: lateralSpeed(b), stun: b.stun, boost: b.boostFuel, flat: b.flat ?? 0, ghost: false, impact }
    mine.engineOff = !!b.engineOff
    const proxies = new Map(this.proxies.map((q) => [q.id, q]))
    const cars = view.cars.filter((c) => c.ownerId !== this.myId || c.id === this.carId).map((c) => (c.id === this.carId ? mine : this.near(c, p, proxies.get(c.id))))
    if (!cars.includes(mine)) cars.push(mine)
    return { ...view, cars }
  }

  /**
   * Other cars near yours are drawn where the prediction has them, in step with your car, so they touch on screen when
   * they touch in the prediction; farther away they fade back to the smoother interpolated pose.
   */
  private near(c: CarView, me: Pose, proxy: Proxy | undefined): CarView {
    if (!proxy || c.ghost) return c
    const hit = this.localHits.get(c.id)
    const held = hit && this.clock - hit.at < HIT_HOLD
    const q = this.proxyVisual(proxy)
    const w = Math.max(0, Math.min(1, (FAR - Math.hypot(q.x - me.x, q.z - me.z)) / (FAR - NEAR)))
    if (w <= 0 && !held) return c
    const out = { ...c, x: c.x + (q.x - c.x) * w, z: c.z + (q.z - c.z) * w, h: c.h + wrap(q.h - c.h) * w }
    if (held) out.impact = this.clock - hit.at < 2 * DT ? hit.impact : 0
    return out
  }

  drainEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }
}
