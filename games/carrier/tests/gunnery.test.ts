import { describe, expect, test } from "bun:test"
import { WEAPON_MOUNTS } from "../shared/carrier-spec"
import { CombatWorld, type Ground, type GroundShip } from "../shared/combat"
import { Fleet } from "../shared/fleet"
import {
  GUNNERY,
  GunneryWorld,
  SAM_CELLS,
  TURRET_GEOMETRY,
  TURRET_SCALE,
  TurretRounds,
  type TurretHit,
  type GunneryEvent,
  type Interceptable,
  asInterceptable,
  boreLocal,
  ciwsStep,
  clampAim,
  isAimTuple,
  isGunBoomTuple,
  isGunFireTuple,
  isInterceptTuple,
  isTurretTuple,
  leadPoint,
  makeTurretState,
  muzzleWorld,
  packAim,
  packGunBoom,
  packGunFire,
  packTurret,
  predictImpact,
  restAngles,
  samDecoyed,
  samLockStep,
  samTrigger,
  shellStep,
  shipHitOf,
  slewTurret,
  takeSam,
  takeShell,
  turretStep,
  unpackGunBoom,
  unpackGunFire,
} from "../shared/gunnery"
import { PLANE, type Vec3, shipToWorld } from "../shared/plane"
import { makeTarget, type Target } from "../shared/weapons"
import { buildShipWeapons, WEAPON_SCALE } from "../src/render/ship-weapons"
import { CAPACITY, joinCrew, leaveCrew, makeCrew, playerOf, runOp, scuttle, shipOf } from "../shared/crew"
import { OPS, gunOp, gunnerAt, shipOps } from "../shared/ops"
import { add } from "./crew-helpers"
import { HitStop } from "@arcade/kit/client/camera"
import { FEEDBACK, punchScale } from "../src/feedback/settings"
import { TurretCam } from "../src/gunnery/camera"
import { SHAKE } from "../src/render/camera"
import { RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { type ClientMsg, type ServerMsg, decodeClient, decodeServer, encode } from "../shared/protocol"

const DT = PLANE.tick
const AIR: Ground = { sea: null, arch: null }
/** A carrier at the origin heading north (bow toward −z), level. */
const SHIP: GroundShip = { x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, id: 1, team: 0 }
const ENEMY: GroundShip = { x: 0, z: -4000, heave: 0, heading: 0, pitch: 0, roll: 0, id: 2, team: 1 }
const CIWS = WEAPON_MOUNTS.findIndex((m) => m.kind === "ciws")
const SAM = WEAPON_MOUNTS.findIndex((m) => m.kind === "sam")
const GUN = WEAPON_MOUNTS.findIndex((m) => m.kind === "gun")

describe("gun seats (DEPLOY)", () => {
  /** p1 helms ship 1 with pilots p2, p3 on deck. */
  const crew = () => {
    const c = makeCrew(5)
    joinCrew(c, 1, "p1", 0)
    add(c, 2, 1)
    add(c, 3, 1)
    return c
  }
  const view = (c: ReturnType<typeof makeCrew>, id: number, op: string) => shipOps(c, id, 0)!.find((v) => v.op.id === op)!

  test("one operation per mount, cap 1, no recharge; the ship holds 8 in all", () => {
    const guns = OPS.filter((o) => o.kind === "gun")
    expect(guns.map((o) => o.label)).toEqual(["CIWS PORT", "CIWS STBD", "SAM PORT", "SAM STBD", "5-INCH GUN"])
    expect(new Set(guns.map((o) => o.mount)).size).toBe(WEAPON_MOUNTS.length)
    for (const o of guns) {
      expect(o).toMatchObject({ cap: 1, recharge: 0 })
      expect(WEAPON_MOUNTS[o.mount!]!.side).toBe(o.id.endsWith("port") ? "port" : "starboard")
    }
    expect(gunOp(CIWS)!.id).toBe("ciws-port")
    expect(CAPACITY).toBe(8)
  })

  test("taking a gun: a pilot on deck switches, a second gunner is refused, the gunner sees it as theirs", () => {
    const c = crew()
    expect(runOp(c, 2, "ciws-port", 0).events).toEqual([{ k: "gun", player: 2, ship: 1, mount: CIWS }])
    expect(playerOf(c, 2)).toMatchObject({ role: "gunner", mount: CIWS, plane: -1 })
    expect(gunnerAt(c, shipOf(c, 1)!, CIWS)).toBe(2)
    expect(runOp(c, 3, "ciws-port", 0).error).toBe("in-use")
    expect(view(c, 3, "ciws-port")).toMatchObject({ state: "in-use", slots: [{ player: 2, readyIn: 0 }] })
    expect(runOp(c, 2, "ciws-port", 0).error).toBe("at-gun")
    expect(view(c, 2, "ciws-port").state).toBe("active")
    // Another gun: switches seats, the old one is free again.
    expect(runOp(c, 2, "sam-stbd", 0).error).toBeUndefined()
    expect(playerOf(c, 2)!.mount).toBe(WEAPON_MOUNTS.findIndex((m) => m.kind === "sam" && m.side === "starboard"))
    expect(runOp(c, 3, "ciws-port", 0).error).toBeUndefined()
  })

  test("the helm hands off to take a gun; a gunner takes the helm or launches, leaving the gun", () => {
    const c = crew()
    expect(runOp(c, 1, "gun-5in", 0).events).toEqual([
      { k: "helm", ship: 1, player: null },
      { k: "gun", player: 1, ship: 1, mount: GUN },
    ])
    expect(shipOf(c, 1)!.helm).toBeNull()
    expect(runOp(c, 1, "helm", 0).error).toBeUndefined()
    expect(playerOf(c, 1)).toMatchObject({ role: "helm", mount: -1 })
    runOp(c, 2, "ciws-stbd", 0)
    expect(runOp(c, 2, "hornet", 0).error).toBeUndefined()
    expect(playerOf(c, 2)).toMatchObject({ role: "pilot", mount: -1, plane: 0 })
    expect(gunnerAt(c, shipOf(c, 1)!, WEAPON_MOUNTS.findIndex((m) => m.kind === "ciws" && m.side === "starboard"))).toBeNull()
    // In the air: no gun seats.
    expect(runOp(c, 2, "ciws-port", 0).error).toBe("flying")
  })

  test("leaving the room or the ship sinking vacates the seat", () => {
    const c = crew()
    runOp(c, 2, "ciws-port", 0)
    runOp(c, 3, "sam-port", 0)
    leaveCrew(c, 2, 1)
    expect(gunnerAt(c, shipOf(c, 1)!, CIWS)).toBeNull()
    scuttle(c, 1, 2)
    // Aboard the replacement (ship 5, same team) as a pilot on deck.
    expect(playerOf(c, 3)).toMatchObject({ ship: 5, team: 0, role: "pilot", mount: -1 })
  })
})

describe("turret geometry", () => {
  test("pivots match the meshes in src/render/ship-weapons.ts", () => {
    expect(TURRET_SCALE).toBe(WEAPON_SCALE)
    for (const w of buildShipWeapons()) {
      const g = TURRET_GEOMETRY[w.kind]
      const m = WEAPON_MOUNTS[w.index]!
      expect(w.yawPivot[1]).toBeCloseTo(m.pos[1] + g.yawY * TURRET_SCALE, 6)
      for (let i = 0; i < 3; i++) expect(w.pitchPivot[i]!).toBeCloseTo(g.pivot[i]! * TURRET_SCALE, 6)
    }
  })

  test("the SAM box has 8 distinct cell mouths at its front", () => {
    expect(SAM_CELLS.length).toBe(8)
    expect(new Set(SAM_CELLS.map((c) => c.join())).size).toBe(8)
    for (const c of SAM_CELLS) expect(c[2]).toBeGreaterThan(4)
  })
})

describe("slew and arcs", () => {
  test("a wanted yaw outside the arc goes to the nearer end; pitch clamps", () => {
    const m = WEAPON_MOUNTS[GUN]!
    const [y0, y1] = m.yawArc
    expect(clampAim(m, y1 + 0.2, 0).yaw).toBeCloseTo(y1, 9)
    expect(clampAim(m, y0 - 0.2, 0).yaw).toBeCloseTo(y0, 9)
    // Just past ±π on the far side of the ship: the nearer end by angle.
    expect(clampAim(m, 3.0, 0).yaw).toBeCloseTo(y0, 9)
    expect(clampAim(m, 0, 5).pitch).toBe(m.pitchArc[1])
    expect(clampAim(m, 0, -5).pitch).toBe(m.pitchArc[0])
  })

  test("every mount trains through 200°; an arc running past ±π keeps aims in range and clamps to the nearer end", () => {
    for (const m of WEAPON_MOUNTS) expect(m.yawArc[1] - m.yawArc[0]).toBeCloseTo((200 * Math.PI) / 180, 9)
    const i = WEAPON_MOUNTS.findIndex((m) => m.yawArc[1] > Math.PI)
    expect(i).toBeGreaterThanOrEqual(0)
    const m = WEAPON_MOUNTS[i]!
    const [y0, y1] = m.yawArc
    // Just inside the far end, asked for as its wrapped (negative) angle: still that end, not clamped.
    expect(clampAim(m, y1 - 0.05 - 2 * Math.PI, 0).yaw).toBeCloseTo(y1 - 0.05, 9)
    expect(clampAim(m, y1 + 0.1, 0).yaw).toBeCloseTo(y1, 9)
    expect(clampAim(m, y0 - 0.1, 0).yaw).toBeCloseTo(y0, 9)
    const a = restAngles(i)
    for (let k = 0; k < 2000; k++) slewTurret(a, i, y1 - 2 * Math.PI, 0, DT)
    expect(a.yaw).toBeCloseTo(y1, 6)
  })

  test("turrets train at their own rates and stop on the clamped aim", () => {
    for (const i of [CIWS, SAM, GUN]) {
      const m = WEAPON_MOUNTS[i]!
      const t = GUNNERY[m.kind]
      const a = restAngles(i)
      const want = clampAim(m, m.yawArc[1], m.pitchArc[1])
      const y0 = a.yaw
      slewTurret(a, i, want.yaw, want.pitch, 0.5)
      expect(Math.abs(a.yaw - y0)).toBeCloseTo(Math.min(Math.abs(want.yaw - y0), t.yawRate * 0.5), 6)
      let on = false
      for (let k = 0; k < 600 && !on; k++) on = slewTurret(a, i, m.yawArc[1], 99, DT)
      expect(on).toBe(true)
      expect(a.yaw).toBeCloseTo(m.yawArc[1], 6)
      expect(a.pitch).toBeCloseTo(m.pitchArc[1], 6)
    }
  })

  test("the slow 5-inch gun takes seconds to swing where the CIWS takes a fraction", () => {
    const time = (i: number) => {
      const m = WEAPON_MOUNTS[i]!
      const a = { yaw: m.yawArc[0], pitch: 0 }
      let n = 0
      while (!slewTurret(a, i, m.yawArc[1], 0, DT) && n < 10_000) n++
      return ((n + 1) * DT) / (m.yawArc[1] - m.yawArc[0])
    }
    expect(time(GUN)).toBeGreaterThan(time(CIWS) * 2.5)
  })

  test("yaw moves inside the arc, never through the ship", () => {
    const m = WEAPON_MOUNTS[GUN]!
    const a = { yaw: m.yawArc[0] + 0.01, pitch: 0 }
    for (let k = 0; k < 2000; k++) {
      slewTurret(a, GUN, m.yawArc[1], 0, DT)
      expect(a.yaw).toBeGreaterThanOrEqual(m.yawArc[0] - 1e-9)
      expect(a.yaw).toBeLessThanOrEqual(m.yawArc[1] + 1e-9)
    }
  })
})

/** A jet target at p moving at v. */
const jet = (id: number, team: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): Target => Object.assign(makeTarget(id, team), { x, y, z, vx, vy, vz })

/** Points mount `i` at a world point and fires CIWS rounds at it with lead for `secs`, stepping both. */
function ciwsAt(rounds: TurretRounds, ship: GroundShip, i: number, aim: () => Vec3, secs: number, step: (t: number) => void, jets: Target[] = [], stores: () => Interceptable[] = () => []): void {
  const st = makeTurretState(i)
  const a = restAngles(i)
  const pos: Vec3 = [0, 0, 0]
  const dir: Vec3 = [0, 0, 0]
  const lead: Vec3 = [0, 0, 0]
  let t = 0
  for (let k = 0; k < Math.round(secs / DT); k++) {
    t += DT
    step(t)
    muzzleWorld(ship, i, a.yaw, a.pitch, pos, dir)
    const p = aim()
    lead[0] = p[0]
    lead[1] = p[1]
    lead[2] = p[2]
    // Local aim: the ship is level and heading north, so ship-local = world rotated by π.
    const lx = -(lead[0] - pos[0])
    const ly = lead[1] - pos[1]
    const lz = -(lead[2] - pos[2])
    slewTurret(a, i, Math.atan2(lx, lz), Math.atan2(ly, Math.hypot(lx, lz)), DT)
    const n = ciwsStep(st, true, DT)
    for (let r = 0; r < n; r++) rounds.fire(7, 0, ship.id!, st.round++, pos[0], pos[1], pos[2], [0, 0, 0], dir, (r / n) * DT)
    rounds.step(DT, t, jets, stores(), AIR, hitFn)
  }
}
let hitFn: TurretHit = () => {}

describe("CIWS", () => {
  test("heats up and locks out like the jets' cannon, then cools", () => {
    const st = makeTurretState(CIWS)
    let n = 0
    let t = 0
    while (!st.overheated && t < 10) {
      n += ciwsStep(st, true, DT)
      t += DT
    }
    expect(t).toBeCloseTo(GUNNERY.ciws.heatTime, 1)
    expect(n).toBeGreaterThan(GUNNERY.ciws.rate * GUNNERY.ciws.heatTime * 0.95)
    expect(ciwsStep(st, true, DT)).toBe(0)
    for (let k = 0; k < 600; k++) ciwsStep(st, false, DT)
    expect(st.overheated).toBe(false)
  })

  test("shreds a jet inside its range, but not a friendly", () => {
    const rounds = new TurretRounds(1024)
    const m = WEAPON_MOUNTS[CIWS]!
    const at = shipToWorld(SHIP, m.pos[0] + 600, m.pos[1] + 300, m.pos[2] + 500)
    const enemy = jet(100, 1, at[0], at[1], at[2])
    const friend = jet(101, 0, at[0], at[1], at[2] + 3)
    const hits = new Map<number, number>()
    hitFn = (_o, kind, target) => {
      if (kind === "jet") hits.set(target, (hits.get(target) ?? 0) + 1)
    }
    ciwsAt(rounds, SHIP, CIWS, () => [at[0], at[1], at[2]], 1.5, () => {}, [enemy, friend])
    expect(hits.get(100) ?? 0).toBeGreaterThan(25)
    expect(hits.get(101) ?? 0).toBe(0)
  })

  test("shoots down an incoming missile and a falling bomb (projectile vs projectile, server check)", () => {
    for (const kind of ["missile", "bomb"] as const) {
      const combat = new CombatWorld({ sea: null, arch: null }, true)
      combat.spawn(200, 1, kind === "bomb" ? "f35" : "hornet")
      const m = WEAPON_MOUNTS[CIWS]!
      // From 2.5 km off the port bow straight at the mount (missile) or falling onto the deck (bomb).
      const mount = shipToWorld(SHIP, m.pos[0], m.pos[1] + 4, m.pos[2])
      const from = kind === "bomb" ? shipToWorld(SHIP, m.pos[0] + 700, 650, m.pos[2] + 500) : shipToWorld(SHIP, m.pos[0] + 1800, 200, m.pos[2] + 1200)
      const d = Math.hypot(mount[0] - from[0], mount[1] - from[1], mount[2] - from[2])
      const sp = kind === "bomb" ? 860 / Math.sqrt((2 * 620) / 9.81) : 450
      const v: Vec3 = kind === "bomb" ? [((mount[0] - from[0]) / d) * sp, 0, ((mount[2] - from[2]) / d) * sp] : [((mount[0] - from[0]) / d) * sp, ((mount[1] - from[1]) / d) * sp, ((mount[2] - from[2]) / d) * sp]
      const store = combat.fire({ owner: 200, seq: 1, t: 0, x: from[0], y: from[1], z: from[2], vx: v[0], vy: v[1], vz: v[2], target: -1, kind })!
      expect(store).not.toBeNull()
      const world = new GunneryWorld({ sea: null, arch: null, ships: [SHIP] }, true)
      world.man(7, 0, SHIP.id!, CIWS)
      const rounds = new TurretRounds(2048)
      const list: Interceptable[] = [{ store: 0, owner: 0, seq: 0, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }]
      let claimed = false
      hitFn = (_o, k, idx) => {
        if (k !== "store" || claimed) return
        const s = list[idx]!
        const live = combat.missiles.find((x) => x.alive && x.owner === s.owner && x.seq === s.seq)
        if (live && world.intercept(7, asInterceptable(live, 0, { ...s }))) {
          combat.snap(s.owner, s.seq)
          claimed = true
        }
      }
      ciwsAt(
        rounds,
        SHIP,
        CIWS,
        () => {
          // Lead the store from the mount at the round's speed.
          const out: Vec3 = [0, 0, 0]
          leadPoint(mount[0], mount[1], mount[2], 0, 0, 0, GUNNERY.ciws.muzzle, store.x, store.y, store.z, store.vx, store.vy, store.vz, 1, out)
          return out
        },
        12,
        (t) => {
          combat.step(t, [])
          world.step(t, { jets: [] })
          world.aim(7, 0, 0, true)
          // Keep the gunner's reported aim on the store, as a client would.
          const lx = -(store.x - mount[0])
          const lz = -(store.z - mount[2])
          world.aim(7, Math.atan2(lx, lz), Math.atan2(store.y - mount[1], Math.hypot(lx, lz)), true)
        },
        [],
        () => (store.alive ? [asInterceptable(store, 0, list[0]!)] : []),
      )
      expect(claimed).toBe(true)
      expect(store.alive).toBe(false)
      expect(world.events.some((e) => e.k === "intercept" && e.store === 0 && e.owner === 200)).toBe(true)
    }
  })

  test("the room refuses intercept claims that don't add up", () => {
    const world = new GunneryWorld({ sea: null, arch: null, ships: [SHIP] }, true)
    const s: Interceptable = { store: 0, owner: 200, seq: 1, team: 1, x: 0, y: 300, z: -800, vx: 0, vy: 0, vz: 0 }
    // Not a gunner.
    expect(world.intercept(7, s)).toBe(false)
    world.man(7, 0, SHIP.id!, CIWS)
    // Not firing.
    expect(world.intercept(7, s)).toBe(false)
    world.aim(7, 0.6, 0.05, true)
    // Out of range.
    expect(world.intercept(7, { ...s, x: 0, y: 300, z: -9000 })).toBe(false)
    // Friendly store.
    expect(world.intercept(7, { ...s, team: 0 })).toBe(false)
    // Far off the reported aim (behind the ship).
    expect(world.intercept(7, { ...s, x: 0, y: 100, z: 900 })).toBe(false)
    // A SAM gunner can't claim CIWS intercepts.
    world.man(8, 0, SHIP.id!, SAM)
    world.aim(8, -1, 0.1, true)
    expect(world.intercept(8, s)).toBe(false)
  })
})

describe("SAM", () => {
  const mount = () => {
    const pos: Vec3 = [0, 0, 0]
    const dir: Vec3 = [0, 0, 0]
    const a = restAngles(SAM)
    return { a, pos, dir }
  }

  test("locks in lockTime (quicker than the AIM-9) out to its range, and not inside its minimum range", () => {
    const { pos, dir } = mount()
    const m = WEAPON_MOUNTS[SAM]!
    muzzleWorld(SHIP, SAM, m.restYaw, 0.2, pos, dir)
    const r = GUNNERY.sam.range * 0.93
    const far = jet(100, 1, pos[0] + dir[0] * r, pos[1] + dir[1] * r, pos[2] + dir[2] * r)
    const lock = { target: -1, time: 0, locked: false }
    let t = 0
    while (!lock.locked && t < 5) {
      samLockStep(lock, DT, pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], 0, [far])
      t += DT
    }
    expect(lock.locked).toBe(true)
    expect(t).toBeCloseTo(GUNNERY.sam.lockTime, 1)
    expect(GUNNERY.sam.lockTime).toBeLessThan(1.4)
    const close = jet(101, 1, pos[0] + dir[0] * 100, pos[1] + dir[1] * 100, pos[2] + dir[2] * 100)
    const l2 = { target: -1, time: 0, locked: false }
    samLockStep(l2, DT, pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], 0, [close])
    expect(l2.target).toBe(-1)
    // Friendly jets are never picked.
    const l3 = { target: -1, time: 0, locked: false }
    samLockStep(l3, DT, pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], 0, [{ ...far, team: 0 }])
    expect(l3.target).toBe(-1)
  })

  test("8 cells, then they reload one at a time", () => {
    const st = makeTurretState(SAM)
    const cells: number[] = []
    for (let k = 0; k < 8; k++) {
      cells.push(takeSam(st))
      for (let s = 0; s < Math.ceil(GUNNERY.sam.interval / DT) + 1; s++) turretStep(st, DT)
    }
    expect(new Set(cells).size).toBe(8)
    expect(takeSam(st)).toBe(-1)
    for (let s = 0; s < Math.round((GUNNERY.sam.reloadDelay + GUNNERY.sam.reload + 0.1) / DT); s++) turretStep(st, DT)
    expect(st.cells).toBe(1)
  })

  test("an early press arms the launcher: it fires the moment the lock completes, and disarms if the track is lost", () => {
    const { pos, dir } = mount()
    const m = WEAPON_MOUNTS[SAM]!
    muzzleWorld(SHIP, SAM, m.restYaw, 0.2, pos, dir)
    const target = jet(100, 1, pos[0] + dir[0] * 2000, pos[1] + dir[1] * 2000, pos[2] + dir[2] * 2000)
    const st = makeTurretState(SAM)
    const step = (pressed: boolean, jets: Target[] = [target]) => {
      samLockStep(st.lock, DT, pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], 0, jets)
      return samTrigger(st, pressed)
    }
    // Tracking, not locked: a press arms instead of dumbfiring.
    expect(step(false)).toBe(false)
    expect(st.lock.target).toBe(100)
    expect(step(true)).toBe(false)
    expect(st.armed).toBe(true)
    let t = 2 * DT
    let fired = -1
    while (t < 3 && fired < 0) {
      if (step(false)) fired = t
      t += DT
    }
    expect(st.lock.locked).toBe(true)
    expect(fired).toBeCloseTo(GUNNERY.sam.lockTime, 1)
    expect(st.armed).toBe(false)
    // Locked: a press fires at once.
    expect(step(true)).toBe(true)
    // Armed, then the jet leaves the seeker: disarmed, and a lock on something later doesn't fire by itself.
    const s2 = makeTurretState(SAM)
    samLockStep(s2.lock, DT, pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], 0, [target])
    expect(samTrigger(s2, true)).toBe(false)
    samLockStep(s2.lock, DT, pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], 0, [])
    expect(samTrigger(s2, false)).toBe(false)
    expect(s2.armed).toBe(false)
    // Nothing in the seeker: a press is a dumbfire, at once.
    expect(samTrigger(s2, true)).toBe(true)
  })

  /** Launches a SAM at a crossing jet; returns the events and whether it hit. */
  function engage(flareAt: number | null, seq: number): { hit: boolean; decoy: boolean } {
    const combat = new CombatWorld(AIR, true)
    combat.spawn(100, 1)
    const world = new GunneryWorld({ sea: null, arch: null, ships: [SHIP] }, true)
    world.man(7, 0, SHIP.id!, SAM)
    const { a, pos, dir } = mount()
    a.pitch = 0.35
    muzzleWorld(SHIP, SAM, a.yaw, a.pitch, pos, dir, 0)
    const j = jet(100, 1, pos[0] + dir[0] * 3500, 900, pos[2] + dir[2] * 3500, 0, 0, -200)
    const e = GUNNERY.sam.eject
    expect(world.fire({ owner: 7, seq, kind: "sam", ship: SHIP.id!, mount: SAM, t: 0, x: pos[0], y: pos[1], z: pos[2], vx: dir[0] * e, vy: dir[1] * e, vz: dir[2] * e, target: 100 })).not.toBeNull()
    let t = 0
    let hit = false
    let decoy = false
    let flared = false
    for (let k = 0; k < Math.round(16 / DT) && !hit; k++) {
      t += DT
      j.x += j.vx * DT
      j.z += j.vz * DT
      const p = world.projectiles.find((p) => p.alive)
      if (flareAt !== null && !flared && p && Math.hypot(p.x - j.x, p.y - j.y, p.z - j.z) < flareAt) {
        flared = true
        combat.flare(100, t, j.x, j.y, j.z, j.vx, j.vy, j.vz)
      }
      combat.step(t, [j])
      world.step(t, { jets: [j], flares: combat.flares })
      for (const ev of world.events.splice(0)) {
        if (ev.k === "hurt" && ev.on === 100) hit = true
        if (ev.k === "decoy") decoy = true
      }
      if (!world.projectiles.some((p) => p.alive)) break
    }
    return { hit, decoy }
  }

  test("a locked SAM flies PN onto a crossing jet and bursts on it", () => {
    expect(engage(null, 1).hit).toBe(true)
  })

  test("a SAM that overshoots its target bursts there instead of flying on", () => {
    const world = new GunneryWorld({ sea: null, arch: null, ships: [SHIP] }, true)
    world.man(7, 0, SHIP.id!, SAM)
    const { a, pos, dir } = mount()
    a.pitch = 0.35
    muzzleWorld(SHIP, SAM, a.yaw, a.pitch, pos, dir, 0)
    const j = jet(100, 1, pos[0] + dir[0] * 1500, pos[1] + dir[1] * 1500, pos[2] + dir[2] * 1500)
    const e = GUNNERY.sam.eject
    world.fire({ owner: 7, seq: 1, kind: "sam", ship: SHIP.id!, mount: SAM, t: 0, x: pos[0], y: pos[1], z: pos[2], vx: dir[0] * e, vy: dir[1] * e, vz: dir[2] * e, target: 100 })
    let boom: GunneryEvent | null = null
    let at = 0
    for (let t = DT; t < 6 && !boom; t += DT) {
      // After a second the jet jinks out to the side, far past what the SAM can follow.
      if (Math.abs(t - 1) < DT / 2) {
        const p = world.projectiles[0]!
        // The starboard SAM flies out along +x: put the jet 300 m off its beam and a little behind.
        j.x = p.x - p.vx * 0.15
        j.y = p.y
        j.z = p.z + 300
      }
      world.step(t, { jets: [j] })
      boom = world.events.splice(0).find((ev) => ev.k === "gboom") ?? null
      at = t
    }
    expect(boom?.k).toBe("gboom")
    expect(boom && boom.k === "gboom" && boom.surface).toBe("air")
    expect(at).toBeLessThan(1.05)
  })

  test("a SAM catches a jet circling hard about a kilometre out", () => {
    let kills = 0
    for (let k = 0; k < 6; k++) {
      const world = new GunneryWorld({ sea: null, arch: null, ships: [SHIP] }, true)
      world.man(7, 0, SHIP.id!, SAM)
      const { pos, dir } = mount()
      // Circle centre 1.4 km off the starboard beam, radius 800 m, 230 m/s, 600 m up; start at phase k.
      const c = shipToWorld(SHIP, -1400, 600, 86)
      const w = 230 / 800
      let ph = k
      const j = jet(100, 1, 0, 600, 0)
      const place = () => {
        j.x = c[0] + Math.cos(ph) * 800
        j.z = c[2] + Math.sin(ph) * 800
        j.vx = -Math.sin(ph) * 230
        j.vz = Math.cos(ph) * 230
      }
      place()
      const lx = -(j.x - SHIP.x)
      const lz = -(j.z - SHIP.z)
      const a = { yaw: Math.atan2(lx - WEAPON_MOUNTS[SAM]!.pos[0], lz - WEAPON_MOUNTS[SAM]!.pos[2]), pitch: 0.3 }
      muzzleWorld(SHIP, SAM, a.yaw, a.pitch, pos, dir, 0)
      const d = Math.hypot(j.x - pos[0], j.y - pos[1], j.z - pos[2])
      const u: Vec3 = [(j.x - pos[0]) / d, (j.y - pos[1]) / d, (j.z - pos[2]) / d]
      const e = GUNNERY.sam.eject
      world.fire({ owner: 7, seq: k, kind: "sam", ship: SHIP.id!, mount: SAM, t: 0, x: pos[0], y: pos[1], z: pos[2], vx: u[0] * e, vy: u[1] * e, vz: u[2] * e, target: 100 })
      let hit = false
      for (let t = DT; t < 14 && !hit; t += DT) {
        ph += w * DT
        place()
        world.step(t, { jets: [j] })
        hit = world.events.splice(0).some((ev) => ev.k === "hurt")
        if (!world.projectiles.some((p) => p.alive)) break
      }
      if (hit) kills++
    }
    expect(kills).toBeGreaterThanOrEqual(5)
  })

  test("flares decoy SAMs only some of the time (fixed per missile and flare)", () => {
    let decoys = 0
    let hits = 0
    for (let seq = 0; seq < 24; seq++) {
      const r = engage(1200, seq)
      if (r.decoy) decoys++
      if (r.hit) hits++
    }
    // Some bursts fool it and some don't (AIM-9s are always seduced in the same geometry): about `decoy` of them.
    expect(decoys).toBeGreaterThan(0)
    expect(hits).toBeGreaterThan(0)
    expect(decoys / 24).toBeGreaterThan(GUNNERY.sam.decoy - 0.25)
    expect(decoys / 24).toBeLessThan(GUNNERY.sam.decoy + 0.25)
    expect(samDecoyed(7, 3, { owner: 100, t0: 1.25 })).toBe(samDecoyed(7, 3, { owner: 100, t0: 1.25 }))
  })

  test("the room refuses launches it can't account for", () => {
    const world = new GunneryWorld({ sea: null, arch: null, ships: [SHIP] }, true)
    const { a, pos, dir } = mount()
    muzzleWorld(SHIP, SAM, a.yaw, a.pitch, pos, dir, 0)
    const l = { owner: 7, seq: 1, kind: "sam" as const, ship: SHIP.id!, mount: SAM, t: 0, x: pos[0], y: pos[1], z: pos[2], vx: dir[0] * 45, vy: dir[1] * 45, vz: dir[2] * 45, target: -1 }
    expect(world.fire(l)).toBeNull()
    world.man(7, 0, SHIP.id!, SAM)
    // Wrong mount, far from the mount, too fast, a shell from a SAM launcher.
    expect(world.fire({ ...l, mount: GUN })).toBeNull()
    expect(world.fire({ ...l, x: l.x + 500 })).toBeNull()
    expect(world.fire({ ...l, vx: 2000 })).toBeNull()
    expect(world.fire({ ...l, kind: "shell" })).toBeNull()
    for (let k = 0; k < 8; k++) expect(world.fire({ ...l, seq: 10 + k })).not.toBeNull()
    expect(world.fire({ ...l, seq: 30 })).toBeNull()
  })
})

