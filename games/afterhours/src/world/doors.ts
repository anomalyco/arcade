import type * as THREE from "three/webgpu"
import type { Box, Floor, WorldContext } from "./context"
import { heightAt } from "./height"
import { DoorAudio, type DoorSound, type DoorVoice } from "./doors/audio"
import { profileFor, stepMotion, type MotionState, type Profile } from "./doors/motion"
import { DoorPrompt, type DoorVerb } from "./doors/hud"

/*
 * Shared doors: every hinged, sliding or roll-up door in the world goes through `ctx.doors.add`. The system owns the
 * leaf's transform, its collider (an oriented box that follows the leaf, read by the player every move), the heavy
 * eased motion (`doors/motion.ts`: latch hesitation, ease-in, slow travel, door-closer approach and latch; E mid-swing
 * reverses), the KeyE interaction and prompt, and the procedural sounds (`doors/audio.ts`: speed-driven creak).
 *
 * MIGRATION (static leaf + collider → ctx.doors.add)
 *
 *  1. Build the leaf as its own Object3D (a Group or Mesh), NOT merged into the module's static batch. Its local
 *     origin is the hinge at floor level: the panel spans local x ∈ [0, width] (pass a negative width when it extends
 *     towards -x), y ∈ [0, height], z ∈ [-thickness/2, thickness/2]. Give it the CLOSED orientation with
 *     `leaf.rotation.y` (the yaw you used to bake in, minus any "stands open" angle). Add it to your module root (the
 *     untransformed group `build(ctx)` receives as `ctx.scene`), never to a transformed sub-group: `add` sets
 *     `leaf.position = hinge`, and `hinge` is in world coordinates.
 *  2. Replace "door stands open" with `startOpen` (0..1 of `openAngle`), not a baked rotation.
 *  3. Delete the leaf's static collider from `ctx.colliders` (the old axis-aligned box over the open leaf is what made
 *     the guard booth unenterable). The system collides the leaf itself.
 *  4. Call:
 *       const door = ctx.doors.add({
 *         id: "booth", leaf, hinge: [hx, floorY, hz], width: -0.95, height: 2.0, thickness: 0.045,
 *         openAngle: Math.PI * 0.5,  // sign = fixed swing direction (+ = counter-clockwise seen from above)
 *         swing: "auto",              // "auto": opens away from the player; "fixed": always sign(openAngle)
 *         startOpen: 0, sound: "steel",
 *         mass: 1.2,                  // optional: heavier/lighter than a typical door of this sound (time ∝ √mass)
 *         // duration: 2.4,           // optional: explicit seconds for a full swing (overrides mass)
 *       })
 *     Typical full-swing times: wood 1.5 s, glass 1.45 s, steel 1.9 s, gate 3.6 s, roll-up (slide axis ≈ ±Y) 3.0 s.
 *     Double doors: give both leaves ids and `double: "<other id>"` on each; one E press swings both.
 *     Sliding / roll-up doors: `slide: { axis: [0, 1, 0], distance: 2.2 }` (world unit axis) translates the leaf
 *     instead of rotating it; `onMove(t)` lets you drive custom visuals (slats coiling into a drum) from the 0..1 state.
 *     Locked doors: `locked: true` (E rattles, prompt says Locked); flip `door.locked` at runtime to unlock.
 *     Body push: an ajar or open leaf yields when the player walks or runs into it from the side it swings away from
 *     (slow push at a walk, banging open at a run, coasting and a soft bounce off the open stop). Shut doors need E,
 *     except `panic: true` (panic-bar fire doors; default for gates), which push open from the push side.
 *     `closer: true` (default = `panic`) makes a used door draw itself slowly shut ~4 s after coming to rest.
 *  5. Pick `openAngle` so the fully open leaf (plus ~4% overshoot) clears jambs, walls and furniture on BOTH sides when
 *     `swing: "auto"`; use `swing: "fixed"` where one side is blocked (a door against a corridor wall).
 *  6. Avoid putting the leaf inside a transformed parent; if you must, keep the parent translation-only and pass the
 *     hinge in world space anyway (the collider uses `hinge`; only the visual would be off).
 *
 * DOORWAY RULE (how the opening must be cut)
 *
 *  - Wall colliders stop at the jambs: leave a real gap at least as wide as the leaf (≥ 0.8 m clear; the player is a
 *    0.3 m radius circle, so anything under 0.62 m is impassable).
 *  - No collider across the opening, at any height the player's body occupies (from floor + 0.45 m up to 1.75 m).
 *    Head jambs/lintels above 1.9 m are fine.
 *  - Flush threshold: the floor (terrain or a `ctx.floors` slab) on both sides and in the opening must be within
 *    0.45 m of `hinge[1]`; extend slabs through the wall thickness so there is no hole under the leaf. No threshold
 *    collider: a raised sill is geometry only.
 *  - Check with `bun scripts/doors-check.ts --all` (walks the player through every registered door and reports
 *    `ctx.doors.audit()` problems).
 */

