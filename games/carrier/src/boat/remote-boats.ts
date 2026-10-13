import {
  BOAT,
  BOAT_HEALTH,
  BOAT_MODE,
  type Boat,
  type BoatNet,
  BoatRounds,
  type BoatTarget,
  type BoatTuple,
  type CranePose,
  boatFloat,
  boatVelocity,
  cranePose,
  extrapolateBoat,
  makeBoat,
  makeTurret,
  muzzleWorld,
  turretGun,
  unpackBoat,
} from "../../shared/boat"
import type { ShipPoseLike, Vec3 } from "../../shared/plane"
import { type Sea, seaHeight } from "../../shared/sea"

/** Remote boats glide onto their dead-reckoned room pose over this lag (s); further than SNAP m, they jump. */
const LAG = 0.25
const SNAP = 40
/** The turret slews to the reported aim at about its own rate. */
const TURRET_LAG = 0.12

/** One other player's boat as drawn here. */
export type RemoteBoat = {
  id: number
  net: BoatNet
  /** Plan pose glided onto the room's, heave/pitch/roll floated on our own sea (shared/boat.ts boatFloat). */
  boat: Boat
  yaw: number
  pitch: number
  /** The pose drawn this frame (the crane's while launching or recovering). */
  shown: ShipPoseLike & { u: number; v: number }
  /** Cosmetic 25 mm rounds while its trigger is down. */
  rounds: BoatRounds
  turret: ReturnType<typeof makeTurret>
  /** Rounds fired since the last frame (muzzle flash and sound). */
  fired: number
  /** The sinking has been shown (its explosion), and the slams already heard. */
  exploded: boolean
  slams: number
  seen: number
}

const cp: CranePose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 }
const mp: Vec3 = [0, 0, 0]
const md: Vec3 = [0, 0, 0]
const tgt = { x: 0, z: 0, heading: 0 }
const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))

/**
 * Every other boat in the room, from the room's `boats` frames (10 Hz): the plan pose dead-reckoned to our sea time and
 * glided onto (like remote carriers), the bob, pitch, roll, slams and air time computed here on our own copy of the sea
 * (a boat's motion is far livelier than a carrier's, so it is never sent), the crane poses on our copy of its carrier,
 * the turret slewing to its reported aim, cosmetic rounds while it fires, and the sinking.
 */
export class RemoteBoats {
  readonly boats = new Map<number, RemoteBoat>()
  private frame = 0

  /** The room's latest boats (ours skipped), every frame. */
  sync(tuples: ReadonlyMap<number, BoatTuple>, me: number, t: number): void {
    this.frame++
    for (const [id, tuple] of tuples) {
      if (id === me) continue
      let r = this.boats.get(id)
      const n = unpackBoat(tuple)
      if (!r) {
        const b = makeBoat(n.x, n.z, n.heading, t)
        this.boats.set(id, (r = { id, net: n, boat: b, yaw: n.yaw, pitch: n.pitch, shown: { x: n.x, z: n.z, heave: 0, heading: n.heading, pitch: 0, roll: 0, u: 0, v: 0 }, rounds: new BoatRounds(48), turret: makeTurret(), fired: 0, exploded: false, slams: 0, seen: 0 }))
        r.rounds.hits = false
      }
      // A recovered boat that launches again is a new one.
      if (r.net.mode !== n.mode && n.mode === BOAT_MODE.launch) r.exploded = false
      r.net = n
      r.seen = this.frame
    }
    for (const [id, r] of this.boats) if (r.seen !== this.frame) this.boats.delete(id)
  }

