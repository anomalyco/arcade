// Scripted "pilot" harness: drives the real Input class (with a fake DOM) → FlightInput → stepFlight,
// exactly the path the client uses, and checks that the controls behave predictably.
import { beforeAll, describe, expect, test } from "bun:test"
import type { FlightInput, FlightState, VehicleKind, WorldQuery } from "../src/sim/types"
import { TICK_DT } from "../src/sim/types"

type Handler = (e: any) => void
const winH: Record<string, Handler> = {}
const docH: Record<string, Handler> = {}
const canvas = { requestPointerLock() {} }
;(globalThis as any).window ??= {}
Object.assign((globalThis as any).window, {
  addEventListener: (t: string, f: Handler) => { winH[t] = f },
  removeEventListener() {},
})
;(globalThis as any).document ??= {}
Object.assign((globalThis as any).document, {
  addEventListener: (t: string, f: Handler) => { docH[t] = f },
  removeEventListener() {},
  pointerLockElement: canvas,
  exitPointerLock() {},
})

let InputCls: typeof import("../src/input").Input
let SteerStick: typeof import("../src/input").SteerStick
let flight: typeof import("../src/sim/flight")
let settings: typeof import("../src/ui/settings").settings

beforeAll(async () => {
  ;({ Input: InputCls, SteerStick } = await import("../src/input"))
  flight = await import("../src/sim/flight")
  settings = (await import("../src/ui/settings")).settings
})

const world: WorldQuery = { groundHeight: () => 10, onRunway: () => true, half: 1e7, ceiling: 6000 }
const FRAME = 1 / 60

class Pilot {
  input: InstanceType<typeof InputCls>
  state: FlightState
  heli: boolean
  buf: FlightInput = { aim: null, throttle: 0, roll: 0, yaw: 0, pitch: 0, boost: false, brake: false }
  t = 0
  constructor(kind: VehicleKind, alt = 1000) {
    this.input = new InputCls(canvas as any)
    this.input.setEnabled(true)
    docH.pointerlockchange?.({})
    winH.mousemove?.({ movementX: 0, movementY: 0 }) // first delta after lock is dropped by design
    this.state = flight.createFlightState(kind, { position: [0, alt, 0], yaw: 0, onGround: false })
    this.heli = kind === "apache"
  }
  key(code: string, down: boolean) {
    winH[down ? "keydown" : "keyup"]({ code, target: null, repeat: false, preventDefault() {} })
  }
  /** One 60 Hz frame. Mouse speed in px/s (movementY > 0 = mouse pulled back), split over 2 events. */
  frame(mxPerS = 0, myPerS = 0) {
    for (let i = 0; i < 2; i++) winH.mousemove({ movementX: (mxPerS * FRAME) / 2, movementY: (myPerS * FRAME) / 2 })
    this.input.sampleSteering(FRAME, this.heli)
    const fi = this.input.flightInput(null, this.heli, null, this.buf)
    flight.stepFlight(this.state, fi, TICK_DT, world)
    this.t += FRAME
  }
  run(seconds: number, mx = 0, my = 0, each?: () => void) {
    for (let i = 0; i < Math.round(seconds / FRAME); i++) { this.frame(mx, my); each?.() }
  }
  get r() { return flight.flightReadout(this.state) }
  get speed() { return this.r.speed }
  /** Horizontal speed along the nose (negative = flying backwards). */
  get fwd() {
    const f = flight.forward(this.state.orientation), v = this.state.velocity, n = Math.hypot(f[0], f[2])
    return (v[0] * f[0] + v[2] * f[2]) / n
  }
  get rate() { const w = this.state.angularVelocity; return Math.hypot(w[0], w[1], w[2]) }
}

describe("stick (mouse → deflection)", () => {
  test("linear in mouse speed, re-centres within ~0.3 s, spikes clamped, frame-rate independent", () => {
    const at = (pxPerS: number, hz: number, seconds = 0.3) => {
      const s = new SteerStick()
      for (let i = 0; i < Math.round(seconds * hz); i++) { s.feed(pxPerS / hz); s.sample(1 / hz) }
      return s
    }
    const half = at(450, 60).value, full = at(900, 60).value
    expect(half).toBeCloseTo(0.5, 2)
    expect(full).toBeCloseTo(1, 1)
    expect(at(450, 144).value).toBeCloseTo(half, 2)
    expect(at(450, 30).value).toBeCloseTo(half, 1)
    const s = at(900, 60)
    for (let i = 0; i < 18; i++) s.sample(1 / 60) // 0.3 s with no motion
    expect(Math.abs(s.value)).toBeLessThan(0.01)
    const spike = new SteerStick()
    spike.feed(50_000); spike.sample(1 / 60)
    expect(spike.value).toBeLessThanOrEqual(1)
    for (let i = 0; i < 18; i++) spike.sample(1 / 60)
    expect(Math.abs(spike.value)).toBeLessThan(0.01)
  })

  test("mouse Y is flight-sim style by default (forward = nose down); Invert flips it", () => {
    const p = new Pilot("fighter")
    p.run(0.2, 0, -600) // mouse pushed forward
    expect(p.buf.pitch).toBeLessThan(-0.3)
    expect(p.state.angularVelocity[0]).toBeLessThan(0)
    settings.invertY = true
    const q = new Pilot("fighter")
    q.run(0.2, 0, -600)
    expect(q.buf.pitch).toBeGreaterThan(0.3)
    settings.invertY = false
  })

  test("same mapping for every aircraft: mouse X → roll, A/D and Q/E → yaw, arrows → pitch/roll", () => {
    for (const kind of ["fighter", "apache"] as VehicleKind[]) {
      const p = new Pilot(kind)
      p.run(0.15, 600, 0)
      expect(p.buf.roll).toBeGreaterThan(0.3)
      expect(p.buf.yaw).toBe(0)
      p.run(0.5)
      p.key("KeyD", true); p.run(0.3); expect(p.buf.yaw).toBeGreaterThan(0.9); p.key("KeyD", false)
      p.key("KeyQ", true); p.run(0.3); expect(p.buf.yaw).toBeLessThan(-0.9); p.key("KeyQ", false)
      p.key("ArrowUp", true); p.run(0.3); expect(p.buf.pitch).toBeLessThan(-0.9); p.key("ArrowUp", false)
      p.key("ArrowLeft", true); p.run(0.3); expect(p.buf.roll).toBeLessThan(-0.9); p.key("ArrowLeft", false)
      p.run(0.5)
      expect(p.buf.roll).toBe(0)
      expect(p.buf.pitch).toBe(0)
      expect(p.buf.yaw).toBe(0)
    }
  })
})