export type { DoorSound }

export type DoorSpec = {
  /** Stable id (needed for `double`, `get`, and the doors check script). Default: auto. */
  id?: string
  /** The moving leaf; pivot at the hinge, rotates about Y (or translates along `slide.axis`). */
  leaf: THREE.Object3D
  /** Hinge (or sliding origin) in world coordinates, at floor level. */
  hinge: readonly [number, number, number]
  /** Leaf length along its local +x (negative: extends towards -x). */
  width: number
  height: number
  thickness: number
  /** Fully open swing in radians; the sign is the swing direction used by `swing: "fixed"` and by `startOpen`. */
  openAngle: number
  /** Initial open fraction 0..1. */
  startOpen?: number
  /** "auto" (default): opens away from the player. "fixed": always towards sign(openAngle). */
  swing?: "auto" | "fixed"
  locked?: boolean
  /** Partner leaf id for double doors; both swing together. */
  double?: string
  sound?: DoorSound
  /** Sliding / roll-up door: translate the leaf `distance` metres along the world unit `axis` instead of rotating. */
  slide?: { axis: readonly [number, number, number]; distance: number }
  /** Weight relative to a typical door of this `sound` (1); travel time scales with √mass. */
  mass?: number
  /** Seconds for a full 0 → 1 travel at the default speed (overrides `mass`). */
  duration?: number
  /**
   * Opens to a body push even when shut (panic-bar fire doors, swing gates): from the push side only, i.e. the side the
   * door swings away from (either side for `swing: "auto"`). Default: true for gates. Other doors yield to a push only
   * once ajar (amount > 0.02); shut and latched they need E.
   */
  panic?: boolean
  /** Door closer: once the player has used it, it slowly swings shut ~4 s after coming to rest. Default: `panic`. */
  closer?: boolean
  /** Called whenever the leaf moves, with the open fraction (may overshoot 1 slightly on hinged doors). */
  onMove?: (t: number) => void
}

export type DoorHandle = {
  readonly id: string
  /** Current open fraction (0 closed, 1 open). */
  readonly amount: number
  /** True once commanded open (even while still swinging). */
  readonly isOpen: boolean
  locked: boolean
  open(): void
  close(): void
  toggle(): void
}

export type DoorIssue = { id: string; issue: string }

const REACH = 1.8
const PLAYER_R = 0.3
const PLAYER_STEP = 0.45
const PLAYER_EYE = 1.65
const SUB = 1 / 120
/** Below this open fraction a door counts as shut and latched (body pushes don't move it unless `panic`). */
const LATCHED = 0.02
/** Seconds a door with a closer rests open before it swings shut. */
const CLOSER_DELAY = 3

type PlayerRef = { pos: { x: number; y: number; z: number }; camera: THREE.PerspectiveCamera }

class Door implements DoorHandle {
  readonly id: string
  locked: boolean
  readonly hx: number
  readonly hy: number
  readonly hz: number
  readonly yaw0: number
  readonly xa: number
  readonly xb: number
  readonly ht: number
  readonly height: number
  readonly swingMag: number
  readonly reachR: number
  readonly profile: Profile
  t: number
  v = 0
  hold = 0
  plan: MotionState["plan"] = null
  tooth = 0
  target: number
  dir: number
  rattle = 0
  active = false
  /** Coasting after a body push: no plan, `v` decays with hinge friction and bounces off the open stop. */
  free = false
  /** Closing under its own closer (slower than a hand). */
  slow = false
  /** Used by the player since it last closed (arms the closer). */
  touched = false
  /** Seconds at rest open (closer countdown). */
  idle = 0
  /** Moved by an agent through `Doors.drive` (no door-system sounds; the agent plays its own) at `rate` × speed. */
  driven = false
  rate = 1
  /** Open fraction at the start of this frame (push velocity), and the frame of the last push contact. */
  t0 = 0
  contact = -9
  readonly panic: boolean
  readonly closer: boolean
  // Current pose (collider): yaw and offset from the hinge.
  yaw: number
  ox = 0
  oy = 0
  oz = 0

