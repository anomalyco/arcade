import type { CombatWorld } from "../../shared/combat"
import { PLANE, type Plane, type PlaneControls, type PlaneWorld, copyPlane, lerpPlane, makePlane, planeAttitude, planeStep, quatAxis, quatMul, setPlaneQuat } from "../../shared/plane"
import { type Lock, type Shooter, type Target, hash01, lockStep, makeTarget } from "../../shared/weapons"
import type { PlaneDrawPose } from "../render/plane-pass"

/** Target drones for the weapons harness (offline): enemy jets flying circuits on the real flight model. */
export type DroneOptions = {
  /** Circuits are laid around this point (plan x, z). */
  centre: [number, number]
  /** Fly in the seeker's way: lock the player and fire missiles (one per `fireEvery` s). */
  hostile: boolean
  /** Drop flares when a missile homing on them comes within 1 km (on alternate missiles, so some get through). */
  flares: boolean
  team: number
}

type Drone = {
  id: number
  plane: Plane
  prev: Plane
  draw: Plane
  controls: PlaneControls
  /** Circuit: centre, radius, height, direction (+1 clockwise seen from above). */
  cx: number
  cz: number
  radius: number
  alt: number
  dir: number
  dead: number
  lock: Lock
  fireIn: number
  seq: number
  flared: Set<string>
  pose: PlaneDrawPose
  target: Target
}

const RESPAWN = 6

/**
 * Drones: AI enemy jets flying wide circles at a steady height (a bank-and-pull autopilot on planeStep), respawning a
 * few seconds after they are destroyed. Optional: hostile (they lock on and shoot missiles at the player) and flaring.
 */
