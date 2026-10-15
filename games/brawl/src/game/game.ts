import { glow, hit as flinch, swing } from "@arcade/kit/avatar/anim"
import { Camera, HitStop } from "@arcade/kit/client/camera"
import type { Input } from "@arcade/kit/client/input"
import { Smoothed } from "@arcade/kit/client/smooth"
import type { Mesh } from "@arcade/kit/gpu/mesh"
import type { FrameInput, Renderer } from "@arcade/kit/gpu/renderer"
import { SceneLights, type Caster, type SceneLight, newSceneFrame, packSceneFrame } from "@arcade/kit/gpu/scene-frame"
import { SnapshotBuffer, lerp, lerpAngle } from "@arcade/kit/net/interpolate"
import { Predictor } from "@arcade/kit/net/prediction"
import { Flock } from "@arcade/kit/sim/boids"
import type { Rect } from "@arcade/kit/sim/geom"
import { stepBody } from "@arcade/kit/sim/move"
import { BLOCKS, CENTER, PROP_KINDS, ROPES, SOLIDS, STAGE, STAGE_SIZE } from "../../shared/arena"
import { CHARACTERS, ROSTER, type CharacterDef } from "../../shared/characters"
import { DT, FEEL, PLAYER_RADIUS } from "../../shared/config"
import { F, type FighterView, type RosterRow, type Snapshot } from "../../shared/view"
import type { Intent, SimEvent } from "../../shared/world"
import type { Session } from "../session"
import type { Sound } from "../sound"
import { abilityMeshes } from "../render/ability-meshes"
import { ARENA_THEMES, type ArenaThemeId, DEFAULT_ARENA_THEME, PIT_Y, arenaLevel, propMeshes } from "../render/arena-mesh"
import { FrameParts, SPRITE } from "../render/frame-parts"
import { FighterDraw, type FighterModels, carryReach, castReach, drawFighter, registerFighters } from "./fighters"
import { Fx } from "./fx"

type Rgb = readonly [number, number, number]

/** Player slot colours: the ring under each fighter, their HUD card and their accent bands. */
export const SLOT_COLORS: Rgb[] = [[1, 0.25, 0.45], [0.2, 0.62, 1], [1, 0.82, 0.15], [0.3, 0.86, 0.38], [0.72, 0.4, 1], [1, 0.55, 0.15], [0.2, 0.9, 0.85], [0.95, 0.95, 0.95]]

type Body = { x: number; y: number; vx: number; vy: number }
type Shown = FighterView & { draw: FighterDraw }

const has = (f: FighterView, flag: number) => (f.f & flag) !== 0

/**
 * The client half of a match: interpolates everyone else from snapshots, predicts your own walking, turns events into
 * effects and sound, and builds each frame for the kit renderer.
 */
export class Game {
  snap: Snapshot | null = null
  roster: RosterRow[] = []
  readonly fx = new Fx()
  readonly hitStop = new HitStop()
  readonly cam: Camera
  private buf = new SnapshotBuffer<Snapshot>(0.1)
  private lastAt = -1
  private fighters = new Map<string, FighterDraw>()
  private decoys = new Map<number, FighterDraw>()
  private shown: Shown[] = []
  private fighterModels: Record<string, FighterModels>
  private propModels: Record<string, number> = {}
  private abModels: Record<string, number> = {}
  private fp = new FrameParts()
  private lights = new SceneLights()
  private frame = newSceneFrame()
  private predictor = new Predictor<Intent>()
  private body: Body | null = null
  private smoothed = new Smoothed()
  /** Where you were drawn when prediction switched on or off, and the offset blending that jump out. */
  private handoffFrom: { x: number; y: number } | null = null
  private blend = { x: 0, y: 0 }
  private predicting = false
  private acc = 0
  private queued = -1
  private walk: Rect[] = [...SOLIDS, ...ROPES]
  /** Local clock (s) for animation and effects. */
  now = 0
  cursor = { ...CENTER }
  /** Fixed camera distance (automation close-ups), or null to frame the fighters. */
  zoom: number | null = null
  theme: ArenaThemeId = DEFAULT_ARENA_THEME
  aim = 0
  /** Damage flash on the screen edge, from your own hits. */
  private hurt = 0
  /** Popups the HUD draws: damage numbers and KO calls. */
  popups: { x: number; y: number; text: string; t0: number; color: Rgb; big?: boolean }[] = []
  /** Most recent KO for the HUD banner callout. */
  lastKo: { victim: string; by: string; stocks: number; at: number } | null = null
  private fallingProps: { kind: string; x: number; y: number; h: number; vx: number; vy: number; z: number; vz: number; t0: number }[] = []
  private lastProps = new Map<number, [number, string, number, number, number, number]>()

  constructor(readonly renderer: Renderer, readonly session: Session, readonly sound: Sound, theme: ArenaThemeId = DEFAULT_ARENA_THEME) {
    this.cam = new Camera()
    this.cam.snap(CENTER.x, CENTER.y)
    this.setTheme(theme)
    this.lights.setBoxes(BLOCKS)
    const add = (m: Mesh) => renderer.addModel(m)
    this.fighterModels = registerFighters(add)
    for (const [k, m] of Object.entries(propMeshes())) this.propModels[k] = add(m)
    for (const [k, m] of Object.entries(abilityMeshes())) this.abModels[k] = add(m)
  }

