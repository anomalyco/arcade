// Air combat: cannon rounds, heat-seeking missiles, flare decoys and damage. Pure and DOM-free, fixed timestep
// (PLANE.tick), deterministic for the same inputs. Tuning in shared/weapons.ts.
//
// Who decides what (see CONTRACTS.md "Weapons"):
// - Rounds (`Bullets`): every client simulates its own rounds against the jets as it draws them and reports hits; the
//   room checks they are plausible (alive enemies within gun range, no more damage than the gun can deal) and applies
//   them. Everyone else draws a firing jet's rounds from its trigger state (cosmetic, same code, no hits).
// - Missiles, bombs and flares (`CombatWorld`): a launch, a release or a burst is an event (pose, velocity, target, sea time). The room
//   runs the authoritative world, guiding every missile against the latest relayed jets, decoying it with flares and
//   deciding detonation and damage; clients run the same world without authority to draw them, and snap a missile to
//   the room's detonation when it arrives. Offline, the local world has the authority.
// - Health lives in the room's world (`Fighter`); damage, kills and repair go out as events.
//
// World frame as shared/plane.ts: x east, y up, z south.

import { BOW_Z, DECK_X0, DECK_X1, DECK_Y, ISLAND, STERN_Z } from "./carrier-spec"
import { type Archipelago, terrainHeight } from "./islands"
import { PLANE, type Plane, type ShipPoseLike, type Vec3, bodyToWorld, worldToShip } from "./plane"
import { type Sea, seaHeight } from "./sea"
import { FLEET, waterlineDistance } from "./fleet"
import { BOAT_ARMOR, BOAT_HEALTH } from "./boat"
import { LOADOUTS, WEAPONS, type Target, type VehicleKind, type WeaponKind, type KillWeapon, bombStation, canHurt, hash01 } from "./weapons"

const G = 9.81
const MAX_PEAK = 640

/** A carrier rounds and stores can hit: its pose (settled, shared/fleet.ts), crew ship id and team when known. */
export type GroundShip = ShipPoseLike & { id?: number; team?: number }

/** What rounds and missiles can hit besides jets. */
export type Ground = { sea: Sea | null; arch: Archipelago | null; ships?: readonly GroundShip[] }

export type ImpactKind = "sea" | "land" | "ship"

const sv: Vec3 = [0, 0, 0]

/** What a point at sea time t is inside: the sea, an island, a carrier, or nothing (""). */
export function groundHit(g: Ground, x: number, y: number, z: number, t: number): ImpactKind | "" {
  if (y < 16) {
    if (g.sea ? y < seaHeight(g.sea, x, z, t) : y < 0) return "sea"
  }
  if (g.arch && y < MAX_PEAK && y < terrainHeight(g.arch, x, z)) return "land"
  return shipAt(g, x, y, z) ? "ship" : ""
}

/** The carrier whose hull or island contains world point (x, y, z), with the point in its ship-local frame in `local`. */
export function shipAt(g: Ground, x: number, y: number, z: number, local: Vec3 = sv): GroundShip | null {
  if (!g.ships) return null
  for (const sh of g.ships) {
    if (Math.abs(x - sh.x) > 220 || Math.abs(z - sh.z) > 220 || y > sh.heave + ISLAND.y1 + 2) continue
    const l = worldToShip(sh, x, y, z, local)
    if (l[0] > DECK_X0 && l[0] < DECK_X1 && l[2] > STERN_Z && l[2] < BOW_Z && l[1] < DECK_Y && l[1] > -12) return sh
    if (l[0] > ISLAND.x0 && l[0] < ISLAND.x1 && l[2] > ISLAND.z0 && l[2] < ISLAND.z1 && l[1] < ISLAND.y1) return sh
  }
  return null
}

/**
 * Closest approach of a point moving from a to b relative to a sphere centre moving from c to d over the same step.
 * Returns the step fraction 0..1 of the closest approach and writes the squared distance there into `out[0]`.
 */
export function sweep(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, out: [number]): number {
  // Relative start and motion.
  const rx = ax - cx
  const ry = ay - cy
  const rz = az - cz
  const mx = bx - ax - (dx - cx)
  const my = by - ay - (dy - cy)
  const mz = bz - az - (dz - cz)
  const mm = mx * mx + my * my + mz * mz
  let k = mm > 1e-12 ? -(rx * mx + ry * my + rz * mz) / mm : 0
  k = k < 0 ? 0 : k > 1 ? 1 : k
  const ex = rx + mx * k
  const ey = ry + my * k
  const ez = rz + mz * k
  out[0] = ex * ex + ey * ey + ez * ez
  return k
}

const d2: [number] = [0]

// ---- rounds -------------------------------------------------------------------------------------------------------------

/** A round hit a jet (`target`) or the world (`target` -1, `kind` what it struck) at (x, y, z); `ship` the carrier it
 *  struck (kind "ship"), when known. */
export type RoundHit = (owner: number, target: number, kind: ImpactKind | "jet", x: number, y: number, z: number, ship: GroundShip | null) => void

/**
 * Cannon rounds in flight: a fixed ring (the oldest round is recycled), structure of arrays, no allocation per round.
 * `fire` spawns a round, `step` flies them all one fixed step with gravity, against the jets and the world.
 */
