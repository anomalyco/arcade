import { describe, expect, test } from "bun:test"
import { Bullets, CombatWorld, type CombatEvent, type Ground, flareAt, flareBurst, guide, launchMissile, makeMissile, sweep } from "../shared/combat"
import { PLANE, type Plane, type PlaneControls, type Vec3, makePlane, planeAttitude, planeStep, quatAxis, setPlaneQuat } from "../shared/plane"
import { LOADOUTS, WEAPONS, makeTarget, type Target } from "../shared/weapons"

const DT = PLANE.tick
const AIR: Ground = { sea: null, arch: null }
const steps = (s: number) => Math.round(s / DT)

/** Level flight, nose north (−z), at (x, y, z). */
function flying(v: number, x: number, y: number, z: number): Plane {
  const p = makePlane(0)
  Object.assign(p, { x, y, z, vz: -v, throttle: PLANE.cruise })
  setPlaneQuat(p, quatAxis(0, 1, 0, Math.PI))
  return p
}

const sync = (t: Target, p: Plane): Target => Object.assign(t, { x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz })

describe("rounds", () => {
  const N: Vec3 = [0, 0, -1]
  const U: Vec3 = [0, 1, 0]
  const L: Vec3 = [-1, 0, 0]

  test("fly at muzzle plus jet speed, drop under gravity and expire at their range", () => {
    const b = new Bullets(8)
    const i = b.fire(1, 0, 1, 0, 1000, 0, [0, 0, -140], N, U, L)
    let t = 0
    const seen: number[] = []
    while (b.state[i] && t < 5) {
      b.step(DT, t, [], AIR, () => {})
      t += DT
      seen.push(b.z[i]!)
    }
    expect(Math.abs(t - WEAPONS.gun.life)).toBeLessThan(DT * 1.5)
    const range = -seen[seen.length - 1]!
    expect(range).toBeGreaterThan(1300)
    expect(range).toBeLessThan(1550)
    // Round 1 is a spread round; the drop below its initial line is ½ g t² (within the dispersion).
    const drop = 1000 + (b.vy[i]! + 9.81 * t) * t - b.y[i]!
    expect(Math.abs(drop - 0.5 * 9.81 * t * t)).toBeLessThan(0.5)
  })

  test("dispersion is the same on every machine and every third round is a tracer", () => {
    const a = new Bullets(64)
    const b = new Bullets(64)
    for (let r = 0; r < 30; r++) {
      a.fire(5, 0, r, 0, 0, 0, [0, 0, 0], N, U, L)
      b.fire(5, 0, r, 0, 0, 0, [0, 0, 0], N, U, L)
    }
    expect([...a.vx]).toEqual([...b.vx])
    expect([...a.vy]).toEqual([...b.vy])
    let tracers = 0
    let maxOff = 0
    for (let r = 0; r < 30; r++) {
      if (a.state[r] === 2) tracers++
      maxOff = Math.max(maxOff, Math.hypot(a.vx[r]!, a.vy[r]!) / WEAPONS.gun.muzzle)
    }
    expect(tracers).toBe(10)
    expect(maxOff).toBeLessThanOrEqual(Math.tan(WEAPONS.gun.spread) + 1e-9)
    expect(maxOff).toBeGreaterThan(Math.tan(WEAPONS.gun.spread) * 0.5)
  })

  /** A burst from (0, 1000, 0) north at a jet crossing west to east 800 m ahead; `lead` aims ahead of it. */
  function crossing(lead: boolean, team = 1): { hits: number; ground: number } {
    const b = new Bullets(256)
    const tgt = flying(150, -150, 1000, -800)
    setPlaneQuat(tgt, quatAxis(0, 1, 0, Math.PI / 2))
    Object.assign(tgt, { vx: 150, vz: 0 })
    const tg = makeTarget(2, team)
    let hits = 0
    let ground = 0
    // Time of flight ≈ 800 / (1050 + 160) s; aim where the target will be then.
    const tof = 800 / 1210
    const aimX = lead ? tgt.x + 150 * tof + 150 * 0.3 : tgt.x
    const d = Math.hypot(aimX, 800)
    const f: Vec3 = [aimX / d, (0.5 * 9.81 * tof * tof) / 800, -800 / d]
    let t = 0
    for (let s = 0; s < steps(1.6); s++) {
      if (s < steps(0.6)) b.fire(1, 0, s, 0, 1000, 0, [0, 0, -160], f, U, L)
      planeStep(tgt, { pitch: 0, roll: 0, yaw: 0, throttle: 0, boost: false }, DT, AIR)
      sync(tg, tgt)
      t += DT
      b.step(DT, t, [tg], AIR, (_o, target) => (target >= 0 ? hits++ : ground++))
    }
    return { hits, ground }
  }

  test("a led burst hits a fast crossing jet; aiming at where it is misses", () => {
    expect(crossing(true).hits).toBeGreaterThan(2)
    expect(crossing(false).hits).toBe(0)
  })

  test("friendly fire is off", () => {
    expect(crossing(true, 0).hits).toBe(0)
  })

  test("the relative sweep catches a round passing through a jet within one step", () => {
    const out: [number] = [0]
    // The round crosses the jet's path between samples: the endpoints are both 18 m away, the middle passes through.
    const k = sweep(0, 0, -18, 0, 0, 18, 0, 0, 0, 0, 0, 0, out)
    expect(k).toBeCloseTo(0.5, 6)
    expect(out[0]).toBeCloseTo(0, 6)
  })

  test("rounds splash into the sea", () => {
    const b = new Bullets(4)
    b.fire(1, 0, 1, 0, 50, 0, [0, 0, -100], [0, -0.5, -Math.sqrt(0.75)], U, L)
    const hits: string[] = []
    for (let s = 0; s < 30; s++) b.step(DT, s * DT, [], AIR, (_o, _t, kind) => hits.push(kind))
    expect(hits).toEqual(["sea"])
  })
})

