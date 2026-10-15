// Jet weapons: tuning, per-aircraft loadouts, the pilot's weapon state (gun heat, missiles, bombs, flares) and the
// heat-seeker's lock. Pure and DOM-free, fixed timestep (PLANE.tick), deterministic for the same inputs. The
// projectiles, missile guidance, bombs, flare decoys and damage live in shared/combat.ts.
//
// Battlefield-style: each aircraft carries an ordered list of weapons (`LOADOUTS`), selected with 1/2/… or cycled,
// fired with Space/LMB, plus flares on their own key. The F/A-18E has the M61 cannon (hold to fire, a heat bar instead
// of ammo) and two AIM-9 heat-seekers that rearm one at a time. The F-35C strike bomber has no gun: two self-defence
// AIM-9s and bay bombs. The seeker locks onto the enemy jet nearest the boresight inside a cone; holding it in the cone
// for `lockTime` locks. Firing locked homes, firing unlocked is a dumbfire that only a lucky proximity fuse turns into a
// hit.

import { VEHICLES, type VehicleKind } from "./vehicles"

/** Weapon kinds. A kind's tuning is WEAPONS[kind]; which aircraft carry it is LOADOUTS. */
export type WeaponKind = "gun" | "missile" | "bomb"
export const WEAPON_KINDS: readonly WeaponKind[] = ["gun", "missile", "bomb"]
/** What can hurt a jet (or a boat): its own kinds plus the ships' guns (shared/gunnery.ts: CIWS rounds, SAMs, 5-inch
 *  shells) and the boat's 25 mm autocannon (shared/boat.ts, `cannon`). */
export type KillWeapon = WeaponKind | "ciws" | "sam" | "shell" | "cannon"
export const KILL_WEAPONS: readonly KillWeapon[] = ["gun", "missile", "bomb", "ciws", "sam", "shell", "cannon"]
export const isKillWeapon = (v: unknown): v is KillWeapon => typeof v === "string" && (KILL_WEAPONS as readonly string[]).includes(v)

/** Aircraft types (shared/vehicles.ts). */
export type { VehicleKind }

/** What an aircraft carries: its selectable weapons in slot order (key 1 = the first), store counts and flares. */
export type LoadoutSpec = {
  readonly name: string
  readonly weapons: readonly WeaponKind[]
  readonly missiles: number
  readonly bombs: number
  readonly flares: number
}

export const LOADOUTS: Readonly<Record<VehicleKind, LoadoutSpec>> = {
  hornet: { name: "F/A-18E", weapons: ["gun", "missile"], missiles: 2, bombs: 0, flares: 2 },
  /** Strike bomber: no gun. Four bombs, the two in the bay first, then the two on the wing pylons (VEHICLES.f35.bombs);
   *  they fall ballistically for now (guided bombs and ship/ground damage come later). */
  f35: { name: "F-35C", weapons: ["missile", "bomb"], missiles: 2, bombs: 4, flares: 2 },
}

/** The Mk VII interceptor boat (shared/boat.ts): only its 25 mm turret (`GUN` there, not the jets' M61), no stores. As
 *  a fighter in the combat world it carries nothing the jets' budgets would refill. */
export const BOAT_LOADOUT: LoadoutSpec = { name: "MK VII", weapons: [], missiles: 0, bombs: 0, flares: 0 }

const DEG = Math.PI / 180