  constructor(
    readonly spec: DoorSpec,
    readonly sys: Doors,
    id: string,
  ) {
    this.id = id
    this.locked = !!spec.locked
    ;[this.hx, this.hy, this.hz] = spec.hinge
    this.yaw0 = spec.leaf.rotation.y
    this.xa = Math.min(0, spec.width)
    this.xb = Math.max(0, spec.width)
    this.ht = Math.max(spec.thickness, 0.05) / 2
    this.height = spec.height
    this.swingMag = Math.abs(spec.openAngle)
    this.reachR = Math.abs(spec.width) + (spec.slide ? Math.abs(spec.slide.distance) : 0) + 0.5
    this.dir = Math.sign(spec.openAngle) || 1
    this.profile = profileFor(spec.sound ?? "steel", spec.slide, spec.mass, spec.duration)
    this.panic = !spec.slide && (spec.panic ?? this.profile.kind === "gate")
    this.closer = !spec.slide && (spec.closer ?? this.panic)
    this.t = this.target = Math.max(0, Math.min(1, spec.startOpen ?? 0))
    this.tooth = Math.floor(this.t * this.profile.teeth)
    this.yaw = this.yaw0
    this.pose(this.t)
    this.apply()
  }

  get amount() {
    return Math.max(0, Math.min(1, this.t))
  }
  get isOpen() {
    return this.target > 0.5
  }
  open() {
    this.sys.command(this, 1, true)
  }
  close() {
    this.sys.command(this, 0, true)
  }
  toggle() {
    this.sys.command(this, this.isOpen ? 0 : 1, true)
  }

  /** Sets yaw/offset for open fraction `t` (the collider pose). */
  pose(t: number) {
    const s = this.spec.slide
    if (s) {
      this.yaw = this.yaw0
      this.ox = s.axis[0] * s.distance * t
      this.oy = s.axis[1] * s.distance * t
      this.oz = s.axis[2] * s.distance * t
    } else this.yaw = this.yaw0 + this.dir * this.swingMag * t
  }

  apply() {
    const leaf = this.spec.leaf
    const r = this.rattle > 0 ? Math.sin(this.rattle * 70) * this.rattle * 0.03 : 0
    leaf.position.set(this.hx + this.ox, this.hy + this.oy, this.hz + this.oz)
    leaf.rotation.y = this.yaw + (this.spec.slide ? 0 : r)
    if (this.spec.slide && r) leaf.position.x += r * 0.2 * Math.cos(this.yaw0)
    this.spec.onMove?.(this.t)
  }

  /** How far a player circle at (px, pz) penetrates the leaf at the current pose (≤ 0: clear). */
  penetration(px: number, pz: number, feet: number, head: number, r: number) {
    const y0 = this.hy + this.oy
    if (y0 > head || y0 + this.height < feet) return -1
    const tx = px - this.hx - this.ox
    const tz = pz - this.hz - this.oz
    const c = Math.cos(this.yaw)
    const s = Math.sin(this.yaw)
    const lx = tx * c - tz * s
    const lz = tx * s + tz * c
    const cx = Math.max(this.xa, Math.min(lx, this.xb))
    const cz = Math.max(-this.ht, Math.min(lz, this.ht))
    return r - Math.hypot(lx - cx, lz - cz)
  }

  /**
   * Ray (world) vs the leaf box at its current pose, or (`opening`) vs the closed doorway's slab (±`pad` m deep).
   * Returns the hit distance, or -1.
   */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, opening = false, pad = 0.04) {
    const yaw = opening ? this.yaw0 : this.yaw
    const tx = ox - this.hx - (opening ? 0 : this.ox)
    const ty = oy - this.hy - (opening ? 0 : this.oy)
    const tz = oz - this.hz - (opening ? 0 : this.oz)
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const o = [tx * c - tz * s, ty, tx * s + tz * c]
    const d = [dx * c - dz * s, dy, dx * s + dz * c]
    const lo = [this.xa - 0.03, 0, -this.ht - pad]
    const hi = [this.xb + 0.03, this.height, this.ht + pad]
    return slab(o, d, lo, hi)
  }

  /** Distance from a world point to the nearest point of the leaf box at its current pose. */
  nearest(px: number, py: number, pz: number) {
    const tx = px - this.hx - this.ox
    const ty = py - this.hy - this.oy
    const tz = pz - this.hz - this.oz
    const c = Math.cos(this.yaw)
    const s = Math.sin(this.yaw)
    const lx = tx * c - tz * s
    const lz = tx * s + tz * c
    const qx = lx - Math.max(this.xa, Math.min(lx, this.xb))
    const qy = ty - Math.max(0, Math.min(ty, this.height))
    const qz = lz - Math.max(-this.ht, Math.min(lz, this.ht))
    return Math.hypot(qx, qy, qz)
  }

  /** Wide leaves (gates) and sliding/roll-up doors can also be closed by aiming at the open doorway itself. */
  get wide() {
    // Small controls (buttons, hatches) are only ever targeted on themselves: a pressed button must not claim the air
    // in front of it and steal focus from its neighbour.
    if (this.height < 1.2) return false
    return !!this.spec.slide || this.xb - this.xa > 1.5
  }

  /** Centre of the leaf at the current pose (world). */
  centre(out: { x: number; y: number; z: number }) {
    const mx = (this.xa + this.xb) / 2
    out.x = this.hx + this.ox + mx * Math.cos(this.yaw)
    out.y = this.hy + this.oy + this.height / 2
    out.z = this.hz + this.oz - mx * Math.sin(this.yaw)
    return out
  }
}

