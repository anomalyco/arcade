// Ship gunnery: the carrier's CIWS, SAM launchers and 5-inch gun, crewed from DEPLOY. Pure and DOM-free,
// fixed timestep (PLANE.tick), deterministic for the same inputs. Tuning in `GUNNERY`; mounts in shared/carrier-spec.ts
// `WEAPON_MOUNTS` (yaw/pitch arcs); the meshes in src/render/ship-weapons.ts (`TURRET_GEOMETRY` mirrors their pivots).
//
// Who decides what (the same split as shared/combat.ts):
// - Turret aim: the gunner's client slews its turret (`slewTurret`, per-weapon rates, clamped to the mount's arcs) and
//   tells the room its yaw, pitch and trigger about 10 times a second; everyone draws the turret from that.
// - CIWS rounds (`TurretRounds`) are shooter-authoritative like the jets' cannon: the gunner's client flies its own
//   rounds against the jets, stores and shells as it draws them and reports hits on jets, hits on ships and
//   intercepts (a round passing within `interceptRadius` of a missile, bomb, SAM or shell). The room checks each claim
//   (`GunneryWorld.ciwsHits`, `intercept`): a manned CIWS firing, a round budget refilled at the gun's rate, the target
//   alive, an enemy, within range of the mount and near the gunner's aim. Others draw the rounds from the trigger.
// - SAMs and shells are events (`GunLaunch`: mount, pose, velocity, target, sea time), like the jets' missiles: the room
//   runs the authoritative `GunneryWorld` (PN-guided SAMs decoyed by flares at a lower rate than AIM-9s; ballistic
//   shells with drag, proximity bursts near jets and impacts on the sea, land and ships) and sends the bursts; clients
//   run the same world without authority to draw them and snap to the room's bursts.
// - Damage goes out as events for the host: `hurt` on a jet (applied to shared/combat.ts health, kill credit to the
//   gunner) and `ship` on a carrier (shared/fleet.ts, via `shipHitOf`). Friendly fire is off (`canHurt`).
//
// Frames: world as shared/plane.ts (x east, y up, z south); ship-local as carrier-spec (+Z bow, +X port). Turret aim
// is ship-local: yaw as `restYaw` (the bore along (sin yaw, 0, cos yaw)), pitch up from the deck plane.

import { WEAPON_MOUNTS, type WeaponKind as MountKind, type WeaponMount } from "./carrier-spec"
import { type Ground, type GroundShip, type ImpactKind, type LiveFlare, type Missile, flareAt, groundHit, shipAt, sweep } from "./combat"
import { type ShipDamageKind, waterlineDistance } from "./fleet"
import { PLANE, type Quat, type ShipPoseLike, type Vec3, quatRotate, shipQuat, worldToShip } from "./plane"
import { seaHeight } from "./sea"
import { type Lock, type Target, canHurt, hash01 } from "./weapons"

export type { MountKind }

const G = 9.81
const DEG = Math.PI / 180
const TAU = Math.PI * 2
const MAX_PEAK = 640

/** What the gunnery weapons are called in kill feeds and on the wire. */
export type GunWeapon = "ciws" | "sam" | "shell"
export const GUN_WEAPONS: readonly GunWeapon[] = ["ciws", "sam", "shell"]

/** Every tunable in one place. SI units unless noted. */
export const GUNNERY = {
  ciws: {
    /** Slew rates (rad/s): a Phalanx trains ~115°/s. */
    yawRate: 2.3,
    pitchRate: 1.8,
    /** Rounds per second (an arcade Phalanx: 4,500 rpm), muzzle speed (m/s, plus the ship's), life (s: ≈ 1.6 km). */
    rate: 75,
    muzzle: 1100,
    life: 1.45,
    gravity: 1,
    spread: 0.35 * DEG,
    /** Every Nth round is a tracer. */
    tracer: 2,
    /** Damage per round on a jet (100 health), and the hit sphere round a jet (m). */
    damage: 1.6,
    hitRadius: 5,
    /** A round passing this close to a missile, bomb, SAM or shell destroys it (m): small, a CIWS has to be on it. */
    interceptRadius: 3,
    /** Seconds of fire from cold to overheated, cooling (heat/s), the delay before it cools, the restart heat. */
    heatTime: 2.6,
    cool: 0.4,
    coolDelay: 0.3,
    restart: 0.25,
    /** Effective range (m): the HUD's lead pip, the room's sanity range for claims. */
    range: 1600,
    /** Rounds an intercept claim costs from the budget (a burst, not one lucky round). */
    interceptCost: 6,
    /** The room accepts claims whose target lies within this angle of the gunner's last reported aim. */
    claimCone: 22 * DEG,
  },
  sam: {
    yawRate: 1.2,
    pitchRate: 1.0,
    /** Cells in the box; an empty cell reloads `reload` s after the previous one, starting `reloadDelay` s after a launch;
     *  `interval` s between launches (was 0.8: with the quicker lock, a ripple of 8 made the SAM the top jet killer). */
    cells: 8,
    reload: 3,
    reloadDelay: 2,
    interval: 1.6,
    /** Seeker on the launcher: cone half-angle off the aim (rad), lock range and minimum range (m), seconds to lock
     *  (the ship's fire-control radar: quicker than the AIM-9's 1.4; was 2.2, too long for a gunner holding a crossing
     *  jet: scripts/sam-playtest.ts), and the keep cone/range once tracking. */
    cone: 9 * DEG,
    range: 4000,
    minRange: 250,
    lockTime: 1.2,
    keep: 1.4,
    keepRange: 1.1,
    /** Leaves the cell at `eject` m/s along the launcher, then the motor: acceleration, top speed, burn, drag. */
    eject: 45,
    accel: 480,
    topSpeed: 820,
    burn: 3.0,
    drag: 0.00008,
    life: 9,
    /** No steering for the first `boost` s (it clears the ship). */
    boost: 0.35,
    nav: 4,
    maxG: 30,
    /** The fins bite from `bite` m/s up (full authority there): a slow SAM just off the rail still turns. */
    bite: 380,
    lag: 0.14,
    gimbal: 55 * DEG,
    /** Proximity fuse radius (m; was 15: a crossing jet at 900 m slipped past at 16-35 m in scripts/sam-playtest.ts).
     *  A SAM that loses its target past closest approach bursts there (a visible near miss, not a 9 s fly-off). */
    fuse: 24,
    arm: 0.6,
    /** Heavy but not a one-shot: a close burst leaves a jet badly hurt and able to limp home (100 hp). */
    damage: 70,
    edge: 30,
    /** Flares: a burst seduces a SAM only by chance (`decoy`, hashed per missile and flare; AIM-9s are always fooled),
     *  within its first `seduce` s and `seduceRange` m. */
    decoy: 0.55,
    seduce: 0.6,
    seduceRange: 1800,
    /** A SAM striking a carrier (hp of shared/fleet.ts's 1,000). */
    shipDamage: 40,
  },
  gun: {
    yawRate: 0.65,
    pitchRate: 0.5,
    /** One round every `interval` s, `muzzle` m/s, quadratic drag (1/m), life (s): ≈ 6 km flat. Balanced to be a steady
     *  threat, not the ship-killer: sustained direct hits take a carrier down in ~3.5 min, a near burst wounds a jet. */
    interval: 2.5,
    muzzle: 800,
    drag: 0.00004,
    life: 8.5,
    /** Proximity fuse on enemy jets (m), armed after `arm` s; damage `damage` at the centre to `edge` at the radius. */
    fuse: 10,
    arm: 0.4,
    damage: 45,
    edge: 12,
    /** Direct hit on a carrier (hp of shared/fleet.ts's 1,000; a fire where it lands); a burst in the water within `near`
     *  m of the hull: `nearMax` at the hull down to `nearMin` at `near` (no fire). */
    shipDamage: 12,
    near: 14,
    nearMax: 10,
    nearMin: 2,
  },
  /** Gunners tell the room their aim this often (s) while it moves. */
  aimEvery: 0.1,
} as const

// ---- turret geometry ----------------------------------------------------------------------------------------------------

/** The weapons are drawn at 1.5x life size (src/render/ship-weapons.ts WEAPON_SCALE). */
export const TURRET_SCALE = 1.5

