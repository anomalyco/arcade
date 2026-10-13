import { describe, expect, test } from "bun:test"
import { BOW_Z, CENTERLINE_X, DECK_Y, STERN_Z } from "../shared/carrier-spec"
import { LANDING, captureMiss, ceilingLimit, directMiss, headingLimit, landingStep, lateralLimit, startLanding, wantsWaveOff, waveOff, worldToPlan } from "../shared/landing"
import { DECK_CENTRE_Y, type ShipLike } from "../shared/launch"
import { PLANE, type Plane, makePlane, planeSpeed, planeStep, quatAxis, quatMul, setPlaneQuat, worldToShip } from "../shared/plane"
import { makeSea } from "../shared/sea"
import { makeShip, shipStep } from "../shared/ship"

const DT = PLANE.tick
const HANDS_OFF = { pitch: 0, roll: 0, yaw: 0, throttle: 0 as const, boost: false }

/** A jet `behind` metres behind the stern of `ship`, `side` metres off the centreline, `height` above the deck, flying
 *  the ship's heading (plus `yaw`) at `speed` m/s over the ground plus the ship's speed. */
function behindShip(ship: ShipLike & { t: number }, behind: number, side: number, height: number, speed = 120, yaw = 0): Plane {
  const p = makePlane(ship.t)
  const h = ship.heading + yaw
  // Ship-local (plan) → world: forward F = (sin h, −cos h), local +X = −R = (−cos h, −sin h).
  const f = [Math.sin(ship.heading), -Math.cos(ship.heading)]
  const left = [-Math.cos(ship.heading), -Math.sin(ship.heading)]
  const z = STERN_Z - behind
  const x = CENTERLINE_X + side
  p.x = ship.x + f[0]! * z + left[0]! * x
  p.z = ship.z + f[1]! * z + left[1]! * x
  p.y = DECK_Y + height
  setPlaneQuat(p, quatAxis(0, 1, 0, Math.PI - h))
  const v = speed + ship.u
  p.vx = Math.sin(h) * v
  p.vz = -Math.cos(h) * v
  p.throttle = PLANE.cruise
  return p
}

/** A carrier pitching ±6°, heaving ±3 m, rolling ±5° and turning at 2°/s at 16 m/s (far harder than the sea does). */
function stormShip(t: number): ShipLike & { t: number } {
  const w = (2 * Math.PI) / 6.5
  const heading = 0.4 + t * 0.035
  return { t, x: 16 * Math.sin(0.4) * t, z: -16 * Math.cos(0.4) * t, heave: 3 * Math.sin(w * t), heading, pitch: 0.105 * Math.sin(w * t + 1), roll: 0.087 * Math.sin(0.5 * w * t), u: 16, v: 0, r: 0.035 }
}

/** A jet `dist` m from the ship's centre at relative bearing `bearing` (rad, 0 = dead ahead of the bow, + to starboard),
 *  `height` m above the deck, nose `off` rad away from the bearing back to the ship, at `speed` m/s. */
function nearShip(ship: ShipLike & { t: number }, dist: number, bearing: number, height: number, speed = 140, off = 0): Plane {
  const p = makePlane(ship.t)
  const a = ship.heading + bearing
  p.x = ship.x + Math.sin(a) * dist
  p.z = ship.z - Math.cos(a) * dist
  p.y = DECK_Y + height
  const h = Math.atan2(ship.x - p.x, -(ship.z - p.z)) + off
  setPlaneQuat(p, quatAxis(0, 1, 0, Math.PI - h))
  p.vx = Math.sin(h) * speed
  p.vz = -Math.cos(h) * speed
  p.throttle = PLANE.cruise
  return p
}