function slab(o: number[], d: number[], lo: number[], hi: number[]) {
  let t0 = 0
  let t1 = Infinity
  for (let i = 0; i < 3; i++) {
    const di = d[i]!
    if (Math.abs(di) < 1e-9) {
      if (o[i]! < lo[i]! || o[i]! > hi[i]!) return -1
      continue
    }
    let a = (lo[i]! - o[i]!) / di
    let b = (hi[i]! - o[i]!) / di
    if (a > b) [a, b] = [b, a]
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, b)
    if (t0 > t1) return -1
  }
  return t0
}

export class Doors {
  private list: Door[] = []
  private byId = new Map<string, Door>()
  private player: PlayerRef | null = null
  private colliders: Box[] = []
  private floors: Floor[] = []
  private settings: Record<string, unknown> = {}
  private audio: DoorAudio | null
  private prompt: DoorPrompt | null = null
  private focus: Door | null = null
  private frame = 0
  private lastDt = 1 / 60
  private tmp = { x: 0, y: 0, z: 0 }

  constructor(private quiet: boolean) {
    this.audio = quiet ? null : new DoorAudio()
    ;(globalThis as { __afterhoursDoors?: Doors }).__afterhoursDoors = this
  }

  /** Registers a door; see the migration note at the top of this file. */
  add(spec: DoorSpec): DoorHandle {
    const id = spec.id ?? `door-${this.list.length}`
    if (this.byId.has(id)) throw new Error(`doors: duplicate id ${id}`)
    const d = new Door(spec, this, id)
    this.list.push(d)
    this.byId.set(id, d)
    return d
  }

  get(id: string): DoorHandle | undefined {
    return this.byId.get(id)
  }

  /** All registered doors (automation and the doors check). */
  all(): readonly DoorHandle[] {
    return this.list
  }

  /** Wires the player in (called once by `Player`). Adds the doors' Lab controls. */
  attach(ctx: WorldContext, player: PlayerRef) {
    this.player = player
    this.colliders = ctx.colliders
    this.floors = ctx.floors
    this.settings = ctx.settings
    ctx.settings["doors.speed"] ??= 1
    ctx.settings["doors.creak"] ??= 1
    ctx.controls.push(
      { key: "doors.speed", label: "Door speed", group: "Doors", unit: "×", min: 0.25, max: 3, step: 0.05 },
      { key: "doors.creak", label: "Creak volume", group: "Doors", min: 0, max: 2, step: 0.05 },
    )
    if (!this.quiet && typeof document !== "undefined") this.prompt = new DoorPrompt()
  }

  /**
   * The player circle moving from (x, z) to (nx, nz) against the door leaves. Returns the fraction of the move to make:
   * 1 (clear), 0 (blocked by a leaf), or in between when the body pushes a leaf open (resistance by the door's mass
   * and the lever arm). A pushed leaf is swung just far enough to clear the new position (so there is never overlap or
   * jitter) and keeps that angular velocity, coasting on after the player stops. Leaves only ever move away from the
   * player, and moves that leave or reduce an overlap are always allowed, so a door can never trap anyone.
   */
  push(x: number, z: number, nx: number, nz: number, feet: number, head: number, r: number) {
    let k = 1
    for (const d of this.list) {
      if (Math.abs(nx - d.hx) > d.reachR + r || Math.abs(nz - d.hz) > d.reachR + r) continue
      const pn = d.penetration(nx, nz, feet, head, r)
      if (pn <= 0 || pn <= d.penetration(x, z, feet, head, r) - 1e-6) continue
      const lever = this.yieldTo(d, x, z, nx, nz, feet, head, r)
      if (lever < 0) return 0
      // Heavier doors and pushes near the hinge slow the player more.
      k = Math.min(k, (0.7 + 0.3 * lever) / (1 + 0.12 * d.profile.duration))
    }
    return k
  }

