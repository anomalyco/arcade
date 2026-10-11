import { describe, expect, test } from "bun:test"
import {
  NEUTRAL_INPUT, cloneFlight, createFlightState, directionFromHeading, flightReadout, forward, quatFromYawPitchRoll, stepFlight, up,
} from "../src/sim/flight"
import { TICK_DT, type FlightInput, type FlightState, type Vec3, type VehicleKind, type WorldQuery } from "../src/sim/types"
import { VEHICLES } from "../src/sim/vehicles"

// Flat island at 10 m with a long runway; open water (0 m) outside.
const LAND = 10
const world: WorldQuery = {
  groundHeight: (x, z) => (Math.abs(x) < 8000 && Math.abs(z) < 8000 ? LAND : 0),
  onRunway: (x, z) => Math.abs(x) < 30 && z < 1000 && z > -7000,
  half: 60000,
  ceiling: 6000,
}

const JETS: VehicleKind[] = ["fighter", "warthog", "blackbird"]
const input = (o: Partial<FlightInput> = {}): FlightInput => ({ ...NEUTRAL_INPUT, ...o })
const run = (s: FlightState, inp: FlightInput | ((s: FlightState) => FlightInput), seconds: number) => {
  const n = Math.round(seconds / TICK_DT)
  for (let i = 0; i < n && !s.crashed; i++) stepFlight(s, typeof inp === "function" ? inp(s) : inp, TICK_DT, world)
}
const airStart = (kind: VehicleKind, alt = 1500, yaw = 0) => createFlightState(kind, { position: [0, alt, 0], yaw, onGround: false })
const runwayStart = (kind: VehicleKind) => createFlightState(kind, { position: [0, LAND + 2, 0], yaw: 0, onGround: true })
const heading = (s: FlightState) => flightReadout(s).heading
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180

function settleLevel(s: FlightState, seconds = 30, boost = false) {
  const aim = directionFromHeading(heading(s) * Math.PI / 180, 0)
  run(s, input({ aim, throttle: 1, boost }), seconds)
}

interface TurnResult { time: number; overshoot: number; finalErr: number; altLoss: number }
function turnTo(kind: VehicleKind, deltaDeg: number, seconds = 15): TurnResult {
  const s = airStart(kind)
  settleLevel(s, 20)
  const start = heading(s)
  const target = start + deltaDeg
  const aim = directionFromHeading(target * Math.PI / 180, 0)
  const alt0 = s.position[1]
  let time = -1, overshoot = 0, minAlt = alt0
  const n = Math.round(seconds / TICK_DT)
  for (let i = 0; i < n; i++) {
    stepFlight(s, input({ aim, throttle: 1 }), TICK_DT, world)
    const err = angDiff(heading(s), target) * Math.sign(deltaDeg) // >0 = past target
    if (time < 0 && Math.abs(err) < 3) time = (i + 1) * TICK_DT
    if (time >= 0) overshoot = Math.max(overshoot, err)
    minAlt = Math.min(minAlt, s.position[1])
  }
  return { time, overshoot, finalErr: Math.abs(angDiff(heading(s), target)), altLoss: alt0 - minAlt }
}

function sustainedTurn(kind: VehicleKind) {
  const s = airStart(kind)
  settleLevel(s, 20)
  // Keep the aim 90° right of the current heading: max-performance level turn.
  const step = () => input({ aim: directionFromHeading((heading(s) + 90) * Math.PI / 180, 0), throttle: 1 })
  run(s, step, 6)
  const h0 = heading(s)
  let total = 0, prev = h0
  run(s, st => { const h = heading(st); total += angDiff(h, prev); prev = h; return step() }, 4)
  const rate = (total / 4) * Math.PI / 180
  const speed = flightReadout(s).speed
  return { rateDeg: total / 4, radius: speed / Math.abs(rate), speed }
}

