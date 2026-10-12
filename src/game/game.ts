import { DT, MAX_LIGHTS, SPEED, WEAPONS, WINDUP_SPEED, type Weapon } from "../../shared/config"
import { type MapDef, getMap } from "../../shared/maps"
import { Level } from "../../shared/sim/level"
import { FLARE_COLOR, flarePower, lampPower } from "../../shared/sim/light"
import { type Body, stepBody } from "../../shared/sim/move"
import type { OtherView, RosterRow, Snapshot } from "../../shared/sim/view"
import type { Award, Intent, RingKind, SimEvent } from "../../shared/sim/world"
import type { Camera } from "../render/camera"
import { buildGlass, buildLevel } from "../render/level-mesh"
import { buildBolt, buildDecoy, buildDoor, buildFlare, buildMine, personModels } from "../render/models"
import { type Batch, type FrameInput, INST_FLOATS, LIGHT_FLOATS, type Renderer, SPRITE_FLOATS } from "../render/renderer"
import { FRAME_FLOATS } from "../render/shaders"
import type { Input } from "./input"
import type { Session } from "./session"

export type Rgb3 = [number, number, number]
export const TEAM: [Rgb3, Rgb3] = [
  [1.0, 0.38, 0.08],
  [0.08, 0.72, 1.0],
]
const FFA: Rgb3[] = [
  [1.0, 0.38, 0.08],
  [0.08, 0.72, 1.0],
  [0.85, 0.85, 0.2],
  [0.75, 0.3, 1.0],
  [0.3, 1.0, 0.5],
  [1.0, 0.3, 0.55],
  [0.9, 0.9, 0.9],
  [0.4, 0.5, 1.0],
]
export const css = (c: Rgb3) => `rgb(${c.map((v) => Math.round(Math.min(1, v) * 255)).join(",")})`

type Ring = { x: number; y: number; r: number; kind: RingKind; t0: number; mine: boolean }
type Tracer = { x0: number; y0: number; x1: number; y1: number; t0: number }
type Puff = { x: number; y: number; h: number; t0: number; life: number; size: number; rot: number; flare: number }
type Marker = { id: string; t0: number }
export type FeedLine = { killer: string; victim: string; kc: Rgb3; vc: Rgb3; weapon: string; t: number }
export type Killcam = { killer: string; weapon: string; dist: number; t0: number; dx: number; dy: number }

const RING_LIFE = (r: number) => 0.7 + r / 26

/**
 * Everything about the match as this client sees it: predicted own body, smoothed visible players, effects, and the
 * per-frame GPU data. It only ever knows what the server sent; hidden players are simply absent.
 */
export class Game {
  map: MapDef
  level: Level
  body: Body | null = null
  aim = 0
  snap: Snapshot | null = null
  snapAt = 0
  shown = new Map<string, OtherView & { sx: number; sy: number; alpha: number; since: number }>()
  rings: Ring[] = []
  tracers: Tracer[] = []
  puffs: Puff[] = []
  markers: Marker[] = []
  flashes: { x: number; y: number; t0: number }[] = []
  lampOut: { x: number; y: number; r: number; t0: number }[] = []
  feed: FeedLine[] = []
  toasts: { text: string; t0: number; big: boolean }[] = []
  killcam: Killcam | null = null
  freezeUntil = 0
  hurt = 0
  /** Nearest enemy-made ring that reached you recently, for the heartbeat. */
  near = { d: Infinity, t: -10 }
  cursor = { x: 0, y: 0 }
  private seq = 0
  private pending: { seq: number; i: Intent }[] = []
  private acc = 0
  private doorAngles: number[] = []
  private puffAt = new Map<number, number>()
  private models: { people: number[][]; door: number; flare: number; decoy: number; mine: number; bolt: number }
  private frame = new Float32Array(FRAME_FLOATS)
  private lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  private inst = new Float32Array(1024 * INST_FLOATS)
  private alpha = new Float32Array(4096 * SPRITE_FLOATS)
  private add = new Float32Array(4096 * SPRITE_FLOATS)
  private nAlpha = 0
  private nAdd = 0
  roster: RosterRow[] = []
  awards: Award[] = []