  setTheme(theme: ArenaThemeId): void {
    const t = ARENA_THEMES[theme] ? theme : DEFAULT_ARENA_THEME
    this.theme = t
    this.renderer.setLevel(arenaLevel(7, t))
    this.renderer.setLook(ARENA_THEMES[t].look())
  }

  get myId(): string {
    return this.session.myId
  }

  get me(): FighterView | null {
    return this.snap?.f.find((f) => f.i === this.myId) ?? null
  }

  /** Where you are drawn (predicted), or null when you aren't on stage. */
  get drawnMe(): { x: number; y: number } | null {
    return this.shown.find((s) => s.i === this.myId) ?? null
  }

  /** Where a fighter is drawn this frame. */
  drawnOf(id: string): { x: number; y: number } | null {
    return this.shown.find((s) => s.i === id) ?? null
  }

  slotOf(id: string): number {
    return this.roster.find((r) => r.id === id)?.slot ?? 0
  }

  colorOf(id: string): Rgb {
    return SLOT_COLORS[this.slotOf(id) % SLOT_COLORS.length]!
  }

  def(char: string): CharacterDef {
    return CHARACTERS[char] ?? ROSTER[0]!
  }

  /** A cast to send on the next tick (0 left mouse, 1 Q, 2 E, 3 Space). */
  press(slot: number): void {
    this.queued = slot
  }

  // Simulation side -------------------------------------------------------------------------------------------------

  update(dt: number, input: Input, w: number, h: number): void {
    this.session.update(dt)
    const now = performance.now() / 1000
    const latest = this.session.latest()
    if (latest && latest.at !== this.lastAt) {
      this.lastAt = latest.at
      const prevPhase = this.snap?.phase
      this.snap = latest.snap
      this.buf.push(latest.snap.t, latest.snap, now)
      if (prevPhase && prevPhase !== latest.snap.phase) this.buf.clear()
      this.reconcile(latest.snap)
    }
    this.roster = this.session.roster()
    for (const e of this.session.drainEvents()) this.event(e)

    const mouse = this.cam.unproject(input.mouse.x, input.mouse.y, w, h, 0)
    this.cursor = { x: mouse.x, y: mouse.y }
    const me = this.drawnMe
    if (me) this.aim = Math.atan2(this.cursor.y - me.y, this.cursor.x - me.x)

    this.acc = Math.min(this.acc + dt, DT * 5)
    while (this.acc >= DT) {
      this.acc -= DT
      this.tick(input)
    }
    this.smoothed.update(this.body ?? { x: 0, y: 0 }, this.acc / DT, dt)
  }

  private get play(): boolean {
    return this.snap?.phase === "play" && this.snap.go <= 0
  }

  private tick(input: Input): void {
    if (!this.myId) return
    const { mx, my } = input.move()
    let cast = this.queued
    this.queued = -1
    if (cast < 0 && input.takeFirePress()) cast = 0
    // Holding the left button keeps swinging as the cooldown allows.
    if (cast < 0 && input.firing && (this.snap?.you?.cd[0] ?? 1) <= 0.05) cast = 0
    if (!this.play) cast = -1
    if (cast >= 0 && (this.snap?.you?.cd[cast] ?? 0) <= 0.05) {
      const d = this.fighters.get(this.myId)
      const me = this.me
      if (d && me && d.castSlot !== cast) {
        d.castSlot = cast
        d.castAt = this.now
        const ab = this.def(me.c).abilities[cast]
        if (ab?.effects[0]?.kind === "melee") swing(d.a, d.a.t)
      }
    }
    const i: Intent = { mx, my, aim: this.aim, tx: this.cursor.x, ty: this.cursor.y, cast }
    const seq = this.predictor.record(i) + 1
    this.session.send({ type: "intent", seq, i })
    if (this.predicting && this.body) {
      this.smoothed.tick(this.body)
      this.step(this.body, i)
    }
  }

  /** The server's walking rule (`World.stepPlay`), replayed locally for your own fighter. */
  private step(b: Body, i: Intent): void {
    const you = this.snap?.you
    const f = this.me
    if (!you || !f) return
    const d = this.def(f.c)
    stepBody(b, you.move ? i.mx : 0, you.move ? i.my : 0, d.speed * FEEL.moveScale * you.speed, this.walk, DT, PLAYER_RADIUS, FEEL.accel * d.accel * you.accel)
  }

  private reconcile(s: Snapshot): void {
    this.walk = [...SOLIDS, ...ROPES]
    for (const p of s.p) {
      const def = PROP_KINDS[p[1]]
      if (!def?.heavy || p[5] > 0.4) continue
      const c = Math.abs(Math.cos(p[4])), sn = Math.abs(Math.sin(p[4]))
      const ex = def.hl * c + def.hw * sn, ey = def.hl * sn + def.hw * c
      this.walk.push([p[2] - ex, p[3] - ey, p[2] + ex, p[3] + ey])
    }
    const f = s.f.find((q) => q.i === this.myId)
    const can = !!f && !!s.you?.move && has(f, F.alive) && s.phase === "play" && s.go <= 0
    if (!f || !can) {
      this.predictor.reconcile(s.ack - 1, () => {}, () => {})
      if (this.predicting) this.handoff()
      this.predicting = false
      this.body = f ? { x: f.x, y: f.y, vx: f.vx, vy: f.vy } : null
      return
    }
    if (!this.predicting || !this.body) {
      this.handoff()
      this.body = { x: f.x, y: f.y, vx: f.vx, vy: f.vy }
      this.smoothed.reset(this.body)
      this.predicting = true
    }
    const b = this.body
    const bx = b.x, by = b.y
    this.predictor.reconcile(s.ack - 1, () => Object.assign(b, { x: f.x, y: f.y, vx: f.vx, vy: f.vy }), (cmd) => this.step(b, cmd))
    if (Math.hypot(b.x - bx, b.y - by) > 2) this.smoothed.reset(b)
    else this.smoothed.correct(b.x - bx, b.y - by)
  }