function takeoff(kind: VehicleKind) {
  const s = runwayStart(kind)
  const z0 = s.position[2]
  const aim = directionFromHeading(0, 10 * Math.PI / 180)
  let t = 0
  while (s.onGround && t < 60 && !s.crashed) { stepFlight(s, input({ aim, throttle: 1 }), TICK_DT, world); t += TICK_DT }
  return { distance: Math.abs(s.position[2] - z0), time: t, speed: flightReadout(s).speed, state: s }
}

function rollRate(kind: VehicleKind) {
  const s = airStart(kind)
  settleLevel(s, 10)
  let t = 0
  while (Math.abs(flightReadout(s).roll) < 90 && t < 5) { stepFlight(s, input({ roll: 1, throttle: 1 }), TICK_DT, world); t += TICK_DT }
  return { timeTo90: t, peakDeg: Math.abs(s.angularVelocity[2]) * 180 / Math.PI }
}

/** Direct (mouse-rate) steering: hold full yaw, ease off over the last stretch like a player would. */
function directTurn(kind: VehicleKind, deltaDeg = 90, seconds = 12) {
  const s = airStart(kind)
  settleLevel(s, 20)
  const target = heading(s) + deltaDeg
  const alt0 = s.position[1]
  let time = -1, overshoot = 0, maxAltDev = 0, maxBank = 0
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    const err = angDiff(target, heading(s)) * Math.sign(deltaDeg) // >0 = still to go
    const yaw = Math.sign(deltaDeg) * clamp01(err / 25)
    stepFlight(s, input({ yaw, throttle: 1 }), TICK_DT, world)
    const after = angDiff(heading(s), target) * Math.sign(deltaDeg)
    if (time < 0 && Math.abs(after) < 3) time = (i + 1) * TICK_DT
    if (time >= 0) overshoot = Math.max(overshoot, after)
    maxAltDev = Math.max(maxAltDev, Math.abs(s.position[1] - alt0))
    maxBank = Math.max(maxBank, Math.abs(flightReadout(s).roll))
  }
  return { time, overshoot, maxAltDev, maxBank, finalRoll: flightReadout(s).roll, finalErr: Math.abs(angDiff(heading(s), target)) }
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

function loopTime(kind: VehicleKind) {
  const s = airStart(kind, 2500)
  settleLevel(s, 10)
  const h0 = heading(s)
  let pitched = 0, t = 0, wentInverted = false
  while (pitched < 2 * Math.PI && t < 45 && !s.crashed) {
    stepFlight(s, input({ pitch: 1, throttle: 1 }), TICK_DT, world)
    pitched += s.angularVelocity[0] * TICK_DT
    if (up(s.orientation)[1] < -0.9) wentInverted = true
    t += TICK_DT
  }
  return { time: t, done: pitched >= 2 * Math.PI, wentInverted, headingDrift: Math.abs(angDiff(heading(s), h0)), crashed: s.crashed }
}

