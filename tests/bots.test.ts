import { describe, expect, test } from "bun:test"
import {
  BOT_NO_FLY_RADIUS, applyAimSafety, botInput, hostileFleetDistance, shipClearanceAlt, chooseBotVehicle, createBotBrain, interceptTime, leadDirection, terrainMinPitch,
} from "../src/sim/bots"
import { createWeapons, markSpawned } from "../src/sim/combat"
import { FLEET, shipPose } from "../src/sim/fleet"
import { setFleetState } from "../src/sim/geography"
import { forward } from "../src/sim/flight"
import { VEHICLES, WEAPONS } from "../src/sim/vehicles"
import type { FlightInput, Missile, PlayerInfo, Quat, SeatInput, TeamId, Vec3, VehicleEntity, VehicleKind, WorldQuery } from "../src/sim/types"

const flat = (h = 0): WorldQuery => ({ groundHeight: () => h, onRunway: () => true, half: 8_000, ceiling: 4_000 })

function quatFromDir(d: Vec3): Quat {
  const yaw = Math.atan2(-d[0], -d[2])
  const pitch = Math.asin(Math.max(-1, Math.min(1, d[1] / Math.hypot(d[0], d[1], d[2]))))
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), sp = Math.sin(pitch / 2), cp = Math.cos(pitch / 2)
  return [cy * sp, sy * cp, -sy * sp, cy * cp] // qYaw(Y) * qPitch(X)
}

let nextId = 0
function vehicle(kind: VehicleKind, team: TeamId, position: Vec3, velocity: Vec3, dir?: Vec3, onGround = false): VehicleEntity {
  const d = dir ?? (Math.hypot(...velocity) > 0 ? velocity : [0, 0, -1])
  return {
    id: `v${nextId++}`, kind, team,
    flight: {
      kind, position: [...position], velocity: [...velocity], orientation: quatFromDir(d), angularVelocity: [0, 0, 0],
      throttle: 0, onGround, gearDown: onGround, crashed: null, tick: 0,
    },
    hp: VEHICLES[kind].maxHp, maxHp: VEHICLES[kind].maxHp, seats: [null, null], aim: [null, null], weapons: createWeapons(kind),
    flaresReadyAt: 0, flareCount: VEHICLES[kind].flares, abilityReadyAt: 0, spottedUntil: 0, lastDamagedBy: null, alive: true,
  }
}

function player(team: TeamId, seat: 0 | 1, id = "bot"): PlayerInfo {
  return { id, name: id, team, vehicleId: null, seat, kills: 0, deaths: 0, bot: true, respawnAt: 0 }
}

/** Snapshot the (reused) output objects. */
function snap(o: { flight?: FlightInput; seat: SeatInput }) {
  return JSON.parse(JSON.stringify(o)) as { flight?: FlightInput; seat: SeatInput }
}

const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2])
const angle = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b)))))
const pitchOf = (v: Vec3) => Math.atan2(v[1], Math.hypot(v[0], v[2]))
const lock = (v: VehicleEntity, seat: 0 | 1, slot: 0 | 1, target: VehicleEntity) => {
  v.weapons[seat][slot].lock = 1
  v.weapons[seat][slot].lockTarget = target.id
}

test("quatFromDir matches flight.forward", () => {
  const d: Vec3 = [0.3, 0.4, -0.866]
  expect(angle(forward(quatFromDir(d)), d)).toBeLessThan(1e-6)
})