describe("SAM warning", () => {
  test("a SAM homing on a jet stays inbound only while that jet is among the world's targets (the pilot's MISSILE warning)", () => {
    for (const listed of [true, false]) {
      const world = new GunneryWorld({ sea: null, arch: null, ships: [SHIP] }, false)
      const pos: Vec3 = [0, 0, 0]
      const dir: Vec3 = [0, 0, 0]
      muzzleWorld(SHIP, SAM, WEAPON_MOUNTS[SAM]!.restYaw, 0.35, pos, dir, 0)
      const j = jet(100, 1, pos[0] + dir[0] * 3000, 900, pos[2] + dir[2] * 3000)
      const e = GUNNERY.sam.eject
      world.fire({ owner: 7, seq: 1, kind: "sam", ship: SHIP.id!, mount: SAM, t: 0, x: pos[0], y: pos[1], z: pos[2], vx: dir[0] * e, vy: dir[1] * e, vz: dir[2] * e, target: 100 }, 0)
      for (let t = DT; t < 1; t += DT) world.step(t, { jets: listed ? [j] : [] })
      if (listed) expect(world.inbound(100, j.x, j.y, j.z)).toBeLessThan(3500)
      else expect(world.inbound(100, j.x, j.y, j.z)).toBe(Infinity)
    }
  })
})