/** Every tunable in one place. SI units unless noted. */
export const WEAPONS = {
  gun: {
    /** Rounds per second while the trigger is held (an arcade M61: half the real 6,000 rpm). */
    rate: 50,
    /** Muzzle speed (m/s) added to the jet's velocity along the boresight. */
    muzzle: 1050,
    /** Round lifetime (s): range ≈ (muzzle + jet speed) · life ≈ 1.4 km at the optimal speed. */
    life: 1.18,
    /** Gravity on the rounds (fraction of g). */
    gravity: 1,
    /** Cone of the dispersion (half-angle, rad), uniform over the disc. */
    spread: 0.32 * DEG,
    /** Every Nth round is a tracer (the others are simulated but not drawn). */
    tracer: 3,
    /** Damage per round on an enemy jet (100 health): 50 rounds, a second of solid hits, kill. */
    damage: 2,
    /** Hit sphere around a jet's centre (m): generous, the arcade way, and it covers the remote-interpolation error. */
    hitRadius: 6.5,
    /** Seconds of continuous fire from cold to overheated, cooling rate (heat per second) and the delay before it cools. */
    heatTime: 3.2,
    cool: 0.42,
    coolDelay: 0.25,
    /** An overheated gun stays silent until the heat is back down to this. */
    restart: 0.3,
    /** Muzzle position on the jet (body frame, metres from the centre): the M61 sits above the radome. */
    muzzleAt: [0, 0.75, 8.2] as const,
  },
  missile: {
    /** An empty rail rearms after `reload` seconds, one at a time (counts per aircraft: LOADOUTS). */
    reload: 10,
    /** Minimum time between two launches (s). */
    interval: 0.7,
    /** Seeker: lock cone half-angle off the boresight (rad), lock range and minimum range (m), seconds to lock. The
     *  lock only builds while the target stays inside this tight cone (outside it the timer bleeds off at `bleed`×). */
    cone: 6 * DEG,
    range: 2500,
    minRange: 120,
    lockTime: 1.4,
    bleed: 2,
    /** The seeker keeps tracking its target within cone · keep and range · keepRange (a completed lock holds there). */
    keep: 3,
    keepRange: 1.1,
    /** Flight: speed gained per second while the motor burns, top speed, burn time, drag after burnout (1/m). */
    accel: 230,
    topSpeed: 640,
    burn: 2.6,
    drag: 0.00011,
    /** Self-destructs after this long (s). */
    life: 7,
    /** Ejection off the rail: the missile drops this fast (m/s) for the first `drop` seconds before it steers. */
    ejectDrop: 6,
    drop: 0.18,
    /** Proportional navigation constant, achievable lateral acceleration (g) at top speed and the autopilot lag (s).
     *  Battlefield-style: a locked missile out-turns any jet (it pulls ~2.5× a jet's best turn), so flares are the escape;
     *  only a late break at the edge of range can still make it miss. */
    nav: 3.4,
    maxG: 35,
    lag: 0.12,
    /** Seeker gimbal (rad off the missile's nose): a target outside it is lost for good (the missile flies on dumb). */
    gimbal: 42 * DEG,
    /** Proximity fuse radius (m), armed after `arm` seconds. Damage falls from `damage` at the centre to `edge` at the radius. */
    fuse: 12,
    arm: 0.35,
    damage: 74,
    edge: 42,
    /** Missile rails on the jet (body frame, from the centre): the wingtip launchers, left first. */
    rails: [
      [6.78, 0.05, -3.1],
      [-6.78, 0.05, -3.1],
    ] as const,
  },
  bomb: {
    /** A 500 lb class bomb falling from the bay: rearm time per bomb, release interval, drag (1/m), eject speed down. */
    reload: 20,
    interval: 0.5,
    drag: 0.00004,
    eject: 4,
    /** Blast radius (m) and damage at the centre and at the edge (jets caught in it; ships take none yet). */
    radius: 30,
    damage: 100,
    edge: 30,
    /** Bomb bay (body frame, from the centre). */
    bay: [0, -1.2, 0.5] as const,
    /** Self-destructs after this long (s). */
    life: 40,
  },
  flare: {
    /** Seconds to reload one burst (one at a time; bursts per aircraft: LOADOUTS). */
    reload: 16,
    /** Pairs per burst, seconds between pairs, sideways and downward ejection (m/s). */
    pairs: 3,
    interval: 0.12,
    side: 22,
    down: 14,
    /** Linear air drag (1/s): flares shed the jet's speed quickly and sink at g / drag. */
    drag: 1.3,
    /** Burn time (s). */
    life: 3.6,
    /** A flare seduces a missile tracking its jet within its first `seduce` seconds, if the missile is closer than
     *  `range` (m) and the flare is inside the missile's seeker gimbal. */
    seduce: 0.9,
    range: 2000,
    /** A jet that just flared cannot be locked for this long (s), and any lock on it breaks. */
    blind: 1.6,
  },
  health: {
    max: 100,
    /** Damage states (fraction of max): trailing smoke below `smoke`, on fire below `fire`. */
    smoke: 0.5,
    fire: 0.25,
    /** Field repair (Battlefield-style): after `repairDelay` s without damage the jet heals `repair` per second. */
    repairDelay: 10,
    repair: 4,
    /** A jet that crashes within this long of taking damage credits the last attacker with the kill (s). */
    credit: 12,
  },
} as const