/**
 * Each kind's pivots as src/render/ship-weapons.ts builds them (life size; tests check they agree): the yaw axis stands
 * `yawY` above the mount base, the barrel elevates about `pivot` (turret frame), the muzzle is `muzzle` along the
 * barrel's +Z, and the gunner's eye is `sight` in the barrel frame (rides the elevation) or the turret frame.
 */
export const TURRET_GEOMETRY: Readonly<Record<MountKind, { yawY: number; pivot: readonly [number, number, number]; muzzle: number; sight: readonly [number, number, number]; sightFrame: "barrel" | "turret" }>> = {
  ciws: { yawY: 2.0, pivot: [0, 1.75, 1.45], muzzle: 5.0, sight: [1.2, 1.05, 0], sightFrame: "barrel" },
  sam: { yawY: 1.8, pivot: [0, 3.2, 0], muzzle: 3.3, sight: [0, 3.7, -4.0], sightFrame: "barrel" },
  gun: { yawY: 0.7, pivot: [0, 1.8, 4.32], muzzle: 10.7, sight: [0, 4.6, 0.6], sightFrame: "turret" },
}

/** The SAM box's 8 cell mouths in the barrel frame (scaled): two 4-cell boxes, 2 x 2 cells each, left box first. */
export const SAM_CELLS: readonly (readonly [number, number, number])[] = (() => {
  const h = 1.55
  const out: [number, number, number][] = []
  for (const [x0, x1] of [
    [0.06, 2.85],
    [-2.85, -0.06],
  ] as const) {
    const w = (x1 - x0 - 0.36) / 2
    for (const r of [1, 0])
      for (const c of [0, 1]) {
        const cx = x0 + 0.12 + c * (w + 0.12) + w / 2
        const cy = -h + 0.12 + r * (h - 0.06) + (h - 0.18) / 2
        out.push([cx * TURRET_SCALE, cy * TURRET_SCALE, 3.3 * TURRET_SCALE])
      }
  }
  return out
})()

export type TurretAngles = { yaw: number; pitch: number }

export const mountOf = (i: number): WeaponMount | undefined => WEAPON_MOUNTS[i]
export const tuningOf = (k: MountKind) => GUNNERY[k]

/** A mount's turret at rest. */
export const restAngles = (i: number, out: TurretAngles = { yaw: 0, pitch: 0 }): TurretAngles => {
  const m = WEAPON_MOUNTS[i]!
  out.yaw = m.restYaw
  out.pitch = m.restPitch
  return out
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** Clamps a wanted aim into the mount's arcs: pitch into `pitchArc`; a yaw outside `yawArc` goes to the nearer end. */
export function clampAim(m: WeaponMount, yaw: number, pitch: number, out: TurretAngles = { yaw: 0, pitch: 0 }): TurretAngles {
  const [y0, y1] = m.yawArc
  // Into [y0, y0 + 2π): arcs may run past ±π (the port SAM's ends wrap round the stern).
  let y = y0 + (((yaw - y0) % TAU) + TAU) % TAU
  if (y > y1) y = Math.abs(wrap(y - y0)) <= Math.abs(wrap(y - y1)) ? y0 : y1
  out.yaw = y
  out.pitch = Math.max(m.pitchArc[0], Math.min(m.pitchArc[1], pitch))
  return out
}

/** How far (rad) a wanted aim lies outside the arcs: 0 inside. The HUD's limit cue. */
export function arcExcess(m: WeaponMount, yaw: number, pitch: number): { yaw: number; pitch: number } {
  const c = clampAim(m, yaw, pitch, ca)
  return { yaw: wrap(yaw - c.yaw), pitch: pitch - c.pitch }
}
const ca: TurretAngles = { yaw: 0, pitch: 0 }

/**
 * Trains turret `cur` of mount `i` toward the wanted aim for `dt` seconds: the aim clamped to the arcs, then each axis
 * at most its rate. Yaw stays inside [y0, y1] (it may pass ±π) and moves linearly there, never through the ship.
 * Returns true when it is on the (clamped) aim.
 */
export function slewTurret(cur: TurretAngles, i: number, wantYaw: number, wantPitch: number, dt: number): boolean {
  const m = WEAPON_MOUNTS[i]!
  const t = GUNNERY[m.kind]
  const c = clampAim(m, wantYaw, wantPitch, ca)
  const dy = c.yaw - cur.yaw
  const dp = c.pitch - cur.pitch
  const sy = t.yawRate * dt
  const sp = t.pitchRate * dt
  cur.yaw += Math.max(-sy, Math.min(sy, dy))
  cur.pitch += Math.max(-sp, Math.min(sp, dp))
  // Stay inside the arcs whatever the start (a turret handed over at rest is already inside).
  clampAim(m, cur.yaw, cur.pitch, cur)
  return Math.abs(dy) <= sy && Math.abs(dp) <= sp
}

/** The bore's ship-local unit direction at (yaw, pitch). */
export function boreLocal(yaw: number, pitch: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const cp = Math.cos(pitch)
  out[0] = Math.sin(yaw) * cp
  out[1] = Math.sin(pitch)
  out[2] = Math.cos(yaw) * cp
  return out
}

/** Ship-local yaw and pitch of a direction (need not be unit). */
export function anglesOf(x: number, y: number, z: number, out: TurretAngles = { yaw: 0, pitch: 0 }): TurretAngles {
  out.yaw = Math.atan2(x, z)
  out.pitch = Math.atan2(y, Math.hypot(x, z))
  return out
}

/**
 * A point of mount `i`'s turret at (yaw, pitch) in ship-local space: (bx, by, bz) in the barrel frame (origin at the
 * elevation pivot, bore +Z) or, with `frame` "turret", in the turret frame (origin on the yaw axis, scaled units).
 */
export function turretPoint(i: number, yaw: number, pitch: number, bx: number, by: number, bz: number, frame: "barrel" | "turret", out: Vec3 = [0, 0, 0]): Vec3 {
  const m = WEAPON_MOUNTS[i]!
  const g = TURRET_GEOMETRY[m.kind]
  let x = bx
  let y = by
  let z = bz
  if (frame === "barrel") {
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    const y1 = y * cp + z * sp
    const z1 = -y * sp + z * cp
    x += g.pivot[0] * TURRET_SCALE
    y = y1 + g.pivot[1] * TURRET_SCALE
    z = z1 + g.pivot[2] * TURRET_SCALE
  }
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  out[0] = m.pos[0] + x * cy + z * sy
  out[1] = m.pos[1] + g.yawY * TURRET_SCALE + y
  out[2] = m.pos[2] - x * sy + z * cy
  return out
}

/** Ship-local → world for a point (with the ship's position) or a direction (`dir`). */
export function toWorld(ship: ShipPoseLike, l: Vec3, dir: boolean, out: Vec3 = [0, 0, 0]): Vec3 {
  const q = shipQuat(ship, qw)
  quatRotate(q[0], q[1], q[2], q[3], l[0], l[1], l[2], out)
  if (!dir) {
    out[0] += ship.x
    out[1] += ship.heave
    out[2] += ship.z
  }
  return out
}
const qw: Quat = [0, 0, 0, 1]

/** World direction → ship-local direction. */
export function toLocalDir(ship: ShipPoseLike, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const q = shipQuat(ship, qw)
  return quatRotate(-q[0], -q[1], -q[2], q[3], x, y, z, out)
}

/** Where mount `i`'s rounds leave in the world (the muzzle), and along what (unit), at (yaw, pitch); SAMs from `cell`. */
export function muzzleWorld(ship: ShipPoseLike, i: number, yaw: number, pitch: number, pos: Vec3, dir: Vec3, cell = 0): void {
  const m = WEAPON_MOUNTS[i]!
  const g = TURRET_GEOMETRY[m.kind]
  if (m.kind === "sam") {
    const c = SAM_CELLS[cell % SAM_CELLS.length]!
    turretPoint(i, yaw, pitch, c[0], c[1], c[2], "barrel", lv)
  } else turretPoint(i, yaw, pitch, 0, 0, g.muzzle * TURRET_SCALE, "barrel", lv)
  toWorld(ship, lv, false, pos)
  toWorld(ship, boreLocal(yaw, pitch, lv), true, dir)
}
const lv: Vec3 = [0, 0, 0]

/** The world velocity of a ship-local point riding the ship (plan speed and yaw rate only: heave and roll are slow). */
export function shipPointVel(ship: ShipPoseLike & { u?: number; v?: number; r?: number }, out: Vec3 = [0, 0, 0]): Vec3 {
  // shared/ship.ts: u forward, v to starboard (m/s) in the plan frame; heading 0 north (−z).
  const u = ship.u ?? 0
  const v = ship.v ?? 0
  const s = Math.sin(ship.heading)
  const c = Math.cos(ship.heading)
  out[0] = s * u + c * v
  out[1] = 0
  out[2] = -c * u + s * v
  return out
}

// ---- the gunner's weapon state ----------------------------------------------------------------------------------------

/** One manned weapon's local state: CIWS heat, SAM cells and lock, the gun's breech. */
export type TurretState = {
  mount: number
  kind: MountKind
  heat: number
  overheated: boolean
  idle: number
  owed: number
  /** Rounds fired (CIWS dispersion and tracers), launches and shells (sequence numbers: one counter). */
  round: number
  seq: number
  cells: number
  /** Seconds until the next cell is reloaded (while one is empty). */
  reloadIn: number
  /** Seconds until another launch or shot. */
  readyIn: number
  lock: Lock
  /** SAM: the trigger was pressed while the seeker tracked but had not locked; it launches the moment it locks. */
  armed: boolean
}

export function makeTurretState(mount: number): TurretState {
  const kind = WEAPON_MOUNTS[mount]!.kind
  return { mount, kind, heat: 0, overheated: false, idle: 10, owed: 0.999, round: 0, seq: 0, cells: GUNNERY.sam.cells, reloadIn: 0, readyIn: 0, lock: { target: -1, time: 0, locked: false }, armed: false }
}

/** CIWS trigger for one step: rounds to fire this step (0..2), heating and cooling as the jets' cannon does. */
export function ciwsStep(s: TurretState, trigger: boolean, dt: number): number {
  const c = GUNNERY.ciws
  if (s.overheated && s.heat <= c.restart) s.overheated = false
  let n = 0
  if (trigger && !s.overheated) {
    s.owed += c.rate * dt
    n = Math.floor(s.owed)
    s.owed -= n
    s.heat = Math.min(1, s.heat + dt / c.heatTime)
    s.idle = 0
    if (s.heat >= 1) {
      s.overheated = true
      s.owed = 0
    }
  } else {
    s.owed = trigger ? 0 : 0.999
    s.idle += dt
    if (s.idle > c.coolDelay) s.heat = Math.max(0, s.heat - c.cool * dt)
  }
  return n
}

/** SAM cells reloading and the launch/shot interval. Every step while manned. */
export function turretStep(s: TurretState, dt: number): void {
  s.readyIn = Math.max(0, s.readyIn - dt)
  if (s.kind !== "sam") return
  const c = GUNNERY.sam
  if (s.cells < c.cells) {
    s.reloadIn -= dt
    if (s.reloadIn <= 0) {
      s.cells++
      s.reloadIn = s.cells < c.cells ? c.reload : 0
    }
  }
}

/** Takes a SAM from the next loaded cell. Returns its cell index (0..7, launch order) or -1. */
export function takeSam(s: TurretState): number {
  const c = GUNNERY.sam
  if (s.cells <= 0 || s.readyIn > 0) return -1
  const cell = (c.cells - s.cells) % c.cells
  s.cells--
  s.reloadIn = c.reloadDelay + c.reload
  s.readyIn = c.interval
  return cell
}

/**
 * The SAM trigger for one step, after the seeker's `samLockStep`. A press while the seeker tracks a jet but has not yet
 * locked arms the launcher, and the SAM goes the moment the lock completes (and a cell is ready), so an early click is
 * never a wasted dumbfire; losing the track disarms it. A press when locked, or with nothing in the seeker (a dumbfire,
 * e.g. at a ship), launches at once. True: launch now (then `takeSam`).
 */
export function samTrigger(s: TurretState, pressed: boolean): boolean {
  const l = s.lock
  if (l.target < 0) s.armed = false
  if (pressed) {
    if (l.target >= 0 && !l.locked) {
      s.armed = true
      return false
    }
    s.armed = false
    return true
  }
  if (s.armed && l.locked && s.cells > 0 && s.readyIn <= 0) {
    s.armed = false
    return true
  }
  return false
}

/** Fires the gun if the breech is ready. */
export function takeShell(s: TurretState): boolean {
  if (s.readyIn > 0) return false
  s.readyIn = GUNNERY.gun.interval
  return true
}

/**
 * The SAM's seeker for one step, aimed along the launcher's bore from the mount: keeps its target in the wider keep
 * cone, else takes the enemy jet nearest the bore inside the lock cone; locks after `lockTime`. `blind(id)`: jets that
 * just flared cannot be picked. Returns true when the lock state changed.
 */
export function samLockStep(lock: Lock, dt: number, x: number, y: number, z: number, fx: number, fy: number, fz: number, team: number, targets: Iterable<Target>, blind: (id: number) => boolean = () => false): boolean {
  const c = GUNNERY.sam
  const before = lock.target
  const was = lock.locked
  let keep: Target | null = null
  let best: Target | null = null
  let bestAngle = Infinity
  for (const t of targets) {
    if (!t.alive || t.team === team || t.surface || blind(t.id)) continue
    const dx = t.x - x
    const dy = t.y - y
    const dz = t.z - z
    const d = Math.hypot(dx, dy, dz)
    if (d < 1e-6) continue
    const a = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dy * fy + dz * fz) / d)))
    if (t.id === lock.target && a <= c.cone * c.keep && d <= c.range * c.keepRange && d >= c.minRange * 0.5) keep = t
    if (a <= c.cone && d <= c.range && d >= c.minRange && a < bestAngle) {
      best = t
      bestAngle = a
    }
  }
  const t = keep ?? best
  if (!t) {
    lock.target = -1
    lock.time = 0
    lock.locked = false
  } else {
    if (t.id !== lock.target) {
      lock.target = t.id
      lock.time = 0
      lock.locked = false
    }
    lock.time += dt
    if (lock.time >= c.lockTime) lock.locked = true
  }
  return lock.target !== before || lock.locked !== was
}

