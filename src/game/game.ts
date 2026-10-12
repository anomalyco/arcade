import { DT, GUNS, MAX_LIGHTS, SPEED, type Gun } from "../../shared/config"
import { type Rect, raycast } from "../../shared/geom"
import { type MapDef, getMap } from "../../shared/maps"
import { stepBody, type Body } from "../../shared/sim/move"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import type { Intent, SimEvent } from "../../shared/sim/world"
import type { Sound } from "../audio/sound"
import type { Camera } from "../render/camera"
import { buildGlass, buildLevel } from "../render/level-mesh"
import { MUZZLE, SHOULDER, personModels } from "../render/person"
import { type Avatar, type Corpse, type PartModels, type PushPart, animate, corpsePose, newAvatar, pose } from "./anim"
import { type Batch, type FrameInput, INST_FLOATS, LIGHT_FLOATS, type Renderer, SPRITE_FLOATS } from "../render/renderer"
import { FRAME_FLOATS } from "../render/shaders"
import type { Input } from "./input"
import type { Session } from "./session"

export type Rgb3 = [number, number, number]
const PALETTE: Rgb3[] = [
  [1.0, 0.38, 0.08],
  [0.08, 0.72, 1.0],
  [0.95, 0.85, 0.2],
  [0.75, 0.32, 1.0],
  [0.3, 1.0, 0.5],
  [1.0, 0.3, 0.55],
  [0.92, 0.92, 0.92],
  [0.4, 0.5, 1.0],
  [1.0, 0.6, 0.3],
  [0.3, 0.9, 0.9],
  [0.7, 1.0, 0.3],
  [1.0, 0.45, 0.85],
]
export const css = (c: Rgb3) => `rgb(${c.map((v) => Math.round(Math.min(1, v) * 255)).join(",")})`

type Tracer = { x0: number; y0: number; x1: number; y1: number; t0: number; life: number; w: number }
type Particle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; t0: number; life: number; size: number; kind: "spark" | "shell" | "blood"; bounced: boolean }
type Flash = { x: number; y: number; t0: number; life: number; power: number }
export type FeedLine = { killer: string; victim: string; kc: Rgb3; vc: Rgb3; gun: Gun; t: number; mine: boolean }

/**
 * The match as this client sees it: predicted own body and own gunfire, smoothed and animated soldiers, effects,
 * and the per-frame GPU data.
 */
export class Game {
  map: MapDef
  blockers: Rect[] = []
  solids: Rect[] = []
  body: Body | null = null
  aim = 0
  cursor = { x: 0, y: 0 }
  snap: Snapshot | null = null
  roster: RosterRow[] = []
  avatars = new Map<string, Avatar>()
  corpses: Corpse[] = []
  feed: FeedLine[] = []
  /** Last hitmarker and kill-confirm times (seconds), for the HUD. */
  hitAt = -10
  killAt = -10
  banner: { text: string; t: number } | null = null
  /** Crosshair spread from recent firing, 0..1. */
  bloom = 0
  hurt = 0
  // Local weapon prediction.
  gun: Gun = "rifle"
  mag = 0
  reloadUntil = 0
  private cooldownUntil = 0
  private lastLocalShot = -10
  private triggerHeld = false
  private wasAlive = false
  private seq = 0
  private pending: { seq: number; i: Intent }[] = []
  private acc = 0
  private now = 0
  private tracers: Tracer[] = []
  private particles: Particle[] = []
  private flashes: Flash[] = []
  private soundAt = new Map<string, number>()
  private models: PartModels
  private frame = new Float32Array(FRAME_FLOATS)
  private lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  private inst = new Float32Array(2048 * INST_FLOATS)
  private add = new Float32Array(4096 * SPRITE_FLOATS)
  private alpha = new Float32Array(2048 * SPRITE_FLOATS)
  private nAdd = 0
  private nAlpha = 0