describe("missiles", () => {
  /**
   * A locked shot from 1,200 m behind a jet flying north at 140 m/s. When the missile comes within `breakAt` metres
   * the target rolls 90° and pulls (a break turn); `flareAt` drops flares instead. Returns the target's health.
   */
  function shot(opts: { breakAt?: number; flareAt?: number; team?: number } = {}): { hp: number; events: CombatEvent[] } {
    const w = new CombatWorld()
    w.spawn(1, 0)
    w.spawn(2, opts.team ?? 1)
    const tgt = flying(140, 0, 1500, 0)
    const tg = sync(makeTarget(2, opts.team ?? 1), tgt)
    const c: PlaneControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, boost: false }
    w.step(DT, [tg])
    w.fire({ owner: 1, seq: 0, t: w.t, x: 0, y: 1500, z: 1200, vx: 0, vy: 0, vz: -160, target: 2 })
    let broke = false
    let flared = false
    const events: CombatEvent[] = []
    for (let i = 0; i < steps(8); i++) {
      const m = w.missiles.find((m) => m.alive)
      const d = m ? Math.hypot(m.x - tgt.x, m.y - tgt.y, m.z - tgt.z) : Infinity
      if (d < (opts.breakAt ?? -1)) broke = true
      if (d < (opts.flareAt ?? -1) && !flared) flared = w.flare(2, w.t, tgt.x, tgt.y, tgt.z, tgt.vx, tgt.vy, tgt.vz)
      if (broke) {
        const a = planeAttitude(tgt)
        c.roll = Math.max(-1, Math.min(1, (Math.PI / 2 - a.bank) * 3))
        c.pitch = Math.abs(a.bank) > 1 ? 1 : 0.3
      }
      planeStep(tgt, c, DT, AIR)
      sync(tg, tgt)
      w.step(w.t + DT, [tg])
      events.push(...w.events.splice(0))
    }
    return { hp: w.hp(2), events }
  }

  test("proportional navigation runs down a jet flying straight: one hit nearly kills", () => {
    const { hp, events } = shot()
    expect(events.find((e) => e.k === "boom")).toMatchObject({ on: 2 })
    expect(hp).toBeGreaterThan(0)
    expect(hp).toBeLessThan(40)
  })

  test("from dead astern it runs down a jet fleeing on afterburner from the edge of the lock range", () => {
    const m = WEAPONS.missile
    const range = m.range * m.keepRange
    const v = PLANE.boostSpeed
    const s = launchMissile(makeMissile(), { owner: 0, seq: 0, t: 0, x: 0, y: 1000, z: 0, vx: 0, vy: 0, vz: -v, target: 1 }, 0)
    let tz = -range
    let best = Infinity
    for (let t = 0; t < m.life; t += DT) {
      tz -= v * DT
      guide(s, DT, true, 0, 1000, tz, 0, 0, -v)
      best = Math.min(best, Math.hypot(s.x, s.y - 1000, s.z - tz))
    }
    expect(best).toBeLessThan(m.fuse)
  })

  test("a break turn alone does not beat it, whenever it starts (flares are the escape)", () => {
    for (const breakAt of [2000, 800, 700, 250]) expect(shot({ breakAt }).hp).toBeLessThan(100)
  })

  test("flares decoy an inbound missile in time; too late, it hits", () => {
    const early = shot({ flareAt: 800 })
    expect(early.hp).toBe(100)
    expect(early.events.some((e) => e.k === "decoy")).toBe(true)
    expect(shot({ flareAt: 40 }).hp).toBeLessThan(100)
  })

  test("it passes friendly jets by", () => {
    const { hp, events } = shot({ team: 0 })
    expect(hp).toBe(100)
    expect(events.some((e) => e.k === "boom" && e.on >= 0)).toBe(false)
  })

  test("a dumbfire flies straight and falls", () => {
    const w = new CombatWorld()
    w.spawn(1, 0)
    w.fire({ owner: 1, seq: 0, t: 0, x: 0, y: 1500, z: 0, vx: 0, vy: 0, vz: -150, target: -1 })
    for (let i = 0; i < steps(3); i++) w.step(w.t + DT, [])
    const m = w.missiles.find((m) => m.alive)!
    expect(Math.abs(m.x)).toBeLessThan(1e-6)
    expect(m.y).toBeLessThan(1500)
    expect(m.z).toBeLessThan(-1000)
  })

  test("with authority a jet cannot fire more missiles than its rails hold", () => {
    const w = new CombatWorld()
    w.spawn(1, 0)
    const l = { owner: 1, seq: 0, t: 0, x: 0, y: 1500, z: 0, vx: 0, vy: 0, vz: -150, target: -1 }
    expect(w.fire(l)).not.toBeNull()
    expect(w.fire({ ...l, seq: 1 })).not.toBeNull()
    expect(w.fire({ ...l, seq: 2 })).toBeNull()
  })
})

