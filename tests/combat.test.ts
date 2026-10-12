import { afterEach, describe, expect, test } from "bun:test"
import {
  SHIP_TARGET_PREFIX, applyTurretInput, damageShip, shipRuntime, segmentHitsShipEx, SHIP_SINK_COLLISION_TIME,
  AA_ACQUIRE, AA_TURRETS, fleetAaDps, type AaTurret, isSpawnProtected, markSpawned, turretHasLOS,
  FLARE_TARGET_PREFIX, WEAPON_DAMAGE_MULT, GUN_FULL_RANGE, VIEW_DELAY_DEFAULT, gunLeadPoint, gunCanReach, GUN_GIMBAL, weaponDirection, gunRangeFactor, hitboxSweep, missileDirectDamage, muzzlePosition, rewoundPosition, viewDelayOf, RECON_KINDS, SPOT_COOLDOWN, SPOT_DURATION, SPOT_TIME, applySeatInput, createCombatState, createWeapons, damageFor, killVehicle, leadPoint,
  stepCombat, sweptSphere, type CombatState,
} from "../src/sim/combat"
import { WORLD_HALF, groundHeight, isWater, posedShip, segmentHitsGround, setFleetState, shipAt, terrainHeight } from "../src/sim/geography"
import { AA_RANGE, FLEET, SHIP_DAMAGE_SCALE, TURRET_HP, SPAWN_PROTECTION, SHIP_SPECS, shipPose, shipToWorld, shipToWorldAt, type Ship } from "../src/sim/fleet"
import { TICK_DT, type GameEvent, type Quat, type SeatIndex, type SeatInput, type TeamId, type Vec3, type VehicleEntity, type VehicleKind } from "../src/sim/types"
import { VEHICLES, WEAPONS } from "../src/sim/vehicles"

const ALT = 3000

/** Quaternion whose nose (-Z) points along dir. */
function look(dir: Vec3): Quat {
  const l = Math.hypot(dir[0], dir[1], dir[2])
  const dx = dir[0] / l, dy = dir[1] / l, dz = dir[2] / l
  const yaw = Math.atan2(-dx, -dz), pitch = Math.asin(dy)
  const qy: Quat = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
  const qx: Quat = [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)]
  // qy * qx
  return [
    qy[3] * qx[0] + qy[0] * qx[3] + qy[1] * qx[2] - qy[2] * qx[1],
    qy[3] * qx[1] - qy[0] * qx[2] + qy[1] * qx[3] + qy[2] * qx[0],
    qy[3] * qx[2] + qy[0] * qx[1] - qy[1] * qx[0] + qy[2] * qx[3],
    qy[3] * qx[3] - qy[0] * qx[0] - qy[1] * qx[1] - qy[2] * qx[2],
  ]
}

let vid = 0
function vehicle(kind: VehicleKind, team: TeamId, position: Vec3, velocity: Vec3, nose: Vec3 = [0, 0, -1]): VehicleEntity {
  const id = `v${++vid}`
  const spec = VEHICLES[kind]
  return {
    id, kind, team,
    flight: {
      kind, position: [...position], velocity: [...velocity], orientation: look(nose), angularVelocity: [0, 0, 0],
      throttle: 1, onGround: false, gearDown: false, crashed: null, tick: 0,
    },
    hp: spec.maxHp, maxHp: spec.maxHp,
    seats: [`${id}-pilot`, `${id}-gunner`],
    aim: [null, null],
    weapons: createWeapons(kind),
    flaresReadyAt: 0, flareCount: spec.flares, abilityReadyAt: 0, spottedUntil: 0, lastDamagedBy: null, alive: true,
  }
}

/** Seat input from a shooter that sees the authoritative state (viewDelay 0) unless overridden. */
function input(p: Partial<SeatInput> & { viewDelay?: number } = {}): SeatInput {
  return { aim: null, firePrimary: false, fireSecondary: false, flares: false, ability: false, viewDelay: 0, ...p } as SeatInput
}

interface World { cs: CombatState; vehicles: VehicleEntity[]; events: GameEvent[]; now: number }
function world(vehicles: VehicleEntity[]): World {
  return { cs: createCombatState(), vehicles, events: [], now: 0 }
}

/** One tick: move vehicles, apply seat inputs, step combat. */
function tick(w: World, inputs: [VehicleEntity, SeatIndex, SeatInput][] = []) {
  w.now += TICK_DT
  for (const v of w.vehicles) {
    if (!v.alive) continue
    const p = v.flight.position, u = v.flight.velocity
    p[0] += u[0] * TICK_DT; p[1] += u[1] * TICK_DT; p[2] += u[2] * TICK_DT
  }
  for (const [v, s, i] of inputs) applySeatInput(w.cs, v, s, i, w.vehicles, w.now, w.events)
  stepCombat(w.cs, w.vehicles, TICK_DT, w.now, w.events)
}

const hits = (w: World, target: VehicleEntity) => w.events.filter(e => e.type === "hit" && e.target === target.id)
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

describe("guns", () => {
  test("swept sphere catches a bullet that would tunnel at 300 m/s closing speed", () => {
    // Bullet 1000 m/s + target 300 m/s toward each other: 21.7 m per tick relative, sphere diameter 16 m.
    const t = sweptSphere([0, 0, 0], [0, 0, -1000 * TICK_DT], [0, 0, -14], [0, 0, 300], TICK_DT, 8)
    expect(t).toBeGreaterThanOrEqual(0)
    expect(t).toBeLessThanOrEqual(1)
  })

  test("head-on burst registers every round despite high closing speed", () => {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
    const target = vehicle("fighter", 1, [0, ALT, -900], [0, 0, 150], [0, 0, 1])
    const w = world([shooter, target])
    for (let i = 0; i < 30; i++) tick(w, [[shooter, 0, input({ firePrimary: true })]])
    for (let i = 0; i < 90; i++) tick(w)
    const shots = 600 - shooter.weapons[0][0].ammo
    expect(shots).toBeGreaterThanOrEqual(8)
    expect(hits(w, target).length).toBe(shots)
    expect(target.hp).toBeCloseTo(450 - shots * damageFor("cannon20", target, 0), 6)
  })

  test("crossing target at 300 m/s is hit with lead", () => {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
    const target = vehicle("fighter", 1, [-400, ALT, -700], [300, 0, 0], [1, 0, 0])
    const w = world([shooter, target])
    for (let i = 0; i < 40; i++) {
      const lp: Vec3 = [0, 0, 0]
      // Aim the nose at the lead point each tick (perfect pilot).
      const tpos = target.flight.position.map((x, k) => x + target.flight.velocity[k] * TICK_DT) as Vec3
      const spos = shooter.flight.position.map((x, k) => x + shooter.flight.velocity[k] * TICK_DT) as Vec3
      expect(leadPoint(spos, shooter.flight.velocity, WEAPONS.cannon20.speed, tpos, target.flight.velocity, lp)).toBeGreaterThan(0)
      shooter.flight.orientation = look(sub(lp, spos))
      tick(w, [[shooter, 0, input({ firePrimary: true })]])
    }
    for (let i = 0; i < 60; i++) tick(w)
    const shots = 600 - shooter.weapons[0][0].ammo
    expect(hits(w, target).length).toBeGreaterThanOrEqual(shots - 1)
  })

  test("friendly fire is ignored", () => {
    const shooter = vehicle("warthog", 0, [0, ALT, 0], [0, 0, -100])
    const friend = vehicle("fighter", 0, [0, ALT, -400], [0, 0, -50])
    const w = world([shooter, friend])
    for (let i = 0; i < 60; i++) tick(w, [[shooter, 0, input({ firePrimary: true })]])
    for (let i = 0; i < 60; i++) tick(w)
    expect(friend.hp).toBe(friend.maxHp)
    expect(hits(w, friend).length).toBe(0)
  })

  test("apache chin gun is clamped to its arc (cannot fire straight up)", () => {
    const apache = vehicle("apache", 0, [0, ALT, 0], [0, 0, 0])
    const w = world([apache])
    tick(w, [[apache, 1, input({ aim: [0, 1, 0], firePrimary: true })]])
    const p = w.cs.projectiles[0]
    const s = Math.hypot(...p.velocity)
    expect(Math.asin(p.velocity[1] / s)).toBeLessThan(0.25)
  })
})