  constructor(
    private renderer: Renderer,
    private session: Session,
    private sound: Sound,
  ) {
    const p = personModels()
    const reg = (m: Parameters<Renderer["addModel"]>[0]) => renderer.addModel(m)
    this.models = {
      legL: reg(p.legL),
      legR: reg(p.legR),
      torso: reg(p.torso),
      arms: { rifle: reg(p.arms.rifle), shotgun: reg(p.arms.shotgun), sniper: reg(p.arms.sniper) },
      whole: { rifle: reg(p.whole.rifle), shotgun: reg(p.whole.shotgun), sniper: reg(p.whole.sniper) },
    }
    this.map = getMap(1)
    this.load(this.map)
  }

  private load(map: MapDef): void {
    this.map = map
    this.blockers = [...map.walls.map((w) => w.rect), ...map.windows, ...map.glass]
    this.solids = [...this.blockers, ...map.props.filter((p) => p.solid).map((p) => p.rect)]
    this.renderer.setLevel(buildLevel(map), buildGlass(map))
    this.renderer.setOccluders(map.walls.map((w) => w.rect))
    this.corpses = []
    this.tracers = []
    this.particles = []
    this.body = null
    this.pending = []
  }

  get myId(): string {
    return this.session.myId
  }

  get alive(): boolean {
    return !!this.snap && this.snap.phase === "play" && !!this.snap.players.find((p) => p.id === this.myId)?.alive
  }

