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
let inputMod: typeof import("../src/input")

beforeAll(async () => {
  inputMod = await import("../src/input")
  ;({ Input: InputCls, SteerStick } = inputMod)
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
    const FULL = inputMod.STICK_FULL_SPEED
    const at = (pxPerS: number, hz: number, seconds = 0.4) => {
      const s = new SteerStick()
      for (let i = 0; i < Math.round(seconds * hz); i++) { s.feed(pxPerS / hz); s.sample(1 / hz) }
      return s
    }
    const half = at(FULL / 2, 60).value
    expect(half).toBeCloseTo(0.5, 1)
    expect(at(FULL, 60).value).toBeCloseTo(1, 1)
    expect(at(FULL / 2, 144).value).toBeCloseTo(half, 2)
    expect(at(FULL / 2, 30).value).toBeCloseTo(half, 1)
    const s = at(FULL, 60)
    for (let i = 0; i < 24; i++) s.sample(1 / 60) // 0.4 s with no motion
    expect(Math.abs(s.value)).toBeLessThan(0.01)
    const spike = new SteerStick()
    spike.feed(50_000); spike.sample(1 / 60)
    expect(spike.value).toBeLessThanOrEqual(1)
    for (let i = 0; i < 24; i++) spike.sample(1 / 60)
    expect(Math.abs(spike.value)).toBeLessThan(0.01)
  })

  test("default sensitivity is ~1.8× the previous one (500 vs 900 px/s for full deflection)", () => {
    expect(inputMod.STICK_FULL_SPEED).toBe(500)
    expect(inputMod.controlScheme()).toBe("point")
    expect(inputMod.CONTROL_SCHEMES).toEqual(["point", "battlefield", "aim"])
  })

  test("point & turn: mouse away = nose up (shooter style); Invert flips it", () => {
    const p = new Pilot("fighter")
    p.run(0.2, 0, -400) // mouse moved up/away
    expect(p.buf.pitch).toBeGreaterThan(0.3)
    expect(p.state.angularVelocity[0]).toBeGreaterThan(0)
    settings.invertY = true
    const q = new Pilot("fighter")
    q.run(0.2, 0, -400)
    expect(q.buf.pitch).toBeLessThan(-0.3)
    settings.invertY = false
  })

  test("point & turn mapping: mouse X/←→ turn, Q/E roll, A/D rudder (jet) / strafe (heli)", () => {
    for (const kind of ["fighter", "apache"] as VehicleKind[]) {
      const heli = kind === "apache"
      const p = new Pilot(kind)
      p.run(0.15, 400, 0) // mouse right
      expect(p.buf.yaw).toBeGreaterThan(0.3) // = turn right
      expect(p.buf.roll).toBe(0)
      p.run(0.5)
      p.key("ArrowRight", true); p.run(0.4); expect(p.buf.yaw).toBeGreaterThan(0.9); p.key("ArrowRight", false)
      p.run(0.3)
      p.key("KeyE", true); p.run(0.4); expect(p.buf.roll).toBeGreaterThan(0.9); p.key("KeyE", false)
      p.run(0.3)
      p.key("KeyQ", true); p.run(0.4); expect(p.buf.roll).toBeLessThan(-0.9); p.key("KeyQ", false)
      p.run(0.3)
      p.key("KeyD", true); p.run(0.4)
      if (heli) { expect(p.buf.roll).toBeCloseTo(inputMod.HELI_STRAFE_ROLL, 2); expect(p.buf.yaw).toBe(0) }
      else { expect(p.buf.yaw).toBeGreaterThan(0.9); expect(p.buf.roll).toBe(0) }
      p.key("KeyD", false)
      p.key("ArrowUp", true); p.run(0.5); expect(p.buf.pitch).toBeLessThan(-0.9); p.key("ArrowUp", false)
      p.run(0.6)
      expect(p.buf.roll).toBe(0)
      expect(p.buf.pitch).toBe(0)
      expect(p.buf.yaw).toBe(0)
    }
  })

  test("battlefield scheme (optional): mouse X = roll, A/D = yaw, mouse away = nose down", () => {
    ;(settings as any).controlScheme = "battlefield"
    try {
      const p = new Pilot("fighter")
      p.run(0.15, 400, -400)
      expect(p.buf.roll).toBeGreaterThan(0.3)
      expect(p.buf.yaw).toBe(0)
      expect(p.buf.pitch).toBeLessThan(-0.3)
      p.key("KeyD", true); p.run(0.4); expect(p.buf.yaw).toBeGreaterThan(0.9); p.key("KeyD", false)
      p.run(0.3)
      p.key("KeyE", true); p.run(0.4); expect(p.buf.roll).toBeGreaterThan(0.9); p.key("KeyE", false)
    } finally {
      ;(settings as any).controlScheme = undefined
    }
  })
})