  constructor(
    private renderer: Renderer,
    private session: Session,
    private onRing: (r: Ring, me: Body | null) => void,
  ) {
    this.map = getMap(0)
    this.level = new Level(this.map)
    const people = personModels().map((ws) => ws.map((m) => renderer.addModel(m)))
    this.models = {
      people,
      door: renderer.addModel(buildDoor()),
      flare: renderer.addModel(buildFlare()),
      decoy: renderer.addModel(buildDecoy()),
      mine: renderer.addModel(buildMine()),
      bolt: renderer.addModel(buildBolt()),
    }
    this.loadMap(this.map)
  }

  private loadMap(map: MapDef): void {
    this.map = map
    this.level = new Level(map)
    this.renderer.setLevel(buildLevel(map), buildGlass(map, this.level.glassBroken))
    this.renderer.setOccluders(this.level.occluders)
    this.doorAngles = map.doors.map((d) => this.doorTarget(d.id, this.level.doorsOpen[d.id]!))
    this.rings = []
    this.tracers = []
    this.puffs = []
    this.lampOut = []
    this.shown.clear()
    this.body = null
    this.pending = []
  }

  get myId(): string {
    return this.session.myId
  }

  /** Server clock now, estimated from the last snapshot. */
  serverTime(now: number): number {
    if (!this.snap) return 0
    return this.snap.t + Math.min(0.5, (now - this.snapAt) / 1000)
  }

  get alive(): boolean {
    return !!this.snap?.you?.alive && this.snap.phase === "live"
  }

  colorOf(id: string): Rgb3 {
    const r = this.roster.find((x) => x.id === id)
    if (!r) return [0.8, 0.8, 0.8]
    if (this.snap?.mode === "ffa") return FFA[this.roster.indexOf(r) % FFA.length]!
    return TEAM[r.team] ?? TEAM[0]
  }

  nameOf(id: string): string {
    return this.roster.find((x) => x.id === id)?.name ?? ""
  }

  // Network --------------------------------------------------------------------------------------------------------

  private ingest(now: number): void {
    const l = this.session.latest()
    if (l && l.snap !== this.snap) {
      const s = l.snap
      if (s.map !== this.map.seed) this.loadMap(getMap(s.map))
      const glassBefore = this.level.glassBroken.slice()
      if (this.level.sync(s.doors.map(Boolean), s.glass.map(Boolean))) {
        this.renderer.setOccluders(this.level.occluders)
        if (glassBefore.some((g, i) => g !== this.level.glassBroken[i])) this.renderer.setGlass(buildGlass(this.map, this.level.glassBroken))
      }
      for (let i = 0; i < this.level.lamps.length; i++) {
        const st = this.level.lamps[i]!
        st.broken = (s.lamps[i * 3]! & 1) !== 0
        st.off = (s.lamps[i * 3]! & 2) !== 0
        st.dimUntil = s.lamps[i * 3 + 1]!
        st.failAt = s.lamps[i * 3 + 2]!
      }
      const wasSeen = new Set(this.shown.keys())
      for (const o of s.others) {
        const k = this.shown.get(o.id)
        if (k) Object.assign(k, o)
        else {
          this.shown.set(o.id, { ...o, sx: o.x, sy: o.y, alpha: 0, since: now })
          if (s.phase === "live" && this.snap && this.isEnemy(o.key)) this.markers.push({ id: o.id, t0: now })
        }
        wasSeen.delete(o.id)
      }
      for (const id of wasSeen) this.shown.delete(id)
      if (s.you) this.reconcile(s, s.you.alive)
      if (s.phase !== this.snap?.phase && s.phase === "loadout") {
        this.killcam = null
        this.feed = []
      }
      this.snap = s
      this.snapAt = l.at
    }
    this.roster = this.session.roster()
    for (const e of this.session.drainEvents()) this.event(e, now)
  }

  private isEnemy(key: string): boolean {
    const me = this.roster.find((r) => r.id === this.myId)
    return !me || me.key !== key
  }