  colorOf(id: string): Rgb3 {
    const i = this.roster.findIndex((r) => r.id === id)
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length]!
  }

  nameOf(id: string): string {
    return this.roster.find((r) => r.id === id)?.name ?? ""
  }

  get health(): number {
    return this.snap?.you?.health ?? 0
  }

  // Network ----------------------------------------------------------------------------------------------------

  private ingest(): void {
    const l = this.session.latest()
    if (l && l.snap !== this.snap) {
      const s = l.snap
      if (s.map !== this.map.seed) this.load(getMap(s.map))
      for (const p of s.players) {
        if (p.id === this.myId) continue
        let a = this.avatars.get(p.id)
        if (!a) {
          a = newAvatar(p.id, p.x, p.y, p.aim, p.gun)
          a.alive = p.alive
          this.avatars.set(p.id, a)
        }
        // Teleport on respawn rather than sliding across the map.
        if (p.alive && (!a.alive || Math.hypot(p.x - a.x, p.y - a.y) > 4)) {
          a.x = p.x
          a.y = p.y
          this.corpses = this.corpses.filter((c) => c.id !== p.id)
        }
        a.tx = p.x
        a.ty = p.y
        a.tvx = p.vx
        a.tvy = p.vy
        a.aim = p.aim
        a.gun = p.gun
        a.alive = p.alive
      }
      for (const id of [...this.avatars.keys()]) if (!s.players.some((p) => p.id === id)) this.avatars.delete(id)
      const mine = s.players.find((p) => p.id === this.myId)
      if (mine) this.reconcile(s, mine)
      this.snap = s
    }
    this.roster = this.session.roster()
    for (const e of this.session.drainEvents()) this.event(e)
  }

  private reconcile(s: Snapshot, mine: Snapshot["players"][number]): void {
    const you = s.you
    if (mine.alive && !this.wasAlive) {
      this.gun = mine.gun
      this.mag = GUNS[mine.gun].mag
      this.reloadUntil = 0
      this.body = { x: mine.x, y: mine.y, vx: 0, vy: 0 }
      this.pending = []
      this.corpses = this.corpses.filter((c) => c.id !== this.myId)
    }
    this.wasAlive = mine.alive
    if (!mine.alive) {
      this.body = { x: mine.x, y: mine.y, vx: 0, vy: 0 }
      return
    }
    this.pending = this.pending.filter((p) => p.seq > s.ack)
    const b: Body = { x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy }
    for (const p of this.pending) stepBody(b, p.i.mx, p.i.my, SPEED, this.solids, DT)
    // Small corrections blend in; big ones snap.
    if (this.body && Math.hypot(b.x - this.body.x, b.y - this.body.y) < 1.5) {
      this.body.x += (b.x - this.body.x) * 0.35
      this.body.y += (b.y - this.body.y) * 0.35
      this.body.vx = b.vx
      this.body.vy = b.vy
    } else this.body = b
    if (you) {
      if (you.reloading > 0 && this.reloadUntil <= this.now) this.reloadUntil = this.now + you.reloading
      if (this.now - this.lastLocalShot > 0.6 && this.reloadUntil <= this.now) this.mag = you.mag
    }
  }

  private event(e: SimEvent): void {
    const t = this.now
    const me = this.body
    switch (e.k) {
      case "shot": {
        if (e.by === this.myId) {
          if (e.hit) {
            this.hitAt = t
            this.sound.hit(false)
          }
          return
        }
        const a = this.avatars.get(e.by)
        const gun = a?.gun ?? "rifle"
        const muzzle = a ? this.muzzle(a.x, a.y, a.aim, gun, a.kick) : { x: e.x0, y: e.y0 }
        this.tracer(muzzle.x, muzzle.y, e.x1, e.y1, gun)
        if (e.hit) {
          const v = this.avatars.get(e.hit)
          if (v) v.flash = 1
          this.blood(e.x1, e.y1, Math.atan2(e.y1 - e.y0, e.x1 - e.x0))
          if (e.hit === this.myId) {
            this.hurt = Math.min(1, this.hurt + 0.45)
            this.cam?.bump(0.5)
            this.sound.hurt()
          }
        } else this.sparks(e.x1, e.y1, Math.atan2(e.y1 - e.y0, e.x1 - e.x0))
        const last = this.soundAt.get(e.by) ?? -1
        if (t - last > 0.05) {
          this.soundAt.set(e.by, t)
          if (a) {
            a.kick = Math.min(1.6, a.kick + GUNS[gun].kick)
            this.shells(muzzle.x, muzzle.y, a.aim, gun)
          }
          this.flashes.push({ x: muzzle.x, y: muzzle.y, t0: t, life: gun === "rifle" ? 0.05 : 0.08, power: gun === "rifle" ? 2.2 : 3.5 })
          if (me) this.sound.shot(gun, e.x0 - me.x, e.y0 - me.y, false)
        }
        return
      }
      case "kill": {
        const v = this.avatars.get(e.victim)
        const vx = v?.x ?? (e.victim === this.myId ? me?.x : 0) ?? 0
        const vy = v?.y ?? (e.victim === this.myId ? me?.y : 0) ?? 0
        const gun = v?.gun ?? this.gun
        this.corpses.push({ id: e.victim, x: vx, y: vy, dx: e.dx, dy: e.dy, t0: t, gun })
        this.feed.unshift({ killer: this.nameOf(e.killer), victim: this.nameOf(e.victim), kc: this.colorOf(e.killer), vc: this.colorOf(e.victim), gun: this.avatars.get(e.killer)?.gun ?? this.gun, t, mine: e.killer === this.myId || e.victim === this.myId })
        this.feed.length = Math.min(this.feed.length, 5)
        if (e.killer === this.myId) {
          this.killAt = t
          this.sound.hit(true)
          this.banner = { text: `ELIMINATED ${this.nameOf(e.victim).toUpperCase()}`, t }
        }
        if (e.victim === this.myId) {
          this.banner = { text: `KILLED BY ${this.nameOf(e.killer).toUpperCase()}`, t }
          this.cam?.bump(0.8)
        }
        return
      }
      case "reload": {
        const a = this.avatars.get(e.by)
        if (a) {
          a.reloadAt = t
          a.reloadFor = GUNS[a.gun].reload
          if (me) this.sound.reload(a.x - me.x, a.y - me.y, a.gun)
        }
        return
      }
      case "end":
        return
    }
  }

  // Input, prediction, local gunfire ----------------------------------------------------------------------------

  private cam: Camera | null = null

  update(dt: number, input: Input, cam: Camera, w: number, h: number, nowMs: number): void {
    this.now = nowMs / 1000
    this.cam = cam
    this.session.update(dt)
    this.ingest()
    const c = cam.unproject(input.mouse.x, input.mouse.y, w, h, SHOULDER - 0.2)
    this.cursor = c
    const origin = this.body ?? { x: this.map.size[0] / 2, y: this.map.size[1] / 2 }
    this.aim = Math.atan2(c.y - origin.y, c.x - origin.x)
    this.acc = Math.min(this.acc + dt, DT * 5)
    while (this.acc >= DT) {
      this.acc -= DT
      const live = this.alive
      const mv = live ? input.move() : { mx: 0, my: 0 }
      const reload = input.takeReload()
      const fire = live && input.enabled && input.firing
      const i: Intent = { mx: mv.mx, my: mv.my, aim: this.aim, fire, reload }
      const seq = ++this.seq
      this.session.send({ type: "intent", seq, i })
      if (!live || !this.body) {
        this.triggerHeld = fire
        continue
      }
      this.pending.push({ seq, i })
      if (this.pending.length > 90) this.pending.shift()
      stepBody(this.body, i.mx, i.my, SPEED, this.solids, DT)
      this.localGun(fire, reload)
    }
    this.bloom = Math.max(0, this.bloom - dt * 2.6)
    this.hurt = Math.max(0, this.hurt - dt * 0.9)
  }

  /** Mirrors the server's trigger rules so your own shots fire on the frame you click. */
  private localGun(fire: boolean, reload: boolean): void {
    const t = this.now
    const gun = GUNS[this.gun]
    if (this.reloadUntil > 0 && t >= this.reloadUntil) {
      this.reloadUntil = 0
      this.mag = gun.mag
    }
    if (this.reloadUntil === 0 && ((reload && this.mag < gun.mag) || (fire && this.mag === 0))) {
      this.reloadUntil = t + gun.reload
      this.sound.reload(0, 0, this.gun)
    }
    const pressed = fire && (gun.auto || !this.triggerHeld)
    this.triggerHeld = fire
    if (!pressed || this.reloadUntil > 0 || this.mag <= 0 || t < this.cooldownUntil) return
    this.cooldownUntil = t + gun.cooldown
    this.mag--
    this.lastLocalShot = t
    const b = this.body!
    const me = this.avatarMe
    me.kick = Math.min(1.6, me.kick + gun.kick)
    const muzzle = this.muzzle(b.x, b.y, this.aim, this.gun, me.kick)
    for (let k = 0; k < gun.pellets; k++) {
      const spread = gun.pellets > 1 ? ((k + 0.5) / gun.pellets - 0.5) * 2 * gun.spread + (Math.random() - 0.5) * 0.04 : (Math.random() * 2 - 1) * gun.spread
      const a = this.aim + spread
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      let stop = Math.min(raycast(b.x, b.y, dx, dy, this.blockers, gun.range), gun.range)
      let hit = false
      for (const o of this.avatars.values()) {
        if (!o.alive) continue
        const along = (o.x - b.x) * dx + (o.y - b.y) * dy
        const off = Math.abs(-(o.x - b.x) * dy + (o.y - b.y) * dx)
        if (along > 0 && along < stop && off < 0.4) {
          stop = along
          hit = true
        }
      }
      const x1 = b.x + dx * stop
      const y1 = b.y + dy * stop
      this.tracer(muzzle.x, muzzle.y, x1, y1, this.gun)
      if (!hit && stop < gun.range) this.sparks(x1, y1, a)
    }
    this.flashes.push({ x: muzzle.x, y: muzzle.y, t0: t, life: this.gun === "rifle" ? 0.05 : 0.08, power: this.gun === "rifle" ? 2.4 : 4 })
    this.shells(muzzle.x, muzzle.y, this.aim, this.gun)
    this.bloom = Math.min(1, this.bloom + gun.kick * 0.35)
    this.cam?.kick(-Math.cos(this.aim), -Math.sin(this.aim), gun.kick * 1.6)
    this.cam?.bump(gun.kick * 0.25)
    this.sound.shot(this.gun, 0, 0, true)
  }

  private avatarMe: Avatar = newAvatar("me", 0, 0, 0, "rifle")

  private muzzle(x: number, y: number, aim: number, gun: Gun, kick: number): { x: number; y: number } {
    const d = MUZZLE[gun] - kick * 0.12
    return { x: x + Math.cos(aim) * d, y: y + Math.sin(aim) * d }
  }

  // Effects -----------------------------------------------------------------------------------------------------

  private tracer(x0: number, y0: number, x1: number, y1: number, gun: Gun): void {
    this.tracers.push({ x0, y0, x1, y1, t0: this.now, life: gun === "sniper" ? 0.3 : 0.07, w: gun === "sniper" ? 0.05 : 0.025 })
  }

  private sparks(x: number, y: number, dir: number): void {
    for (let i = 0; i < 6; i++) {
      const a = dir + Math.PI + (Math.random() - 0.5) * 2.2
      const s = 2 + Math.random() * 4
      this.particles.push({ x, y, z: 0.9 + Math.random() * 0.5, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: Math.random() * 3, t0: this.now, life: 0.18 + Math.random() * 0.2, size: 0.035, kind: "spark", bounced: false })
    }
    this.particles.push({ x, y, z: 1.1, vx: 0, vy: 0, vz: 0, t0: this.now, life: 0.08, size: 0.35, kind: "spark", bounced: true })
    const me = this.body
    if (me && Math.hypot(x - me.x, y - me.y) < 12) this.sound.impact(x - me.x, y - me.y)
  }

  private blood(x: number, y: number, dir: number): void {
    for (let i = 0; i < 7; i++) {
      const a = dir + (Math.random() - 0.5) * 1.2
      const s = 1.5 + Math.random() * 3
      this.particles.push({ x, y, z: 1.1, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: Math.random() * 2, t0: this.now, life: 0.4 + Math.random() * 0.3, size: 0.05 + Math.random() * 0.04, kind: "blood", bounced: false })
    }
  }

  private shells(x: number, y: number, aim: number, gun: Gun): void {
    if (gun === "shotgun") return
    const side = aim - Math.PI / 2
    const s = 1.6 + Math.random()
    this.particles.push({ x: x - Math.cos(aim) * 0.6, y: y - Math.sin(aim) * 0.6, z: SHOULDER - 0.1, vx: Math.cos(side) * s + (Math.random() - 0.5), vy: Math.sin(side) * s + (Math.random() - 0.5), vz: 2 + Math.random(), t0: this.now, life: 1.4, size: 0.035, kind: "shell", bounced: false })
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600)
  }

  private step(a: Avatar, mine: boolean): void {
    const me = this.body
    if (me && Math.hypot(a.x - me.x, a.y - me.y) < 14) this.sound.step(a.x - me.x, a.y - me.y, mine)
  }

  // Frame assembly ----------------------------------------------------------------------------------------------

  private sprite(add: boolean, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot = 0, stretch = 0, extra = 0): void {
    const buf = add ? this.add : this.alpha
    const n = add ? this.nAdd : this.nAlpha
    if ((n + 1) * SPRITE_FLOATS > buf.length) return
    buf.set([x, y, z, size, r, g, b, a, kind, rot, stretch, extra], n * SPRITE_FLOATS)
    if (add) this.nAdd++
    else this.nAlpha++
  }

  build(cam: Camera, w: number, h: number, dt: number): FrameInput {
    const t = this.now
    const snap = this.snap
    this.nAdd = 0
    this.nAlpha = 0

    // Map lights, then muzzle flashes as short-lived point lights that cast shadows like any other.
    const L = this.lights
    L.fill(0)
    let nl = 0
    for (const l of this.map.lights) {
      L.set([l.x, l.h, l.y, l.r, l.color[0], l.color[1], l.color[2], l.power, l.cone?.[0] ?? 0, l.cone?.[1] ?? 0, l.cone?.[2] ?? 0, l.cone ? 1 : 0, l.power, 0, 0, 0], nl * LIGHT_FLOATS)
      nl++
    }
    this.flashes = this.flashes.filter((f) => t - f.t0 < f.life)
    for (const f of this.flashes) {
      if (nl >= MAX_LIGHTS) break
      const p = f.power * (1 - (t - f.t0) / f.life)
      L.set([f.x, 1.2, f.y, 7, 1, 0.72, 0.38, p, 0, 0, 0, 0, 1, 0, 0, 0], nl * LIGHT_FLOATS)
      nl++
      this.sprite(true, f.x, SHOULDER - 0.2, f.y, 0.35 + Math.random() * 0.2, 1, 0.8, 0.45, 1, 0)
    }

    // Soldiers.
    const parts = new Map<number, number[]>()
    const push = (model: number, x: number, y: number, z: number, yaw: number, tint: Rgb3, pitch: number, roll: number, flash: number) => {
      const arr = parts.get(model) ?? []
      arr.push(x, y, z, yaw, tint[0], tint[1], tint[2], 1, pitch, roll, 1, flash)
      parts.set(model, arr)
    }
    const k = 1 - Math.exp(-dt * 16)
    for (const a of this.avatars.values()) {
      if (!a.alive) continue
      // Chase the server position, extrapolated a little along its velocity.
      const tx = a.tx + a.tvx * 0.05
      const ty = a.ty + a.tvy * 0.05
      const nx = a.x + (tx - a.x) * k
      const ny = a.y + (ty - a.y) * k
      const vx = dt > 0 ? (nx - a.x) / dt : 0
      const vy = dt > 0 ? (ny - a.y) / dt : 0
      if (animate(a, dt, nx, ny, a.vx + (vx - a.vx) * 0.3, a.vy + (vy - a.vy) * 0.3, a.aim)) this.step(a, false)
      const col = this.colorOf(a.id)
      pose(push, a, col, this.models, t)
      this.sprite(true, a.x, 0.03, a.y, 0.48, col[0], col[1], col[2], 0.9, 2, 0, 0.14)
    }
    const me = this.alive ? this.body : null
    if (me) {
      const a = this.avatarMe
      a.gun = this.gun
      a.alive = true
      a.reloadAt = this.reloadUntil > 0 ? this.reloadUntil - GUNS[this.gun].reload : -10
      a.reloadFor = GUNS[this.gun].reload
      if (animate(a, dt, me.x, me.y, me.vx, me.vy, this.aim)) this.step(a, true)
      const col = this.colorOf(this.myId)
      pose(push, a, col, this.models, t)
      this.sprite(true, me.x, 0.03, me.y, 0.48, col[0], col[1], col[2], 1, 2, 0, 0.14)
    }

    let n = 0
    const batches: Batch[] = []
    const emit = (model: number, data: number[], alpha = false) => {
      const count = data.length / INST_FLOATS
      if (!count) return
      if ((n + count) * INST_FLOATS > this.inst.length) {
        const bigger = new Float32Array((n + count) * INST_FLOATS * 2)
        bigger.set(this.inst)
        this.inst = bigger
      }
      this.inst.set(data, n * INST_FLOATS)
      batches.push({ model, data: this.inst.subarray(n * INST_FLOATS, (n + count) * INST_FLOATS) as Float32Array<ArrayBuffer>, count, alpha })
      n += count
    }
    for (const [model, data] of parts) emit(model, data)

    // Corpses (drawn with alpha so they can fade out).
    const bodies = new Map<number, number[]>()
    const pushBody: PushPart = (model, x, y, z, yaw, tint, pitch, roll, flash, alpha = 1) => {
      const arr = bodies.get(model) ?? []
      arr.push(x, y, z, yaw, tint[0], tint[1], tint[2], 1, pitch, roll, alpha, flash)
      bodies.set(model, arr)
    }
    this.corpses = this.corpses.filter((c) => corpsePose(pushBody, c, this.colorOf(c.id), this.models, t))
    for (const [model, data] of bodies) emit(model, data, true)

    // Tracers, particles.
    this.tracers = this.tracers.filter((tr) => t - tr.t0 < tr.life)
    for (const tr of this.tracers) {
      const p = (t - tr.t0) / tr.life
      const len = Math.hypot(tr.x1 - tr.x0, tr.y1 - tr.y0)
      if (len < 0.05) continue
      // A bright head runs along the line, trailing a fading streak.
      const head = Math.min(1, p * 2.2)
      const tail = Math.max(0, p * 2.2 - 0.6)
      const hx = tr.x0 + (tr.x1 - tr.x0) * head
      const hy = tr.y0 + (tr.y1 - tr.y0) * head
      const ax = tr.x0 + (tr.x1 - tr.x0) * tail
      const ay = tr.y0 + (tr.y1 - tr.y0) * tail
      const seg = Math.hypot(hx - ax, hy - ay) / 2
      if (seg > 0.01) this.sprite(true, (hx + ax) / 2, SHOULDER - 0.2, (hy + ay) / 2, seg, 1, 0.85, 0.55, 1 - p * 0.6, 4, Math.atan2(tr.y1 - tr.y0, tr.x1 - tr.x0), tr.w / seg)
    }
    this.particles = this.particles.filter((p) => t - p.t0 < p.life)
    for (const p of this.particles) {
      p.vz -= 9.8 * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      if (p.z < 0.02) {
        p.z = 0.02
        if (p.kind === "shell" && !p.bounced) {
          p.vz = -p.vz * 0.35
          p.vx *= 0.5
          p.vy *= 0.5
          p.bounced = true
        } else {
          p.vz = 0
          p.vx *= 0.8
          p.vy *= 0.8
        }
      }
      const a = 1 - (t - p.t0) / p.life
      if (p.kind === "spark") this.sprite(true, p.x, p.z, p.y, p.size, 1, 0.75, 0.35, a, 0)
      else if (p.kind === "shell") this.sprite(false, p.x, p.z, p.y, p.size, 0.85, 0.65, 0.25, Math.min(1, a * 3), 6)
      else this.sprite(false, p.x, p.z, p.y, p.size, 0.45, 0.04, 0.05, a, 6)
    }

    // Uniforms.
    const vp = cam.update(w / h)
    const F = this.frame
    F.set(vp, 0)
    F.set([cam.eye[0], cam.eye[1], cam.eye[2], t], 16)
    F.set([this.renderer.width, this.renderer.height, nl, this.renderer.occluderCount], 20)
    const focus = me ? cam.project(me.x, 0.9, me.y, w, h) : { x: 0, y: 0 }
    F.set([me?.x ?? 0, me?.y ?? 0, me ? 1 : 0, 0.24], 24)
    F.set([0.16, 0.2, 0.34, 0], 28)
    F.set([(focus.x / w) * 2 - 1, 1 - (focus.y / h) * 2, 0.7, 0], 32)
    F.set([0, 1, 0, 0], 36)
    const dead = !!snap && snap.phase === "play" && !this.alive
    return {
      frame: F,
      lights: L,
      batches,
      alphaSprites: this.alpha,
      alphaCount: this.nAlpha,
      addSprites: this.add,
      addCount: this.nAdd,
      grade: [t, dead ? 0.7 : 0, this.hurt * 0.9, 1.15],
    }
  }
}