// ---- ballistics -----------------------------------------------------------------------------------------------------------

/** One step of a 5-inch shell: quadratic drag and gravity (semi-implicit Euler; prediction uses the same step). */
export function shellStep(p: { x: number; y: number; z: number; vx: number; vy: number; vz: number }, dt: number): void {
  const k = GUNNERY.gun.drag * Math.hypot(p.vx, p.vy, p.vz)
  p.vx -= p.vx * k * dt
  p.vy -= (p.vy * k + G) * dt
  p.vz -= p.vz * k * dt
  p.x += p.vx * dt
  p.y += p.vy * dt
  p.z += p.vz * dt
}

/** Where a shell fired now lands: the point, time of flight and what it strikes (null: it bursts in the air at the end
 *  of its life). Flies the same steps as the world (PLANE.tick), so the marker is where the shell will hit. */
export type Impact = { x: number; y: number; z: number; time: number; kind: ImpactKind | "air" }

export function predictImpact(x: number, y: number, z: number, vx: number, vy: number, vz: number, t: number, ground: Ground, out: Impact = { x: 0, y: 0, z: 0, time: 0, kind: "air" }, ignoreShip = -1, dt = PLANE.tick): Impact {
  const p = ps
  p.x = x
  p.y = y
  p.z = z
  p.vx = vx
  p.vy = vy
  p.vz = vz
  const life = GUNNERY.gun.life
  let age = 0
  const g = ground.ships && ignoreShip >= 0 ? { ...ground, ships: ground.ships.filter((s) => s.id !== ignoreShip) } : ground
  while (age < life) {
    shellStep(p, dt)
    age += dt
    const kind = p.y < MAX_PEAK ? groundHit(g, p.x, p.y, p.z, t + age) : ""
    if (kind) {
      out.x = p.x
      out.y = kind === "sea" && g.sea ? seaHeight(g.sea, p.x, p.z, t + age) : kind === "sea" ? 0 : p.y
      out.z = p.z
      out.time = age
      out.kind = kind
      return out
    }
  }
  out.x = p.x
  out.y = p.y
  out.z = p.z
  out.time = age
  out.kind = "air"
  return out
}
const ps = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }

/**
 * First-order lead: where to aim a round leaving (x, y, z) at `speed` (m/s, plus the shooter's velocity) to meet a target
 * at p moving at v. Returns the time to impact (Infinity if it can't catch it) and the aim point in `out`. Gravity drop
 * is added for `gravity` g over that time.
 */