describe("5-inch gun", () => {
  test("shells fly ~800 m/s under drag and gravity, out to ~6 km flat", () => {
    const p = { x: 0, y: 30, z: 0, vx: 0, vy: 0, vz: -GUNNERY.gun.muzzle }
    let t = 0
    while (t < GUNNERY.gun.life) {
      shellStep(p, DT)
      t += DT
    }
    expect(-p.z).toBeGreaterThan(5500)
    expect(-p.z).toBeLessThan(7000)
    expect(p.y).toBeLessThan(-200)
  })

  test("the predicted impact is where the world's shell lands", () => {
    const sea = null
    const world = new GunneryWorld({ sea, arch: null, ships: [SHIP] }, true)
    world.man(7, 0, SHIP.id!, GUN)
    const pos: Vec3 = [0, 0, 0]
    const dir: Vec3 = [0, 0, 0]
    muzzleWorld(SHIP, GUN, -0.3, 0.02, pos, dir)
    const v: Vec3 = [dir[0] * GUNNERY.gun.muzzle, dir[1] * GUNNERY.gun.muzzle, dir[2] * GUNNERY.gun.muzzle]
    const pred = predictImpact(pos[0], pos[1], pos[2], v[0], v[1], v[2], 0, { sea, arch: null })
    expect(pred.kind).toBe("sea")
    world.fire({ owner: 7, seq: 1, kind: "shell", ship: 1, mount: GUN, t: 0, x: pos[0], y: pos[1], z: pos[2], vx: v[0], vy: v[1], vz: v[2], target: -1 })
    let boom: GunneryEvent | undefined
    for (let t = DT; t < 15 && !boom; t += DT) {
      world.step(t, { jets: [] })
      boom = world.events.find((e) => e.k === "gboom")
    }
    expect(boom?.k).toBe("gboom")
    if (boom?.k !== "gboom") return
    expect(boom.surface).toBe("sea")
    expect(Math.hypot(boom.x - pred.x, boom.z - pred.z)).toBeLessThan(1)
  })

  test("a shell on an enemy carrier is a ship hit; a near miss in the water is a smaller one", () => {
    const world = new GunneryWorld({ sea: null, arch: null, ships: [SHIP, ENEMY] }, true)
    world.man(7, 0, SHIP.id!, GUN)
    const st = makeTurretState(GUN)
    expect(takeShell(st)).toBe(true)
    expect(takeShell(st)).toBe(false)
    // Dropped from just above the enemy's deck and just beside its waterline.
    const deck = shipToWorld(ENEMY, 0, 40, 20)
    const beside = shipToWorld(ENEMY, 0, 30, -173)
    world.fire({ owner: 7, seq: 1, kind: "shell", ship: 1, mount: GUN, t: 0, x: deck[0], y: deck[1], z: deck[2], vx: 0, vy: -300, vz: 0, target: -1 })
    world.gunners.get(7)!.shells = 1
    world.fire({ owner: 7, seq: 2, kind: "shell", ship: 1, mount: GUN, t: 0, x: beside[0], y: beside[1], z: beside[2], vx: 0, vy: -300, vz: 0, target: -1 })
    // Fired far from the mount: the authority refuses; run these two without it.
    expect(world.projectiles.filter((p) => p.alive).length).toBe(0)
    world.authority = false
    world.fire({ owner: 7, seq: 1, kind: "shell", ship: 1, mount: GUN, t: 0, x: deck[0], y: deck[1], z: deck[2], vx: 0, vy: -300, vz: 0, target: -1 }, 0)
    world.fire({ owner: 7, seq: 2, kind: "shell", ship: 1, mount: GUN, t: 0, x: beside[0], y: beside[1], z: beside[2], vx: 0, vy: -300, vz: 0, target: -1 }, 0)
    for (let t = DT; t < 2; t += DT) world.step(t, { jets: [] })
    const ships = world.events.filter((e) => e.k === "ship")
    expect(ships.some((e) => e.k === "ship" && e.ship === 2 && e.near === 0)).toBe(true)
    expect(ships.some((e) => e.k === "ship" && e.ship === 2 && e.near > 0 && e.near <= GUNNERY.gun.near)).toBe(true)
    // In fleet terms: a direct hit is a scaled missile, a near miss a scaled bomb near miss, CIWS rounds gun rounds.
    expect(shipHitOf("shell", 0)).toEqual({ w: "shell", near: 0, n: 1, amount: GUNNERY.gun.shipDamage })
    const near = shipHitOf("shell", 7)
    expect(near.near).toBe(7)
    expect(near.amount!).toBeLessThan(GUNNERY.gun.nearMax)
    expect(near.amount!).toBeGreaterThan(GUNNERY.gun.nearMin)
    // Through the fleet: a direct shell is GUNNERY.gun.shipDamage, too light to start a fire or close the deck (fleet's
    // 20 hp shell threshold); a near miss is less.
    const fleet = new Fleet()
    fleet.add(2, 1)
    const d = shipHitOf("shell", 0)
    expect(fleet.hit({ ship: 2, by: 7, team: 0, w: d.w, x: 0, y: 26, z: 20, near: d.near, n: d.n, amount: d.amount }, 1)).toBe(GUNNERY.gun.shipDamage)
    expect(fleet.hulls.get(2)!.fires).toHaveLength(0)
    expect(fleet.hit({ ship: 2, by: 7, team: 0, w: near.w, x: 0, y: 0, z: -173, near: near.near, n: near.n, amount: near.amount }, 2)).toBeCloseTo(near.amount!, 6)
    expect(fleet.hulls.get(2)!.fires).toHaveLength(0)
    // Friendly fire is off.
    expect(fleet.hit({ ship: 2, by: 7, team: 1, w: d.w, x: 0, y: 26, z: 20, near: 0, amount: d.amount }, 3)).toBe(0)
  })

  test("a proximity burst near an enemy jet hurts it; friendly fire is off", () => {
    for (const team of [1, 0]) {
      const world = new GunneryWorld(AIR, false)
      world.fire({ owner: 7, seq: 1, kind: "shell", ship: 1, mount: GUN, t: 0, x: 0, y: 1000, z: 0, vx: 0, vy: 0, vz: -800, target: -1 }, 0)
      world.authority = true
      // Beside the shell's path where it has dropped ~11 m under gravity: inside the fuse.
      const j = jet(100, team, 4, 989, -1200)
      const hurt: GunneryEvent[] = []
      for (let t = DT; t < 3; t += DT) {
        world.step(t, { jets: [j] })
        hurt.push(...world.events.splice(0).filter((e) => e.k === "hurt"))
      }
      if (team === 1) expect(hurt.length).toBe(1)
      else expect(hurt.length).toBe(0)
    }
  })

  test("lead point meets a crossing target", () => {
    const out: Vec3 = [0, 0, 0]
    const t = leadPoint(0, 0, 0, 0, 0, 0, 1000, 1000, 0, 0, 0, 0, 200, 0, out)
    // The round reaches the lead point at the same time as the target.
    expect(Math.hypot(out[0], out[1], out[2]) / 1000).toBeCloseTo(t, 6)
    expect(out[2]).toBeCloseTo(200 * t, 6)
  })
})