describe("math", () => {
  test("intercept time for a stationary target is range / speed", () => {
    expect(interceptTime(0, 0, -1000, 0, 0, 0, 1000)).toBeCloseTo(1, 6)
  })
  test("lead direction hits a crossing target", () => {
    const out: Vec3 = [0, 0, 0]
    const tPos: Vec3 = [0, 0, -1000], tVel: Vec3 = [100, 0, 0]
    const t = leadDirection([0, 0, 0], [0, 0, 0], tPos, tVel, 1000, 0, out)
    expect(Math.hypot(out[0] * 1000 * t - tVel[0] * t, out[1] * 1000 * t, out[2] * 1000 * t - tPos[2])).toBeLessThan(1e-6)
  })
  test("terrainMinPitch demands a climb toward a ridge and allows descent over flat ground", () => {
    const ridge = { groundHeight: (_x: number, z: number) => (z < -800 ? 1_400 : 0) }
    expect(terrainMinPitch([0, 1000, 0], [0, 0, -150], ridge, 150, 7)).toBeGreaterThan(0.2)
    expect(terrainMinPitch([0, 1000, 0], [0, 0, -150], { groundHeight: () => 0 }, 150, 7)).toBeLessThan(-0.3)
  })
  test("applyAimSafety: raises dives near the ground, caps the ceiling, turns back at the edge", () => {
    const dive: Vec3 = [0, -0.5, -0.86]
    applyAimSafety(dive, [0, 100, 0], [0, -20, -150], flat(), 150, 7, null)
    expect(pitchOf(dive)).toBeGreaterThan(0)
    const climb: Vec3 = [0, 0.5, -0.86]
    applyAimSafety(climb, [0, 3_800, 0], [0, 0, -150], flat(), 150, 7, null)
    expect(pitchOf(climb)).toBeLessThan(0)
    const out: Vec3 = [1, 0, 0]
    applyAimSafety(out, [7_800, 2000, 0], [150, 0, 0], flat(), 150, 7, null)
    expect(out[0]).toBeLessThan(0)
  })
})