describe("spawn protection", () => {
  test("freshly spawned vehicle takes no damage for SPAWN_PROTECTION s", () => {
    const target = vehicle("fighter", 1, [0, ALT, -500], [0, 0, 0])
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, 0])
    const w = world([shooter, target])
    markSpawned(target, 0)
    while (w.now < SPAWN_PROTECTION - 1) tick(w, [[shooter, 0, input({ firePrimary: true })]])
    expect(600 - shooter.weapons[0][0].ammo).toBeGreaterThan(0)
    expect(target.hp).toBe(target.maxHp)
    expect(isSpawnProtected(target, w.now)).toBe(true)
    while (w.now < SPAWN_PROTECTION + 1) tick(w, [[shooter, 0, input({ firePrimary: true })]])
    expect(target.hp).toBeLessThan(target.maxHp)
  })

  test("freshly spawned vehicle cannot fire", () => {
    const shooter = vehicle("fighter", 1, [0, ALT, 0], [0, 0, 0])
    const w = world([shooter])
    markSpawned(shooter, 0)
    for (let i = 0; i < 30; i++) tick(w, [[shooter, 0, input({ firePrimary: true, fireSecondary: true })]])
    expect(w.cs.projectiles.length).toBe(0)
    expect(w.cs.missiles.length).toBe(0)
    expect(shooter.weapons[0][0].ammo).toBe(WEAPONS.cannon20.ammo)
  })
})

describe("fleet AA", () => {
  const carrier = FLEET.find(s => s.team === 1 && s.kind === "carrier")!
  const enemyTurrets = (team: TeamId) => AA_TURRETS.filter(t => t.team !== team)
  const minTurretDist = (p: Vec3, team: TeamId) => Math.min(...enemyTurrets(team).map(t => Math.hypot(p[0] - t.position[0], p[1] - t.position[1], p[2] - t.position[2])))
  /** Point at horizontal distance `d` from the team-1 carrier, on the side away from the map centre. */
  const outward = (d: number, y: number): Vec3 => {
    const l = Math.hypot(carrier.position[0], carrier.position[2])
    return [carrier.position[0] + carrier.position[0] / l * d, y, carrier.position[2] + carrier.position[2] / l * d]
  }
  const aaEvents = (w: World, v: VehicleEntity) => w.events.filter(e => (e as unknown as { type: string; target: string }).type === "aa" && (e as unknown as { target: string }).target === v.id)

  /** First point outward from the team-1 carrier whose nearest enemy turret is ≥ md away. */
  const atMinDist = (md: number, y = 300): Vec3 => {
    let d = 0
    while (minTurretDist(outward(d, y), 0) < md) d += 5
    return outward(d, y)
  }

  /** Nearest enemy turret position to p (team-1 fleet). */
  const nearestTurret = (p: Vec3) => enemyTurrets(0).reduce((a, t) => (dist3(t.position, p) < dist3(a.position, p) ? t : a)).position
  const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  test("loitering at 400 m still kills (slow target dies in a few seconds, credited to the fleet)", () => {
    const f = vehicle("fighter", 0, atMinDist(400), [0, 0, 0])
    const w = world([f])
    while (f.alive && w.now < 20) tick(w)
    console.log(`AA: hovering fighter at 400 m dies after ${w.now.toFixed(1)} s`)
    expect(f.alive).toBe(false)
    expect(w.now).toBeGreaterThan(AA_ACQUIRE)
    expect(w.now).toBeLessThan(8)
    const kill = w.events.find(e => e.type === "kill") as unknown as { killer: unknown; weapon: string; killerTeam: number }
    expect(kill).toMatchObject({ killer: null, weapon: "aa", killerTeam: 1 })
    expect(aaEvents(w, f).length).toBeGreaterThan(0)
  })

  test("orbiting at 400 m at speed is slower to kill but still lethal", () => {
    const start = atMinDist(400)
    const c = nearestTurret(start)
    const r = Math.hypot(start[0] - c[0], start[2] - c[2])
    const f = vehicle("fighter", 0, start, [0, 0, 0])
    const w = world([f])
    let ang = Math.atan2(start[2] - c[2], start[0] - c[0])
    const speed = 160
    while (f.alive && w.now < 60) {
      ang += (speed / r) * TICK_DT
      // Kinematic orbit: set velocity tangent so the harness integrates the circle.
      f.flight.velocity = [-Math.sin(ang) * speed, 0, Math.cos(ang) * speed]
      tick(w)
    }
    console.log(`AA: fighter orbiting at 400 m / ${speed} m/s dies after ${w.now.toFixed(1)} s`)
    expect(f.alive).toBe(false)
    expect(w.now).toBeLessThan(40)
    expect(w.now).toBeGreaterThan(6)
  })

  test("a missile pass to 1 km and break-away is survivable", () => {
    // Head straight at the nearest turret from 3 km at 180 m/s, break 120° at 1 km, extend out.
    const start = atMinDist(3000)
    const c = nearestTurret(start)
    const dx = c[0] - start[0], dz = c[2] - start[2], l = Math.hypot(dx, dz)
    const f = vehicle("fighter", 0, start, [dx / l * 180, 0, dz / l * 180])
    const w = world([f])
    let breaking = false, heading = Math.atan2(dz, dx), target = heading
    while (f.alive && w.now < 30) {
      if (!breaking && minTurretDist(f.flight.position, 0) <= 1000) { breaking = true; target = heading + (2 * Math.PI) / 3 }
      if (breaking && heading < target) heading = Math.min(target, heading + 0.5 * TICK_DT) // ~5 g turn at 180 m/s
      f.flight.velocity = [Math.cos(heading) * 180, 0, Math.sin(heading) * 180]
      tick(w)
    }
    const left = f.hp / f.maxHp
    console.log(`AA: 1 km missile pass leaves ${(left * 100).toFixed(0)}% hull`)
    expect(f.alive).toBe(true)
    expect(left).toBeGreaterThan(0.6)
  })

  test("jinking at speed takes far less than flying straight or hovering", () => {
    const run = (mode: "hover" | "straight" | "jink") => {
      const start = atMinDist(600)
      const c = nearestTurret(start)
      const ox = start[0] - c[0], oz = start[2] - c[2], l = Math.hypot(ox, oz)
      const tx = -oz / l, tz = ox / l // tangent (crossing)
      const f = vehicle("fighter", 0, start, [0, 0, 0])
      f.hp = 1e6; f.maxHp = 1e6
      const w = world([f])
      while (w.now < 6) {
        if (mode === "straight") f.flight.velocity = [tx * 200, 0, tz * 200]
        if (mode === "jink") {
          // 200 m/s crossing with a ±0.6 rad weave at 1 Hz: ~75 m/s² lateral.
          const a = 0.6 * Math.sin(w.now * 2 * Math.PI)
          f.flight.velocity = [(tx * Math.cos(a) + ox / l * Math.sin(a)) * 200, 0, (tz * Math.cos(a) + oz / l * Math.sin(a)) * 200]
        }
        tick(w)
      }
      return 1e6 - f.hp
    }
    const hover = run("hover"), straight = run("straight"), jink = run("jink")
    console.log(`AA at 600 m over 6 s: hover ${hover.toFixed(0)}, straight 200 m/s ${straight.toFixed(0)}, jinking ${jink.toFixed(0)} damage`)
    expect(straight).toBeLessThan(hover)
    expect(jink).toBeLessThan(straight * 0.6)
  })

  test("beyond 1200 m nothing fires (no long-range gun shots)", () => {
    const far = vehicle("warthog", 0, atMinDist(1250), [0, 0, 0])
    const w = world([far])
    for (let i = 0; i < 600; i++) tick(w)
    expect(far.hp).toBe(far.maxHp)
    expect(w.events).toHaveLength(0)
    expect(fleetAaDps(0, far.flight.position)).toBe(0)
  })

  test("own-team aircraft are never targeted", () => {
    const own = vehicle("fighter", 1, [carrier.position[0] + 600, 200, carrier.position[2]], [0, 0, 0])
    const w = world([own])
    for (let i = 0; i < 300; i++) tick(w)
    expect(own.hp).toBe(own.maxHp)
    expect(w.events).toHaveLength(0)
  })

  test("spawn-protected enemies are not engaged", () => {
    const f = vehicle("fighter", 0, atMinDist(400, 200), [0, 0, 0])
    const w = world([f])
    markSpawned(f, 0)
    while (w.now < SPAWN_PROTECTION - 0.5) tick(w)
    expect(f.hp).toBe(f.maxHp)
    expect(aaEvents(w, f)).toHaveLength(0)
    while (f.alive && w.now < SPAWN_PROTECTION + 4) tick(w)
    expect(f.alive).toBe(false)
  })

  test("terrain line of sight blocks fire", () => {
    // Fleets sit in open ocean, so place a temporary team-1 turret beside the map's highest peak.
    let peak: Vec3 = [0, -1e9, 0]
    for (let x = -WORLD_HALF + 2500; x < WORLD_HALF - 2500; x += 100) {
      for (let z = -WORLD_HALF + 2500; z < WORLD_HALF - 2500; z += 100) {
        const h = terrainHeight(x, z)
        if (h > peak[1]) peak = [x, h, z]
      }
    }
    expect(peak[1]).toBeGreaterThan(100)
    // Put the test ship on open water on one side of the peak and the hidden target low behind the other
    // side, within AA range of the turret.
    let found: { ship: Ship; turret: AaTurret; hidden: Vec3 } | null = null
    search: for (let r = 300; r <= 1100; r += 50) {
      for (let k = 0; k < 32; k++) {
        const ang = (k / 32) * Math.PI * 2, dx = Math.cos(ang), dz = Math.sin(ang)
        if (groundHeight(peak[0] - dx * r, peak[2] - dz * r) > 0.5) continue
        const ship: Ship = { id: "test-dd", team: 1, kind: "destroyer", position: [peak[0] - dx * r, 0, peak[2] - dz * r], heading: 0 }
        const turret: AaTurret = { ship, turret: "ciws_test", kind: "ciws", team: 1, position: shipToWorld(ship, [0, 18, 0]) }
        for (let back = 100; r + back <= 1100; back += 50) {
          const hx = peak[0] + dx * back, hz = peak[2] + dz * back
          const hidden: Vec3 = [hx, groundHeight(hx, hz) + 15, hz]
          if (!turretHasLOS(turret, hidden)) { found = { ship, turret, hidden }; break search }
        }
      }
    }
    expect(found).not.toBeNull()
    const { ship, turret } = found!
    const hidden = vehicle("apache", 0, found!.hidden, [0, 0, 0])
    const visible = vehicle("apache", 2, [ship.position[0], 400, ship.position[2] + 500], [0, 0, 0])
    expect(turretHasLOS(turret, hidden.flight.position)).toBe(false)
    expect(turretHasLOS(turret, visible.flight.position)).toBe(true)
    expect(minTurretDist(hidden.flight.position, 0)).toBeGreaterThan(AA_RANGE)
    AA_TURRETS.push(turret)
    try {
      const w = world([hidden])
      for (let i = 0; i < 180; i++) tick(w)
      expect(hidden.hp).toBe(hidden.maxHp)
      expect(aaEvents(w, hidden)).toHaveLength(0)
      const w2 = world([visible])
      for (let i = 0; i < 180; i++) tick(w2)
      expect(visible.hp).toBeLessThan(visible.maxHp)
    } finally {
      AA_TURRETS.pop()
    }
  })

  test("5-inch gun fires flak bursts with splash", () => {
    const dd = AA_TURRETS.find(t => t.team === 1 && t.kind === "gun")!
    const f = vehicle("warthog", 0, [dd.position[0] + 900, 400, dd.position[2]], [0, 0, 0])
    f.hp = 1e6
    const w = world([f])
    for (let i = 0; i < 600; i++) tick(w)
    expect(w.events.filter(e => e.type === "explosion").length).toBeGreaterThan(2)
  })

  describe("moving fleets", () => {
    afterEach(() => setFleetState(0, 4))

    test("turrets follow the ships at t=300 and engage around the moved carrier", () => {
      setFleetState(300, 4)
      const moved = shipPose(carrier, 300).position
      expect(Math.hypot(moved[0] - carrier.position[0], moved[2] - carrier.position[2])).toBeGreaterThan(100)
      const f = vehicle("fighter", 0, [moved[0] + 500, 300, moved[2]], [0, 0, 0])
      const w = world([f])
      tick(w)
      const spec = SHIP_SPECS.carrier.turrets[0]
      const t = AA_TURRETS.find(x => x.ship.id === carrier.id && x.turret === spec.id)!
      const expected = shipToWorldAt(carrier, 300, spec.offset)
      for (let k = 0; k < 3; k++) expect(t.position[k]).toBeCloseTo(expected[k], 6)
      while (f.alive && w.now < 4) tick(w)
      expect(f.alive).toBe(false)
      // Line of sight is tested against the moved hull: a turret sees past its own (moved) ship.
      expect(turretHasLOS(t, [moved[0] + 500, 300, moved[2]])).toBe(true)
    })

    test("inactive teams' fleets never fire", () => {
      setFleetState(0, 2)
      const c3 = FLEET.find(sh => sh.team === 3 && sh.kind === "carrier")!
      const f = vehicle("fighter", 0, [c3.position[0] + 600, 200, c3.position[2]], [0, 0, 0])
      const w = world([f])
      for (let i = 0; i < 300; i++) tick(w)
      expect(f.hp).toBe(f.maxHp)
      expect(aaEvents(w, f)).toHaveLength(0)
    })
  })

  test("deterministic and cheap", () => {
    const run = () => {
      vid = 500
      const vs: VehicleEntity[] = []
      for (let i = 0; i < 40; i++) {
        const ship = FLEET[(i * 5) % FLEET.length]
        const a = i * 2.4
        vs.push(vehicle("fighter", ((ship.team + 1 + (i % 3)) % 4) as TeamId, [ship.position[0] + Math.cos(a) * (900 + i * 40), 200 + i * 20, ship.position[2] + Math.sin(a) * (900 + i * 40)], [Math.sin(a) * 120, 0, -Math.cos(a) * 120]))
      }
      for (const v of vs) v.hp = 1e9
      const w = world(vs)
      const t0 = performance.now()
      for (let i = 0; i < 600; i++) tick(w)
      return { json: JSON.stringify({ cs: w.cs, events: w.events, hp: vs.map(v => v.hp) }), ms: (performance.now() - t0) / 600 }
    }
    const a = run(), b = run()
    expect(a.json).toBe(b.json)
    console.log(`fleet AA: ${AA_TURRETS.length} turrets + 40 aircraft = ${b.ms.toFixed(3)} ms/tick (incl. test harness)`)
    expect(b.ms).toBeLessThan(0.5)
  })
})

