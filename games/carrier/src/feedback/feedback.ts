import { DECK_WIDTH, DECK_Y, ISLAND, LENGTH } from "../../shared/carrier-spec"
import type { Missile } from "../../shared/combat"
import { type Archipelago, terrainHeight } from "../../shared/islands"
import { type Vec3, worldToShip } from "../../shared/plane"
import { type Sea, seaHeight } from "../../shared/sea"
import type { ShipPoseLike } from "../../shared/plane"
import type { WeaponFx } from "../render/weapon-fx"
import { Canopy } from "./canopy"
import { type CalloutKind, FeedbackOverlay } from "./callouts"
import { cautionChime, sting } from "./feedback-audio"
import { FEEDBACK } from "./settings"

type Point = { x: number; y: number; z: number }
type Moving = Point & { vx: number; vy: number; vz: number }

/** What the flight seam hands over every frame. */
export type FeedbackFrame = {
  dt: number
  t: number
  paused: boolean
  /** Our jet flies (phase flying, not landing). */
  flying: boolean
  /** Seconds since the wheels left the deck (no scrape calls off the catapult). */
  airborne: number
  /** The cockpit view shows (not chase, not the bombsight). */
  cockpit: boolean
  /** Our jet as drawn, or null. */
  plane: Moving | null
  hp: number
  id: number
  team: number
  eye: ArrayLike<number>
  forward: ArrayLike<number>
  up: ArrayLike<number>
  sea: Sea | null
  arch: Archipelago | null
  ships: readonly (ShipPoseLike & { id: number; team: number })[]
  missiles: readonly Missile[]
}

/** A missile homing on us, followed for CLOSE CALL: closest approach so far and whether it was decoyed. */
type Watch = { min: number; rx: number; ry: number; rz: number; decoyed: boolean; done: boolean; seen: number }

const local: Vec3 = [0, 0, 0]

/**
 * Damage and reward feedback for the pilot, all presentation from events the game already has (the room's `hp`, `kill`,
 * `boom`, `sunk`, `deckkill`, our own world's missiles): nothing here changes the simulation or reaches the room.
 * - Taking damage: a red edge flash scaled by the damage with a wedge toward the attacker, sparks off the airframe
 *   (any jet's: everyone sees them), canopy cracks and oil streaks in the cockpit view, a soft master caution chime at
 *   low health. The damage smoke itself thickens in `Weapons.damageFx` / `WeaponFx.damage`.
 * - Kills: a short punch-in of the view (presentation fov only; sea time and flight run on), a warm edge pulse, debris
 *   tumbling past the canopy if the kill was close, and one sting with the callout.
 * - Callouts with a streak counter: SPLASH ONE, DOUBLE / TRIPLE / MULTI KILL, SHIP HIT, CARRIER SUNK, DECK JET
 *   DESTROYED, CLOSE CALL (an enemy missile passing close or decoyed by our flares near us, or skimming the sea, land, a
 *   deck or an island at speed). `onCallout` (callouts.ts) lets radio chatter voice them.
 */
export class Feedback {
  readonly overlay: FeedbackOverlay
  readonly canopy: Canopy
  /** Kills since our last death. */
  streak = 0
  private multi = 0
  private lastKill = -1e9
  private time = 0
  private edge = 0
  private dirAmt = 0
  private dx = 50
  private dy = 50
  private pulse = 0
  private punch = -1
  private lastHurt = -1e9
  private cautionIn = 0
  private wasHp = 100
  private lastClose = -1e9
  private lastShipHit = -1e9
  private watch = new Map<number, Watch>()
  private frameNo = 0
  private eye: Vec3 = [0, 0, 0]
  private fwd: Vec3 = [0, 0, -1]
  private up: Vec3 = [0, 1, 0]
  private ownVel: Vec3 = [0, 0, 0]
  private flying = false
  private ships: FeedbackFrame["ships"] = []
  private team = -1

  constructor(private fx: WeaponFx) {
    this.overlay = new FeedbackOverlay()
    this.canopy = new Canopy(this.overlay.root)
  }