export function leadPoint(x: number, y: number, z: number, svx: number, svy: number, svz: number, speed: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number, gravity: number, out: Vec3): number {
  const rx = px - x
  const ry = py - y
  const rz = pz - z
  const wx = vx - svx
  const wy = vy - svy
  const wz = vz - svz
  // |r + w t| = speed t → (w·w − s²) t² + 2 (r·w) t + r·r = 0.
  const a = wx * wx + wy * wy + wz * wz - speed * speed
  const b = 2 * (rx * wx + ry * wy + rz * wz)
  const c = rx * rx + ry * ry + rz * rz
  let t = Infinity
  if (Math.abs(a) < 1e-6) t = b < 0 ? -c / b : Infinity
  else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const s = Math.sqrt(disc)
      const t1 = (-b - s) / (2 * a)
      const t2 = (-b + s) / (2 * a)
      t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity)
    }
  }
  if (!Number.isFinite(t)) {
    out[0] = px
    out[1] = py
    out[2] = pz
    return Infinity
  }
  out[0] = px + wx * t
  out[1] = py + wy * t + 0.5 * G * gravity * t * t
  out[2] = pz + wz * t
  return t
}

// ---- CIWS rounds ----------------------------------------------------------------------------------------------------------

/** Something a CIWS round can shoot down: a missile or bomb (`store` 0: shared/combat.ts) or a SAM or shell (`store` 1). */
export type Interceptable = { store: 0 | 1; owner: number; seq: number; team: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }

/** A CIWS round hit: a jet (`target` its id), a store (`target` its index in the list), or the world (`target` -1). */
export type TurretHit = (owner: number, kind: ImpactKind | "jet" | "store", target: number, x: number, y: number, z: number, ship: GroundShip | null) => void

/**
 * CIWS rounds in flight: a fixed ring, structure of arrays, as shared/combat.ts `Bullets`. Own rounds (`hits`) check jets
 * and stores with relative sweeps; cosmetic rounds (everyone else's turrets) only strike the world.
 */
export class TurretRounds {
  readonly cap: number
  readonly x: Float64Array
  readonly y: Float64Array
  readonly z: Float64Array
  readonly vx: Float64Array
  readonly vy: Float64Array
  readonly vz: Float64Array
  readonly age: Float32Array
  readonly owner: Int32Array
  readonly team: Int32Array
  /** The carrier the round left (it never strikes its own ship). */
  readonly ship: Int32Array
  /** 0 = free, 1 = flying, 2 = flying tracer. */
  readonly state: Uint8Array
  hits = true
  private next = 0
  live = 0

  constructor(cap = 512) {
    this.cap = cap
    this.x = new Float64Array(cap)
    this.y = new Float64Array(cap)
    this.z = new Float64Array(cap)
    this.vx = new Float64Array(cap)
    this.vy = new Float64Array(cap)
    this.vz = new Float64Array(cap)
    this.age = new Float32Array(cap)
    this.owner = new Int32Array(cap)
    this.team = new Int32Array(cap)
    this.ship = new Int32Array(cap)
    this.state = new Uint8Array(cap)
  }

  clear(): void {
    this.state.fill(0)
    this.live = 0
  }

  /**
   * Round `round` of `owner` from the muzzle along the unit bore f, with the ship's velocity v; the dispersion disc is
   * hashed from (owner, round) over the axes u and r (square to f). `lead` (s) flies it ahead within the step.
   */
  fire(owner: number, team: number, ship: number, round: number, x: number, y: number, z: number, v: Vec3, f: Vec3, lead = 0): number {
    const c = GUNNERY.ciws
    const i = this.next
    this.next = (i + 1) % this.cap
    if (!this.state[i]) this.live++
    // Two axes square to the bore.
    let ux = -f[1] * f[0]
    let uy = 1 - f[1] * f[1]
    let uz = -f[1] * f[2]
    let ul = Math.hypot(ux, uy, uz)
    if (ul < 1e-4) {
      ux = 1
      uy = uz = 0
      ul = 1
    }
    ux /= ul
    uy /= ul
    uz /= ul
    const rx = f[1] * uz - f[2] * uy
    const ry = f[2] * ux - f[0] * uz
    const rz = f[0] * uy - f[1] * ux
    const a = hash01(owner ^ 0x7c15, round) * Math.PI * 2
    const r = Math.sqrt(hash01(owner ^ 0x31d3, round)) * Math.tan(c.spread)
    const su = Math.sin(a) * r
    const sr = Math.cos(a) * r
    let dx = f[0] + ux * su + rx * sr
    let dy = f[1] + uy * su + ry * sr
    let dz = f[2] + uz * su + rz * sr
    const n = Math.hypot(dx, dy, dz)
    dx /= n
    dy /= n
    dz /= n
    this.vx[i] = v[0] + dx * c.muzzle
    this.vy[i] = v[1] + dy * c.muzzle
    this.vz[i] = v[2] + dz * c.muzzle
    this.x[i] = x + this.vx[i]! * lead
    this.y[i] = y + this.vy[i]! * lead
    this.z[i] = z + this.vz[i]! * lead
    this.age[i] = lead
    this.owner[i] = owner
    this.team[i] = team
    this.ship[i] = ship
    this.state[i] = round % c.tracer === 0 ? 2 : 1
    return i
  }

  /** One step against the jets (`targets`, at the end of the step), the stores and the world at sea time t. */
  step(dt: number, t: number, targets: readonly Target[], stores: readonly Interceptable[], ground: Ground, hit: TurretHit): void {
    if (!this.live) return
    const c = GUNNERY.ciws
    const r2 = c.hitRadius * c.hitRadius
    const i2 = c.interceptRadius * c.interceptRadius
    const grav = G * c.gravity * dt
    for (let i = 0; i < this.cap; i++) {
      if (!this.state[i]) continue
      const ax = this.x[i]!
      const ay = this.y[i]!
      const az = this.z[i]!
      this.vy[i] = this.vy[i]! - grav
      const bx = ax + this.vx[i]! * dt
      const by = ay + this.vy[i]! * dt
      const bz = az + this.vz[i]! * dt
      this.x[i] = bx
      this.y[i] = by
      this.z[i] = bz
      this.age[i] = this.age[i]! + dt
      if (this.hits) {
        let best = -1
        let bestK = 2
        let store = false
        for (let j = 0; j < targets.length; j++) {
          const tg = targets[j]!
          if (!tg.alive || !canHurt(this.team[i]!, this.owner[i]!, tg.team, tg.id)) continue
          const qx = tg.x - bx
          const qy = tg.y - by
          const qz = tg.z - bz
          const reach = 40 + c.hitRadius
          if (qx * qx + qy * qy + qz * qz > reach * reach) continue
          const k = sweep(ax, ay, az, bx, by, bz, tg.x - tg.vx * dt, tg.y - tg.vy * dt, tg.z - tg.vz * dt, tg.x, tg.y, tg.z, d2)
          if (d2[0] <= r2 && k < bestK) {
            best = j
            bestK = k
          }
        }
        for (let j = 0; j < stores.length; j++) {
          const s = stores[j]!
          if (s.team === this.team[i]) continue
          const qx = s.x - bx
          const qy = s.y - by
          const qz = s.z - bz
          if (qx * qx + qy * qy + qz * qz > 60 * 60) continue
          const k = sweep(ax, ay, az, bx, by, bz, s.x - s.vx * dt, s.y - s.vy * dt, s.z - s.vz * dt, s.x, s.y, s.z, d2)
          if (d2[0] <= i2 && k < bestK) {
            best = j
            bestK = k
            store = true
          }
        }
        if (best >= 0) {
          this.kill(i)
          const hx = ax + (bx - ax) * bestK
          const hy = ay + (by - ay) * bestK
          const hz = az + (bz - az) * bestK
          if (store) hit(this.owner[i]!, "store", best, hx, hy, hz, null)
          else hit(this.owner[i]!, "jet", targets[best]!.id, hx, hy, hz, null)
          continue
        }
      }
      if (this.age[i]! > 0.05) {
        const kind = by < MAX_PEAK ? groundHit(ground, bx, by, bz, t) : ""
        if (kind) {
          const sh = kind === "ship" ? shipAt(ground, bx, by, bz) : null
          if (!(sh && sh.id === this.ship[i])) {
            this.kill(i)
            hit(this.owner[i]!, kind, -1, bx, kind === "sea" && ground.sea ? seaHeight(ground.sea, bx, bz, t) : by, bz, sh)
            continue
          }
        }
      }
      if (this.age[i]! >= c.life) this.kill(i)
    }
  }