describe("lock-on missiles", () => {
  test("lock acquires in lockTime, warns the target while tracking, and breaks the instant it leaves the cone", () => {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, 0])
    const target = vehicle("fighter", 1, [0, ALT, -900], [0, 0, 0])
    const w = world([shooter, target])
    const rt = shooter.weapons[0][1]
    const locks = () => w.events.filter(e => e.type === "lock") as Extract<GameEvent, { type: "lock" }>[]
    const ticks = Math.round(WEAPONS.aim9.lockTime! / TICK_DT)
    tick(w, [[shooter, 0, input()]])
    expect(locks()).toEqual([{ type: "lock", vehicle: shooter.id, target: target.id, locked: false }]) // tracking warning
    for (let i = 0; i < ticks - 2; i++) tick(w, [[shooter, 0, input()]])
    expect(rt.lockTarget).toBe(target.id)
    expect(rt.lock).toBeLessThan(1)
    expect(locks().filter(e => e.locked)).toHaveLength(0)
    expect(locks()).toHaveLength(2) // start + half-way
    tick(w, [[shooter, 0, input()]])
    expect(rt.lock).toBe(1)
    expect(locks().filter(e => e.locked)).toHaveLength(1)

    // Just outside the ~4.6° seeker cone: no hysteresis, the lock drops at once.
    const off = WEAPONS.aim9.lockCone! * 1.05
    target.flight.position = [Math.sin(off) * 900, ALT, -Math.cos(off) * 900]
    tick(w, [[shooter, 0, input()]])
    expect(rt.lockTarget).toBeNull()
    expect(rt.lock).toBe(0)
    expect(locks().filter(e => !e.locked)).toHaveLength(3)
  })

  test("heat-seeker lock range is short (~1.1 km)", () => {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, 0])
    const target = vehicle("fighter", 1, [0, ALT, -1300], [0, 0, 0])
    const w = world([shooter, target])
    for (let i = 0; i < 10; i++) tick(w, [[shooter, 0, input()]])
    expect(shooter.weapons[0][1].lockTarget).toBeNull()
    expect(WEAPONS.aim9.ammo).toBe(2)
  })

  test("out of range targets are not locked; aim47 locks at long range", () => {
    const fighter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, 0])
    const bb = vehicle("blackbird", 0, [10, ALT, 0], [0, 0, 0])
    const target = vehicle("fighter", 1, [0, ALT, -5000], [0, 0, 0])
    const w = world([fighter, bb, target])
    for (let i = 0; i < 10; i++) tick(w, [[fighter, 0, input({ aim: [0, 0, -1] })], [bb, 1, input({ aim: [0, 0, -1] })]])
    expect(fighter.weapons[0][1].lockTarget).toBeNull()
    expect(bb.weapons[1][0].lockTarget).toBe(target.id)
    target.flight.position = [0, ALT, -8500]
    tick(w, [[bb, 1, input({ aim: [0, 0, -1] })]])
    expect(bb.weapons[1][0].lockTarget).toBeNull()
  })

  test("homing missile hits a straight-flying target and destroys it", () => {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
    const target = vehicle("fighter", 1, [-60, ALT + 30, -900], [150, 0, -40], [1, 0, 0])
    const w = world([shooter, target])
    const track = () => { shooter.flight.orientation = look(sub(target.flight.position, shooter.flight.position)) }
    for (let i = 0; i < Math.round(WEAPONS.aim9.lockTime! / TICK_DT) + 1; i++) { track(); tick(w, [[shooter, 0, input()]]) }
    expect(shooter.weapons[0][1].lock).toBe(1)
    track()
    tick(w, [[shooter, 0, input({ fireSecondary: true })]])
    expect(w.cs.missiles).toHaveLength(1)
    expect(w.cs.missiles[0].target).toBe(target.id)
    for (let i = 0; i < 8 * 60 && w.cs.missiles.length; i++) tick(w)
    const h = hits(w, target)
    expect(h).toHaveLength(1)
    expect(target.alive).toBe(false) // missile direct hits destroy outright
    expect(target.lastDamagedBy).toBe(shooter.seats[0])
  })

  test("firing without lock launches a dumbfire missile", () => {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
    const w = world([shooter])
    tick(w, [[shooter, 0, input({ fireSecondary: true })]])
    expect(w.cs.missiles).toHaveLength(1)
    expect(w.cs.missiles[0].target).toBeNull()
    expect(shooter.weapons[0][1].ammo).toBe(WEAPONS.aim9.ammo - 1)
  })

  test("flares decoy ~80–90% of inbound heat-seekers", () => {
    let decoyed = 0, survived = 0
    const N = 30
    for (let n = 0; n < N; n++) {
      const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
      const target = vehicle("fighter", 1, [0, ALT, -900], [0, 0, -150])
      const w = world([shooter, target])
      w.cs.nextId = 1 + n * 7 // vary ids → vary deterministic rolls
      for (let i = 0; i < Math.round(WEAPONS.aim9.lockTime! / TICK_DT) + 1; i++) tick(w, [[shooter, 0, input()]])
      tick(w, [[shooter, 0, input({ fireSecondary: true })]])
      for (let i = 0; i < 30; i++) tick(w)
      tick(w, [[target, 0, input({ flares: true })]])
      expect(w.events.some(e => e.type === "flares")).toBe(true)
      expect(target.flareCount).toBe(VEHICLES.fighter.flares - 1)
      if (w.cs.missiles[0]?.target?.startsWith(FLARE_TARGET_PREFIX)) decoyed++
      for (let i = 0; i < 8 * 60 && w.cs.missiles.length; i++) tick(w)
      if (target.hp === target.maxHp) survived++
    }
    expect(decoyed).toBeGreaterThanOrEqual(N * 0.7)
    expect(decoyed).toBeLessThan(N)
    expect(survived).toBe(decoyed)
  })

  test("flare cooldown and count are enforced", () => {
    const v = vehicle("blackbird", 0, [0, ALT, 0], [0, 0, -200])
    const w = world([v])
    for (let i = 0; i < 60; i++) tick(w, [[v, 0, input({ flares: true })]])
    expect(w.events.filter(e => e.type === "flares")).toHaveLength(1)
    expect(v.flareCount).toBe(VEHICLES.blackbird.flares - 1)
  })
})