describe("helicopter pilot", () => {
  test("hands-off hover holds: drift < 1 m/s over 10 s", () => {
    const p = new Pilot("apache")
    p.run(10)
    expect(p.speed).toBeLessThan(1)
    expect(Math.abs(p.state.position[1] - 1000)).toBeLessThan(1)
  })

  test("short mouse-X flick → bounded roll that stops within 0.3 s of the mouse stopping", () => {
    const p = new Pilot("apache")
    p.run(0.1, 1200, 0) // flick right
    let peakRate = 0
    p.run(0.3, 0, 0, () => { peakRate = Math.max(peakRate, p.rate) })
    const bank = p.r.roll
    expect(bank).toBeGreaterThan(3)
    expect(bank).toBeLessThan(30)
    expect(p.rate).toBeLessThan(Math.max(0.1, peakRate * 0.15))
    // …then it slowly comes back toward level by itself (2–3 s).
    p.run(3)
    expect(Math.abs(p.r.roll)).toBeLessThan(Math.abs(bank) * 0.2)
  })

  test("push forward → flies forward; pull back → stops and flies backwards; X → hovers", () => {
    const p = new Pilot("apache")
    p.run(0.35, 0, -900) // push mouse forward: nose down
    expect(p.r.pitch).toBeLessThan(-15)
    let maxFwd = 0
    p.run(3, 0, 0, () => { maxFwd = Math.max(maxFwd, p.fwd) })
    expect(maxFwd).toBeGreaterThan(5)
    // Pull back (nose up) and keep nudging back to hold it: the heli slows, then reverses.
    let minFwd = Infinity
    p.run(0.5, 0, 700)
    p.run(4, 0, 90, () => { minFwd = Math.min(minFwd, p.fwd) })
    expect(minFwd).toBeLessThan(-3)
    p.key("KeyX", true)
    p.run(8)
    p.key("KeyX", false)
    expect(p.speed).toBeLessThan(1)
    expect(Math.abs(p.r.pitch)).toBeLessThan(3)
    expect(Math.abs(p.r.roll)).toBeLessThan(3)
  })

  test("roll right slides right, pedals yaw without rolling", () => {
    const p = new Pilot("apache")
    p.run(0.2, 900, 0)
    p.run(1.5)
    // Nose north (-Z), right = +X.
    expect(p.state.velocity[0]).toBeGreaterThan(2)
    const q = new Pilot("apache")
    q.key("KeyD", true); q.run(1); q.key("KeyD", false)
    expect(Math.abs(q.r.roll)).toBeLessThan(2)
    expect(q.r.heading).toBeGreaterThan(45)
    expect(q.r.heading).toBeLessThan(120)
  })
})

describe("jet pilot", () => {
  test("roll right then pull: turns right; release → stable, no wobble", () => {
    const p = new Pilot("fighter", 2000)
    p.state.throttle = 1
    p.run(0.3, 700, 0) // roll right
    const bank = p.r.roll
    expect(bank).toBeGreaterThan(35)
    p.run(2.5, 0, 500) // keep pulling the mouse back = pull
    const h = p.r.heading
    expect(h).toBeGreaterThan(40)
    expect(h).toBeLessThan(180)
    p.run(0.3, -700, 0) // roll out
    p.run(1)
    const rolls: number[] = []
    p.run(3, 0, 0, () => rolls.push(p.r.roll))
    expect(p.rate).toBeLessThan(0.02)
    expect(Math.max(...rolls) - Math.min(...rolls)).toBeLessThan(3)
    expect(Math.abs(p.r.roll)).toBeLessThan(20)
  })

  test("release mid-manoeuvre holds attitude (no self-rolling)", () => {
    const p = new Pilot("warthog", 2000)
    p.state.throttle = 1
    p.run(0.25, 600, 0)
    p.run(0.5)
    const bank = p.r.roll
    p.run(3)
    expect(Math.abs(p.r.roll - bank)).toBeLessThan(2)
  })
})
