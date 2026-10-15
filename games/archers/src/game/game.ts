import { SideCamera } from "@arcade/kit/client/side-camera"
import { Mesh, type Mat, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Frame, V3 } from "@arcade/kit/rig"
import { type Arena, mod, wrapDelta } from "../../shared/arena"
import { DT } from "../../shared/config"
import { botButtons } from "../../shared/bots"
import type { Buttons } from "../../shared/input"
import { DEFAULT_TUNING, type Tuning } from "../../shared/tuning"
import { type Archer, type Arrow, type ArrowKind, HH, type Item, type SimEvent, World } from "../../shared/world"
import { buildArenaScene } from "../render/arena-mesh"
import { ARROW_LEN, IDENTITIES, archerParts, arrowMesh, bowMesh, brazierMesh, chestMeshes, wingMesh } from "../render/models"
import { INST_FLOATS, type Renderer, type SceneFrame } from "../render/renderer"
import { M } from "../render/shaders"
import type { Sound } from "../sound"
import { type ArcherModels, ArcherView, type Push, RIG_SCALE, pushBody } from "./archer-pose"
import type { Controls, Device } from "./controls"
import { EMBER, FIRE, Fx, Lights, P, Q, Quads } from "./fx"
import type { OnlineSession } from "../net/online"

/** The colour each arrow kind burns with: fire for normal arrows, distinct hot colours for the specials. */
export const ARROW_COLOR: Record<ArrowKind, Rgb> = {
  normal: [1.0, 0.45, 0.12],
  bomb: [1.0, 0.16, 0.05],
  laser: [1.0, 0.18, 0.42],
  drill: [1.0, 0.78, 0.35],
  bramble: [0.62, 0.9, 0.2],
}
const ITEM_COLOR: Record<Item, Rgb> = { ...ARROW_COLOR, shield: [0.55, 0.85, 1.0], wings: [1.0, 0.92, 0.7] }

export type Seat = { id: string; name: string; device: Device | null }
export type GameOptions = { arena: string; seats: Seat[]; seed: number; tuning?: Tuning }

type Hist = { x: number; y: number }
type Spots = { archers: Map<string, Hist>; arrows: Map<number, Hist> }
const spotsOf = (w: World): Spots => ({
  archers: new Map(w.s.archers.map((a) => [a.id, { x: a.x, y: a.y }])),
  arrows: new Map(w.s.arrows.map((r) => [r.id, { x: r.x, y: r.y }])),
})
/** A rollback moving an archer further than this is a respawn or a wrap, not a correction to glide over. */
const GLIDE_MAX = 3
/** Seconds of flight an arrow's trail shows, independent of frame rate. */
const TRAIL_SECONDS = 0.085
const KINDS: readonly ArrowKind[] = ["normal", "bomb", "laser", "drill", "bramble"]
const linear = (c: Rgb, k = 1): Rgb => [c[0] ** 2.2 * k, c[1] ** 2.2 * k, c[2] ** 2.2 * k]

/**
 * A local match: the deterministic sim stepped at 60 Hz (people from devices, bots from their brains), presented
 * with interpolation, hit-stop and slow motion, and turned into one `SceneFrame` per display frame.
 */
export class Game {
  world: World
  readonly cam = new SideCamera()
  readonly fx = new Fx()
  seats: Seat[]
  views = new Map<string, ArcherView>()
  /** Presentation clock (slowed by slow motion, stopped by hit-stop). */
  now = 0
  timeScale = 1
  private acc = 0
  private hitStop = 0
  private slowUntil = 0
  private prev = new Map<string, Hist>()
  private arrowPrev = new Map<number, Hist>()
  private trails = new Map<number, (Hist & { t: number })[]>()
  /** When each arrow stuck, for the shaft's quiver; and who was drawing last tick, for the draw creak. */
  private stuckAt = new Map<number, number>()
  private wasDrawing = new Set<string>()
  private archerModels: ArcherModels[] = []
  private bowModel: number
  private arrowModels: Record<ArrowKind, number>
  private chestBody: number
  private chestLid: number
  private brazier: number
  private wing: number
  private sunPoint: V3 = [16, 22, -42]
  private parts = new Map<number, number[]>()
  private dynamic = new Mesh()
  private add = new Quads()
  private alpha = new Quads()
  private mist = new Quads()
  private lights = new Lights()
  private hurt = 0
  private emberAcc = 0
  /** Close-up for captures and the Lab: frame this archer with `focusSpan` tiles of height. */
  focus: string | null = null
  focusSpan = 6
  /** Events of the last frame, for the HUD and proofs. */
  events: SimEvent[] = []
  readonly counts: Record<string, number> = {}
  onEvent: ((e: SimEvent) => void) | null = null
  /** Online play: the room session drives the world instead of local stepping. */
  online: OnlineSession | null = null
  private loadedArena = ""
  /** How far each archer was drawn from where a rollback put it: eased to zero so corrections glide, not pop. */
  private offsets = new Map<string, Hist>()