describe("landing capture window", () => {
  const ship = Object.assign(makeShip(100, -300, 0.7, 10), { u: 15 })
  test("captures heading roughly toward your carrier anywhere near it: from ahead, the side, behind", () => {
    for (const bearing of [0, 0.8, Math.PI / 2, 2.2, Math.PI, -2.2, -Math.PI / 2, -0.8])
      for (const dist of [800, 2900]) {
        expect(captureMiss(nearShip(ship, dist, bearing, 300), ship)).toBe("")
        expect(captureMiss(nearShip(ship, dist, bearing, 750, 140, 1.15), ship)).toBe("")
      }
    expect(LANDING.near).toBe(3000)
    // The straight-in window behind the stern still captures beyond 3 km.
    expect(captureMiss(behindShip(ship, 3900, 390, 580, 160, 0.8), ship)).toBe("")
  })
  test("refuses: too far, too high, heading away, banked past 70°, too slow", () => {
    expect(captureMiss(nearShip(ship, 3600, Math.PI / 2, 300), ship)).toBe("range")
    expect(captureMiss(nearShip(ship, 1500, Math.PI / 2, 900), ship)).toBe("height")
    expect(captureMiss(nearShip(ship, 1500, Math.PI / 2, 300, 140, 1.4), ship)).toBe("heading")
    expect(captureMiss(nearShip(ship, 1500, 0, 300, 140, Math.PI), ship)).toBe("heading")
    expect(captureMiss(nearShip(ship, 1500, 0, 300, 30), ship)).toBe("slow")
    const banked = nearShip(ship, 1500, Math.PI / 2, 300)
    setPlaneQuat(banked, quatMul([banked.qx, banked.qy, banked.qz, banked.qw], quatAxis(0, 0, 1, 1.35)))
    expect(captureMiss(banked, ship)).toBe("attitude")
  })
  test("the straight-in window (no pattern needed) is the funnel behind the stern", () => {
    expect(directMiss(behindShip(ship, 900, 40, 120), ship)).toBe("")
    expect(directMiss(behindShip(ship, 2500, -390, 450, 120, -0.8), ship)).toBe("")
    expect(lateralLimit(1500)).toBe(400)
    expect(ceilingLimit(2500)).toBe(600)
    expect(headingLimit(1500)).toBeCloseTo((50 * Math.PI) / 180, 6)
    expect(directMiss(behindShip(ship, 4200, 0, 120), ship)).toBe("range")
    expect(directMiss(behindShip(ship, -200, 0, 120), ship)).toBe("range")
    expect(directMiss(behindShip(ship, 1500, 450, 120), ship)).toBe("lateral")
    expect(directMiss(behindShip(ship, 100, 0, 150), ship)).toBe("height")
    expect(directMiss(behindShip(ship, 200, 0, 20, 260), ship)).toBe("fast")
  })
})

/** Runs a landing to the end; checks the deck run every step. Returns the steps taken and how often it reported landed. */
function land(plane: Plane, shipAt: (t: number) => ShipLike & { t: number }, stepShip: () => void = () => {}) {
  let t = plane.t
  let ship = shipAt(t)
  const l = startLanding(plane, ship)
  let landed = 0
  let steps = 0
  let touchSpeed = 0
  let prevPhase = l.phase
  let prevZ = -Infinity
  while (steps < 60 * 90 && l.phase !== "done") {
    stepShip()
    t += DT
    ship = shipAt(t)
    if (landingStep(l, plane, ship, DT)) landed++
    steps++
    if (prevPhase === "approach" && l.phase === "trap") touchSpeed = l.u
    prevPhase = l.phase
    const loc = worldToShip(ship, plane.x, plane.y, plane.z)
    // Over the deck (or in the pattern, anywhere over the hull) the jet never goes into it.
    const overHull = loc[2] > STERN_Z && loc[2] < BOW_Z && Math.abs(loc[0]) < 40
    if (overHull) expect(loc[1]).toBeGreaterThan(DECK_CENTRE_Y - 1e-6)
    if (l.phase !== "approach" && l.phase !== "pattern") {
      // On the runway (45 m wide) from touchdown, closing on the centreline, and stopped short of the bow.
      expect(Math.abs(loc[0] - CENTERLINE_X)).toBeLessThan(6)
      expect(loc[2]).toBeLessThan(BOW_Z - 20)
      expect(Math.abs(loc[1] - DECK_CENTRE_Y)).toBeLessThan(1e-6)
      expect(loc[2]).toBeGreaterThanOrEqual(prevZ - 1e-6)
      prevZ = loc[2]
    }
    expect(Number.isFinite(plane.x + plane.y + plane.z + plane.vx)).toBe(true)
  }
  return { l, steps, landed, touchSpeed, ship }
}