  /**
   * Advances every boat to sea time t (dt since the last frame): plan pose, float, crane, turret, cosmetic rounds.
   * `ship(id)` is a carrier as drawn here.
   */
  update(dt: number, t: number, sea: Sea, ship: (id: number) => (ShipPoseLike & { u: number }) | null, world: Parameters<BoatRounds["step"]>[4]): void {
    const water = (x: number, z: number) => seaHeight(sea, x, z, t)
    for (const r of this.boats.values()) {
      const n = r.net
      const b = r.boat
      const s = r.shown
      if (n.mode === BOAT_MODE.launch || n.mode === BOAT_MODE.recover) {
        const home = ship(n.ship)
        if (home) {
          cranePose(Math.max(0, t - n.modeAt), home, water, n.mode === BOAT_MODE.recover ? n.from : null, cp)
          Object.assign(s, { x: cp.x, z: cp.z, heave: cp.y, heading: cp.heading, pitch: cp.pitch, roll: cp.roll, u: home.u, v: 0 })
        }
        // Afloat again at the crane point when it lets go.
        Object.assign(b, makeBoat(s.x, s.z, s.heading, t), { heave: s.heave })
      } else {
        extrapolateBoat(n, t, tgt)
        const dx = tgt.x - b.x
        const dz = tgt.z - b.z
        const k = Math.hypot(dx, dz) > SNAP ? 1 : 1 - Math.exp(-dt / LAG)
        b.x += dx * k
        b.z += dz * k
        b.heading = wrap(b.heading + wrap(tgt.heading - b.heading) * k)
        b.u = n.u
        b.v = n.v
        b.r = n.r
        b.power = n.power
        b.rudder = n.rudder
        b.boosting = n.boosting
        if (n.mode === BOAT_MODE.sunk) {
          // Going down: the stern first, then under.
          const u = Math.min(1, Math.max(0, t - n.modeAt) / BOAT_HEALTH.sink)
          const wy = water(b.x, b.z)
          b.heave += (wy - 1.2 - 7 * u * u - b.heave) * (1 - Math.exp(-dt * 1.5))
          b.pitch += (0.32 * Math.min(1, u * 2) - b.pitch) * (1 - Math.exp(-dt * 1.2))
          b.roll += (0.25 * Math.min(1, u * 2) - b.roll) * (1 - Math.exp(-dt))
          b.t = t
        } else {
          // Float on our own sea in steps no longer than the sim's.
          let left = Math.min(0.25, Math.max(0, t - b.t))
          if (t - b.t > 1 || t < b.t - 1) left = BOAT.tick
          while (left > 1e-6) {
            const h = Math.min(BOAT.tick, left)
            b.t = t - left + h
            boatFloat(b, sea, h)
            left -= h
          }
          b.t = t
        }
        Object.assign(s, { x: b.x, z: b.z, heave: b.heave, heading: b.heading, pitch: b.pitch, roll: b.roll, u: b.u, v: b.v })
      }
      const kt = 1 - Math.exp(-dt / TURRET_LAG)
      r.yaw += (n.yaw - r.yaw) * kt
      r.pitch += (n.pitch - r.pitch) * kt
      // Cosmetic rounds at the gun's rate while its trigger is down.
      const tr = r.turret
      const shots = n.mode === BOAT_MODE.drive ? turretGun(tr, n.firing, Math.min(dt, 0.1)) : 0
      if (shots > 0) {
        const [vx, vz] = boatVelocity(b)
        muzzleWorld(s, r.yaw, r.pitch, mp, md)
        for (let i = 0; i < shots; i++) r.rounds.fire(r.id, -1, tr.round++, mp[0], mp[1], mp[2], md[0], md[1], md[2], vx, vz)
        r.fired += shots
      }
      if (r.rounds.live) r.rounds.step(Math.min(dt, 0.05), t, [], [], world, () => {})
    }
  }

  /** Remote boats on the water as weapons see them (for our 25 mm rounds), with their teams. */
  targets(team: (id: number) => number, alive: (id: number) => boolean, out: BoatTarget[]): BoatTarget[] {
    out.length = 0
    for (const r of this.boats.values()) {
      if (r.net.mode !== BOAT_MODE.drive) continue
      const [vx, vz] = boatVelocity(r.boat)
      out.push({ id: r.id, team: team(r.id), pose: r.shown, vx, vz, alive: alive(r.id) })
    }
    return out
  }
}

