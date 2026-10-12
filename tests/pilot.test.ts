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
    this.input.setAim([0, 0, -1])
    this.input.mouseMode = "aim"
  }
  key(code: string, down: boolean) {
    winH[down ? "keydown" : "keyup"]({ code, target: null, repeat: false, preventDefault() {} })
  }
  aim: [number, number, number] = [0, 0, -1]
  /** One 60 Hz frame, mirroring game.ts: scheme → mouse role, nose, aim, sticks, flight input.
   *  Mouse speed in px/s (movementY > 0 = mouse pulled back), split over 2 events. */
  frame(mxPerS = 0, myPerS = 0) {
    const input = this.input
    const mode = input.pilotMouseMode(true)
    const nose = flight.forward(this.state.orientation)
    input.setNose(nose)
    input.setPose(this.state.orientation)
    if (mode !== input.mouseMode) {
      if (mode === "aim") input.setAim(nose)
      input.mouseMode = mode
    }
    for (let i = 0; i < 2; i++) winH.mousemove({ movementX: (mxPerS * FRAME) / 2, movementY: (myPerS * FRAME) / 2 })
    input.aimDir(this.aim as any)
    input.sampleSteering(FRAME, this.heli)
    const fi = input.flightInput([this.aim[0], this.aim[1], this.aim[2]], this.heli, null, this.buf)
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

const scheme = (name: string | undefined) => { (settings as any).controlScheme = name }

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
    for (let i = 0; i < 24; i++) s.sample(1 / 60)
    expect(Math.abs(s.value)).toBeLessThan(0.01)
    const spike = new SteerStick()
    spike.feed(50_000); spike.sample(1 / 60)
    expect(spike.value).toBeLessThanOrEqual(1)
    for (let i = 0; i < 24; i++) spike.sample(1 / 60)
    expect(Math.abs(spike.value)).toBeLessThan(0.01)
  })

  test("default scheme is mouse-aim (instructor); schemes exported", () => {
    scheme(undefined)
    expect(inputMod.controlScheme()).toBe("aim")
    expect(inputMod.CONTROL_SCHEMES).toEqual(["aim", "keys", "point", "battlefield"])
  })
})

describe("mouse-aim (instructor) mapping", () => {
  test("mouse moves the aim (not the stick); keys: Q/E roll, arrows pitch, A/D rudder (jet) / strafe (heli)", () => {
    scheme("aim")
    for (const kind of ["fighter", "apache"] as VehicleKind[]) {
      const heli = kind === "apache"
      const p = new Pilot(kind, 2000)
      p.run(0.2, 600, -300)
      expect(p.buf.aim).not.toBeNull()
      expect(p.input.aimYaw).toBeLessThan(-0.1) // aim moved right
      expect(p.input.aimPitch).toBeGreaterThan(0.05) // mouse away = aim up
      expect(p.buf.roll).toBe(0)
      expect(p.buf.pitch).toBe(0)
      p.key("KeyE", true); p.run(0.4); expect(p.buf.roll).toBeGreaterThan(0.9); p.key("KeyE", false); p.run(0.3)
      p.key("ArrowDown", true); p.run(0.4); expect(p.buf.pitch).toBeGreaterThan(0.9); p.key("ArrowDown", false); p.run(0.3)
      p.key("KeyD", true); p.run(0.4)
      if (heli) expect(p.buf.roll).toBeCloseTo(inputMod.HELI_STRAFE_ROLL, 2)
      else expect(p.buf.yaw).toBeGreaterThan(0.9)
      p.key("KeyD", false); p.run(0.4)
      expect(p.buf.roll).toBe(0); expect(p.buf.yaw).toBe(0); expect(p.buf.pitch).toBe(0)
    }
  })

  test("hold Alt (or toggle M) = manual: aim off, mouse X rolls, mouse away = nose up", () => {
    scheme("aim")
    const p = new Pilot("fighter", 2000)
    p.key("AltLeft", true)
    p.run(0.2, 300, -300)
    expect(p.buf.aim).toBeNull()
    expect(p.buf.roll).toBeGreaterThan(0.3)
    expect(p.buf.pitch).toBeGreaterThan(0.3)
    p.key("AltLeft", false)
    p.run(0.3)
    expect(p.buf.aim).not.toBeNull()
    p.key("KeyM", true); p.key("KeyM", false)
    expect(p.input.manual).toBe(true)
    p.key("KeyM", true); p.key("KeyM", false)
    expect(p.input.manual).toBe(false)
  })
})