/** The pilot's weapons state: aircraft, selected slot, the gun's heat, stores and flares left, and the seeker's lock. */
export type Loadout = {
  vehicle: VehicleKind
  spec: LoadoutSpec
  /** Index into spec.weapons. */
  slot: number
  heat: number
  overheated: boolean
  /** Seconds since the gun last fired (cooling starts after coolDelay). */
  idle: number
  /** Fractional rounds owed to the trigger (carries the 50 rps rate across 60 Hz steps). */
  owed: number
  /** Rounds fired this sortie (seeds the dispersion and the tracer cadence). */
  round: number
  missiles: number
  /** Seconds until the next missile is back on a rail (counts down while one is missing). */
  rearm: number
  /** Seconds until another launch or release is allowed. */
  launchIn: number
  /** Missiles and bombs released this sortie (their sequence numbers: one counter for both). */
  launched: number
  bombs: number
  /** Seconds until the next bomb is back in the bay. */
  bombIn: number
  flares: number
  /** Seconds until the next flare burst is reloaded. */
  flareIn: number
  lock: Lock
}

/** The seeker: the jet it tracks (-1 none), seconds held in the cone, locked or not. */
export type Lock = { target: number; time: number; locked: boolean }

export function makeLoadout(vehicle: VehicleKind = "hornet"): Loadout {
  const spec = LOADOUTS[vehicle]
  return {
    vehicle,
    spec,
    slot: 0,
    heat: 0,
    overheated: false,
    idle: 10,
    owed: 0.999,
    round: 0,
    missiles: spec.missiles,
    rearm: 0,
    launchIn: 0,
    launched: 0,
    bombs: spec.bombs,
    bombIn: 0,
    flares: spec.flares,
    flareIn: 0,
    lock: { target: -1, time: 0, locked: false },
  }
}

/** The selected weapon. */
export const weaponOf = (l: Loadout): WeaponKind => l.spec.weapons[l.slot] ?? l.spec.weapons[0]!

/** Selects slot `n` (0-based) if the aircraft has it; returns true when the selection changed. */
export function selectSlot(l: Loadout, n: number): boolean {
  if (n < 0 || n >= l.spec.weapons.length || n === l.slot) return false
  l.slot = n
  return true
}

/** Steps the selection by `dir` (±1) through the weapons this aircraft has, wrapping. */
export function cycleWeapon(l: Loadout, dir: number): boolean {
  const n = l.spec.weapons.length
  if (n < 2) return false
  l.slot = (((l.slot + Math.sign(dir)) % n) + n) % n
  return true
}

/** Fresh sortie, optionally in another aircraft: everything full and cold (keeps the slot when it still exists). */
export function rearm(l: Loadout, vehicle: VehicleKind = l.vehicle): void {
  const slot = l.slot
  Object.assign(l, makeLoadout(vehicle))
  if (slot < l.spec.weapons.length) l.slot = slot
}