  /** Switching between predicted and server-driven drawing: keep you where you were on screen and blend. */
  private handoff(): void {
    const d = this.drawnMe
    this.handoffFrom = d ? { x: d.x, y: d.y } : null
  }

  // Events ------------------------------------------------------------------------------------------------------------

  private fighterAt(id: string): { x: number; y: number } | null {
    return this.shown.find((s) => s.i === id) ?? this.snap?.f.find((f) => f.i === id) ?? null
  }

  private event(e: SimEvent): void {
    const t = this.now
    const fx = this.fx
    const snd = this.sound
    switch (e.k) {
      case "cast": {
        const f = this.snap?.f.find((q) => q.i === e.by)
        const def = f ? this.def(f.c).abilities[e.slot] : undefined
        const kind = def?.effects[0]?.kind
        if (kind === "melee") snd.play(e.slot === 0 && f?.c === "slab" ? "melee.swing.heavy" : "melee.swing.light", e.x, e.y)
        else if (kind === "dash") snd.play("melee.swing.heavy", e.x, e.y, { rate: 0.8 })
        else snd.play("spell_arcane_cast", e.x, e.y, { gain: 0.5 })
        break
      }
      case "melee":
        fx.swipe(t, e.x, e.y, e.aim, e.range, [2, 2, 2.2])
        break
      case "burst": {
        if (e.look === "fire") {
          fx.fire(e.x, e.y, e.r, 40)
          fx.light(t, e.x, e.y, 1.2, 9, [1, 0.5, 0.15], 4, 0.6)
          fx.ring(t, e.x, e.y, e.r * 1.1, [3, 1.2, 0.3], 0.3)
          snd.play("impact_crash_layered", e.x, e.y, { gain: 0.35, rate: 1.4 })
          snd.play("cooking.sizzle", e.x, e.y, { gain: 0.7, rate: 0.85 })
        } else if (e.look === "applause") {
          fx.confetti(e.x, e.y, 1, 70, 7)
          fx.ring(t, e.x, e.y, e.r, [3, 2.6, 1], 0.4)
          fx.ring(t + 0.05, e.x, e.y, e.r * 0.7, [2.6, 1.4, 2.4], 0.35)
          snd.play("crowd.applause", e.x, e.y)
          snd.play("door.bash", e.x, e.y, { gain: 0.5, rate: 1.3 })
        } else {
          fx.dust(e.x, e.y, 16, e.r)
          fx.ring(t, e.x, e.y, e.r, [2.4, 2.2, 2], 0.35, true)
          snd.play("door.bash", e.x, e.y)
          this.shakeNear(e.x, e.y, 0.35)
        }
        break
      }
      case "proj-end": {
        if (e.look === "pan") {
          fx.sparks(e.x, e.y, 0.5, 14)
          snd.play("impact.bullet.metal", e.x, e.y)
          snd.play("cooking.sizzle", e.x, e.y)
        } else if (e.look === "seed") {
          fx.leaves(e.x, e.y, 14)
          fx.dust(e.x, e.y, 6, 0.5)
          snd.play("item.drop", e.x, e.y)
        } else if (e.look === "switch") fx.poof(t, e.x, e.y, [0.7, 0.45, 1], 0.8)
        else if (e.look === "vine") fx.leaves(e.x, e.y, 8)
        else if (e.hit) fx.sparks(e.x, e.y, 0.9, 5, 3)
        break
      }
      case "swap": {
        for (const id of [e.a, e.b]) {
          const p = this.fighterAt(id)
          if (p) fx.poof(t, p.x, p.y, [0.75, 0.5, 1])
        }
        snd.play("spell_arcane_cast", undefined, undefined, { rate: 1.3 })
        break
      }
      case "blink":
        fx.poof(t, e.x0, e.y0, [0.7, 0.45, 1])
        fx.poof(t + 0.02, e.x1, e.y1, [0.7, 0.45, 1], 0.7)
        snd.play("spell_arcane_cast", e.x1, e.y1, { rate: 1.5, gain: 0.6 })
        break
      case "grab":
        snd.play("melee.shove", this.fighterAt(e.by)?.x, this.fighterAt(e.by)?.y)
        break
      case "throw":
        snd.play("melee.swing.heavy", this.fighterAt(e.by)?.x, this.fighterAt(e.by)?.y, { rate: 0.7 })
        break
      case "pop":
      case "scatter": {
        const fl = this.fx.flocks.get(e.id)
        if (fl) fl.scatter = 1
        break
      }
      case "ab-hit":
        break
      case "prop-hit":
        if (e.v > 3) snd.play("item.drop", e.x, e.y, { gain: Math.min(1, e.v / 10) })
        if (e.v > 6) fx.dust(e.x, e.y, 4, 0.4)
        break
      case "prop-break":
        fx.chips(e.x, e.y, e.kind === "crate" ? 18 : 10)
        fx.dust(e.x, e.y, 8, 0.6)
        snd.play("melee.break", e.x, e.y)
        break
      case "prop-boom":
        fx.explode(t, e.x, e.y)
        snd.play("impact_crash_layered", e.x, e.y)
        this.shakeNear(e.x, e.y, 0.8)
        this.hitStop.trigger(0.06, 0.1)
        break
      case "hit": {
        const target = this.fighters.get(e.target)
        const by = this.fighterAt(e.by)
        const dx = by ? e.x - by.x : 0, dy = by ? e.y - by.y : 0
        if (target) {
          flinch(target.a, dx, dy, Math.min(2.2, 0.55 + e.speed / 7))
          target.a.flash = Math.min(0.75, 0.3 + e.speed / 32)
        }
        const strong = e.speed > 7.5
        const col = this.colorOf(e.by)
        fx.sparks(e.x, e.y, 1, strong ? 22 : 10, strong ? 10 : 6.5)
        fx.flash(t, e.x, e.y, 1, strong ? 1.85 : 1.05, [4, 3.5, 2.2], 0.14)
        fx.ring(t, e.x, e.y, strong ? 1.65 : 0.95, strong ? [3.2, 3, 2.6] : [col[0] * 2.5, col[1] * 2.5, col[2] * 2.5], strong ? 0.26 : 0.18, strong)
        if (strong) fx.light(t, e.x, e.y, 1.3, 6.5, col, 2.8, 0.2)
        this.popups.push({ x: e.x, y: e.y, text: `+${Math.round(e.damage)}%`, t0: t, color: col })
        snd.play(strong ? "melee.hit.metal" : "melee.hit.wood", e.x, e.y, { gain: Math.min(1, 0.45 + e.speed / 13) })
        const hitAng = Math.atan2(dy, dx)
        if (e.target === this.myId) {
          this.hurt = Math.min(1, this.hurt + 0.28 + e.speed / 26)
          this.cam.add((0.24 + e.speed / 32) * FEEL.shakeScale, hitAng)
          snd.play("body.hurt", e.x, e.y, { gain: 0.65 })
        } else if (e.by === this.myId) {
          this.cam.add((0.14 + e.speed / 45) * FEEL.shakeScale, hitAng, 0.45)
        } else {
          this.shakeNear(e.x, e.y, (0.08 + e.speed / 80) * FEEL.shakeScale)
        }
        if (e.speed > 10.5) this.cam.punch(0.28 * FEEL.shakeScale, 0.008)
        if (e.speed > 5) this.hitStop.trigger(Math.min(0.11, (0.022 + e.speed / 220) * FEEL.hitStopScale), 0.06)
        break
      }
      case "ko": {
        const dir = Math.atan2(e.y - (STAGE[1] + STAGE[3]) / 2, e.x - (STAGE[0] + STAGE[2]) / 2)
        fx.ko(t, e.x, e.y, dir + Math.PI, this.colorOf(e.victim))
        snd.play("impact_crash_layered", e.x, e.y, { gain: 0.95 })
        snd.play("ui_confirm", undefined, undefined, { rate: 0.75 })
        this.cam.add(0.75 * FEEL.shakeScale, dir)
        this.cam.punch(0.85 * FEEL.shakeScale, 0.014)
        this.hitStop.trigger(0.12 * FEEL.hitStopScale, 0.04)
        const victim = this.roster.find((r) => r.id === e.victim)
        this.popups.push({ x: e.x, y: e.y, text: e.stocks > 0 ? "RING OUT!" : "ELIMINATED!", t0: t, color: this.colorOf(e.victim), big: true })
        this.lastKo = { victim: e.victim, by: e.by, stocks: e.stocks, at: t }
        if (victim && e.victim === this.myId) this.hurt = 1
        break
      }
      case "spawn":
        fx.ring(t, e.x, e.y, 1.6, [2.5, 2.5, 2.5], 0.5)
        fx.confetti(e.x, e.y, 2.5, 20, 2)
        break
      case "go":
        snd.play("ui.ping")
        break
      case "end":
        snd.play("ui_confirm")
        break
      case "prop-fall": {
        const p = this.lastProps.get(e.id)
        if (p) this.fallingProps.push({ kind: p[1], x: p[2], y: p[3], h: p[4], vx: (e.x - p[2]) * 10, vy: (e.y - p[3]) * 10, z: p[5], vz: 0, t0: t })
        break
      }
    }
  }