export class Bullets {
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
  /** 0 = free, 1 = flying, 2 = flying tracer. */
  readonly state: Uint8Array
  /** True when this ring reports hits on jets (own rounds); cosmetic rings only hit the world. */
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
    this.state = new Uint8Array(cap)
  }

  clear(): void {
    this.state.fill(0)
    this.live = 0
  }

  /**
   * Fires round number `round` of `owner` from muzzle (x, y, z) along the boresight f with the jet's velocity v. The
   * jet's up (u) and left (l) axes spread it over the dispersion disc (hashed from owner and round, so every machine
   * fires the same pattern). `lead` (s) flies it ahead, to spread rounds fired within one step.
   */
  fire(owner: number, team: number, round: number, x: number, y: number, z: number, v: Vec3, f: Vec3, u: Vec3, l: Vec3, lead = 0): number {
    const g = WEAPONS.gun
    const i = this.next
    this.next = (i + 1) % this.cap
    if (!this.state[i]) this.live++
    const a = hash01(owner, round) * Math.PI * 2
    const r = Math.sqrt(hash01(owner ^ 0x5bd1, round)) * Math.tan(g.spread)
    const su = Math.sin(a) * r
    const sl = Math.cos(a) * r
    let dx = f[0] + u[0] * su + l[0] * sl
    let dy = f[1] + u[1] * su + l[1] * sl
    let dz = f[2] + u[2] * su + l[2] * sl
    const n = Math.hypot(dx, dy, dz)
    dx /= n
    dy /= n
    dz /= n
    this.vx[i] = v[0] + dx * g.muzzle
    this.vy[i] = v[1] + dy * g.muzzle
    this.vz[i] = v[2] + dz * g.muzzle
    this.x[i] = x + this.vx[i]! * lead
    this.y[i] = y + this.vy[i]! * lead
    this.z[i] = z + this.vz[i]! * lead
    this.age[i] = lead
    this.owner[i] = owner
    this.team[i] = team
    this.state[i] = round % g.tracer === 0 ? 2 : 1
    return i
  }

  /**
   * One step: gravity, then each round's path this step against every enemy jet (relative sweep, so fast crossing
   * targets are not skipped) and the world at sea time t. Targets hold their positions at the end of the step.
   */
  step(dt: number, t: number, targets: readonly Target[], ground: Ground, hit: RoundHit): void {
    if (!this.live) return
    const g = WEAPONS.gun
    const r2 = g.hitRadius * g.hitRadius
    const grav = G * g.gravity * dt
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
        for (let j = 0; j < targets.length; j++) {
          const tg = targets[j]!
          if (!tg.alive || !canHurt(this.team[i]!, this.owner[i]!, tg.team, tg.id)) continue
          // Quick reject: farther than the step's travel plus the hit radius.
          const qx = tg.x - bx
          const qy = tg.y - by
          const qz = tg.z - bz
          const reach = 40 + g.hitRadius
          if (qx * qx + qy * qy + qz * qz > reach * reach) continue
          const k = sweep(ax, ay, az, bx, by, bz, tg.x - tg.vx * dt, tg.y - tg.vy * dt, tg.z - tg.vz * dt, tg.x, tg.y, tg.z, d2)
          if (d2[0] <= r2 && k < bestK) {
            best = j
            bestK = k
          }
        }
        if (best >= 0) {
          const tg = targets[best]!
          this.kill(i)
          hit(this.owner[i]!, tg.id, "jet", ax + (bx - ax) * bestK, ay + (by - ay) * bestK, az + (bz - az) * bestK, null)
          continue
        }
      }
      const kind = by < MAX_PEAK ? groundHit(ground, bx, by, bz, t) : ""
      if (kind) {
        this.kill(i)
        hit(this.owner[i]!, -1, kind, bx, kind === "sea" && ground.sea ? seaHeight(ground.sea, bx, bz, t) : by, bz, kind === "ship" ? shipAt(ground, bx, by, bz) : null)
        continue
      }
      if (this.age[i]! >= g.life) this.kill(i)
    }
  }

  private kill(i: number): void {
    this.state[i] = 0
    this.live--
  }
}

// ---- flares -------------------------------------------------------------------------------------------------------------

/** One flare: ejected at sea time t0 from (x, y, z) with velocity (vx, vy, vz); its path is closed-form (linear drag). */
export type Flare = { owner: number; t0: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }

/** A flare slot in a world's pool (`live` until it burns out). */
export type LiveFlare = Flare & { live: boolean }

/** Position of a flare at sea time t (closed form, so any machine agrees): linear drag toward a slow fall. */
export function flareAt(f: Flare, t: number, out: Vec3): Vec3 {
  const k = WEAPONS.flare.drag
  const tau = Math.max(0, t - f.t0)
  const e = (1 - Math.exp(-k * tau)) / k
  const vt = -G / k
  out[0] = f.x + f.vx * e
  out[1] = f.y + vt * tau + (f.vy - vt) * e
  out[2] = f.z + f.vz * e
  return out
}

/** Velocity of a flare at sea time t. */
export function flareVel(f: Flare, t: number, out: Vec3): Vec3 {
  const k = WEAPONS.flare.drag
  const e = Math.exp(-k * Math.max(0, t - f.t0))
  const vt = -G / k
  out[0] = f.vx * e
  out[1] = vt + (f.vy - vt) * e
  out[2] = f.vz * e
  return out
}

/**
 * The flares of one burst released at sea time t from a jet at (x, y, z) flying at v: `pairs` pairs, `interval` apart
 * (each from where the jet will be by then, flying straight), kicked out left and right and down.
 */