describe("helicopter pilot (point & turn)", () => {
  test("hands-off hover holds: drift < 1 m/s over 10 s", () => {
    const p = new Pilot("apache")
    p.run(10)
    expect(p.speed).toBeLessThan(1)
    expect(Math.abs(p.state.position[1] - 1000)).toBeLessThan(1)
  })

  test("mouse right turns the nose right in a hover, without drifting or flipping", () => {
    const p = new Pilot("apache")
    p.run(0.5, 400, 0)
    p.run(0.5)
    expect(p.r.heading).toBeGreaterThan(20)
    expect(p.r.heading).toBeLessThan(120)
    expect(Math.abs(p.r.roll)).toBeLessThan(5) // no bank when hovering
    p.run(2)
    expect(p.speed).toBeLessThan(1)
    expect(p.rate).toBeLessThan(0.05)
  })

  test("mouse down tilts forward and flies forward; up tilts back and flies backwards; X hovers", () => {
    const p = new Pilot("apache")
    p.run(0.4, 0, 500) // mouse pulled toward you = nose down
    expect(p.r.pitch).toBeLessThan(-15)
    let maxFwd = 0
    p.run(3, 0, 0, () => { maxFwd = Math.max(maxFwd, p.fwd) })
    expect(maxFwd).toBeGreaterThan(4)
    let minFwd = Infinity
    p.run(0.6, 0, -500) // mouse away = nose up
    p.run(4, 0, -60, () => { minFwd = Math.min(minFwd, p.fwd) })
    expect(minFwd).toBeLessThan(-3)
    p.key("KeyX", true); p.run(8); p.key("KeyX", false)
    expect(p.speed).toBeLessThan(1)
    expect(Math.abs(p.r.pitch)).toBeLessThan(3)
    expect(Math.abs(p.r.roll)).toBeLessThan(3)
  })

  test("A/D strafes: steady sideways tilt and slide, level again on release", () => {
    const p = new Pilot("apache")
    p.key("KeyD", true); p.run(2.5); p.key("KeyD", false)
    expect(p.r.roll).toBeGreaterThan(18)
    expect(p.r.roll).toBeLessThan(35)
    expect(p.state.velocity[0]).toBeGreaterThan(5) // nose north (-Z): right = +X
    p.run(3)
    expect(Math.abs(p.r.roll)).toBeLessThan(5)
  })

  test("turning in forward flight banks into the turn (style + coordination)", () => {
    const p = new Pilot("apache")
    p.state.orientation = flight.quatFromYawPitchRoll(0, -0.35, 0)
    p.state.velocity = [0, 0, -40]
    p.key("ArrowRight", true); p.run(1.2)
    expect(p.r.roll).toBeGreaterThan(8)
    p.key("ArrowRight", false)
  })
})

describe("helicopter: Q/E roll", () => {
  test("holding E flips the heli (full roll), releasing rights it, X recovers", () => {
    const p = new Pilot("apache", 1500)
    let minUp = 1
    p.key("KeyE", true)
    p.run(3.5, 0, 0, () => { minUp = Math.min(minUp, flight.up(p.state.orientation)[1]) })
    p.key("KeyE", false)
    expect(minUp).toBeLessThan(-0.7)
    p.key("KeyX", true); p.run(2.5); p.key("KeyX", false)
    expect(flight.up(p.state.orientation)[1]).toBeGreaterThan(0.85)
  })

  test("a short E tap does not flip it, and it rights itself", () => {
    const p = new Pilot("apache")
    p.key("KeyE", true); p.run(0.6); p.key("KeyE", false)
    expect(flight.up(p.state.orientation)[1]).toBeGreaterThan(0.3)
    p.run(3)
    expect(Math.abs(p.r.roll)).toBeLessThan(8)
  })
})