  constructor(readonly renderer: Renderer, readonly controls: Controls, readonly sound: Sound, opts: GameOptions) {
    this.world = World.create(opts.seed, opts.arena, opts.tuning ?? { ...DEFAULT_TUNING })
    this.seats = opts.seats
    for (const s of this.seats) this.world.add(s.id, s.name, !s.device)
    const r = renderer
    for (const id of IDENTITIES) {
      const p = archerParts(id.hat)
      this.archerModels.push({
        pelvis: r.addModel(p.pelvis), torso: r.addModel(p.torso), head: r.addModel(p.head), upperArm: r.addModel(p.upperArm), foreArm: r.addModel(p.foreArm),
        thigh: r.addModel(p.thigh), shin: r.addModel(p.shin), foot: r.addModel(p.foot), toe: r.addModel(p.toe),
      })
    }
    this.bowModel = r.addModel(bowMesh())
    this.arrowModels = Object.fromEntries(KINDS.map((k) => [k, r.addModel(arrowMesh(k))])) as Record<ArrowKind, number>
    const chest = chestMeshes()
    this.chestBody = r.addModel(chest.body)
    this.chestLid = r.addModel(chest.lid)
    this.brazier = r.addModel(brazierMesh())
    this.wing = r.addModel(wingMesh())
    this.loadArena()
  }

  get arena(): Arena {
    return this.world.arena
  }

  private loadArena(): void {
    this.loadedArena = this.world.s.arena
    const scene = buildArenaScene(this.arena)
    this.renderer.setStatic(scene.mesh)
    this.sunPoint = scene.sun
    this.views.clear()
    this.prev.clear()
  }

  setArena(id: string): void {
    this.world.setArena(id)
    this.world.s.round = 0
    this.loadArena()
  }

  /** Adds a person on `device`, taking over a bot's seat if the arena is full. */
  join(device: Device, name: string): Seat | null {
    const bot = this.seats.find((s) => !s.device)
    if (bot) {
      bot.device = device
      bot.name = name
      const a = this.world.archer(bot.id)
      if (a) {
        a.bot = false
        a.name = name
      }
      delete this.world.s.brains[bot.id]
      return bot
    }
    return null
  }

  private input(a: Archer): Buttons {
    const seat = this.seats.find((s) => s.id === a.id)
    if (!seat?.device) return botButtons(this.world, a)
    return this.controls.buttons(seat.device)
  }

  // Update --------------------------------------------------------------------------------------------------------

  update(realDt: number): void {
    // Online time can't be dropped: the room keeps going, so a long frame still advances the head in full.
    if (this.online?.ready) return this.updateOnline(Math.min(1, realDt))
    const dt = Math.min(0.1, realDt)
    if (this.hitStop > 0) {
      this.hitStop -= dt
      return
    }
    const slow = this.now < this.slowUntil
    this.timeScale += ((slow ? 0.28 : 1) - this.timeScale) * Math.min(1, dt * (slow ? 30 : 6))
    const sdt = dt * this.timeScale
    this.now += sdt
    this.acc += sdt
    let steps = 0
    while (this.acc >= DT && steps < 8) {
      this.acc -= DT
      steps++
      for (const a of this.world.s.archers) this.prev.set(a.id, { x: a.x, y: a.y })
      for (const r of this.world.s.arrows) this.arrowPrev.set(r.id, { x: r.x, y: r.y })
      this.world.step((a) => this.input(a))
      for (const e of this.world.takeEvents()) this.onSim(e)
      for (const a of this.world.s.archers) {
        if (a.drawing && !this.wasDrawing.has(a.id) && a.quiver.length) this.sound.play("bow.draw", a.x, a.y + 0.8)
        if (a.drawing) this.wasDrawing.add(a.id)
        else this.wasDrawing.delete(a.id)
      }
      if (this.hitStop > 0) {
        this.acc = 0
        break
      }
    }
    if (steps >= 8) this.acc = 0
    this.fx.update(sdt)
    this.hurt *= Math.exp(-dt * 3)
    this.ambient(sdt)
  }

  /**
   * Online: the session runs rollback to its head tick and this presents the result. The room's clock can't stop, so
   * hit-stop only freezes effects and there is no slow motion; corrections to where archers were drawn are eased out.
   */
  private updateOnline(dt: number): void {
    const o = this.online!
    if (this.hitStop > 0) this.hitStop -= dt
    this.timeScale = 1
    this.now += dt
    const oldHead = o.rb.headTick
    const before = spotsOf(o.world)
    let cur = before
    let prev: Spots | null = null
    let atOld: Spots | null = null
    const device = (b: number) => b | this.controls.buttons("pad0")
    const events = o.update(() => device(this.controls.buttons("kb")), (w, t) => {
      prev = cur
      cur = spotsOf(w)
      if (t === oldHead && o.rb.resimulated > 0) atOld = cur
    })
    this.world = o.world
    if (this.world.s.arena !== this.loadedArena) this.loadArena()
    if (o.id && this.seats[0]?.id !== o.id) this.seats = [{ id: o.id, name: "YOU", device: "kb" }]
    if (prev) {
      this.prev = (prev as Spots).archers
      this.arrowPrev = (prev as Spots).arrows
    }
    if (atOld) {
      const W = this.arena.w, H = this.arena.h
      for (const [id, was] of before.archers) {
        const now = (atOld as Spots).archers.get(id)
        if (!now) continue
        const dx = wrapDelta(was.x - now.x, W), dy = wrapDelta(was.y - now.y, H)
        if (Math.abs(dx) > GLIDE_MAX || Math.abs(dy) > GLIDE_MAX) continue
        const off = this.offsets.get(id) ?? { x: 0, y: 0 }
        this.offsets.set(id, { x: off.x + dx, y: off.y + dy })
      }
    }
    const k = Math.exp(-dt * 14)
    for (const [id, off] of this.offsets) {
      off.x *= k
      off.y *= k
      if (Math.abs(off.x) + Math.abs(off.y) < 1e-3) this.offsets.delete(id)
    }
    this.acc = o.fraction * DT
    for (const e of events) this.onSim(e)
    for (const a of this.world.s.archers) {
      if (a.drawing && !this.wasDrawing.has(a.id) && a.quiver.length) this.sound.play("bow.draw", a.x, a.y + 0.8)
      if (a.drawing) this.wasDrawing.add(a.id)
      else this.wasDrawing.delete(a.id)
    }
    const fdt = Math.min(0.1, dt)
    this.fx.update(this.hitStop > 0 ? 0 : fdt)
    this.hurt *= Math.exp(-fdt * 3)
    this.ambient(fdt)
  }