export function flareBurst(owner: number, t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, out: Flare[] = []): Flare[] {
  const f = WEAPONS.flare
  out.length = 0
  // Sideways: horizontal, square to the flight path (or east when flying straight up or down).
  let sx = -vz
  let sz = vx
  const sl = Math.hypot(sx, sz)
  if (sl < 1e-3) {
    sx = 1
    sz = 0
  } else {
    sx /= sl
    sz /= sl
  }
  for (let i = 0; i < f.pairs; i++) {
    const dt = i * f.interval
    for (const side of [-1, 1]) {
      const spread = 0.75 + 0.5 * hash01(owner * 31 + i, Math.round(t * 1000) + side)
      out.push({
        owner,
        t0: t + dt,
        x: x + vx * dt,
        y: y + vy * dt,
        z: z + vz * dt,
        vx: vx + sx * side * f.side * spread,
        vy: vy - f.down * spread,
        vz: vz + sz * side * f.side * spread,
      })
    }
  }
  return out
}

// ---- missiles -----------------------------------------------------------------------------------------------------------

export type Missile = {
  /** Missiles have a motor and a seeker; bombs only fall (shared "store" state, one sequence counter per owner). */
  kind: "missile" | "bomb"
  owner: number
  team: number
  /** Launch sequence number of its owner (owner, seq) names it everywhere. */
  seq: number
  /** Jet it homes on (-1 none: dumbfire, lost or decoyed). */
  target: number
  /** The flare it chases instead, or null. */
  decoy: LiveFlare | null
  t0: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  speed: number
  /** Achieved lateral acceleration (lags the guidance command). */
  ax: number
  ay: number
  az: number
  age: number
  alive: boolean
}

/** A launch as sent over the wire: who, which, when, from where, how fast, at whom (-1 dumbfire; bombs: -1). */
export type MissileLaunch = { owner: number; seq: number; t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; target: number; kind?: "missile" | "bomb" }

export function makeMissile(): Missile {
  return { kind: "missile", owner: -1, team: -1, seq: 0, target: -1, decoy: null, t0: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, ax: 0, ay: 0, az: 0, age: 0, alive: false }
}

export function launchMissile(m: Missile, l: MissileLaunch, team: number): Missile {
  m.kind = l.kind ?? "missile"
  m.owner = l.owner
  m.team = team
  m.seq = l.seq
  m.target = m.kind === "bomb" ? -1 : l.target
  m.decoy = null
  m.t0 = l.t
  m.x = l.x
  m.y = l.y
  m.z = l.z
  m.vx = l.vx
  m.vy = l.vy
  m.vz = l.vz
  m.speed = Math.hypot(l.vx, l.vy, l.vz)
  m.ax = m.ay = m.az = 0
  m.age = 0
  m.alive = true
  return m
}

const tp: Vec3 = [0, 0, 0]
const lp: Vec3 = [0, 0, 0]
const lq: Vec3 = [0, 0, 0]
const tv: Vec3 = [0, 0, 0]

/**
 * Flies a missile one step toward (px, py, pz) moving at (qx, qy, qz) by proportional navigation (the lateral
 * acceleration turns the velocity at `nav` times the line-of-sight rate), limited to the missile's g (falling with
 * speed after burnout) behind a first-order autopilot lag. `track` false flies it dumb (gravity, no steering). Returns
 * false when the target left the seeker's gimbal (lost).
 */