describe("pilot", () => {
  test("jet on the carrier deck: full power, no brake, then holds the bow heading in a gentle climb", () => {
    const w = flat(20)
    const brain = createBotBrain(1, 1)
    const v = vehicle("fighter", 0, [0, 22, 6_050], [0, 0, 0], [0, 0, -1], true)
    const out = snap(botInput(brain, player(0, 0), v, [v], 0, [], w))
    expect(out.flight!.throttle).toBe(1)
    expect(out.flight!.brake).toBe(false)
    expect(out.flight!.boost).toBe(true)
    expect(angle(out.flight!.aim!, [0, 0, -1])).toBeLessThan(0.01)
    // Off the catapult, low over the water: keep the bow heading and climb gently.
    v.flight.onGround = false
    v.flight.position = [0, 25, 5_700]
    v.flight.velocity = [0, 0, -VEHICLES.fighter.stall * 1.3]
    const out2 = snap(botInput(brain, player(0, 0), v, [v], 3, [], flat(0)))
    expect(pitchOf(out2.flight!.aim!)).toBeGreaterThan(0.03)
    expect(pitchOf(out2.flight!.aim!)).toBeLessThan(0.4)
    expect(Math.abs(out2.flight!.aim![0])).toBeLessThan(0.01)
    expect(out2.flight!.throttle).toBe(1)
  })

  test("helicopter lifts vertically off the deck, then departs", () => {
    const brain = createBotBrain(2, 1)
    const v = vehicle("apache", 0, [-27, 22, 6_120], [0, 0, 0], [0, 0, -1], true)
    const out = snap(botInput(brain, player(0, 0), v, [v], 0, [], flat(20)))
    expect(out.flight!.throttle).toBeGreaterThan(0.5)
    expect(out.flight!.brake).toBe(true)
    expect(Math.abs(pitchOf(out.flight!.aim!))).toBeLessThan(0.01)
    v.flight.onGround = false
    v.flight.position = [-27, 110, 6_120]
    const out2 = snap(botInput(brain, player(0, 0), v, [v], 8, [], flat(0)))
    expect(out2.flight!.brake).toBe(false)
    expect(pitchOf(out2.flight!.aim!)).toBeLessThan(-0.1) // nose down: moving out
  })

  test("aims at the gun lead point and fires when aligned", () => {
    const pos: Vec3 = [0, 2000, 0], vel: Vec3 = [0, 0, -150]
    const enemy = vehicle("fighter", 1, [0, 2000, -800], [100, 0, 0])
    const lead: Vec3 = [0, 0, 0]
    leadDirection(pos, vel, enemy.flight.position, enemy.flight.velocity, WEAPONS.cannon20.speed, 0, lead)
    const me = vehicle("fighter", 0, pos, vel, lead)
    const out = snap(botInput(createBotBrain(3, 1), player(0, 0), me, [me, enemy], 10, [], flat()))
    expect(angle(out.flight!.aim!, lead)).toBeLessThan(0.02)
    expect(out.seat.firePrimary).toBe(true)

    const off = vehicle("fighter", 0, pos, vel, [0.5, 0, -0.86])
    const out2 = snap(botInput(createBotBrain(3, 1), player(0, 0), off, [off, enemy], 10, [], flat()))
    expect(out2.seat.firePrimary).toBe(false)
    expect(angle(out2.flight!.aim!, lead)).toBeLessThan(0.02)
  })

  test("never targets enemies inside their safe zone", () => {
    const enemy = vehicle("fighter", 1, [0, 60, -5_500], [0, 0, 0]) // team 1 base, low = protected
    const me = vehicle("fighter", 0, [0, 300, -4_500], [0, 0, -150], [0, 0, -1])
    const out = botInput(createBotBrain(4, 1), player(0, 0), me, [me, enemy], 10, [], flat())
    expect(out.seat.firePrimary || out.seat.fireSecondary).toBe(false)
  })

  test("heat-seeker: holds until lock completes, then fires", () => {
    const enemy = vehicle("fighter", 1, [0, 2000, -2000], [0, 0, -150])
    const me = vehicle("fighter", 0, [0, 2000, 0], [0, 0, -150], [0.3, 0, -0.95])
    me.weapons[0][1].lockTarget = enemy.id
    me.weapons[0][1].lock = 0.5
    const brain = createBotBrain(5, 1)
    expect(botInput(brain, player(0, 0), me, [me, enemy], 10, [], flat()).seat.fireSecondary).toBe(false)
    lock(me, 0, 1, enemy)
    expect(botInput(brain, player(0, 0), me, [me, enemy], 10.1, [], flat()).seat.fireSecondary).toBe(true)
  })

  test("pulls up when terrain rises ahead", () => {
    const ridge: WorldQuery = { ...flat(), groundHeight: (_x, z) => (z < -600 ? 1_300 : 0) }
    const me = vehicle("fighter", 0, [0, 1000, 0], [0, 0, -150])
    const out = botInput(createBotBrain(6, 1), player(0, 0), me, [me], 100, [], ridge)
    expect(pitchOf(out.flight!.aim!)).toBeGreaterThan(0.25)
  })

  test("breaks and drops flares against an inbound missile after reacting", () => {
    const brain = createBotBrain(7, 1)
    const me = vehicle("fighter", 0, [0, 2000, 0], [0, 0, -150])
    const missile: Missile = {
      id: 9, weapon: "aim9", owner: "e", vehicle: "x", team: 1, position: [0, 2000, 1500], velocity: [0, 0, -500],
      target: me.id, steered: false, age: 1, ttl: 8,
    }
    botInput(brain, player(0, 0), me, [me], 10, [missile], flat())
    const out = snap(botInput(brain, player(0, 0), me, [me], 11, [missile], flat()))
    expect(out.seat.flares).toBe(true)
    expect(out.flight!.boost).toBe(true)
    expect(Math.abs(out.flight!.aim![2])).toBeLessThan(0.2) // beam: perpendicular to the missile
  })

  test("helicopter keeps standoff: closes when far, turns away when too close", () => {
    const enemy = vehicle("apache", 1, [0, 300, -1_000], [0, 0, 0])
    const me = vehicle("apache", 0, [0, 300, 2_000], [0, 0, -40])
    const far = snap(botInput(createBotBrain(11, 1), player(0, 0), me, [me, enemy], 10, [], flat()))
    expect(far.flight!.aim![2]).toBeLessThan(-0.5)
    enemy.flight.position = [0, 300, 1_700]
    const near = snap(botInput(createBotBrain(11, 1), player(0, 0), me, [me, enemy], 10, [], flat()))
    expect(near.flight!.aim![2]).toBeGreaterThan(0)
  })

  test("Blackbird pilot stays out of gun range and looks at its target (recon spotting)", () => {
    const enemy = vehicle("fighter", 1, [0, 2000, -1500], [0, 0, 150])
    const me = vehicle("blackbird", 0, [0, 2000, 0], [0, 0, -200])
    const out = snap(botInput(createBotBrain(12, 1), player(0, 0), me, [me, enemy], 10, [], flat()))
    expect(out.flight!.aim![2]).toBeGreaterThan(0) // extending away
    expect(angle(out.seat.aim!, [0, 0, -1])).toBeLessThan(0.01) // reticle on the target
    expect(out.seat.firePrimary || out.seat.fireSecondary).toBe(false)
    me.flight.position = [0, 2000, 3_000]
    enemy.flight.position = [0, 2000, -4_000]
    const far = snap(botInput(createBotBrain(12, 1), player(0, 0), me, [me, { ...enemy, spottedUntil: 99 }], 10, [], flat()))
    expect(far.flight!.aim![2]).toBeLessThan(-0.9) // closes in
  })
})