  private kill(i: number): void {
    this.state[i] = 0
    this.live--
  }
}
const d2: [number] = [0]

// ---- SAMs and shells: the world ---------------------------------------------------------------------------------------------

export type GunProjectile = {
  kind: "sam" | "shell"
  owner: number
  team: number
  seq: number
  /** The carrier it left: it never strikes it in its first second (it starts beside it). */
  ship: number
  /** Jet a SAM homes on (-1 none). */
  target: number
  decoy: LiveFlare | null
  /** Flares released before this sea time are ignored: a burst that failed its coin. */
  ignore: number
  t0: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  speed: number
  ax: number
  ay: number
  az: number
  age: number
  alive: boolean
}

export function makeProjectile(): GunProjectile {
  return { kind: "shell", owner: -1, team: -1, seq: 0, ship: -1, target: -1, decoy: null, ignore: -Infinity, t0: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, ax: 0, ay: 0, az: 0, age: 0, alive: false }
}

/** A SAM launch or a shell as sent over the wire: who, which, from which mount and ship, when, where, how fast, at whom. */
export type GunLaunch = { owner: number; seq: number; kind: "sam" | "shell"; ship: number; mount: number; t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; target: number }

/** A manned mount as the room knows it: who, which ship and mount, their last aim and trigger, and their budgets. */
export type Gunner = {
  id: number
  team: number
  ship: number
  mount: number
  yaw: number
  pitch: number
  firing: boolean
  /** Sea time of the last trigger-on report. */
  firedAt: number
  /** Authority budgets: CIWS rounds, SAM cells, gun shells. */
  rounds: number
  cells: number
  shells: number
}

export type GunneryEvent =
  /** A SAM or shell burst at (x, y, z): in the air, on the sea, on land or on a ship; `on` the jet it burst on (-1). */
  | { k: "gboom"; owner: number; seq: number; kind: "sam" | "shell"; x: number; y: number; z: number; on: number; surface: "air" | ImpactKind }
  /** A jet took `dmg` from gunner `by`'s weapon `w` (the host applies it to shared/combat.ts health and kill credit). */
  | { k: "hurt"; on: number; dmg: number; by: number; w: GunWeapon }
  /** A shell or SAM struck carrier `ship` (ship-local point; `near` > 0: a shell burst in the water that far off). */
  | { k: "ship"; ship: number; owner: number; w: "sam" | "shell"; x: number; y: number; z: number; near: number; n?: number }
  /** A SAM turned onto a flare. */
  | { k: "decoy"; owner: number; seq: number }
  /** Gunner `by`'s CIWS shot down a store (0: a missile or bomb of shared/combat.ts, 1: a SAM or shell) at (x, y, z). */
  | { k: "intercept"; by: number; owner: number; seq: number; store: 0 | 1; x: number; y: number; z: number }

export const MAX_PROJECTILES = 64

/** SAM damage at distance d from the burst. */
export function samDamage(d: number): number {
  const c = GUNNERY.sam
  return d > c.fuse ? 0 : c.damage + (c.edge - c.damage) * (d / c.fuse)
}

/** Shell burst damage on a jet at distance d. */
export function shellDamage(d: number): number {
  const c = GUNNERY.gun
  return d > c.fuse ? 0 : c.damage + (c.edge - c.damage) * (d / c.fuse)
}

/** Whether a burst whose first flare is `f` seduces SAM (owner, seq): a fixed coin per missile and burst, so every
 *  machine agrees. */
export const samDecoyed = (owner: number, seq: number, f: { owner: number; t0: number }): boolean => hash01(owner * 7919 + seq, f.owner * 131 + Math.round(f.t0 * 1000)) < GUNNERY.sam.decoy

/**
 * A gunnery hit on a carrier in shared/fleet.ts terms (`Fleet.hit`); CIWS rounds never hurt a carrier. A
 * shell or SAM on the hull is a `shell` of its own damage (zone and fire from where it lands); a shell in the water near
 * the hull is a `shell` near miss (`near` > 0: the hull side, no fire) on a falling curve.
 */
export function shipHitOf(w: "sam" | "shell", near: number): { w: ShipDamageKind; near: number; n: number; amount?: number } {
  if (w === "sam") return { w: "shell", near: 0, n: 1, amount: GUNNERY.sam.shipDamage }
  if (near <= 0) return { w: "shell", near: 0, n: 1, amount: GUNNERY.gun.shipDamage }
  const g = GUNNERY.gun
  const k = Math.min(1, near / g.near)
  return { w: "shell", near: Math.max(0.5, near), n: 1, amount: g.nearMax + (g.nearMin - g.nearMax) * k }
}

/** What the world needs from the host each step: the jets (at the end of the step) and the live flares. */
export type GunneryTargets = { jets: readonly Target[]; flares?: readonly LiveFlare[] }

/**
 * SAMs and shells for a room (or a client's cosmetic copy, or the offline harness), and the gunners' budgets. `step(t,
 * targets)` advances it in fixed PLANE.tick steps to sea time t. With `authority` bursts hurt (as events), launches spend
 * budgets and claims are checked; without it projectiles still fly, decoy and burst for drawing. Events accumulate in
 * `events` until the host drains them.
 */
export class GunneryWorld {
  t = 0
  readonly gunners = new Map<number, Gunner>()
  readonly projectiles: GunProjectile[] = Array.from({ length: MAX_PROJECTILES }, makeProjectile)
  readonly events: GunneryEvent[] = []
  private sub: Target[] = []
  private subPool: Target[] = []

  constructor(
    public ground: Ground = { sea: null, arch: null },
    public authority = true,
  ) {}

  /** A player takes mount `mount` of ship `ship`: full budgets, aim at rest. */
  man(id: number, team: number, ship: number, mount: number): Gunner {
    const m = WEAPON_MOUNTS[mount]!
    const g: Gunner = { id, team, ship, mount, yaw: m.restYaw, pitch: m.restPitch, firing: false, firedAt: -1e9, rounds: GUNNERY.ciws.rate * 0.6, cells: GUNNERY.sam.cells, shells: 1 }
    this.gunners.set(id, g)
    return g
  }

  unman(id: number): void {
    this.gunners.delete(id)
  }

  /** A gunner's aim report (ship-local yaw and pitch; trigger). */
  aim(id: number, yaw: number, pitch: number, firing: boolean): void {
    const g = this.gunners.get(id)
    if (!g) return
    const c = clampAim(WEAPON_MOUNTS[g.mount]!, yaw, pitch, ca)
    g.yaw = c.yaw
    g.pitch = c.pitch
    g.firing = firing
    if (firing) g.firedAt = this.t
  }

  private shipPose(id: number): GroundShip | null {
    for (const s of this.ground.ships ?? []) if (s.id === id) return s
    return null
  }

  /** A manned mount's muzzle in the world now (for range checks), or null if its ship isn't known. */
  mountAt(g: Gunner, out: Vec3): Vec3 | null {
    const s = this.shipPose(g.ship)
    if (!s) return null
    return toWorld(s, turretPoint(g.mount, g.yaw, g.pitch, 0, 0, 0, "barrel", mv), false, out)
  }

  /**
   * CIWS hits gunner `by` reports on jet `target` (`n` rounds): refused unless `by` mans a CIWS, the jet is an alive
   * enemy within range of the mount, and the rounds fit the budget. Emits the damage; returns the rounds applied.
   */
  ciwsHits(by: number, target: Target, n: number): number {
    const g = this.gunners.get(by)
    if (!g || WEAPON_MOUNTS[g.mount]!.kind !== "ciws" || !target.alive || !canHurt(g.team, g.id, target.team, target.id)) return 0
    if (this.authority) {
      const at = this.mountAt(g, mw)
      if (at && Math.hypot(target.x - at[0], target.y - at[1], target.z - at[2]) > GUNNERY.ciws.range + 500) return 0
    }
    const use = this.spend(g, n)
    if (use) this.events.push({ k: "hurt", on: target.id, dmg: use * GUNNERY.ciws.damage, by, w: "ciws" })
    return use
  }

