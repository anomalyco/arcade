// A scripted SAM gunner against scripted jets, on the real shared/gunnery.ts seeker and GunneryWorld (no browser):
// how long the lock takes for a human-like aim, how often a launch connects, how long the missile flies and why it
// misses. The gunner tracks the jet's direction with a reaction delay, a lag and a hand tremor; the turret slews at its
// own rates and the seeker looks along the launcher. Deterministic per seed.
//
//   bun scripts/sam-playtest.ts                     (every scenario, 40 runs each)
//   bun scripts/sam-playtest.ts --runs=100 --set lockTime=1.2 --set cone=0.18
//   bun scripts/sam-playtest.ts --json
//   bun scripts/sam-playtest.ts --no-arm            (an early press launches at once, unguided: the old trigger)

import { WEAPON_MOUNTS } from "../shared/carrier-spec"
import { CombatWorld, type GroundShip } from "../shared/combat"
import { GUNNERY, GunneryWorld, anglesOf, clampAim, makeTurretState, muzzleWorld, samLockStep, samTrigger, slewTurret, takeSam, toLocalDir, turretStep } from "../shared/gunnery"
import { PLANE, type Vec3 } from "../shared/plane"
import type { Target } from "../shared/weapons"

const DT = PLANE.tick
const G = 9.81
const SHIP: GroundShip = { x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, id: 1, team: 0 }
const SAM = WEAPON_MOUNTS.findIndex((m) => m.kind === "sam" && m.side === "starboard")

type Scenario = {
  name: string
  /** The jet's start (world) and velocity, relative to the starboard SAM, which faces +x. */
  start(rng: () => number): { p: Vec3; v: Vec3 }
  /** Turn command (rad/s about world up) and climb (m/s²) at time t; `inbound` a SAM is homing within 2 km. */
  steer(t: number, inbound: boolean, j: Target, rng: () => number): { yaw: number; climb: number; flare: boolean }
  /** Most flare bursts the pilot fires (0.9 s apart while it wants to). */
  bursts?: number
}

const straight = () => ({ yaw: 0, climb: 0, flare: false })
const maxTurn = (speed: number, g: number) => (g * G) / speed

const SCENARIOS: Scenario[] = [
  {
    name: "crossing 2 km",
    start: (r) => ({ p: [-2000 - r() * 400, 400 + r() * 400, -2500], v: [0, 0, 175] }),
    steer: straight,
  },
  {
    name: "crossing 3.5 km",
    start: (r) => ({ p: [-3400 - r() * 300, 600 + r() * 600, -2500], v: [0, 0, 180] }),
    steer: straight,
  },
  {
    name: "crossing 0.9 km",
    start: (r) => ({ p: [-800 - r() * 200, 400 + r() * 300, -500], v: [0, 0, 175] }),
    steer: straight,
  },
  {
    name: "attack run",
    start: (r) => ({ p: [-4500, 250 + r() * 150, (r() - 0.5) * 600], v: [170, 0, 0] }),
    steer: straight,
  },
  {
    name: "orbit 1.5 km weaving",
    start: (r) => ({ p: [-1500, 500 + r() * 300, 0], v: [0, 0, 160] }),
    steer: (t, _i, j) => {
      const s = Math.hypot(j.vx, j.vz)
      // Hold the circle and weave on it at ±4 g.
      return { yaw: s / 1500 + Math.sin(t * 0.9) * maxTurn(s, 4), climb: Math.sin(t * 0.5) * 6, flare: false }
    },
  },
  {
    name: "crossing, breaks 7 g",
    start: (r) => ({ p: [-2400 - r() * 600, 500 + r() * 400, -2500], v: [0, 0, 175] }),
    steer: (_t, inbound, j) => (inbound ? { yaw: maxTurn(Math.hypot(j.vx, j.vz), 7), climb: -8, flare: false } : straight()),
  },
  {
    name: "crossing, one flare burst",
    start: (r) => ({ p: [-2400 - r() * 600, 500 + r() * 400, -2500], v: [0, 0, 175] }),
    steer: (_t, inbound) => ({ yaw: 0, climb: 0, flare: inbound }),
    bursts: 1,
  },
  {
    name: "crossing, breaks + flares",
    start: (r) => ({ p: [-2400 - r() * 600, 500 + r() * 400, -2500], v: [0, 0, 175] }),
    steer: (_t, inbound, j) => {
      if (!inbound) return straight()
      const s = Math.hypot(j.vx, j.vz)
      return { yaw: maxTurn(s, 7), climb: -8, flare: true }
    },
  },
]

type Gunner = { name: string; react: number; lag: number; tremor: number; patient: boolean }
const GUNNERS: Gunner[] = [
  { name: "steady", react: 0.2, lag: 0.25, tremor: 0.8, patient: true },
  { name: "shaky", react: 0.3, lag: 0.4, tremor: 2.5, patient: true },
  { name: "impatient", react: 0.2, lag: 0.25, tremor: 1.2, patient: false },
]

