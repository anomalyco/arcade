import { DT, GUNS, SPEED, type Gun } from "../../shared/config"
import { type Rect, raycast } from "../../shared/geom"
import { type MapDef, getMap } from "../../shared/maps"
import { stepBody, type Body } from "../../shared/sim/move"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import type { Intent, SimEvent } from "../../shared/sim/world"
import type { Sound } from "../audio/sound"
import type { Camera } from "../render/camera"
import { buildLevel } from "../render/level-mesh"
import { type Caster, type DynLight, LightCuller } from "../render/lighting"
import { HOLD, MUZZLE, SHOULDER, personModels } from "../render/person"
import { type Avatar, EV, type PartModels, type PushPart, animate, fire as shoot, gunPoints, hit, newAvatar, pose } from "./anim"
import { type Corpse, type Debris, deathStyle, emitRagdoll, ragdoll, ragdollCentre, stepDebris, stepRagdoll } from "./ragdoll"
import { type Batch, type FrameInput, INST_FLOATS, type Renderer, SPRITE_FLOATS } from "../render/renderer"
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

type Tracer = { x0: number; y0: number; z0: number; x1: number; y1: number; t0: number; life: number; w: number; gun: Gun }
type FlashFx = { x: number; y: number; z: number; aim: number; gun: Gun; t0: number; seed: number }
type Particle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; t0: number; life: number; size: number; kind: "spark" | "dust" | "blood" | "splat" | "smoke" | "chip"; bounced: boolean }
type Flash = { x: number; y: number; t0: number; life: number; power: number }
/** Rifle and shotgun tracers fly at this speed (m/s) as a streak this long. */
const TRACER_SPEED = 240
const TRACER_LEN = 3.2
const HIT_POWER: Record<Gun, number> = { rifle: 0.8, shotgun: 0.3, sniper: 1.8 }
/** Camera recoil per gun: shove along the aim, shake, zoom punch and a little roll. */
const CAM_RECOIL: Record<Gun, { kick: number; shake: number; punch: number; roll: number }> = {
  rifle: { kick: 0.55, shake: 0.07, punch: 0.25, roll: 0.004 },
  shotgun: { kick: 1.8, shake: 0.32, punch: 1.1, roll: 0.012 },
  sniper: { kick: 2.2, shake: 0.38, punch: 1.4, roll: 0.014 },
}
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
  private debris: Debris[] = []
  private flashFx: FlashFx[] = []
  /** Hit-stop: animation and effects crawl until this time after a kill. */
  private freezeUntil = 0
  private hitSoundAt = -1
  private soundAt = new Map<string, number>()
  private models: PartModels
  private frame = new Float32Array(FRAME_FLOATS)
  private culler = new LightCuller()
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
    const regGuns = (r: typeof p.gun) => ({ rifle: reg(r.rifle), shotgun: reg(r.shotgun), sniper: reg(r.sniper) })
    this.models = {
      pelvis: reg(p.pelvis),
      torso: reg(p.torso),
      head: reg(p.head),
      upperArm: reg(p.upperArm),
      foreArm: reg(p.foreArm),
      thigh: reg(p.thigh),
      shin: reg(p.shin),
      foot: reg(p.foot),
      pump: reg(p.pump),
      gun: regGuns(p.gun),
      mag: regGuns(p.mag),
      casing: regGuns(p.casing),
    }
    this.map = getMap(1)
    this.load(this.map)
  }

  private load(map: MapDef): void {
    this.map = map
    this.blockers = [...map.walls.map((w) => w.rect), ...map.windows, ...map.glass]
    this.solids = [...this.blockers, ...map.props.filter((p) => p.solid).map((p) => p.rect)]
    this.renderer.setLevel(buildLevel(map))
    this.culler.setMap(map)
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
        const dir = Math.atan2(e.y1 - e.y0, e.x1 - e.x0)
        const victim = e.hit ? (e.hit === this.myId ? this.avatarMe : this.avatars.get(e.hit)) : undefined
        if (victim) {
          const by = e.by === this.myId ? this.gun : (this.avatars.get(e.by)?.gun ?? "rifle")
          hit(victim, Math.cos(dir), Math.sin(dir), HIT_POWER[by])
          this.blood(e.x1, e.y1, dir, by === "shotgun" ? 0.4 : 1)
        }
        if (e.by === this.myId) {
          if (e.hit && t - this.hitSoundAt > 0.04) {
            this.hitAt = t
            this.hitSoundAt = t
            this.sound.hit(false)
          }
          return
        }
        const a = this.avatars.get(e.by)
        const gun = a?.gun ?? "rifle"
        const last = this.soundAt.get(e.by) ?? -1
        const first = t - last > 0.05
        if (first && a) shoot(a, t)
        const m = a ? this.muzzle(a) : { x: e.x0, y: e.y0, z: SHOULDER - 0.15 }
        this.tracer(m.x, m.y, m.z, e.x1, e.y1, gun)
        if (!e.hit) this.impact(e.x1, e.y1, dir, gun)
        if (e.hit === this.myId) {
          this.hurt = Math.min(1, this.hurt + 0.45)
          this.cam?.bump(0.45)
          this.cam?.kick(Math.cos(dir), Math.sin(dir), 0.9)
          this.sound.hurt()
        } else if (me && !e.hit) {
          // Near miss: a crack as the round passes close by.
          const along = (me.x - e.x0) * Math.cos(dir) + (me.y - e.y0) * Math.sin(dir)
          const off = Math.abs(-(me.x - e.x0) * Math.sin(dir) + (me.y - e.y0) * Math.cos(dir))
          if (along > 1 && along < Math.hypot(e.x1 - e.x0, e.y1 - e.y0) && off < 1.6) this.sound.whiz(Math.cos(dir) * 2, Math.sin(dir) * 2, gun)
        }
        if (first) {
          this.soundAt.set(e.by, t)
          if (a && gun === "rifle") this.casing(a)
          this.muzzleFlash(m.x, m.y, m.z, a?.aim ?? dir, gun)
          if (me) this.sound.shot(gun, e.x0 - me.x, e.y0 - me.y, false)
        }
        return
      }
      case "kill": {
        const mine = e.victim === this.myId
        const v = mine ? this.avatarMe : this.avatars.get(e.victim)
        const killerGun = e.killer === this.myId ? this.gun : (this.avatars.get(e.killer)?.gun ?? "rifle")
        if (v?.body) {
          this.corpses = this.corpses.filter((c) => c.id !== e.victim)
          this.corpses.push({ id: e.victim, gun: v.gun, t0: t, rd: ragdoll(v.body, v.gun, v.svx, v.svy, e.dx, e.dy, deathStyle(killerGun), this.solids) })
          v.body = null
          this.blood(v.x, v.y, Math.atan2(e.dy, e.dx), 2)
        }
        this.feed.unshift({ killer: this.nameOf(e.killer), victim: this.nameOf(e.victim), kc: this.colorOf(e.killer), vc: this.colorOf(e.victim), gun: killerGun, t, mine: e.killer === this.myId || mine })
        this.feed.length = Math.min(this.feed.length, 5)
        if (e.killer === this.myId) {
          this.killAt = t
          this.freezeUntil = t + 0.07
          this.sound.hit(true)
          this.cam?.bump(0.25)
          this.banner = { text: `ELIMINATED ${this.nameOf(e.victim).toUpperCase()}`, t }
        }
        if (mine) {
          this.banner = { text: `KILLED BY ${this.nameOf(e.killer).toUpperCase()}`, t }
          this.cam?.bump(0.8)
          this.cam?.kick(e.dx, e.dy, 2)
        }
        return
      }
      case "reload": {
        const a = this.avatars.get(e.by)
        if (a) {
          a.reloadAt = t
          a.reloadFor = GUNS[a.gun].reload
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
    }
    const pressed = fire && (gun.auto || !this.triggerHeld)
    this.triggerHeld = fire
    if (!pressed || this.reloadUntil > 0 || this.mag <= 0 || t < this.cooldownUntil) return
    this.cooldownUntil = t + gun.cooldown
    this.mag--
    this.lastLocalShot = t
    const b = this.body!
    const me = this.avatarMe
    shoot(me, t)
    const muzzle = this.muzzle(me)
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
      this.tracer(muzzle.x, muzzle.y, muzzle.z, x1, y1, this.gun)
      if (!hit && stop < gun.range) this.impact(x1, y1, a, this.gun)
    }
    this.muzzleFlash(muzzle.x, muzzle.y, muzzle.z, this.aim, this.gun)
    if (this.gun === "rifle") this.casing(me)
    this.bloom = Math.min(1, this.bloom + (this.gun === "rifle" ? 0.16 : 0.75))
    const cr = CAM_RECOIL[this.gun]
    this.cam?.kick(-Math.cos(this.aim), -Math.sin(this.aim), cr.kick)
    this.cam?.bump(cr.shake)
    this.cam?.punch(cr.punch, (Math.random() < 0.5 ? -1 : 1) * cr.roll)
    this.sound.shot(this.gun, 0, 0, true)
  }

  private avatarMe: Avatar = newAvatar("me", 0, 0, 0, "rifle")

  /** The muzzle of a soldier's gun from its last pose, or where it would be. */
  private muzzle(a: Avatar): { x: number; y: number; z: number } {
    const g = gunPoints(a)
    if (g) return { x: g.muzzle[0], y: g.muzzle[2], z: g.muzzle[1] }
    const h = HOLD[a.gun]
    const c = Math.cos(a.aim)
    const s = Math.sin(a.aim)
    return { x: a.x + c * MUZZLE[a.gun] - s * h.side, y: a.y + s * MUZZLE[a.gun] + c * h.side, z: h.up }
  }

  // Effects -----------------------------------------------------------------------------------------------------

  private fx(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, kind: Particle["kind"]): void {
    this.particles.push({ x, y, z, vx, vy, vz, t0: this.now, life, size, kind, bounced: false })
  }

  private tracer(x0: number, y0: number, z0: number, x1: number, y1: number, gun: Gun): void {
    this.tracers.push({ x0, y0, z0, x1, y1, t0: this.now, life: gun === "sniper" ? 0.55 : (Math.hypot(x1 - x0, y1 - y0) + TRACER_LEN) / TRACER_SPEED, w: gun === "sniper" ? 0.045 : gun === "shotgun" ? 0.018 : 0.026, gun })
    if (gun === "sniper") {
      // A smoke trail that hangs in the air along the shot.
      const len = Math.hypot(x1 - x0, y1 - y0)
      for (let d = 0.6; d < len; d += 0.9) {
        const u = d / len
        this.fx(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, z0 + (1.1 - z0) * u, (Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.15, 0.1, 0.9 + Math.random() * 0.4, 0.12 + Math.random() * 0.05, "smoke")
      }
    }
  }

  private muzzleFlash(x: number, y: number, z: number, aim: number, gun: Gun): void {
    const big = gun !== "rifle"
    this.flashes.push({ x: x + Math.cos(aim) * 0.35, y: y + Math.sin(aim) * 0.35, t0: this.now, life: big ? 0.09 : 0.055, power: gun === "rifle" ? 0.8 : gun === "shotgun" ? 1.6 : 1.4 })
    this.flashFx.push({ x, y, z, aim, gun, t0: this.now, seed: Math.random() })
    const n = gun === "shotgun" ? 4 : gun === "sniper" ? 3 : Math.random() < 0.4 ? 1 : 0
    for (let i = 0; i < n; i++) {
      const s = 0.6 + Math.random() * 1.2
      const a = aim + (Math.random() - 0.5) * 0.7
      this.fx(x + Math.cos(aim) * 0.15, y + Math.sin(aim) * 0.15, z, Math.cos(a) * s, Math.sin(a) * s, 0.2 + Math.random() * 0.3, 0.6 + Math.random() * 0.6, big ? 0.09 : 0.05, "smoke")
    }
  }

  private impact(x: number, y: number, dir: number, gun: Gun): void {
    const z = 0.9 + Math.random() * 0.5
    const n = gun === "shotgun" ? 3 : gun === "sniper" ? 12 : 7
    for (let i = 0; i < n; i++) {
      const a = dir + Math.PI + (Math.random() - 0.5) * 2.4
      const s = 2.5 + Math.random() * 5
      this.fx(x, y, z, Math.cos(a) * s, Math.sin(a) * s, Math.random() * 3.5, 0.15 + Math.random() * 0.25, 0.03, "spark")
    }
    for (let i = 0; i < (gun === "shotgun" ? 1 : 3); i++) {
      const a = dir + Math.PI + (Math.random() - 0.5) * 1.6
      const s = 1 + Math.random() * 2.5
      this.fx(x, y, z, Math.cos(a) * s, Math.sin(a) * s, 1 + Math.random() * 2, 0.6 + Math.random() * 0.4, 0.03 + Math.random() * 0.02, "chip")
    }
    const puffs = gun === "shotgun" ? 1 : 2
    for (let i = 0; i < puffs; i++) {
      const a = dir + Math.PI + (Math.random() - 0.5) * 1.2
      this.fx(x - Math.cos(dir) * 0.05, y - Math.sin(dir) * 0.05, z, Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0.3, 0.55 + Math.random() * 0.3, gun === "sniper" ? 0.22 : 0.13, "dust")
    }
    this.fx(x, y, z, 0, 0, 0, 0.06, gun === "sniper" ? 0.6 : 0.35, "spark")
    const me = this.body
    if (me && Math.hypot(x - me.x, y - me.y) < 14) this.sound.impact(x - me.x, y - me.y)
  }

  private blood(x: number, y: number, dir: number, amount = 1): void {
    const n = Math.round(9 * amount)
    for (let i = 0; i < n; i++) {
      const a = dir + (Math.random() - 0.5) * 1.1
      const s = 1.5 + Math.random() * 3.5
      this.fx(x, y, 0.9 + Math.random() * 0.4, Math.cos(a) * s, Math.sin(a) * s, Math.random() * 2, 1.2, 0.035 + Math.random() * 0.035, "blood")
    }
    if (amount >= 0.5) this.fx(x, y, 1.1, Math.cos(dir) * 0.8, Math.sin(dir) * 0.8, 0.2, 0.3, 0.2, "smoke")
  }

  /** Spent brass or a shotgun hull out of the ejection port, flung right and back, tumbling. */
  private casing(a: Avatar): void {
    const g = gunPoints(a)
    if (!g) return
    const s = 1.6 + Math.random() * 1.2
    const v: [number, number, number] = [g.right[0] * s - g.dir[0] * 0.6 + a.svx * 0.8, 1.6 + Math.random() * 1.2, g.right[2] * s - g.dir[2] * 0.6 + a.svy * 0.8]
    this.debris.push({ model: this.models.casing[a.gun], p: g.port, v, yaw: a.aim + Math.PI / 2, pitch: 0, roll: 0, w: [(Math.random() - 0.5) * 30, 15 + Math.random() * 20, (Math.random() - 0.5) * 20], t0: this.now, life: a.gun === "rifle" ? 2.5 : 4, bounces: 0 })
    if (this.debris.length > 220) this.debris.splice(0, this.debris.length - 220)
  }

  private dropMag(a: Avatar): void {
    const g = gunPoints(a)
    if (!g || a.gun === "shotgun") return
    const h = a.handVel
    this.debris.push({ model: this.models.mag[a.gun], p: g.magwell, v: [h[0] * 0.5 + a.svx, -0.5, h[2] * 0.5 + a.svy], yaw: a.aim, pitch: 0, roll: 0, w: [(Math.random() - 0.5) * 4, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8], t0: this.now, life: 5, bounces: 0 })
  }

  /** Cues from an avatar's animation: footsteps, casings, magazines and the mechanical sounds of the gun. */
  private cues(a: Avatar, ev: number, mine: boolean): void {
    if (!ev) return
    const me = this.body
    const dx = me ? a.x - me.x : 0
    const dy = me ? a.y - me.y : 0
    if (ev & EV.step && me && Math.hypot(dx, dy) < 16) this.sound.step(dx, dy, mine, Math.min(1, Math.hypot(a.svx, a.svy) / SPEED))
    if (ev & EV.eject) this.casing(a)
    if (ev & EV.magDrop) this.dropMag(a)
    if (Math.hypot(dx, dy) < 22) this.sound.cue(ev, a.gun, dx, dy, mine)
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

    // Map lights near the view (culled to the GPU budget), then muzzle flashes as short-lived point lights that cast
    // shadows like any other. Soldiers cast round shadows.
    const vp = cam.update(w / h)
    const view = cam.groundRect()
    this.flashes = this.flashes.filter((f) => t - f.t0 < f.life)
    const dyn: DynLight[] = this.flashes.map((f) => ({ x: f.x, y: f.y, h: 1.2, r: 7, color: [1, 0.72, 0.38], power: f.power * (1 - (t - f.t0) / f.life), size: 0.05 }))
    const casters: Caster[] = []
    for (const a of this.avatars.values()) if (a.alive) casters.push({ x: a.x, y: a.y })
    if (this.alive && this.body) casters.push({ x: this.body.x, y: this.body.y })
    this.culler.update(view, t, dyn, casters)
    const nl = this.culler.lightCount

    // Soldiers. A kill freezes animation and effects for a few frames (hit-stop).
    const adt = t < this.freezeUntil ? dt * 0.06 : dt
    const parts = new Map<number, number[]>()
    const push: PushPart = (model, x, y, z, yaw, tint, pitch, roll, flash, alpha = 1) => {
      let arr = parts.get(model)
      if (!arr) parts.set(model, (arr = []))
      arr.push(x, y, z, yaw, tint[0], tint[1], tint[2], 1, pitch, roll, alpha, flash)
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
      this.cues(a, animate(a, adt, t, nx, ny, a.vx + (vx - a.vx) * 0.3, a.vy + (vy - a.vy) * 0.3, a.aim), false)
      const col = this.colorOf(a.id)
      pose(push, a, col, this.models)
      this.sprite(true, a.x, 0.03, a.y, 0.48, col[0], col[1], col[2], 0.9, 2, 0, 0.14)
    }
    const me = this.alive ? this.body : null
    if (me) {
      const a = this.avatarMe
      a.gun = this.gun
      a.alive = true
      a.reloadAt = this.reloadUntil > 0 ? this.reloadUntil - GUNS[this.gun].reload : -10
      a.reloadFor = GUNS[this.gun].reload
      this.cues(a, animate(a, adt, t, me.x, me.y, me.vx, me.vy, this.aim), true)
      const col = this.colorOf(this.myId)
      pose(push, a, col, this.models)
      this.sprite(true, me.x, 0.03, me.y, 0.48, col[0], col[1], col[2], 1, 2, 0, 0.14)
    }

    // Casings and magazines on the floor.
    this.debris = this.debris.filter((d) => t - d.t0 < d.life)
    for (const d of this.debris) {
      if (stepDebris(d, adt, this.solids) && me && Math.hypot(d.p[0] - me.x, d.p[2] - me.y) < 10) this.sound.clink(d.p[0] - me.x, d.p[2] - me.y, d.model === this.models.mag.rifle || d.model === this.models.mag.sniper)
      const sink = Math.max(0, t - d.t0 - (d.life - 0.5)) * 0.12
      push(d.model, d.p[0], d.p[1] - sink, d.p[2], d.yaw, [1, 1, 1], d.pitch, d.roll, 0)
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

    // Corpses: ragdolls that settle, their stripes dimming and a pool spreading, then sink away before the respawn.
    const bodies = new Map<number, number[]>()
    const pushBody: PushPart = (model, x, y, z, yaw, tint, pitch, roll, flash, alpha = 1) => {
      let arr = bodies.get(model)
      if (!arr) bodies.set(model, (arr = []))
      arr.push(x, y, z, yaw, tint[0], tint[1], tint[2], 1, pitch, roll, alpha, flash)
    }
    this.corpses = this.corpses.filter((c) => t - c.t0 < 3.4)
    for (const c of this.corpses) {
      const age = t - c.t0
      stepRagdoll(c.rd, adt)
      const col = this.colorOf(c.id)
      const dim = 0.2 + 0.8 * Math.exp(-age * 1.2)
      const sink = Math.max(0, age - 2.5) ** 2 * 0.6
      const pool = Math.max(0, Math.min(1, (age - 0.4) / 2.4))
      if (pool > 0) {
        const bc = ragdollCentre(c.rd)
        this.sprite(false, bc.x, 0.012, bc.y, 0.1 + 0.55 * Math.sqrt(pool), 0.07, 0.0, 0.004, 0.9 * Math.max(0, 1 - sink * 4), 6)
      }
      emitRagdoll(pushBody, c.rd, c.gun, [col[0] * dim, col[1] * dim, col[2] * dim], this.models, Math.max(0, 0.7 - age * 5), 1, sink)
    }
    for (const [model, data] of bodies) emit(model, data)

    // Muzzle flashes: a hot core, petals along the barrel and, for the sniper, the brake's side jets.
    this.flashFx = this.flashFx.filter((f) => t - f.t0 < (f.gun === "rifle" ? 0.05 : 0.075))
    for (const f of this.flashFx) {
      const life = f.gun === "rifle" ? 0.05 : 0.075
      const p = (t - f.t0) / life
      const fa = 1 - p
      const big = f.gun === "shotgun" ? 1.7 : f.gun === "sniper" ? 1.4 : 1
      const c = Math.cos(f.aim)
      const sn = Math.sin(f.aim)
      this.sprite(true, f.x + c * 0.08, f.z, f.y + sn * 0.08, (0.32 + f.seed * 0.12) * big, 1, 0.85, 0.55, fa, 0)
      const petal = (rot: number, l: number, wd: number, a: number) => {
        const half = l / 2
        this.sprite(true, f.x + Math.cos(rot) * half, f.z, f.y + Math.sin(rot) * half, half, 1, 0.75, 0.4, a, 4, rot, wd / half)
      }
      const len = (0.45 + f.seed * 0.25) * big * (1 - p * 0.4)
      petal(f.aim, len, 0.07 * big, fa)
      petal(f.aim + 0.45 + f.seed * 0.2, len * 0.45, 0.04 * big, fa * 0.8)
      petal(f.aim - 0.45 - (1 - f.seed) * 0.2, len * 0.45, 0.04 * big, fa * 0.8)
      if (f.gun === "shotgun") petal(f.aim, len * 0.8, 0.25, fa * 0.5)
      if (f.gun === "sniper") {
        petal(f.aim + Math.PI / 2, 0.35, 0.05, fa)
        petal(f.aim - Math.PI / 2, 0.35, 0.05, fa)
      }
    }

    // Tracers: rifle and shotgun rounds are short streaks flying down the line; the sniper leaves a lingering beam.
    this.tracers = this.tracers.filter((tr) => t - tr.t0 < tr.life)
    for (const tr of this.tracers) {
      const len = Math.hypot(tr.x1 - tr.x0, tr.y1 - tr.y0)
      if (len < 0.05) continue
      const rot = Math.atan2(tr.y1 - tr.y0, tr.x1 - tr.x0)
      const age = t - tr.t0
      const line = (u0: number, u1: number, w: number, r: number, g: number, b: number, a: number) => {
        const seg = ((u1 - u0) * len) / 2
        if (seg < 0.01) return
        const um = (u0 + u1) / 2
        this.sprite(true, tr.x0 + (tr.x1 - tr.x0) * um, tr.z0, tr.y0 + (tr.y1 - tr.y0) * um, seg, r, g, b, a, 4, rot, w / seg)
      }
      if (tr.gun === "sniper") {
        const p = age / tr.life
        const a = (1 - p) * (1 - p)
        line(0, 1, tr.w * (1 - p * 0.6), 0.85, 0.92, 1, a)
        line(0, 1, tr.w * 4, 0.4, 0.55, 1, a * 0.3)
      } else {
        const head = Math.min(1, (age * TRACER_SPEED) / len)
        const tail = Math.max(0, (age * TRACER_SPEED - TRACER_LEN) / len)
        line(tail, head, tr.w, 1, 0.9, 0.6, 1)
        line(tail, head, tr.w * 4, 1, 0.55, 0.2, 0.22)
      }
    }

    this.particles = this.particles.filter((p) => t - p.t0 < p.life)
    for (const p of this.particles) {
      const age = t - p.t0
      const a = 1 - age / p.life
      if (p.kind === "dust" || p.kind === "smoke") {
        const drag = Math.exp(-adt * 3)
        p.vx *= drag
        p.vy *= drag
        p.vz = p.vz * drag + adt * 0.25
      } else if (p.kind !== "splat") p.vz -= 9.8 * adt
      p.x += p.vx * adt
      p.y += p.vy * adt
      p.z += p.vz * adt
      if (p.z < 0.02) {
        p.z = 0.02
        if (p.kind === "blood") {
          // Drops land as splats that stay a while.
          p.kind = "splat"
          p.t0 = t
          p.life = 5 + Math.random() * 2
          p.size *= 1.6 + Math.random()
          p.z = 0.011
        } else if (p.kind === "spark" && !p.bounced) {
          p.vz = -p.vz * 0.3
          p.bounced = true
        } else {
          p.vz = 0
          p.vx *= 0.7
          p.vy *= 0.7
        }
      }
      if (p.kind === "spark") this.sprite(true, p.x, p.z, p.y, p.size * (p.life < 0.1 ? 1 : 1 + a), 1, 0.72, 0.3, a, 0)
      else if (p.kind === "dust") this.sprite(false, p.x, p.z, p.y, p.size * (1 + age * 2.5), 0.32, 0.31, 0.3, a * 0.55, 1, 0, 0, p.size * 40)
      else if (p.kind === "smoke") this.sprite(false, p.x, p.z, p.y, p.size * (1 + age * 3), 0.42, 0.42, 0.45, a * a * 0.22, 1, 0, 0, p.size * 40)
      else if (p.kind === "chip") this.sprite(false, p.x, p.z, p.y, p.size, 0.25, 0.26, 0.3, Math.min(1, a * 4), 6)
      else if (p.kind === "splat") this.sprite(false, p.x, p.z, p.y, p.size, 0.08, 0.0, 0.005, Math.min(1, a * 3) * 0.9, 6)
      else this.sprite(false, p.x, p.z, p.y, p.size, 0.22, 0.0, 0.01, 1, 6)
    }
    if (this.particles.length > 1500) this.particles.splice(0, this.particles.length - 1500)

    // Uniforms.
    const F = this.frame
    F.set(vp, 0)
    F.set([cam.eye[0], cam.eye[1], cam.eye[2], t], 16)
    F.set([this.renderer.width, this.renderer.height, nl, this.map.lights.length], 20)
    const focus = me ? cam.project(me.x, 0.9, me.y, w, h) : { x: 0, y: 0 }
    F.set([me?.x ?? 0, me?.y ?? 0, me ? 1 : 0, 0.24], 24)
    F.set([0.065, 0.085, 0.18, 1.6], 28)
    F.set([(focus.x / w) * 2 - 1, 1 - (focus.y / h) * 2, 0.7, 0], 32)
    F.set([0, 1, 0, 0], 36)
    F.set([1 / this.map.size[0], 1 / this.map.size[1], this.map.size[0], this.map.size[1]], 40)
    const dead = !!snap && snap.phase === "play" && !this.alive
    const C = this.culler
    return {
      frame: F,
      lights: C.lights,
      lightCount: C.lightCount,
      occluders: C.occ,
      occluderCount: C.occCount,
      lampPower: C.power,
      lampCount: this.map.lights.length,
      view,
      batches,
      alphaSprites: this.alpha,
      alphaCount: this.nAlpha,
      addSprites: this.add,
      addCount: this.nAdd,
      grade: [t, dead ? 0.7 : 0, this.hurt * 0.9, 1.15],
    }
  }
}