  /**
   * CIWS rounds gunner `by` claims against something on carrier `ship`'s deck (a parked jet, shared/deck-jets.ts):
   * a manned CIWS, an enemy ship within range, the round budget; nothing emitted. (Rounds on the carrier itself do
   * nothing: CIWS never hurts a carrier.)
   * Returns the rounds allowed.
   */
  ciwsDeckRounds(by: number, ship: GroundShip, n: number): number {
    const g = this.gunners.get(by)
    if (!g || WEAPON_MOUNTS[g.mount]!.kind !== "ciws" || ship.id === undefined || ship.team === g.team) return 0
    if (this.authority) {
      const at = this.mountAt(g, mw)
      if (at && Math.hypot(ship.x - at[0], ship.z - at[2]) > GUNNERY.ciws.range + 400) return 0
    }
    return this.spend(g, n)
  }

  private spend(g: Gunner, n: number): number {
    if (!this.authority) return Math.max(0, Math.floor(n))
    const use = Math.max(0, Math.min(Math.floor(n), Math.floor(g.rounds)))
    g.rounds -= use
    return use
  }

  /**
   * Gunner `by` claims their CIWS shot down a store at (x, y, z) (its position as the claim saw it): `s` the store as the
   * authority knows it now. Accepted when `by` mans a CIWS that fired in the last second, the store belongs to an enemy,
   * it lies within range of the mount and within `claimCone` of the reported aim, and a burst's rounds fit the budget.
   */
  intercept(by: number, s: Interceptable | null): boolean {
    const g = this.gunners.get(by)
    if (!g || !s || WEAPON_MOUNTS[g.mount]!.kind !== "ciws") return false
    if (s.team === g.team) return false
    if (this.authority) {
      if (this.t - g.firedAt > 1 && !g.firing) return false
      const sh = this.shipPose(g.ship)
      const at = this.mountAt(g, mw)
      if (!sh || !at) return false
      const dx = s.x - at[0]
      const dy = s.y - at[1]
      const dz = s.z - at[2]
      const d = Math.hypot(dx, dy, dz)
      if (d > GUNNERY.ciws.range + 300) return false
      const f = toWorld(sh, boreLocal(g.yaw, g.pitch, mv), true, mf)
      if (d > 30 && (dx * f[0] + dy * f[1] + dz * f[2]) / d < Math.cos(GUNNERY.ciws.claimCone)) return false
      if (g.rounds < GUNNERY.ciws.interceptCost) return false
      g.rounds -= GUNNERY.ciws.interceptCost
    }
    this.events.push({ k: "intercept", by, owner: s.owner, seq: s.seq, store: s.store, x: s.x, y: s.y, z: s.z })
    if (s.store === 1) {
      const p = this.find(s.owner, s.seq)
      if (p) this.burst(p, p.x, p.y, p.z, [], -1, "air")
    }
    return true
  }

  /** Distance (m) from (x, y, z) to the nearest live SAM homing on jet `id`, or Infinity (the jet's MISSILE warning). */
  inbound(id: number, x: number, y: number, z: number): number {
    let best = Infinity
    for (const p of this.projectiles) if (p.alive && p.kind === "sam" && p.target === id) best = Math.min(best, Math.hypot(p.x - x, p.y - y, p.z - z))
    return best
  }

  /** The live SAM or shell (owner, seq), if any. */
  find(owner: number, seq: number): GunProjectile | null {
    for (const p of this.projectiles) if (p.alive && p.owner === owner && p.seq === seq) return p
    return null
  }

  /** Every live SAM and shell as a CIWS sees it. */
  interceptables(out: Interceptable[] = []): Interceptable[] {
    let k = 0
    for (const p of this.projectiles) if (p.alive) out.push(asInterceptable(p, 1, (this.ipool[k++] ??= { store: 1, owner: 0, seq: 0, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })))
    return out
  }
  private ipool: Interceptable[] = []

  /**
   * A SAM leaves a cell or a shell leaves the muzzle. With authority: refused (null) unless the owner mans that mount
   * (a SAM launcher for a SAM, the gun for a shell), it has a cell or a shell in the budget, and it starts near the
   * mount on its ship.
   */
  fire(l: GunLaunch, team?: number): GunProjectile | null {
    const g = this.gunners.get(l.owner)
    if (this.authority) {
      if (!g || g.mount !== l.mount || g.ship !== l.ship) return null
      const kind = WEAPON_MOUNTS[g.mount]!.kind
      if ((l.kind === "sam" && kind !== "sam") || (l.kind === "shell" && kind !== "gun")) return null
      if (l.kind === "sam" ? g.cells < 1 : g.shells < 1) return null
      const at = this.mountAt(g, mw)
      if (at && Math.hypot(l.x - at[0], l.y - at[1], l.z - at[2]) > 60) return null
      const sp = Math.hypot(l.vx, l.vy, l.vz)
      const want = l.kind === "sam" ? GUNNERY.sam.eject : GUNNERY.gun.muzzle
      if (sp > want + 80) return null
      if (l.kind === "sam") g.cells--
      else g.shells--
    }
    if (this.find(l.owner, l.seq)) return null
    const p = this.projectiles.find((p) => !p.alive) ?? this.projectiles[0]!
    p.kind = l.kind
    p.owner = l.owner
    p.team = team ?? g?.team ?? -1
    p.seq = l.seq
    p.ship = l.ship
    p.target = l.kind === "sam" ? l.target : -1
    p.decoy = null
    p.ignore = -Infinity
    p.t0 = l.t
    p.x = l.x
    p.y = l.y
    p.z = l.z
    p.vx = l.vx
    p.vy = l.vy
    p.vz = l.vz
    p.speed = Math.hypot(l.vx, l.vy, l.vz)
    p.ax = p.ay = p.az = 0
    p.age = 0
    p.alive = true
    // Heard late: fly it up to the world's time (no fuse on the way).
    const dt = PLANE.tick
    while (p.t0 + p.age + dt <= this.t + 1e-9) {
      if (p.kind === "shell") {
        shellStep(p, dt)
        p.age += dt
      } else guideSam(p, dt, false, 0, 0, 0, 0, 0, 0)
    }
    return p
  }

  /** Advances to sea time t in fixed steps; `targets.jets` are the jets now (at t). */
  step(t: number, targets: GunneryTargets): void {
    const dt = PLANE.tick
    if (t - this.t > 2) this.t = t - dt
    const jets = targets.jets
    while (this.t + dt <= t) {
      this.t += dt
      const back = this.t - t
      const sub = this.sub
      sub.length = 0
      for (let i = 0; i < jets.length; i++) {
        const tg = jets[i]!
        const s = (this.subPool[i] ??= { id: 0, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, alive: true })
        s.id = tg.id
        s.team = tg.team
        s.alive = tg.alive
        s.vx = tg.vx
        s.vy = tg.vy
        s.vz = tg.vz
        s.x = tg.x + tg.vx * back
        s.y = tg.y + tg.vy * back
        s.z = tg.z + tg.vz * back
        sub.push(s)
      }
      this.tick(dt, sub, targets.flares ?? [])
    }
  }