export function guide(m: Missile, dt: number, track: boolean, px: number, py: number, pz: number, qx: number, qy: number, qz: number): boolean {
  const c = WEAPONS.missile
  m.age += dt
  // Motor, then drag after burnout.
  if (m.age < c.burn) m.speed = Math.min(c.topSpeed, m.speed + c.accel * dt)
  else m.speed = Math.max(60, m.speed - c.drag * m.speed * m.speed * dt)
  const s = Math.hypot(m.vx, m.vy, m.vz) || 1
  const ux = m.vx / s
  const uy = m.vy / s
  const uz = m.vz / s
  let cx = 0
  let cy = 0
  let cz = 0
  let seen = true
  const steering = m.age > c.drop
  if (track && steering) {
    const rx = px - m.x
    const ry = py - m.y
    const rz = pz - m.z
    const r2 = rx * rx + ry * ry + rz * rz
    const r = Math.sqrt(r2)
    if (r > 1e-3 && (rx * ux + ry * uy + rz * uz) / r < Math.cos(c.gimbal)) seen = false
    else if (r > 1e-3) {
      // Line-of-sight rate Ω = r × v_rel / |r|²; pure PN: a = N Ω × v_m.
      const wx = qx - m.vx
      const wy = qy - m.vy
      const wz = qz - m.vz
      const ox = (ry * wz - rz * wy) / r2
      const oy = (rz * wx - rx * wz) / r2
      const oz = (rx * wy - ry * wx) / r2
      cx = c.nav * (oy * m.vz - oz * m.vy)
      cy = c.nav * (oz * m.vx - ox * m.vz)
      cz = c.nav * (ox * m.vy - oy * m.vx)
      // The autopilot holds the missile up against gravity while it tracks.
      cy += G
    }
  }
  // Limit, lag, and keep the acceleration square to the flight path.
  // Half its turn authority at any speed, all of it at top speed: a slow missile just off the rail still turns onto a
  // crossing target.
  const limit = c.maxG * G * Math.min(1, 0.5 + 0.5 * (m.speed / c.topSpeed))
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
  // Turn the flight path, then gravity, then the new speed along it.
  let nx = ux + (lx / m.speed) * dt
  let ny = uy + ((ly - G) / m.speed) * dt
  let nz = uz + (lz / m.speed) * dt
  if (!steering) ny -= (c.ejectDrop / m.speed) * (dt / c.drop)
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

/** Missile damage at distance d from the burst: `damage` at the centre down to `edge` at the fuse radius, 0 beyond. */
export function blastDamage(d: number): number {
  const c = WEAPONS.missile
  if (d > c.fuse) return 0
  return c.damage + (c.edge - c.damage) * (d / c.fuse)
}

/** A bomb falls one step: gravity and a little drag, nose along its path. Lift-free, unguided. */
export function fall(m: Missile, dt: number): void {
  const b = WEAPONS.bomb
  m.age += dt
  const k = b.drag * Math.hypot(m.vx, m.vy, m.vz)
  m.vx -= m.vx * k * dt
  m.vy -= (m.vy * k + G) * dt
  m.vz -= m.vz * k * dt
  m.speed = Math.hypot(m.vx, m.vy, m.vz)
  m.x += m.vx * dt
  m.y += m.vy * dt
  m.z += m.vz * dt
}

/** Bomb damage at distance d: `damage` at the centre down to `edge` at the radius, 0 beyond. */
export function bombDamage(d: number): number {
  const b = WEAPONS.bomb
  if (d > b.radius) return 0
  return b.damage + (b.edge - b.damage) * (d / b.radius)
}

// ---- bomb release and impact prediction ---------------------------------------------------------------------------------

const rel: Vec3 = [0, 0, 0]
const push: Vec3 = [0, 0, 0]

/**
 * The next bomb's release from jet `p` (`bombs` of `max` left on `vehicle`): from its station on the jet
 * (shared/weapons.ts `bombStation`), at the jet's velocity plus the ejector's push out of the belly. What the jet
 * releases (src/weapons/weapons.ts) and what the bombsight predicts from. Fills everything but owner and seq.
 */
export function bombLaunch(p: Plane, vehicle: VehicleKind, bombs: number, max: number, out: MissileLaunch): MissileLaunch {
  const b = bombStation(vehicle, bombs, max)
  const at = bodyToWorld(p, b[0], b[1], b[2], rel)
  const v = bodyToWorld(p, 0, -WEAPONS.bomb.eject, 0, push)
  out.t = p.t
  out.x = p.x + at[0]
  out.y = p.y + at[1]
  out.z = p.z + at[2]
  out.vx = p.vx + v[0]
  out.vy = p.vy + v[1]
  out.vz = p.vz + v[2]
  out.target = -1
  out.kind = "bomb"
  return out
}

/** A carrier's plan motion (shared/ship.ts `Ship`): forward and starboard speed (m/s) and yaw rate (rad/s). */
export type ShipMotion = { u: number; v: number; r: number }
export type MovingShip = GroundShip & ShipMotion

/** Moves a carrier's plan pose one step along its course at constant speed and yaw rate: shipStep's kinematics. */
export function driftShip(s: MovingShip, dt: number): void {
  s.heading += s.r * dt
  const sh = Math.sin(s.heading)
  const ch = Math.cos(s.heading)
  s.x += (s.u * sh + s.v * ch) * dt
  s.z += (-s.u * ch + s.v * sh) * dt
}

/** Where a bomb bursts (`bombImpact`). */
export type BombImpact = {
  /** What it strikes, "" when its life runs out first. */
  kind: ImpactKind | ""
  /** The burst point, as CombatWorld detonates it (on the sea's surface over water). */
  x: number
  y: number
  z: number
  /** Seconds from release to the burst. */
  time: number
  /** The carrier struck (index into `ships`, -1 none) and the strike in its frame (on the deck when it came through it). */
  ship: number
  local: Vec3
}

export const makeBombImpact = (): BombImpact => ({ kind: "", x: 0, y: 0, z: 0, time: 0, ship: -1, local: [0, 0, 0] })

const probe = makeMissile()
const drift: MovingShip[] = []
const driftList: MovingShip[] = []
const driftGround: Ground = { sea: null, arch: null, ships: driftList }

/**
 * Predicts where bomb launch `l` bursts by flying the world's own bomb: CombatWorld.tick's steps (`fall` at PLANE.tick:
 * gravity and drag), each tested against the sea at that step's sea time, the islands and the carriers, every carrier
 * drifted along its course (`driftShip`) step by step. Exact for carriers holding their speed and turn. Pure: `ships`
 * is copied, never moved.
 */
export function bombImpact(g: Ground, ships: readonly MovingShip[], l: MissileLaunch, out: BombImpact): BombImpact {
  const dt = PLANE.tick
  launchMissile(probe, l, -1)
  driftList.length = 0
  for (let i = 0; i < ships.length; i++) {
    const s = (drift[i] ??= { x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, u: 0, v: 0, r: 0 })
    const o = ships[i]!
    s.x = o.x
    s.z = o.z
    s.heave = o.heave
    s.heading = o.heading
    s.pitch = o.pitch
    s.roll = o.roll
    s.u = o.u
    s.v = o.v
    s.r = o.r
    driftList.push(s)
  }
  driftGround.sea = g.sea
  driftGround.arch = g.arch
  out.kind = ""
  out.ship = -1
  while (probe.age < WEAPONS.bomb.life) {
    for (const s of driftList) driftShip(s, dt)
    const px = probe.x
    const py = probe.y
    const pz = probe.z
    fall(probe, dt)
    const t = l.t + probe.age
    const kind = probe.y < MAX_PEAK ? groundHit(driftGround, probe.x, probe.y, probe.z, t) : ""
    if (!kind) continue
    out.kind = kind
    out.x = probe.x
    out.y = kind === "sea" && g.sea ? seaHeight(g.sea, probe.x, probe.z, t) : probe.y
    out.z = probe.z
    out.time = probe.age
    if (kind === "ship") {
      const sh = shipAt(driftGround, probe.x, probe.y, probe.z, out.local)
      if (sh) {
        out.ship = driftList.findIndex((s) => s === sh)
        if (worldToShip(sh, px, py, pz, lq)[1] >= DECK_Y && out.local[1] < DECK_Y) out.local[1] = DECK_Y
      }
    }
    return out
  }
  out.time = probe.age
  return out
}

// ---- the world ----------------------------------------------------------------------------------------------------------

/** One jet's combat state in the world: health, who hurt it last, and the room's launch/flare budgets. */
export type Fighter = {
  id: number
  team: number
  vehicle: VehicleKind
  hp: number
  alive: boolean
  /** Sea time of the last damage, who dealt it and with what. */
  hitAt: number
  by: number
  w: KillWeapon
  /** Authority budgets (anti-spam): missiles, bombs and flare bursts available, and rounds of gun damage. */
  missiles: number
  bombs: number
  flares: number
  rounds: number
  /** Last health sent out while repairing (repair updates go out in whole steps). */
  sent: number
  /** A boat (shared/boat.ts), not a jet: same health scale, its damage scaled per weapon (`BOAT_ARMOR`), no stores. */
  boat?: boolean
}

export type CombatEvent =
  /** A missile or bomb burst at (x, y, z): over the sea (`water`), on a jet (`on`, else -1); `ground` what it struck. */
  | { k: "boom"; owner: number; seq: number; x: number; y: number; z: number; on: number; water: boolean; bomb?: boolean; intercepted?: true }
  /** A jet's health changed (damage, or repair with by -1 and w ""). */
  | { k: "hp"; on: number; hp: number; by: number; w: KillWeapon | "" }
  /** A jet was destroyed: by whom (-1 it crashed on its own) and with what ("" a crash). */
  | { k: "kill"; on: number; by: number; w: KillWeapon | "" }
  /**
   * A missile or bomb struck carrier `ship` (direct: `near` 0, ship-local x, y, z of the hit), or a bomb burst in the
   * water `near` m from its hull (ship-local point of the burst). shared/fleet.ts turns it into damage.
   */
  | { k: "ship"; ship: number; owner: number; w: WeaponKind; x: number; y: number; z: number; near: number }
  /** A missile turned onto a flare. */
  | { k: "decoy"; owner: number; seq: number }

export const MAX_MISSILES = 64
export const MAX_FLARES = 192

/**
 * Missiles, flares and health for a room (or the offline harness, or a client's cosmetic copy). `step(t, targets)`
 * advances it in fixed PLANE.tick steps to sea time t; targets are every jet as known now (position and velocity at t,
 * extrapolated across the steps). With `authority`, detonations hurt and the world keeps health, credits kills and
 * repairs; without it, missiles still fly, decoy and burst (for drawing) but nobody's health changes.
 * Events accumulate in `events` until the host drains them.
 */
export class CombatWorld {
  t = 0
  readonly fighters = new Map<number, Fighter>()
  readonly missiles: Missile[] = Array.from({ length: MAX_MISSILES }, makeMissile)
  readonly flares: LiveFlare[] = Array.from({ length: MAX_FLARES }, () => ({ owner: -1, t0: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, live: false }))
  readonly events: CombatEvent[] = []
  private nextFlare = 0
  private burst: Flare[] = []
  private byId = new Map<number, Target>()
  private sub: Target[] = []

  constructor(
    public ground: Ground = { sea: null, arch: null },
    public authority = true,
  ) {}

  /** A jet entering combat (a new sortie): full health and budgets. `boat`: a boat instead (no budgets at all). */
  spawn(id: number, team: number, vehicle: VehicleKind = "hornet", t = this.t, boat = false): Fighter {
    let f = this.fighters.get(id)
    if (!f) {
      f = { id, team, vehicle, hp: 0, alive: true, hitAt: -1e9, by: -1, w: "gun", missiles: 0, bombs: 0, flares: 0, rounds: 0, sent: 0 }
      this.fighters.set(id, f)
    }
    const spec = LOADOUTS[vehicle]
    f.team = team
    f.vehicle = vehicle
    f.hp = WEAPONS.health.max
    f.sent = f.hp
    f.alive = true
    f.hitAt = t - 1e6
    f.by = -1
    f.missiles = spec.missiles
    f.bombs = spec.bombs
    f.flares = spec.flares
    f.rounds = spec.weapons.includes("gun") ? WEAPONS.gun.rate : 0
    f.boat = boat
    if (boat) f.missiles = f.bombs = f.flares = f.rounds = 0
    return f
  }

  remove(id: number): void {
    this.fighters.delete(id)
  }

  /** Health of a jet (full when unknown). */
  hp(id: number): number {
    return this.fighters.get(id)?.hp ?? WEAPONS.health.max
  }

  /** A missile leaves a rail or a bomb leaves the bay. Refused (null) with authority when the owner has none left or
   *  is not flying. */
  fire(l: MissileLaunch, team?: number): Missile | null {
    const f = this.fighters.get(l.owner)
    const bomb = l.kind === "bomb"
    if (this.authority) {
      if (!f || !f.alive || (bomb ? f.bombs : f.missiles) < 1) return null
      if (bomb) f.bombs--
      else f.missiles--
    }
    for (const m of this.missiles) if (m.alive && m.owner === l.owner && m.seq === l.seq) return null
    const m = this.missiles.find((m) => !m.alive) ?? this.missiles[0]!
    launchMissile(m, l, team ?? f?.team ?? -1)
    // A launch heard late: fly it up to the world's time toward where its target is now (no fuse on the way).
    const dt = PLANE.tick
    const tg = l.target >= 0 ? this.byId.get(l.target) : undefined
    while (m.t0 + m.age + dt <= this.t + 1e-9) {
      if (bomb) fall(m, dt)
      else if (tg && m.target >= 0) {
        if (!guide(m, dt, true, tg.x, tg.y, tg.z, tg.vx, tg.vy, tg.vz)) m.target = -1
      } else guide(m, dt, false, 0, 0, 0, 0, 0, 0)
    }
    return m
  }

  /** A flare burst. Refused (false) with authority when the owner has none loaded. Breaks nothing by itself: missiles
   *  decoy in `step`, and seekers read `flaredAt`. */
  flare(owner: number, t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): boolean {
    const f = this.fighters.get(owner)
    if (this.authority) {
      if (!f || !f.alive || f.flares < 1) return false
      f.flares--
    }
    for (const b of flareBurst(owner, t, x, y, z, vx, vy, vz, this.burst)) {
      const slot = this.flares[this.nextFlare]!
      this.nextFlare = (this.nextFlare + 1) % MAX_FLARES
      Object.assign(slot, b, { live: true })
    }
    return true
  }

  /** True while jet `id` is hidden from seekers by its own fresh flares. */
  blind(id: number, t = this.t): boolean {
    for (const f of this.flares) if (f.live && f.owner === id && t >= f.t0 - 0.5 && t - f.t0 < WEAPONS.flare.blind) return true
    return false
  }

  /**
   * Cannon hits reported by `shooter` on `target` (rounds `n`). With authority: refused unless both are alive enemies
   * and the gun could have fired that many (a budget refilled at the gun's rate); `dist` (m, between the two jets as the
   * room knows them) beyond range refuses too. Returns the rounds applied.
   */
  gunHit(shooter: number, target: number, n: number, dist = 0): number {
    const a = this.fighters.get(shooter)
    const b = this.fighters.get(target)
    if (!a || !b || !a.alive || !b.alive || a.boat || !canHurt(a.team, a.id, b.team, b.id) || !LOADOUTS[a.vehicle].weapons.includes("gun")) return 0
    const g = WEAPONS.gun
    if (dist > g.muzzle * g.life + 400) return 0
    const use = Math.max(0, Math.min(Math.floor(n), Math.floor(a.rounds)))
    if (!use) return 0
    a.rounds -= use
    this.damage(b, use * g.damage, shooter, "gun")
    return use
  }

  /**
   * Rounds `shooter` claims against something that is not a jet (a carrier): refused unless it is alive with a gun;
   * cut to the same round budget its jet hits draw from. Returns the rounds allowed.
   */
  spendRounds(shooter: number, n: number): number {
    const a = this.fighters.get(shooter)
    if (!a || !a.alive || a.boat || !LOADOUTS[a.vehicle].weapons.includes("gun")) return 0
    const use = Math.max(0, Math.min(Math.floor(n), Math.floor(a.rounds)))
    a.rounds -= use
    return use
  }

  /**
   * A missile or bomb in flight destroyed before it struck (a ship's CIWS or SAM, shared code for gunnery): it bursts
   * harmlessly where it is (a `boom` with on -1, no damage, no ship event). Returns false if it isn't flying.
   */
  intercept(owner: number, seq: number): boolean {
    for (const m of this.missiles) {
      if (!m.alive || m.owner !== owner || m.seq !== seq) continue
      m.alive = false
      this.events.push(m.kind === "bomb" ? { k: "boom", owner, seq, x: m.x, y: m.y, z: m.z, on: -1, water: false, bomb: true, intercepted: true } : { k: "boom", owner, seq, x: m.x, y: m.y, z: m.z, on: -1, water: false, intercepted: true })
      return true
    }
    return false
  }

  /** A jet crashed (sea, land, ship, lost) on its own: destroyed, credited to whoever damaged it lately. */
  crash(id: number): void {
    const f = this.fighters.get(id)
    if (!f || !f.alive) return
    f.alive = false
    f.hp = 0
    if (!this.authority) return
    const credit = f.by >= 0 && this.t - f.hitAt <= WEAPONS.health.credit
    this.events.push({ k: "kill", on: id, by: credit ? f.by : -1, w: credit ? f.w : "" })
  }

  /** Damage to jet `id` from outside this world (shared/gunnery.ts: a ship gun's rounds, SAM or shell), credited to
   *  player `by` with `w`. Friendly fire is the caller's check (the gunnery world only hurts enemies). */
  hurt(id: number, amount: number, by: number, w: KillWeapon): void {
    const f = this.fighters.get(id)
    if (f) this.damage(f, amount, by, w)
  }

  private damage(f: Fighter, amount: number, by: number, w: KillWeapon): void {
    if (f.boat) amount *= BOAT_ARMOR[w]
    if (!this.authority || !f.alive || amount <= 0) return
    f.hp = Math.max(0, f.hp - amount)
    f.sent = f.hp
    f.hitAt = this.t
    f.by = by
    f.w = w
    this.events.push({ k: "hp", on: f.id, hp: Math.round(f.hp * 10) / 10, by, w })
    if (f.hp <= 0) {
      f.alive = false
      this.events.push({ k: "kill", on: f.id, by, w })
    }
  }

  /** Advances to sea time t in fixed steps; `targets` are the jets now (at t). */
  step(t: number, targets: readonly Target[]): void {
    const dt = PLANE.tick
    if (t - this.t > 2) this.t = t - dt
    this.byId.clear()
    for (const tg of targets) this.byId.set(tg.id, tg)
    while (this.t + dt <= t) {
      this.t += dt
      // Targets extrapolated to this step's time.
      const back = this.t - t
      const sub = this.sub
      sub.length = 0
      for (let i = 0; i < targets.length; i++) {
        const tg = targets[i]!
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
      this.tick(dt, sub)
    }
  }

  private subPool: Target[] = []

  private tick(dt: number, targets: readonly Target[]): void {
    const t = this.t
    const fl = WEAPONS.flare
    for (const f of this.flares) if (f.live && t - f.t0 > fl.life) f.live = false
    if (this.authority) this.budgets(dt)
    for (const m of this.missiles) {
      if (!m.alive) continue
      if (m.t0 + m.age + dt > t + 1e-9) continue
      if (m.kind === "bomb") {
        const px = m.x
        const py = m.y
        const pz = m.z
        fall(m, dt)
        const kind = m.y < MAX_PEAK ? groundHit(this.ground, m.x, m.y, m.z, t) : ""
        if (kind) {
          const y = kind === "sea" && this.ground.sea ? seaHeight(this.ground.sea, m.x, m.z, t) : m.y
          this.shipStrike(m, kind, px, py, pz, y)
          this.detonate(m, m.x, y, m.z, targets, -1, kind === "sea")
        } else if (m.age >= WEAPONS.bomb.life) m.alive = false
        continue
      }
      let target: Target | null = null
      if (m.target >= 0) {
        for (const x of targets) if (x.id === m.target && x.alive) target = x
        if (!target) m.target = -1
      }
      // Fresh flares from its target seduce it while it is close enough and they are in its seeker.
      if (target && !m.decoy) {
        const dx = target.x - m.x
        const dy = target.y - m.y
        const dz = target.z - m.z
        if (dx * dx + dy * dy + dz * dz < fl.range * fl.range)
          for (const f of this.flares) {
            if (!f.live || f.owner !== target.id || t < f.t0 || t - f.t0 > fl.seduce) continue
            flareAt(f, t, tp)
            const rx = tp[0] - m.x
            const ry = tp[1] - m.y
            const rz = tp[2] - m.z
            const r = Math.hypot(rx, ry, rz)
            if (r > 1 && (rx * m.vx + ry * m.vy + rz * m.vz) / (r * m.speed) > Math.cos(WEAPONS.missile.gimbal)) {
              m.decoy = f
              m.target = -1
              target = null
              this.events.push({ k: "decoy", owner: m.owner, seq: m.seq })
              break
            }
          }
      }
      const ox = m.x
      const oy = m.y
      const oz = m.z
      if (m.decoy) {
        const f = m.decoy
        if (!f.live || f.owner < 0) m.decoy = null
        flareAt(f, t, tp)
        flareVel(f, t, tv)
        if (!guide(m, dt, m.decoy !== null, tp[0], tp[1], tp[2], tv[0], tv[1], tv[2])) m.decoy = null
      } else if (target) {
        if (!guide(m, dt, true, target.x, target.y, target.z, target.vx, target.vy, target.vz)) m.target = -1
      } else guide(m, dt, false, 0, 0, 0, 0, 0, 0)

      // Proximity fuse on any enemy jet this step (relative sweep).
      const c = WEAPONS.missile
      if (m.age >= c.arm) {
        let best: Target | null = null
        let bestD = c.fuse * c.fuse
        let bestK = 0
        for (const tg of targets) {
          if (!tg.alive || !canHurt(m.team, m.owner, tg.team, tg.id)) continue
          const qx = tg.x - m.x
          const qy = tg.y - m.y
          const qz = tg.z - m.z
          if (qx * qx + qy * qy + qz * qz > 160 * 160) continue
          const k = sweep(ox, oy, oz, m.x, m.y, m.z, tg.x - tg.vx * dt, tg.y - tg.vy * dt, tg.z - tg.vz * dt, tg.x, tg.y, tg.z, d2)
          // Burst at the closest approach: wait while it is still closing at the end of the step.
          if (d2[0] <= bestD && k < 1) {
            best = tg
            bestD = d2[0]
            bestK = k
          }
        }
        if (best) {
          // Burst at the closest approach.
          const bx = ox + (m.x - ox) * bestK
          const by = oy + (m.y - oy) * bestK
          const bz = oz + (m.z - oz) * bestK
          this.detonate(m, bx, by, bz, targets, best.id, false)
          continue
        }
        // A decoyed missile bursts on its flare.
        if (m.decoy) {
          flareAt(m.decoy, t, tp)
          if ((tp[0] - m.x) ** 2 + (tp[1] - m.y) ** 2 + (tp[2] - m.z) ** 2 < 8 * 8) {
            this.detonate(m, m.x, m.y, m.z, targets, -1, false)
            continue
          }
        }
      }
      const kind = m.y < MAX_PEAK ? groundHit(this.ground, m.x, m.y, m.z, t) : ""
      if (kind) {
        const y = kind === "sea" && this.ground.sea ? seaHeight(this.ground.sea, m.x, m.z, t) : m.y
        this.shipStrike(m, kind, ox, oy, oz, y)
        this.detonate(m, m.x, y, m.z, targets, -1, kind === "sea")
        continue
      }
      if (m.age >= c.life) this.detonate(m, m.x, m.y, m.z, targets, -1, false)
    }
  }

  /**
   * A store that just struck the world: on a carrier, a direct hit at the point it entered (a deck hit lands on the deck
   * surface, not where the step ended up inside the hull); in the sea, a bomb's near miss on every carrier within reach.
   * (px, py, pz) is where it was a step before.
   */
  private shipStrike(m: Missile, kind: ImpactKind, px: number, py: number, pz: number, seaY: number): void {
    const g = this.ground
    if (kind === "ship") {
      const sh = shipAt(g, m.x, m.y, m.z, lp)
      if (!sh || sh.id === undefined) return
      const before = worldToShip(sh, px, py, pz, lq)
      // Came down through the deck: it burst on the deck.
      if (before[1] >= DECK_Y && lp[1] < DECK_Y) lp[1] = DECK_Y
      this.events.push({ k: "ship", ship: sh.id, owner: m.owner, w: m.kind, x: lp[0], y: lp[1], z: lp[2], near: 0 })
      return
    }
    if (kind !== "sea" || m.kind !== "bomb" || !g.ships) return
    for (const sh of g.ships) {
      if (sh.id === undefined || Math.abs(m.x - sh.x) > 260 || Math.abs(m.z - sh.z) > 260) continue
      const l = worldToShip(sh, m.x, seaY, m.z, lp)
      const d = waterlineDistance(l[0], l[2])
      if (d <= FLEET.near) this.events.push({ k: "ship", ship: sh.id, owner: m.owner, w: "bomb", x: l[0], y: 0, z: l[2], near: Math.max(0.5, d) })
    }
  }

  private detonate(m: Missile, x: number, y: number, z: number, targets: readonly Target[], on: number, water: boolean): void {
    m.alive = false
    const bomb = m.kind === "bomb"
    this.events.push(bomb ? { k: "boom", owner: m.owner, seq: m.seq, x, y, z, on, water, bomb } : { k: "boom", owner: m.owner, seq: m.seq, x, y, z, on, water })
    if (!this.authority) return
    // Ships take their damage through the "ship" event (shared/fleet.ts); here, jets caught in the blast.
    for (const tg of targets) {
      if (!tg.alive || !canHurt(m.team, m.owner, tg.team, tg.id)) continue
      const d = Math.hypot(tg.x - x, tg.y - y, tg.z - z)
      const dmg = bomb ? bombDamage(d) : blastDamage(d)
      const f = this.fighters.get(tg.id)
      if (f && dmg > 0) this.damage(f, dmg, m.owner, m.kind)
    }
  }

  /** Refills the authority budgets and repairs jets left alone long enough. */
  private budgets(dt: number): void {
    const h = WEAPONS.health
    const g = WEAPONS.gun
    for (const f of this.fighters.values()) {
      if (!f.alive) continue
      if (f.boat) {
        // A boat carries nothing to refill; it repairs on its own clock.
        const b = BOAT_HEALTH
        if (f.hp < h.max && this.t - f.hitAt > b.repairDelay) {
          f.hp = Math.min(h.max, f.hp + b.repair * dt)
          if (f.hp - f.sent >= 5 || f.hp >= h.max) {
            f.sent = f.hp
            this.events.push({ k: "hp", on: f.id, hp: Math.round(f.hp * 10) / 10, by: -1, w: "" })
          }
        }
        continue
      }
      const spec = LOADOUTS[f.vehicle]
      if (spec.weapons.includes("gun")) f.rounds = Math.min(g.rate * 0.6, f.rounds + g.rate * dt * 1.15)
      // Slightly quicker than the client's own rearm, so a legitimate launch is never refused for clock skew.
      f.missiles = Math.min(spec.missiles, f.missiles + dt / (WEAPONS.missile.reload * 0.9))
      f.bombs = Math.min(spec.bombs, f.bombs + dt / (WEAPONS.bomb.reload * 0.9))
      f.flares = Math.min(spec.flares, f.flares + dt / (WEAPONS.flare.reload * 0.9))
      if (f.hp < h.max && this.t - f.hitAt > h.repairDelay) {
        f.hp = Math.min(h.max, f.hp + h.repair * dt)
        if (f.hp - f.sent >= 5 || f.hp >= h.max) {
          f.sent = f.hp
          this.events.push({ k: "hp", on: f.id, hp: Math.round(f.hp * 10) / 10, by: -1, w: "" })
        }
      }
    }
  }

  /** Forces a missile's detonation where the authority says it burst (a client snapping to the room). */
  snap(owner: number, seq: number): Missile | null {
    for (const m of this.missiles)
      if (m.alive && m.owner === owner && m.seq === seq) {
        m.alive = false
        return m
      }
    return null
  }

  /** Sets a jet's health from the authority (a client mirroring the room). */
  setHp(id: number, hp: number): void {
    const f = this.fighters.get(id)
    if (!f) return
    f.hp = hp
    if (hp <= 0) f.alive = false
  }

  /** Missiles homing on jet `id` (for its MISSILE warning): the nearest one's distance, or Infinity. */
  inbound(id: number, x: number, y: number, z: number): number {
    let best = Infinity
    for (const m of this.missiles) {
      if (!m.alive || m.kind !== "missile" || m.target !== id) continue
      const d = Math.hypot(m.x - x, m.y - y, m.z - z)
      if (d < best) best = d
    }
    return best
  }
}