  /** The presentation fov scale this frame (the kill punch-in), 1 at rest. */
  get fovScale(): number {
    if (this.punch < 0) return 1
    const T = FEEDBACK.punchTime
    const u = this.punch / T
    // Snap in over the first 12%, hold, ease back out.
    const e = u < 0.12 ? u / 0.12 : u < 0.4 ? 1 : 1 - ((u - 0.4) / 0.6) ** 2 * (3 - 2 * ((u - 0.4) / 0.6))
    return 1 - FEEDBACK.punchZoom * Math.max(0, Math.min(1, e))
  }

  /** A new sortie: clean canopy, health full. The streak lives on until we die. */
  sortie(): void {
    this.canopy.clear()
    this.wasHp = 100
    this.watch.clear()
  }

  /** Our jet was destroyed (shot down or crashed): the streak ends. */
  died(): void {
    this.streak = 0
    this.multi = 0
  }

  /**
   * Jet `at` lost `amount` health (the room's `hp`). `own`: ours (edge, canopy, caution); `from`: the attacker's
   * position when known (the edge wedge leans that way).
   */
  struck(own: boolean, amount: number, at: Moving, from: Point | null): void {
    if (FEEDBACK.sparks && !(own && this.canopyShowing)) {
      const n = Math.min(14, 4 + Math.round(amount * 0.8))
      this.fx.strike(at.x + (Math.random() - 0.5) * 6, at.y + (Math.random() - 0.3) * 2, at.z + (Math.random() - 0.5) * 6, at.vx, at.vy, at.vz, n)
    }
    if (!own) return
    this.lastHurt = this.time
    this.edge = Math.min(1, Math.max(this.edge, 0.45 + amount / 30))
    this.canopy.hit(amount)
    if (from && FEEDBACK.edgeDirectional) {
      const dx = from.x - this.eye[0]
      const dy = from.y - this.eye[1]
      const dz = from.z - this.eye[2]
      const f = this.fwd
      const u = this.up
      // Camera right = forward × up.
      const rx = f[1] * u[2] - f[2] * u[1]
      const ry = f[2] * u[0] - f[0] * u[2]
      const rz = f[0] * u[1] - f[1] * u[0]
      const sx = dx * rx + dy * ry + dz * rz
      const sy = dx * u[0] + dy * u[1] + dz * u[2]
      const a = Math.atan2(sy, sx)
      this.dx = 50 + Math.cos(a) * 62
      this.dy = 50 - Math.sin(a) * 62
      this.dirAmt = Math.min(1, Math.max(this.dirAmt, 0.45 + amount / 40))
    }
  }

  private canopyShowing = false

  /**
   * A jet was shot down at `at` (null when not drawn). `mine`: we made the kill (the kill moment and a callout; true
   * returned when the callout's sting played, so the hit marker stays silent). Debris flies past us from any close kill.
   */
  kill(mine: boolean, at: Moving | null): boolean {
    if (at && this.flying) this.debris(at)
    if (!mine) return false
    this.streak++
    this.multi = this.time - this.lastKill <= FEEDBACK.multiWindow ? this.multi + 1 : 1
    this.lastKill = this.time
    this.punch = 0
    this.pulse = 1
    const kind: CalloutKind = this.multi >= 4 ? "multi" : this.multi === 3 ? "triple" : this.multi === 2 ? "double" : "splash"
    return this.call(kind)
  }

  /** We sank a carrier, or destroyed a jet parked on a deck: the callout and its sting (true when it played). */
  sunk(): boolean {
    this.pulse = 1
    return this.call("sunk")
  }
  deckKill(): boolean {
    this.pulse = Math.max(this.pulse, 0.7)
    return this.call("deck-jet")
  }

  /** Our missile or bomb burst without hitting a jet: SHIP HIT when that was on (or against) an enemy carrier. */
  burst(x: number, y: number, z: number): void {
    if (this.time - this.lastShipHit < 1.2) return
    for (const s of this.ships) {
      if (s.team === this.team) continue
      const l = worldToShip(s, x, y, z, local)
      // The hull and island box, with the 25 m a near miss in the water still damages.
      if (Math.abs(l[0]) < DECK_WIDTH / 2 + 25 && Math.abs(l[2]) < LENGTH / 2 + 25 && l[1] < ISLAND.y1 + 10) {
        this.lastShipHit = this.time
        this.call("ship-hit")
        return
      }
    }
  }

  /** Dev preview: a callout with its sting and pulse, as if it happened (src/dev/feedback-lab.ts). */
  preview(kind: CalloutKind): void {
    if (kind === "close-call") this.lastClose = -1e9
    this.call(kind)
  }

