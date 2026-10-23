import { Glide, hermite2, lerpAngle, SnapshotBuffer } from "@arcade/kit/net/interpolate"
import { Predictor, Smoother } from "@arcade/kit/net/prediction"
import { RoomSocket } from "@arcade/kit/net/room-socket"
import { BUILD } from "../shared/build.gen"
import { createNight, canLight } from "../shared/night"
import { applyFlares, applyMapDelta, applyNightWire, BIT, decodeServer, GAME, packIntent, quantizeInput, ROOM_FEEL, tapeFromRow, TICK_DT, type PlayerRow, type RosterRow, type ServerMsg, type Snapshot } from "../shared/protocol"
import { createWoods, newPlayer, setBotCount, stepMotion, stepWoods, type Feel, type Player, type PlayerInput, type WoodsEvent, type WoodsState } from "../shared/sim"
import { castVote, isGone, type Suspect } from "../shared/verdict"
import type { WoodsWorld } from "../shared/world"
import { flyFor } from "../shared/flares"

/**
 * Where the night runs. Solo steps the shared sim here with bots; a room steps it on the server and this client
 * predicts only its own walking. Either way the page draws `view` (tapes, finds, everyone), walks the camera along
 * `drawn()` and plays `drain()`'s events.
 */
export interface Session {
  readonly online: boolean
  readonly world: WoodsWorld
  /** Seconds per fixed tick. */
  readonly dt: number
  /** Your player id (−1 until a room seats you). */
  readonly me: number
  /** What to draw. Your entry is `self`. */
  readonly view: WoodsState
  /** Your own player: predicted motion, your light, your map's pencil marks. */
  readonly self: Player
  tick(input: PlayerInput): void
  /** Your drawn position between ticks (`alpha` 0..1 of the way to the newest), with corrections eased out. */
  drawn(alpha: number): { x: number; z: number; y: number }
  /** Presentation for this frame (`alpha` 0..1 of the way from the last tick to the next): friends interpolated, corrections decayed. */
  frame(dt: number, alpha: number): void
  drain(): WoodsEvent[]
  /** The sim's clock now (s), smooth between ticks and snapshots: what flares burn by. */
  roomTime(): number
  /** Name what took her at the radio (`verdict.ts`); the room or the local sim decides if it counts. */
  vote(suspect: Suspect): void
  status(): string | null
  roster(): readonly RosterRow[]
  close(): void
}

type Pose = { x: number; z: number; y: number; yaw: number; pitch: number }

export class SoloSession implements Session {
  readonly online = false
  readonly dt = 1 / 60
  readonly me = 0
  /** The sim (automation writes here); `view` is what to draw. */
  readonly state: WoodsState
  view: WoodsState
  /** Draw friends between their last two ticks (a 120 Hz screen otherwise shows a 60 Hz sim as stutter). */
  smooth = true
  private inputs = new Map<number, PlayerInput>()
  private events: WoodsEvent[] = []
  private prev = { x: 0, z: 0, y: 0 }
  private before = new Map<number, Pose>()
  private shown = new Map<number, Player>()
  private drawnView = {} as WoodsState