  private shakeNear(x: number, y: number, amount: number): void {
    const me = this.drawnMe
    const d = me ? Math.hypot(me.x - x, me.y - y) : 8
    this.cam.add(amount * Math.max(0.25, 1 - d / 18))
  }

  // Presentation side -----------------------------------------------------------------------------------------------

  /** Interpolated fighters this frame, with your own predicted position. */
  private sampleFighters(now: number): Shown[] {
    const br = this.buf.sample(now)
    if (!br) return []
    const out: Shown[] = []
    for (const b of br.b.f) {
      const a = br.a.f.find((q) => q.i === b.i) ?? b
      const jump = Math.hypot(b.x - a.x, b.y - a.y) > 3
      const k = jump ? 1 : br.t
      let x = lerp(a.x, b.x, k), y = lerp(a.y, b.y, k)
      if (b.i === this.myId && this.predicting && this.body) {
        x = this.smoothed.x
        y = this.smoothed.y
      }
      let draw = this.fighters.get(b.i)
      const scale = this.fighterModels[b.c]?.scale ?? 1
      if (!draw || draw.char !== b.c) this.fighters.set(b.i, (draw = new FighterDraw(b.i, b.c, x, y, b.a, scale)))
      out.push({ ...b, x, y, vx: lerp(a.vx, b.vx, k), vy: lerp(a.vy, b.vy, k), a: b.i === this.myId && this.predicting ? this.aim : lerpAngle(a.a, b.a, k), draw })
    }
    // Your own handoff (prediction on or off) blends out instead of jumping.
    const mine = out.find((s) => s.i === this.myId)
    if (mine && this.handoffFrom) {
      const ox = this.handoffFrom.x - mine.x, oy = this.handoffFrom.y - mine.y
      this.blend = Math.hypot(ox, oy) < 3 ? { x: ox, y: oy } : { x: 0, y: 0 }
    }
    this.handoffFrom = null
    if (mine) {
      mine.x += this.blend.x
      mine.y += this.blend.y
    }
    return out
  }