describe("carrier fleets", () => {
  const enemyCarrier = FLEET.find(s => s.team === 1 && s.kind === "carrier")!

  test("steering refuses to enter a hostile fleet's AA umbrella, but own fleet is fine", () => {
    const cz = enemyCarrier.position[2]
    const pos: Vec3 = [0, 1500, cz + BOT_NO_FLY_RADIUS + 300]
    const aim: Vec3 = [0, 0, -1] // straight at the enemy carrier
    applyAimSafety(aim, pos, [0, 0, -150], flat(), 150, 7, 0)
    expect(aim[2]).toBeGreaterThan(-0.75)
    const deep: Vec3 = [0, 0, -1]
    applyAimSafety(deep, [0, 1500, cz + 1_500], [0, 0, -150], flat(), 150, 7, 0)
    expect(deep[2]).toBeGreaterThan(0.9) // inside: head straight out
    const own: Vec3 = [0, 0, -1]
    applyAimSafety(own, pos, [0, 0, -150], flat(), 150, 7, 1)
    expect(own[2]).toBeLessThan(-0.99)
  })

  test("ignores (and abandons) targets sheltering near their fleet", () => {
    const brain = createBotBrain(13, 1)
    const me = vehicle("fighter", 0, [0, 1500, 0], [0, 0, -150])
    const enemy = vehicle("fighter", 1, [0, 1500, -1_000], [0, 0, -150])
    lock(me, 0, 1, enemy)
    let out = snap(botInput(brain, player(0, 0), me, [me, enemy], 10, [], flat()))
    expect(out.seat.fireSecondary).toBe(true)
    enemy.flight.position = [0, 1500, enemyCarrier.position[2] + 2_000]
    expect(hostileFleetDistance(0, 0, enemy.flight.position[2])).toBeLessThan(BOT_NO_FLY_RADIUS)
    me.weapons[0][1].readyAt = 0
    out = snap(botInput(brain, player(0, 0), me, [me, enemy], 20, [], flat()))
    expect(out.seat.firePrimary || out.seat.fireSecondary).toBe(false)
    expect(brain.state.phase).toBe("transit")
  })

  test("ignores spawn-protected enemies", () => {
    const me = vehicle("fighter", 0, [0, 1500, 0], [0, 0, -150])
    const enemy = vehicle("fighter", 1, [0, 1500, -800], [0, 0, -150])
    markSpawned(enemy, 9)
    const brain = createBotBrain(14, 1)
    botInput(brain, player(0, 0), me, [me, enemy], 10, [], flat())
    expect(brain.state.targetId).toBeNull()
  })

  test("uses current ship poses and only active fleets", () => {
    try {
      setFleetState(600, 2)
      const moved = shipPose(enemyCarrier, 600).position
      expect(Math.abs(moved[2] - enemyCarrier.position[2])).toBeGreaterThan(1_000)
      expect(hostileFleetDistance(0, moved[0], moved[2])).toBeLessThan(1)
      // Old (start) position is no longer guarded; inactive teams 2/3 have no fleets.
      expect(hostileFleetDistance(0, enemyCarrier.position[0], enemyCarrier.position[2])).toBeGreaterThan(500)
      const west = FLEET.find(s => s.team === 2 && s.kind === "carrier")!
      expect(hostileFleetDistance(0, west.position[0], west.position[2])).toBeGreaterThan(BOT_NO_FLY_RADIUS)
      const aim: Vec3 = [0, 0, -1]
      applyAimSafety(aim, [moved[0], 1500, moved[2] + BOT_NO_FLY_RADIUS + 300], [0, 0, -150], flat(), 150, 7, 0)
      expect(aim[2]).toBeGreaterThan(-0.75)
    } finally {
      setFleetState(0, 4)
    }
  })

  test("climbs over ship hulls in its path", () => {
    const dd = FLEET.find(s => s.kind === "destroyer")!
    const p: Vec3 = [dd.position[0], 20, dd.position[2] + 400]
    expect(shipClearanceAlt(p, 0, -1, 1_000, 40)).toBeGreaterThan(50)
    expect(shipClearanceAlt(p, 0, 1, 1_000, 40)).toBe(-Infinity)
    const aim: Vec3 = [0, 0, -1]
    applyAimSafety(aim, p, [0, 0, -120], flat(), 10, 7, dd.team)
    expect(pitchOf(aim)).toBeGreaterThan(0.05)
  })
})

