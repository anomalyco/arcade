import { describe, expect, test } from "bun:test"
import { DRAFT } from "../shared/carrier-spec"
import { archipelagoFor, terrainHeight } from "../shared/islands"
import { type Sea, makeSea, seaHeight } from "../shared/sea"
import { HULL_POINTS, KNOT, SHIP, type Ship, extrapolatePose, headingTo, makeShip, poseOf, seaStorm, shipFloat, shipStep } from "../shared/ship"
import { WEATHER_PRESETS, type WeatherKind, makeWeatherSea } from "../shared/weather"

const calm = (seed = 7): Sea => ({ ...makeSea(seed), waves: [] })
/** The seed's sea with every wave scaled; Q shrinks so it never loops. */
const scaled = (k: number, seed = 7): Sea => {
  const s = makeSea(seed)
  return { ...s, waves: s.waves.map((w) => ({ ...w, amp: w.amp * k, steep: w.steep / k })) }
}
/** The seed's sea under a weather preset (heavy: 15-22 m sets). */
const weather = (kind: WeatherKind, seed = 7): Sea => {
  const v = makeWeatherSea(makeSea(seed))
  v.set(WEATHER_PRESETS[kind])
  return v.sea
}
/** Heading into the primary swell (head seas). */
const into = (sea: Sea) => Math.atan2(-sea.swell[0], sea.swell[1])

function run(ship: Ship, seconds: number, controls: { throttle: number; rudder: number }, sea: Sea, arch: Parameters<typeof shipStep>[3] = null, each?: (s: Ship) => void) {
  const n = Math.round(seconds / SHIP.tick)
  for (let i = 0; i < n; i++) {
    shipStep(ship, controls, sea, arch)
    each?.(ship)
  }
}

