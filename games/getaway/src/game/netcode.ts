import { Glide, SnapshotBuffer } from "@arcade/kit/net/interpolate"
import { OptimisticEvents } from "@arcade/kit/net/prediction"
import { DT, GADGETS, HEAD_START_SECONDS, INTRO_SECONDS, LOADOUT, TICK_HZ, VEHICLE_BY_ID, type GadgetId, type Role, type Vehicle } from "../../shared/config"
import type { ClientMsg, ServerMsg } from "../../shared/protocol"
import { quantizeInput } from "../../shared/protocol"
import type { Box, City } from "../../shared/sim/city"
import { propBox } from "../../shared/sim/gadgets"
import { type Body, type Input, collideBoxes, collideCars, lateralSpeed, newBody, speedOf, stepAndCollide, stepHeight, toggleEngine } from "../../shared/sim/vehicle"
import { MAX_STRIPS, SURVIVAL, type CarView, type Phase, type SimEvent, type WorldView } from "../../shared/sim/world"
import { lerpView } from "./interp"
import { crossTunnel } from "../../shared/sim/tunnel"

/** Other cars are drawn 80–100 ms in the past so there are always two snapshots to blend between. */
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

export type Snap = { tick: number; view: WorldView }
export const remoteBuffer = (): SnapshotBuffer<Snap> => new SnapshotBuffer<Snap>(0.1, SNAP_KEEP, 0.25, { min: 0.08, max: 0.1 })

export type GetawayOptimisticKind = "gadget" | "engine" | "boost" | "landing"
export type GetawayOptimisticPayload = {
  slot?: 0 | 1
  gadgetId?: GadgetId
  prevCharges?: number
  engineOff?: boolean
  prevFuel?: number
}