describe("jets: direct steering", () => {
  for (const kind of JETS) {
    test(`${kind}: yaw command makes a level coordinated 90° turn`, () => {
      const r = directTurn(kind)
      const aim = turnTo(kind, 90)
      expect(r.time).toBeGreaterThan(0)
      expect(r.time).toBeLessThan(aim.time * 1.35)
      expect(r.overshoot).toBeLessThan(6)
      expect(r.finalErr).toBeLessThan(3)
      expect(r.maxAltDev).toBeLessThan(40)
      expect(r.maxBank).toBeGreaterThan(40) // it actually banks into the turn
      expect(Math.abs(r.finalRoll)).toBeLessThan(10) // and rolls out when released
    })

    test(`${kind}: held pitch-up loops`, () => {
      const r = loopTime(kind)
      expect(r.crashed).toBeNull()
      expect(r.done).toBe(true)
      expect(r.wentInverted).toBe(true)
      expect(r.headingDrift).toBeLessThan(10)
    })

    test(`${kind}: release holds a climbing attitude`, () => {
      const s = airStart(kind, 2000)
      s.orientation = quatFromYawPitchRoll(0, 15 * Math.PI / 180, 0)
      s.velocity = [0, Math.sin(0.26) * VEHICLES[kind].cruise, -Math.cos(0.26) * VEHICLES[kind].cruise]
      run(s, input({ throttle: 1 }), 3)
      const r = flightReadout(s)
      expect(Math.abs(r.pitch - 15)).toBeLessThan(2)
      expect(Math.abs(r.roll)).toBeLessThan(2)
      expect(Math.abs(angDiff(r.heading, 0))).toBeLessThan(2)
    })

    test(`${kind}: inverted with no input stays inverted`, () => {
      const s = airStart(kind, 2000)
      s.orientation = quatFromYawPitchRoll(0, 0, Math.PI)
      run(s, input({ throttle: 1 }), 5)
      const r = flightReadout(s)
      expect(Math.abs(r.roll)).toBeGreaterThan(170)
      expect(s.crashed).toBeNull()
    })

    test(`${kind}: Q/E roll overrides auto-bank (barrel roll while turning)`, () => {
      const s = airStart(kind, 2000)
      let rolled = 0
      for (let i = 0; i < 60 * 6 && rolled < 2 * Math.PI; i++) {
        stepFlight(s, input({ yaw: 1, roll: 1, throttle: 1 }), TICK_DT, world)
        rolled -= s.angularVelocity[2] * TICK_DT
      }
      expect(rolled).toBeGreaterThanOrEqual(2 * Math.PI)
    })
  }
})

describe("helicopter: direct steering", () => {
  test("mouse Y cyclic tilts and holds, mouse X pedals, near-level release hovers", () => {
    const s = createFlightState("apache", { position: [0, 300, 0], yaw: 0, onGround: false })
    run(s, input({ pitch: -1 }), 0.3) // nose down
    run(s, input(), 0.5)
    const tilt = flightReadout(s).pitch
    expect(tilt).toBeLessThan(-15)
    run(s, input(), 6) // held: keeps flying forward
    expect(Math.abs(flightReadout(s).pitch - tilt)).toBeLessThan(1)
    expect(flightReadout(s).speed).toBeGreaterThan(20)
    run(s, input({ yaw: 1 }), 1)
    expect(angDiff(heading(s), 0)).toBeGreaterThan(60)
    run(s, input({ pitch: 1 }), 0.3)
    run(s, input({ brake: true }), 15)
    run(s, input(), 5)
    expect(Math.abs(flightReadout(s).pitch)).toBeLessThan(2)
    expect(flightReadout(s).speed).toBeLessThan(2)
  })
})