  private tick(dt: number, targets: readonly Target[], flares: readonly LiveFlare[]): void {
    const t = this.t
    if (this.authority) this.budgets(dt)
    for (const p of this.projectiles) {
      if (!p.alive) continue
      if (p.t0 + p.age + dt > t + 1e-9) continue
      const ox = p.x
      const oy = p.y
      const oz = p.z
      let lost = false
      if (p.kind === "shell") {
        shellStep(p, dt)
        p.age += dt
      } else if (this.guide(p, dt, targets, flares, t)) lost = true
      // Proximity fuse on enemy jets.
      const fuse = p.kind === "sam" ? GUNNERY.sam.fuse : GUNNERY.gun.fuse
      const arm = p.kind === "sam" ? GUNNERY.sam.arm : GUNNERY.gun.arm
      if (p.age >= arm) {
        let best: Target | null = null
        let bestD = fuse * fuse
        let bestK = 0
        for (const tg of targets) {
          if (!tg.alive || !canHurt(p.team, p.owner, tg.team, tg.id)) continue
          const qx = tg.x - p.x
          const qy = tg.y - p.y
          const qz = tg.z - p.z
          if (qx * qx + qy * qy + qz * qz > 200 * 200) continue
          const k = sweep(ox, oy, oz, p.x, p.y, p.z, tg.x - tg.vx * dt, tg.y - tg.vy * dt, tg.z - tg.vz * dt, tg.x, tg.y, tg.z, d2)
          if (d2[0] <= bestD && k < 1) {
            best = tg
            bestD = d2[0]
            bestK = k
          }
        }
        if (best) {
          this.burst(p, ox + (p.x - ox) * bestK, oy + (p.y - oy) * bestK, oz + (p.z - oz) * bestK, targets, best.id, "air")
          continue
        }
        if (p.decoy) {
          flareAt(p.decoy, t, tp)
          if ((tp[0] - p.x) ** 2 + (tp[1] - p.y) ** 2 + (tp[2] - p.z) ** 2 < 8 * 8) {
            this.burst(p, p.x, p.y, p.z, targets, -1, "air")
            continue
          }
        }
      }
      if (lost) {
        this.burst(p, p.x, p.y, p.z, targets, -1, "air")
        continue
      }
      const kind = p.y < MAX_PEAK ? groundHit(this.ground, p.x, p.y, p.z, t) : ""
      if (kind) {
        let skip = false
        let sh: GroundShip | null = null
        if (kind === "ship") {
          sh = shipAt(this.ground, p.x, p.y, p.z, lp)
          skip = !!sh && sh.id === p.ship && p.age < 1
        }
        if (!skip) {
          const y = kind === "sea" && this.ground.sea ? seaHeight(this.ground.sea, p.x, p.z, t) : p.y
          this.strike(p, kind, sh, ox, oy, oz, y)
          this.burst(p, p.x, y, p.z, targets, -1, kind)
          continue
        }
      }
      const life = p.kind === "sam" ? GUNNERY.sam.life : GUNNERY.gun.life
      if (p.age >= life) this.burst(p, p.x, p.y, p.z, targets, -1, "air")
    }
  }

  /** SAM guidance for one step: flares (by chance), then PN on its target or decoy. True when it just lost its target
   *  out of the seeker's gimbal (it overshot): the caller bursts it there. */
  private guide(p: GunProjectile, dt: number, targets: readonly Target[], flares: readonly LiveFlare[], t: number): boolean {
    const c = GUNNERY.sam
    let target: Target | null = null
    if (p.target >= 0) {
      for (const x of targets) if (x.id === p.target && x.alive) target = x
      if (!target) p.target = -1
    }
    if (target && !p.decoy) {
      const dx = target.x - p.x
      const dy = target.y - p.y
      const dz = target.z - p.z
      if (dx * dx + dy * dy + dz * dz < c.seduceRange * c.seduceRange)
        for (const f of flares) {
          if (!f.live || f.owner !== target.id || t < f.t0 || t - f.t0 > c.seduce || f.t0 < p.ignore) continue
          // One coin per burst: a failed one makes the SAM ignore the rest of that burst.
          if (!samDecoyed(p.owner, p.seq, f)) {
            p.ignore = f.t0 + c.seduce + 0.5
            continue
          }
          flareAt(f, t, tp)
          const rx = tp[0] - p.x
          const ry = tp[1] - p.y
          const rz = tp[2] - p.z
          const r = Math.hypot(rx, ry, rz)
          if (r > 1 && (rx * p.vx + ry * p.vy + rz * p.vz) / (r * (p.speed || 1)) > Math.cos(c.gimbal)) {
            p.decoy = f
            p.target = -1
            target = null
            this.events.push({ k: "decoy", owner: p.owner, seq: p.seq })
            break
          }
        }
    }
    if (p.decoy) {
      const f = p.decoy
      if (!f.live) p.decoy = null
      flareAt(f, t, tp)
      const fv = flareVelApprox(f, t)
      if (!guideSam(p, dt, p.decoy !== null, tp[0], tp[1], tp[2], fv[0], fv[1], fv[2])) p.decoy = null
    } else if (target) {
      if (!guideSam(p, dt, true, target.x, target.y, target.z, target.vx, target.vy, target.vz)) {
        p.target = -1
        return true
      }
    } else guideSam(p, dt, false, 0, 0, 0, 0, 0, 0)
    return false
  }

  /** A projectile that struck the world: a carrier hit (direct) or a shell's near miss in the water. */
  private strike(p: GunProjectile, kind: ImpactKind, sh: GroundShip | null, px: number, py: number, pz: number, seaY: number): void {
    const w: GunWeapon = p.kind === "sam" ? "sam" : "shell"
    if (kind === "ship") {
      if (!sh || sh.id === undefined) return
      worldToShip(sh, p.x, p.y, p.z, lp)
      const before = worldToShip(sh, px, py, pz, lq)
      if (before[1] >= 26 && lp[1] < 26) lp[1] = 26
      this.events.push({ k: "ship", ship: sh.id, owner: p.owner, w, x: lp[0], y: lp[1], z: lp[2], near: 0 })
      return
    }
    if (kind !== "sea" || p.kind !== "shell" || !this.ground.ships) return
    for (const s of this.ground.ships) {
      if (s.id === undefined || Math.abs(p.x - s.x) > 240 || Math.abs(p.z - s.z) > 240) continue
      const l = worldToShip(s, p.x, seaY, p.z, lp)
      const d = waterlineDistance(l[0], l[2])
      if (d <= GUNNERY.gun.near) this.events.push({ k: "ship", ship: s.id, owner: p.owner, w, x: l[0], y: 0, z: l[2], near: Math.max(0.5, d) })
    }
  }

  private burst(p: GunProjectile, x: number, y: number, z: number, targets: readonly Target[], on: number, surface: "air" | ImpactKind): void {
    p.alive = false
    this.events.push({ k: "gboom", owner: p.owner, seq: p.seq, kind: p.kind, x, y, z, on, surface })
    if (!this.authority) return
    const w: GunWeapon = p.kind === "sam" ? "sam" : "shell"
    for (const tg of targets) {
      if (!tg.alive || !canHurt(p.team, p.owner, tg.team, tg.id)) continue
      const d = Math.hypot(tg.x - x, tg.y - y, tg.z - z)
      const dmg = p.kind === "sam" ? samDamage(d) : shellDamage(d)
      if (dmg > 0) this.events.push({ k: "hurt", on: tg.id, dmg, by: p.owner, w })
    }
  }

  private budgets(dt: number): void {
    const c = GUNNERY.ciws
    for (const g of this.gunners.values()) {
      const kind = WEAPON_MOUNTS[g.mount]!.kind
      if (kind === "ciws") g.rounds = Math.min(c.rate * 0.6, g.rounds + c.rate * dt * 1.15)
      // Slightly quicker than the client's own reload, so a legitimate launch is never refused for clock skew.
      else if (kind === "sam") g.cells = Math.min(GUNNERY.sam.cells, g.cells + dt / (GUNNERY.sam.reload * 0.9))
      else g.shells = Math.min(2, g.shells + dt / (GUNNERY.gun.interval * 0.9))
    }
  }

  /** Forces a projectile's burst where the authority says it burst (a client snapping to the room). */
  snap(owner: number, seq: number): GunProjectile | null {
    const p = this.find(owner, seq)
    if (p) p.alive = false
    return p
  }
}
const mv: Vec3 = [0, 0, 0]
const mw: Vec3 = [0, 0, 0]
const mf: Vec3 = [0, 0, 0]
const tp: Vec3 = [0, 0, 0]
const lp: Vec3 = [0, 0, 0]
const lq: Vec3 = [0, 0, 0]
const fvv: Vec3 = [0, 0, 0]

/** A flare's velocity by finite difference (shared/combat.ts flareVel without importing its drag constant twice). */
function flareVelApprox(f: LiveFlare, t: number): Vec3 {
  const a = flareAt(f, t, fva)
  const b = flareAt(f, t + 0.01, fvv)
  fvv[0] = (b[0] - a[0]) / 0.01
  fvv[1] = (b[1] - a[1]) / 0.01
  fvv[2] = (b[2] - a[2]) / 0.01
  return fvv
}
const fva: Vec3 = [0, 0, 0]

/** A projectile or a shared/combat.ts missile/bomb as a CIWS target. */
export function asInterceptable(p: GunProjectile | Missile, store: 0 | 1, out: Interceptable): Interceptable {
  out.store = store
  out.owner = p.owner
  out.seq = p.seq
  out.team = p.team
  out.x = p.x
  out.y = p.y
  out.z = p.z
  out.vx = p.vx
  out.vy = p.vy
  out.vz = p.vz
  return out
}