describe("helicopter: no accidental flips", () => {
  test("1.5 s of nose-down key does not flip it; releasing rights it", () => {
    const p = new Pilot("apache")
    p.key("ArrowUp", true); p.run(1.5); p.key("ArrowUp", false)
    expect(Math.abs(p.r.roll)).toBeLessThan(10) // a flip reads as roll ±180
    expect(p.r.pitch).toBeGreaterThan(-85)
    p.run(3)
    expect(Math.abs(p.r.pitch)).toBeLessThan(10)
  })

  test("holding nose-down long enough still flips it (flips are possible)", () => {
    const p = new Pilot("apache", 1500)
    let minUp = 1
    p.key("ArrowUp", true)
    p.run(5, 0, 0, () => { minUp = Math.min(minUp, flight.up(p.state.orientation)[1]) })
    p.key("ArrowUp", false)
    expect(minUp).toBeLessThan(-0.5)
  })

  test("released while inverted: gentle righting; X recovers quickly", () => {
    const p = new Pilot("apache", 2000)
    p.state.orientation = flight.quatFromYawPitchRoll(0, 0.3, Math.PI * 0.97)
    p.run(2)
    const upAfter2 = flight.up(p.state.orientation)[1]
    expect(upAfter2).toBeGreaterThan(-0.97)
    expect(upAfter2).toBeLessThan(0.5)
    const q = new Pilot("apache", 2000)
    q.state.orientation = flight.quatFromYawPitchRoll(0, 0.3, Math.PI * 0.97)
    q.key("KeyX", true); q.run(2); q.key("KeyX", false)
    expect(flight.up(q.state.orientation)[1]).toBeGreaterThan(0.85)
  })

  test("releasing W at full collective eases back to hover in ~1.5 s", () => {
    const p = new Pilot("apache")
    p.key("KeyW", true); p.run(1); p.key("KeyW", false)
    expect(p.state.throttle).toBe(1)
    p.run(1.6)
    expect(p.state.throttle).toBeCloseTo(0.5, 2)
    p.run(4)
    expect(Math.abs(p.state.velocity[1])).toBeLessThan(2)
  })
})

describe("jet pilot (point & turn)", () => {
  test("mouse right → turns right with auto-bank, level; release → rolls out, stable, no wobble", () => {
    const p = new Pilot("fighter", 2000)
    p.state.throttle = 1
    const alt0 = p.state.position[1]
    let maxBank = 0
    p.run(2.5, 350, 0, () => { maxBank = Math.max(maxBank, p.r.roll) })
    expect(maxBank).toBeGreaterThan(40)
    expect(p.r.heading).toBeGreaterThan(40)
    expect(p.r.heading).toBeLessThan(150)
    expect(Math.abs(p.state.position[1] - alt0)).toBeLessThan(40)
    p.run(4)
    const rolls: number[] = []
    p.run(2, 0, 0, () => rolls.push(p.r.roll))
    expect(Math.abs(p.r.roll)).toBeLessThan(5)
    expect(p.rate).toBeLessThan(0.03)
    expect(Math.max(...rolls) - Math.min(...rolls)).toBeLessThan(3)
  })

  test("small mouse moves turn gently, big moves turn hard", () => {
    const turned = (pxPerS: number) => {
      const p = new Pilot("fighter", 2000)
      p.state.throttle = 1
      p.run(1.5, pxPerS, 0)
      return p.r.heading
    }
    const gentle = turned(100), hard = turned(600)
    expect(gentle).toBeGreaterThan(1)
    expect(gentle).toBeLessThan(hard / 2.5)
  })

  test("mouse away → nose up", () => {
    const p = new Pilot("fighter", 2000)
    p.run(0.5, 0, -300)
    expect(p.r.pitch).toBeGreaterThan(5)
  })

  test("E = full 360° barrel roll (overrides auto-bank), Q rolls left", () => {
    for (const [code, sign] of [["KeyE", 1], ["KeyQ", -1]] as const) {
      const p = new Pilot("fighter", 2000)
      p.state.throttle = 1
      let rolled = 0
      p.key(code, true)
      p.run(2.5, 0, 0, () => { rolled -= p.state.angularVelocity[2] * FRAME })
      p.key(code, false)
      expect(rolled * sign).toBeGreaterThan(2 * Math.PI)
    }
  })

  test("roll inverted with Q/E and let go: stays inverted (no forced auto-level)", () => {
    const p = new Pilot("fighter", 2000)
    p.state.throttle = 1
    p.key("KeyE", true)
    for (let i = 0; i < 300 && Math.abs(p.r.roll) < 175; i++) p.frame()
    p.key("KeyE", false)
    p.run(0.6)
    const r0 = Math.abs(p.r.roll)
    expect(r0).toBeGreaterThan(150)
    p.run(4)
    expect(Math.abs(p.r.roll)).toBeGreaterThan(150)
  })

  test("A/D = rudder: turns the jet", () => {
    const p = new Pilot("fighter", 2000)
    p.state.throttle = 1
    p.key("KeyD", true); p.run(2); p.key("KeyD", false)
    expect(p.r.heading).toBeGreaterThan(20)
    expect(p.r.heading).toBeLessThan(150)
  })

  test("keyboard roll ramps in over ~0.25 s (no snap)", () => {
    const p = new Pilot("fighter", 2000)
    p.key("KeyE", true)
    p.run(0.1)
    expect(p.buf.roll).toBeGreaterThan(0.25)
    expect(p.buf.roll).toBeLessThan(0.6)
    p.run(0.2)
    expect(p.buf.roll).toBe(1)
    p.key("KeyE", false)
  })
})