  /** `seed` picks the night (its clue layout, bots and flicker); the same seed is the same night. */
  constructor(readonly world: WoodsWorld, private readonly feel: Feel, readonly seed = world.params.seed) {
    this.state = this.view = createWoods(world, feel.botCount, seed)
    this.prev = { x: this.self.x, z: this.self.z, y: this.self.air.y }
  }
  get self(): Player {
    return this.state.players.find((p) => p.id === 0)!
  }
  tick(input: PlayerInput) {
    if (this.state.brains.length !== this.feel.botCount) setBotCount(this.state, this.world, this.feel.botCount)
    this.prev = { x: this.self.x, z: this.self.z, y: this.self.air.y }
    for (const p of this.state.players) {
      const b = this.before.get(p.id)
      if (b) Object.assign(b, { x: p.x, z: p.z, y: p.air.y, yaw: p.yaw, pitch: p.pitch })
      else this.before.set(p.id, { x: p.x, z: p.z, y: p.air.y, yaw: p.yaw, pitch: p.pitch })
    }
    this.inputs.set(0, input)
    stepWoods(this.state, this.world, this.inputs, this.dt, this.feel)
    this.events.push(...this.state.events)
  }
  drawn(alpha: number) {
    const s = this.self
    return { x: this.prev.x + (s.x - this.prev.x) * alpha, z: this.prev.z + (s.z - this.prev.z) * alpha, y: this.prev.y + (s.air.y - this.prev.y) * alpha }
  }
  frame(_dt: number, alpha: number) {
    if (!this.smooth) { this.view = this.state; return }
    const players = this.state.players.map((p) => {
      if (p.id === this.me) return p
      let d = this.shown.get(p.id)
      if (d) Object.assign(d, p)
      else this.shown.set(p.id, (d = { ...p }))
      const b = this.before.get(p.id)
      // A teleport (automation, a respawn) shows where it lands.
      if (b && Math.hypot(p.x - b.x, p.z - b.z) < 2) {
        d.x = b.x + (p.x - b.x) * alpha
        d.z = b.z + (p.z - b.z) * alpha
        d.air = { ...p.air, y: b.y + (p.air.y - b.y) * alpha }
        d.yaw = lerpAngle(b.yaw, p.yaw, alpha)
        d.pitch = b.pitch + (p.pitch - b.pitch) * alpha
      }
      return d
    })
    if (this.shown.size > players.length) for (const id of this.shown.keys()) if (!players.some((p) => p.id === id)) this.shown.delete(id)
    this.view = Object.assign(this.drawnView, this.state, { players })
  }
  vote(suspect: Suspect) {
    const me = this.state.players.find((p) => p.id === 0)
    if (me) castVote(this.state.night, me, suspect, this.state.t)
  }
  drain() {
    const out = this.events
    this.events = []
    return out
  }
  roomTime() {
    return this.state.t
  }
  /** An event made outside a tick (the Lab's creature Trigger now), played like the sim's own. */
  inject(e: WoodsEvent) {
    this.events.push(e)
  }
  status() {
    return null
  }
  roster() {
    return []
  }
  close() {}
  /** Automation: stand somewhere. */
  teleport(x: number, z: number) {
    Object.assign(this.self, { x, z, vx: 0, vz: 0 })
    this.prev = { x, z, y: this.self.air.y }
  }
}

type Remote = { player: Player; glide: Glide }

/** A walker's torch battery from their row. */
function battery(p: Player, r: PlayerRow) {
  p.charge = (r[10] ?? 100) / 100
  p.spare = !!(r[7]! & BIT.spare)
  p.swap = r[7]! & BIT.swap ? 1 : 0
}

export class OnlineSession implements Session {
  readonly online = true
  me = -1
  readonly view: WoodsState
  readonly self: Player
  private socket: RoomSocket<unknown>
  private predictor = new Predictor<PlayerInput>()
  private smoother = new Smoother(12, 3)
  private snaps = new SnapshotBuffer<Snapshot>(0.1, 32, 0.25, { min: 0.08, max: 0.1 })
  private remotes = new Map<number, Remote>()
  private names: Record<number, string> = {}
  private events: WoodsEvent[] = []
  private rosterRows: RosterRow[] = []
  private prev = { x: 0, z: 0, y: 0 }
  /** A fresh join snapshot restores the camera's facing before it sends another input. */
  poseVersion = 0
  private obstacles: Player[] = []
  private fatal: string | null = null
  /** Ask the room for the next night (from the debrief). */
  again() {
    this.socket.send({ type: "again" })
  }
  /** Room time of the newest snapshot and when it arrived (performance.now ms). */
  private clock = { t: 0, at: 0 }
  vote(suspect: Suspect) {
    this.socket.send({ type: "vote", suspect })
  }
  /** Bytes received over the socket (bandwidth readout). */
  bytesIn = 0
  readonly startedAt = performance.now()

  constructor(readonly world: WoodsWorld, readonly room: string, name: string) {
    this.view = createWoods(world, 0, world.params.seed, [])
    const s = world.camp.spawn
    this.self = newPlayer(-1, false, name || "You", s.x, s.z, s.yaw)
    this.prev = { x: s.x, z: s.z, y: 0 }
    this.view.players.push(this.self)
    this.socket = new RoomSocket({
      game: GAME,
      room,
      automaticReload: true,
      hello: (token) => ({ type: "hello", token, build: BUILD, name }),
      receive: (m) => this.receive(m as ServerMsg),
      fatal: (message) => (this.fatal = message),
      encode: (m) => JSON.stringify(m),
      decode: (raw) => { this.bytesIn += raw.length; return decodeServer(raw) },
    })
  }

  /** Ticks run a touch faster or slower so the room's input buffer stays centred (`Predictor.pace`). */
  get dt() {
    return TICK_DT / this.predictor.pace
  }

