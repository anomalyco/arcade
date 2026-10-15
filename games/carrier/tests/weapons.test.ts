import { describe, expect, test } from "bun:test"
import { PLANE } from "../shared/plane"
import {
  LOADOUTS,
  WEAPONS,
  cycleWeapon,
  selectSlot,
  takeBomb,
  weaponOf,
  canHurt,
  damageState,
  gunStep,
  lockStep,
  loadoutStep,
  makeLoadout,
  makeTarget,
  rearm,
  takeFlares,
  takeMissile,
  type Shooter,
  type Target,
} from "../shared/weapons"

const DT = PLANE.tick
const steps = (s: number) => Math.round(s / DT)

/** At the origin, nose north (−z), team 0. */
const shooter: Shooter = { x: 0, y: 1000, z: 0, fx: 0, fy: 0, fz: -1, team: 0 }

function enemy(id: number, x: number, y: number, z: number, team = 1): Target {
  return Object.assign(makeTarget(id, team), { x, y, z })
}

describe("gun", () => {
  test("fires 50 rounds a second, the first at once", () => {
    const l = makeLoadout()
    expect(gunStep(l, true, DT)).toBe(1)
    let n = 1
    for (let i = 1; i < steps(1); i++) n += gunStep(l, true, DT)
    expect(n).toBeGreaterThanOrEqual(WEAPONS.gun.rate - 1)
    expect(n).toBeLessThanOrEqual(WEAPONS.gun.rate + 1)
  })

  test("overheats after heatTime of fire, then stays silent until it cools to the restart heat", () => {
    const l = makeLoadout()
    let t = 0
    while (!l.overheated && t < 10) {
      gunStep(l, true, DT)
      t += DT
    }
    expect(Math.abs(t - WEAPONS.gun.heatTime)).toBeLessThan(0.05)
    // Still holding the trigger: nothing comes out while it cools.
    let fired = 0
    let cool = 0
    while (l.overheated) {
      fired += gunStep(l, false, DT)
      cool += DT
    }
    expect(fired).toBe(0)
    expect(l.heat).toBeLessThanOrEqual(WEAPONS.gun.restart + 1e-9)
    expect(cool).toBeGreaterThan(1)
    expect(gunStep(l, true, DT)).toBe(1)
  })

  test("short bursts never overheat", () => {
    const l = makeLoadout()
    for (let k = 0; k < 20; k++) {
      for (let i = 0; i < steps(0.6); i++) gunStep(l, true, DT)
      for (let i = 0; i < steps(1.5); i++) gunStep(l, false, DT)
    }
    expect(l.overheated).toBe(false)
  })
})

describe("loadout", () => {
  test("two missiles, launch interval, rearm one at a time", () => {
    const l = makeLoadout()
    expect(takeMissile(l)).toBe(0)
    expect(takeMissile(l)).toBe(-1) // interval
    for (let i = 0; i < steps(WEAPONS.missile.interval + 0.05); i++) loadoutStep(l, DT)
    expect(takeMissile(l)).toBe(1)
    expect(l.missiles).toBe(0)
    expect(takeMissile(l)).toBe(-1)
    for (let i = 0; i < steps(WEAPONS.missile.reload - 1); i++) loadoutStep(l, DT)
    expect(l.missiles).toBe(0)
    for (let i = 0; i < steps(1.5); i++) loadoutStep(l, DT)
    expect(l.missiles).toBe(1)
    for (let i = 0; i < steps(WEAPONS.missile.reload); i++) loadoutStep(l, DT)
    expect(l.missiles).toBe(2)
  })

  test("flare bursts reload after their cooldown; a new sortie fills everything", () => {
    const l = makeLoadout()
    expect(takeFlares(l)).toBe(true)
    expect(takeFlares(l)).toBe(true)
    expect(takeFlares(l)).toBe(false)
    for (let i = 0; i < steps(WEAPONS.flare.reload + 0.1); i++) loadoutStep(l, DT)
    expect(l.flares).toBe(1)
    l.heat = 0.8
    rearm(l)
    expect(l.flares).toBe(LOADOUTS.hornet.flares)
    expect(l.missiles).toBe(LOADOUTS.hornet.missiles)
    expect(l.heat).toBe(0)
  })
})