describe("wire", () => {
  test("turret, aim, fire, burst and intercept tuples round-trip and validate", () => {
    const tt = packTurret(3, { id: 9, mount: 2, yaw: 1.2345, pitch: -0.2, firing: true })
    expect(isTurretTuple(tt)).toBe(true)
    expect(tt).toEqual([3, 2, 1235, -200, 1, 9])
    expect(isTurretTuple([3, 9, 0, 0, 1, 9])).toBe(false)
    const a = packAim(-2.5, 1.1, false)
    expect(isAimTuple(a)).toBe(true)
    expect(isAimTuple([1.5, 0, 0])).toBe(false)
    const l = { owner: 4, seq: 7, kind: "shell" as const, ship: 2, mount: 0, t: 12.3456, x: 1.234, y: 2, z: 3, vx: 4, vy: 5, vz: 6, target: -1 }
    const f = packGunFire(l)
    expect(isGunFireTuple(f)).toBe(true)
    expect(unpackGunFire(4, f)).toEqual({ ...l, t: 12.346, x: 1.23 })
    expect(isGunFireTuple([...f.slice(0, 3), 9, ...f.slice(4)])).toBe(false)
    const b = packGunBoom({ k: "gboom", owner: 4, seq: 7, kind: "sam", x: 1, y: 2, z: 3, on: 100, surface: "ship" })
    expect(isGunBoomTuple(b)).toBe(true)
    expect(unpackGunBoom(b)).toEqual({ k: "gboom", owner: 4, seq: 7, kind: "sam", x: 1, y: 2, z: 3, on: 100, surface: "ship" })
    expect(isInterceptTuple([4, 7, 1])).toBe(true)
    expect(isInterceptTuple([4, 7, 2])).toBe(false)
    expect(JSON.stringify(tt).length).toBeLessThan(30)
  })

  test("the bore is unit length and points along restYaw", () => {
    const b = boreLocal(0.5, 0.2)
    expect(Math.hypot(...b)).toBeCloseTo(1, 9)
    expect(Math.atan2(b[0], b[2])).toBeCloseTo(0.5, 9)
  })
})