  private reconcile(s: Snapshot, alive: boolean): void {
    const you = s.you!
    this.pending = this.pending.filter((p) => p.seq > s.ack)
    const b: Body = { x: you.x, y: you.y, vx: you.vx, vy: you.vy }
    if (alive && s.phase === "live") {
      for (const p of this.pending) stepBody(b, p.i.mx, p.i.my, you.windupLeft > 0 ? WINDUP_SPEED : SPEED[p.i.stance], this.level.solids, DT)
    }
    this.body = b
  }

  private event(e: SimEvent, now: number): void {
    const t = now / 1000
    switch (e.k) {
      case "ring": {
        // Your own sounds and sounds from players you can already see aren't news: no ring for those.
        const me = this.alive && this.body ? Math.hypot(e.x - this.body.x, e.y - this.body.y) < 0.7 : false
        const seen = [...this.shown.values()].some((o) => Math.hypot(e.x - o.sx, e.y - o.sy) < 0.9)
        const r = { x: e.x, y: e.y, r: e.r, kind: e.kind, t0: t, mine: me || (seen && e.kind !== "glass" && e.kind !== "alarm") }
        this.rings.push(r)
        this.onRing(r, this.alive ? this.body : null)
        if (this.body && this.alive && e.kind !== "ping") {
          const d = Math.hypot(e.x - this.body.x, e.y - this.body.y)
          if (d > 0.6 && d <= e.r) this.near = { d, t }
        }
        return
      }
      case "shot":
        this.tracers.push({ x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, t0: t })
        this.flashes.push({ x: e.x0, y: e.y0, t0: t })
        return
      case "kill": {
        const w = e.weapon === "left" ? "left" : WEAPONS[e.weapon as Weapon].label.toLowerCase()
        this.feed.unshift({ killer: this.nameOf(e.killer), victim: this.nameOf(e.victim), kc: this.colorOf(e.killer), vc: this.colorOf(e.victim), weapon: w, t })
        this.feed.length = Math.min(this.feed.length, 4)
        if (e.victim === this.myId) {
          this.freezeUntil = t + 0.35
          this.hurt = 1
        }
        if (e.killer === this.myId) this.toasts.push({ text: `${this.nameOf(e.victim).toUpperCase()} · ${Math.round(e.dist)} M`, t0: t, big: false })
        return
      }
      case "killcam":
        this.killcam = { killer: this.nameOf(e.killer), weapon: e.weapon === "left" ? "" : WEAPONS[e.weapon as Weapon].label.toLowerCase(), dist: e.dist, t0: t, dx: e.dx, dy: e.dy }
        return
      case "lamp": {
        const l = this.map.lights[e.id]
        if (l) this.lampOut.push({ x: l.x, y: l.y, r: l.r * 0.45, t0: t })
        return
      }
      case "toast":
        this.toasts.push({ text: e.text, t0: t, big: false })
        return
      case "round":
        this.toasts.push({ text: e.winner === null ? `ROUND ${e.round} · DRAW` : `ROUND ${e.round} · ${e.label.toUpperCase()}`, t0: t, big: true })
        return
      case "match":
        this.awards = e.awards
        return
      case "glass":
        return
    }
  }

  // Fixed-step input and prediction -----------------------------------------------------------------------------

  update(dt: number, input: Input, cam: Camera, w: number, h: number, now: number): void {
    this.session.update(dt)
    this.ingest(now)
    const t = now / 1000
    const c = cam.unproject(input.mouse.x, input.mouse.y, w, h, 1.2)
    this.cursor = c
    const origin = this.body ?? { x: this.map.size[0] / 2, y: this.map.size[1] / 2 }
    this.aim = Math.atan2(c.y - origin.y, c.x - origin.x)
    if (t < this.freezeUntil) return
    this.acc = Math.min(this.acc + dt, DT * 5)
    while (this.acc >= DT) {
      this.acc -= DT
      const mv = input.move()
      const presses = input.take()
      const live = this.alive
      const i: Intent = {
        mx: live ? mv.mx : 0,
        my: live ? mv.my : 0,
        stance: mv.stance,
        aim: this.aim,
        fire: live && presses.fire,
        reload: live && presses.reload,
        gadget: live ? presses.gadget : -1,
        tx: c.x,
        ty: c.y,
        use: live && presses.use,
      }
      const seq = ++this.seq
      this.session.send({ type: "intent", seq, i })
      if (live && this.body) {
        this.pending.push({ seq, i })
        if (this.pending.length > 90) this.pending.shift()
        const winding = (this.snap?.you?.windupLeft ?? 0) > 0
        stepBody(this.body, i.mx, i.my, winding ? WINDUP_SPEED : SPEED[i.stance], this.level.solids, DT)
      }
    }
  }