type Pending = { seq: number; input: Input }
type Pose = { x: number; z: number; h: number; y?: number; tunnels?: number }

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
  e.y = (e.y ?? 0) * k
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
  readonly optimistic = new OptimisticEvents<GetawayOptimisticKind, GetawayOptimisticPayload>()
  private prevBody: Body | null = null
  private carId = -1
  private role: Role = "cop"
  private vehicle: Vehicle | null = null
  private phase: Phase = "intro"
  private phaseT = 0
  private buf = remoteBuffer()
  private glides = new Map<number, Glide>()
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
  /** Engine and gadget key state the server last saw (edge detection for H and Q/E presses), at the ack and live. */
  private ackEngine = false
  private engineHeld = false
  private ackGadget: 0 | 1 | null = null
  private gadgetHeld: 0 | 1 | null = null
  private predictedGadgetCd: [number, number] = [0, 0]
  private predictedGadgetCharges: [number | null, number | null] = [null, null]

  constructor(
    readonly city: City,
    public myId: string,
    private send: (msg: ClientMsg) => void,
  ) {
    this.boxes = city.boxes
  }

  get latest(): Snap | null {
    return this.buf.latest ?? null
  }

  /** The socket was replaced. The server forgets in-flight inputs, so drop them too. */
  resetStream() {
    this.pending = []
    this.optimistic.reset()
    this.buf.clear()
    this.glides.clear()
  }

  receive(msg: ServerMsg) {
    if (msg.type === "events") {
      for (const e of msg.events) {
        if (e.carId === this.carId && e.kind === "gadget" && this.optimistic.confirmWhere((p) => p.kind === "gadget")) continue
        if (e.carId === this.carId && e.kind === "landing" && this.optimistic.confirmWhere((p) => p.kind === "landing")) continue
        this.events.push(e)
      }
    } else if (msg.type === "snapshot") {
      this.snapshot(msg)
    }
  }

  private snapshot(msg: Extract<ServerMsg, { type: "snapshot" }>) {
    const last = this.latest
    if (last && msg.tick <= last.tick) return
    if (last && msg.view.round !== last.view.round) {
      this.buf.clear()
      this.glides.clear()
    }
    this.buf.push(msg.tick * DT, { tick: msg.tick, view: msg.view }, this.clock)
    const acked = this.pending.find((p) => p.seq === msg.ack)
    if (acked) {
      this.ackEngine = !!acked.input.engine
      this.ackGadget = acked.input.gadget ?? null
    }
    this.pending = this.pending.filter((p) => p.seq > msg.ack)
    this.reconcile(msg.view, msg.you, msg.ack)
  }

  /** Resets to the server's body for the last acked input, then replays everything still in flight. */
  private reconcile(view: WorldView, you: Body | null, ack = 0) {
    const car = view.cars.find((c) => c.ownerId === this.myId && !c.ghost)
    const spec = car ? VEHICLE_BY_ID.get(car.vehicle) : undefined
    if (!you || !car || !spec) {
      this.body = this.prevBody = null
      this.carId = -1
      this.err = { x: 0, z: 0, h: 0 }
      this.proxies = []
      this.proxyErr.clear()
      this.optimistic.reset()
      return
    }
    const before = this.body ? this.visual() : null
    const beforeProxies = new Map(this.proxies.map((p) => [p.id, this.proxyVisual(p)]))
    const fresh = car.id !== this.carId
    if (fresh) {
      this.optimistic.reset()
      this.predictedGadgetCd = [car.gadgets?.[0]?.cooldown ?? 0, car.gadgets?.[1]?.cooldown ?? 0]
      this.predictedGadgetCharges = [car.gadgets?.[0]?.charges ?? null, car.gadgets?.[1]?.charges ?? null]
    }
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
    this.gadgetHeld = this.ackGadget
    this.proxies = []
    for (const c of view.cars) {
      const s = VEHICLE_BY_ID.get(c.vehicle)
      if (c.id === car.id || c.ghost || c.ownerId === this.myId || !s) continue
      const body: Body = { ...newBody(c.x, c.z, c.h), tunnels: c.tunnels ?? 0, y: c.y ?? 0, vy: c.vy ?? 0, airborne: c.airborne ?? false, vx: c.vx, vz: c.vz, yaw: c.yaw ?? 0 }
      this.proxies.push({ id: c.id, role: c.role, spec: s, body, prev: { x: c.x, z: c.z, h: c.h, y: c.y ?? 0 }, age: 0, impact: 0 })
    }
    this.proxies.sort((a, b) => a.id - b.id)
    this.replaying = true
    for (const p of this.pending) this.advance(p.input, p.seq)
    this.replaying = false
    const isConfirmed = (ev: { kind: GetawayOptimisticKind; payload: GetawayOptimisticPayload }) => {
      if (ev.kind === "gadget") {
        const slot = ev.payload.slot ?? 0
        const sg = car.gadgets?.[slot]
        const spec = ev.payload.gadgetId ? GADGETS[ev.payload.gadgetId] : undefined
        if (!sg || !spec) return false
        return sg.charges < (ev.payload.prevCharges ?? sg.charges) || sg.cooldown >= spec.cooldown - 0.25
      }
      if (ev.kind === "engine") return Boolean(you.engineOff) === Boolean(ev.payload.engineOff)
      if (ev.kind === "boost") return Boolean(you.boosting) || Boolean(this.body?.boosting) || you.boostFuel < (ev.payload.prevFuel ?? 1) - 1e-4
      return true
    }
    while (this.optimistic.confirmWhere((ev) => ev.seq <= ack && isConfirmed(ev))) {
      // Confirm all predictions whose server effect is already visible at `ack`.
    }
    // `socketJitter` bridges brief stalls with stand-ins before carrying late edges forward,
    // so only reject once `ack` has passed the bridge window without the server applying the action.
    this.optimistic.reconcile(ack - 4, isConfirmed)
    for (const slot of [0, 1] as const) {
      if (!this.optimistic.hasPending("gadget", `gadget:${slot}`)) {
        const sg = car.gadgets?.[slot]
        this.predictedGadgetCd[slot] = sg?.cooldown ?? 0
        this.predictedGadgetCharges[slot] = sg ? sg.charges : null
      }
    }
    const errs = new Map<number, Pose>()
    if (!fresh)
      for (const p of this.proxies) {
        const was = beforeProxies.get(p.id)
        if (!was) continue
        const now = this.proxyVisual(p, false)
        const e = { x: was.x - now.x, z: was.z - now.z, h: wrap(was.h - now.h), y: (was.y ?? 0) - (now.y ?? 0) }
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
    else this.err = { x: ex, z: ez, h: wrap(before.h - after.h), y: before.y - after.y }
  }

  /** One predicted tick, following World.step: phase clock first, then drive or hold still. Waiting never advances on its own. */
  private advance(input: Input, seq = this.seq) {
    const b = this.body
    if (!b || !this.vehicle) return
    this.prevBody = clone(b)
    if (!this.replaying) {
      for (const slot of [0, 1] as const) {
        if (this.predictedGadgetCd[slot] > 0) this.predictedGadgetCd[slot] = Math.max(0, this.predictedGadgetCd[slot] - DT)
      }
    }
    const press = !!input.engine && !this.engineHeld
    this.engineHeld = !!input.engine
    const g = input.gadget ?? null
    const gadgetPress = g !== null && g !== this.gadgetHeld ? g : null
    this.gadgetHeld = g
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
    if (press) {
      toggleEngine(b)
      if (!this.replaying) {
        const nextOff = !!b.engineOff
        this.optimistic.predict({
          seq,
          kind: "engine",
          key: "engine",
          payload: { engineOff: nextOff },
          reapply: () => {
            if (this.body) this.body.engineOff = nextOff
          },
          rollback: () => {
            if (this.body) this.body.engineOff = !nextOff
          },
        })
      }
    }
    if (!this.replaying && gadgetPress !== null) {
      this.predictGadget(gadgetPress, seq)
    }
    const wasBoosting = !!b.boosting
    const prevFuel = b.boostFuel
    let impact = stepAndCollide(b, input, this.vehicle, DT, this.boxes, undefined, this.city.ramps)
    if (!this.replaying && !wasBoosting && b.boosting) {
      this.optimistic.predict({
        seq,
        kind: "boost",
        key: "boost",
        payload: { prevFuel },
        rollback: () => {
          if (this.body) this.body.boosting = false
        },
      })
    }
    if (!this.replaying && b.landing > 0) {
      this.events.push({ t: this.latest?.view.t ?? 0, kind: "landing", text: "", carId: this.carId, impact: b.landing })
      this.optimistic.predict({
        seq,
        kind: "landing",
        key: "landing",
        payload: {},
      })
    }
    if (b.tunnels !== this.prevBody.tunnels) {
      this.prevBody = clone(b)
      this.err = { x: 0, z: 0, h: 0 }
    }
    // Same order as World.stepCars: cars pair up by id, then anything shoved gets settled against the city.
    let touched = false
    for (const p of this.proxies) {
      p.impact = 0
      // Cops pass through each other (mirrors World.stepCars).
      if (p.role === "cop" && this.role === "cop") continue
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

  private predictGadget(rawSlot: 0 | 1, seq: number) {
    const slot: 0 | 1 = SURVIVAL ? 0 : rawSlot
    const gid = LOADOUT[this.role][slot]
    if (SURVIVAL && (this.role !== "cop" || gid !== "spike")) return
    const phaseOk = this.role === "cop" ? this.phase === "chase" : (this.phase === "headstart" || this.phase === "chase") && !this.latest?.view.busted
    if (!phaseOk) return
    const cd = this.predictedGadgetCd[slot]
    if (cd > 0.05) return
    const spec = GADGETS[gid]
    const prevCharges = this.predictedGadgetCharges[slot] ?? (SURVIVAL && gid === "spike" ? MAX_STRIPS : spec.charges)
    if (prevCharges <= 0 && !(SURVIVAL && gid === "spike")) return
    this.predictedGadgetCd[slot] = spec.cooldown
    this.predictedGadgetCharges[slot] = Math.max(0, prevCharges - 1)
    const carName = this.latest?.view.cars.find((c) => c.id === this.carId)?.name ?? "Unit"
    this.events.push({ t: this.latest?.view.t ?? 0, kind: "gadget", text: `${carName} deployed ${spec.name}`, carId: this.carId })
    this.optimistic.predict({
      seq,
      kind: "gadget",
      key: `gadget:${slot}`,
      payload: { slot, gadgetId: gid, prevCharges },
      rollback: () => {
        this.predictedGadgetCd[slot] = 0
        this.predictedGadgetCharges[slot] = prevCharges
      },
    })
  }

  /** Mirrors World.moving for the predicted phase. */
  private moves(role: Role) {
    return this.phase === "waiting" || this.phase === "chase" || (this.phase === "headstart" && role === "robber")
  }

  /** One tick of a proxy: it keeps its speed and yaw rate (its velocity turning with it) while it is moving this phase. */
  private coast(p: Proxy) {
    const k = p.body
    p.prev = { x: k.x, z: k.z, h: k.h, y: k.y }
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
    stepHeight(k, this.city.ramps, DT)
    if (crossTunnel(k)) {
      p.prev = { ...k }
      this.proxyErr.delete(p.id)
    }
  }

  /** A proxy's pose blended between its last two ticks like your car, plus its decaying correction. */
  private proxyVisual(p: Proxy, withErr = true): Pose {
    const t = this.acc / DT
    const e = withErr ? this.proxyErr.get(p.id) : undefined
    return {
      x: p.prev.x + (p.body.x - p.prev.x) * t + (e?.x ?? 0),
      y: (p.prev.y ?? 0) + (p.body.y - (p.prev.y ?? 0)) * t + (e?.y ?? 0),
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
      y: a.y + (b.y - a.y) * t + (this.err.y ?? 0),
      z: a.z + (b.z - a.z) * t + this.err.z,
      h: a.h + wrap(b.h - a.h) * t + this.err.h,
    }
  }

  /** Runs fixed 30 Hz input ticks (sending each input), then builds the view to draw. Null until the first snapshot. */
  update(dt: number, raw: Input): WorldView | null {
    this.acc = Math.min(this.acc + dt, 0.25)
    const input = quantizeInput(raw)
    while (this.acc >= DT) {
      this.acc -= DT
      const seq = ++this.seq
      this.send({ type: "input", seq, input })
      this.pending.push({ seq, input })
      if (this.pending.length > MAX_PENDING) this.pending.shift()
      this.advance(input, seq)
    }
    this.clock += dt
    ease(this.err, dt)
    for (const e of this.proxyErr.values()) ease(e, dt)
    return this.view(dt)
  }

  /** Snapshots bracketing the adaptive time-stretched render time, blended, with your predicted car merged in. */
  view(dt = 0): WorldView | null {
    const latest = this.latest
    if (!latest) return null
    const sample = this.buf.sample(this.clock)
    if (!sample) return this.merge(latest.view, latest.view)
    const { a, b, t, over } = sample
    const span = Math.max(0, (b.tick - a.tick) * DT)
    let view =
      span <= 0
        ? over > 0
          ? lerpView(b.view, b.view, 1, 0, over)
          : b.view
        : lerpView(a.view, b.view, t, span, over)
    if (view.round !== latest.view.round) {
      view = latest.view
      this.glides.clear()
    } else {
      view = this.applyGlides(view, dt)
    }
    return this.merge(view, latest.view)
  }

  private applyGlides(view: WorldView, dt: number): WorldView {
    let changed = false
    const cars = view.cars.map((c) => {
      if (c.id === this.carId || c.ownerId === this.myId) return c
      if (c.ghost) {
        this.glides.get(c.id)?.reset()
        return c
      }
      let g = this.glides.get(c.id)
      if (!g) {
        g = new Glide(10, 4)
        this.glides.set(c.id, g)
      }
      if (dt > 0) g.step(c.x, c.z, c.vx, c.vz, dt)
      if (Math.abs(g.x) < 1e-4 && Math.abs(g.y) < 1e-4) return c
      changed = true
      return { ...c, x: c.x + g.x, z: c.z + g.y }
    })
    return changed ? { ...view, cars } : view
  }

  private merge(view: WorldView, latest: WorldView): WorldView {
    const b = this.body
    if (!b) return view
    const base = view.cars.find((c) => c.id === this.carId) ?? latest.cars.find((c) => c.id === this.carId)
    if (!base) return view
    const p = this.visual()
    const impact = Math.max(this.impactNow, this.impactPrev)
    const mine: CarView = { ...base, x: p.x, z: p.z, h: p.h, vx: b.vx, vz: b.vz, speed: speedOf(b), drift: lateralSpeed(b), stun: b.stun, boost: b.boostFuel, wheels: b.wheels ?? 0, ghost: false, impact }
    Object.assign(mine, { tunnels: b.tunnels, y: Math.max(0, p.y), vy: b.vy, airborne: b.airborne, landing: b.landing, landings: b.landings, braking: b.braking, boosting: b.boosting })
    mine.engineOff = !!b.engineOff
    const latestMine = latest.cars.find((c) => c.id === this.carId) ?? base
    if (latestMine.gadgets) {
      mine.gadgets = latestMine.gadgets.map((g, i) => {
        const slot = (i === 1 ? 1 : 0) as 0 | 1
        if (!this.optimistic.hasPending("gadget", `gadget:${slot}`)) return g
        const cooldown = Math.max(g.cooldown, this.predictedGadgetCd[slot])
        const charges = this.predictedGadgetCharges[slot] ?? g.charges
        const phaseOk = mine.role === "cop" ? this.phase === "chase" : (this.phase === "headstart" || this.phase === "chase") && !latest.busted
        const ready = (!SURVIVAL || (mine.role === "cop" && g.id === "spike")) && cooldown <= 0 && (charges > 0 || (SURVIVAL && g.id === "spike")) && phaseOk
        return { ...g, cooldown, charges, ready }
      })
    }
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
    if ((c.tunnels ?? 0) !== proxy.body.tunnels || Math.hypot(q.x - c.x, q.z - c.z) > 100) return { ...c, ...q, tunnels: proxy.body.tunnels }
    const w = Math.max(0, Math.min(1, (FAR - Math.hypot(q.x - me.x, q.z - me.z)) / (FAR - NEAR)))
    if (w <= 0 && !held) return c
    const out = { ...c, x: c.x + (q.x - c.x) * w, z: c.z + (q.z - c.z) * w, h: c.h + wrap(q.h - c.h) * w }
    out.y = Math.max(0, (c.y ?? 0) + ((q.y ?? 0) - (c.y ?? 0)) * w)
    if (held) out.impact = this.clock - hit.at < 2 * DT ? hit.impact : 0
    return out
  }

  drainEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }
}