describe("lock-on (gunner) missiles", () => {
  test("apache gunner hellfire locks along the seat aim and hits an off-boresight target", () => {
    const apache = vehicle("apache", 0, [0, ALT, 0], [0, 0, -40])
    const target = vehicle("apache", 1, [1200, ALT - 100, -700], [0, 0, -30])
    const w = world([apache, target])
    const aimAt = () => input({ aim: sub(target.flight.position, apache.flight.position) })
    const ticks = Math.round(WEAPONS.hellfire.lockTime! / TICK_DT)
    for (let i = 0; i < ticks; i++) tick(w, [[apache, 1, aimAt()]])
    expect(apache.weapons[1][1].lock).toBe(1)
    tick(w, [[apache, 1, { ...aimAt(), fireSecondary: true }]])
    expect(w.cs.missiles[0]).toMatchObject({ target: target.id, steered: false, seat: 1 })
    // Fire-and-forget: the gunner looks away.
    for (let i = 0; i < 10 * 60 && w.cs.missiles.length; i++) tick(w, [[apache, 1, input({ aim: [-1, 0, 0] })]])
    expect(hits(w, target)).toHaveLength(1)
  })

  test("pilot seekers lock along the nose, ignoring the seat aim", () => {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, 0])
    const target = vehicle("fighter", 1, [1000, ALT, 0], [0, 0, 0])
    const w = world([shooter, target])
    for (let i = 0; i < 90; i++) tick(w, [[shooter, 0, input({ aim: [1, 0, 0] })]])
    expect(shooter.weapons[0][1].lockTarget).toBeNull()
  })

  test("null slots do nothing (blackbird pilot has no weapons)", () => {
    const bb = vehicle("blackbird", 0, [0, ALT, 0], [0, 0, -200])
    expect(bb.weapons[0]).toHaveLength(2)
    expect(bb.weapons[0][0].ammo).toBe(0)
    const w = world([bb])
    for (let i = 0; i < 30; i++) tick(w, [[bb, 0, input({ firePrimary: true, fireSecondary: true })]])
    expect(w.cs.projectiles.length + w.cs.missiles.length).toBe(0)
    expect(w.events.filter(e => e.type === "fire")).toHaveLength(0)
  })
})

describe("scanner missile (aim47)", () => {
  function setup() {
    const bb = vehicle("blackbird", 0, [0, ALT, 0], [0, 0, -200])
    const target = vehicle("fighter", 1, [-600, ALT + 200, -3000], [150, 0, 0], [1, 0, 0])
    const w = world([bb, target])
    const track = (extra: Partial<SeatInput> = {}) => input({ aim: sub(target.flight.position, bb.flight.position), ...extra })
    const ticks = Math.round(WEAPONS.aim47.lockTime! / TICK_DT)
    for (let i = 0; i < ticks; i++) tick(w, [[bb, 1, track()]])
    expect(bb.weapons[1][0].lock).toBe(1)
    tick(w, [[bb, 1, track({ firePrimary: true })]])
    expect(w.cs.missiles).toHaveLength(1)
    const m = w.cs.missiles[0]
    expect(m).toMatchObject({ weapon: "aim47", target: target.id, steered: true, seat: 1 })
    return { bb, target, w, m, track }
  }

  test("keeps tracking while the scanner is on target and hits a target 3 km out", () => {
    const { bb, target, w, m, track } = setup()
    let guided = true
    for (let i = 0; i < 22 * 60 && w.cs.missiles.length; i++) {
      tick(w, [[bb, 1, track()]])
      if (w.cs.missiles.length && m.target !== target.id) guided = false
    }
    expect(guided).toBe(true)
    expect(hits(w, target)).toHaveLength(1)
    expect(target.alive).toBe(false)
  })

  test("loses guidance after the scanner drifts off, flies straight, and re-acquires", () => {
    const { bb, target, w, m, track } = setup()
    const away = input({ aim: [1, 0, 0] })
    const grace = Math.floor(1.5 / TICK_DT) - 2
    for (let i = 0; i < grace; i++) tick(w, [[bb, 1, away]])
    expect(m.target).toBe(target.id) // still within the grace period
    for (let i = 0; i < 6; i++) tick(w, [[bb, 1, away]])
    expect(m.target).toBeNull()
    const v0 = [...m.velocity]
    for (let i = 0; i < 20; i++) tick(w, [[bb, 1, away]])
    const cos = (m.velocity[0] * v0[0] + m.velocity[1] * v0[1] + m.velocity[2] * v0[2]) / (Math.hypot(...m.velocity) * Math.hypot(...v0))
    expect(cos).toBeGreaterThan(0.99999)
    tick(w, [[bb, 1, track()]])
    expect(m.target).toBe(target.id)
  })

  test("flares are ignored while painted at range, but work when the scanner is off", () => {
    const a = setup()
    for (let i = 0; i < 30; i++) tick(a.w, [[a.bb, 1, a.track()]])
    tick(a.w, [[a.bb, 1, a.track()], [a.target, 0, input({ flares: true })]])
    expect(a.m.target).toBe(a.target.id)

    let decoyed = 0
    for (let n = 0; n < 10; n++) {
      const b = setup()
      b.w.cs.nextId += n * 5
      for (let i = 0; i < 30; i++) tick(b.w, [[b.bb, 1, input({ aim: [1, 0, 0] })]])
      tick(b.w, [[b.bb, 1, input({ aim: [1, 0, 0] })], [b.target, 0, input({ flares: true })]])
      if (b.m.target?.startsWith(FLARE_TARGET_PREFIX)) decoyed++
    }
    expect(decoyed).toBeGreaterThanOrEqual(6)
  })
})