  private doorTarget(id: number, open: boolean): number {
    const d = this.map.doors[id]!
    const horizontal = d.rect[2] - d.rect[0] > d.rect[3] - d.rect[1]
    const swing = id % 2 ? 1 : -1
    if (horizontal) return open ? (swing * Math.PI) / 2 : 0
    return open ? (swing > 0 ? Math.PI : 0) : Math.PI / 2
  }

  // Frame assembly ---------------------------------------------------------------------------------------------

  private pushInst(n: number, x: number, y: number, z: number, yaw: number, tint: readonly number[], crouch: number, lie: number, flash: number, a: number): number {
    if ((n + 1) * INST_FLOATS > this.inst.length) {
      const bigger = new Float32Array(this.inst.length * 2)
      bigger.set(this.inst)
      this.inst = bigger
    }
    const o = n * INST_FLOATS
    this.inst.set([x, y, z, yaw, tint[0]!, tint[1]!, tint[2]!, crouch, lie, flash, a, 0], o)
    return n + 1
  }

  private sprite(add: boolean, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot = 0, stretch = 0, extra = 0): void {
    const buf = add ? this.add : this.alpha
    const n = add ? this.nAdd : this.nAlpha
    if ((n + 1) * SPRITE_FLOATS > buf.length) return
    buf.set([x, y, z, size, r, g, b, a, kind, rot, stretch, extra], n * SPRITE_FLOATS)
    if (add) this.nAdd++
    else this.nAlpha++
  }