describe("landing", () => {
  test("lands on a calm sea: touches down near the approach speed, on the centreline, stops on deck, reports once", () => {
    const sea = makeSea(7)
    const ship = makeShip(0, 0, 0.3, 0)
    for (let i = 0; i < 1200; i++) shipStep(ship, { throttle: 0.6, rudder: 0 }, sea, null)
    const plane = behindShip(ship, 1500, 90, 200)
    expect(captureMiss(plane, ship)).toBe("")
    const r = land(plane, () => ship, () => shipStep(ship, { throttle: 0.6, rudder: 0 }, sea, null))
    expect(r.l.phase).toBe("done")
    expect(r.landed).toBe(1)
    expect(Math.abs(r.touchSpeed - LANDING.approachSpeed)).toBeLessThan(3)
    const loc = worldToShip(ship, plane.x, plane.y, plane.z)
    expect(Math.abs(loc[0] - CENTERLINE_X)).toBeLessThan(0.5)
    expect(loc[2]).toBeGreaterThan(LANDING.touchZ)
    // Stopped: the jet moves with the deck.
    expect(Math.abs(planeSpeed(plane) - Math.hypot(ship.u, ship.v))).toBeLessThan(1.5)
    // Arrested in about 2 s at ~3.6 g.
    expect(LANDING.approachSpeed / LANDING.trapDecel).toBeCloseTo(2, 0)
  })

  test("lands on a heavily pitching, rolling, turning deck from fast and off to the side", () => {
    for (const [behind, side, height, speed] of [
      [1800, 130, 280, 180],
      [600, -60, 60, 110],
      [300, 20, 55, 100],
    ] as const) {
      const ship0 = stormShip(3)
      const plane = behindShip(ship0, behind, side, height, speed)
      expect(captureMiss(plane, ship0)).toBe("")
      const r = land(plane, stormShip)
      expect(r.l.phase).toBe("done")
      expect(r.landed).toBe(1)
      const loc = worldToShip(r.ship, plane.x, plane.y, plane.z)
      expect(Math.abs(loc[0] - CENTERLINE_X)).toBeLessThan(0.5)
      expect(Math.abs(loc[1] - DECK_CENTRE_Y)).toBeLessThan(1e-6)
    }
  })

  test("every capture across the window lands: on the runway, never into the deck, stopped short of the bow", () => {
    let n = 0
    for (const behind of [20, 150, 600, 2000, 3950])
      for (const sf of [-1, 0, 1])
        for (const hf of [0.05, 1])
          for (const yf of [-1, 1])
            for (const speed of [80, 200]) {
              const ship0 = stormShip(3)
              const plane = behindShip(ship0, behind, sf * (lateralLimit(behind) - 1), Math.max(4, hf * (ceilingLimit(behind) - 1)), speed, yf * (headingLimit(behind) - 0.01))
              if (captureMiss(plane, ship0)) continue
              n++
              const r = land(plane, stormShip)
              expect(r.l.phase).toBe("done")
              expect(r.landed).toBe(1)
              const loc = worldToShip(r.ship, plane.x, plane.y, plane.z)
              expect(Math.abs(loc[0] - CENTERLINE_X)).toBeLessThan(0.5)
            }
    expect(n).toBeGreaterThan(60)
  })

  test("from ahead, the side and behind (any heading toward the ship), the autopilot flies around and lands", () => {
    let n = 0
    let patterns = 0
    for (const bearing of [0, 0.6, 1.3, Math.PI / 2, 2.2, 2.8, Math.PI, -2.8, -2.2, -Math.PI / 2, -1.3, -0.6])
      for (const dist of [700, 1800, 2900])
        for (const [height, speed, off] of [
          [15, 100, 0],
          [400, 220, 1.1],
          [780, 150, -1.1],
        ] as const) {
          const ship0 = stormShip(3)
          const plane = nearShip(ship0, dist, bearing, height, speed, off)
          if (captureMiss(plane, ship0)) continue
          n++
          const r = land(plane, stormShip)
          if (r.l.path) patterns++
          expect(r.l.phase).toBe("done")
          expect(r.landed).toBe(1)
          const loc = worldToShip(r.ship, plane.x, plane.y, plane.z)
          expect(Math.abs(loc[0] - CENTERLINE_X)).toBeLessThan(0.5)
          expect(loc[2]).toBeGreaterThan(LANDING.touchZ)
        }
    expect(n).toBeGreaterThan(90)
    expect(patterns).toBeGreaterThan(60)
  })

  test("quick from anywhere: ≤ 25 s typical and ≤ 35 s worst from capture to stopped on deck", () => {
    const times: number[] = []
    for (let b = 0; b < 16; b++)
      for (const dist of [600, 1700, 2950])
        for (const [height, speed, off] of [
          [300, 90, -1.2],
          [500, 230, 0],
          [700, 150, 1.2],
        ] as const) {
          const ship0 = stormShip(3)
          const plane = nearShip(ship0, dist, (b / 16) * Math.PI * 2, height, speed, off)
          if (captureMiss(plane, ship0)) continue
          times.push(land(plane, stormShip).steps * DT)
        }
    times.sort((a, b) => a - b)
    expect(times.length).toBeGreaterThan(120)
    expect(times[times.length >> 1]!).toBeLessThanOrEqual(25)
    expect(times[times.length - 1]!).toBeLessThanOrEqual(35)
  })

  test("the pattern flies a smooth curve: no course jumps, banked into the turns, and keeps clear of the water", () => {
    const ship0 = stormShip(3)
    // Dead ahead of the bow, flying straight at the ship: it has to swing all the way round behind the stern.
    const plane = nearShip(ship0, 2500, 0, 200, 160)
    let t = 3
    const l = startLanding(plane, ship0)
    expect(l.phase).toBe("pattern")
    let psi = l.psi
    let maxBank = 0
    let turned = 0
    while (l.phase === "pattern") {
      t += DT
      landingStep(l, plane, stormShip(t), DT)
      const d = Math.atan2(Math.sin(l.psi - psi), Math.cos(l.psi - psi))
      expect(Math.abs(d)).toBeLessThan(LANDING.turnRate * DT + 1e-9)
      turned += Math.abs(d)
      psi = l.psi
      maxBank = Math.max(maxBank, Math.abs(l.bank))
      expect(l.y).toBeGreaterThan(DECK_Y + 20)
    }
    expect(turned).toBeGreaterThan(Math.PI * 0.9)
    expect(maxBank).toBeGreaterThan(0.4)
    expect(l.phase).toBe("approach")
    expect(Math.abs(l.x - CENTERLINE_X)).toBeLessThan(10)
  })

  test("the capture blends in without a jump", () => {
    const ship = stormShip(3)
    const plane = behindShip(ship, 700, 100, 150, 150)
    const before = [plane.x, plane.y, plane.z]
    const l = startLanding(plane, ship)
    landingStep(l, plane, stormShip(3 + DT), DT)
    expect(Math.hypot(plane.x - before[0]!, plane.y - before[1]!, plane.z - before[2]!)).toBeLessThan(5)
  })

  test("wave-off: hard stick (> 80%) or the afterburner hands the jet back, flying; throttle alone never", () => {
    const ship = Object.assign(makeShip(0, 0, 0, 0), { u: 15 })
    const plane = behindShip(ship, 1200, 0, 150)
    const l = startLanding(plane, ship)
    for (let i = 0; i < 120; i++) landingStep(l, plane, ship, DT)
    // Throttle alone and moderate stick never abort; strong stick (> 70%) or the afterburner does.
    expect(wantsWaveOff(l, { pitch: 0.2, roll: 0.1, throttle: 1, boost: false })).toBe(false)
    expect(wantsWaveOff(l, { pitch: 0.75, roll: -0.75, throttle: 1, boost: false })).toBe(false)
    expect(wantsWaveOff(l, { pitch: 0.9, roll: 0, throttle: 0, boost: false })).toBe(true)
    expect(wantsWaveOff(l, { pitch: 0, roll: -0.85, throttle: 0, boost: false })).toBe(true)
    expect(wantsWaveOff(l, { pitch: 0, roll: 0, throttle: 0, boost: true })).toBe(true)
    waveOff(plane)
    const y = plane.y
    for (let i = 0; i < 180; i++) planeStep(plane, HANDS_OFF, DT, { sea: null, arch: null })
    expect(plane.crashed).toBe("")
    expect(plane.y).toBeGreaterThan(y)
    expect(planeSpeed(plane)).toBeGreaterThan(PLANE.stallSpeed)
    // Not once on the deck.
    const l2 = startLanding(behindShip(ship, 300, 0, 40), ship)
    l2.phase = "trap"
    expect(wantsWaveOff(l2, { pitch: 1, roll: 1, throttle: 1, boost: true })).toBe(false)
  })

  test("is deterministic", () => {
    const go = () => {
      const plane = behindShip(stormShip(3), 1500, 80, 200, 160)
      const r = land(plane, stormShip)
      return [r.steps, plane.x, plane.y, plane.z, plane.qx, plane.qw, worldToPlan(r.ship, plane.x, plane.y, plane.z)[2]]
    }
    expect(go()).toEqual(go())
  })
})