/**
 * A SAM flies one step toward (px, py, pz) moving at (qx, qy, qz): boost straight out of the cell, then the motor, and
 * pure proportional navigation (as shared/combat.ts `guide`, with the SAM's tuning) behind an autopilot lag. `track`
 * false flies it dumb. Returns false when the target left the seeker's gimbal.
 */
export function guideSam(m: GunProjectile, dt: number, track: boolean, px: number, py: number, pz: number, qx: number, qy: number, qz: number): boolean {
  const c = GUNNERY.sam
  m.age += dt
  if (m.age < c.burn) m.speed = Math.min(c.topSpeed, m.speed + c.accel * dt)
  else m.speed = Math.max(80, m.speed - c.drag * m.speed * m.speed * dt)
  const s = Math.hypot(m.vx, m.vy, m.vz) || 1
  const ux = m.vx / s
  const uy = m.vy / s
  const uz = m.vz / s
  let cx = 0
  let cy = 0
  let cz = 0
  let seen = true
  const steering = m.age > c.boost
  if (track && steering) {
    const rx = px - m.x
    const ry = py - m.y
    const rz = pz - m.z
    const r2 = rx * rx + ry * ry + rz * rz
    const r = Math.sqrt(r2)
    if (r > 1e-3 && (rx * ux + ry * uy + rz * uz) / r < Math.cos(c.gimbal)) seen = false
    else if (r > 1e-3) {
      const wx = qx - m.vx
      const wy = qy - m.vy
      const wz = qz - m.vz
      const ox = (ry * wz - rz * wy) / r2
      const oy = (rz * wx - rx * wz) / r2
      const oz = (rx * wy - ry * wx) / r2
      cx = c.nav * (oy * m.vz - oz * m.vy)
      cy = c.nav * (oz * m.vx - ox * m.vz)
      cz = c.nav * (ox * m.vy - oy * m.vx)
      cy += G
    }
  }
  const limit = c.maxG * G * Math.max(0.2, Math.min(1, m.speed / c.bite))
  const cl = Math.hypot(cx, cy, cz)
  if (cl > limit) {
    cx *= limit / cl
    cy *= limit / cl
    cz *= limit / cl
  }
  const k = 1 - Math.exp(-dt / c.lag)
  m.ax += (cx - m.ax) * k
  m.ay += (cy - m.ay) * k
  m.az += (cz - m.az) * k
  const along = m.ax * ux + m.ay * uy + m.az * uz
  const lx = m.ax - along * ux
  const ly = m.ay - along * uy
  const lz = m.az - along * uz
  // In the boost the motor holds it on the launcher's line (no gravity sag while it clears the ship).
  let nx = ux + (lx / m.speed) * dt
  let ny = uy + ((ly - (steering ? G : 0)) / m.speed) * dt
  let nz = uz + (lz / m.speed) * dt
  const nl = Math.hypot(nx, ny, nz) || 1
  nx /= nl
  ny /= nl
  nz /= nl
  m.vx = nx * m.speed
  m.vy = ny * m.speed
  m.vz = nz * m.speed
  m.x += m.vx * dt
  m.y += m.vy * dt
  m.z += m.vz * dt
  return seen
}

// ---- wire -------------------------------------------------------------------------------------------------------------------

/**
 * A manned turret on the wire (room → everyone, ~10 Hz): [ship, mount, yaw (mrad), pitch (mrad), trigger 0/1, gunner].
 * Unlisted mounts are unmanned (drawn easing back to rest).
 */
export type TurretTuple = [ship: number, mount: number, yaw: number, pitch: number, firing: number, gunner: number]
export const TURRET_TUPLE_LENGTH = 6

export const packTurret = (ship: number, g: Pick<Gunner, "mount" | "yaw" | "pitch" | "firing" | "id">): TurretTuple => [ship, g.mount, Math.round(g.yaw * 1000), Math.round(g.pitch * 1000), g.firing ? 1 : 0, g.id]

export function isTurretTuple(v: unknown): v is TurretTuple {
  if (!Array.isArray(v) || v.length !== TURRET_TUPLE_LENGTH) return false
  for (const n of v) if (!Number.isInteger(n) || Math.abs(n) > 1e7) return false
  return v[0] >= 0 && v[1] >= 0 && v[1] < WEAPON_MOUNTS.length && (v[4] === 0 || v[4] === 1) && v[5] >= 0
}

/** A gunner's aim (client → room): [yaw (mrad), pitch (mrad), trigger 0/1]. */
export type AimTuple = [yaw: number, pitch: number, firing: number]
export const packAim = (yaw: number, pitch: number, firing: boolean): AimTuple => [Math.round(yaw * 1000), Math.round(pitch * 1000), firing ? 1 : 0]
export const isAimTuple = (v: unknown): v is AimTuple => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && Math.abs(n) <= 7000) && (v[2] === 0 || v[2] === 1)

/** A SAM or shell launch on the wire: [seq, kind (0 SAM, 1 shell), ship, mount, sea time, x, y, z, vx, vy, vz, target]. */
export type GunFireTuple = [seq: number, kind: number, ship: number, mount: number, t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, target: number]
export const GUN_FIRE_LENGTH = 12

const r1 = (v: number, k: number) => Math.round(v * k) / k
export const packGunFire = (l: GunLaunch): GunFireTuple => [l.seq, l.kind === "sam" ? 0 : 1, l.ship, l.mount, r1(l.t, 1e3), r1(l.x, 100), r1(l.y, 100), r1(l.z, 100), r1(l.vx, 100), r1(l.vy, 100), r1(l.vz, 100), l.target]
export const unpackGunFire = (owner: number, a: GunFireTuple): GunLaunch => ({ owner, seq: a[0], kind: a[1] === 0 ? "sam" : "shell", ship: a[2], mount: a[3], t: a[4], x: a[5], y: a[6], z: a[7], vx: a[8], vy: a[9], vz: a[10], target: a[11] })

export function isGunFireTuple(v: unknown): v is GunFireTuple {
  if (!Array.isArray(v) || v.length !== GUN_FIRE_LENGTH) return false
  for (const n of v) if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e7) return false
  return Number.isInteger(v[0]) && v[0] >= 0 && (v[1] === 0 || v[1] === 1) && Number.isInteger(v[2]) && v[2] >= 0 && Number.isInteger(v[3]) && v[3] >= 0 && v[3] < WEAPON_MOUNTS.length && Number.isInteger(v[11]) && v[11] >= -1
}

/** A SAM or shell burst on the wire: [owner, seq, kind (0 SAM, 1 shell), x, y, z, jet hit (-1), surface (0 air, 1 sea, 2 land, 3 ship)]. */
export type GunBoomTuple = [owner: number, seq: number, kind: number, x: number, y: number, z: number, on: number, surface: number]
export const GUN_BOOM_LENGTH = 8
const SURFACES = ["air", "sea", "land", "ship"] as const

export const packGunBoom = (e: Extract<GunneryEvent, { k: "gboom" }>): GunBoomTuple => [e.owner, e.seq, e.kind === "sam" ? 0 : 1, r1(e.x, 10), r1(e.y, 10), r1(e.z, 10), e.on, SURFACES.indexOf(e.surface)]
export const unpackGunBoom = (b: GunBoomTuple): Extract<GunneryEvent, { k: "gboom" }> => ({ k: "gboom", owner: b[0], seq: b[1], kind: b[2] === 0 ? "sam" : "shell", x: b[3], y: b[4], z: b[5], on: b[6], surface: SURFACES[b[7]] ?? "air" })

export function isGunBoomTuple(v: unknown): v is GunBoomTuple {
  if (!Array.isArray(v) || v.length !== GUN_BOOM_LENGTH) return false
  for (const n of v) if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e7) return false
  return Number.isInteger(v[0]) && Number.isInteger(v[1]) && (v[2] === 0 || v[2] === 1) && Number.isInteger(v[6]) && Number.isInteger(v[7]) && v[7] >= 0 && v[7] < SURFACES.length
}

/** An intercept claim (client → room): [store owner, store seq, store kind (0 missile/bomb, 1 SAM/shell)]. */
export type InterceptTuple = [owner: number, seq: number, store: number]
export const isInterceptTuple = (v: unknown): v is InterceptTuple => Array.isArray(v) && v.length === 3 && Number.isInteger(v[0]) && v[0] >= 0 && Number.isInteger(v[1]) && v[1] >= 0 && (v[2] === 0 || v[2] === 1)