/**
 * Advances the gun by one step with the trigger held or not. Returns how many rounds leave the muzzle this step (0, 1
 * or occasionally 2 at 50 rps and 60 Hz), and heats or cools the barrel.
 */
export function gunStep(l: Loadout, trigger: boolean, dt: number): number {
  const g = WEAPONS.gun
  if (!l.spec.weapons.includes("gun")) return 0
  if (l.overheated && l.heat <= g.restart) l.overheated = false
  let n = 0
  if (trigger && !l.overheated) {
    l.owed += g.rate * dt
    n = Math.floor(l.owed)
    l.owed -= n
    l.heat = Math.min(1, l.heat + dt / g.heatTime)
    l.idle = 0
    if (l.heat >= 1) {
      l.overheated = true
      l.owed = 0
    }
  } else {
    // The first round of a burst leaves at once.
    l.owed = trigger ? 0 : 0.999
    l.idle += dt
    if (l.idle > g.coolDelay) l.heat = Math.max(0, l.heat - g.cool * dt)
  }
  return n
}

/** Missile and bomb rearm, the launch interval, flare reload. Call every step while the jet flies. */
export function loadoutStep(l: Loadout, dt: number): void {
  const m = WEAPONS.missile
  l.launchIn = Math.max(0, l.launchIn - dt)
  if (l.missiles < l.spec.missiles) {
    l.rearm -= dt
    if (l.rearm <= 0) {
      l.missiles++
      l.rearm = l.missiles < l.spec.missiles ? m.reload : 0
    }
  }
  if (l.bombs < l.spec.bombs) {
    l.bombIn -= dt
    if (l.bombIn <= 0) {
      l.bombs++
      l.bombIn = l.bombs < l.spec.bombs ? WEAPONS.bomb.reload : 0
    }
  }
  const f = WEAPONS.flare
  if (l.flares < l.spec.flares) {
    l.flareIn -= dt
    if (l.flareIn <= 0) {
      l.flares++
      l.flareIn = l.flares < l.spec.flares ? f.reload : 0
    }
  }
}

/** Takes a missile off a rail if one is ready. Returns the launch's sequence number, or -1. */
export function takeMissile(l: Loadout): number {
  if (l.missiles <= 0 || l.launchIn > 0) return -1
  if (l.missiles === l.spec.missiles) l.rearm = WEAPONS.missile.reload
  l.missiles--
  l.launchIn = WEAPONS.missile.interval
  return l.launched++
}

/** Releases a bomb from the bay if one is loaded. Returns its sequence number, or -1. */
export function takeBomb(l: Loadout): number {
  if (l.bombs <= 0 || l.launchIn > 0) return -1
  if (l.bombs === l.spec.bombs) l.bombIn = WEAPONS.bomb.reload
  l.bombs--
  l.launchIn = WEAPONS.bomb.interval
  return l.launched++
}

/** Spends a flare burst if one is loaded. */
export function takeFlares(l: Loadout): boolean {
  if (l.flares <= 0) return false
  if (l.flares === l.spec.flares) l.flareIn = WEAPONS.flare.reload
  l.flares--
  return true
}

/** Which rail the next missile leaves from (alternating, left first) on `vehicle`: body frame from its centre. */
export const railOf = (seq: number, vehicle: VehicleKind = "hornet"): readonly [number, number, number] => {
  const r = VEHICLES[vehicle].rails
  return r[seq % r.length]!
}

/** The station the next bomb leaves from: stores go in release order (VEHICLES[vehicle].bombs), so with `bombs` of
 *  `max` left it is station `max - bombs`, and the last one rearmed is the next to go. Body frame from the centre. */
export const bombStation = (vehicle: VehicleKind, bombs: number, max: number): readonly [number, number, number] => {
  const b = VEHICLES[vehicle].bombs
  return b[Math.max(0, Math.min(b.length - 1, max - bombs))]!
}