describe("flares", () => {
  test("follow the closed form: shed the jet's speed and sink", () => {
    const fl = flareBurst(3, 10, 0, 1000, 0, 0, 0, -150)
    expect(fl.length).toBe(WEAPONS.flare.pairs * 2)
    const p: Vec3 = [0, 0, 0]
    flareAt(fl[0]!, 10 + 3, p)
    expect(p[1]).toBeLessThan(1000 - 10)
    // Decelerated: travelled far less than the jet would have in 3 s.
    expect(-p[2]).toBeLessThan(150 * 3 * 0.4)
    // Left and right of the flight path.
    flareAt(fl[1]!, 10 + 1, p)
    const right = p[0]
    flareAt(fl[0]!, 10 + 1, p)
    expect(Math.sign(right)).toBe(-Math.sign(p[0]))
  })
})

describe("damage", () => {
  test("gun hits are budgeted by the gun's rate and kill with credit", () => {
    const w = new CombatWorld()
    w.spawn(1, 0)
    w.spawn(2, 1)
    // A huge claim is cut to what the gun could have fired.
    expect(w.gunHit(1, 2, 500)).toBeLessThanOrEqual(WEAPONS.gun.rate)
    // Friendly: refused.
    w.spawn(3, 0)
    expect(w.gunHit(1, 3, 5)).toBe(0)
    // Keep hitting at the gun's rate until it dies.
    let t = 0
    while (w.fighters.get(2)!.alive && t < 10) {
      w.step(w.t + DT, [])
      w.gunHit(1, 2, 1)
      t += DT
    }
    expect(w.fighters.get(2)!.alive).toBe(false)
    expect(w.events.find((e) => e.k === "kill")).toMatchObject({ on: 2, by: 1, w: "gun" })
    // Out of range claims are refused.
    w.spawn(4, 1)
    expect(w.gunHit(1, 4, 3, 5000)).toBe(0)
  })

  test("damage states, repair after a quiet spell, and crash credit", () => {
    const w = new CombatWorld()
    w.spawn(1, 0)
    w.spawn(2, 1)
    w.step(1, [])
    w.gunHit(1, 2, 25)
    expect(w.hp(2)).toBeCloseTo(100 - 25 * WEAPONS.gun.damage, 6)
    for (let i = 0; i < steps(WEAPONS.health.repairDelay - 1); i++) w.step(w.t + DT, [])
    expect(w.hp(2)).toBeCloseTo(100 - 25 * WEAPONS.gun.damage, 6)
    for (let i = 0; i < steps(3); i++) w.step(w.t + DT, [])
    expect(w.hp(2)).toBeGreaterThan(100 - 25 * WEAPONS.gun.damage + 5)
    w.gunHit(1, 2, 5)
    w.crash(2)
    expect(w.events.filter((e) => e.k === "kill")).toEqual([{ k: "kill", on: 2, by: 1, w: "gun" }])
    // Without recent damage a crash credits nobody.
    w.spawn(3, 1)
    w.crash(3)
    expect(w.events.filter((e) => e.k === "kill").pop()).toEqual({ k: "kill", on: 3, by: -1, w: "" })
  })

  test("an F-35C's gun claims are refused (it has none)", () => {
    const w = new CombatWorld()
    w.spawn(1, 0, "f35")
    w.spawn(2, 1)
    expect(w.gunHit(1, 2, 5)).toBe(0)
    expect(w.hp(2)).toBe(100)
  })

  test("bombs fall from the bay and burst on the sea; the blast hurts enemy jets caught in it", () => {
    const w = new CombatWorld()
    w.spawn(1, 0, "f35")
    w.spawn(2, 1)
    const low = Object.assign(makeTarget(2, 1), { x: 0, y: 5, z: -1500 })
    w.fire({ owner: 1, seq: 0, t: 0, x: 0, y: 400, z: 0, vx: 0, vy: 0, vz: -150, target: 2, kind: "bomb" })
    // The room's budget is the F-35C's bomb load: every store, then nothing.
    for (let seq = 1; seq < LOADOUTS.f35.bombs; seq++) expect(w.fire({ owner: 1, seq, t: 0, x: 0, y: 400, z: 0, vx: 0, vy: 0, vz: -150, target: -1, kind: "bomb" })).not.toBeNull()
    expect(w.fire({ owner: 1, seq: LOADOUTS.f35.bombs, t: 0, x: 0, y: 400, z: 0, vx: 0, vy: 0, vz: -150, target: -1, kind: "bomb" })).toBeNull()
    for (let i = 0; i < steps(12); i++) w.step(w.t + DT, [low])
    const boom = w.events.find((e) => e.k === "boom")!
    expect(boom).toMatchObject({ water: true, bomb: true, on: -1 })
    if (boom.k !== "boom") throw new Error()
    // ≈ 150 m/s for the fall time of 400 m (about 9 s), never steered toward the jet.
    expect(Math.abs(boom.x)).toBeLessThan(1e-6)
    expect(boom.z).toBeLessThan(-1100)
    expect(boom.z).toBeGreaterThan(-1450)
    expect(w.hp(2)).toBe(100)
    // A jet right over the burst point is caught.
    const w2 = new CombatWorld()
    w2.spawn(1, 0, "f35")
    w2.spawn(2, 1)
    const over = Object.assign(makeTarget(2, 1), { x: 0, y: 10, z: boom.z })
    w2.fire({ owner: 1, seq: 0, t: 0, x: 0, y: 400, z: 0, vx: 0, vy: 0, vz: -150, target: -1, kind: "bomb" })
    for (let i = 0; i < steps(12); i++) w2.step(w2.t + DT, [over])
    expect(w2.hp(2)).toBeLessThan(100)
  })

  test("without authority missiles fly and burst but nobody's health changes", () => {
    const w = new CombatWorld(AIR, false)
    w.spawn(1, 0)
    w.spawn(2, 1)
    const tg = Object.assign(makeTarget(2, 1), { x: 0, y: 1500, z: -600, vz: -100 })
    w.fire({ owner: 1, seq: 0, t: 0, x: 0, y: 1500, z: 0, vx: 0, vy: 0, vz: -200, target: 2 })
    for (let i = 0; i < steps(4); i++) {
      tg.z += tg.vz * DT
      w.step(w.t + DT, [tg])
    }
    expect(w.events.some((e) => e.k === "boom" && e.on === 2)).toBe(true)
    expect(w.hp(2)).toBe(100)
    expect(w.events.some((e) => e.k === "hp" || e.k === "kill")).toBe(false)
  })
})