describe("ammo regeneration", () => {
  test("empty magazine refills in `refill` s after `refillDelay`", () => {
    const f = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
    const w = world([f])
    const rt = f.weapons[0][0]
    rt.ammo = 1
    tick(w, [[f, 0, input({ firePrimary: true })]])
    expect(rt.ammo).toBe(0)
    const spec = WEAPONS.cannon20
    const t0 = w.now
    while (w.now - t0 < spec.refillDelay - TICK_DT / 2) tick(w)
    expect(rt.ammo).toBe(0)
    while (w.now - t0 < spec.refillDelay + spec.refill - 0.5) tick(w)
    expect(rt.ammo).toBeGreaterThan(0)
    expect(rt.ammo).toBeLessThan(spec.ammo)
    while (w.now - t0 < spec.refillDelay + spec.refill + TICK_DT * 1.5) tick(w)
    expect(rt.ammo).toBe(spec.ammo)
    expect(Number.isInteger(rt.ammo)).toBe(true)
  })

  test("firing resets the regen delay", () => {
    const f = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
    const w = world([f])
    const rt = f.weapons[0][0]
    rt.ammo = 10
    tick(w, [[f, 0, input({ firePrimary: true })]])
    for (let i = 0; i < 90; i++) tick(w)
    tick(w, [[f, 0, input({ firePrimary: true })]])
    expect(rt.ammo).toBe(8)
    for (let i = 0; i < 90; i++) tick(w) // 1.5 s < refillDelay since the last shot
    expect(rt.ammo).toBe(8)
    for (let i = 0; i < 60; i++) tick(w)
    expect(rt.ammo).toBeGreaterThan(8)
  })

  test("missiles regenerate too; unlimited weapons stay -1", () => {
    const bb = vehicle("blackbird", 0, [0, ALT, 0], [0, 0, -200])
    expect(bb.weapons[1][1].ammo).toBe(-1)
    const w = world([bb])
    bb.weapons[1][0].ammo = 0
    for (let i = 0; i < (WEAPONS.aim47.refillDelay + WEAPONS.aim47.refill) * 60 + 2; i++) tick(w)
    expect(bb.weapons[1][0].ammo).toBe(WEAPONS.aim47.ammo)
    expect(bb.weapons[1][1].ammo).toBe(-1)
  })
})

describe("radar pulse", () => {
  test("spots enemies in radius and applies the damage bonus", () => {
    const bb = vehicle("blackbird", 0, [0, ALT, 0], [0, 0, -200])
    const near = vehicle("fighter", 1, [3000, ALT, 0], [0, 0, 0])
    const far = vehicle("fighter", 2, [6000, ALT, 0], [0, 0, 0])
    const friend = vehicle("fighter", 0, [500, ALT, 0], [0, 0, 0])
    const w = world([bb, near, far, friend])
    tick(w, [[bb, 1, input({ ability: true })]])
    const pulse = w.events.find(e => e.type === "pulse")
    expect(pulse).toBeDefined()
    expect(near.spottedUntil).toBeCloseTo(w.now + WEAPONS.radarpulse.ttl)
    expect(far.spottedUntil).toBe(0)
    expect(friend.spottedUntil).toBe(0)
    // Cooldown (shared by RMB and the ability key).
    tick(w, [[bb, 1, input({ ability: true, fireSecondary: true })]])
    expect(w.events.filter(e => e.type === "pulse")).toHaveLength(1)

    expect(damageFor("cannon20", near, w.now)).toBeCloseTo(damageFor("cannon20", far, w.now) * 1.2)
    // Actual hit applies the bonus.
    const gunner = vehicle("fighter", 2, [3000, ALT, 500], [0, 0, 0])
    w.vehicles.push(gunner)
    for (let i = 0; i < 2; i++) tick(w, [[gunner, 0, input({ firePrimary: true })]])
    for (let i = 0; i < 60; i++) tick(w)
    const h = hits(w, near)[0]
    expect(h && h.type === "hit" && h.damage).toBeCloseTo(WEAPONS.cannon20.damage * WEAPON_DAMAGE_MULT.cannon20 * 1.2)
  })
})

test("radar pulse also fires from the RSO secondary slot, once per press", () => {
  const bb = vehicle("blackbird", 0, [0, ALT, 0], [0, 0, -200])
  const w = world([bb])
  tick(w, [[bb, 1, input({ fireSecondary: true, ability: true })]])
  expect(w.events.filter(e => e.type === "pulse")).toHaveLength(1)
})

describe("kills", () => {
  test("kill event emitted exactly once, credited to the last damager", () => {
    const shooter = vehicle("warthog", 0, [0, ALT, 0], [0, 0, -100])
    const target = vehicle("apache", 1, [0, ALT, -500], [0, 0, 0])
    target.hp = 30
    const w = world([shooter, target])
    for (let i = 0; i < 60; i++) tick(w, [[shooter, 0, input({ firePrimary: true })]])
    for (let i = 0; i < 60; i++) tick(w)
    const kills = w.events.filter(e => e.type === "kill")
    expect(kills).toHaveLength(1)
    const k = kills[0]
    expect(k.type === "kill" && k.killer).toBe(shooter.seats[0])
    expect(k.type === "kill" && k.weapon).toBe("gau8")
    expect(target.alive).toBe(false)
    expect(w.events.filter(e => e.type === "hit" && e.target === target.id).length).toBeLessThan(10)
    expect(killVehicle(target, "crash", null, w.events)).toBe(false)
  })

  test("killVehicle for crashes credits lastDamagedBy by default", () => {
    const v = vehicle("fighter", 1, [0, ALT, 0], [0, 0, 0])
    v.lastDamagedBy = "enemy"
    const events: GameEvent[] = []
    expect(killVehicle(v, "crash", undefined, events)).toBe(true)
    expect(events[0]).toMatchObject({ type: "kill", killer: "enemy", weapon: "crash", victim: v.id })
    expect(events[1].type).toBe("explosion")
  })
})

describe("determinism & balance", () => {
  function scenario() {
    vid = 100
    const a = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
    const b = vehicle("apache", 1, [100, ALT - 50, -900], [20, 0, 30], [0, 0, 1])
    const c = vehicle("blackbird", 2, [-300, ALT + 200, -2000], [200, 0, 0], [1, 0, 0])
    const w = world([a, b, c])
    for (let i = 0; i < 600; i++) {
      tick(w, [
        [a, 0, input({ aim: sub(b.flight.position, a.flight.position), firePrimary: i % 90 < 40, fireSecondary: i > 100 })],
        [b, 1, input({ aim: sub(a.flight.position, b.flight.position), firePrimary: true, fireSecondary: i === 200 })],
        [b, 0, input({ flares: i === 250, firePrimary: i % 120 < 10 })],
        [c, 1, input({ ability: i === 10, aim: sub(a.flight.position, c.flight.position), firePrimary: i > 300 })],
        [c, 0, input({ flares: i === 400 })],
      ])
    }
    return JSON.stringify({ cs: w.cs, vehicles: w.vehicles, events: w.events })
  }

  test("identical inputs produce identical state", () => {
    const x = scenario(), y = scenario()
    expect(x).toBe(y)
    expect(x.length).toBeGreaterThan(1000)
  })

  test("TTK targets", () => {
    const v = (k: VehicleKind) => vehicle(k, 1, [0, 0, 0], [0, 0, 0])
    const ttk = (w: "cannon20" | "gau8" | "chaingun30", k: VehicleKind) => VEHICLES[k].maxHp / (damageFor(w, v(k), 0) * WEAPONS[w].rate)
    expect(ttk("cannon20", "fighter")).toBeGreaterThan(2)
    expect(ttk("cannon20", "fighter")).toBeLessThan(3)
    expect(ttk("gau8", "fighter")).toBeLessThan(ttk("cannon20", "fighter"))
    expect(ttk("chaingun30", "apache")).toBeLessThan(2.5)
    // Missile direct hits destroy anything (incl. the armored A-10); splash is moderate.
    for (const w of ["aim9", "tvmissile", "hellfire", "maverick", "aim47"] as const) {
      for (const k of ["fighter", "apache", "warthog", "blackbird"] as VehicleKind[]) {
        const t = v(k)
        t.spottedUntil = 0
        expect(missileDirectDamage(w, t, 0)).toBeGreaterThan(t.maxHp)
        expect(damageFor(w, t, 0) / t.maxHp).toBeLessThan(0.45) // max splash (at the hull)
      }
    }
    const table: Record<string, Record<string, string>> = {}
    for (const w of ["cannon20", "gau8", "chaingun30"] as const) {
      table[w] = {}
      for (const k of ["fighter", "apache", "warthog", "blackbird"] as VehicleKind[]) table[w][k] = ttk(w, k).toFixed(2) + "s"
    }
    for (const w of ["aim9", "tvmissile", "hellfire", "maverick", "aim47", "rockets"] as const) {
      table[w] = {}
      for (const k of ["fighter", "apache", "warthog", "blackbird"] as VehicleKind[]) table[w][k] = w === "rockets" ? Math.round(100 * damageFor(w, v(k), 0) / VEHICLES[k].maxHp) + "%" : `kill / ${Math.round(100 * damageFor(w, v(k), 0) / VEHICLES[k].maxHp)}% splash`
    }
    console.table(table)
  })
})