  /** Builds the GPU frame for this instant. */
  build(cam: Camera, w: number, h: number, now: number): FrameInput {
    const t = now / 1000
    const st = this.serverTime(now)
    const snap = this.snap
    const dt = Math.min(0.1, t - (this.lastT || t))
    this.lastT = t

    // Lights: every map light keeps its slot (fixtures look up their own), then burning flares.
    const L = this.lights
    L.fill(0)
    let nl = 0
    for (const l of this.map.lights) {
      const p = lampPower(l, this.level.lamps[l.id]!, st)
      L.set([l.x, l.h, l.y, l.r, l.color[0], l.color[1], l.color[2], p, l.cone?.[0] ?? 0, l.cone?.[1] ?? 0, l.cone?.[2] ?? 0, l.cone ? 1 : 0, l.power, 0, 0, 0], nl * LIGHT_FLOATS)
      nl++
    }
    for (const th of snap?.thrown ?? []) {
      if (th.kind !== "flare" || nl >= MAX_LIGHTS) continue
      const p = flarePower(st, th.landAt, th.endAt)
      if (p <= 0) continue
      L.set([th.x, 0.3, th.y, 9, FLARE_COLOR[0], FLARE_COLOR[1], FLARE_COLOR[2], p, 0, 0, 0, 0, 1.3, 0, 0, 0], nl * LIGHT_FLOATS)
      nl++
    }

    // Instances.
    this.nAlpha = 0
    this.nAdd = 0
    const batches: Batch[] = []
    const people = new Map<number, number[]>()
    const addPerson = (look: number, weapon: Weapon, data: number[]) => {
      const id = this.models.people[look]?.[["pistol", "shotgun", "crossbow"].indexOf(weapon)] ?? this.models.people[0]![0]!
      const arr = people.get(id) ?? []
      arr.push(...data)
      people.set(id, arr)
    }
    const k = 1 - Math.exp(-dt * 14)
    for (const o of this.shown.values()) {
      o.sx += (o.x - o.sx) * k
      o.sy += (o.y - o.sy) * k
      o.alpha = Math.min(1, o.alpha + dt * 6)
      const col = this.colorOf(o.id)
      addPerson(o.look, o.weapon, [o.sx, 0, o.sy, o.aim, col[0], col[1], col[2], o.stance === "sneak" ? 0.78 : 1, 0, 0, 1, 0])
      this.sprite(true, o.sx, 0.03, o.sy, 0.5, col[0], col[1], col[2], 0.9 * o.alpha, 2, 0, 0.16)
      if (o.windup) this.sprite(true, o.sx, 0.04, o.sy, 0.8, 1, 0.3, 0.2, 0.8, 2, 0, 0.05)
    }
    const me = this.alive ? this.body : null
    if (me && snap?.you) {
      const col = this.colorOf(this.myId)
      const row = this.roster.find((r) => r.id === this.myId)
      addPerson(row?.look ?? 0, snap.you.weapon, [me.x, 0, me.y, this.aim, col[0], col[1], col[2], snap.you.stance === "sneak" ? 0.78 : 1, 0, 0, 1, 0])
      this.sprite(true, me.x, 0.03, me.y, 0.5, col[0], col[1], col[2], 1, 2, 0, 0.16)
      if (snap.you.windupLeft > 0) {
        const total = WEAPONS[snap.you.weapon].windup
        const f = snap.you.windupLeft / total
        this.sprite(true, me.x, 0.04, me.y, 0.42 + f * 0.35, 1, 1, 1, 0.6, 2, 0, 0.06)
      }
      // Faint dotted aim line out to the weapon's range.
      const range = Math.min(WEAPONS[snap.you.weapon].range, Math.hypot(this.cursor.x - me.x, this.cursor.y - me.y))
      const hx = me.x + Math.cos(this.aim) * (0.6 + range / 2)
      const hz = me.y + Math.sin(this.aim) * (0.6 + range / 2)
      this.sprite(true, hx, 0.05, hz, range / 2, 1, 1, 1, 0.16, 4, this.aim, 0.025 / Math.max(0.1, range / 2), range * 2.2)
    }
    for (const c of snap?.corpses ?? []) {
      const col = this.colorOf(c.id)
      const row = this.roster.find((r) => r.id === c.id)
      addPerson(row?.look ?? 0, "pistol", [c.x, 0, c.y, c.aim, col[0] * 0.5, col[1] * 0.5, col[2] * 0.5, 1, 1, 0, 1, 0])
    }
    let n = 0
    for (const [model, data] of people) {
      const start = n
      for (let i = 0; i < data.length; i += 12) n = this.pushInst(n, data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!, [data[i + 4]!, data[i + 5]!, data[i + 6]!], data[i + 7]!, data[i + 8]!, data[i + 9]!, data[i + 10]!)
      batches.push({ model, data: this.inst.subarray(start * INST_FLOATS, n * INST_FLOATS) as Float32Array<ArrayBuffer>, count: n - start })
    }
    // Doors swing toward their state.
    const doorStart = n
    this.map.doors.forEach((d, i) => {
      const target = this.doorTarget(d.id, this.level.doorsOpen[d.id]!)
      this.doorAngles[i] = (this.doorAngles[i] ?? target) + ((target - (this.doorAngles[i] ?? target)) * Math.min(1, dt * 9))
      const horizontal = d.rect[2] - d.rect[0] > d.rect[3] - d.rect[1]
      const hx = horizontal ? d.rect[0] : (d.rect[0] + d.rect[2]) / 2
      const hz = horizontal ? (d.rect[1] + d.rect[3]) / 2 : d.rect[1]
      n = this.pushInst(n, hx, 0, hz, this.doorAngles[i]!, [1, 1, 1], 1, 0, 0, 1)
    })
    batches.push({ model: this.models.door, data: this.inst.subarray(doorStart * INST_FLOATS, n * INST_FLOATS) as Float32Array<ArrayBuffer>, count: n - doorStart })

    // Thrown gadgets, bolts and your mines.
    const flareStart = n
    const decoys: number[] = []
    for (const th of snap?.thrown ?? []) {
      const f = Math.min(1, Math.max(0, (st - th.thrownAt) / Math.max(0.01, th.landAt - th.thrownAt)))
      const x = th.sx + (th.x - th.sx) * f
      const z = th.sy + (th.y - th.sy) * f
      const y = f < 1 ? 1.2 + Math.sin(f * Math.PI) * 2.2 - f * 1.2 : 0
      if (th.kind === "flare") {
        n = this.pushInst(n, x, y, z, th.id * 1.7 + (f < 1 ? t * 9 : 0), [1, 1, 1], 1, 0, 0, 1)
        const p = flarePower(st, th.landAt, th.endAt)
        if (f < 1 || p > 0) {
          this.sprite(true, x, y + 0.15, z, f < 1 ? 0.5 : 0.9 + p * 0.5, 1, 0.25, 0.15, 1, 0)
          const last = this.puffAt.get(th.id) ?? 0
          if (f >= 1 && t - last > 0.14) {
            this.puffAt.set(th.id, t)
            this.puffs.push({ x, y: z, h: 0.1, t0: t, life: 2.6, size: 0.18, rot: Math.random() * 6, flare: th.id })
          }
          if (f >= 1) {
            const left = Math.max(0, (th.endAt - st) / (th.endAt - th.landAt))
            this.sprite(true, x, 0.05, z, 0.7, 1, 0.9, 0.9, 0.55, 5, 0, 0.04, left)
          }
        }
      } else decoys.push(x, y, z)
    }
    batches.push({ model: this.models.flare, data: this.inst.subarray(flareStart * INST_FLOATS, n * INST_FLOATS) as Float32Array<ArrayBuffer>, count: n - flareStart })
    const misc = (model: number, pts: number[], tint: readonly number[]) => {
      const s = n
      for (let i = 0; i < pts.length; i += 3) n = this.pushInst(n, pts[i]!, pts[i + 1]!, pts[i + 2]!, i, tint, 1, 0, 0, 1)
      batches.push({ model, data: this.inst.subarray(s * INST_FLOATS, n * INST_FLOATS) as Float32Array<ArrayBuffer>, count: n - s })
    }
    misc(this.models.decoy, decoys, [0.9, 0.2, 0.2])
    misc(this.models.bolt, (snap?.bolts ?? []).flatMap((b) => [b.x, 0, b.y]), [1, 1, 1])
    const mines = snap?.you?.mines ?? []
    misc(this.models.mine, mines.flatMap((m) => [m.x, 0, m.y]), Math.sin(t * 4) > 0 ? [1.2, 0.15, 0.1] : [0.2, 0.05, 0.05])

    // Smoke puffs: faceted, rising, lit red by their flare.
    this.puffs = this.puffs.filter((p) => t - p.t0 < p.life)
    for (const p of this.puffs) {
      const a = (t - p.t0) / p.life
      const lit = 0.25 + 0.75 * Math.max(0, 1 - a * 1.4)
      this.sprite(false, p.x + a * 0.6, p.h + a * 2.4, p.y - a * 1.2, p.size + a * 0.55, 0.55 * lit + 0.12, 0.12 * lit + 0.12, 0.1 * lit + 0.14, (1 - a) * 0.55, 1, 0, 0, p.rot)
    }

    // Sound rings. They are information about what you can't see, so sounds made by you or by a player already on
    // screen are not drawn. Footsteps are faint and short; gunfire, glass and alarms are the big rings.
    this.rings = this.rings.filter((r) => t - r.t0 < RING_LIFE(r.r) + 2.5)
    for (const r of this.rings) {
      if (r.mine) continue
      const age = t - r.t0
      const step = r.kind === "step" || r.kind === "run" || r.kind === "splash" || r.kind === "crunch"
      if (step) {
        const a = Math.max(0, 1 - age / 3)
        this.sprite(true, r.x, 0.05, r.y, 0.07, 1, 1, 1, 0.7 * a, 6)
        const p = age / 0.9
        if (p < 1) {
          const rad = Math.max(0.2, Math.min(r.r, 3.5) * (1 - (1 - p) * (1 - p)))
          this.sprite(true, r.x, 0.05, r.y, rad, 1, 1, 1, (1 - p) * (r.kind === "run" ? 0.5 : 0.28), 2, 0, Math.min(0.5, 0.035 / rad))
        }
        continue
      }
      const life = RING_LIFE(r.r)
      const col = r.kind === "alarm" ? [1, 0.3, 0.25] : r.kind === "ping" ? [0.6, 0.75, 1] : [1, 1, 1]
      const jag = r.kind === "glass" || r.kind === "lamp" || r.kind === "emp" || r.kind === "alarm"
      const echoes = r.kind === "shot" || r.kind === "shotgun" || r.kind === "glass" ? 2 : 1
      const strength = r.kind === "ping" || r.kind === "dry" || r.kind === "door" ? 0.4 : 0.85
      for (let e = 0; e < echoes; e++) {
        const p = (age - e * 0.15) / life
        if (p < 0 || p > 1) continue
        const rad = Math.max(0.15, r.r * (1 - (1 - p) * (1 - p)))
        const a = Math.pow(1 - p, 1.6) * strength * (e ? 0.45 : 1)
        this.sprite(true, r.x, 0.05, r.y, rad, col[0]!, col[1]!, col[2]!, a, jag ? 3 : 2, 0, Math.min(0.5, 0.04 / rad), r.t0 * 3)
      }
    }
    this.tracers = this.tracers.filter((tr) => t - tr.t0 < 0.25)
    for (const tr of this.tracers) {
      const len = Math.hypot(tr.x1 - tr.x0, tr.y1 - tr.y0) / 2
      const a = 1 - (t - tr.t0) / 0.25
      this.sprite(true, (tr.x0 + tr.x1) / 2, 1.2, (tr.y0 + tr.y1) / 2, len, 1, 0.85, 0.6, a, 4, Math.atan2(tr.y1 - tr.y0, tr.x1 - tr.x0), 0.03 / Math.max(0.1, len))
    }
    this.flashes = this.flashes.filter((f) => t - f.t0 < 0.08)
    for (const f of this.flashes) this.sprite(true, f.x, 1.2, f.y, 0.7, 1, 0.7, 0.35, 1, 0)
    this.lampOut = this.lampOut.filter((l) => t - l.t0 < 3.5)
    for (const l of this.lampOut) this.sprite(true, l.x, 0.05, l.y, l.r, 1, 1, 1, 0.5 * (1 - (t - l.t0) / 3.5), 5, 0, 0.02)
    this.markers = this.markers.filter((m) => t * 1000 - m.t0 < 1400)
    for (const m of this.markers) {
      const o = this.shown.get(m.id)
      if (o) this.sprite(false, o.sx, 2.25, o.sy, 0.22, 1, 1, 1, 1, 7)
    }

    // Frame uniforms.
    const vp = cam.update(w / h)
    const F = this.frame
    F.set(vp, 0)
    F.set([cam.eye[0], cam.eye[1], cam.eye[2], t], 16)
    F.set([this.renderer.width, this.renderer.height, nl, this.renderer.occluderCount], 20)
    const focus = me ? cam.project(me.x, 0.9, me.y, w, h) : { x: 0, y: 0 }
    F.set([me?.x ?? 0, me?.y ?? 0, me ? 1 : 0, 0.2], 24)
    F.set([0.16, 0.2, 0.34, 0], 28)
    F.set([(focus.x / w) * 2 - 1, 1 - (focus.y / h) * 2, 0.7, 0], 32)
    F.set([0, 1, 0, 0], 36)

    this.hurt = Math.max(0, this.hurt - dt * 1.2)
    const dead = snap?.phase === "live" && !!snap.you && !snap.you.alive
    return {
      frame: F,
      lights: L,
      batches,
      alphaSprites: this.alpha,
      alphaCount: this.nAlpha,
      addSprites: this.add,
      addCount: this.nAdd,
      grade: [t, dead ? 0.55 : 0, this.hurt * 0.8, 1.15],
    }
  }

  private lastT = 0
}