  /** Camera: frames everyone on stage, leaning toward you and your cursor. */
  frameCamera(dt: number, w: number, h: number): void {
    const live = this.shown.filter((s) => has(s, F.alive) && !has(s, F.falling))
    let x0 = STAGE[2], y0 = STAGE[3], x1 = STAGE[0], y1 = STAGE[1]
    for (const s of live) {
      x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y)
    }
    if (!live.length) [x0, y0, x1, y1] = STAGE
    let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    const me = this.drawnMe
    const mine = this.shown.find((s) => s.i === this.myId)
    if (me && mine && has(mine, F.alive)) {
      cx = cx * 0.45 + me.x * 0.55
      cy = cy * 0.45 + me.y * 0.55
    }
    // The ground the view covers is about 0.6 × distance tall at this pitch.
    const aspect = w / Math.max(1, h)
    const span = Math.max((x1 - x0 + 5.6) / aspect, y1 - y0 + 4.8)
    const want = Math.max(14.5, Math.min(26.5, (span * 1.28) / Math.max(0.7, FEEL.camTightness)))
    this.cam.zoomOffset = (this.zoom ?? want) - 24
    const lean = me && mine && has(mine, F.alive)
    this.cam.follow(cx, cy + 0.85, lean ? (this.cursor.x - me!.x) * 0.16 : 0, lean ? (this.cursor.y - me!.y) * 0.13 : 0, dt, false)
  }

  build(w: number, h: number, dt: number): FrameInput {
    this.now += dt
    const t = this.now
    const adt = this.hitStop.step(dt)
    const fp = this.fp
    fp.begin()
    this.shown = this.sampleFighters(performance.now() / 1000)
    const kb = Math.exp(-dt * 10)
    this.blend.x *= kb
    this.blend.y *= kb
    this.frameCamera(dt, w, h)
    const vp = this.cam.update(w / h)
    const view = this.cam.groundRect()
    const snap = this.snap
    const casters: Caster[] = []
    const moving: { rect: Rect; h: number }[] = []

    // Fighters.
    for (const s of this.shown) this.drawShown(s, adt, t, casters)
    for (const [id, d] of this.fighters) if (!this.shown.some((s) => s.i === id)) this.fighters.delete(id)

    // Props.
    const br = this.buf.sample(performance.now() / 1000)
    if (br) {
      this.lastProps.clear()
      for (const p of br.b.p) {
        const a = br.a.p.find((q) => q[0] === p[0]) ?? p
        const x = lerp(a[2], p[2], br.t), y = lerp(a[3], p[3], br.t), hd = lerpAngle(a[4], p[4], br.t), z = lerp(a[5], p[5], br.t)
        this.lastProps.set(p[0], [p[0], p[1], x, y, hd, z])
        const model = this.propModels[p[1]]
        if (model === undefined) continue
        const spin = z > 0.05 ? z * 1.5 : 0
        fp.push(model, x, z, y, hd, [1, 1, 1], 0, spin, 0)
        const def = PROP_KINDS[p[1]]!
        if (z < 0.4) {
          const c = Math.abs(Math.cos(hd)), sn = Math.abs(Math.sin(hd))
          const ex = def.hl * c + def.hw * sn, ey = def.hl * sn + def.hw * c
          moving.push({ rect: [x - ex, y - ey, x + ex, y + ey], h: def.height })
        }
        fp.sprite(false, x, 0.02, y, Math.max(def.hl, def.hw) * 1.25, 0.15, 0.08, 0.2, z > 0.05 ? 0.25 : 0.35, SPRITE.disc)
      }
      this.drawAbilities(br.a, br.b, br.t, t, adt)
    }
    this.fallingProps = this.fallingProps.filter((p) => t - p.t0 < 1.4)
    for (const p of this.fallingProps) {
      p.vz -= 18 * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      const model = this.propModels[p.kind]
      if (model !== undefined) fp.push(model, p.x, p.z, p.y, p.h + (t - p.t0) * 2, [1, 1, 1], (t - p.t0) * 3, 0, 0)
    }

    this.fx.step(adt)
    this.fx.draw(fp, t)

    // Your aim: a short dashed line to the cursor while you can act.
    const mine = this.shown.find((s) => s.i === this.myId)
    if (mine && has(mine, F.alive) && !has(mine, F.falling) && snap?.phase === "play") {
      const d = Math.min(3, Math.hypot(this.cursor.x - mine.x, this.cursor.y - mine.y))
      const c = glow(this.colorOf(this.myId), 2.2)
      fp.sprite(true, mine.x + Math.cos(this.aim) * (0.6 + d / 2), 0.04, mine.y + Math.sin(this.aim) * (0.6 + d / 2), d / 2, c[0], c[1], c[2], 0.5, SPRITE.line, this.aim, 0.05, 8)
      fp.sprite(true, this.cursor.x, 0.04, this.cursor.y, 0.25, c[0], c[1], c[2], 0.8, SPRITE.ring, t, 0.2)
    }

    const palette = ARENA_THEMES[this.theme] ?? ARENA_THEMES.spotlit_ring
    const sceneLights: SceneLight[] = [...palette.lights]
    if (palette.fighterRimPower > 0) {
      for (const s of this.shown) {
        if (!has(s, F.alive) || has(s, F.falling)) continue
        const col = this.colorOf(s.i)
        sceneLights.push({
          x: s.x,
          y: s.y - 0.3,
          h: 2.0,
          r: 3.4,
          color: [0.35 + col[0] * 0.65, 0.35 + col[1] * 0.65, 0.35 + col[2] * 0.65],
          power: palette.fighterRimPower * (s.i === this.myId ? 1.25 : 1),
          size: 0.4,
          unshadowed: true,
        })
      }
    }
    this.fx.lights(t, sceneLights)
    for (const z of snap?.ab.z ?? []) if (z[1] === "fire") sceneLights.push({ x: z[3], y: z[4], h: 1, r: 5, color: [1, 0.5, 0.2], power: 1.5, size: 0.4 })
    this.lights.update(sceneLights, casters, moving)
    packSceneFrame(this.frame, {
      viewProj: vp as Float32Array,
      eye: this.cam.eye,
      time: t,
      width: this.renderer.width,
      height: this.renderer.height,
      lightCount: this.lights.lightCount,
      ambient: palette.ambient,
      mapSize: STAGE_SIZE,
      ao: palette.ao,
    })
    this.hurt *= Math.exp(-dt * 4)
    const L = this.lights
    return {
      frame: this.frame as Float32Array<ArrayBuffer>,
      fxParticles: this.fx.particles,
      lights: L.lights as Float32Array<ArrayBuffer>,
      lightCount: L.lightCount,
      shadowLightCount: L.shadowLightCount,
      occluders: L.occ as Float32Array<ArrayBuffer>,
      occluderCount: L.occCount,
      lampPower: L.power as Float32Array<ArrayBuffer>,
      lampCount: 0,
      view,
      batches: fp.batches(),
      alphaSprites: fp.alpha as Float32Array<ArrayBuffer>,
      alphaCount: fp.nAlpha,
      addSprites: fp.add as Float32Array<ArrayBuffer>,
      addCount: fp.nAdd,
      grade: [t, 0, this.hurt * 0.6, 1],
    }
  }

  private drawShown(s: Shown, adt: number, t: number, casters: Caster[]): void {
    const d = s.draw
    const m = this.fighterModels[s.c]
    if (!m || !has(s, F.alive)) {
      d.fallAt = 0
      return
    }
    const fp = this.fp
    const def = this.def(s.c)
    const color = this.colorOf(s.i)
    // Casts: restart the arm pose when a new one shows up.
    if (s.k) {
      if (d.castSlot !== s.k[0] || Math.abs(t - s.k[1] - d.castAt) > 0.25) {
        d.castSlot = s.k[0]
        d.castAt = t - s.k[1]
        const ab = def.abilities[s.k[0]]
        if (ab?.effects[0]?.kind === "melee") swing(d.a, d.a.t)
      }
    }
    const ab = d.castSlot >= 0 ? def.abilities[d.castSlot] : undefined
    const dashing = has(s, F.dashing)
    d.a.reach = has(s, F.carrying) ? carryReach() : ab ? castReach(ab, t - d.castAt, dashing ? 0.2 : 0) : undefined
    if (!d.a.reach && !s.k) d.castSlot = -1
    // Falling off the stage: drop into the pit, spinning.
    let lift = 0
    if (has(s, F.falling)) {
      if (!d.fallAt) d.fallAt = t
      const ft = t - d.fallAt
      lift = Math.max(PIT_Y, -9 * ft * ft)
    } else d.fallAt = 0
    const launched = has(s, F.launched)
    d.tumble += ((launched || d.fallAt ? 1 : 0) - d.tumble) * (1 - Math.exp(-adt * (launched ? 14 : 6)))
    const sp = Math.hypot(s.vx, s.vy)
    if (d.fallAt) d.spin += adt * 9
    else d.spin = 0
    let turn: { axis: [number, number, number]; angle: number } | undefined
    if (has(s, F.carried)) {
      lift = 1.15
      turn = { axis: [-Math.sin(s.a), 0, Math.cos(s.a)], angle: Math.PI / 2 }
    } else if (d.tumble > 0.01 && sp > 0.1) {
      // Flying: the body tips back along the flight, and keeps tumbling over the edge.
      const ux = s.vx / sp, uy = s.vy / sp
      turn = { axis: [-uy, 0, ux], angle: -d.tumble * (0.9 + d.spin) }
    }
    if ((launched || d.fallAt > 0) && sp > 5 && adt > 0) {
      this.fx.launchTrail(t, s.x, s.y, s.vx, s.vy, color)
    }
    // Just respawned: a soft pulsing shine while nothing can hit you.
    if (has(s, F.invuln)) d.a.flash = Math.max(d.a.flash, 0.12 + 0.1 * Math.sin(t * 18))
    drawFighter(fp, m, d, adt, t, s.x, s.y, s.vx, s.vy, s.a, { lift, turn, alpha: 1, color })
    if (lift < -0.5) return
    casters.push({ x: s.x, y: s.y, r: 0.22 * m.scale, h: 1.75 * m.scale })
    const gc = glow(color, s.i === this.myId ? 2.4 : 1.6)
    fp.sprite(true, s.x, 0.03, s.y, 0.55 * m.scale, gc[0], gc[1], gc[2], 0.95, SPRITE.ring, 0, 0.16)
    fp.sprite(false, s.x, 0.015, s.y, 0.42 * m.scale, 0.12, 0.05, 0.18, 0.35, SPRITE.disc)
    const head = 1.95 * m.scale + lift
    if (has(s, F.stunned) && !has(s, F.carried)) this.fx.stars(fp, t, s.x, s.y, head)
    if (has(s, F.shield)) fp.sprite(true, s.x, 1, s.y, 1.1 * m.scale, 0.6, 0.9, 1.4, 0.35, SPRITE.glow)
    if (has(s, F.rooted)) fp.push(this.abModels.vine!, s.x, 0, s.y, t * 0.3, [1, 1, 1], 0, 0, 0)
    if (has(s, F.haste) || dashing) {
      const c = glow(def.color, 2)
      for (let i = 1; i <= 4; i++) fp.sprite(true, s.x - s.vx * i * 0.03, 0.9, s.y - s.vy * i * 0.03, 0.4 - i * 0.06, c[0], c[1], c[2], 0.35, SPRITE.glow)
    }
  }

  /** Projectiles, swarms, zones and decoys, interpolated between two snapshots. */
  private drawAbilities(a: Snapshot, b: Snapshot, k: number, t: number, adt: number): void {
    const fp = this.fp
    for (const p of b.ab.p) {
      const q = a.ab.p.find((r) => r[0] === p[0]) ?? p
      const x = lerp(q[3], p[3], k), y = lerp(q[4], p[4], k), z = lerp(q[5], p[5], k)
      const dir = Math.atan2(p[4] - q[4], p[3] - q[3])
      switch (p[1]) {
        case "card":
          fp.push(this.abModels.card!, x, 0.9 + z, y, t * 25 + p[0], [1, 1, 1], 0, 0, 0)
          break
        case "switch":
          fp.push(this.abModels.swap!, x, 0.9 + z, y, t * 12, [1, 1, 1], 0, 0, 0)
          fp.sprite(true, x, 0.9 + z, y, 0.8, 1.6, 0.9, 3, 0.8, SPRITE.glow)
          break
        case "pan":
          fp.push(this.abModels.pan!, x, 0.8 + z, y, t * 14, [1, 1, 1], 0, 0, 0)
          fp.sprite(false, x, 0.02, y, 0.35, 0.1, 0.05, 0.15, 0.3, SPRITE.disc)
          if (this.fx.random() < 0.5) this.fx.sparks(x, y, 0.85, 1, 1)
          break
        case "seed":
          fp.push(this.abModels.seed!, x, 0.4 + z, y, t * 8, [1, 1, 1], t * 6, 0, 0)
          fp.sprite(false, x, 0.02, y, 0.3, 0.1, 0.05, 0.15, 0.3, SPRITE.disc)
          break
        case "vine":
          fp.push(this.abModels.vine!, x, 0, y, dir + t * 4, [1, 1, 1], 0, 0, 0)
          if (this.fx.random() < 0.3) this.fx.leaves(x, y, 1)
          break
        default:
          fp.sprite(true, x, 0.9 + z, y, 0.4, 3, 3, 3, 1, SPRITE.glow)
      }
    }
    // Swarms: one entity on the server, a flock of bees here.
    const seen = new Set<number>()
    for (const s of b.ab.s) {
      const q = a.ab.s.find((r) => r[0] === s[0]) ?? s
      const x = lerp(q[3], s[3], k), y = lerp(q[4], s[4], k)
      seen.add(s[0])
      let fl = this.fx.flocks.get(s[0])
      if (!fl) {
        fl = { flock: new Flock(s[6], s[0] * 7919, x, 1.4, y, 0.8), seen: t, scatter: 0, x, y, vx: 0, vy: 0 }
        this.fx.flocks.set(s[0], fl)
      }
      fl.vx = adt > 0 ? (x - fl.x) / adt : 0
      fl.vy = adt > 0 ? (y - fl.y) / adt : 0
      fl.x = x
      fl.y = y
      fl.seen = t
      fl.flock.step(adt, s[5], x, 1.2, y, fl.vx, fl.vy, 0.75)
    }
    for (const [id, fl] of this.fx.flocks) {
      if (!seen.has(id)) {
        fl.scatter = Math.min(1, fl.scatter + adt * 2)
        fl.flock.step(adt, fl.flock.size, fl.x, 1.2, fl.y, 0, 0, 0.75, fl.scatter)
        if (t - fl.seen > 1.2) {
          this.fx.flocks.delete(id)
          continue
        }
      }
      const f = fl.flock
      const n = seen.has(id) ? Math.min(f.size, b.ab.s.find((r) => r[0] === id)?.[5] ?? 0) : f.size
      for (let i = 0; i < n; i++) {
        const yaw = Math.atan2(f.vz[i]!, f.vx[i]!)
        fp.push(this.abModels.bee!, f.x[i]!, f.y[i]!, f.z[i]!, yaw, [1, 1, 1], Math.sin(t * 40 + i) * 0.3, 0, 0, seen.has(id) ? 1 : 1 - fl.scatter * 0.8)
      }
      if (seen.has(id) && this.fx.random() < adt * 1.2) this.sound.play("creature.bees.swarm", fl.x, fl.y, { gain: 0.6 })
    }
    // Zones.
    for (const z of b.ab.z) {
      const [id, look, , x, y, r, age, life] = z
      const fadeIn = Math.min(1, age / 0.25)
      const fadeOut = Math.min(1, (life - age) / 0.6)
      const vis = Math.max(0, Math.min(fadeIn, fadeOut))
      switch (look) {
        case "grease":
          fp.sprite(false, x, 0.012, y, r, 0.55, 0.28, 0.05, 0.82 * vis, SPRITE.disc)
          fp.sprite(false, x + r * 0.2, 0.013, y - r * 0.15, r * 0.55, 0.85, 0.5, 0.1, 0.6 * vis, SPRITE.disc)
          fp.sprite(true, x - r * 0.25, 0.02, y + r * 0.2, r * 0.3, 0.6, 0.4, 0.15, 0.4 * vis, SPRITE.glow)
          break
        case "ice":
          fp.sprite(false, x, 0.011, y, r, 0.38, 0.72, 1, 0.42 * vis, SPRITE.disc)
          fp.sprite(true, x, 0.02, y, r, 0.6, 0.9, 1.3, 0.35 * vis, SPRITE.ring, 0, 0.06)
          if (this.fx.random() < adt * 2 * r) {
            const a2 = this.fx.random() * Math.PI * 2, rr = Math.sqrt(this.fx.random()) * r
            this.fx.flash(t, x + Math.cos(a2) * rr, y + Math.sin(a2) * rr, 0.05, 0.25, [2, 2.5, 3], 0.3)
          }
          break
        case "smoke":
          for (let i = 0; i < 9; i++) {
            const a2 = i * 2.4 + id
            const rr = r * (0.25 + 0.6 * ((i * 37) % 10) / 10)
            const bob = Math.sin(t * 1.3 + i) * 0.15
            const g = 0.62 + (i % 3) * 0.08
            fp.sprite(false, x + Math.cos(a2 + t * 0.2) * rr, 0.6 + bob + (i % 3) * 0.35, y + Math.sin(a2 + t * 0.2) * rr, r * 0.42 * (0.7 + 0.3 * vis), g, g, g + 0.04, 0.8 * vis, SPRITE.puff, 0, 0, a2)
          }
          break
        case "vines": {
          fp.sprite(false, x, 0.012, y, r, 0.18, 0.4, 0.12, 0.7 * vis, SPRITE.disc)
          for (let i = 0; i < 7; i++) {
            const a2 = i * 2.4 + id * 0.7
            const rr = r * (i === 0 ? 0 : 0.35 + 0.5 * ((i * 53) % 10) / 10)
            const grow = Math.min(1, age / 0.4) * vis
            if (grow > 0.05) fp.part(this.abModels.bramble!, x + Math.cos(a2) * rr, 0, y + Math.sin(a2) * rr, a2, [1, 1, 1], 0, 0, 0, 1, 0.35 + 0.4 * grow)
          }
          break
        }
        default:
          fp.sprite(false, x, 0.012, y, r, 1, 0.5, 0.2, 0.4 * vis, SPRITE.disc)
      }
    }
    // Decoys look exactly like the magician.
    const live = new Set<number>()
    for (const dz of b.ab.d) {
      const [id, by, x, y, aim] = dz
      live.add(id)
      const owner = b.f.find((f) => f.i === by)
      const char = owner?.c ?? "presto"
      const m = this.fighterModels[char]
      if (!m) continue
      let d = this.decoys.get(id)
      if (!d) this.decoys.set(id, (d = new FighterDraw(`decoy${id}`, char, x, y, aim, m.scale)))
      drawFighter(fp, m, d, adt, t, x, y, 0, 0, aim, { lift: 0, alpha: 1, color: this.colorOf(by) })
      const gc = glow(this.colorOf(by), 1.6)
      fp.sprite(true, x, 0.03, y, 0.55 * m.scale, gc[0], gc[1], gc[2], 0.95, SPRITE.ring, 0, 0.16)
    }
    for (const [id, d] of this.decoys) {
      if (live.has(id)) continue
      const sc = this.fighterModels[d.char]?.scale ?? 1
      this.fx.poof(t, d.a.x * sc, d.a.y * sc, [0.7, 0.45, 1], 0.8)
      this.decoys.delete(id)
    }
  }
}