describe("recon look-to-spot", () => {
  const TICKS = Math.round(SPOT_TIME / TICK_DT)
  function setup(targetPos: Vec3 = [0, ALT, -3000]) {
    const bb = vehicle("blackbird", 0, [0, ALT, 0], [0, 0, 0])
    const target = vehicle("fighter", 1, targetPos, [0, 0, 0])
    const w = world([bb, target])
    const look = (aim: Vec3 | null) => tick(w, [[bb, 0, input({ aim: aim ?? undefined })]])
    const at = () => sub(target.flight.position, bb.flight.position)
    return { bb, target, w, look, at }
  }
  const spotted = (w: World) => w.events.filter(e => e.type === "spotted")

  test("builds over SPOT_TIME on target, then spots with event and duration", () => {
    const { bb, target, w, look, at } = setup()
    for (let i = 0; i < TICKS - 1; i++) look(at())
    expect(bb.spotCandidate).toBe(target.id)
    expect(bb.spotProgress!).toBeGreaterThan(0.95)
    expect(spotted(w)).toHaveLength(0)
    look(at())
    expect(spotted(w)).toHaveLength(1)
    expect(spotted(w)[0]).toMatchObject({ by: bb.id, team: 0, target: target.id })
    expect(target.spottedUntil).toBeCloseTo(w.now + SPOT_DURATION)
    expect(bb.spotProgress).toBe(0)
    expect(damageFor("cannon20", target, w.now)).toBeCloseTo(WEAPONS.cannon20.damage * WEAPON_DAMAGE_MULT.cannon20 * 1.2)
  })

  test("decays quickly off target and resets on target switch", () => {
    const { bb, target, w, look, at } = setup()
    for (let i = 0; i < 60; i++) look(at())
    const p = bb.spotProgress!
    for (let i = 0; i < 6; i++) look([1, 0, 0])
    expect(bb.spotProgress!).toBeLessThan(p - 0.2)
    for (let i = 0; i < 30; i++) look([1, 0, 0])
    expect(bb.spotProgress).toBe(0)
    expect(bb.spotCandidate).toBeNull()
    // Switching to another enemy restarts from zero.
    const other = vehicle("apache", 2, [3000, ALT, 0], [0, 0, 0])
    w.vehicles.push(other)
    for (let i = 0; i < 60; i++) look(at())
    look([1, 0, 0])
    expect(bb.spotCandidate).toBe(other.id)
    expect(bb.spotProgress!).toBeLessThan(0.05)
    expect(target.spottedUntil).toBe(0)
  })

  test("only recon pilots spot; other kinds and seats don't", () => {
    const f = vehicle("fighter", 0, [0, ALT, 0], [0, 0, 0])
    const target = vehicle("fighter", 1, [0, ALT, -3000], [0, 0, 0])
    const w = world([f, target])
    for (let i = 0; i < TICKS * 2; i++) tick(w, [[f, 0, input({ aim: [0, 0, -1] })]])
    expect(target.spottedUntil).toBe(0)
    expect(RECON_KINDS.has("blackbird")).toBe(true)
  })

  test("blocked by terrain line of sight", () => {
    // Find a peak and put spotter and target low on opposite sides of it.
    let peak: Vec3 = [0, -1e9, 0]
    for (let x = -WORLD_HALF + 500; x < WORLD_HALF - 500; x += 100) {
      for (let z = -WORLD_HALF + 500; z < WORLD_HALF - 500; z += 100) {
        const h = terrainHeight(x, z)
        if (h > peak[1]) peak = [x, h, z]
      }
    }
    expect(peak[1]).toBeGreaterThan(100)
    const y = Math.max(peak[1] * 0.5, 30)
    const a: Vec3 = [peak[0] - 1500, y, peak[2]], b: Vec3 = [peak[0] + 1500, y, peak[2]]
    if (groundHeight(a[0], a[2]) > y || groundHeight(b[0], b[2]) > y) { a[1] = b[1] = peak[1] - 10 }
    expect(segmentHitsGround(a, b)).not.toBeNull()
    const { bb, target, w, look, at } = setup(b)
    bb.flight.position = [...a]
    for (let i = 0; i < TICKS * 2; i++) look(at())
    expect(spotted(w)).toHaveLength(0)
    expect(target.spottedUntil).toBe(0)
  })

  test("per-target cooldown before re-spotting", () => {
    const { target, w, look, at } = setup()
    for (let i = 0; i < TICKS; i++) look(at())
    expect(spotted(w)).toHaveLength(1)
    const t0 = w.now
    while (w.now - t0 < SPOT_COOLDOWN - 0.1) look(at())
    expect(spotted(w)).toHaveLength(1)
    for (let i = 0; i < TICKS + 12; i++) look(at())
    expect(spotted(w)).toHaveLength(2)
    expect(target.spottedUntil).toBe((spotted(w)[1] as { until: number }).until)
  })

  test("radar pulse emits spotted events for each painted enemy", () => {
    const bb = vehicle("blackbird", 0, [0, ALT, 0], [0, 0, 0])
    const e1 = vehicle("fighter", 1, [1000, ALT, 0], [0, 0, 0])
    const e2 = vehicle("apache", 2, [0, ALT, 2000], [0, 0, 0])
    const friend = vehicle("fighter", 0, [500, ALT, 0], [0, 0, 0])
    const w = world([bb, e1, e2, friend])
    tick(w, [[bb, 1, input({ ability: true })]])
    const ev = spotted(w)
    expect(ev.map(e => e.type === "spotted" && e.target).sort()).toEqual([e1.id, e2.id].sort())
    expect(ev[0]).toMatchObject({ by: bb.id, team: 0, until: w.now + WEAPONS.radarpulse.ttl })
  })
})