describe("jets", () => {
  for (const kind of JETS) {
    const spec = VEHICLES[kind]
    test(`${kind}: takeoff from runway`, () => {
      const r = takeoff(kind)
      expect(r.state.crashed).toBeNull()
      expect(r.state.onGround).toBe(false)
      expect(r.distance).toBeLessThan(1500)
      expect(r.speed).toBeGreaterThan(spec.stall * 0.85)
      // Climb out cleanly and retract gear.
      run(r.state, input({ aim: directionFromHeading(0, 10 * Math.PI / 180), throttle: 1 }), 15)
      expect(r.state.crashed).toBeNull()
      expect(flightReadout(r.state, world).agl).toBeGreaterThan(60)
      expect(r.state.gearDown).toBe(false)
    })

    test(`${kind}: takeoff with aim on the horizon auto-rotates`, () => {
      const s = runwayStart(kind)
      let t = 0
      while (s.onGround && t < 40) { stepFlight(s, input({ aim: [0, 0, -1], throttle: 1 }), TICK_DT, world); t += TICK_DT }
      expect(s.onGround).toBe(false)
      expect(Math.abs(s.position[2])).toBeLessThan(1200) // half a runway: spawns sit at its midpoint
      run(s, input({ aim: [0, 0, -1], throttle: 1 }), 5)
      expect(s.crashed).toBeNull()
      expect(s.onGround).toBe(false)
    })

    test(`${kind}: cruise and boost speeds`, () => {
      const s = airStart(kind)
      settleLevel(s, 60)
      expect(Math.abs(flightReadout(s).speed - spec.cruise) / spec.cruise).toBeLessThan(0.1)
      settleLevel(s, 60, true)
      expect(Math.abs(flightReadout(s).speed - spec.boost) / spec.boost).toBeLessThan(0.1)
      expect(s.crashed).toBeNull()
    })

    test(`${kind}: mouse-aim 90° right converges without oscillation`, () => {
      const r = turnTo(kind, 90)
      expect(r.time).toBeGreaterThan(0)
      expect(r.time).toBeLessThan(kind === "blackbird" ? 9 : 5)
      expect(r.overshoot).toBeLessThan(10)
      expect(r.finalErr).toBeLessThan(3)
      expect(r.altLoss).toBeLessThan(150)
    })

    test(`${kind}: aim directly behind recovers`, () => {
      const s = airStart(kind, 2000)
      settleLevel(s, 10)
      const back: Vec3 = forward(s.orientation).map(c => -c) as Vec3
      back[1] = 0
      const n = Math.hypot(back[0], back[2]); back[0] /= n; back[2] /= n
      run(s, input({ aim: back, throttle: 1 }), 20)
      const f = forward(s.orientation)
      const dot = f[0] * back[0] + f[1] * back[1] + f[2] * back[2]
      expect(s.crashed).toBeNull()
      expect(dot).toBeGreaterThan(Math.cos(5 * Math.PI / 180))
    })

    test(`${kind}: hands-off holds attitude`, () => {
      const s = airStart(kind)
      settleLevel(s, 10)
      const h0 = heading(s), a0 = s.position[1]
      run(s, input({ throttle: 0 }), 5)
      expect(Math.abs(angDiff(heading(s), h0))).toBeLessThan(2)
      expect(Math.abs(s.position[1] - a0)).toBeLessThan(30)
    })

    test(`${kind}: stall is forgiving`, () => {
      const s = airStart(kind, 2500)
      run(s, input({ pitch: 1, throttle: -1 }), 3) // zoom climb, chop throttle
      run(s, input({ pitch: 1, throttle: -1 }), 12) // keep pulling, airspeed bleeds away
      expect(s.crashed).toBeNull()
      run(s, input({ aim: directionFromHeading(0, -0.15), throttle: 1 }), 15)
      expect(s.crashed).toBeNull()
      expect(flightReadout(s).speed).toBeGreaterThan(spec.stall)
      expect(flightReadout(s).stalled).toBe(false)
    })
  }

  test("gentle runway landing is safe", () => {
    const s = createFlightState("fighter", { position: [0, LAND + 60, 2000], yaw: 0, onGround: false })
    s.velocity = [0, 0, -70]
    s.throttle = 0.3
    const glide = directionFromHeading(0, -2.5 * Math.PI / 180)
    let t = 0
    while (!s.onGround && !s.crashed && t < 60) {
      const flare = flightReadout(s, world).agl < 8
      stepFlight(s, input({ aim: flare ? directionFromHeading(0, -0.015) : glide }), TICK_DT, world)
      t += TICK_DT
    }
    expect(s.crashed).toBeNull()
    expect(s.onGround).toBe(true)
    expect(s.position[2]).toBeLessThan(1000) // on the runway
    run(s, input({ brake: true, throttle: -1 }), 20)
    expect(s.crashed).toBeNull()
    expect(flightReadout(s).speed).toBeLessThan(1)
  })

  test("crash into water", () => {
    const s = createFlightState("fighter", { position: [12000, 300, 0], yaw: 0, onGround: false })
    run(s, input({ aim: directionFromHeading(0, -0.6), throttle: 1 }), 30)
    expect(s.crashed).toBe("water")
    const frozen = cloneFlight(s)
    stepFlight(s, input({ throttle: 1 }), TICK_DT, world)
    expect(s).toEqual(frozen)
  })

  test("crash into terrain off-runway with gear up", () => {
    const s = createFlightState("fighter", { position: [3000, 400, 0], yaw: 0, onGround: false })
    run(s, input({ aim: directionFromHeading(0, -0.5), throttle: 1 }), 30)
    expect(s.crashed).toBe("terrain")
  })

  test("map boundary crashes, ceiling only pushes down", () => {
    const s = createFlightState("fighter", { position: [59900, 1000, 0], yaw: -Math.PI / 2, onGround: false })
    run(s, input({ throttle: 1 }), 5)
    expect(s.crashed).toBe("boundary")
    const c = createFlightState("blackbird", { position: [0, 5500, 0], yaw: 0, onGround: false })
    run(c, input({ aim: directionFromHeading(0, 0.6), throttle: 1, boost: true }), 40)
    expect(c.crashed).toBeNull()
    expect(c.position[1]).toBeLessThan(world.ceiling + 200)
  })
})