  /** True when moving from (x, z) to (nx, nz) would push deeper into a leaf that won't yield. */
  blocks(x: number, z: number, nx: number, nz: number, feet: number, head: number, r: number) {
    return this.push(x, z, nx, nz, feet, head, r) === 0
  }

  /**
   * Swings `d` open just far enough to clear a player circle at (nx, nz), if the body can push it: unlocked, ajar (or
   * a panic door), and the player on the side it swings away from. Returns the lever arm 0..1 (contact distance from
   * the hinge over the leaf length), or -1 when the leaf holds.
   */
  private yieldTo(d: Door, x: number, z: number, nx: number, nz: number, feet: number, head: number, r: number) {
    if (d.spec.slide || d.locked || d.hold > 0) return -1
    const shut = d.t < LATCHED
    if (shut && !d.panic) return -1
    if (shut && (d.spec.swing ?? "auto") === "auto") d.dir = this.sideDir(d, x, z)
    // Increasing t moves the leaf towards local -z·dir·sign(width): the player must be on the other side.
    const c = Math.cos(d.yaw)
    const s = Math.sin(d.yaw)
    const lz = (x - d.hx) * s + (z - d.hz) * c
    const w = Math.sign(d.spec.width) || 1
    const t0 = d.t
    let t: number
    if (Math.sign(lz) === d.dir * w) {
      // Pushing it open: swing just far enough to clear the body, unless it is already against its open stop.
      d.pose(1)
      if (d.penetration(nx, nz, feet, head, r) > 0) {
        d.pose(t0)
        return -1
      }
      let lo = t0
      let hi = 1
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2
        d.pose(mid)
        if (d.penetration(nx, nz, feet, head, r) > 0) lo = mid
        else hi = mid
      }
      t = Math.min(1, hi + 0.002)
    } else {
      // From the side it opens towards: an open leaf standing across the way (a fire-escape door over a narrow
      // landing) is pushed back towards its frame, but never shut and latched by the body; a shut door just blocks.
      if (shut) return -1
      const floor = LATCHED + 0.01
      d.pose(floor)
      if (d.penetration(nx, nz, feet, head, r) > 0) {
        d.pose(t0)
        return -1
      }
      let lo = floor
      let hi = t0
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2
        d.pose(mid)
        if (d.penetration(nx, nz, feet, head, r) > 0) hi = mid
        else lo = mid
      }
      t = Math.max(floor, lo - 0.002)
    }
    d.pose(t)
    d.t = d.target = t
    d.plan = null
    d.free = true
    d.slow = false
    d.driven = false
    d.rate = 1
    d.touched = true
    d.idle = 0
    d.active = true
    const vmax = 3 / d.profile.duration
    const v = Math.max(-vmax, Math.min(vmax, (t - d.t0) / Math.max(1e-3, this.lastDt)))
    if (v > 0 ? v > d.v : v < d.v) d.v = v
    // A fast first contact (running into it) bangs.
    if (this.frame - d.contact > 3 && d.v * d.profile.duration > 1.2) this.audio?.bump(d.spec.sound ?? "steel", this.pan(d), Math.min(1, (d.v * d.profile.duration) / 3))
    d.contact = this.frame
    d.apply()
    return Math.min(1, Math.hypot(nx - d.hx, nz - d.hz) / Math.max(0.1, d.xb - d.xa))
  }

  /** Swing sign that moves the leaf away from a body at (x, z). */
  private sideDir(d: Door, x: number, z: number) {
    const side = (x - d.hx) * Math.sin(d.yaw0) + (z - d.hz) * Math.cos(d.yaw0)
    return (Math.sign(side) || 1) * (Math.sign(d.spec.width) || 1)
  }

  /** KeyE: toggles the door under the crosshair. Returns the door used, if any. */
  use(): DoorHandle | null {
    this.audio?.unlock()
    const d = this.pick()
    if (!d) return null
    if (d.locked || (d.spec.double && this.byId.get(d.spec.double)?.locked)) {
      d.rattle = 0.35
      d.active = true
      this.audio?.rattle(d.spec.sound ?? "steel", this.pan(d))
      this.prompt?.flash()
      return d
    }
    this.command(d, d.isOpen ? 0 : 1, true)
    this.audio?.confirm()
    return d
  }

  /** What the door audio needs about a door: its sound, motion kind, panic bar, whether it's a small control, and
   *  where its leaf is. */
  private voiceOf(d: Door): DoorVoice {
    const c = d.centre(this.tmp)
    return { sound: d.spec.sound ?? "steel", kind: d.profile.kind, panic: d.panic, control: d.height < 1.2, x: c.x, y: c.y, z: c.z }
  }

  /**
   * Moves a door for an agent other than the player (the hunter, src/game/hunter): towards `target` (0 shut, 1 open),
   * swinging away from the point `from`, at `rate` × the normal speed, without the door system's own sounds (the agent
   * plays positional ones). The player's next use or push, or the door's closer, gives it back its sounds.
   */
  drive(id: string, target: number, o: { from?: { x: number; z: number }; rate?: number } = {}) {
    const d = this.byId.get(id)
    if (!d || d.locked) return false
    const p = d.spec.double ? this.byId.get(d.spec.double) : undefined
    for (const e of p ? [d, p] : [d]) if (o.from && target > 0 && e.t < 0.05 && !e.spec.slide && (e.spec.swing ?? "auto") === "auto") e.dir = this.sideDir(e, o.from.x, o.from.z)
    this.command(d, target, true, o.rate ?? 1)
    return true
  }

  /** Sets a door's target (and its partner's). `driven` (a rate): an agent's silent `drive`. */
  command(d: Door, target: number, partner: boolean, driven = 0) {
    d.driven = driven > 0
    d.rate = driven > 0 ? driven : 1
    if (target === d.target && !d.free) return
    d.free = false
    d.slow = false
    d.touched = true
    d.idle = 0
    const atRest = !d.active || (Math.abs(d.v) < 1e-3 && d.hold <= 0)
    if (atRest && !driven && target > 0 && d.t < 0.05 && !d.spec.slide && (d.spec.swing ?? "auto") === "auto") d.dir = this.awayDir(d)
    d.target = target
    d.active = true
    if (atRest) {
      // From rest the latch (or the gate's chain) releases first; mid-swing a reversal just brakes and turns round.
      d.hold = d.profile.hesitate * (target > d.t ? 1 : 0.5)
      d.plan = null
      if (this.audio && this.player && !driven) {
        const v = this.voiceOf(d)
        if (v.control) this.audio.control(v)
        else if (d.profile.kind === "rollup" || d.profile.kind === "slide") this.audio.moveStart(v)
        else if (target > d.t && d.t < 0.02) this.audio.release(v.sound, v.kind, this.pan(d), v)
      }
    }
    const p = partner && d.spec.double ? this.byId.get(d.spec.double) : undefined
    if (p) this.command(p, target, false, driven)
  }

  /** Swing sign that moves the leaf's free edge away from the player (by side of the door plane, else facing). */
  private awayDir(d: Door) {
    const fixed = Math.sign(d.spec.openAngle) || 1
    const p = this.player
    if (!p) return fixed
    const nx = Math.sin(d.yaw0)
    const nz = Math.cos(d.yaw0)
    let side = (p.pos.x - d.hx) * nx + (p.pos.z - d.hz) * nz
    if (Math.abs(side) < 0.05) {
      const e = p.camera.matrixWorld.elements
      side = e[8]! * nx + e[10]! * nz // camera +z points backwards: pushing forward = away
    }
    const w = Math.sign(d.spec.width) || 1
    return (Math.sign(side) || 1) * w
  }

  private pan(d: Door) {
    const p = this.player
    if (!p) return 0
    const c = d.centre(this.tmp)
    const e = p.camera.matrixWorld.elements
    const dx = c.x - e[12]!
    const dz = c.z - e[14]!
    const len = Math.hypot(dx, dz) || 1
    return ((dx * e[0]! + dz * e[2]!) / len) * 0.7
  }

  /**
   * The door under the crosshair, not hidden behind a wall collider. A leaf counts when the crosshair is on it and
   * its nearest point is within reach (so a 2.8 m gate leaf can be grabbed by the end you stand at, wherever you aim
   * along it); wide and sliding doors also count when the crosshair is on their open doorway within reach.
   */
  private pick(): Door | null {
    const p = this.player
    if (!p) return null
    const e = p.camera.matrixWorld.elements
    const ox = e[12]!
    const oy = e[13]!
    const oz = e[14]!
    const dx = -e[8]!
    const dy = -e[9]!
    const dz = -e[10]!
    let best: Door | null = null
    let bestT = Infinity
    for (const d of this.list) {
      if (Math.abs(ox - d.hx) > d.reachR + REACH || Math.abs(oz - d.hz) > d.reachR + REACH) continue
      let t = d.ray(ox, oy, oz, dx, dy, dz)
      if (t > REACH && !(t <= REACH + d.xb - d.xa && d.nearest(ox, oy, oz) <= REACH)) t = -1
      if (d.wide && d.t > 0.02) {
        const to = d.ray(ox, oy, oz, dx, dy, dz, true, 0.25)
        if (to >= 0 && to <= REACH && (t < 0 || to < t)) t = to
      }
      if (t < 0) continue
      // Paired leaves meet at the stiles, so one ray can hit both at almost the same distance: take the leaf whose
      // centre is nearer the point under the crosshair (the one actually aimed at), not whichever was registered last.
      if (best && Math.abs(t - bestT) < 0.03 && best.spec.double === d.id) {
        const hx = ox + dx * t
        const hz = oz + dz * t
        const cd = d.centre(this.tmp)
        const dd = Math.hypot(cd.x - hx, cd.z - hz)
        const cb = best.centre(this.tmp)
        if (dd < Math.hypot(cb.x - hx, cb.z - hz)) {
          best = d
          bestT = Math.min(t, bestT)
        }
        continue
      }
      if (t < bestT) {
        bestT = t
        best = d
      }
    }
    if (!best) return null
    const o = [ox, oy, oz]
    const dir = [dx, dy, dz]
    for (const b of this.colliders) {
      if (b.max[0] < ox - bestT || b.min[0] > ox + bestT || b.max[2] < oz - bestT || b.min[2] > oz + bestT) continue
      const t = slab(o, dir, b.min as unknown as number[], b.max as unknown as number[])
      if (t >= 0 && t < bestT - 0.05) return null
    }
    return best
  }

  /** Per frame (called by the player before it moves): animates doors and updates the prompt. */
  update(dt: number) {
    this.frame++
    this.lastDt = dt
    const speed = Number(this.settings["doors.speed"] ?? 1)
    if (this.audio) {
      this.audio.creakVolume = Number(this.settings["doors.creak"] ?? 1)
    }
    const p = this.player?.pos
    const feet = p ? p.y + PLAYER_STEP : 0
    const head = p ? p.y + PLAYER_EYE + 0.1 : 0
    for (const d of this.list) {
      if (!d.active) continue
      if (d.rattle > 0) d.rattle = Math.max(0, d.rattle - dt)
      const sound = d.spec.sound ?? "steel"
      const prof = d.profile
      // An agent's door (`drive`) is silent here: the agent plays its own sounds.
      const audio = d.driven ? null : this.audio
      let left = dt
      while (left > 1e-6) {
        const h = Math.min(SUB, left)
        left -= h
        const prev = d.t
        let t: number
        let bump = 0
        if (d.free) {
          // Coasting after a push: hinge friction, a soft bounce off the open stop. It comes to rest just short of the
          // frame rather than latching (only E or a closer shuts a door).
          d.v *= Math.exp(-2.6 * h)
          t = d.t + d.v * h
          if (t >= 1) {
            t = 1
            bump = d.v * prof.duration
            d.v = d.v > 0.05 ? -d.v * 0.28 : 0
          } else if (t <= LATCHED + 0.01 && d.v < 0) {
            t = Math.min(prev, LATCHED + 0.01)
            d.v = 0
          }
          d.target = t
        } else t = stepMotion(d, prof, d.target, speed * (d.slow ? 0.55 : 1) * d.rate, h)
        const latched = d.target === 0 && t === 0 && prev > 0
        if (p && t !== prev) {
          const before = d.penetration(p.x, p.z, feet, head, PLAYER_R)
          d.pose(t)
          const after = d.penetration(p.x, p.z, feet, head, PLAYER_R)
          if (after > 0 && after > before) {
            // The leaf would hit the player: it stops against them and resumes when they move.
            d.pose(prev)
            d.v = 0
            d.plan = null
            break
          }
        } else d.pose(t)
        if (latched && audio && d.height >= 1.2) audio.latch(sound, prof.kind, this.pan(d), Math.abs(d.v) * prof.duration, this.voiceOf(d))
        if (bump > 0.6) audio?.bump(sound, this.pan(d), Math.min(1, bump / 3))
        if (d.free && t === 0) {
          d.v = 0
          d.free = false
        }
        if (!d.free && t === d.target && !d.plan) d.v = 0
        d.t = t
      }
      if (d.free && Math.abs(d.v) < 0.004) {
        d.free = false
        d.v = 0
        d.target = d.t
      }
      d.t0 = d.t
      if (prof.teeth) {
        const tooth = Math.floor(d.t * prof.teeth + 1e-6)
        if (tooth !== d.tooth && audio) audio.tick(this.pan(d))
        d.tooth = tooth
      }
      // Leaf speed relative to the peak of a full swing (1.875 / duration for the quintic curve).
      if (d.height >= 1.2) audio?.motion(d.id, sound, prof.kind, (Math.abs(d.v) * prof.duration) / (1.875 * Math.max(0.05, speed)), this.pan(d), dt)
      if (!d.free && d.t === d.target && !d.plan && d.hold <= 0 && d.rattle === 0) {
        d.v = 0
        d.pose(d.t)
        if (d.t < LATCHED) d.touched = false
        d.slow &&= d.t > 0
        if (d.closer && d.touched && d.t >= LATCHED) {
          // The closer waits, then draws the leaf shut slowly (the player in the way just stops it).
          d.idle += dt
          if (d.idle > CLOSER_DELAY) {
            d.idle = 0
            d.touched = false
            d.driven = false
            d.rate = 1
            d.slow = true
            d.target = 0
            d.hold = 0.25
            d.plan = null
          }
        } else {
          d.active = false
          this.audio?.stopLoop(d.id)
        }
      }
      d.apply()
    }
    if (this.prompt) {
      const f = this.pick()
      this.focus = f
      let verb: DoorVerb = null
      if (f) verb = f.locked || (f.spec.double && this.byId.get(f.spec.double)?.locked) ? "Locked" : f.isOpen ? "Close" : "Open"
      this.prompt.set(verb)
    }
  }

  /** The door currently under the crosshair (for automation). */
  get focused(): DoorHandle | null {
    return this.focus
  }

  /** Leaf centre of a door at its current pose (automation: aim the camera at it). */
  centreOf(id: string) {
    const d = this.byId.get(id)
    return d ? { ...d.centre({ x: 0, y: 0, z: 0 }) } : null
  }

  /**
   * Checks every door's doorway against the doorway rule: with the door (and its partner) fully open, a player circle
   * fits in the opening and 0.5 m either side, nothing blocks it at body height, and the floor steps ≤ 0.45 m.
   */
  audit(): DoorIssue[] {
    const issues: DoorIssue[] = []
    const saved = this.list.map((d) => [d.t, d.dir] as const)
    for (const d of this.list) d.pose(1)
    for (const d of this.list) {
      // Small "doors" (push buttons, hatches) aren't doorways.
      if (d.height < 1.2) continue
      const partner = d.spec.double ? this.byId.get(d.spec.double) : undefined
      if (d.spec.double && !partner) issues.push({ id: d.id, issue: `partner ${d.spec.double} not registered` })
      // Opening centre: the closed leaf's midpoint, or the midpoint between both closed leaves.
      const mid = (x: Door) => {
        const m = (x.xa + x.xb) / 2
        return [x.hx + m * Math.cos(x.yaw0), x.hz - m * Math.sin(x.yaw0)] as const
      }
      let [cx, cz] = mid(d)
      if (partner) {
        const [px, pz] = mid(partner)
        cx = (cx + px) / 2
        cz = (cz + pz) / 2
      }
      const nx = Math.sin(d.yaw0)
      const nz = Math.cos(d.yaw0)
      const g0 = this.groundAt(cx, cz, d.hy + PLAYER_STEP)
      if (Math.abs(g0 - d.hy) > PLAYER_STEP) issues.push({ id: d.id, issue: `floor in the opening is ${(g0 - d.hy).toFixed(2)} m from the hinge height` })
      for (const s of [-0.6, 0, 0.6]) {
        const x = cx + nx * s
        const z = cz + nz * s
        const g = this.groundAt(x, z, g0 + PLAYER_STEP)
        if (g < g0 - PLAYER_STEP) issues.push({ id: d.id, issue: `drop of ${(g0 - g).toFixed(2)} m at ${s} m` })
        const feet = g + PLAYER_STEP
        const head = g + PLAYER_EYE + 0.1
        const r = PLAYER_R - 0.02
        for (const b of this.colliders) {
          if (b.max[1] < feet || b.min[1] > head) continue
          const qx = Math.max(b.min[0], Math.min(x, b.max[0]))
          const qz = Math.max(b.min[2], Math.min(z, b.max[2]))
          if ((x - qx) ** 2 + (z - qz) ** 2 < r * r) {
            issues.push({ id: d.id, issue: `collider [${b.min.map((v) => v.toFixed(2))}]–[${b.max.map((v) => v.toFixed(2))}] blocks the doorway at ${s} m` })
          }
        }
        for (const o of this.list) {
          if (o.penetration(x, z, feet, head, r) > 0) issues.push({ id: d.id, issue: `open leaf ${o.id} blocks the doorway at ${s} m` })
        }
      }
    }
    this.list.forEach((d, i) => {
      d.dir = saved[i]![1]
      d.pose(saved[i]![0])
    })
    return issues
  }

  private groundAt(x: number, z: number, maxY: number) {
    let g = heightAt(x, z)
    for (const f of this.floors) {
      if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && f.y <= maxY && f.y > g) g = f.y
    }
    return g
  }
}