  private call(kind: CalloutKind, side = 0): boolean {
    if (!this.overlay.callout(kind, this.streak)) return false
    sting(kind, side)
    return true
  }

  private closeCall(side: number): void {
    if (this.time - this.lastClose < FEEDBACK.closeEvery || this.time - this.lastHurt < 0.8) return
    this.lastClose = this.time
    this.call("close-call", side)
  }

  /** Pieces of the jet flung toward and past the camera, from a kill within `FEEDBACK.debrisRange`. */
  private debris(at: Moving): void {
    const e = this.eye
    const dx = at.x - e[0]
    const dy = at.y - e[1]
    const dz = at.z - e[2]
    const d = Math.hypot(dx, dy, dz)
    const n = FEEDBACK.debrisCount
    if (d > FEEDBACK.debrisRange || n <= 0) return
    const v = this.ownVel
    const f = this.fwd
    for (let i = 0; i < n; i++) {
      // Each piece crosses a point a few metres off our flight path, T seconds from now.
      const T = Math.max(0.25, Math.min(1.1, d / 160)) * (0.75 + Math.random() * 0.5)
      const off = 4 + Math.random() * 14
      const a = Math.random() * Math.PI * 2
      const tx = e[0] + v[0] * T + f[0] * (Math.random() * 6) + Math.cos(a) * off
      const ty = e[1] + v[1] * T + Math.sin(a) * off * 0.6
      const tz = e[2] + v[2] * T + f[2] * (Math.random() * 6) - Math.cos(a) * off * 0.4
      const sx = at.x + (Math.random() - 0.5) * 4
      const sy = at.y + (Math.random() - 0.5) * 3
      const sz = at.z + (Math.random() - 0.5) * 4
      this.fx.shard(sx, sy, sz, (tx - sx) / T, (ty - sy) / T + 4.9 * T, (tz - sz) / T, 0.35 + Math.random() * 0.9, T * 2.2 + 0.8, Math.random() < 0.35)
    }
  }

  /** Per frame, after the weapons. */
  frame(v: FeedbackFrame): void {
    const dt = v.dt
    this.time += dt
    this.frameNo++
    this.eye[0] = v.eye[0]!
    this.eye[1] = v.eye[1]!
    this.eye[2] = v.eye[2]!
    this.fwd[0] = v.forward[0]!
    this.fwd[1] = v.forward[1]!
    this.fwd[2] = v.forward[2]!
    this.up[0] = v.up[0]!
    this.up[1] = v.up[1]!
    this.up[2] = v.up[2]!
    this.ships = v.ships
    this.team = v.team
    this.flying = v.flying && !!v.plane
    const p = v.plane
    if (p) {
      this.ownVel[0] = p.vx
      this.ownVel[1] = p.vy
      this.ownVel[2] = p.vz
    }
    this.canopyShowing = this.flying && v.cockpit
    if (this.punch >= 0) {
      this.punch += dt
      if (this.punch > FEEDBACK.punchTime) this.punch = -1
    }
    this.edge = Math.max(0, this.edge - dt * 1.3)
    this.dirAmt = Math.max(0, this.dirAmt - dt * 1.2)
    this.pulse = Math.max(0, this.pulse - dt / Math.max(0.2, FEEDBACK.punchTime))

    const hp = this.flying ? v.hp : 100
    // Master caution: once on crossing into smoke, then repeating while health is low.
    if (this.flying && !v.paused) {
      const low = FEEDBACK.cautionBelow
      if (hp < low) {
        this.cautionIn -= dt
        if (this.cautionIn <= 0) {
          cautionChime()
          this.cautionIn = FEEDBACK.cautionEvery
        }
      } else {
        this.cautionIn = 0
        if (this.wasHp >= 50 && hp < 50) cautionChime()
      }
    }
    this.wasHp = hp
    if (this.flying && !v.paused && p) {
      this.missileCalls(v, p)
      this.scrapeCalls(v, p)
    } else this.watch.clear()

    this.canopy.update(dt, this.canopyShowing && !v.paused, hp)
    // Low health breathes the damage ring a little (subtle, below the hit flash).
    const breathe = this.flying && hp < FEEDBACK.cautionBelow ? 0.12 + 0.08 * Math.sin(this.time * 3.2) : 0
    const k = FEEDBACK.edge
    const pulse = this.pulse * FEEDBACK.killPulse
    this.overlay.update(dt, Math.min(1, Math.max(this.edge, breathe) * k), this.dirAmt * k, this.dx, this.dy, pulse, this.flying ? this.streak : 0, this.flying && !v.paused)
  }