describe("helicopter", () => {
  test("lifts off and hovers at collective 0.5", () => {
    const s = createFlightState("apache", { position: [0, LAND + 2, 0], yaw: 0, onGround: true })
    run(s, input({ throttle: 1 }), 1.5)
    run(s, input(), 3)
    expect(s.onGround).toBe(false)
    // Settle collective to exactly 0.5 and verify altitude hold.
    s.throttle = 0.5
    run(s, input({ brake: true }), 3)
    const alt = s.position[1]
    run(s, input(), 10)
    expect(Math.abs(s.position[1] - alt)).toBeLessThan(2)
    expect(flightReadout(s).speed).toBeLessThan(1)
  })

  test("cruise, max speed and hover-hold kills drift", () => {
    const s = createFlightState("apache", { position: [0, 300, 0], yaw: 0, onGround: false })
    run(s, input({ aim: directionFromHeading(0, -25 * Math.PI / 180) }), 30)
    const cruise = flightReadout(s).speed
    expect(Math.abs(cruise - 75) / 75).toBeLessThan(0.1)
    run(s, input({ aim: directionFromHeading(0, -10 * Math.PI / 180), boost: true }), 30)
    const max = flightReadout(s).speed
    expect(Math.abs(max - 98) / 98).toBeLessThan(0.1)
    expect(Math.abs(s.position[1] - 300)).toBeLessThan(40)
    run(s, input({ brake: true }), 12)
    expect(flightReadout(s).speed).toBeLessThan(2)
    expect(Math.abs(flightReadout(s).pitch)).toBeLessThan(3)
  })

  test("yaws toward aim heading and strafes", () => {
    const s = createFlightState("apache", { position: [0, 300, 0], yaw: 0, onGround: false })
    run(s, input({ aim: directionFromHeading(Math.PI / 2, 0) }), 3)
    expect(Math.abs(angDiff(heading(s), 90))).toBeLessThan(3)
    run(s, input({ aim: directionFromHeading(Math.PI / 2, 0), roll: 1 }), 4)
    const v = s.velocity
    // Facing east, strafing right = moving south (+Z).
    expect(v[2]).toBeGreaterThan(10)
  })

  test("holding collective down lands softly (ground cushion), diving in fast crashes", () => {
    const s = createFlightState("apache", { position: [0, 200, 0], yaw: 0, onGround: false })
    run(s, input({ throttle: -1 }), 30)
    expect(s.crashed).toBeNull()
    expect(s.onGround).toBe(true)
    const d = createFlightState("apache", { position: [0, 120, 0], yaw: 0, onGround: false })
    run(d, input({ aim: directionFromHeading(0, -0.6), boost: true, throttle: -1 }), 30)
    expect(d.crashed).toBe("terrain")
  })

  test("collective released in the air returns to hover", () => {
    const s = createFlightState("apache", { position: [0, 200, 0], yaw: 0, onGround: false })
    run(s, input({ throttle: 1 }), 2)
    expect(s.velocity[1]).toBeGreaterThan(5)
    run(s, input(), 4)
    expect(Math.abs(s.velocity[1])).toBeLessThan(0.5)
    expect(s.throttle).toBeCloseTo(0.5, 5)
  })
})