test("the world is deterministic: the same inputs give the same missiles, flares, health and events", () => {
  const run = () => {
    const w = new CombatWorld()
    w.spawn(1, 0)
    w.spawn(2, 1)
    w.spawn(3, 1)
    const a = flying(150, 0, 1200, 0)
    const b = flying(170, 300, 1300, 400)
    const ta = makeTarget(2, 1)
    const tb = makeTarget(3, 1)
    const ca: PlaneControls = { pitch: 0.6, roll: 0.4, yaw: 0, throttle: 1, boost: false }
    const cb: PlaneControls = { pitch: 0.2, roll: -0.3, yaw: 0.1, throttle: 0, boost: true }
    for (let i = 0; i < steps(9); i++) {
      if (i === 30) w.fire({ owner: 1, seq: 0, t: w.t, x: 0, y: 1250, z: 1500, vx: 0, vy: 0, vz: -170, target: 2 })
      if (i === 60) w.fire({ owner: 1, seq: 1, t: w.t, x: 50, y: 1250, z: 1500, vx: 0, vy: 0, vz: -170, target: 3 })
      if (i === 150) w.flare(3, w.t, b.x, b.y, b.z, b.vx, b.vy, b.vz)
      planeStep(a, ca, DT, AIR)
      planeStep(b, cb, DT, AIR)
      w.step(w.t + DT, [sync(ta, a), sync(tb, b)])
    }
    return JSON.stringify({ m: w.missiles.filter((m) => m.alive || m.age > 0).map(({ decoy, ...m }) => m), hp: [w.hp(2), w.hp(3)], e: w.events })
  }
  const one = run()
  expect(run()).toBe(one)
  expect(one).toContain("boom")
})