  private ambient(dt: number): void {
    // Embers off the fire bowls.
    this.emberAcc += dt * 14
    while (this.emberAcc > 1) {
      this.emberAcc--
      const b = this.arena.braziers[Math.floor(this.fx.rnd() * this.arena.braziers.length)]
      if (!b) break
      const x = b[0] + (this.fx.rnd() - 0.5) * 0.5, y = b[1] + 0.75
      this.fx.spawn(P.ember, x, y, (this.fx.rnd() - 0.5) * 0.4, (this.fx.rnd() - 0.5) * 0.8, 1.2 + this.fx.rnd() * 1.6, 0)
    }
  }

  private onSim(e: SimEvent): void {
    this.counts[e.k] = (this.counts[e.k] ?? 0) + 1
    this.events.push(e)
    this.onEvent?.(e)
    const fx = this.fx
    const snd = this.sound
    switch (e.k) {
      case "shoot": {
        const c = linear(ARROW_COLOR[e.kind], 3)
        fx.flash(e.x, e.y, 2.2, c, 3, 18)
        fx.burst(P.spark, 5, e.x, e.y, 0.2, 4, e.dx * 0.6, e.dy * 0.6, 0.6)
        snd.play("bow.release", e.x, e.y, { rate: e.kind === "normal" ? 1 : 0.9 })
        const v = this.views.get(e.by)
        if (v) v.looseAt = this.now
        break
      }
      case "stick": {
        const l = Math.hypot(e.dx, e.dy) || 1
        const nx = -e.dx / l, ny = -e.dy / l
        fx.burst(P.spark, 7, e.x, e.y, 0.3, 6, nx * 0.5, ny * 0.5, 0.8)
        fx.burst(P.chip, 6, e.x, e.y, 0.3, 4, nx * 0.6, ny * 0.6 + 0.3, 0.7)
        fx.burst(P.dust, 2, e.x, e.y, 0.2, 0.8, nx * 0.4, ny * 0.4, 0.5)
        fx.flash(e.x, e.y, 1.8, linear(ARROW_COLOR[e.kind], 2), 2, 14)
        this.cam.add(0.06, e.dx / l * 0.05, e.dy / l * 0.05)
        snd.play("arrow.thunk", e.x, e.y, { rate: e.into === "floor" ? 0.95 : 1.05 })
        this.stuckAt.set(e.id, this.now)
        break
      }
      case "kill": {
        const v = this.views.get(e.victim)
        v?.kill(e.dx, e.dy)
        const killer = this.world.archer(e.by)
        const col = killer ? linear(IDENTITIES[killer.slot % 4]!.ember, 3) : linear(FIRE, 3)
        fx.burst(P.feather, 22, e.x, e.y, 0.3, 5, e.dx * 0.5, e.dy * 0.5 + 0.3, 1)
        fx.burst(P.cloth, 10, e.x, e.y, 0.3, 6, e.dx * 0.6, e.dy * 0.6 + 0.4, 0.8)
        fx.burst(P.spark, 16, e.x, e.y, 0.4, 8, e.dx * 0.4, e.dy * 0.4, 1)
        fx.flash(e.x, e.y, 4, col, 6, 8)
        fx.ring(e.x, e.y, 0.2, 1.8, 0.3, col, 0.5)
        this.cam.add(e.last ? 0.55 : 0.4, e.dx * 0.25, e.dy * 0.25)
        this.cam.zoomPunch(e.last ? 0.08 : 0.04)
        this.hitStop = e.last ? 0.11 : 0.07
        if (e.last) this.slowUntil = this.now + 0.75
        this.hurt = Math.max(this.hurt, this.seats.some((s) => s.id === e.victim && s.device) ? 1 : 0)
        if (e.cause === "arrow") snd.play("arrow.hit", e.x, e.y)
        snd.play("archer.feathers", e.x, e.y)
        break
      }
      case "catch": {
        const a = this.world.archer(e.by)
        const c = a ? linear(IDENTITIES[a.slot % 4]!.ember, 3) : linear(EMBER, 3)
        fx.ring(e.x, e.y, 0.1, 1.2, 0.3, c, 1)
        fx.burst(P.spark, 10, e.x, e.y, 0.3, 5)
        fx.flash(e.x, e.y, 2.5, c, 3, 12)
        this.hitStop = Math.max(this.hitStop, 0.04)
        snd.play("arrow.catch", e.x, e.y)
        break
      }
      case "jump":
        fx.burst(P.dust, e.kind === "wall" ? 4 : 3, e.x, e.y + (e.kind === "wall" ? 0.6 : 0.05), 0.1, 1.2, 0, 0.2, 1)
        if (e.kind === "flap") snd.play("wings.flap", e.x, e.y)
        break
      case "land": {
        const v = this.views.get(e.id)
        if (v) {
          v.landAt = this.now
          v.landV = e.v
        }
        if (e.v > 8) fx.burst(P.dust, 4 + Math.floor(e.v / 6), e.x, e.y + 0.05, 0.1, 1.5 + e.v * 0.06, 0, 0.1, 1)
        break
      }
      case "dodge":
        fx.burst(P.dust, 3, e.x, e.y + 0.6, 0.1, 1.5, -e.dx * 0.4, -e.dy * 0.4, 0.8)
        snd.play("archer.dodge", e.x, e.y)
        break
      case "grab":
        fx.burst(P.dust, 3, e.x, e.y + HH, 0.1, 0.8)
        break
      case "pickup":
        fx.ring(e.x, e.y + 0.3, 0.05, 0.45, 0.2, linear(ARROW_COLOR[e.kind], 2), 0.35)
        snd.play("arrow.pickup", e.x, e.y)
        break
      case "chest":
        fx.burst(P.spark, 24, e.x, e.y + 0.5, 0.3, 6, 0, 0.6, 0.9)
        fx.flash(e.x, e.y + 0.6, 4, linear(ITEM_COLOR[e.item], 3), 4, 4)
        snd.play("chest.open", e.x, e.y)
        break
      case "item":
        fx.ring(e.x, e.y, 0.1, 1.4, 0.4, linear(ITEM_COLOR[e.item], 2.5), 1)
        snd.play("pickup.item", e.x, e.y)
        break
      case "boom":
        fx.burst(P.fireball, 6, e.x, e.y, 0.3, 2.5)
        fx.burst(P.spark, 30, e.x, e.y, 0.3, 12)
        fx.burst(P.chip, 14, e.x, e.y, 0.3, 8)
        fx.burst(P.smoke, 6, e.x, e.y, 0, 1.5, 0, 0.3)
        fx.spawn(P.shock, e.x, e.y, 0.3)
        fx.flash(e.x, e.y, 7, linear(FIRE, 4), 9, 5)
        this.cam.add(0.6, 0, 0)
        this.cam.zoomPunch(0.05)
        snd.play("bomb.explode", e.x, e.y)
        break
      case "laser":
        fx.beam(e.pts, linear(ARROW_COLOR.laser, 2.5))
        this.cam.add(0.15)
        snd.play("laser.beam", e.pts[0], e.pts[1])
        break
      case "shield":
        fx.ring(e.x, e.y, 0.6, 2.2, 0.35, linear(ITEM_COLOR.shield, 3), 1)
        fx.burst(P.spark, 14, e.x, e.y, 0.3, 6)
        snd.play("shield.break", e.x, e.y)
        break
      case "bramble":
        fx.burst(P.leaf, 12, (e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2, 0.3, 3)
        snd.play("bramble.grow", (e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2)
        break
      case "dry":
        snd.play("gun.dry-fire", e.x, e.y, { gain: 0.5 })
        break
      case "phase":
        snd.play(e.phase === "play" ? "ui.ping" : "ui.tick")
        if (e.phase === "count") {
          this.trails.clear()
          for (const v of this.views.values()) v.scarf = []
        }
        break
    }
  }

  // Build -----------------------------------------------------------------------------------------------------------

  private pushPart: Push = (model, f, scale, tint, emissive = 0, keep = 0, flash = 0) => {
    let list = this.parts.get(model)
    if (!list) this.parts.set(model, (list = []))
    list.push(f.p[0], f.p[1], f.p[2], scale, f.x[0], f.x[1], f.x[2], emissive, f.y[0], f.y[1], f.y[2], keep, f.z[0], f.z[1], f.z[2], flash, tint[0], tint[1], tint[2], 1)
  }

  /** Interpolated position of an archer between the last two ticks. */
  private lerpPos(a: Archer): Hist {
    const p = this.prev.get(a.id)
    const k = Math.min(1, this.acc / DT)
    const off = this.offsets.get(a.id)
    const ox = off?.x ?? 0, oy = off?.y ?? 0
    const W = this.arena.w, H = this.arena.h
    if (!p) return { x: mod(a.x + ox, W), y: mod(a.y + oy, H) }
    return { x: mod(p.x + wrapDelta(a.x - p.x, W) * k + ox, W), y: mod(p.y + wrapDelta(a.y - p.y, H) * k + oy, H) }
  }

  build(w: number, h: number, realDt: number): SceneFrame {
    const aspect = w / Math.max(1, h)
    const A = this.arena
    const f = this.focus ? this.world.archer(this.focus) : null
    if (f) {
      const p = this.lerpPos(f)
      const hw = (this.focusSpan * aspect) / 2
      this.cam.frame(p.x - hw, p.y + 0.6 - this.focusSpan / 2, p.x + hw, p.y + 0.6 + this.focusSpan / 2, aspect)
    } else this.cam.frame(0, 0, A.w, A.h, aspect, 0.35)
    const vp = this.cam.update(realDt, aspect)
    for (const list of this.parts.values()) list.length = 0
    this.dynamic.v.length = 0
    this.add.reset()
    this.alpha.reset()
    this.mist.reset()
    this.lights.reset()
    const dt = this.hitStop > 0 ? 0 : realDt * this.timeScale

    this.drawBraziers()
    this.drawArchers(dt)
    this.drawArrows()
    this.drawChests()
    this.drawPickups()
    this.drawBrambles()
    this.drawMist()
    this.fx.emit(this.add, this.lights)

    const sun = this.cam.project(this.sunPoint[0], this.sunPoint[1], this.sunPoint[2], w, h)
    const s = this.world.s
    const desat = s.phase === "over" || s.phase === "match" ? Math.min(0.6, (s.time - s.phaseAt) * 1.5) * (1 - this.timeScale) + 0.0 : 0
    return {
      viewProj: vp,
      eye: this.cam.eye,
      time: this.now,
      // The glow sits in the fog just below the bell window, where the concept's light pools.
      sun: [sun.x / w - 0.02, sun.y / h + 0.13, 0.22, 1.0],
      fog: [0.016, 2.4, 0.55, 0.045],
      skyBrightness: 1,
      rim: 0.6,
      shafts: 1,
      hurt: this.hurt * 0.6,
      desat: Math.max(desat, (1 - this.timeScale) * 0.7),
      tint: [0.9, 0.94, 1.0],
      lights: this.lights.data,
      lightCount: this.lights.count,
      parts: this.parts,
      dynamic: this.dynamic,
      mist: this.mist.data,
      mistCount: this.mist.count,
      alpha: this.alpha.data,
      alphaCount: this.alpha.count,
      add: this.add.data,
      addCount: this.add.count,
      particles: this.fx.particles,
    }
  }

  /** Copies of a point across the wrap seams that are near enough to the edge to be seen. */
  private wraps(x: number, y: number, pad: number): [number, number][] {
    const A = this.arena
    const xs = [0]
    const ys = [0]
    if (x < pad) xs.push(A.w)
    if (x > A.w - pad) xs.push(-A.w)
    if (y < pad) ys.push(A.h)
    if (y > A.h - pad) ys.push(-A.h)
    const out: [number, number][] = []
    for (const ox of xs) for (const oy of ys) out.push([ox, oy])
    return out
  }

  private drawBraziers(): void {
    const t = this.now
    for (const [i, b] of this.arena.braziers.entries()) {
      const f: Frame = { p: [b[0], b[1], 0.2], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
      this.pushPart(this.brazier, f, 1, linear(FIRE, 1.4), 0, 1, 0)
      const flick = 0.85 + 0.15 * Math.sin(t * 11 + i * 3) + 0.08 * Math.sin(t * 23 + i)
      this.lights.push(b[0], b[1] + 1.1, 0.8, 5.5, linear(FIRE, 1), 2.2 * flick)
      this.add.push(b[0], b[1] + 0.95, 0.4, 1.0, 1.0, 0, Q.glow, linear(FIRE, 1.2), 0.4 * flick, 1)
      this.add.push(b[0], b[1] + 0.9, 0.5, 0.3, 0.4, 0, Q.glow, linear([1, 0.6, 0.25], 3), 0.8 * flick, 1)
      // Flame tongues.
      for (let k = 0; k < 4; k++) {
        const ph = t * (3 + k * 0.7) + k * 1.7 + i
        const u = (ph % 1 + 1) % 1
        this.add.push(b[0] + Math.sin(ph * 2.3) * 0.12, b[1] + 0.85 + u * 0.7, 0.45, 0.14 * (1 - u) + 0.05, 0.22 * (1 - u) + 0.08, 0, Q.glow, linear([1, 0.5 + 0.3 * (1 - u), 0.15], 3), (1 - u) * 0.8, 1)
      }
    }
  }

  private drawArchers(dt: number): void {
    const s = this.world.s
    const W = this.arena.w
    for (const a of s.archers) {
      let v = this.views.get(a.id)
      const p = this.lerpPos(a)
      if (!v) {
        v = new ArcherView(a.id, p.x, p.y)
        this.views.set(a.id, v)
      }
      const id = IDENTITIES[a.slot % 4]!
      const m = this.archerModels[a.slot % 4]!
      const ember = linear(id.ember, 2.2)
      if (a.alive) v.update(a, p.x, p.y, dt, this.now, W)
      else if (a.deadAt >= 0 && s.time - a.deadAt < 6) v.update(a, p.x, p.y, dt, this.now, W)
      else continue
      const body = a.alive ? v.world : v.deadWorld()
      if (!body) continue
      const pulse = 0.8 + 0.4 * Math.sin(this.now * 5 + a.slot)
      const markOn = a.alive ? 1 : Math.max(0, 1 - (s.time - a.deadAt) * 0.8)
      for (const [ox, oy] of this.wraps(p.x, p.y, 2.5)) {
        const shift = (f: Frame): Frame => (ox || oy ? { p: [f.p[0] + ox, f.p[1] + oy, f.p[2]], x: f.x, y: f.y, z: f.z } : f)
        const push: Push = (model, f, scale, tint, e, k, fl) => this.pushPart(model, shift(f), scale, tint, e, k, fl)
        pushBody(push, body, m, ember, v.flash, (a.alive ? pulse : 0.3) * markOn)
        if (a.alive && v.bow) push(this.bowModel, v.bow, RIG_SCALE * 1.15, ember, 0, 0, 0)
        if (a.alive && a.wings) this.drawWings(push, body.torso, a)
        this.drawScarf(v, ox, oy, id.scarf)
        if (a.alive && v.bow) {
          // Bow string and the nocked arrow.
          const z = v.bow.p[2] + 0.01
          this.ribbon([[v.stringTop[0] + ox, v.stringTop[1] + oy], [v.nock[0] + ox, v.nock[1] + oy], [v.stringBot[0] + ox, v.stringBot[1] + oy]], z, 0.008, 0.008, [0.5, 0.5, 0.5], M.actor, 0)
          if (a.drawing && a.quiver.length) {
            const kind = a.quiver[0]!
            const dx = a.aimX || a.face, dy = a.aimY
            const l = Math.hypot(dx, dy) || 1
            const f = this.arrowFrame(v.nock[0] + ox, v.nock[1] + oy, dx / l, dy / l, v.nock[2] + 0.02, 0)
            push(this.arrowModels[kind], f, 0.75, linear(ARROW_COLOR[kind], 2.4), 0, 1, 0)
            const head = [f.p[0] + (dx / l) * ARROW_LEN * 0.75, f.p[1] + (dy / l) * ARROW_LEN * 0.75] as const
            const k = Math.min(1, a.drawT / 0.35)
            this.add.push(head[0], head[1], 0.5, 0.35 + 0.25 * k, 0.35 + 0.25 * k, 0, Q.glow, linear(ARROW_COLOR[kind], 2.5), 0.5 + 0.4 * k, 1)
            if (!ox && !oy) this.lights.push(head[0], head[1], 0.6, 3, linear(ARROW_COLOR[kind], 1), 1.2 * k)
          }
        }
        if (a.alive && a.shield) {
          const c = linear(ITEM_COLOR.shield, 1.8)
          this.add.push(p.x + ox, p.y + oy + HH / 2, 0.6, 0.95, 0.95, 0, Q.ring, c, 0.55 + 0.15 * Math.sin(this.now * 6), 0.8)
          this.add.push(p.x + ox, p.y + oy + HH / 2, 0.6, 0.95, 0.95, 0, Q.glow, c, 0.12, 0.8)
        }
        if (a.alive) this.drawPips(a, p.x + ox, p.y + oy, id.ember)
      }
      if (a.alive) this.lights.push(p.x, p.y + 0.9, 0.5, 1.2, linear(id.ember, 1), 0.25)
    }
  }

  private drawWings(push: Push, torso: Frame, a: Archer): void {
    const flap = a.vy > 0 || a.ground ? Math.sin(this.now * (a.ground ? 3 : 18)) * (a.ground ? 0.12 : 0.6) : 0.2
    const back: V3 = [torso.p[0] - torso.x[0] * 0.12, torso.p[1] + 0.32, torso.p[2] - 0.05]
    for (const side of [-1, 1]) {
      const ang = 0.5 + flap
      const dir: V3 = [-a.face * Math.cos(ang) * 0.9, Math.sin(ang), side * 0.35]
      const l = Math.hypot(dir[0], dir[1], dir[2])
      const x: V3 = [dir[0] / l, dir[1] / l, dir[2] / l]
      const y: V3 = [-x[1], x[0], 0]
      const yl = Math.hypot(y[0], y[1]) || 1
      const yy: V3 = [y[0] / yl, y[1] / yl, 0]
      const z: V3 = [x[1] * yy[2] - x[2] * yy[1], x[2] * yy[0] - x[0] * yy[2], x[0] * yy[1] - x[1] * yy[0]]
      push(this.wing, { p: back, x, y: yy, z }, 0.85, [1, 1, 1], 0, 0, 0)
    }
  }

  /** Quiver pips over the head: one per arrow, in the archer's ember colour (specials in their own colour). */
  private drawPips(a: Archer, x: number, y: number, ember: Rgb): void {
    const n = a.quiver.length
    const sp = 0.16
    for (let i = 0; i < n; i++) {
      const kind = a.quiver[i]!
      const c = kind === "normal" ? linear(ember, 2.2) : linear(ARROW_COLOR[kind], 2.6)
      const px = x + (i - (n - 1) / 2) * sp
      this.add.push(px, y + HH + 0.32, 0.8, 0.055, 0.075, 0, Q.diamond, c, 0.95, 1)
    }
  }

  private drawScarf(v: ArcherView, ox: number, oy: number, color: Rgb): void {
    if (v.scarf.length < 2) return
    const pts = v.scarf.map((p) => [p[0] + ox, p[1] + oy] as [number, number])
    this.ribbon(pts, v.scarf[0]![2], 0.07, 0.025, linear(color, 1.4), M.cloth, 0.75)
  }

  /** A camera-facing strip through points, tapering from w0 to w1 half widths. */
  private ribbon(pts: [number, number][], z: number, w0: number, w1: number, color: Rgb, mat: number, aux: number): void {
    const n = pts.length
    const side: [number, number][] = []
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(n - 1, i + 1)]!
      const dx = b[0] - a[0], dy = b[1] - a[1]
      const l = Math.hypot(dx, dy) || 1
      const w = w0 + (w1 - w0) * (i / (n - 1))
      side.push([(-dy / l) * w, (dx / l) * w])
    }
    for (let i = 0; i + 1 < n; i++) {
      const p = pts[i]!, q = pts[i + 1]!, s0 = side[i]!, s1 = side[i + 1]!
      this.dynamic.quad([p[0] - s0[0], p[1] - s0[1], z], [q[0] - s1[0], q[1] - s1[1], z], [q[0] + s1[0], q[1] + s1[1], z], [p[0] + s0[0], p[1] + s0[1], z], [0, 0, 1], color, mat as Mat, aux)
    }
  }

  /** An arrow frame whose nock sits at (x, y) pointing along (dx, dy). */
  private arrowFrame(x: number, y: number, dx: number, dy: number, z: number, spin: number): Frame {
    const c = Math.cos(spin), s = Math.sin(spin)
    return { p: [x, y, z], x: [dx, dy, 0], y: [-dy * c, dx * c, s], z: [dy * s, -dx * s, c] }
  }

  private drawArrows(): void {
    const s = this.world.s
    const W = this.arena.w, H = this.arena.h
    const k = Math.min(1, this.acc / DT)
    const scale = 0.75
    const live = new Set<number>()
    for (const r of s.arrows) {
      live.add(r.id)
      const pv = this.arrowPrev.get(r.id)
      const x = pv && r.state !== "stuck" ? mod(pv.x + wrapDelta(r.x - pv.x, W) * k, W) : r.x
      const y = pv && r.state !== "stuck" ? mod(pv.y + wrapDelta(r.y - pv.y, H) * k, H) : r.y
      const sp = Math.hypot(r.vx, r.vy) || 1
      const dx = r.vx / sp, dy = r.vy / sp
      const len = ARROW_LEN * scale
      const c = ARROW_COLOR[r.kind]
      const flying = r.state === "fly"
      const z = flying ? 0.05 : r.state === "stuck" ? 0.25 : 0.1
      // A freshly stuck shaft quivers about its head for a moment.
      const since = r.state === "stuck" ? this.now - (this.stuckAt.get(r.id) ?? -9) : 9
      const wob = since < 0.4 ? Math.sin(since * 70) * 0.22 * (1 - since / 0.4) ** 2 : 0
      const cw = Math.cos(wob), sw = Math.sin(wob)
      const wdx = dx * cw - dy * sw, wdy = dx * sw + dy * cw
      for (const [ox, oy] of this.wraps(x, y, 1.5)) {
        const back = len * (r.state === "stuck" ? 0.7 : 1)
        const f = this.arrowFrame(x + ox - wdx * back, y + oy - wdy * back, wdx, wdy, z, r.state === "loose" ? r.age * 14 : 0)
        this.pushPart(this.arrowModels[r.kind], f, scale, linear(c, flying ? 2.6 : 1.4), 0, 1, 0)
        const hx = x + ox, hy = y + oy
        this.add.push(hx, hy, 0.35, flying ? 0.32 : 0.2, flying ? 0.32 : 0.2, 0, Q.glow, linear(c, flying ? 1.8 : 1.1), flying ? 0.6 : 0.35 + 0.12 * Math.sin(this.now * 4 + r.id), 1)
      }
      if (flying) this.lights.push(x, y, 0.5, 3.2, linear(c, 1), 1.5)
      else if (r.state === "stuck") this.lights.push(x, y, 0.5, 1.4, linear(c, 1), 0.35)
      // Trails: the last few positions, broken across wrap seams.
      let tr = this.trails.get(r.id)
      if (!tr) this.trails.set(r.id, (tr = []))
      if (flying && (!tr.length || tr[0]!.t !== this.now)) tr.unshift({ x, y, t: this.now })
      while (tr.length && this.now - tr[tr.length - 1]!.t > TRAIL_SECONDS) tr.pop()
      for (let i = 0; i + 1 < tr.length; i++) {
        const p = tr[i]!, q = tr[i + 1]!
        if (Math.abs(p.x - q.x) > 3 || Math.abs(p.y - q.y) > 3) continue
        const u = 1 - (this.now - p.t) / TRAIL_SECONDS
        this.add.line(p.x, p.y, q.x, q.y, 0.3, 0.04 * u + 0.01, Q.bar, linear(c, 2), u * u * 0.6, 1)
      }
    }
    for (const id of this.trails.keys()) if (!live.has(id)) this.trails.delete(id)
    for (const id of this.stuckAt.keys()) if (!live.has(id)) this.stuckAt.delete(id)
    for (const id of this.arrowPrev.keys()) if (!live.has(id)) this.arrowPrev.delete(id)
  }

  private drawChests(): void {
    const s = this.world.s
    for (const c of s.chests) {
      const open = c.open ? Math.min(1, (s.time - c.openedAt) * 5) : 0
      const fade = c.open ? Math.max(0, 1 - (s.time - c.openedAt - 1.6) * 1.2) : 1
      if (fade <= 0) continue
      const bob = c.open ? 0 : Math.max(0, 0.15 - (s.time % 3) * 0.6) * Math.sin(this.now * 40)
      const f: Frame = { p: [c.x + bob * 0.2, c.y, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
      this.pushPart(this.chestBody, f, 1.1, linear([1, 0.6, 0.25], 2), 0, 0.6, 0)
      const th = -1.9 * open
      const cs = Math.cos(th), sn = Math.sin(th)
      const lid: Frame = { p: [c.x + bob * 0.2, c.y + 0.42 * 1.1, -0.28 * 1.1], x: [1, 0, 0], y: [0, cs, -sn], z: [0, sn, cs] }
      this.pushPart(this.chestLid, lid, 1.1, [1, 1, 1], 0, 0, 0)
      const glow = c.open ? (1 - open * 0.5) * fade : 0.35 + 0.15 * Math.sin(this.now * 3)
      this.add.push(c.x, c.y + 0.45, 0.6, 0.9, 0.7, 0, Q.glow, linear([1, 0.7, 0.3], 1.5), glow, 0.9)
      this.lights.push(c.x, c.y + 0.6, 0.8, 3, linear([1, 0.65, 0.3], 1), c.open ? 2 * fade : 0.5)
    }
  }

  private drawPickups(): void {
    for (const p of this.world.s.pickups) {
      const c = linear(ITEM_COLOR[p.item], 2.2)
      const y = p.y + Math.sin(this.now * 3 + p.id) * 0.08
      const blink = p.age > 11 ? (Math.sin(this.now * 20) > 0 ? 1 : 0.3) : 1
      this.add.push(p.x, y, 0.5, 0.75, 0.75, 0, Q.glow, c, 0.45 * blink, 1)
      this.add.push(p.x, y, 0.55, 0.42, 0.42, this.now, Q.ring, c, 0.8 * blink, 1)
      this.lights.push(p.x, y, 0.8, 2.5, linear(ITEM_COLOR[p.item], 1), 1)
      if (p.item === "shield") {
        this.add.push(p.x, y, 0.6, 0.22, 0.22, 0, Q.disc, c, 0.6 * blink, 1)
      } else if (p.item === "wings") {
        for (const side of [-1, 1]) {
          const f: Frame = { p: [p.x, y - 0.05, 0.4], x: [side * 0.8, 0.6, 0], y: [-0.6, side * 0.8, 0], z: [0, 0, side] }
          this.pushPart(this.wing, f, 0.55, [1, 1, 1], 0, 0, 0)
        }
      } else {
        for (const s of [-1, 1]) {
          const ang = Math.PI / 2 + s * 0.35
          const dx = Math.cos(ang), dy = Math.sin(ang)
          this.pushPart(this.arrowModels[p.item], this.arrowFrame(p.x - dx * 0.32, y - dy * 0.32, dx, dy, 0.45, 0), 0.7, c, 0, 1, 0)
        }
      }
    }
  }

  private drawBrambles(): void {
    const s = this.world.s
    for (const b of s.brambles) {
      const grow = Math.min(1, (s.time - b.born) / 0.25)
      const wither = Math.min(1, (b.until - s.time) / 0.6)
      const k = grow * wither
      const w = b.x1 - b.x0, h = b.y1 - b.y0
      let seed = b.id * 7919
      const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
      const n = Math.ceil((w * h) * 40)
      const horiz = w > h
      for (let i = 0; i < n; i++) {
        const u = rnd(), vv = rnd()
        const x = b.x0 + u * w, y = b.y0 + vv * h
        const along = horiz ? Math.abs(u - 0.5) * 2 : Math.abs(vv - 0.5) * 2
        if (along > k) continue
        const len = (0.12 + rnd() * 0.22) * k
        const ang = rnd() * Math.PI * 2
        const z = -0.3 + rnd() * 0.9
        const tx = x + Math.cos(ang) * len, ty = y + Math.sin(ang) * len
        const px = -Math.sin(ang) * 0.025, py = Math.cos(ang) * 0.025
        this.dynamic.facet([x - px, y - py, z], [tx, ty, z], [x + px, y + py, z], [1, 1, 1], M.actor as Mat)
        this.dynamic.facet([x + px, y + py, z], [tx, ty, z], [x - px, y - py, z], [1, 1, 1], M.actor as Mat)
      }
      // A dim ember glow in the thorns so the hazard reads.
      this.add.push((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 0.4, w / 2 + 0.2, h / 2 + 0.2, 0, Q.glow, linear(ARROW_COLOR.bramble, 0.8), 0.35 * k, 1)
    }
  }

  private drawMist(): void {
    const A = this.arena
    const t = this.now
    // Banks behind the plane, a low band across the floor and a thin veil in front.
    const sheets: [number, number, number, number, number, number][] = [
      [A.w * 0.5, A.h * 0.55, -9, A.w * 0.9, 5.5, 0.55],
      [A.w * 0.3, A.h * 0.25, -4, A.w * 0.6, 3.2, 0.5],
      [A.w * 0.75, A.h * 0.7, -3, A.w * 0.5, 2.6, 0.4],
      [A.w * 0.5, 1.5, -0.6, A.w * 0.9, 2.4, 0.5],
    ]
    for (const [i, [x, y, z, hw, hh, a]] of sheets.entries()) {
      this.mist.push(x + Math.sin(t * 0.05 + i) * 1.5, y, z, hw, hh, 0, Q.mist, [1.05, 1.05, 1.08], a, 0, i * 0.37 + 0.1)
    }
  }

  /** Live archers' interpolated head positions in CSS pixels, for name tags. */
  heads(w: number, h: number): { id: string; x: number; y: number; slot: number; name: string; bot: boolean }[] {
    const out: { id: string; x: number; y: number; slot: number; name: string; bot: boolean }[] = []
    for (const a of this.world.s.archers) {
      if (!a.alive) continue
      const p = this.lerpPos(a)
      const s = this.cam.project(p.x, p.y + HH + 0.55, 0, w, h)
      out.push({ id: a.id, x: s.x, y: s.y, slot: a.slot, name: a.name, bot: a.bot })
    }
    return out
  }
}

export type { Arrow }