describe("gunner", () => {
  test("Apache gunner leads and fires the chain gun in range (and in arc)", () => {
    const me = vehicle("apache", 0, [0, 500, 0], [0, 0, 0], [0, 0, -1])
    const enemy = vehicle("apache", 1, [0, 400, -900], [50, 0, 0])
    const out = snap(botInput(createBotBrain(8, 1), player(0, 1), me, [me, enemy], 10, [], flat()))
    const lead: Vec3 = [0, 0, 0]
    leadDirection(me.flight.position, me.flight.velocity, enemy.flight.position, enemy.flight.velocity, WEAPONS.chaingun30.speed, 0, lead)
    expect(angle(out.seat.aim!, lead)).toBeLessThan(0.01)
    expect(out.seat.firePrimary).toBe(true)
    expect(out.flight).toBeUndefined()
    // Target above the turret's elevation limit: track but hold fire.
    enemy.flight.position = [0, 1400, -900]
    const high = snap(botInput(createBotBrain(8, 1), player(0, 1), me, [me, enemy], 10, [], flat()))
    expect(high.seat.firePrimary).toBe(false)
  })

  test("WSO holds the seeker on target and launches only with a full lock", () => {
    const me = vehicle("fighter", 0, [0, 2000, 0], [0, 0, -150])
    const enemy = vehicle("warthog", 1, [0, 1500, -2500], [100, 0, 0])
    const brain = createBotBrain(9, 1)
    const out = snap(botInput(brain, player(0, 1), me, [me, enemy], 10, [], flat()))
    expect(out.seat.firePrimary).toBe(false)
    expect(angle(out.seat.aim!, [0, -500, -2500])).toBeLessThan(0.01)
    lock(me, 1, 0, enemy)
    expect(botInput(brain, player(0, 1), me, [me, enemy], 10.1, [], flat()).seat.firePrimary).toBe(true)
  })

  test("Blackbird RSO pulses, scanner-locks, fires aim47 and keeps painting until impact", () => {
    const me = vehicle("blackbird", 0, [0, 3000, 3_000], [0, 0, -200])
    const enemy = vehicle("fighter", 1, [500, 2800, -2_000], [0, 0, 150])
    const near = vehicle("warthog", 1, [3_000, 3000, 3_000], [0, 0, 0])
    me.seats = ["pilot", "rso"]
    const brain = createBotBrain(10, 1)
    const rso = player(0, 1, "rso")
    let out = snap(botInput(brain, rso, me, [me, enemy, near], 10, [], flat()))
    expect(out.seat.ability).toBe(true) // warthog within 4 km and unspotted
    near.alive = false
    enemy.spottedUntil = 100
    out = snap(botInput(brain, rso, me, [me, enemy], 20, [], flat()))
    expect(out.seat.firePrimary).toBe(false)
    expect(angle(out.seat.aim!, [500, -200, -5000])).toBeLessThan(0.01)
    lock(me, 1, 0, enemy)
    out = snap(botInput(brain, rso, me, [me, enemy], 21, [], flat()))
    expect(out.seat.firePrimary).toBe(true)
    // Missile in flight: scanner stays on the target even when another enemy is closer.
    const other = vehicle("apache", 1, [-800, 2900, 2_000], [0, 0, 0])
    other.spottedUntil = 100
    const m: Missile = {
      id: 3, weapon: "aim47", owner: "rso", vehicle: me.id, team: 0, position: [0, 3000, 2_000], velocity: [0, 0, -600],
      target: enemy.id, scanTarget: enemy.id, steered: true, seat: 1, age: 2, ttl: 22,
    }
    enemy.flight.position = [800, 2800, -2_000]
    for (let t = 22; t < 26; t += 0.5) {
      out = snap(botInput(brain, rso, me, [me, enemy, other], t, [m], flat()))
      expect(angle(out.seat.aim!, [800, -200, -5000])).toBeLessThan(WEAPONS.aim47.lockCone!)
      expect(out.seat.firePrimary).toBe(false)
    }
  })
})