type Run = { locked: boolean; lockAt: number; launched: boolean; homing: boolean; hit: boolean; kill: boolean; tof: number; miss: string; firstSeen: number }

function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DEG = Math.PI / 180

function play(sc: Scenario, gu: Gunner, seed: number): Run {
  const rng = mulberry(seed * 977 + 13)
  const world = new GunneryWorld({ sea: null, arch: null, ships: [SHIP] }, true)
  const combat = new CombatWorld({ sea: null, arch: null }, true)
  combat.spawn(100, 1)
  world.man(7, 0, SHIP.id!, SAM)
  const st = makeTurretState(SAM)
  const m = WEAPON_MOUNTS[SAM]!
  const turret = { yaw: m.restYaw, pitch: m.restPitch }
  const s0 = sc.start(rng)
  // The starboard SAM faces +x in this frame? It faces the ship's starboard: world +x for heading 0 (bow −z).
  const j: Target & { hp: number } = { id: 100, team: 1, x: s0.p[0], y: s0.p[1], z: s0.p[2], vx: s0.v[0], vy: s0.v[1], vz: s0.v[2], alive: true, hp: 100 }
  // Mirror scenarios to the starboard side (−x is port for heading 0: right of a ship facing −z is +x).
  j.x = -j.x
  j.vx = -j.vx
  const hist: { t: number; x: number; y: number; z: number }[] = []
  const aim = { yaw: turret.yaw, pitch: turret.pitch }
  const ph = [rng() * 9, rng() * 9, rng() * 9, rng() * 9]
  const pos: Vec3 = [0, 0, 0]
  const dir: Vec3 = [0, 0, 0]
  const lv: Vec3 = [0, 0, 0]
  const run: Run = { locked: false, lockAt: -1, launched: false, homing: false, hit: false, kill: false, tof: -1, miss: "no launch", firstSeen: -1 }
  let launchT = -1
  let heldOn = 0
  let flareIn = 0
  let bursts = sc.bursts ?? 99
  let wasFire = false
  for (let t = DT; t < 30; t += DT) {
    // The jet.
    const inbound = world.inbound(j.id, j.x, j.y, j.z) < 2000
    const c = sc.steer(t, inbound, j, rng)
    const sp = Math.hypot(j.vx, j.vz)
    const yawRate = Math.max(-maxTurn(sp, 7.5), Math.min(maxTurn(sp, 7.5), c.yaw))
    const ca = Math.cos(yawRate * DT)
    const sa = Math.sin(yawRate * DT)
    const vx = j.vx * ca - j.vz * sa
    const vz = j.vx * sa + j.vz * ca
    j.vx = vx
    j.vz = vz
    j.vy = Math.max(-40, Math.min(40, j.vy + c.climb * DT))
    if (j.y < 120) j.vy = Math.max(j.vy, 5)
    j.x += j.vx * DT
    j.y += j.vy * DT
    j.z += j.vz * DT
    if (c.flare && bursts > 0 && (flareIn -= DT) <= 0) {
      flareIn = 0.9
      bursts--
      combat.flare(j.id, t, j.x, j.y, j.z, j.vx, j.vy, j.vz)
    }
    combat.step(t, [j])
    hist.push({ t, x: j.x, y: j.y, z: j.z })
    while (hist.length > 2 && hist[1]!.t <= t - gu.react) hist.shift()
    const seen = hist[0]!
    // The gunner: aims at where the jet was `react` s ago, with a lag and a tremor (degrees).
    muzzleWorld(SHIP, SAM, turret.yaw, turret.pitch, pos, dir)
    toLocalDir(SHIP, seen.x - pos[0], seen.y - pos[1], seen.z - pos[2], lv)
    const want = anglesOf(lv[0], lv[1], lv[2], { yaw: 0, pitch: 0 })
    const tr = gu.tremor * DEG
    want.yaw += tr * (Math.sin(t * 2.3 + ph[0]!) * 0.6 + Math.sin(t * 5.1 + ph[1]!) * 0.4)
    want.pitch += tr * (Math.sin(t * 1.9 + ph[2]!) * 0.6 + Math.sin(t * 4.3 + ph[3]!) * 0.4)
    const k = 1 - Math.exp(-DT / gu.lag)
    let dy = want.yaw - aim.yaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    aim.yaw += dy * k
    aim.pitch += (want.pitch - aim.pitch) * k
    const cl = clampAim(m, aim.yaw, aim.pitch, { yaw: 0, pitch: 0 })
    slewTurret(turret, SAM, cl.yaw, cl.pitch, DT)
    turretStep(st, DT)
    muzzleWorld(SHIP, SAM, turret.yaw, turret.pitch, pos, dir)
    if (!run.launched) {
      samLockStep(st.lock, DT, pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], 0, [j], (id) => combat.blind(id))
      if (st.lock.target >= 0 && run.firstSeen < 0) run.firstSeen = t
      if (st.lock.locked && !run.locked) {
        run.locked = true
        run.lockAt = t - run.firstSeen
      }
      heldOn = st.lock.target >= 0 ? heldOn + DT : 0
      // One click: the patient gunner waits for the lock tone, the impatient one clicks 0.3 s after the box appears.
      const press = !wasFire && (gu.patient ? st.lock.locked : heldOn > 0.3)
      if (press) wasFire = true
      if (noArm ? press : samTrigger(st, press)) {
        const cell = takeSam(st)
        if (cell >= 0) {
          muzzleWorld(SHIP, SAM, turret.yaw, turret.pitch, pos, dir, cell)
          const e = GUNNERY.sam.eject
          const l = { owner: 7, seq: 1, kind: "sam" as const, ship: SHIP.id!, mount: SAM, t, x: pos[0], y: pos[1], z: pos[2], vx: dir[0] * e, vy: dir[1] * e, vz: dir[2] * e, target: st.lock.locked ? st.lock.target : -1 }
          if (world.fire(l)) {
            run.launched = true
            run.homing = l.target >= 0
            launchT = t
            run.miss = "in flight"
          }
        }
      }
      if (t > 22) break
    }
    world.step(t, { jets: [j], flares: combat.flares })
    for (const e of world.events.splice(0)) {
      if (e.k === "hurt" && e.on === j.id) {
        run.hit = true
        j.hp -= e.dmg
        run.kill = j.hp <= 0
      }
      if (e.k === "decoy") run.miss = "flared"
      if (e.k === "gboom") {
        run.tof = t - launchT
        if (!run.hit && run.miss === "in flight") {
          const p = world.find(e.owner, e.seq)
          run.miss = e.surface !== "air" ? `hit ${e.surface}` : p && p.age >= GUNNERY.sam.life - 0.05 ? "timed out" : "fuse miss"
        }
      }
    }
    if (run.launched && !world.projectiles.some((p) => p.alive)) break
  }
  if (run.hit) run.miss = ""
  return run
}