describe("ship", () => {
  test("is deterministic", () => {
    const sea = makeSea(3)
    const a = makeShip(0, 0, 0.4, 50)
    const b = makeShip(0, 0, 0.4, 50)
    const plan = (s: Ship) => {
      run(s, 20, { throttle: 1, rudder: 0 }, sea)
      run(s, 15, { throttle: 0.6, rudder: -1 }, sea)
      run(s, 10, { throttle: 0, rudder: 0.5 }, sea)
    }
    plan(a)
    plan(b)
    expect(a).toEqual(b)
  })

  test("works up to top speed in ~5-9 s, holds the ordered speed, and coasts", () => {
    const sea = calm()
    const s = makeShip(0, 0, 0)
    let t90 = 0
    let t = 0
    run(s, 40, { throttle: 1, rudder: 0 }, sea, null, (x) => {
      t += SHIP.tick
      if (!t90 && x.u >= 0.9 * SHIP.topSpeed) t90 = t
    })
    expect(t90).toBeGreaterThan(5)
    expect(t90).toBeLessThan(9)
    expect(s.u).toBeCloseTo(SHIP.topSpeed, 1)
    expect(SHIP.topSpeed / KNOT).toBeGreaterThanOrEqual(30)
    // Half throttle settles at half speed: the throttle says how fast it goes.
    run(s, 60, { throttle: 0.5, rudder: 0 }, sea)
    expect(s.u / SHIP.topSpeed).toBeCloseTo(0.5, 2)
    // Engines stopped: it slows down within seconds but keeps going for hundreds of metres.
    run(s, 60, { throttle: 1, rudder: 0 }, sea)
    const z0 = s.z
    run(s, 10, { throttle: 0, rudder: 0 }, sea)
    expect(s.u).toBeLessThan(0.8 * SHIP.topSpeed)
    expect(s.u).toBeGreaterThan(0.3 * SHIP.topSpeed)
    run(s, 300, { throttle: 0, rudder: 0 }, sea)
    expect(s.u).toBe(0)
    expect(z0 - s.z).toBeGreaterThan(500)
    expect(z0 - s.z).toBeLessThan(2500)
  })

  test("astern: reverses to stop, backs up slowly, and steers like a car in reverse", () => {
    const sea = calm()
    const s = makeShip(0, 0, 0)
    run(s, 20, { throttle: 1, rudder: 0 }, sea)
    let t = 0
    while (s.u > 0 && t < 60) {
      shipStep(s, { throttle: -1, rudder: 0 }, sea, null)
      t += SHIP.tick
    }
    expect(s.order).toBe(-SHIP.astern)
    expect(t).toBeGreaterThan(3)
    expect(t).toBeLessThan(20)
    run(s, 40, { throttle: -SHIP.astern, rudder: 0 }, sea)
    expect(s.u).toBeLessThan(-0.8 * SHIP.astern * SHIP.topSpeed)
    expect(s.u).toBeGreaterThan(-1.05 * SHIP.astern * SHIP.topSpeed)
    const h0 = s.heading
    run(s, 8, { throttle: -SHIP.astern, rudder: 1 }, sea)
    expect(s.heading - h0).toBeLessThan(-0.1)
    run(s, 400, { throttle: 0, rudder: 0 }, sea)
    expect(s.u).toBe(0)
  })

  test("engine output answers the throttle within about a second", () => {
    const s = makeShip(0, 0, 0)
    run(s, 1.2, { throttle: 1, rudder: 0 }, calm())
    expect(s.power).toBe(1)
  })

  test("turning circle: 400-650 m at full speed, tighter but slower when slow", () => {
    const circle = (throttle: number) => {
      const sea = calm()
      const s = makeShip(0, 0, 0)
      run(s, 60, { throttle, rudder: 0 }, sea)
      let x0 = Infinity
      let x1 = -Infinity
      let turned = 0
      let prev = s.heading
      let t = 0
      let t90 = 0
      while (turned < Math.PI * 2 && t < 600) {
        shipStep(s, { throttle, rudder: 1 }, sea, null)
        t += SHIP.tick
        let d = s.heading - prev
        if (d < -Math.PI) d += Math.PI * 2
        if (d > Math.PI) d -= Math.PI * 2
        turned += d
        prev = s.heading
        if (!t90 && turned >= Math.PI / 2) t90 = t
        if (turned > 0.3) {
          x0 = Math.min(x0, s.x)
          x1 = Math.max(x1, s.x)
        }
      }
      return { diameter: x1 - x0, t90, roll: s.roll }
    }
    const fast = circle(1)
    expect(fast.diameter).toBeGreaterThan(400)
    expect(fast.diameter).toBeLessThan(650)
    expect(fast.t90).toBeLessThan(45)
    // Heels outward (turning to starboard rolls to port: roll < 0), a few degrees.
    expect(fast.roll).toBeLessThan(-0.02)
    expect(fast.roll).toBeGreaterThan(-0.1)
    const slow = circle(0.3)
    expect(slow.diameter).toBeLessThan(fast.diameter)
    expect(slow.t90).toBeGreaterThan(fast.t90)
    expect(slow.t90).toBeLessThan(90)
  })

  test("floats at the waterline in a calm sea", () => {
    const s = makeShip(0, 0, 0)
    s.heave = 2
    s.pitch = 0.05
    s.roll = -0.05
    run(s, 60, { throttle: 0, rudder: 0 }, calm())
    expect(Math.abs(s.heave)).toBeLessThan(0.01)
    expect(Math.abs(s.pitch)).toBeLessThan(1e-3)
    expect(Math.abs(s.roll)).toBeLessThan(1e-3)
  })

  test("rides calm and moderate swells smoothly and stays stable (the heavy, steady carrier)", () => {
    for (const [sea, heading] of [
      [scaled(1), 0],
      [scaled(1.15), 0],
      [weather("medium"), Math.PI / 2],
      [weather("light"), 2.2],
    ] as const) {
      expect(seaStorm(sea)).toBeLessThan(0.25)
      const s = makeShip(0, 0, heading, 200)
      run(s, 30, { throttle: 1, rudder: 0 }, sea)
      let maxPitch = 0
      let maxRoll = 0
      let maxAcc = 0
      let maxStep = 0
      let prevVel = s.heaveVel
      let prevAcc = 0
      let sumErr = 0
      let n = 0
      run(s, 120, { throttle: 1, rudder: 0 }, sea, null, (x) => {
        maxPitch = Math.max(maxPitch, Math.abs(x.pitch))
        maxRoll = Math.max(maxRoll, Math.abs(x.roll))
        const acc = (x.heaveVel - prevVel) / SHIP.tick
        maxAcc = Math.max(maxAcc, Math.abs(acc))
        if (n) maxStep = Math.max(maxStep, Math.abs(acc - prevAcc))
        prevAcc = acc
        prevVel = x.heaveVel
        // Heave follows the water averaged over the hull.
        const avg = HULL_POINTS.reduce((sum, [f, sd]) => sum + seaHeight(sea, x.x + f * Math.sin(x.heading) + sd * Math.cos(x.heading), x.z - f * Math.cos(x.heading) + sd * Math.sin(x.heading), x.t), 0) / HULL_POINTS.length
        sumErr += Math.abs(x.heave - avg * SHIP.gain)
        n++
      })
      expect(Number.isFinite(s.heave)).toBe(true)
      expect(maxPitch).toBeLessThan(0.12)
      expect(maxRoll).toBeLessThan(0.2)
      // Heave acceleration stays well under 1 g and changes smoothly from step to step (no kicks).
      expect(maxAcc).toBeLessThan(0.6 * 9.81)
      expect(maxStep).toBeLessThan(0.3)
      expect(sumErr / n).toBeLessThan(2.5)
    }
  })

  test("calm seas feel exactly as before the storm response (no storm blend below its Hs)", () => {
    for (const seed of [1, 2, 3, 7, 11, 42, 31337]) {
      expect(seaStorm(makeSea(seed))).toBe(0)
      expect(seaStorm(weather("light", seed))).toBeLessThan(0.02)
      expect(seaStorm(weather("heavy", seed))).toBeGreaterThan(0.8)
    }
  })

  test("a heavy storm throws the carrier about: rears up, crests, drops and slams, rolls hard in beam seas", () => {
    const D = 180 / Math.PI
    for (const seed of [1, 7, 42]) {
      const sea = weather("heavy", seed)
      const out: string[] = []
      for (const [name, heading, throttle] of [
        ["head", into(sea), 1],
        ["beam", into(sea) + Math.PI / 2, 0.6],
        ["follow", into(sea) + Math.PI, 1],
      ] as const) {
        const s = makeShip(0, 0, heading, 300)
        s.u = SHIP.topSpeed * throttle
        s.power = throttle
        run(s, 20, { throttle, rudder: 0 }, sea)
        let p0 = 0
        let p1 = 0
        let roll = 0
        let h0 = 0
        let h1 = 0
        let air = 0
        const slams = s.slams
        let prevVel = s.heaveVel
        const accs: number[] = []
        run(s, 120, { throttle, rudder: 0 }, sea, null, (x) => {
          p0 = Math.min(p0, x.pitch)
          p1 = Math.max(p1, x.pitch)
          roll = Math.max(roll, Math.abs(x.roll))
          h0 = Math.min(h0, x.heave)
          h1 = Math.max(h1, x.heave)
          air = Math.max(air, x.bowAir)
          accs.push(Math.abs(x.heaveVel - prevVel) / SHIP.tick)
          prevVel = x.heaveVel
          expect(Number.isFinite(x.heave + x.pitch + x.roll + x.heaveVel + x.pitchVel + x.rollVel)).toBe(true)
        })
        accs.sort((a, b) => a - b)
        const p99 = accs[Math.floor(accs.length * 0.99)]! / 9.81
        out.push(`${name}: pitch ${(p0 * D).toFixed(1)}..${(p1 * D).toFixed(1)}°, roll ±${(roll * D).toFixed(1)}°, heave ${h0.toFixed(1)}..${h1.toFixed(1)} m, bow clear ${air.toFixed(0)} m, ${s.slams - slams} slams, p99 ${p99.toFixed(2)} g`)
        expect(Math.abs(p0)).toBeLessThanOrEqual(SHIP.maxPitch)
        expect(p1).toBeLessThanOrEqual(SHIP.maxPitch)
        expect(roll).toBeLessThanOrEqual(SHIP.maxRoll)
        expect(p99).toBeLessThan(1.8)
        if (name === "head") {
          // Rears up a face and pitches down over the crest: several degrees each way, the bow clear of the water, slams.
          expect(p1).toBeGreaterThan(6 / D)
          expect(-p0).toBeGreaterThan(4.5 / D)
          expect(air).toBeGreaterThan(10)
          expect(h1 - h0).toBeGreaterThan(10)
          expect(s.slams - slams).toBeGreaterThan(5)
        } else if (name === "beam") {
          expect(roll).toBeGreaterThan(12 / D)
          expect(h1 - h0).toBeGreaterThan(10)
        }
      }
      console.log(`heavy storm, seed ${seed}: ${out.join("; ")}`)
    }
  })

  test("render rate doesn't matter: the sim only takes fixed steps (in a heavy storm too)", () => {
    const sea = weather("heavy")
    const finals = [30, 60, 144].map((hz) => {
      const s = makeShip(0, 0, 1, 100)
      const prev = makeShip(0, 0, 1, 100)
      let t = 100
      let worst = 0
      for (let f = 0; f < 60 * hz; f++) {
        t += 1 / hz
        while (s.t + SHIP.tick <= t + 1e-9) {
          Object.assign(prev, s)
          shipStep(s, { throttle: 1, rudder: s.t > 130 ? 1 : 0 }, sea, null)
        }
        worst = Math.max(worst, Math.abs(s.heave), Math.abs(s.pitch) * 100)
      }
      expect(worst).toBeLessThan(40)
      return s
    })
    expect(finals[0]!.x).toBeCloseTo(finals[1]!.x, 6)
    expect(finals[1]!.x).toBeCloseTo(finals[2]!.x, 6)
    expect(finals[1]!.heave).toBeCloseTo(finals[2]!.heave, 6)
  })

  test("runs aground on an island instead of passing through it", () => {
    const arch = archipelagoFor(7)
    const isl = arch.islands[0]!
    const sea = calm()
    const d = Math.hypot(isl.x, isl.z)
    const start = isl.radius * 1.6 + 600
    const x = isl.x - (isl.x / d) * start
    const z = isl.z - (isl.z / d) * start
    const s = makeShip(x, z, headingTo(x, z, isl.x, isl.z))
    s.u = SHIP.topSpeed
    s.power = 1
    let closest = Infinity
    let grounded = false
    run(s, 120, { throttle: 1, rudder: 0 }, sea, arch, (x) => {
      closest = Math.min(closest, Math.hypot(x.x - isl.x, x.z - isl.z))
      if (x.ground > 0.05) grounded = true
    })
    expect(grounded).toBe(true)
    // Its keel never sits on dry land.
    expect(terrainHeight(arch, s.x, s.z)).toBeLessThan(-DRAFT + 3)
    expect(closest).toBeGreaterThan(isl.radius * 0.5)
    expect(Math.abs(s.u)).toBeLessThan(2)
  })

  test("soft world edge pushes back", () => {
    const s = makeShip(SHIP.edge + 200, 0, Math.PI / 2)
    run(s, 300, { throttle: 0.3, rudder: 0 }, calm())
    expect(s.x).toBeLessThan(SHIP.edge + 1500)
  })

  test("remote hulls float on the local sea in step with the owner", () => {
    const sea = makeSea(11)
    const owner = makeShip(0, 0, 0.3, 500)
    const remote = makeShip(0, 0, 0.3, 500)
    let err = 0
    for (let i = 0; i < 60 * 60; i++) {
      shipStep(owner, { throttle: 0.7, rudder: i > 1800 ? 0.5 : 0 }, sea, null)
      // The remote only gets the plan pose and floats itself.
      const p = poseOf(owner)
      remote.x = p.x
      remote.z = p.z
      remote.heading = p.heading
      remote.u = p.u
      remote.r = p.r
      remote.t = owner.t
      shipFloat(remote, sea, SHIP.tick)
      if (i > 20 * 60) err = Math.max(err, Math.abs(remote.heave - owner.heave), Math.abs(remote.pitch - owner.pitch) * 160)
    }
    expect(err).toBeLessThan(0.05)
  })

  test("dead reckoning follows the arc", () => {
    const s = makeShip(0, 0, 0, 0)
    s.power = 1
    s.u = SHIP.topSpeed * 0.6
    const sea = calm()
    run(s, 5, { throttle: 0.6, rudder: 1 }, sea)
    const p = poseOf(s)
    run(s, 1, { throttle: 0.6, rudder: 1 }, sea)
    const out = { x: 0, z: 0, heading: 0 }
    extrapolatePose(p, s.t, out)
    expect(Math.hypot(out.x - s.x, out.z - s.z)).toBeLessThan(0.5)
  })
})