test("outputs are finite, in range and aims are unit across random scenarios", () => {
  const kinds: VehicleKind[] = ["fighter", "apache", "warthog", "blackbird"]
  let s = 12345
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
  const world: WorldQuery = { ...flat(), groundHeight: (x, z) => Math.max(0, 600 * Math.sin(x / 1500) * Math.cos(z / 1800)) }
  for (let seed = 0; seed < 30; seed++) {
    const brain = createBotBrain(seed)
    const vs: VehicleEntity[] = []
    for (let i = 0; i < 8; i++) {
      vs.push(vehicle(kinds[Math.floor(r() * 4)], (i % 2) as TeamId, [r() * 14_000 - 7_000, r() * 3500, r() * 14_000 - 7_000],
        [r() * 300 - 150, r() * 40 - 20, r() * 300 - 150], undefined, r() < 0.1))
      if (r() < 0.5) vs[i].spottedUntil = 1e9
    }
    const missiles: Missile[] = [{ id: 1, weapon: "aim9", owner: "x", vehicle: vs[1].id, team: 1, position: [0, 1000, 0], velocity: [0, 0, 300], target: vs[0].id, steered: false, age: 0, ttl: 8 }]
    for (let t = 0; t < 120; t++) {
      for (const seat of [0, 1] as const) {
        const out = botInput(brain, player(0, seat), vs[0], vs, t / 6, missiles, world)
        if (out.flight) {
          const f = out.flight
          for (const k of [f.throttle, f.roll, f.yaw, f.pitch]) { expect(Number.isFinite(k)).toBe(true); expect(Math.abs(k)).toBeLessThanOrEqual(1) }
          expect(Math.abs(len(f.aim!) - 1)).toBeLessThan(1e-6)
        }
        if (out.seat.aim) expect(Math.abs(len(out.seat.aim) - 1)).toBeLessThan(1e-6)
      }
      vs[0].flight.position[0] += vs[0].flight.velocity[0] / 6
      vs[0].flight.position[2] += vs[0].flight.velocity[2] / 6
    }
  }
})

test("deterministic for the same seed", () => {
  const run = () => {
    const brain = createBotBrain(42)
    const me = vehicle("fighter", 0, [0, 2000, 0], [0, 0, -150])
    me.id = "me"
    const enemy = vehicle("warthog", 1, [300, 1800, -1500], [80, 0, 30])
    enemy.id = "enemy"
    const outs: string[] = []
    for (let t = 0; t < 200; t++) {
      enemy.flight.position[0] += 80 / 60
      outs.push(JSON.stringify(botInput(brain, player(0, 0), me, [me, enemy], t / 60, [], flat())))
      outs.push(JSON.stringify(botInput(brain, player(0, 1), me, [me, enemy], t / 60, [], flat())))
    }
    return outs.join("\n")
  }
  expect(run()).toBe(run())
})

test("lower skill means more aim jitter", () => {
  const spread = (skill: number) => {
    const me = vehicle("fighter", 0, [0, 2000, 0], [0, 0, -150])
    const enemy = vehicle("fighter", 1, [0, 2000, -2000], [0, 0, -150])
    let max = 0
    for (let seed = 0; seed < 20; seed++) {
      const out = botInput(createBotBrain(seed, skill), player(0, 0), me, [me, enemy], 10, [], flat())
      max = Math.max(max, angle(out.flight!.aim!, [0, 0, -1]))
    }
    return max
  }
  expect(spread(0)).toBeGreaterThan(spread(1) * 5)
})

test("chooseBotVehicle mixes kinds and avoids stacking Blackbirds", () => {
  let s = 7
  const rng = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
  const bot = player(0, 0)
  const seen = new Set<string>()
  for (let i = 0; i < 400; i++) seen.add(chooseBotVehicle(bot, [], [], rng))
  expect(seen.size).toBe(4)
  const bbs = [vehicle("blackbird", 0, [0, 0, 0], [0, 0, 0]), vehicle("blackbird", 0, [0, 0, 0], [0, 0, 0])]
  let bb = 0
  for (let i = 0; i < 400; i++) if (chooseBotVehicle(bot, [], bbs, rng) === "blackbird") bb++
  expect(bb).toBeLessThan(10)
})
