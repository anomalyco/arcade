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

/** Direct steering, classic turn: roll into ~70° bank, pull, roll out near the target heading. */
function directTurn(kind: VehicleKind, deltaDeg = 90, seconds = 14) {
  const s = airStart(kind)
  settleLevel(s, 20)
  const target = heading(s) + deltaDeg
  const alt0 = s.position[1]
  let time = -1, overshoot = 0, maxAltDev = 0, maxBank = 0
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    const r = flightReadout(s)
    const err = angDiff(target, r.heading) * Math.sign(deltaDeg) // >0 = still to go
    // Like a player: bank harder if the nose climbs, pull while banked, roll out and re-trim the nose.
    const wantBank = Math.sign(deltaDeg) * Math.min(Math.max(50, Math.min(100, 75 + r.verticalSpeed * 3)), Math.max(0, err) * 3)
    const roll = Math.max(-1, Math.min(1, (wantBank - r.roll) * 0.03))
    const pull = Math.abs(r.roll) > 25 && err > 2 ? Math.min(1, err / 15) : 0
    const pitch = pull > 0 ? pull : Math.max(-1, Math.min(1, -r.pitch * 0.08))
    stepFlight(s, input({ roll, pitch, throttle: 1 }), TICK_DT, world)
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
    test(`${kind}: roll-then-pull makes a clean 90° turn`, () => {
      const r = directTurn(kind)
      const aim = turnTo(kind, 90)
      expect(r.time).toBeGreaterThan(0)
      expect(r.time).toBeLessThan(aim.time * 1.6)
      expect(r.overshoot).toBeLessThan(6)
      expect(r.finalErr).toBeLessThan(3)
      expect(r.maxAltDev).toBeLessThan(60)
      expect(Math.abs(r.finalRoll)).toBeLessThan(5)
    })

    test(`${kind}: yaw (mouse X) makes a level coordinated turn with auto-bank, then rolls out`, () => {
      const s = airStart(kind)
      settleLevel(s, 5)
      const alt0 = s.position[1]
      let maxBank = 0, t90 = -1
      for (let i = 0; i < 60 * 12 && t90 < 0; i++) {
        stepFlight(s, input({ yaw: 1, throttle: 1 }), TICK_DT, world)
        maxBank = Math.max(maxBank, flightReadout(s).roll)
        if (angDiff(heading(s), 90) > -3) t90 = (i + 1) * TICK_DT
      }
      expect(t90).toBeGreaterThan(0)
      expect(t90).toBeLessThan(kind === "blackbird" ? 9 : 4)
      expect(maxBank).toBeGreaterThan(40) // banks right into a right turn
      expect(Math.abs(s.position[1] - alt0)).toBeLessThan(40) // level
      run(s, input({ throttle: 1 }), 4)
      expect(Math.abs(flightReadout(s).roll)).toBeLessThan(5) // rolls out when released
    })

    test(`${kind}: roll (A/D) overrides auto-bank; inverted is held, moderate bank eases level`, () => {
      const inv = airStart(kind)
      inv.orientation = quatFromYawPitchRoll(0, 0, Math.PI)
      run(inv, input({ throttle: 1 }), 4)
      expect(Math.abs(flightReadout(inv).roll)).toBeGreaterThan(170)
      const mid = airStart(kind)
      mid.orientation = quatFromYawPitchRoll(0, 0, 30 * Math.PI / 180)
      run(mid, input({ throttle: 1 }), 8)
      expect(Math.abs(flightReadout(mid).roll)).toBeLessThan(3)
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

// Helicopter direct-mode helpers: a tiny "pilot" that holds a pitch angle through the pitch-rate input.
const heliAir = (alt = 1000) => createFlightState("apache", { position: [0, alt, 0], yaw: 0, onGround: false })
const holdPitchInput = (s: FlightState, deg: number) => Math.max(-1, Math.min(1, (deg - flightReadout(s).pitch) * 0.15))
const holdLevelCollective = (s: FlightState) => (s.velocity[1] < 0 ? 0.3 : -0.3)
const fwdSpeed = (s: FlightState) => { const f = forward(s.orientation); const n = Math.hypot(f[0], f[2]); return (s.velocity[0] * f[0] + s.velocity[2] * f[2]) / n }

function heliFeel() {
  const hover = heliAir(); run(hover, input(), 5)
  const desc = heliAir(); run(desc, input({ throttle: -1 }), 0.5); run(desc, input(), 5)
  const climb = heliAir(); run(climb, input({ throttle: 1 }), 5.5)
  const back = heliAir(); run(back, st => input({ pitch: holdPitchInput(st, 20), throttle: holdLevelCollective(st) }), 15)
  const top = heliAir(); run(top, st => input({ pitch: holdPitchInput(st, -55), throttle: 1 }), 40)
  const topSpeed = flightReadout(top).speed
  let stop = 0
  while (fwdSpeed(top) > 2 && stop < 30) { stepFlight(top, input({ pitch: holdPitchInput(top, 55), throttle: top.throttle > 0.75 ? -1 : 0 }), TICK_DT, world); stop += TICK_DT }
  const flip = heliAir(); run(flip, input({ roll: 0.45 }), 4)
  const strafeBank = flightReadout(flip).roll
  const loop = heliAir(); run(loop, st => input({ pitch: holdPitchInput(st, -40), throttle: 1 }), 10)
  let pitched = 0, loopTime = 0
  while (pitched < 2 * Math.PI && loopTime < 8) { stepFlight(loop, input({ pitch: 1, throttle: 1 }), TICK_DT, world); pitched += loop.angularVelocity[0] * TICK_DT; loopTime += TICK_DT }
  const brake = heliAir(); run(brake, st => input({ pitch: holdPitchInput(st, -55), throttle: 1 }), 40)
  let brakeStop = 0
  while (flightReadout(brake).speed > 2 && brakeStop < 30) { stepFlight(brake, input({ brake: true }), TICK_DT, world); brakeStop += TICK_DT }
  return {
    hoverDrift: flightReadout(hover).speed, hoverAltErr: Math.abs(hover.position[1] - 1000),
    descent: -desc.velocity[1], climb: climb.velocity[1], descentCollective: desc.throttle,
    backward: -fwdSpeed(back), topSpeed, stop, strafeBank, strafeSpeed: Math.abs(flip.velocity[0]), flipCrashed: flip.crashed,
    loopTime, looped: pitched >= 2 * Math.PI, brakeStop,
  }
}

describe("helicopter: direct steering", () => {
  const f = heliFeel()
  test("neutral hover is truly stationary", () => {
    expect(f.hoverDrift).toBeLessThan(0.5)
    expect(f.hoverAltErr).toBeLessThan(0.5)
  })
  test("collective holds where left; S gives a real descent, W a real climb", () => {
    expect(f.descentCollective).toBeLessThan(0.1)
    expect(f.descent).toBeGreaterThan(14)
    expect(f.climb).toBeGreaterThan(14)
  })
  test("pitch back flies backwards, nose down + full collective reaches ~95 m/s", () => {
    expect(f.backward).toBeGreaterThan(15)
    expect(Math.abs(f.topSpeed - 95) / 95).toBeLessThan(0.1)
  })
  test("pitching back stops it from top speed quickly", () => expect(f.stop).toBeLessThan(6))
  test("loops are possible (pitch); a partial roll (strafe) settles at a steady tilt, not a flip", () => {
    expect(f.looped).toBe(true)
    expect(f.strafeBank).toBeGreaterThan(20)
    expect(f.strafeBank).toBeLessThan(35)
    expect(f.flipCrashed).toBeNull()
  })
  test("brake auto-hover kills velocity and levels", () => expect(f.brakeStop).toBeLessThan(12))

  test("pitch is rate-based, damps crisply, and a released tilt eases back to level in ~2–3 s", () => {
    const s = heliAir()
    run(s, input({ pitch: -1 }), 0.4)
    run(s, input(), 0.3)
    const tilt = flightReadout(s).pitch
    expect(tilt).toBeLessThan(-20)
    run(s, input(), 3)
    expect(Math.abs(flightReadout(s).pitch)).toBeLessThan(Math.abs(tilt) * 0.15)
    expect(fwdSpeed(s)).toBeGreaterThan(3)
  })

  test("small tilts self-level weakly back to a hover attitude", () => {
    const s = heliAir()
    run(s, input({ pitch: 0.5 }), 0.1)
    run(s, input(), 10)
    expect(Math.abs(flightReadout(s).pitch)).toBeLessThan(0.5)
  })

  test("pedal yaw (A/D) turns fast in a hover", () => {
    const s = heliAir()
    run(s, input({ yaw: 1 }), 1.2)
    expect(angDiff(heading(s), 0)).toBeGreaterThan(80)
  })

  test("collective detent snaps to hover when released near it", () => {
    const s = heliAir()
    s.throttle = 0.53
    run(s, input(), 1)
    expect(s.throttle).toBeCloseTo(0.5, 6)
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
  test("lifts off from the pad and settles into a hover", () => {
    const s = createFlightState("apache", { position: [0, LAND + 2, 0], yaw: 0, onGround: true })
    run(s, input({ throttle: 1 }), 0.6)
    run(s, input(), 3)
    expect(s.onGround).toBe(false)
    s.throttle = 0.5
    run(s, input({ brake: true }), 3)
    const alt = s.position[1]
    run(s, input(), 10)
    expect(Math.abs(s.position[1] - alt)).toBeLessThan(2)
    expect(flightReadout(s).speed).toBeLessThan(1)
  })

  test("mouse-aim mode: cruise, max speed and hover-hold", () => {
    const s = createFlightState("apache", { position: [0, 300, 0], yaw: 0, onGround: false })
    run(s, input({ aim: directionFromHeading(0, -25 * Math.PI / 180) }), 30)
    expect(Math.abs(flightReadout(s).speed - 75) / 75).toBeLessThan(0.1)
    run(s, input({ aim: directionFromHeading(0, -10 * Math.PI / 180), boost: true }), 30)
    expect(Math.abs(flightReadout(s).speed - 98) / 98).toBeLessThan(0.1)
    run(s, input({ aim: directionFromHeading(0, 0), brake: true }), 12)
    expect(flightReadout(s).speed).toBeLessThan(2)
  })

  test("mouse-aim mode: yaws toward aim heading and strafes", () => {
    const s = createFlightState("apache", { position: [0, 300, 0], yaw: 0, onGround: false })
    run(s, input({ aim: directionFromHeading(Math.PI / 2, 0) }), 3)
    expect(Math.abs(angDiff(heading(s), 90))).toBeLessThan(3)
    run(s, input({ aim: directionFromHeading(Math.PI / 2, 0), roll: 1 }), 4)
    expect(s.velocity[2]).toBeGreaterThan(10) // facing east, strafing right = south (+Z)
  })

  test("easing down lands; slamming in at full descent crashes", () => {
    const s = createFlightState("apache", { position: [0, 60, 0], yaw: 0, onGround: false })
    s.throttle = 0.35
    run(s, input(), 30)
    expect(s.crashed).toBeNull()
    expect(s.onGround).toBe(true)
    const d = createFlightState("apache", { position: [0, 200, 0], yaw: 0, onGround: false })
    run(d, input({ throttle: -1 }), 30)
    expect(d.crashed).toBe("terrain")
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
      "roll+pull t90 (s)": dt90.time.toFixed(2), "roll+pull altΔ": dt90.maxAltDev.toFixed(0),
      "loop (s)": lp.time.toFixed(1),
    })
  }
  console.table(rows)

  const f = heliFeel()
  console.table([{
    kind: "apache (direct)", "hover drift m/s": f.hoverDrift.toFixed(3), "descent m/s": f.descent.toFixed(1), "climb m/s": f.climb.toFixed(1),
    "backward m/s": f.backward.toFixed(1), "top m/s": f.topSpeed.toFixed(1), "stop from top, pitch back (s)": f.stop.toFixed(1),
    "brake stop (s)": f.brakeStop.toFixed(1), "strafe bank°": f.strafeBank.toFixed(0), "strafe m/s (4 s)": f.strafeSpeed.toFixed(1), "loop (s)": f.loopTime.toFixed(2),
  }])
})