describe("the room", () => {
  class Conn {
    sent: ServerMsg[] = []
    send(data: string) {
      const m = decodeServer(data)
      if (!m) throw new Error(`bad frame ${data}`)
      this.sent.push(m)
    }
    close() {}
    all<T extends ServerMsg["type"]>(type: T): Extract<ServerMsg, { type: T }>[] {
      return this.sent.filter((m): m is Extract<ServerMsg, { type: T }> => m.type === type)
    }
    last<T extends ServerMsg["type"]>(type: T): Extract<ServerMsg, { type: T }> | undefined {
      return this.all(type).at(-1)
    }
    get id(): number {
      return this.last("welcome")!.id
    }
  }
  const EPOCH = 1_000_000
  function room() {
    let now = EPOCH
    const core = new RoomCore(
      () => now,
      () => 42,
    )
    const join = (name: string) => {
      const c = new Conn()
      core.message(c, encode({ type: "hello", build: BUILD, name }))
      return c
    }
    const say = (c: Conn, msg: ClientMsg) => core.message(c, encode(msg))
    const run = (ms: number, each?: () => void) => {
      for (let left = ms; left > 0; left -= 50) {
        now += Math.min(50, left)
        each?.()
        core.step(now)
      }
    }
    const seaT = () => (now - EPOCH) / 1000
    return { core, join, say, run, seaT }
  }

  test("a gunner mans the CIWS, everyone sees the turret, and its hits shoot down an enemy jet (credit, feed, stats)", () => {
    const { core, join, say, run, seaT } = room()
    const a = join("ada") // team 0, ship 1's helm
    const b = join("bo") // team 1
    say(a, { type: "op", op: "ciws-port" })
    expect(playerOf(core.crew!, a.id)).toMatchObject({ role: "gunner", mount: CIWS })
    expect(core.crew!.ships.find((s) => s.id === 1)!.helm).toBeNull()
    say(a, { type: "aim", a: packAim(0.9, 0.3, false) })
    run(200)
    const t = b.last("turrets")!.t
    expect(t).toEqual([[1, CIWS, 900, 300, 0, a.id]])
    // B flies a Hornet 700 m off A's port bow.
    say(b, { type: "op", op: "hornet" })
    const ship = core.hullPoseList.find((s) => s.id === 1)!
    const at = shipToWorld(ship, 500, 300, 600)
    const fly = () => say(b, { type: "plane", p: [seaT(), 1, at[0], at[1], at[2], 0, 1, 0, 0, 0, 0, -1, 0.77, 0, 0, 0, 0] })
    fly()
    run(100, fly)
    // A fires at it: the aim reports the trigger, the hits go in batches.
    say(a, { type: "aim", a: packAim(0.7, 0.4, true) })
    for (let k = 0; k < 20 && core.hp(b.id) > 0; k++) {
      say(a, { type: "thits", on: b.id, n: 8 })
      run(100, fly)
    }
    expect(core.hp(b.id)).toBe(0)
    expect(b.last("kill")).toEqual({ type: "kill", on: b.id, by: a.id, w: "ciws" })
    expect(a.last("stats")!.s.find((s) => s[0] === a.id)).toEqual([a.id, 1, 0])
    // Leaving the gun (taking the helm) unmans it: the turrets frame empties.
    say(a, { type: "op", op: "helm" })
    run(300)
    expect(b.last("turrets")!.t).toEqual([])
  })

  test("friendly fire is off; a non-gunner's claims are ignored", () => {
    const { core, join, say, run, seaT } = room()
    const a = join("ada")
    join("bo")
    const c = join("cy")
    say(c, { type: "board", ship: 1 }) // ada's carrier: a friend
    say(a, { type: "op", op: "ciws-port" })
    say(c, { type: "op", op: "hornet" })
    run(100)
    const ship = core.hullPoseList.find((s) => s.id === 1)!
    const at = shipToWorld(ship, 500, 300, 600)
    const fly = () => say(c, { type: "plane", p: [seaT(), 1, at[0], at[1], at[2], 0, 1, 0, 0, 0, 0, -1, 0.77, 0, 0, 0, 0] })
    run(100, fly)
    say(a, { type: "aim", a: packAim(0.7, 0.4, true) })
    say(a, { type: "thits", on: c.id, n: 50 })
    run(100, fly)
    expect(core.hp(c.id)).toBe(100)
  })

  test("every other carrier is an enemy: a third carrier's jet takes the CIWS hits", () => {
    const { core, join, say, run, seaT } = room()
    const a = join("ada")
    join("bo")
    const c = join("cy") // a third carrier
    expect(playerOf(core.crew!, c.id)!.team).toBe(2)
    say(a, { type: "op", op: "ciws-port" })
    say(c, { type: "op", op: "hornet" })
    run(100)
    const ship = core.hullPoseList.find((s) => s.id === 1)!
    const at = shipToWorld(ship, 500, 300, 600)
    const fly = () => say(c, { type: "plane", p: [seaT(), 1, at[0], at[1], at[2], 0, 1, 0, 0, 0, 0, -1, 0.77, 0, 0, 0, 0] })
    run(100, fly)
    say(a, { type: "aim", a: packAim(0.7, 0.4, true) })
    say(a, { type: "thits", on: c.id, n: 50 })
    run(100, fly)
    expect(core.hp(c.id)).toBeLessThan(100)
  })

  test("a 5-inch shell is relayed to everyone and bursts for everyone", () => {
    const { core, join, say, run, seaT } = room()
    const a = join("ada")
    const b = join("bo")
    say(a, { type: "op", op: "gun-5in" })
    run(100)
    const ship = core.hullPoseList.find((s) => s.id === 1)!
    const m = WEAPON_MOUNTS[GUN]!
    const pos: Vec3 = [0, 0, 0]
    const dir: Vec3 = [0, 0, 0]
    muzzleWorld(ship, GUN, m.restYaw, 0.02, pos, dir)
    const v = GUNNERY.gun.muzzle
    say(a, { type: "gfire", g: packGunFire({ owner: a.id, seq: 0, kind: "shell", ship: 1, mount: GUN, t: seaT(), x: pos[0], y: pos[1], z: pos[2], vx: dir[0] * v, vy: dir[1] * v, vz: dir[2] * v, target: -1 }) })
    expect(b.last("gfire")!.id).toBe(a.id)
    // A second shot inside the interval is refused (not relayed).
    say(a, { type: "gfire", g: packGunFire({ owner: a.id, seq: 1, kind: "shell", ship: 1, mount: GUN, t: seaT(), x: pos[0], y: pos[1], z: pos[2], vx: dir[0] * v, vy: dir[1] * v, vz: dir[2] * v, target: -1 }) })
    expect(b.all("gfire")).toHaveLength(1)
    run(12_000)
    const boom = b.last("gboom")!
    expect(boom.b[0]).toBe(a.id)
    expect([1, 2]).toContain(boom.b[7]) // on the sea or an island
  })

  test("protocol: the gunnery messages decode on both ends, junk is refused", () => {
    expect(decodeClient(encode({ type: "aim", a: [100, -50, 1] }))).toEqual({ type: "aim", a: [100, -50, 1] })
    expect(decodeClient('{"type":"aim","a":[1.5,0,1]}')).toBeNull()
    expect(decodeClient(encode({ type: "intercept", i: [3, 4, 0] }))).toEqual({ type: "intercept", i: [3, 4, 0] })
    expect(decodeClient(encode({ type: "thits", on: 3, n: 12 }))).toEqual({ type: "thits", on: 3, n: 12 })
    expect(decodeClient('{"type":"thits","on":3,"n":0}')).toBeNull()
    expect(decodeClient(encode({ type: "op", op: "sam-stbd" }))).toEqual({ type: "op", op: "sam-stbd" })
    expect(decodeServer(encode({ type: "turrets", t: [[1, 2, 900, 300, 1, 4]] }))).toEqual({ type: "turrets", t: [[1, 2, 900, 300, 1, 4]] })
    expect(decodeServer(encode({ type: "kill", on: 1, by: 2, w: "sam" }))).toEqual({ type: "kill", on: 1, by: 2, w: "sam" })
    expect(decodeServer('{"type":"gboom","b":[1,2,3]}')).toBeNull()
  })
})

