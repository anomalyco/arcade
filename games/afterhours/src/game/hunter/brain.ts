import * as THREE from "three/webgpu"
import type { Player } from "../../player"
import type { WorldContext } from "../../world/context"
import { CORE } from "../../world/layout"
import { createWendigo, type Wendigo } from "../../creatures/wendigo"
import { NavGraph, type Route, type NavRoom, storeyOf, CELL } from "./nav"
import { lightAt, noiseDistance, type Heard } from "./senses"
import { onNoise, type NoiseEvent } from "./noise"
import { Voice } from "./voice"
import { num } from "./settings"

// The Wendigo as an agent in the building: it moves along real routes (nav.ts), opens and bashes doors, takes the
// stairs, and decides what to do from what it hears and sees, never from where the player really is.
//
// States:
//   roam         wanders room to room, weighted to rooms it hasn't been in lately and to where it heard things;
//                now and then (rarely) settles into an ambush at a stair landing or the lift lobby instead.
//   investigate  goes to where it heard (or glimpsed) something, looks about, then checks the nearest rooms.
//   hunt         has seen you: chases at 4.6 m/s on all fours (the player runs 4.5), re-routing to you while it can
//                see you; once you're out of sight it runs on to where you were heading, briefly.
//   search       lost you: sweeps the rooms round where it last knew you were, checking corners and furniture, opening
//                some closed doors (not all), then gives up after `hunter.searchTime`.
//   ambush       waits, still, at a chokepoint for 15–25 s, listening.
// Fairness: sight needs a clear line (walls, furniture, door leaves) and light; it only ever knows a position it saw or
// heard (heard positions are fuzzed); you hear it coming (footsteps, breath); a grace period after a checkpoint.
// Stance: upright and stooped walking indoors (roam, investigate), on all fours when hunting or searching fast, on the
// stairs and through doorways.

export type HunterMode = "dormant" | "roam" | "investigate" | "hunt" | "search" | "ambush" | "caught"

type Goal = { x: number; z: number; s: number }
type Task = Goal & { look: number; kind: "go" | "room" | "door" | "spot"; room?: string }

export type CatchInfo = { x: number; y: number; z: number; mode: HunterMode }

const UP = new THREE.Vector3(0, 1, 0)