describe("jet pilot (mouse-aim)", () => {
  test("flick the aim 90° right: banks, pulls, settles on the heading without oscillation", () => {
    scheme("aim")
    const p = new Pilot("fighter", 2000)
    p.state.throttle = 1
    const px = (Math.PI / 2) / 0.0021
    p.run(0.25, px / 0.25, 0)
    let maxBank = 0, t = 0, settled = -1, over = 0
    p.run(6, 0, 0, () => {
      t += FRAME
      maxBank = Math.max(maxBank, p.r.roll)
      const err = ((p.r.heading - 90 + 540) % 360) - 180
      if (settled < 0 && Math.abs(err) < 3) settled = t
      if (settled >= 0) over = Math.max(over, err)
    })
    expect(maxBank).toBeGreaterThan(40)
    expect(settled).toBeGreaterThan(0)
    expect(settled).toBeLessThan(3)
    expect(over).toBeLessThan(6)
    expect(Math.abs(p.r.roll)).toBeLessThan(8)
  })

  test("E = 360° barrel roll; holding ↓ loops (manual mastery over the instructor)", () => {
    scheme("aim")
    const p = new Pilot("fighter", 2500)
    p.state.throttle = 1
    let rolled = 0
    p.key("KeyE", true)
    p.run(2, 0, 0, () => { rolled -= p.state.angularVelocity[2] * FRAME })
    p.key("KeyE", false)
    expect(rolled).toBeGreaterThan(2 * Math.PI)
    const q = new Pilot("fighter", 2500)
    q.state.throttle = 1
    let pitched = 0
    q.key("ArrowDown", true)
    q.run(9, 0, 0, () => { pitched += q.state.angularVelocity[0] * FRAME })
    q.key("ArrowDown", false)
    expect(pitched).toBeGreaterThan(2 * Math.PI)
    expect(q.state.crashed).toBeNull()
  })

  test("keyboard roll ramps in over ~0.25 s (no snap)", () => {
    scheme("aim")
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

describe("optional schemes", () => {
  test("point & turn: mouse right turns right; let go and it flies straight", () => {
    scheme("point")
    try {
      const p = new Pilot("fighter", 2000)
      p.state.throttle = 1
      p.run(1.5, 400, 0)
      const h = p.r.heading
      expect(h).toBeGreaterThan(20)
      p.run(4)
      const h2 = p.r.heading
      p.run(2)
      expect(Math.abs(p.r.heading - h2)).toBeLessThan(3)
      expect(p.rate).toBeLessThan(0.05)
    } finally { scheme(undefined) }
  })

  test("battlefield: always manual — mouse X roll, A/D rudder, mouse away = nose down", () => {
    scheme("battlefield")
    try {
      const p = new Pilot("fighter")
      p.run(0.15, 400, -400)
      expect(p.buf.aim).toBeNull()
      expect(p.buf.roll).toBeGreaterThan(0.3)
      expect(p.buf.pitch).toBeLessThan(-0.3)
      p.key("KeyD", true); p.run(0.4); expect(p.buf.yaw).toBeGreaterThan(0.9); p.key("KeyD", false)
    } finally { scheme(undefined) }
  })
})

describe("helicopter pilot (mouse-aim)", () => {
  test("hands-off hover holds: drift < 1 m/s over 10 s", () => {
    scheme("aim")
    const p = new Pilot("apache")
    p.run(10)
    expect(p.speed).toBeLessThan(1)
    expect(Math.abs(p.state.position[1] - 1000)).toBeLessThan(2)
  })

  test("look down → forward, look up → back, look right → turns, X → hover", () => {
    scheme("aim")
    const p = new Pilot("apache")
    p.run(0.3, 0, 600) // mouse toward you = aim down
    let maxFwd = 0
    p.run(5, 0, 0, () => { maxFwd = Math.max(maxFwd, p.fwd) })
    expect(maxFwd).toBeGreaterThan(15)
    p.run(0.5, 0, -700) // aim above the horizon
    let minFwd = Infinity
    p.run(8, 0, 0, () => { minFwd = Math.min(minFwd, p.fwd) })
    expect(minFwd).toBeLessThan(-2)
    p.run(0.3, 600, 0)
    p.run(2.5)
    expect(p.r.heading).toBeGreaterThan(18) // 180 px of mouse ≈ 22° of aim
    p.key("KeyX", true); p.run(10); p.key("KeyX", false)
    expect(p.speed).toBeLessThan(2)
  })

  test("A/D strafes; E flips it; it rights itself", () => {
    scheme("aim")
    const p = new Pilot("apache", 1500)
    p.key("KeyD", true); p.run(2.5); p.key("KeyD", false)
    expect(p.r.roll).toBeGreaterThan(15)
    expect(p.state.velocity[0]).toBeGreaterThan(3)
    p.run(2)
    let minUp = 1
    p.key("KeyE", true)
    p.run(2, 0, 0, () => { minUp = Math.min(minUp, flight.up(p.state.orientation)[1]) })
    p.key("KeyE", false)
    expect(minUp).toBeLessThan(-0.7)
    p.run(4)
    expect(flight.up(p.state.orientation)[1]).toBeGreaterThan(0.9)
  })
})

describe("keyboard flight + mouse aim", () => {
  const press = (p: Pilot, code: string, sec: number, each?: () => void) => { p.key(code, true); p.run(sec, 0, 0, each); p.key(code, false) }

  test("keys fly: W nose down, S nose up, A/D roll, Q/E rudder; ramp ~0.12 s; flight aim is null", () => {
    scheme("keys")
    const p = new Pilot("fighter", 2000)
    p.key("KeyS", true); p.run(0.06)
    expect(p.buf.pitch).toBeGreaterThan(0.3); expect(p.buf.pitch).toBeLessThan(0.8)
    p.run(0.1); expect(p.buf.pitch).toBe(1); p.key("KeyS", false); p.run(0.3)
    p.key("KeyW", true); p.run(0.2); expect(p.buf.pitch).toBe(-1); p.key("KeyW", false); p.run(0.3)
    p.key("KeyD", true); p.run(0.2); expect(p.buf.roll).toBe(1); p.key("KeyD", false); p.run(0.3)
    p.key("KeyE", true); p.run(0.2); expect(p.buf.yaw).toBe(1); p.key("KeyE", false); p.run(0.3)
    expect(p.buf.aim).toBeNull()
  })

  test("Shift = throttle up + boost, Z = throttle down", () => {
    scheme("keys")
    const p = new Pilot("fighter", 2000)
    p.state.throttle = 0.5
    press(p, "ShiftLeft", 0.5)
    expect(p.state.throttle).toBeGreaterThan(0.75)
    press(p, "KeyZ", 0.5)
    expect(p.state.throttle).toBeLessThan(0.6)
  })

  test("hold S loops; D barrel-rolls 360°; roll + pull turns cleanly; release flies on with no wobble", () => {
    scheme("keys")
    const p = new Pilot("fighter", 2500)
    p.state.throttle = 1
    let pitched = 0
    press(p, "KeyS", 8, () => { pitched += p.state.angularVelocity[0] * FRAME })
    expect(pitched).toBeGreaterThan(2 * Math.PI)
    expect(p.state.crashed).toBeNull()
    const r = new Pilot("fighter", 2500)
    r.state.throttle = 1
    let rolled = 0
    press(r, "KeyD", 1.8, () => { rolled -= r.state.angularVelocity[2] * FRAME })
    expect(rolled).toBeGreaterThan(2 * Math.PI)
    const t = new Pilot("fighter", 2500)
    t.state.throttle = 1
    press(t, "KeyD", 0.3) // bank right
    expect(t.r.roll).toBeGreaterThan(45)
    press(t, "KeyS", 2.5) // pull
    expect(t.r.heading).toBeGreaterThan(60)
    expect(t.r.heading).toBeLessThan(200)
    const rolls: number[] = []
    t.run(2, 0, 0, () => rolls.push(t.r.roll))
    expect(Math.max(...rolls) - Math.min(...rolls)).toBeLessThan(6)
  })

  test("mouse moves a body-relative gun reticle clamped to the gimbal cone; it rides with the aircraft", () => {
    scheme("keys")
    const p = new Pilot("fighter", 2500)
    p.run(0.2, 300, 0) // a little right
    expect(p.input.reticleX).toBeGreaterThan(0.02)
    expect(p.input.reticleFrac).toBeLessThan(1)
    p.run(0.5, 5000, -5000) // shove it hard: clamps at the cone edge
    expect(p.input.reticleFrac).toBeCloseTo(1, 5)
    // World direction stays within the cone of the nose.
    const d = p.input.reticleDir([0, 0, 0]), f = flight.forward(p.state.orientation)
    const ang = Math.acos(d[0] * f[0] + d[1] * f[1] + d[2] * f[2])
    expect(ang).toBeLessThanOrEqual(inputMod.RETICLE_LIMIT + 1e-6)
    // It is body-relative: rolling the aircraft keeps the offset in the body frame.
    const before = [p.input.reticleX, p.input.reticleY]
    p.state.orientation = flight.quatFromYawPitchRoll(1, 0.2, 0.5)
    p.run(0.02)
    expect([p.input.reticleX, p.input.reticleY]).toEqual(before)
  })

  test("soft assist only beyond 70% of the cone; then it gently turns toward the reticle", () => {
    scheme("keys")
    const L = inputMod.RETICLE_LIMIT
    const inner = new Pilot("fighter", 2500)
    inner.input.reticleX = 0.6 * L
    inner.run(1)
    expect(inner.buf.yaw).toBe(0)
    expect(inner.buf.pitch).toBe(0)
    const outer = new Pilot("fighter", 2500)
    outer.state.throttle = 1
    outer.input.reticleX = 0.98 * L
    outer.run(3)
    expect(outer.buf.yaw).toBeGreaterThan(0.3)
    expect(outer.buf.yaw).toBeLessThan(0.7) // gentle — keys still own the aircraft
    expect(outer.r.heading).toBeGreaterThan(10)
    expect(Math.abs(outer.r.roll)).toBeLessThan(20)
    const up = new Pilot("fighter", 2500)
    up.input.reticleY = 0.95 * L
    up.run(0.5)
    expect(up.buf.pitch).toBeGreaterThan(0.2)
    // Keys override the assist on their axis.
    up.key("KeyW", true); up.run(0.3); expect(up.buf.pitch).toBe(-1); up.key("KeyW", false)
  })

  test("heli: W tilts forward, S back, A/D strafe, Q/E pedals, Space/Z collective, ←/→ flips; Space doesn't fire", () => {
    scheme("keys")
    const p = new Pilot("apache", 1500)
    p.run(5)
    expect(p.speed).toBeLessThan(1)
    press(p, "KeyW", 0.4)
    let maxFwd = 0
    p.run(3, 0, 0, () => { maxFwd = Math.max(maxFwd, p.fwd) })
    expect(maxFwd).toBeGreaterThan(4)
    p.key("KeyX", true); p.run(8); p.key("KeyX", false)
    p.key("KeyD", true); p.run(2.5)
    expect(p.r.roll).toBeGreaterThan(15)
    expect(p.state.velocity[0]).toBeGreaterThan(3)
    p.key("KeyD", false); p.run(3)
    press(p, "KeyE", 1)
    expect(p.r.heading).toBeGreaterThan(40)
    const c0 = p.state.throttle
    press(p, "Space", 0.3)
    expect(p.state.throttle).toBeGreaterThan(c0)
    expect(p.input.seatInput(null, { aim: null, firePrimary: false, fireSecondary: false, flares: false, ability: false }).firePrimary).toBe(false)
    press(p, "KeyZ", 0.6)
    expect(p.state.throttle).toBeLessThan(0.45)
    let minUp = 1
    press(p, "ArrowRight", 2, () => { minUp = Math.min(minUp, flight.up(p.state.orientation)[1]) })
    expect(minUp).toBeLessThan(-0.5)
  })
})

describe("bombardier bomb sight", () => {
  test("aims down within a ±35° cone, stabilized (heading only), mouse away = further ahead", () => {
    const input = new InputCls(canvas as any)
    input.setEnabled(true)
    docH.pointerlockchange?.({})
    winH.mousemove?.({ movementX: 0, movementY: 0 })
    input.mouseMode = "aim"
    input.setNose([0, 0, -1])
    input.setBombsight(true)
    const d: [number, number, number] = [0, 0, 0]
    input.aimDir(d as any)
    expect(d[1]).toBeLessThan(-0.85) // mostly down
    expect(d[2]).toBeLessThan(0) // leaning forward (north)
    const f0 = input.bombFwd
    winH.mousemove({ movementX: 0, movementY: -50 })
    expect(input.bombFwd).toBeGreaterThan(f0)
    for (let i = 0; i < 50; i++) winH.mousemove({ movementX: 300, movementY: -300 })
    expect(Math.hypot(input.bombFwd, input.bombSide)).toBeCloseTo(inputMod.BOMBSIGHT_CONE, 5)
    input.aimDir(d as any)
    expect(Math.acos(-d[1])).toBeLessThanOrEqual(inputMod.BOMBSIGHT_CONE + 1e-6)
    // Stabilized: only the heading matters (a nose pointing east swings the sight east).
    input.bombFwd = 0.3; input.bombSide = 0
    input.setNose([1, -0.2, 0])
    input.aimDir(d as any)
    expect(d[0]).toBeGreaterThan(0.2)
    expect(Math.abs(d[2])).toBeLessThan(1e-9)
    input.setBombsight(false)
  })
})