  tick(input: PlayerInput) {
    if (this.me < 0 || this.socket.problem) return
    // Taken (`verdict.ts`): the room holds you still (map down), so only look; don't predict anything else.
    const taken = isGone(this.view.night, this.me)
    const q = quantizeInput(taken ? { ...input, mx: 0, mz: 0, jump: false, light: false, tie: false, map: false } : input)
    this.prev = { x: this.self.x, z: this.self.z, y: this.self.air.y }
    const seq = this.predictor.record(q)
    if (taken) Object.assign(this.self, { yaw: q.yaw, pitch: q.pitch, vx: 0, vz: 0, mapRaise: 0 })
    else stepMotion(this.world, this.self, q, ROOM_FEEL, TICK_DT, this.obstacles)
    this.self.light = q.light && canLight(this.self)
    this.socket.send({ type: "intent", seq, i: packIntent(q) })
  }

  drawn(alpha: number) {
    const s = this.self
    return { x: this.prev.x + (s.x - this.prev.x) * alpha + this.smoother.x, z: this.prev.z + (s.z - this.prev.z) * alpha + this.smoother.y, y: this.prev.y + (s.air.y - this.prev.y) * alpha }
  }

  private receive(m: ServerMsg) {
    switch (m.type) {
      case "roster": this.rosterRows = m.players as RosterRow[]; return
      case "ev": for (const e of m.events as WoodsEvent[]) this.event(e); return
      case "s": this.snapshot(m); return
    }
  }

  private event(e: WoodsEvent) {
    const v = this.view
    if (e.kind === "tape-tied" && !v.tapes.some((t) => t.id === e.tape)) {
      const tape = tapeFromRow(this.world, [e.tape, e.tree, Math.round(e.yaw * 1000), e.by, Math.round(e.at * 10)])
      if (tape) v.tapes.push(tape)
    }
    if (e.kind === "tape-removed") v.tapes = v.tapes.filter((t) => t.id !== e.tape)
    this.events.push(e)
  }

  private snapshot(s: Snapshot) {
    // A new night puts everyone back at camp: take the room's position outright rather than easing across the woods.
    const first = this.me < 0 || this.me !== s.me || !!s.map?.reset || (!!s.night && s.night.seed !== this.view.night.seed)
    if (first) { this.snaps.clear(); this.poseVersion++ }
    this.me = s.me
    this.self.id = s.me
    this.view.t = s.t
    this.clock = { t: s.t, at: performance.now() }
    if (s.names) this.names = s.names
    if (s.fl) applyFlares(this.view.flares, s.fl, s.t, (f, seconds) => flyFor(this.world, f, seconds))
    if (s.tapes) this.view.tapes = s.tapes.map((r) => tapeFromRow(this.world, r)).filter((t) => t !== null)
    if (s.found) this.view.found = s.found
    if (s.distant) this.view.distant = s.distant
    if (s.night) {
      if (s.night.seed !== this.view.night.seed) this.view.night = createNight(this.world, s.night.seed)
      applyNightWire(this.view.night, s.night)
    }
    // Collision reads the newest authoritative positions, never the delayed presentation poses; the taken have no body.
    this.obstacles = s.p.filter((r) => r[0] !== s.me && !isGone(this.view.night, r[0]!)).map((r) => newPlayer(r[0]!, !!(r[7]! & BIT.bot), "", r[1]! / 100, r[2]! / 100, r[5]! / 1000))
    const taken = isGone(this.view.night, s.me)
    if (s.map) applyMapDelta(this.self.map, s.map)
    const mine = s.p.find((r) => r[0] === s.me)
    if (mine) {
      battery(this.self, mine)
      this.self.flickerLeft = mine[7]! & BIT.flicker ? 1 : 0
      this.self.tie = mine[9]! >= 0 ? { tree: mine[9]!, progress: mine[8]! / 100, removing: !!(mine[7]! & BIT.untie) } : null
    }
    if (s.you) {
      const you = s.you
      this.self.flares = you[10] ?? this.self.flares
      const restore = () => {
        Object.assign(this.self, { x: you[0], z: you[1], vx: you[2], vz: you[3], mapRaise: you[4] })
        Object.assign(this.self.air, { y: you[5], v: you[6], airborne: you[5]! > 0 || you[6] !== 0 })
      }
      if (first) {
        this.predictor.reset()
        restore()
        Object.assign(this.self, { yaw: you[7], pitch: you[8], light: !!you[9] })
        this.prev = { x: this.self.x, z: this.self.z, y: this.self.air.y }
        this.smoother.x = this.smoother.y = 0
      } else {
        const bx = this.self.x, bz = this.self.z, by = this.self.air.y
        this.predictor.reconcile(s.ack, restore, (cmd) => { if (!taken) stepMotion(this.world, this.self, cmd, ROOM_FEEL, TICK_DT, this.obstacles) })
        this.smoother.correct(bx, bz, this.self.x, this.self.z)
        this.prev.x += this.self.x - bx
        this.prev.z += this.self.z - bz
        this.prev.y += this.self.air.y - by
      }
    }
    this.snaps.push(s.t, s, performance.now() / 1000)
  }