  /** Enemy missiles homing on us: a pass within `missMetres` we survive, or one decoyed by our flares close by. */
  private missileCalls(v: FeedbackFrame, p: Moving): void {
    for (const m of v.missiles) {
      if (!m.alive || m.kind !== "missile" || m.owner === v.id) continue
      const key = m.owner * 4096 + m.seq
      let w = this.watch.get(key)
      const rx = m.x - p.x
      const ry = m.y - p.y
      const rz = m.z - p.z
      const d = Math.hypot(rx, ry, rz)
      if (!w) {
        if (m.target !== v.id) continue
        w = { min: d, rx, ry, rz, decoyed: false, done: false, seen: 0 }
        this.watch.set(key, w)
      }
      w.seen = this.frameNo
      if (w.done) continue
      // Closest approach along this frame's relative path (a fast pass skips past the minimum between frames).
      const sx = rx - w.rx
      const sy = ry - w.ry
      const sz = rz - w.rz
      const ss = sx * sx + sy * sy + sz * sz
      const u = ss > 0 ? Math.max(0, Math.min(1, -(w.rx * sx + w.ry * sy + w.rz * sz) / ss)) : 1
      const closest = Math.hypot(w.rx + sx * u, w.ry + sy * u, w.rz + sz * u)
      w.min = Math.min(w.min, closest)
      w.rx = rx
      w.ry = ry
      w.rz = rz
      const side = this.side(rx, ry, rz)
      if (m.decoy && !w.decoyed) {
        w.decoyed = true
        if (d < FEEDBACK.flareSave) {
          w.done = true
          this.closeCall(side)
          continue
        }
      }
      // Past the closest point and opening: it missed.
      if (w.min < FEEDBACK.missMetres && d > w.min + 8 && u < 1) {
        w.done = true
        this.closeCall(side)
      }
    }
    for (const [k, w] of this.watch) if (w.seen !== this.frameNo) this.watch.delete(k)
  }

  /** Skimming the sea, land, a carrier's deck or island at speed. */
  private scrapeCalls(v: FeedbackFrame, p: Moving): void {
    if (v.airborne < 4) return
    const speed = Math.hypot(p.vx, p.vy, p.vz)
    if (speed < FEEDBACK.scrapeSpeed) return
    const c = FEEDBACK.clearance
    let floor = v.sea ? seaHeight(v.sea, p.x, p.z, v.t) : 0
    if (v.arch) floor = Math.max(floor, terrainHeight(v.arch, p.x, p.z))
    const clear = p.y - floor
    if (clear > c * 3) this.scrapeArmed = true
    let low = clear < c
    if (!low)
      for (const s of v.ships) {
        const l = worldToShip(s, p.x, p.y, p.z, local)
        if (Math.abs(l[2]) > LENGTH / 2 + 10 || Math.abs(l[0]) > DECK_WIDTH / 2 + 10) continue
        const inIsland = l[0] > ISLAND.x0 - 12 && l[0] < ISLAND.x1 + 12 && l[2] > ISLAND.z0 - 12 && l[2] < ISLAND.z1 + 12
        if (l[1] - DECK_Y < c + 2 || (inIsland && l[1] < ISLAND.y1 + c + 4)) {
          low = true
          break
        }
      }
    // One call per dip: it re-arms once the jet climbs back out.
    if (low && this.scrapeArmed) {
      this.scrapeArmed = false
      this.closeCall(0)
    }
  }
  private scrapeArmed = false

  /** -1 left .. 1 right of the camera, for panning. */
  private side(x: number, y: number, z: number): number {
    const f = this.fwd
    const u = this.up
    const rx = f[1] * u[2] - f[2] * u[1]
    const ry = f[2] * u[0] - f[0] * u[2]
    const rz = f[0] * u[1] - f[1] * u[0]
    const l = Math.hypot(x, y, z) || 1
    return (x * rx + y * ry + z * rz) / l
  }
}