describe("gun ballistics, lag compensation & impacts", () => {
  /** Fire a 1 s cannon burst at a 200 m/s crossing target, aiming with the shooter's (possibly lagged) view. */
  function crossingBurst(viewLag: number, reportedDelay: number) {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
    const target = vehicle("fighter", 1, [-300, ALT, -650], [200, 0, 0], [1, 0, 0])
    const w = world([shooter, target])
    for (let i = 0; i < 30; i++) tick(w) // build position history
    const view: Vec3 = [0, 0, 0], lp: Vec3 = [0, 0, 0], muz: Vec3 = [0, 0, 0]
    for (let i = 0; i < 60; i++) {
      // The client renders the target `viewLag` s in the past and aims the HUD pipper at that picture.
      rewoundPosition(target, viewLag, view)
      muzzlePosition(shooter, 0, "cannon20", muz)
      leadPoint(muz, shooter.flight.velocity, WEAPONS.cannon20.speed, view, target.flight.velocity, lp)
      shooter.flight.orientation = look(sub(lp, muz))
      tick(w, [[shooter, 0, input({ firePrimary: true, viewDelay: reportedDelay } as Partial<SeatInput>)]])
    }
    for (let i = 0; i < 60; i++) tick(w)
    return { shots: 600 - shooter.weapons[0][0].ammo, hits: hits(w, target).length }
  }

  test("lag compensation: a lagged view still hits when the delay is reported, misses without it", () => {
    const comp = crossingBurst(0.15, 0.15)
    const none = crossingBurst(0.15, 0)
    expect(comp.hits).toBeGreaterThanOrEqual(comp.shots - 1)
    expect(none.hits).toBeLessThan(comp.shots * 0.3)
  })

  test("view delay defaults and clamps", () => {
    expect(viewDelayOf({ aim: null, firePrimary: true, fireSecondary: false, flares: false, ability: false })).toBe(VIEW_DELAY_DEFAULT)
    expect(viewDelayOf(input({ viewDelay: 5 } as Partial<SeatInput>))).toBeLessThanOrEqual(0.3)
    expect(viewDelayOf(input({ viewDelay: -1 } as Partial<SeatInput>))).toBe(0)
  })

  test("gunLeadPoint matches the server ballistics (perfect aim at a crossing target hits)", () => {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
    const target = vehicle("fighter", 1, [-250, ALT + 40, -600], [180, 0, 20], [1, 0, 0])
    const w = world([shooter, target])
    const lp: Vec3 = [0, 0, 0], muz: Vec3 = [0, 0, 0]
    for (let i = 0; i < 45; i++) {
      expect(gunLeadPoint(shooter, 0, target, lp)).toBeGreaterThan(0)
      muzzlePosition(shooter, 0, "cannon20", muz)
      shooter.flight.orientation = look(sub(lp, muz))
      tick(w, [[shooter, 0, input({ firePrimary: true })]])
    }
    for (let i = 0; i < 60; i++) tick(w)
    expect(hits(w, target).length).toBeGreaterThanOrEqual(600 - shooter.weapons[0][0].ammo - 1)
    expect(gunLeadPoint(vehicle("blackbird", 0, [0, 0, 0], [0, 0, 0]), 0, target, lp)).toBe(-1) // no gun
  })

  test("bullet hitbox: wings and fuselage capsules, not a big sphere", () => {
    const R = VEHICLES.fighter.radius
    // Along body Z (nose→tail line) 7 m to the side, crossing the wing span: hit.
    expect(hitboxSweep([7, 0, -50], [7, 0, 50], R)).toBeGreaterThanOrEqual(0)
    // 7 m above the fuselage: clear miss (the old 8 m sphere would have counted it).
    expect(hitboxSweep([0, 7, -50], [0, 7, 50], R)).toBe(-1)
    // Through the fuselage from behind: hit, with an entry before the closest approach.
    const t = hitboxSweep([0, 1, 60], [0, 1, -60], R)
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(0.5)
  })

  test("guns: full damage to 800 m, falling off beyond", () => {
    const spec = WEAPONS.cannon20
    expect(gunRangeFactor("cannon20", (GUN_FULL_RANGE - 10) / spec.speed)).toBe(1)
    expect(gunRangeFactor("cannon20", spec.ttl)).toBeCloseTo(0.4)
    expect(spec.speed).toBeGreaterThanOrEqual(1100)
  })

  /** A sea point and a land point (high terrain). */
  function surfaces() {
    let sea: Vec3 | null = null, land: Vec3 | null = null
    for (let x = -WORLD_HALF + 200; x < WORLD_HALF - 200 && !(sea && land); x += 150) {
      for (let z = -WORLD_HALF + 200; z < WORLD_HALF - 200 && !(sea && land); z += 150) {
        const h = terrainHeight(x, z)
        if (!sea && h < -10 && groundHeight(x, z) === 0) sea = [x, 0, z]
        if (!land && h > 60) land = [x, groundHeight(x, z), z]
      }
    }
    return { sea: sea!, land: land! }
  }

  test("rockets and bullets that hit the water splash (no fireball, no bullet damage); land impacts are ground", () => {
    const { sea, land } = surfaces()
    expect(sea).toBeDefined()
    expect(land).toBeDefined()
    const explosionsAt = (at: Vec3, weapon: "rockets" | "cannon20") => {
      const shooter = vehicle(weapon === "rockets" ? "apache" : "fighter", 0, [at[0], at[1] + 120, at[2] + 60], [0, 0, 0], [0, -0.9, -0.45])
      const bystander = vehicle("fighter", 1, [at[0] + 22, at[1] + 3, at[2]], [0, 0, 0])
      const w = world([shooter, bystander])
      for (let i = 0; i < 20; i++) tick(w, [[shooter, 0, input({ firePrimary: true })]])
      for (let i = 0; i < 120; i++) tick(w)
      return { ex: w.events.filter(e => e.type === "explosion") as Extract<GameEvent, { type: "explosion" }>[], bystander }
    }
    const rw = explosionsAt(sea, "rockets")
    expect(rw.ex.length).toBeGreaterThan(0)
    expect(rw.ex.every(e => e.surface === "water" && e.size < WEAPONS.rockets.splash)).toBe(true)
    expect(rw.bystander.hp).toBe(rw.bystander.maxHp) // 22 m away (14 m from its hull): outside the small water splash
    const bw = explosionsAt(sea, "cannon20")
    expect(bw.ex.length).toBeGreaterThan(0)
    expect(bw.ex.every(e => e.surface === "water")).toBe(true)
    expect(bw.bystander.hp).toBe(bw.bystander.maxHp)
    const rl = explosionsAt(land, "rockets")
    expect(rl.ex.some(e => e.surface === "ground" && e.size === WEAPONS.rockets.splash)).toBe(true)
  })

  test("missiles: air bursts are surface 'air', water impacts small 'water' splashes", () => {
    const { sea } = surfaces()
    const shooter = vehicle("fighter", 0, [sea[0], 3000, sea[2]], [0, 0, -150])
    const w = world([shooter])
    tick(w, [[shooter, 0, input({ fireSecondary: true })]]) // dumbfire, expires in the air
    for (let i = 0; i < 8 * 60 && w.cs.missiles.length; i++) tick(w)
    const air = w.events.filter(e => e.type === "explosion") as Extract<GameEvent, { type: "explosion" }>[]
    expect(air.length).toBe(1)
    expect(air[0].surface).toBe("air")
    const low = vehicle("fighter", 0, [sea[0], 60, sea[2]], [0, -60, -100], [0, -0.6, -0.8])
    const w2 = world([low])
    tick(w2, [[low, 0, input({ fireSecondary: true })]])
    for (let i = 0; i < 8 * 60 && w2.cs.missiles.length; i++) tick(w2)
    const wet = w2.events.filter(e => e.type === "explosion") as Extract<GameEvent, { type: "explosion" }>[]
    expect(wet.length).toBe(1)
    expect(wet[0].surface).toBe("water")
  })
})

describe("gimbaled pilot guns", () => {
  test("pilot guns fire toward the seat aim, clamped to GUN_GIMBAL around the nose", () => {
    const f = vehicle("fighter", 0, [0, ALT, 0], [0, 0, 0])
    const d: Vec3 = [0, 0, 0]
    const off = 0.15 // ~8.6°, inside the gimbal
    weaponDirection(f, "cannon20", [Math.sin(off), 0, -Math.cos(off)], d)
    expect(Math.acos(-d[2])).toBeCloseTo(off, 6)
    weaponDirection(f, "cannon20", [1, 0, 0], d) // 90° off: clamped
    expect(Math.acos(-d[2])).toBeCloseTo(GUN_GIMBAL, 6)
    expect(d[0]).toBeGreaterThan(0)
    weaponDirection(f, "gau8", null, d)
    expect(d).toEqual([0, 0, -1])
    weaponDirection(f, "aim9", [1, 0, 0], d) // missiles stay on the nose
    expect(d[2]).toBeCloseTo(-1, 9)
    expect(gunCanReach(f, 0, [100, ALT, -1000])).toBe(true)
    expect(gunCanReach(f, 0, [1000, ALT, -1000])).toBe(false)
  })

  test("reasonable aim (gunLeadPoint ± 0.5°) vs a weaving target at 300–600 m lands ≥ 25% of rounds; hit events credit the shooter", () => {
    let seed = 7
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1
    let shots = 0, landed = 0
    for (const range of [300, 450, 600]) {
      const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -170])
      const target = vehicle("fighter", 1, [60, ALT + 20, -range], [0, 0, -170])
      const w = world([shooter, target])
      const lp: Vec3 = [0, 0, 0]
      for (let i = 0; i < 180; i++) {
        // Target weaves: heading oscillates ±0.4 rad (≈6 g at 170 m/s); shooter's nose loosely follows the target.
        const hdg = 0.4 * Math.sin(w.now * 0.8)
        target.flight.velocity = [Math.sin(hdg) * 170, 0, -Math.cos(hdg) * 170]
        target.flight.orientation = look(target.flight.velocity)
        shooter.flight.orientation = look(sub(target.flight.position, shooter.flight.position))
        gunLeadPoint(shooter, 0, target, lp)
        const aim = sub(lp, shooter.flight.position)
        const n = Math.hypot(...aim)
        const yaw = (rnd() * 0.5 * Math.PI) / 180, pitch = (rnd() * 0.5 * Math.PI) / 180
        const a: Vec3 = [aim[0] / n + yaw, aim[1] / n + pitch, aim[2] / n]
        tick(w, [[shooter, 0, input({ aim: a, firePrimary: true })]])
      }
      for (let i = 0; i < 60; i++) tick(w)
      shots += 600 - shooter.weapons[0][0].ammo
      const h = hits(w, target)
      landed += h.length
      expect(h.every(e => e.type === "hit" && e.by === shooter.seats[0] && e.weapon === "cannon20")).toBe(true)
      if (!target.alive) expect(w.events.some(e => e.type === "kill" && e.killer === shooter.seats[0])).toBe(true)
    }
    const rate = landed / shots
    console.log(`gimbaled gun hit rate vs weaving target (300–600 m, ±0.5° aim noise): ${(rate * 100).toFixed(0)}% (${landed}/${shots})`)
    expect(rate).toBeGreaterThanOrEqual(0.25)
  })
})