  frame(dt: number) {
    this.smoother.step(dt)
    for (const f of this.view.flares.list) if (f.body && !f.body.rest) flyFor(this.world, f, dt)
    const br = this.snaps.sample(performance.now() / 1000)
    const seen = new Set<number>([this.me])
    if (br) {
      const rowA = new Map<number, PlayerRow>(br.a.p.map((r) => [r[0]!, r]))
      for (const b of br.b.p) {
        const id = b[0]!
        if (id === this.me) continue
        seen.add(id)
        let a = rowA.get(id) ?? b
        // A reused id (a bot replaced, a seat re-filled) is a different walker: don't blend the old one into it.
        if ((a[7]! & BIT.bot) !== (b[7]! & BIT.bot) || Math.hypot(a[1]! - b[1]!, a[2]! - b[2]!) > 1000) a = b
        let r = this.remotes.get(id)
        if (!r) {
          r = { player: newPlayer(id, !!(b[7]! & BIT.bot), this.names[id] ?? "Friend", b[1]! / 100, b[2]! / 100, b[5]! / 1000), glide: new Glide(10, 4) }
          this.remotes.set(id, r)
          this.view.players.push(r.player)
        }
        const pa = { x: a[1]! / 100, y: a[2]! / 100, vx: a[3]! / 100, vy: a[4]! / 100 }, pb = { x: b[1]! / 100, y: b[2]! / 100, vx: b[3]! / 100, vy: b[4]! / 100 }
        const h = hermite2(pa, pb, br.span, br.t, br.over, 3)
        const g = r.glide.step(h.x, h.y, h.vx, h.vy, dt)
        const p = r.player
        p.x = g.x; p.z = g.y; p.vx = h.vx; p.vz = h.vy
        p.air.y = Math.max(0, (a[11]! + (b[11]! - a[11]!) * br.t) / 1000)
        p.air.v = b[12]! / 1000
        p.air.airborne = p.air.y > 0
        p.yaw = lerpAngle(a[5]! / 1000, b[5]! / 1000, br.t)
        p.pitch = a[6]! / 1000 + (b[6]! / 1000 - a[6]! / 1000) * br.t
        p.light = !!(b[7]! & BIT.light)
        battery(p, b)
        p.flickerLeft = b[7]! & BIT.flicker ? 1 : 0
        p.signal = b[7]! & BIT.signal ? 1 : 0
        p.mapRaise = b[7]! & BIT.map ? 1 : 0
        p.tie = b[9]! >= 0 ? { tree: b[9]!, progress: b[8]! / 100, removing: !!(b[7]! & BIT.untie) } : null
        p.name = this.names[id] ?? p.name
        p.bot = !!(b[7]! & BIT.bot)
      }
    }
    for (const id of [...this.remotes.keys()]) if (!seen.has(id)) {
      const r = this.remotes.get(id)!
      this.remotes.delete(id)
      this.view.players = this.view.players.filter((p) => p !== r.player)
    }
  }

  drain() {
    const out = this.events
    this.events = []
    return out
  }
  roomTime() {
    return this.clock.t + Math.min(0.5, (performance.now() - this.clock.at) / 1000)
  }
  status() {
    return this.fatal ?? this.socket.status()
  }
  roster() {
    return this.rosterRows
  }
  rename(name: string) {
    this.socket.send({ type: "name", name })
  }
  /** Automation: cut the socket as a dropped connection would; RoomSocket reconnects and reclaims the seat. */
  drop() {
    ;(this.socket as unknown as { ws: WebSocket | null }).ws?.close()
  }
  /** Whether a friend is away (dropped, seat held). */
  away(id: number) {
    return this.rosterRows.some((r) => r.pid === id && !r.connected)
  }
  close() {
    this.socket.close()
  }
}