describe("per-aircraft loadouts", () => {
  test("the Hornet cycles gun and missiles; 1/2 select them", () => {
    const l = makeLoadout("hornet")
    expect(weaponOf(l)).toBe("gun")
    expect(selectSlot(l, 1)).toBe(true)
    expect(weaponOf(l)).toBe("missile")
    expect(selectSlot(l, 2)).toBe(false)
    expect(cycleWeapon(l, 1)).toBe(true)
    expect(weaponOf(l)).toBe("gun")
    cycleWeapon(l, -1)
    expect(weaponOf(l)).toBe("missile")
    expect(takeBomb(l)).toBe(-1)
  })

  test("the F-35C strike bomber has no gun: missiles and bombs only", () => {
    const l = makeLoadout("f35")
    expect(l.spec.weapons.includes("gun")).toBe(false)
    expect(weaponOf(l)).toBe("missile")
    expect(gunStep(l, true, DT)).toBe(0)
    selectSlot(l, 1)
    expect(weaponOf(l)).toBe("bomb")
    expect(takeBomb(l)).toBe(0)
    for (let i = 0; i < steps(WEAPONS.bomb.interval + 0.05); i++) loadoutStep(l, DT)
    expect(takeBomb(l)).toBe(1)
    expect(takeBomb(l)).toBe(-1)
    expect(l.bombs).toBe(l.spec.bombs - 2)
    for (let i = 0; i < steps(WEAPONS.bomb.reload + 0.1); i++) loadoutStep(l, DT)
    expect(l.bombs).toBe(l.spec.bombs - 1)
    // A new sortie in a Hornet starts on its gun.
    rearm(l, "hornet")
    expect(weaponOf(l)).toBe("gun")
    expect(l.bombs).toBe(0)
  })

  test("an F-35C launches with its missiles selected, never its bombs (no bombsight off the catapult)", () => {
    const l = makeLoadout("f35")
    expect(weaponOf(l)).toBe("missile")
    // Bombs selected when the last sortie ended (landed, crashed or shot down): the next one starts on missiles.
    selectSlot(l, 1)
    expect(weaponOf(l)).toBe("bomb")
    rearm(l)
    expect(weaponOf(l)).toBe("missile")
    expect(l.bombs).toBe(LOADOUTS.f35.bombs)
    // From a Hornet sortie on its missiles, too.
    const h = makeLoadout("hornet")
    selectSlot(h, 1)
    rearm(h, "f35")
    expect(weaponOf(h)).toBe("missile")
  })
})

describe("seeker", () => {
  test("locks an enemy inside the cone after lockTime", () => {
    const l = makeLoadout().lock
    const t = [enemy(7, 100, 1000, -1500)]
    let time = 0
    while (!l.locked && time < 5) {
      lockStep(l, DT, shooter, t)
      time += DT
    }
    expect(l.target).toBe(7)
    expect(Math.abs(time - WEAPONS.missile.lockTime)).toBeLessThan(0.05)
  })

  test("ignores jets outside the cone, out of range, too close, friendly or wrecked", () => {
    const off = Math.tan(WEAPONS.missile.cone * 1.1) * 1000
    const cases = [enemy(1, off, 1000, -1000), enemy(2, 0, 1000, -WEAPONS.missile.range - 50), enemy(3, 0, 1000, -50), enemy(4, 0, 1000, -1000, 0), Object.assign(enemy(5, 0, 1000, -1000), { alive: false })]
    for (const c of cases) {
      const l = makeLoadout().lock
      for (let i = 0; i < steps(3); i++) lockStep(l, DT, shooter, [c])
      expect(l.target).toBe(-1)
      expect(l.locked).toBe(false)
    }
  })

  test("picks the jet nearest the boresight; the lock builds only in the tight cone, then holds in the keep cone", () => {
    const m = WEAPONS.missile
    const l = makeLoadout().lock
    const a = enemy(1, Math.tan(m.cone * 0.8) * 1500, 1000, -1500)
    const b = enemy(2, Math.tan(m.cone * 0.2) * 2000, 1000, -2000)
    lockStep(l, DT, shooter, [a, b])
    expect(l.target).toBe(2)
    // b drifts past the lock cone but inside the keep cone: still tracked, but the lock does not build.
    b.x = Math.tan(m.cone * 1.5) * 2000
    for (let i = 0; i < steps(m.lockTime + 0.5); i++) lockStep(l, DT, shooter, [a, b])
    expect(l.target).toBe(2)
    expect(l.locked).toBe(false)
    // Back on the nose: it locks after lockTime, then holds while b swings out to most of the keep cone.
    b.x = Math.tan(m.cone * 0.2) * 2000
    for (let i = 0; i < steps(m.lockTime + 0.1); i++) lockStep(l, DT, shooter, [a, b])
    expect(l.locked).toBe(true)
    b.x = Math.tan(m.cone * m.keep * 0.9) * 2000
    lockStep(l, DT, shooter, [a, b])
    expect(l.target).toBe(2)
    expect(l.locked).toBe(true)
    // Past the keep cone: lost; the seeker starts over on a.
    b.x = Math.tan(m.cone * m.keep * 1.1) * 2000
    lockStep(l, DT, shooter, [a, b])
    expect(l.target).toBe(1)
    expect(l.locked).toBe(false)
  })

  test("a jet that just flared breaks the lock and cannot be picked", () => {
    const l = makeLoadout().lock
    const t = [enemy(9, 0, 1000, -1200)]
    for (let i = 0; i < steps(2); i++) lockStep(l, DT, shooter, t)
    expect(l.locked).toBe(true)
    expect(lockStep(l, DT, shooter, t, (id) => id === 9)).toBe(true)
    expect(l.target).toBe(-1)
    expect(l.locked).toBe(false)
  })
})

test("friendly fire is off and damage states follow health", () => {
  expect(canHurt(0, 1, 1, 2)).toBe(true)
  expect(canHurt(0, 1, 0, 2)).toBe(false)
  expect(canHurt(0, 1, 1, 1)).toBe(false)
  expect(damageState(100)).toBe(0)
  expect(damageState(49)).toBe(1)
  expect(damageState(24)).toBe(2)
  expect(damageState(0)).toBe(3)
})