describe("kill moment under reduced motion", () => {
  test("the punch-in and the hit-stop stand still when reduced motion is on, for the sight and the pilot", () => {
    const was = SHAKE.reduceMotion
    try {
      const mid = FEEDBACK.punchTime * 0.25
      SHAKE.reduceMotion = false
      const cam = new TurretCam()
      expect(cam.shake.reduced).toBe(false)
      expect(punchScale(mid, cam.shake.reduced)).toBeLessThan(1)
      const on = new HitStop()
      on.trigger(0.1, 0.05, !cam.shake.reduced)
      expect(on.step(1 / 60)).toBeLessThan(1 / 60)

      SHAKE.reduceMotion = true
      expect(cam.shake.reduced).toBe(true)
      expect(punchScale(mid, cam.shake.reduced)).toBe(1)
      const off = new HitStop()
      off.trigger(0.1, 0.05, !cam.shake.reduced)
      expect(off.step(1 / 60)).toBe(1 / 60)
    } finally {
      SHAKE.reduceMotion = was
    }
  })

  test("the punch-in is 1 at rest and after it ends", () => {
    expect(punchScale(-1, false)).toBe(1)
    expect(punchScale(FEEDBACK.punchTime, false)).toBe(1)
    expect(punchScale(FEEDBACK.punchTime * 0.2, false)).toBeCloseTo(1 - FEEDBACK.punchZoom, 6)
  })
})