describe("Fleet Strike: ships", () => {
  afterEach(() => setFleetState(0, 4))
  const shoot = (w: World, weapon: "rockets" | "cannon20", team: TeamId, from: Vec3, to: Vec3) => {
    const d = sub(to, from), l = Math.hypot(...d), sp = WEAPONS[weapon].speed
    w.cs.projectiles.push({ id: w.cs.nextId++, weapon, owner: "shooter", vehicle: "vX", team, position: [...from], velocity: [d[0] / l * sp, d[1] / l * sp, d[2] / l * sp], age: 0, ttl: 3 })
  }
  const amidships = (id: string, y = 5): Vec3 => { const s = posedShip(id)!; return [s.position[0], y, s.position[2]] }
  const beside = (id: string, d: number, y = 5): Vec3 => { const s = posedShip(id)!; return [s.position[0] + Math.cos(s.heading) * d, y, s.position[2] - Math.sin(s.heading) * d] }

  test("rockets into an enemy hull damage it (×SHIP_DAMAGE_SCALE); guns barely scratch; friendly fire off", () => {
    const w = world([])
    const rt = shipRuntime(w.cs, "t1-dd1")!
    shoot(w, "rockets", 0, beside("t1-dd1", 150), amidships("t1-dd1"))
    for (let i = 0; i < 30; i++) tick(w)
    expect(rt.maxHp - rt.hp).toBeCloseTo(WEAPONS.rockets.damage * SHIP_DAMAGE_SCALE.rockets, 3)
    expect(w.events.some(e => e.type === "ship-hit" && e.ship === "t1-dd1" && e.by === "shooter")).toBe(true)
    expect(rt.damage.length).toBe(1)
    expect(w.cs.shipDamageBy![0]).toBeCloseTo(WEAPONS.rockets.damage * SHIP_DAMAGE_SCALE.rockets, 3)
    const before = rt.hp
    shoot(w, "cannon20", 0, beside("t1-dd1", 150), amidships("t1-dd1"))
    for (let i = 0; i < 30; i++) tick(w)
    expect(before - rt.hp).toBeLessThan(WEAPONS.cannon20.damage * 0.2)
    expect(before - rt.hp).toBeGreaterThan(0)
    const own = shipRuntime(w.cs, "t0-dd1")!
    shoot(w, "rockets", 0, beside("t0-dd1", 150), amidships("t0-dd1"))
    for (let i = 0; i < 30; i++) tick(w)
    expect(own.hp).toBe(own.maxHp)
    expect(w.events.filter(e => e.type === "crater")).toHaveLength(0) // hull/deck hits are not craters
  })

  test("hits near a turret knock it out; a knocked-out turret stops firing", () => {
    const w = world([])
    const ship = posedShip("t1-dd1")!
    const mount = SHIP_SPECS.destroyer.turrets.find(t => t.id === "ciws_fwd")!
    damageShip(w.cs, "t1-dd1", TURRET_HP + 1, "p9", 0, shipToWorld(ship, mount.offset), 0, w.events)
    expect(shipRuntime(w.cs, "t1-dd1")!.turrets.ciws_fwd.hp).toBe(0)
    expect(w.events).toContainEqual({ type: "turret-destroyed", ship: "t1-dd1", turret: "ciws_fwd", by: "p9" })
    const f = vehicle("apache", 0, shipToWorld(ship, [0, 300, -24]), [0, 0, 0])
    f.hp = 1e6
    const w2 = { ...world([f]), cs: w.cs }
    for (let i = 0; i < 240; i++) tick(w2)
    const fired = (id: string) => w2.events.some(e => (e as unknown as { type: string; ship: string; turret: string }).type === "aa" && (e as unknown as { ship: string }).ship === "t1-dd1" && (e as unknown as { turret: string }).turret === id)
    expect(fired("ciws_fwd")).toBe(false)
    expect(fired("ciws_aft")).toBe(true)
  })

  test("a sunk ship stops firing and stops colliding after ~20 s", () => {
    const w = world([])
    const ship = posedShip("t1-dd2")!
    damageShip(w.cs, "t1-dd2", 1e9, "p1", 0, ship.position, 0, w.events)
    const rt = shipRuntime(w.cs, "t1-dd2")!
    expect(rt.sunk).toBe(true)
    expect(rt.hp).toBe(0)
    expect(w.events.some(e => e.type === "ship-sunk" && e.ship === "t1-dd2" && e.team === 1)).toBe(true)
    const f = vehicle("apache", 0, shipToWorld(ship, [0, 250, 0]), [0, 0, 0])
    f.hp = 1e6
    const w2 = { ...world([f]), cs: w.cs }
    for (let i = 0; i < 240; i++) tick(w2)
    expect(w2.events.some(e => (e as unknown as { ship?: string; type: string }).type === "aa" && (e as unknown as { ship: string }).ship === "t1-dd2")).toBe(false)
    const a = beside("t1-dd2", 100), b = amidships("t1-dd2")
    expect(segmentHitsShipEx(w.cs, a, b, 1, null)?.ship.id).toBe("t1-dd2")
    expect(segmentHitsShipEx(w.cs, a, b, SHIP_SINK_COLLISION_TIME + 1, null)).toBeNull()
  })

  test("lock-on missiles lock enemy ships and home onto them", () => {
    const c = posedShip("t1-carrier")!
    const start = beside("t1-carrier", 900, 250)
    const dir = sub(amidships("t1-carrier", 12), start)
    const f = vehicle("fighter", 0, start, [0, 0, 0], dir)
    f.hp = 1e6
    const w = world([f])
    while (w.now < 3) tick(w, [[f, 0, input({ aim: dir })]])
    expect(f.weapons[0][1].lockTarget).toBe(SHIP_TARGET_PREFIX + "t1-carrier")
    expect(f.weapons[0][1].lock).toBe(1)
    tick(w, [[f, 0, input({ aim: dir, fireSecondary: true })]])
    expect(w.cs.missiles[0]?.target).toBe(SHIP_TARGET_PREFIX + "t1-carrier")
    const rt = shipRuntime(w.cs, "t1-carrier")!
    while (w.cs.missiles.length && w.now < 12) tick(w)
    expect(rt.maxHp - rt.hp).toBeCloseTo(WEAPONS.aim9.damage * SHIP_DAMAGE_SCALE.missile_lock, 3)
    expect(c).toBeDefined()
  })

  test("craters only on island ground (not water, not decks)", () => {
    let land: Vec3 | null = null
    for (let x = -WORLD_HALF + 3000; x < WORLD_HALF - 3000 && !land; x += 250) {
      for (let z = -WORLD_HALF + 3000; z < WORLD_HALF - 3000; z += 250) {
        if (terrainHeight(x, z) > 60 && !isWater(x, z) && !shipAt(x, z)) { land = [x, terrainHeight(x, z), z]; break }
      }
    }
    expect(land).not.toBeNull()
    const w = world([])
    shoot(w, "rockets", 0, [land![0] + 30, land![1] + 150, land![2]], land!)
    for (let i = 0; i < 60; i++) tick(w)
    expect(w.events.filter(e => e.type === "crater")).toHaveLength(1)
    expect(w.cs.craters!.length).toBe(1)
    let sea: Vec3 = [0, 0, 0]
    for (let x = -WORLD_HALF + 1000; x < WORLD_HALF; x += 500) if (isWater(x, WORLD_HALF - 800) && !shipAt(x, WORLD_HALF - 800)) { sea = [x, 0, WORLD_HALF - 800]; break }
    shoot(w, "rockets", 0, [sea[0] + 30, 150, sea[2]], sea)
    for (let i = 0; i < 60; i++) tick(w)
    expect(w.cs.craters!.length).toBe(1)
  })

  test("player-manned 5-inch fires flak shells that burst near enemies, credited to the player", () => {
    const ship = posedShip("t1-dd1")!
    const mount = shipToWorld(ship, SHIP_SPECS.destroyer.turrets.find(t => t.id === "gun_fwd")!.offset)
    const target: Vec3 = [mount[0] + 700, mount[1] + 400, mount[2]]
    const f = vehicle("apache", 0, target, [0, 0, 0])
    f.hp = 1e6
    const w = world([f])
    shipRuntime(w.cs, "t1-dd1")!.turrets.gun_fwd.manned = "gunner"
    const aim = sub(target, mount)
    for (let i = 0; i < 120; i++) {
      w.now += TICK_DT
      applyTurretInput(w.cs, "t1-dd1", "gun_fwd", "gunner", input({ aim, firePrimary: true }), w.now, w.events)
      stepCombat(w.cs, w.vehicles, TICK_DT, w.now, w.events)
    }
    const flak = w.events.filter(e => e.type === "hit" && e.target === f.id && e.by === "gunner")
    expect(flak.length).toBeGreaterThan(0)
    expect(w.events.some(e => e.type === "explosion" && e.kind === "flak")).toBe(true)
  })
})