const args = process.argv.slice(2)
const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? 40)
const json = args.includes("--json")
const noArm = args.includes("--no-arm")
const sam = GUNNERY.sam as unknown as Record<string, number>
for (let i = 0; i < args.length; i++) {
  const a = args[i]!
  const v = a === "--set" ? args[++i]! : a.startsWith("--set=") ? a.slice(6) : null
  if (!v) continue
  const [k, n] = v.split("=")
  if (!(k! in sam)) throw new Error(`no GUNNERY.sam.${k}`)
  sam[k!] = Number(n)
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–")
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const out: Record<string, unknown>[] = []
for (const gu of GUNNERS) {
  if (!json) console.log(`\n== gunner: ${gu.name} (react ${gu.react} s, lag ${gu.lag} s, tremor ${gu.tremor}°, ${gu.patient ? "fires on lock" : "clicks 0.3 s after the box appears"}) ==`)
  for (const sc of SCENARIOS) {
    const rs = Array.from({ length: runs }, (_, i) => play(sc, gu, i + 1))
    const locked = rs.filter((r) => r.locked)
    const launched = rs.filter((r) => r.launched)
    const hits = rs.filter((r) => r.hit)
    const misses = new Map<string, number>()
    for (const r of rs) if (!r.hit) misses.set(r.miss, (misses.get(r.miss) ?? 0) + 1)
    const row = {
      gunner: gu.name,
      scenario: sc.name,
      lock: locked.length / runs,
      lockTime: avg(locked.map((r) => r.lockAt)),
      launched: launched.length / runs,
      homing: launched.filter((r) => r.homing).length / Math.max(1, launched.length),
      hit: hits.length / runs,
      hitPerLaunch: hits.length / Math.max(1, launched.length),
      kill: rs.filter((r) => r.kill).length / runs,
      tof: avg(rs.filter((r) => r.tof > 0).map((r) => r.tof)),
      misses: Object.fromEntries(misses),
    }
    out.push(row)
    if (!json)
      console.log(
        `${sc.name.padEnd(27)} lock ${pct(locked.length, runs).padStart(4)} in ${row.lockTime.toFixed(2)} s · launched ${pct(launched.length, runs).padStart(4)} (homing ${pct(launched.filter((r) => r.homing).length, launched.length)}) · hit ${pct(hits.length, runs).padStart(4)} (${pct(hits.length, launched.length)} of launches) · tof ${row.tof.toFixed(1)} s · misses ${[...misses].map(([k, n]) => `${k} ${n}`).join(", ")}`,
      )
  }
}
if (json) console.log(JSON.stringify(out, null, 1))
