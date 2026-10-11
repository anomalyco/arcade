import { describe, expect, test } from "bun:test"
import {
  FLARE_TARGET_PREFIX, applySeatInput, createCombatState, createWeapons, damageFor, killVehicle, leadPoint,
  stepCombat, sweptSphere, type CombatState,
} from "../src/sim/combat"
import { AIRBASES } from "../src/sim/geography"
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

function input(p: Partial<SeatInput> = {}): SeatInput {
  return { aim: null, firePrimary: false, fireSecondary: false, flares: false, ability: false, ...p }
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

describe("safe zones", () => {
  const base = AIRBASES[1].center

  test("vehicle inside its own safe zone takes no damage", () => {
    const target = vehicle("fighter", 1, [base[0], base[1] + 300, base[2]], [0, 0, 0])
    const shooter = vehicle("fighter", 0, [base[0], base[1] + 300, base[2] + 600], [0, 0, 0])
    const w = world([shooter, target])
    for (let i = 0; i < 60; i++) tick(w, [[shooter, 0, input({ firePrimary: true })]])
    for (let i = 0; i < 60; i++) tick(w)
    expect(w.cs.projectiles.length + (600 - shooter.weapons[0][0].ammo)).toBeGreaterThan(0)
    expect(target.hp).toBe(target.maxHp)
  })

  test("vehicle inside its own safe zone cannot fire", () => {
    const shooter = vehicle("fighter", 1, [base[0], base[1] + 300, base[2]], [0, 0, 0])
    const w = world([shooter])
    for (let i = 0; i < 30; i++) tick(w, [[shooter, 0, input({ firePrimary: true, fireSecondary: true })]])
    expect(w.cs.projectiles.length).toBe(0)
    expect(w.cs.missiles.length).toBe(0)
    expect(shooter.weapons[0][0].ammo).toBe(WEAPONS.cannon20.ammo)
  })
})

describe("lock-on missiles", () => {
  test("lock acquires in lockTime and is lost when out of cone", () => {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, 0])
    const target = vehicle("fighter", 1, [0, ALT, -1200], [0, 0, 0])
    const w = world([shooter, target])
    const rt = shooter.weapons[0][1]
    const ticks = Math.round(WEAPONS.aim9.lockTime! / TICK_DT)
    for (let i = 0; i < ticks - 1; i++) tick(w, [[shooter, 0, input({ aim: [0, 0, -1] })]])
    expect(rt.lockTarget).toBe(target.id)
    expect(rt.lock).toBeLessThan(1)
    expect(w.events.some(e => e.type === "lock")).toBe(false)
    tick(w, [[shooter, 0, input({ aim: [0, 0, -1] })]])
    expect(rt.lock).toBe(1)
    expect(w.events.filter(e => e.type === "lock" && e.locked)).toHaveLength(1)

    target.flight.position = [900, ALT, -1200] // ~37° off the aim axis
    tick(w, [[shooter, 0, input({ aim: [0, 0, -1] })]])
    expect(rt.lockTarget).toBeNull()
    expect(rt.lock).toBe(0)
    expect(w.events.filter(e => e.type === "lock" && !e.locked)).toHaveLength(1)
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

  test("homing missile hits a straight-flying target", () => {
    const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
    const target = vehicle("fighter", 1, [-200, ALT + 100, -1500], [150, 0, 0], [1, 0, 0])
    const w = world([shooter, target])
    const aimAt = () => input({ aim: sub(target.flight.position, shooter.flight.position) })
    for (let i = 0; i < 75; i++) tick(w, [[shooter, 0, aimAt()]])
    expect(shooter.weapons[0][1].lock).toBe(1)
    tick(w, [[shooter, 0, { ...aimAt(), fireSecondary: true }]])
    expect(w.cs.missiles).toHaveLength(1)
    expect(w.cs.missiles[0].target).toBe(target.id)
    for (let i = 0; i < 8 * 60 && w.cs.missiles.length; i++) tick(w)
    const h = hits(w, target)
    expect(h).toHaveLength(1)
    const frac = (target.maxHp - target.hp) / target.maxHp
    expect(frac).toBeGreaterThan(0.55)
    expect(frac).toBeLessThan(0.65)
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

  test("flares decoy most inbound heat-seekers", () => {
    let decoyed = 0, survived = 0
    const N = 20
    for (let n = 0; n < N; n++) {
      const shooter = vehicle("fighter", 0, [0, ALT, 0], [0, 0, -150])
      const target = vehicle("fighter", 1, [0, ALT, -1400], [0, 0, -150])
      const w = world([shooter, target])
      w.cs.nextId = 1 + n * 7 // vary ids → vary deterministic rolls
      for (let i = 0; i < 75; i++) tick(w, [[shooter, 0, input({ aim: [0, 0, -1] })]])
      tick(w, [[shooter, 0, input({ aim: [0, 0, -1], fireSecondary: true })]])
      for (let i = 0; i < 60; i++) tick(w)
      tick(w, [[target, 0, input({ flares: true })]])
      expect(w.events.some(e => e.type === "flares")).toBe(true)
      expect(target.flareCount).toBe(VEHICLES.fighter.flares - 1)
      if (w.cs.missiles[0]?.target?.startsWith(FLARE_TARGET_PREFIX)) decoyed++
      for (let i = 0; i < 8 * 60 && w.cs.missiles.length; i++) tick(w)
      if (target.hp === target.maxHp) survived++
    }
    expect(decoyed).toBeGreaterThanOrEqual(N * 0.5)
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
    expect(target.maxHp - target.hp).toBeCloseTo(damageFor("aim47", target, 0))
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
    expect(h && h.type === "hit" && h.damage).toBeCloseTo(WEAPONS.cannon20.damage * 1.55 * 1.2)
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
    expect(ttk("cannon20", "fighter")).toBeGreaterThan(1.5)
    expect(ttk("cannon20", "fighter")).toBeLessThan(2.5)
    expect(ttk("gau8", "fighter")).toBeLessThan(ttk("cannon20", "fighter"))
    expect(ttk("chaingun30", "apache")).toBeLessThan(2.5)
    const aim9 = damageFor("aim9", v("fighter"), 0) / VEHICLES.fighter.maxHp
    expect(aim9).toBeGreaterThan(0.55)
    expect(aim9).toBeLessThan(0.65)
    const table: Record<string, Record<string, string>> = {}
    for (const w of ["cannon20", "gau8", "chaingun30"] as const) {
      table[w] = {}
      for (const k of ["fighter", "apache", "warthog", "blackbird"] as VehicleKind[]) table[w][k] = ttk(w, k).toFixed(2) + "s"
    }
    for (const w of ["aim9", "tvmissile", "hellfire", "maverick", "aim47", "rockets"] as const) {
      table[w] = {}
      for (const k of ["fighter", "apache", "warthog", "blackbird"] as VehicleKind[]) table[w][k] = Math.round(100 * damageFor(w, v(k), 0) / VEHICLES[k].maxHp) + "%"
    }
    console.table(table)
  })
})