export class Drones {
  readonly list: Drone[] = []
  private shooter: Shooter = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, team: 1 }
  private att = { heading: 0, pitch: 0, bank: 0 }

  constructor(
    count: number,
    private opts: DroneOptions,
  ) {
    for (let i = 0; i < count; i++) {
      const d: Drone = {
        id: 100 + i,
        plane: makePlane(),
        prev: makePlane(),
        draw: makePlane(),
        controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0, boost: false },
        cx: 0,
        cz: 0,
        radius: 0,
        alt: 0,
        dir: 1,
        dead: -1,
        lock: { target: -1, time: 0, locked: false },
        fireIn: 8 + i * 5,
        seq: 0,
        flared: new Set(),
        pose: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, pitch: 0, roll: 0, gear: 0, throttle: 0.7, burner: 0 },
        target: makeTarget(100 + i, opts.team),
      }
      this.list.push(d)
      this.place(d, i, 0)
    }
  }

  private place(d: Drone, k: number, t: number): void {
    const [x0, z0] = this.opts.centre
    const a = hash01(d.id, k) * Math.PI * 2
    const r = 900 + 1400 * hash01(d.id + 7, k)
    d.cx = x0 + Math.cos(a) * r
    d.cz = z0 + Math.sin(a) * r
    d.radius = 700 + 500 * hash01(d.id + 3, k)
    d.alt = 450 + 500 * hash01(d.id + 5, k)
    d.dir = hash01(d.id + 9, k) < 0.5 ? 1 : -1
    // Start on the circle, flying along it.
    const b = hash01(d.id + 11, k) * Math.PI * 2
    const p = d.plane
    Object.assign(p, makePlane(t), { x: d.cx + Math.cos(b) * d.radius, y: d.alt, z: d.cz + Math.sin(b) * d.radius, throttle: PLANE.cruise })
    // Tangent: clockwise from above (x east, z south) is (-sin b, cos b) for dir 1.
    const tx = -Math.sin(b) * d.dir
    const tz = Math.cos(b) * d.dir
    const heading = Math.atan2(tx, -tz)
    setPlaneQuat(p, quatMul(quatAxis(0, 1, 0, Math.PI - heading), quatAxis(1, 0, 0, 0)))
    p.vx = tx * PLANE.optimalSpeed
    p.vz = tz * PLANE.optimalSpeed
    copyPlane(p, d.prev)
    d.dead = -1
    d.flared.clear()
  }

  /** Puts every drone back in the fight (full health) after the world forgot them, e.g. on a reset. */
  enlist(world: CombatWorld): void {
    for (const d of this.list) world.spawn(d.id, this.opts.team)
  }

  /** One fixed step at sea time t: fly, and (hostile) hunt the player; flare at inbound missiles. */
  tick(world: CombatWorld, ground: PlaneWorld, player: Target | null, onLock: (id: number, state: boolean | null) => void): void {
    const dt = PLANE.tick
    for (const [i, d] of this.list.entries()) {
      copyPlane(d.plane, d.prev)
      const f = world.fighters.get(d.id)
      if (!f) world.spawn(d.id, this.opts.team)
      const alive = world.fighters.get(d.id)!.alive
      if (!alive) {
        if (d.dead < 0) {
          d.dead = 0
          if (d.lock.target >= 0) onLock(d.id, null)
          d.lock.target = -1
        }
        d.dead += dt
        d.plane.t += dt
        if (d.dead > RESPAWN) {
          this.place(d, i + Math.floor(d.plane.t), d.plane.t)
          world.spawn(d.id, this.opts.team)
        }
        continue
      }
      this.fly(d, dt, ground)
      if (d.plane.crashed) {
        world.crash(d.id)
        continue
      }
      const p = d.plane
      // Flares at inbound missiles (alternate ones), once each.
      if (this.opts.flares)
        for (const m of world.missiles) {
          if (!m.alive || m.target !== d.id) continue
          const key = `${m.owner}:${m.seq}`
          if (d.flared.has(key)) continue
          if (Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z) < 1000) {
            d.flared.add(key)
            if (m.seq % 2 === 0) world.flare(d.id, p.t, p.x, p.y, p.z, p.vx, p.vy, p.vz)
          }
        }
      if (this.opts.hostile && player) {
        const s = this.shooter
        const nx = 2 * (p.qx * p.qz + p.qw * p.qy)
        const ny = 2 * (p.qy * p.qz - p.qw * p.qx)
        const nz = 1 - 2 * (p.qx * p.qx + p.qy * p.qy)
        Object.assign(s, { x: p.x, y: p.y, z: p.z, fx: nx, fy: ny, fz: nz, team: this.opts.team })
        if (lockStep(d.lock, dt, s, [player], (id) => world.blind(id))) onLock(d.id, d.lock.target >= 0 ? d.lock.locked : null)
        d.fireIn -= dt
        if (d.lock.locked && d.fireIn <= 0) {
          d.fireIn = 15
          world.fighters.get(d.id)!.missiles = 2
          world.fire({ owner: d.id, seq: d.seq++, t: p.t, x: p.x, y: p.y - 1, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, target: player.id })
        }
      }
    }
  }

  /** The circuit autopilot: bank toward the circle's tangent (with a correction onto the radius), pull to hold height. */
  private fly(d: Drone, dt: number, ground: PlaneWorld): void {
    const p = d.plane
    const c = d.controls
    const a = planeAttitude(p, this.att)
    const rx = p.x - d.cx
    const rz = p.z - d.cz
    const r = Math.hypot(rx, rz) || 1
    // Desired track: the tangent, turned in or out by the radius error.
    let tx = (-rz / r) * d.dir
    let tz = (rx / r) * d.dir
    const err = Math.max(-1, Math.min(1, (r - d.radius) / 400))
    tx -= (rx / r) * err
    tz -= (rz / r) * err
    const want = Math.atan2(tx, -tz)
    let dh = want - a.heading
    dh = Math.atan2(Math.sin(dh), Math.cos(dh))
    const bank = Math.max(-1.1, Math.min(1.1, dh * 2.5))
    c.roll = Math.max(-1, Math.min(1, (bank - a.bank) * 2.5))
    const climb = Math.max(-0.25, Math.min(0.25, (d.alt - p.y) * 0.004))
    c.pitch = Math.max(-1, Math.min(1, (climb - a.pitch) * 3 + Math.abs(Math.sin(a.bank)) * 0.55))
    c.yaw = 0
    c.throttle = 0
    planeStep(p, c, dt, ground)
  }

  /** Each live drone interpolated (k between the last two steps) for drawing. */
  *poses(k: number): Generator<[drone: Drone, pose: PlaneDrawPose]> {
    for (const d of this.list) {
      if (d.dead >= 0) continue
      const p = lerpPlane(d.prev, d.plane, k, d.draw)
      const o = d.pose
      o.x = p.x
      o.y = p.y
      o.z = p.z
      o.qx = p.qx
      o.qy = p.qy
      o.qz = p.qz
      o.qw = p.qw
      o.pitch = d.controls.pitch
      o.roll = d.controls.roll
      o.throttle = p.throttle
      yield [d, o]
    }
  }
}