// ---- seeker -------------------------------------------------------------------------------------------------------------

/** A jet as weapons see it: id, team, centre and velocity. `alive` false for wrecks and jets on deck. */
/** `surface`: a boat (shared/boat.ts): rounds, blasts and shells hit it, heat-seekers never lock it. */
export type Target = { id: number; team: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; alive: boolean; surface?: boolean }

export function makeTarget(id = -1, team = -1): Target {
  return { id, team, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, alive: true }
}

/** The shooter for the seeker: position, unit boresight and team. */
export type Shooter = { x: number; y: number; z: number; fx: number; fy: number; fz: number; team: number }

/** Angle off the boresight (rad) and distance of a target, or null when behind/out of reach. */
function offBore(s: Shooter, t: Target, out: { angle: number; dist: number }): boolean {
  const dx = t.x - s.x
  const dy = t.y - s.y
  const dz = t.z - s.z
  const d = Math.hypot(dx, dy, dz)
  if (d < 1e-6) return false
  const c = (dx * s.fx + dy * s.fy + dz * s.fz) / d
  out.angle = Math.acos(Math.max(-1, Math.min(1, c)))
  out.dist = d
  return true
}

const ob = { angle: 0, dist: 0 }

/**
 * One seeker step while the missile is selected: keeps tracking the current target while it stays in the (wider)
 * keep cone, else picks the enemy nearest the boresight inside the lock cone. The lock builds over `lockTime` seconds
 * only while the target sits inside the tight lock cone (it bleeds off outside it); once locked it holds in the keep cone.
 * `blind(id)` is true for jets that just flared (they break the lock and cannot be picked). Returns true when the
 * lock state changed (a new target, locked, or lost), so the caller can tell the room.
 */
export function lockStep(lock: Lock, dt: number, s: Shooter, targets: Iterable<Target>, blind: (id: number) => boolean = () => false): boolean {
  const m = WEAPONS.missile
  const before = lock.target
  const was = lock.locked
  let keep: Target | null = null
  let keepIn = false
  let best: Target | null = null
  let bestAngle = Infinity
  for (const t of targets) {
    if (!t.alive || t.team === s.team || t.surface || blind(t.id)) continue
    if (!offBore(s, t, ob)) continue
    if (t.id === lock.target && ob.angle <= m.cone * m.keep && ob.dist <= m.range * m.keepRange && ob.dist >= m.minRange * 0.5) {
      keep = t
      keepIn = ob.angle <= m.cone
    }
    if (ob.angle <= m.cone && ob.dist <= m.range && ob.dist >= m.minRange && ob.angle < bestAngle) {
      best = t
      bestAngle = ob.angle
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
    if (!lock.locked) {
      lock.time = keep && !keepIn ? Math.max(0, lock.time - m.bleed * dt) : lock.time + dt
      if (lock.time >= m.lockTime) lock.locked = true
    }
  }
  return lock.target !== before || lock.locked !== was
}

export function clearLock(lock: Lock): void {
  lock.target = -1
  lock.time = 0
  lock.locked = false
}

// ---- determinism helpers ------------------------------------------------------------------------------------------------

/** A 0..1 hash of two integers (dispersion, debris). Same on every machine. */
export function hash01(a: number, b: number): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Can `a`'s weapons hurt `b`? Friendly fire is off: only another team (every carrier is its own, shared/crew.ts), never yourself. */
export const canHurt = (attackerTeam: number, attacker: number, victimTeam: number, victim: number): boolean => attacker !== victim && attackerTeam !== victimTeam

/** Damage state of a health value: 0 fine, 1 smoking, 2 burning, 3 destroyed. */
export function damageState(hp: number): 0 | 1 | 2 | 3 {
  const h = WEAPONS.health
  if (hp <= 0) return 3
  if (hp < h.max * h.fire) return 2
  if (hp < h.max * h.smoke) return 1
  return 0
}