test("determinism: identical runs are bit-identical", () => {
  const script = (i: number): FlightInput => input({
    aim: directionFromHeading(i * 0.003, Math.sin(i * 0.01) * 0.3),
    throttle: i < 200 ? 1 : 0, roll: i % 700 > 650 ? 1 : 0, boost: i % 500 > 400, brake: i % 900 > 870,
  })
  const go = (kind: VehicleKind) => {
    const s = kind === "apache" ? createFlightState(kind, { position: [0, LAND + 2, 0], yaw: 0.3, onGround: true }) : runwayStart(kind)
    for (let i = 0; i < 3000; i++) stepFlight(s, script(i), TICK_DT, world)
    return s
  }
  for (const kind of [...JETS, "apache"] as VehicleKind[]) {
    const a = go(kind), b = go(kind)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // Clone mid-flight and continue: same result as uninterrupted.
    const c = go(kind), d = cloneFlight(c)
    for (let i = 0; i < 100; i++) { stepFlight(c, script(i), TICK_DT, world); stepFlight(d, script(i), TICK_DT, world) }
    expect(JSON.stringify(c)).toBe(JSON.stringify(d))
  }
})

test("feel table", () => {
  const rows: Record<string, unknown>[] = []
  for (const kind of JETS) {
    const t90 = turnTo(kind, 90)
    const st = sustainedTurn(kind)
    const to = takeoff(kind)
    const rr = rollRate(kind)
    const dt90 = directTurn(kind)
    const lp = loopTime(kind)
    const cs = airStart(kind); settleLevel(cs, 60); const cruise = flightReadout(cs).speed
    settleLevel(cs, 60, true); const boost = flightReadout(cs).speed
    rows.push({
      kind, cruise: cruise.toFixed(0), boost: boost.toFixed(0),
      "t90 (s)": t90.time.toFixed(2), "overshoot°": t90.overshoot.toFixed(1), "altLoss": t90.altLoss.toFixed(0),
      "turn °/s": st.rateDeg.toFixed(1), "radius m": st.radius.toFixed(0), "turn spd": st.speed.toFixed(0),
      "takeoff m": to.distance.toFixed(0), "takeoff s": to.time.toFixed(1),
      "roll→90 (s)": rr.timeTo90.toFixed(2), "roll °/s": rr.peakDeg.toFixed(0),
      "direct t90 (s)": dt90.time.toFixed(2), "direct altΔ": dt90.maxAltDev.toFixed(0), "direct bank°": dt90.maxBank.toFixed(0),
      "loop (s)": lp.time.toFixed(1),
    })
  }
  console.table(rows)

  const h = createFlightState("apache", { position: [0, 300, 0], yaw: 0, onGround: false })
  run(h, input({ aim: directionFromHeading(0, -25 * Math.PI / 180) }), 40)
  const cruise = flightReadout(h).speed
  run(h, input({ aim: directionFromHeading(0, -25 * Math.PI / 180), boost: true }), 40)
  const max = flightReadout(h).speed
  let stop = 0
  while (flightReadout(h).speed > 2 && stop < 30) { stepFlight(h, input({ brake: true }), TICK_DT, world); stop += TICK_DT }
  let yaw90 = 0
  const target = directionFromHeading((heading(h) + 90) * Math.PI / 180, 0)
  const targetHeading = heading(h) + 90
  while (Math.abs(angDiff(heading(h), targetHeading)) > 3 && yaw90 < 10) {
    stepFlight(h, input({ aim: target }), TICK_DT, world)
    yaw90 += TICK_DT
  }
  run(h, input({ throttle: 1 }), 4)
  const climb = h.velocity[1]
  console.table([{ kind: "apache", cruise: cruise.toFixed(0), boost: max.toFixed(0), "hover-hold stop (s)": stop.toFixed(1), "yaw 90° (s)": yaw90.toFixed(2), "climb m/s": climb.toFixed(1) }])
})
