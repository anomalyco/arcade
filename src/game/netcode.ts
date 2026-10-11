import { DT, HEAD_START_SECONDS, INTRO_SECONDS, TICK_HZ, VEHICLE_BY_ID, type Role, type Vehicle } from "../../shared/config"
import type { ClientMsg, ServerMsg } from "../../shared/protocol"
import { quantizeInput } from "../../shared/protocol"
import type { Box, City } from "../../shared/sim/city"
import { propBox } from "../../shared/sim/gadgets"
import { type Body, type Input, lateralSpeed, speedOf, stepAndCollide } from "../../shared/sim/vehicle"
import type { CarView, Phase, SimEvent, WorldView } from "../../shared/sim/world"
import { lerpView } from "./interp"

/** Other cars are drawn this far in the past so there are always two snapshots to blend between. */
export const INTERP_TICKS = Math.round(0.1 * TICK_HZ)
const MAX_PENDING = 3 * TICK_HZ
const SNAP_KEEP = TICK_HZ
/** Corrections bigger than this teleport instead of sliding. */
const SNAP_DIST = 8
const CORRECT_RATE = 10

type Snap = { tick: number; view: WorldView }
type Pending = { seq: number; input: Input }

/** Mirrors World.radiusOf for a vehicle spec. */
export function radiusOfVehicle(v: Vehicle) {
  return Math.max(1.1, v.length * 0.42)
}

const clone = (b: Body): Body => ({ ...b })
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

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
  private err = { x: 0, z: 0, h: 0 }
  private boxes: Box[]

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
      return
    }
    const before = this.body ? this.visual() : null
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
    for (const p of this.pending) this.advance(p.input)
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
    if (!moving) {
      b.vx *= 0.85
      b.vz *= 0.85
      return
    }
    stepAndCollide(b, input, this.vehicle, DT, radiusOfVehicle(this.vehicle), this.boxes)
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
    const k = Math.exp(-CORRECT_RATE * dt)
    this.err.x *= k
    this.err.z *= k
    this.err.h *= k
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
    const mine: CarView = { ...base, x: p.x, z: p.z, h: p.h, vx: b.vx, vz: b.vz, speed: speedOf(b), drift: lateralSpeed(b), stun: b.stun, boost: b.boostFuel, flat: b.flat ?? 0, ghost: false }
    const cars = view.cars.filter((c) => c.ownerId !== this.myId || c.id === this.carId).map((c) => (c.id === this.carId ? mine : c))
    if (!cars.includes(mine)) cars.push(mine)
    return { ...view, cars }
  }

  drainEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }
}