function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Hunter {
  mode: HunterMode = "dormant"
  readonly pos = new THREE.Vector3()
  readonly vel = new THREE.Vector3()
  s = 0
  heading = 0
  time = 0
  grace = 0
  awareness = 0
  /** The route being followed, the next waypoint, and distance along it. */
  route: Route | null = null
  wp = 1
  progress = 0
  goal: Goal | null = null
  /** Last position it knew the player at (seen or heard), and when. */
  memory: (Goal & { y: number; t: number; seen: boolean; vx: number; vz: number }) | null = null
  /** What it has heard lately (debug), and the decaying heat of noises it uses to roam. */
  readonly heard: Heard[] = []
  readonly heat: { x: number; z: number; s: number; t: number; w: number }[] = []
  /** Seen this vision tick (debug), the sight range and cone half-angle in use. */
  seeing = false
  sightRange = 0
  cone = 0
  stance: "quad" | "biped" = "quad"
  /** World y of the ceiling it is fitting its antlers under (debug). */
  ceiling = Infinity
  readonly log: { t: number; event: string; mode: HunterMode; x: number; z: number; s: number }[] = []
  readonly trail: { t: number; x: number; z: number; s: number; mode: HunterMode }[] = []
  readonly nav: NavGraph
  readonly voice: Voice
  /** The Wendigo's body, made by `prepare()` (it loads ~5 MB and compiles its shaders, so not before it's needed). */
  creature: Wendigo | null = null
  catches = 0
  onCatch: (info: CatchInfo) => void = () => {}

  private rng: () => number
  private tasks: Task[] = []
  private task: Task | null = null
  private lookUntil = 0
  private repathAt = 0
  private visionAt = 0
  private stanceAt = 0
  private seenAt = -99
  private lastScream = -99
  private nextBreath = 0
  private nextVocal = 0
  private nextStep = 0
  private foot = 0
  private nextKnock = 0
  private doorIdx = 0
  private doorWait: { door: number; t: number; bash: boolean } | null = null
  private ownDoors = new Set<string>()
  private queue: NoiseEvent[] = []
  private visited = new Map<string, number>()
  private ambushAt = -99
  private glimpseAt = -99
  /** Last sprint it heard (for your heading), and when it last had a fix on you by sight or a sprint. */
  private sprintFix: Goal & { t: number } | null = null
  private trackAt = -99
  /** A hunt begun by hearing a sprint (it rushes, out of sight); a chase begun by sight keeps its hunt speed. */
  private rushing = false
  private interest = 0
  private lookTarget = new THREE.Vector3()
  private searchUntil = 0
  private offNoise: () => void
  private lamps: WorldContext["lamps"][] = []
  private trailAt = 0
  private stuckT = 0
  private lastPos = new THREE.Vector3()

  constructor(
    readonly ctx: WorldContext,
    readonly player: Player,
    scene: THREE.Scene,
    nav: NavGraph,
    seed = (Math.random() * 1e9) | 0,
  ) {
    this.nav = nav
    this.rng = mulberry(seed)
    this.voice = new Voice(ctx)
    this.scene = scene
    this.seed = seed
    this.offNoise = onNoise((e) => this.queue.push(e))
    for (const l of ctx.lamps) {
      const m = /^interior:(\d)/.exec(l.zone ?? "")
      if (m) (this.lamps[Number(m[1])] ??= []).push(l)
    }
  }

  private scene: THREE.Scene
  private seed: number
  private compiled: Promise<void> | null = null

  /**
   * Makes the body and gets its pipelines compiled out of sight, so it never stalls a frame when it first comes into
   * view. Resolves once it's ready to be seen (the entry sequence calls this at the switch, 14 s before it spawns).
   */
  prepare() {
    if (this.compiled) return this.compiled
    const w = createWendigo({
      ground: (x, z) => {
        const g = this.nav.groundAt(x, z, this.pos.y + 0.6, this.pos.y - 1.2)
        return Number.isNaN(g) ? this.pos.y : g
      },
      scale: num(this.ctx, "hunter.scale"),
      seed: this.seed % 1000,
    })
    this.creature = w
    w.root.visible = false
    this.scene.add(w.root)
    const r = this.ctx.renderer as unknown as { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s: THREE.Scene) => Promise<void> }
    this.compiled = w.ready
      .then(async () => {
        if (!r.compileAsync) return
        const was = w.root.visible
        w.root.visible = true
        try {
          await r.compileAsync(w.root, this.ctx.camera, this.scene)
        } finally {
          w.root.visible = was && this.mode !== "dormant"
        }
      })
      .catch((e: unknown) => console.warn("hunter: creature", e))
    return this.compiled
  }

  get ownDoorIds(): Set<string> {
    return this.ownDoors
  }

  private note(event: string) {
    this.log.push({ t: +this.time.toFixed(2), event, mode: this.mode, x: +this.pos.x.toFixed(2), z: +this.pos.z.toFixed(2), s: this.s })
    if (this.log.length > 300) this.log.splice(0, 50)
  }

  // --------------------------------------------------------------------------------------------- lifecycle

  /** Puts it in the building at (x, z) on storey s and starts it in `mode` (investigating `toward` if given). */
  spawn(x: number, z: number, s: number, opts: { toward?: Goal; grace?: number } = {}) {
    const p = this.nav.snap(s, x, z, 4) ?? { x, z }
    this.pos.set(p.x, this.nav.grids[s]!.y, p.z)
    this.s = s
    this.vel.set(0, 0, 0)
    this.grace = opts.grace ?? 0
    this.awareness = 0
    this.memory = null
    this.route = null
    this.tasks = []
    this.task = null
    this.prepare()
    this.creature?.root.position.copy(this.pos)
    this.time = Math.max(this.time, 0.001)
    this.note(`spawn ${s}`)
    if (opts.toward) this.investigate(opts.toward, 0.4, "spawn")
    else this.setMode("roam")
  }

  /** Back in after a checkpoint load: far from the player, memory wiped, a grace period. */
  restore(grace = num(this.ctx, "hunter.grace")) {
    const p = this.player.state.pos
    const ps = storeyOf(p.y)
    let best = this.nav.chokepoints[0]!
    let bd = -1
    for (const c of [...this.nav.chokepoints, { x: 0, z: 18, s: 0 }]) {
      const d = Math.hypot(c.x - p.x, c.z - p.z) + Math.abs(c.s - ps) * 15
      if (d > bd) {
        bd = d
        best = c
      }
    }
    this.queue.length = 0
    this.heat.length = 0
    this.visited.clear()
    this.spawn(best.x, best.z, best.s, { grace })
    this.mode = "roam"
  }

  /** Dormant and out of sight again (nothing it knew is kept). */
  sleep() {
    this.setMode("dormant")
    this.vel.set(0, 0, 0)
    this.memory = null
    this.awareness = 0
    this.heat.length = 0
    this.queue.length = 0
    this.voice.restoreLights()
    if (this.creature) this.creature.root.visible = false
  }

  dispose() {
    this.offNoise()
    this.voice.restoreLights()
    this.creature?.root.removeFromParent()
  }

  private setMode(m: HunterMode) {
    if (m === this.mode) return
    this.mode = m
    this.rushing = false
    this.tasks = []
    this.task = null
    this.route = null
    this.note(`→ ${m}`)
  }

  // --------------------------------------------------------------------------------------------- senses

  private eyeY() {
    const k = num(this.ctx, "hunter.scale") / 0.85
    return this.pos.y + (this.stance === "biped" ? 2.3 : 1.25) * k
  }

  private hear() {
    const ear = { x: this.pos.x, y: this.pos.y, z: this.pos.z }
    const scale = num(this.ctx, "hunter.hearing")
    for (const e of this.queue) {
      if (this.grace > 0 || this.mode === "dormant" || this.mode === "caught") continue
      const eff = noiseDistance(this.nav, e, ear)
      const r = e.radius * scale * (this.mode === "ambush" ? 1.25 : 1)
      const heard = eff < r
      const strength = heard ? 1 - eff / r : 0
      const es = storeyOf(e.y)
      let x = e.x
      let z = e.z
      if (heard) {
        // Fainter → vaguer: the position heard wanders up to 3.5 m from the source.
        const off = e.kind === "sprint" ? 0.3 + (1 - strength) * 1.2 : 0.4 + (1 - strength) * 3.1
        const a = this.rng() * Math.PI * 2
        const p = this.nav.snap(es, e.x + Math.cos(a) * off * this.rng(), e.z + Math.sin(a) * off * this.rng(), 3.5) ?? this.nav.snap(es, e.x, e.z, 3)
        if (p) {
          x = p.x
          z = p.z
        }
      }
      this.heard.push({ e, strength, x, y: e.y, z, s: es, t: this.time, heard, eff })
      if (this.heard.length > 120) this.heard.splice(0, 40)
      if (!heard) continue
      this.heat.push({ x, z, s: es, t: this.time, w: strength })
      if (this.heat.length > 80) this.heat.shift()
      this.react({ x, z, s: es }, e, strength)
    }
    this.queue.length = 0
  }

  private react(p: Goal, e: NoiseEvent, strength: number) {
    if (e.kind === "sprint") return this.sprintHeard(p, e.y)
    if (this.mode === "hunt") {
      // Out of sight, a noise tells it where you went (that's fair: it heard you).
      if (this.time - this.seenAt > 0.5 && strength > 0.15 && this.memory) {
        Object.assign(this.memory, { x: p.x, z: p.z, s: p.s, y: e.y, t: this.time, seen: false })
        this.repathAt = 0
      }
      return
    }
    if (this.mode === "search") {
      this.memory = { ...p, y: e.y, t: this.time, seen: false, vx: 0, vz: 0 }
      if (strength > 0.12) this.investigate(p, strength, e.kind)
      return
    }
    // Weak noises only stir it if nothing more interesting is going on.
    const score = strength * (e.radius >= 10 ? 1.3 : 1)
    const threshold = this.mode === "investigate" ? Math.max(0.08, this.interest * 0.7) : 0.06
    if (score >= threshold) this.investigate(p, strength, e.kind)
  }

  /**
   * A sprint: it knows the floor and roughly where, and comes at once, running (a hunt by sound: out of sight it rushes
   * at `hunter.speedRush`, on all fours, the stairs included). Successive sprint fixes give it your heading, so it
   * aims ahead of you to cut you off.
   */
  private sprintHeard(p: Goal, y: number) {
    const f = this.sprintFix
    let vx = 0
    let vz = 0
    const dt = f ? this.time - f.t : 0
    if (f && f.s === p.s && dt > 0.15 && dt < 2.5) {
      vx = (p.x - f.x) / dt
      vz = (p.z - f.z) / dt
      const v = Math.hypot(vx, vz)
      if (v > 5) {
        vx *= 5 / v
        vz *= 5 / v
      }
      if (this.memory && !this.memory.seen) {
        vx = 0.5 * vx + 0.5 * this.memory.vx
        vz = 0.5 * vz + 0.5 * this.memory.vz
      }
    }
    this.sprintFix = { x: p.x, z: p.z, s: p.s, t: this.time }
    if (this.mode === "hunt" && this.time - this.seenAt < 0.5) return
    this.memory = { ...p, y, t: this.time, seen: false, vx, vz }
    this.trackAt = this.time
    if (this.mode !== "hunt") {
      this.note("hears a sprint")
      this.startHunt()
      this.rushing = true
    } else this.repathAt = Math.min(this.repathAt, this.time + 0.15)
  }

  private see(dt: number) {
    if (this.grace > 0 || this.mode === "dormant" || this.mode === "caught") {
      this.seeing = false
      return
    }
    const ps = this.player.state
    const p = ps.pos
    const pS = storeyOf(p.y)
    const inCore = (x: number, z: number) => x >= CORE.stair.min[0] && x <= CORE.stair.max[0] && z >= CORE.stair.min[1] - 0.2 && z <= CORE.stair.max[1]
    if (pS !== this.s && !(inCore(p.x, p.z) && inCore(this.pos.x, this.pos.z))) {
      this.seeing = false
      this.awareness = Math.max(0, this.awareness - dt * 0.15)
      return
    }
    const ex = this.pos.x
    const ey = this.eyeY()
    const ez = this.pos.z
    const light = lightAt(this.lamps[pS] ?? [], p.x, p.y + 1, p.z)
    const still = ps.speed < 0.3 ? 0.8 : 1
    const crouch = ps.crouch > 0.5 ? 0.6 : 1
    const flash = ps.flashlight ? 2.6 : 1
    // Once hunting it is locked on: it keeps you in sight further (at least 12 m) than it would spot you.
    const locked = this.mode === "hunt" && this.time - this.seenAt < 1.5
    const base = (5 + 13 * light) * flash * crouch * still * (locked ? 1.6 : 1)
    const range = Math.max(locked ? 12 : 2.5, Math.min(40, base)) * num(this.ctx, "hunter.sight")
    const cone = this.mode === "hunt" ? 1.4 : 0.96
    this.sightRange = range
    this.cone = cone
    const fx = Math.sin(this.heading)
    const fz = Math.cos(this.heading)
    let visible = false
    let dist = Infinity
    const chestY = p.y + ps.eyeHeight * 0.62
    for (const ty of [ps.eye.y, chestY]) {
      const dx = p.x - ex
      const dz = p.z - ez
      const d = Math.hypot(dx, ty - ey, dz)
      dist = Math.min(dist, d)
      const hd = Math.hypot(dx, dz) || 1
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / hd)))
      // The beam pointed at it gives you away wherever it's looking (if it could see you).
      const cam = this.ctx.camera.matrixWorld.elements
      const beam = ps.flashlight && d < 30 && (-cam[8]! * -dx + -cam[10]! * -dz) / hd > 0.9
      if (!beam && (d > range || (ang > cone && d > 2.5))) continue
      if (this.nav.sees(this.s, ex, ey, ez, p.x, ty, p.z)) {
        visible = true
        break
      }
    }
    this.seeing = visible
    if (visible) {
      const close = dist < 4
      this.awareness = close ? 1 : Math.min(1, this.awareness + dt * (0.8 + 3 * Math.max(0, 1 - dist / range)))
      this.seenAt = this.time
      this.memory = { x: p.x, z: p.z, s: pS, y: p.y, t: this.time, seen: true, vx: this.player.vel.x, vz: this.player.vel.z }
      if (this.awareness >= 1 && this.mode !== "hunt") this.startHunt()
      else if (this.mode !== "hunt" && this.awareness > 0.3 && this.time - this.glimpseAt > 1) {
        // Something moved over there: turn and go to it (re-aimed at most once a second).
        this.glimpseAt = this.time
        this.investigate({ x: p.x, z: p.z, s: pS }, 0.8, "glimpse")
      }
    } else this.awareness = Math.max(0, this.awareness - dt * (this.mode === "hunt" ? 0 : 0.12))
  }

  // --------------------------------------------------------------------------------------------- states

  private investigate(p: Goal, strength: number, why: string) {
    if (this.mode === "hunt") return
    const was = this.mode
    this.mode = "investigate"
    this.interest = Math.max(strength, was === "investigate" ? this.interest * 0.8 : 0)
    this.tasks = [{ ...p, look: 1.5 + this.rng() * 1.5, kind: "go" }]
    // Then the nearest rooms round it (a shut door isn't always opened, unless the noise came from inside).
    for (const r of this.roomsNear(p, 11, 3)) {
      const inside = p.x >= r.rect.x0 && p.x <= r.rect.x1 && p.z >= r.rect.z0 && p.z <= r.rect.z1
      if (!inside && this.shut(r) && this.rng() < 0.5) continue
      if (this.tasks.length < 3) this.tasks.push({ x: r.px, z: r.pz, s: r.s, look: 1 + this.rng(), kind: "room", room: r.key })
    }
    this.task = null
    this.route = null
    this.note(`investigate ${why} ${strength.toFixed(2)}`)
    if (was !== "investigate" && strength > 0.5 && this.time > this.nextVocal - 6) {
      this.voice.vocal(this.headPos(), "chatter", 0.8)
      this.nextVocal = this.time + 8 + this.rng() * 6
    }
  }

  private startHunt() {
    this.setMode("hunt")
    this.awareness = 1
    this.repathAt = 0
    if (this.time - this.lastScream > 40) {
      this.lastScream = this.time
      this.voice.vocal(this.headPos(), "scream", 0.8)
    } else this.voice.vocal(this.headPos(), "chatter", 1.1)
    this.nextVocal = this.time + 6
  }

  private startSearch() {
    const m = this.memory
    this.setMode("search")
    this.searchUntil = this.time + num(this.ctx, "hunter.searchTime")
    this.awareness = 0.2
    if (!m) return
    const c = { x: m.x, z: m.z, s: m.s }
    // Where they were heading, first; then the rooms round it, nearest first (with some shuffle); a closed door isn't
    // always opened, so hiding behind one can work.
    const ahead = this.nav.snap(m.s, m.x + m.vx * 1.6, m.z + m.vz * 1.6, 3)
    if (ahead) this.tasks.push({ ...ahead, s: m.s, look: 1.2, kind: "go" })
    const rooms = this.roomsNear(c, 15, 6)
    for (const r of rooms) {
      if (this.shut(r) && this.rng() < 0.55) continue
      const spot = r.spots.length && this.rng() < 0.7 ? r.spots[Math.floor(this.rng() * r.spots.length)]! : ([r.px, r.pz] as [number, number])
      this.tasks.push({ x: spot[0], z: spot[1], s: r.s, look: 1 + this.rng() * 1.2, kind: "spot", room: r.key })
    }
    for (let i = 0; i < 2; i++) {
      const a = this.rng() * Math.PI * 2
      const p = this.nav.snap(m.s, m.x + Math.cos(a) * 6, m.z + Math.sin(a) * 6, 3)
      if (p) this.tasks.push({ ...p, s: m.s, look: 1.2, kind: "go" })
    }
    // Maybe they took the stairs.
    const landing = this.nav.chokepoints.find((k) => k.s === m.s)
    if (landing && Math.hypot(landing.x - m.x, landing.z - m.z) < 14 && this.rng() < 0.4) {
      const other = this.nav.chokepoints.filter((k) => Math.abs(k.s - m.s) === 1)
      const o = other[Math.floor(this.rng() * other.length)]
      if (o) this.tasks.push({ x: o.x, z: o.z, s: o.s, look: 2, kind: "go" })
    }
  }

  private roam() {
    // Rarely, an ambush at a chokepoint near where it heard things.
    const recent = this.heat.filter((h) => this.time - h.t < 120)
    if (recent.length && this.time - this.ambushAt > 120 && this.rng() < 0.06) {
      const c = recent[recent.length - 1]!
      let best = this.nav.chokepoints[0]!
      let bd = Infinity
      for (const k of this.nav.chokepoints) {
        const d = Math.hypot(k.x - c.x, k.z - c.z) + Math.abs(k.s - c.s) * 8
        if (d < bd) {
          bd = d
          best = k
        }
      }
      this.ambushAt = this.time
      this.setMode("ambush")
      this.tasks = [{ ...best, look: 15 + this.rng() * 10, kind: "go" }]
      return
    }
    let best: NavRoom | null = null
    let bs = -Infinity
    for (const r of this.nav.rooms) {
      const since = this.time - (this.visited.get(r.key) ?? -999)
      if (since < 25) continue
      const d = Math.hypot(r.px - this.pos.x, r.pz - this.pos.z) + Math.abs(r.s - this.s) * 14
      let heat = 0
      for (const h of recent) heat += h.w * Math.exp(-(this.time - h.t) / 90) * Math.exp(-(Math.hypot(h.x - r.px, h.z - r.pz) + Math.abs(h.s - r.s) * 10) / 12)
      const score = Math.min(1, since / 240) + 1.5 * Math.min(1.5, heat) + this.rng() * 0.5 - d / 90
      if (score > bs) {
        bs = score
        best = r
      }
    }
    if (best) this.tasks = [{ x: best.px, z: best.pz, s: best.s, look: 2 + this.rng() * 3, kind: "room", room: best.key }]
    else {
      const k = this.nav.chokepoints[Math.floor(this.rng() * this.nav.chokepoints.length)]!
      this.tasks = [{ ...k, look: 3, kind: "go" }]
    }
  }

  /** Every door of the room shut. */
  private shut(r: NavRoom) {
    return r.doors.length > 0 && r.doors.every((i) => this.nav.doors[i]!.h.amount < 0.05)
  }

  private roomsNear(p: Goal, radius: number, n: number) {
    return this.nav.rooms
      .filter((r) => r.s === p.s && Math.hypot(r.px - p.x, r.pz - p.z) < radius && this.time - (this.visited.get(r.key) ?? -999) > 20)
      .map((r) => ({ r, d: Math.hypot(r.px - p.x, r.pz - p.z) + this.rng() * 4 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map((e) => e.r)
  }

  private think() {
    const now = this.time
    switch (this.mode) {
      case "hunt": {
        const m = this.memory
        if (!m) return this.setMode("roam")
        const lost = now - this.seenAt
        // Its latest fix on you: seen, or a sprint heard.
        const fix = now - Math.max(this.seenAt, this.trackAt)
        const ps = this.player.state.pos
        if (lost < 0.15) {
          // In sight: straight at you when the floor allows, else re-route often.
          const g = this.nav.grids[this.s]!
          if (now >= this.repathAt && storeyOf(ps.y) === this.s && Math.hypot(ps.x - this.pos.x, ps.z - this.pos.z) < 9 && this.nav.lineWalkable(g, this.pos.x, this.pos.z, ps.x, ps.z)) {
            this.repathAt = now + 0.1
            this.directTo({ x: ps.x, z: ps.z, s: this.s })
          } else if (now >= this.repathAt) {
            this.repathAt = now + 0.3
            this.rechase({ x: m.x, z: m.z, s: m.s })
          }
        } else {
          // Out of sight: on to where you were heading (a guess from your last velocity, not your position); after a
          // sprint, ahead of you by about the time it needs to get there (cutting you off).
          const bySound = !m.seen && fix < 3
          if (now >= this.repathAt) {
            this.repathAt = now + (bySound ? 0.35 : 0.6)
            const dist = Math.hypot(m.x - this.pos.x, m.z - this.pos.z) + Math.abs(m.s - this.s) * 10
            const k = bySound ? Math.min(1.5, dist / num(this.ctx, "hunter.speedRush")) : Math.min(lost, 1.2) * 0.9
            const p = this.nav.snap(m.s, m.x + m.vx * k, m.z + m.vz * k, 3) ?? { x: m.x, z: m.z }
            this.rechase({ x: p.x, z: p.z, s: m.s })
          }
          // Searches once it is where it last knew you to be (after a sprint, however long the run there takes).
          if ((fix > 1 && !this.route) || (m.seen && fix > 7)) this.startSearch()
        }
        return
      }
      case "search":
        if (now > this.searchUntil) {
          this.note("gives up")
          this.voice.vocal(this.headPos(), "moan", 0.9)
          this.nextVocal = now + 20
          this.setMode("roam")
          return
        }
        break
      case "dormant":
      case "caught":
        return
    }
    // Task runner (roam, investigate, search, ambush).
    if (!this.task) {
      this.task = this.tasks.shift() ?? null
      if (!this.task) {
        if (this.mode === "search" && this.memory) return this.startSearch()
        if (this.mode !== "roam") this.setMode("roam")
        this.roam()
        this.task = this.tasks.shift() ?? null
        if (!this.task) return
      }
      this.lookUntil = 0
      if (!this.goTo(this.task)) {
        this.task = null
        return
      }
    }
    if (this.route) return
    // Arrived: look about, then the next task.
    if (!this.lookUntil) {
      this.lookUntil = now + this.task.look
      if (this.task.room) this.visited.set(this.task.room, now)
      if (this.mode === "roam" && this.rng() < 0.25 && now > this.nextVocal - 10) {
        this.voice.vocal(this.headPos(), this.rng() < 0.5 ? "groan" : "moan", 0.8)
        this.nextVocal = now + 15 + this.rng() * 20
      }
    }
    if (now >= this.lookUntil) {
      if (this.mode === "ambush") this.setMode("roam")
      this.task = null
    }
  }

  // --------------------------------------------------------------------------------------------- movement

  /** On a stair leg of its route (re-planning there would snap it back to a landing). */
  private onStair() {
    const r = this.route
    return !!r && !!(r.pts[this.wp]?.stair || r.pts[this.wp - 1]?.stair)
  }

  /** Re-plans a chase to `g`, unless it is on the stair or the goal has barely moved. */
  private rechase(g: Goal) {
    const o = this.goal
    if (this.route && (this.onStair() || (o && o.s === g.s && Math.hypot(o.x - g.x, o.z - g.z) < 1.5))) return
    this.goTo(g)
  }

  /** Routes to a goal (A* and the stair); false when unreachable. */
  private goTo(g: Goal) {
    const r = this.nav.route({ x: this.pos.x, z: this.pos.z, s: this.s }, g)
    this.goal = g
    if (!r) {
      this.route = null
      this.note(`no route to ${g.s}:${g.x.toFixed(1)},${g.z.toFixed(1)}`)
      return false
    }
    this.route = r
    this.wp = 1
    this.progress = 0
    this.doorIdx = 0
    this.doorWait = null
    return true
  }

  private directTo(g: Goal) {
    this.goal = g
    const d = Math.hypot(g.x - this.pos.x, g.z - this.pos.z)
    this.route = { pts: [{ x: this.pos.x, z: this.pos.z, s: this.s }, { ...g }], cum: [0, d], length: d, doors: this.nav.lineDoors(this.s, this.pos.x, this.pos.z, g.x, g.z, 0, []) }
    this.wp = 1
    this.progress = 0
    this.doorIdx = 0
  }

  private speedFor() {
    switch (this.mode) {
      case "hunt":
        // Out of sight, closing on a sprint it heard: faster than you can run.
        return this.rushing && this.time - this.seenAt > 0.5 ? num(this.ctx, "hunter.speedRush") : num(this.ctx, "hunter.speedHunt")
      case "investigate":
        return num(this.ctx, "hunter.speedInvestigate") * (this.interest > 0.6 ? 1.5 : 1)
      case "search":
        return num(this.ctx, "hunter.speedSearch")
      default:
        return num(this.ctx, "hunter.speedRoam")
    }
  }

  private move(dt: number) {
    const r = this.route
    let want = 0
    let dx = 0
    let dz = 0
    if (r) {
      // Doors on the way: stop and open (or bash when hunting), wait until the leaf is clear.
      want = this.speedFor()
      const bash = this.mode === "hunt" || (this.mode === "investigate" && this.interest > 0.7)
      while (this.doorIdx < r.doors.length) {
        const e = r.doors[this.doorIdx]!
        const d = this.nav.doors[e.door]!
        const ahead = e.along - this.progress
        if (ahead < -0.9) {
          this.doorIdx++
          this.doorWait = null
          // Now and then it pulls a door shut behind it (or slams it, searching).
          if (d.h.amount > 0.4 && (this.mode === "roam" || this.mode === "search") && this.rng() < 0.12) {
            const slam = this.mode === "search" && this.rng() < 0.5
            this.ctx.doors.drive(d.id, 0, { rate: slam ? 2.6 : 0.9 })
            this.ownDoors.add(d.id)
            this.voice.door({ x: d.cx, y: this.pos.y + 1, z: d.cz }, d.sound, slam ? "slam" : "close")
            this.note(`${slam ? "slams" : "closes"} ${d.id}`)
          }
          continue
        }
        if (ahead > (bash ? 2.2 : 1.4)) break
        if (d.h.amount >= 0.5 && !this.doorWait) break
        if (!this.doorWait) {
          this.doorWait = { door: e.door, t: 0, bash }
          this.ctx.doors.drive(d.id, 1, { from: { x: this.pos.x, z: this.pos.z }, rate: bash ? 3.4 : 0.85 })
          this.ownDoors.add(d.id)
          if (d.partner >= 0) this.ownDoors.add(this.nav.doors[d.partner]!.id)
          this.voice.door({ x: d.cx, y: this.pos.y + 1, z: d.cz }, d.sound, bash ? "bash" : "open")
          this.note(`${bash ? "bashes" : "opens"} ${d.id}`)
        }
        this.doorWait.t += dt
        if (d.h.amount >= 0.5 || this.doorWait.t > (bash ? 0.6 : 2.2)) {
          this.doorWait = null
          this.doorIdx++
          continue
        }
        want = bash ? want * 0.35 : 0
        break
      }
      // Steer to the next waypoint (skip ahead when the one after is already in a straight line).
      let w = r.pts[this.wp]
      while (w) {
        const d = Math.hypot(w.x - this.pos.x, w.z - this.pos.z)
        // At a run the stair's turns are taken wide (a waypoint counts as reached further out), so it keeps its speed.
        if (d > (w.stair ? Math.max(0.35, Math.hypot(this.vel.x, this.vel.z) * 0.14) : 0.3)) break
        this.wp++
        w = r.pts[this.wp]
      }
      if (!w) {
        this.route = null
        want = 0
      } else {
        dx = w.x - this.pos.x
        dz = w.z - this.pos.z
        const d = Math.hypot(dx, dz) || 1
        dx /= d
        dz /= d
        this.progress = r.cum[this.wp]! - d
        if ((w.stair || r.pts[this.wp - 1]?.stair) && this.mode !== "hunt") want = Math.min(want, 1.4)
        // Ease into the last waypoint.
        if (this.wp === r.pts.length - 1) want = Math.min(want, 0.6 + d * 1.5)
      }
    }
    if (this.mode === "hunt" && want > 0) {
      // Hunting it steers like a running animal: the heading swings round (up to 10 rad/s) and the speed holds,
      // easing off only into a sharp turn, so the stair's switchbacks and the corridor corners don't stop it dead.
      const sp = Math.hypot(this.vel.x, this.vel.z)
      const des = Math.atan2(dx, dz)
      const cur = sp > 0.3 ? Math.atan2(this.vel.x, this.vel.z) : des
      const dh = Math.atan2(Math.sin(des - cur), Math.cos(des - cur))
      const h = cur + Math.sign(dh) * Math.min(Math.abs(dh), 10 * dt)
      const target = want * (Math.abs(dh) > 1.2 ? 0.6 : 1)
      const nsp = sp + Math.max(-20 * dt, Math.min(10 * dt, target - sp))
      this.vel.x = Math.sin(h) * nsp
      this.vel.z = Math.cos(h) * nsp
    } else {
      const accel = this.mode === "hunt" ? 14 : 5
      const tx = dx * want
      const tz = dz * want
      const k = 1 - Math.exp(-accel * dt / Math.max(0.5, want || 1))
      this.vel.x += (tx - this.vel.x) * k
      this.vel.z += (tz - this.vel.z) * k
    }
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    // Feet on the floor (treads on the stair); the storey follows.
    const g = this.nav.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.55, this.pos.y - 1.0)
    if (!Number.isNaN(g)) this.pos.y += (g - this.pos.y) * Math.min(1, dt * 14)
    const ns = storeyOf(this.pos.y)
    const w = r?.pts[this.wp]
    this.s = w && !w.stair && Math.abs(this.pos.y - this.nav.grids[w.s]!.y) < 0.6 ? w.s : ns
    // Heading follows the velocity (or turns to what it's looking at when still).
    const sp = Math.hypot(this.vel.x, this.vel.z)
    let want2 = this.heading
    if (sp > 0.2) want2 = Math.atan2(this.vel.x, this.vel.z)
    else if (this.lookTarget.lengthSq() > 0) want2 = Math.atan2(this.lookTarget.x - this.pos.x, this.lookTarget.z - this.pos.z)
    const dh = Math.atan2(Math.sin(want2 - this.heading), Math.cos(want2 - this.heading))
    this.heading += Math.sign(dh) * Math.min(Math.abs(dh), (this.mode === "hunt" ? 6 : 2.6) * dt)
    // Stuck (a door that wouldn't open, a bad cell): re-route.
    if (this.route && want > 0.3 && !this.doorWait && this.lastPos.distanceTo(this.pos) < want * dt * 0.15) {
      this.stuckT += dt
      if (this.stuckT > 2.5) {
        this.stuckT = 0
        this.note("stuck: re-route")
        if (this.goal && !this.goTo(this.goal)) this.task = null
      }
    } else this.stuckT = 0
    this.lastPos.copy(this.pos)
  }

  private headPos() {
    const fx = Math.sin(this.heading)
    const fz = Math.cos(this.heading)
    return { x: this.pos.x + fx * 0.9, y: this.eyeY(), z: this.pos.z + fz * 0.9 }
  }

  // --------------------------------------------------------------------------------------------- body and voice

  private body(dt: number) {
    const now = this.time
    const sp = Math.hypot(this.vel.x, this.vel.z)
    const inStair = this.pos.x >= CORE.stair.min[0] - 0.3 && this.pos.x <= CORE.stair.max[0] + 0.3 && this.pos.z >= CORE.stair.min[1] - 1 && this.pos.z <= CORE.stair.max[1]
    // Upright only in roam/investigate, away from doorways and the stair, not at speed.
    const r = this.route
    const nextDoor = r && this.doorIdx < r.doors.length ? r.doors[this.doorIdx]!.along - this.progress : Infinity
    const lastDoor = r && this.doorIdx > 0 ? this.progress - r.doors[this.doorIdx - 1]!.along : Infinity
    const tight = nextDoor < 2.8 || lastDoor < 1.0 || inStair || !!this.doorWait
    const wantBiped = (this.mode === "roam" || this.mode === "investigate") && !tight && sp < 2.4
    const want = wantBiped ? "biped" : "quad"
    const forced = want === "quad" && (this.mode === "hunt" || inStair)
    if (want !== this.stance && (forced || now - this.stanceAt > 2.5)) {
      this.stance = want
      this.stanceAt = now
    }
    // Look: at you while it sees you, ahead along the route, or round the room while it looks about.
    const ps = this.player.state
    if (this.seeing || this.mode === "hunt") this.lookTarget.set(ps.eye.x, ps.eye.y, ps.eye.z)
    else if (r && r.pts[this.wp]) {
      const p = r.pts[Math.min(r.pts.length - 1, this.wp + 1)]!
      this.lookTarget.set(p.x, this.eyeY() - 0.3, p.z)
    } else if (this.lookUntil) {
      const a = this.heading + Math.sin(now * 0.9) * 1.3
      this.lookTarget.set(this.pos.x + Math.sin(a) * 4, this.eyeY() - 0.4, this.pos.z + Math.cos(a) * 4)
    }
    const w = this.creature
    if (w?.animator) {
      const root = w.root
      root.position.copy(this.pos)
      root.quaternion.setFromAxisAngle(UP, this.heading)
      const mode = this.mode === "caught" ? "lunge" : sp > 0.15 ? "stalk" : this.mode === "ambush" && !this.route ? "freeze" : "idle"
      // The ceiling over it: under the root and a metre ahead (where the antlers are), whichever is lower.
      const fx = Math.sin(this.heading)
      const fz = Math.cos(this.heading)
      this.ceiling = Math.min(this.nav.ceilingAt(this.pos.x, this.pos.z, this.pos.y), this.nav.ceilingAt(this.pos.x + fx, this.pos.z + fz, this.pos.y))
      // Rising from all fours the antlers climb faster than the stoop eases in: ask for 0.3 m more room while it rises.
      const ceiling = this.ceiling - (this.stance === "biped" && now - this.stanceAt < 1.6 ? 0.3 : 0)
      w.update(dt, { mode, stance: this.stance, target: this.lookTarget, velocity: this.vel, ceiling })
      // Shown on the player's storey (or both in the open stairwell).
      const pS = storeyOf(ps.pos.y)
      const pCore = ps.pos.x >= CORE.stair.min[0] - 0.5 && ps.pos.x <= CORE.stair.max[0] + 0.5 && ps.pos.z >= CORE.stair.min[1] - 1.5
      root.visible = this.mode !== "dormant" && (pS === this.s || Math.abs(ps.pos.y - this.pos.y) < 2 || (pCore && inStair))
    }

    // Footfalls: heavier and quicker on all fours at speed; claws on hard floors.
    if (sp > 0.25 && now >= this.nextStep) {
      const quad = this.stance === "quad"
      const stride = quad ? (sp > 3 ? 0.62 : 0.5) : 0.78
      this.nextStep = now + Math.max(0.09, stride / sp) * (0.92 + this.rng() * 0.16)
      const side = this.foot++ % 2 ? 1 : -1
      const fx = Math.sin(this.heading)
      const fz = Math.cos(this.heading)
      const fwd = quad ? (this.foot % 4 < 2 ? 0.7 : -0.5) : 0.1
      const p = { x: this.pos.x + fx * fwd + fz * side * 0.32, y: this.pos.y + 0.05, z: this.pos.z + fz * fwd - fx * side * 0.32 }
      const weight = Math.min(1, (quad ? 0.25 : 0.45) + sp / 5.5)
      this.voice.step(p, weight, quad)
    }
    // Breath, close by only (the proc skips it when too faint).
    if (now >= this.nextBreath) {
      const fast = this.mode === "hunt" || sp > 2.5
      this.nextBreath = now + (fast ? 1.0 : this.mode === "ambush" ? 4.5 : 3.0) * (0.85 + this.rng() * 0.3)
      this.voice.breath(this.headPos(), fast)
    }
    // Vocalisations by mode.
    if (now >= this.nextVocal && this.mode !== "ambush" && this.mode !== "caught") {
      const k = this.mode === "search" ? "chatter" : this.mode === "hunt" ? "chatter" : this.rng() < 0.6 ? "groan" : "moan"
      this.voice.vocal(this.headPos(), k, this.mode === "hunt" ? 1 : 0.8)
      this.nextVocal = now + (this.mode === "hunt" ? 5 + this.rng() * 4 : this.mode === "search" ? 9 + this.rng() * 6 : 22 + this.rng() * 25)
    }
    // Knocking things over: hugging furniture in a room at speed (or, rarely, roaming).
    if (now >= this.nextKnock && sp > 0.8) {
      this.nextKnock = now + 0.5
      const g = this.nav.grids[this.s]
      const c = this.nav.cellAt(this.pos.x, this.pos.z)
      const hugging = g && c >= 0 && g.clear[c]! <= 1 && g.door[c]! < 0
      const room = this.nav.roomAt(this.s, this.pos.x, this.pos.z)
      const chance = (sp > 3 ? 0.18 : 0.012) * 0.5
      if (hugging && room && this.rng() < chance) {
        this.nextKnock = now + 5
        const fx = Math.sin(this.heading)
        const fz = Math.cos(this.heading)
        this.voice.knock({ x: this.pos.x + fx * 0.6, y: this.pos.y + 0.4, z: this.pos.z + fz * 0.6 })
        this.note("knocks something over")
      }
    }
    this.voice.lights(this.pos, dt, this.mode === "dormant" ? 0 : num(this.ctx, "hunter.lights"), now)
    void CELL
  }

  private checkCatch() {
    if (this.grace > 0 || this.mode === "caught" || this.mode === "dormant") return
    const p = this.player.state.pos
    if (Math.abs(p.y - this.pos.y) > 1.3) return
    const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z)
    if (d > num(this.ctx, "hunter.catch")) return
    if (!this.nav.sees(this.s, this.pos.x, this.pos.y + 1.1, this.pos.z, p.x, p.y + 1.1, p.z)) return
    this.catches++
    this.setMode("caught")
    this.vel.set(0, 0, 0)
    this.note("CAUGHT")
    this.onCatch({ x: this.pos.x, y: this.pos.y, z: this.pos.z, mode: "hunt" })
  }

  /** Per frame. */
  update(dt: number) {
    if (this.mode === "dormant") return
    dt = Math.min(dt, 0.1)
    this.time += dt
    this.grace = Math.max(0, this.grace - dt)
    this.interest = Math.max(0, this.interest - dt * 0.04)
    this.hear()
    if (this.time >= this.visionAt) {
      const step = 0.1
      this.visionAt = this.time + step
      this.see(step)
    }
    if (this.mode !== "caught") {
      this.think()
      this.move(dt)
    }
    this.body(dt)
    this.checkCatch()
    if (this.time >= this.trailAt) {
      this.trailAt = this.time + 0.25
      this.trail.push({ t: +this.time.toFixed(2), x: +this.pos.x.toFixed(2), z: +this.pos.z.toFixed(2), s: this.s, mode: this.mode })
      if (this.trail.length > 4000) this.trail.splice(0, 1000)
    }
  }

  /** Stands where it is, listening, for `seconds` (then roams): scripted beats and automation. */
  hold(seconds: number) {
    this.setMode("roam")
    this.tasks = [{ x: this.pos.x, z: this.pos.z, s: this.s, look: seconds, kind: "go" }]
  }

  /** Back to roaming after a catch (debug and automation; the game's death flow decides otherwise). */
  release() {
    if (this.mode === "caught") {
      this.awareness = 0
      this.memory = null
      this.grace = 4
      this.setMode("roam")
    }
  }
}
