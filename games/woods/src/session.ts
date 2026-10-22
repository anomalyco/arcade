import { Glide, hermite2, lerpAngle, SnapshotBuffer } from "@arcade/kit/net/interpolate"
import { Predictor, Smoother } from "@arcade/kit/net/prediction"
import { RoomSocket } from "@arcade/kit/net/room-socket"
import { BUILD } from "../shared/build.gen"
import { applyMapDelta, BIT, decodeServer, GAME, packIntent, quantizeInput, ROOM_FEEL, tapeFromRow, TICK_DT, type PlayerRow, type RosterRow, type ServerMsg, type Snapshot } from "../shared/protocol"
import { createWoods, newPlayer, setBotCount, stepMotion, stepWoods, type Feel, type Player, type PlayerInput, type WoodsEvent, type WoodsState } from "../shared/sim"
import type { WoodsWorld } from "../shared/world"

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
  drawn(alpha: number): { x: number; z: number }
  /** Presentation for this frame: friends interpolated, corrections decayed. */
  frame(dt: number): void
  drain(): WoodsEvent[]
  status(): string | null
  roster(): readonly RosterRow[]
  close(): void
}

export class SoloSession implements Session {
  readonly online = false
  readonly dt = 1 / 60
  readonly me = 0
  view: WoodsState
  private inputs = new Map<number, PlayerInput>()
  private events: WoodsEvent[] = []
  private prev = { x: 0, z: 0 }

  constructor(readonly world: WoodsWorld, private readonly feel: Feel) {
    this.view = createWoods(world, feel.botCount)
    this.prev = { x: this.self.x, z: this.self.z }
  }
  get self(): Player {
    return this.view.players.find((p) => p.id === 0)!
  }
  tick(input: PlayerInput) {
    if (this.view.brains.length !== this.feel.botCount) setBotCount(this.view, this.world, this.feel.botCount)
    this.prev = { x: this.self.x, z: this.self.z }
    this.inputs.set(0, input)
    stepWoods(this.view, this.world, this.inputs, this.dt, this.feel)
    this.events.push(...this.view.events)
  }
  drawn(alpha: number) {
    const s = this.self
    return { x: this.prev.x + (s.x - this.prev.x) * alpha, z: this.prev.z + (s.z - this.prev.z) * alpha }
  }
  frame() {}
  drain() {
    const out = this.events
    this.events = []
    return out
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
    this.prev = { x, z }
  }
}

type Remote = { player: Player; glide: Glide }

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
  private prev = { x: 0, z: 0 }
  private fatal: string | null = null
  /** Bytes received over the socket (bandwidth readout). */
  bytesIn = 0
  readonly startedAt = performance.now()

  constructor(readonly world: WoodsWorld, readonly room: string, name: string) {
    this.view = createWoods(world, 0, world.params.seed, [])
    const s = world.camp.spawn
    this.self = newPlayer(-1, false, name || "You", s.x, s.z, s.yaw)
    this.prev = { x: s.x, z: s.z }
    this.view.players.push(this.self)
    this.socket = new RoomSocket({
      game: GAME,
      room,
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
    if (this.me < 0) return
    const q = quantizeInput(input)
    this.prev = { x: this.self.x, z: this.self.z }
    const seq = this.predictor.record(q)
    stepMotion(this.world, this.self, q, ROOM_FEEL, TICK_DT)
    this.self.light = q.light
    this.socket.send({ type: "intent", seq, i: packIntent(q) })
  }

  drawn(alpha: number) {
    const s = this.self
    return { x: this.prev.x + (s.x - this.prev.x) * alpha + this.smoother.x, z: this.prev.z + (s.z - this.prev.z) * alpha + this.smoother.y }
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
    const first = this.me < 0 || this.me !== s.me
    this.me = s.me
    this.self.id = s.me
    this.view.t = s.t
    if (s.names) this.names = s.names
    if (s.tapes) this.view.tapes = s.tapes.map((r) => tapeFromRow(this.world, r)).filter((t) => t !== null)
    if (s.found) this.view.found = s.found
    if (s.sounds) Object.assign(this.view.sounds, s.sounds)
    if (s.map) applyMapDelta(this.self.map, s.map)
    const mine = s.p.find((r) => r[0] === s.me)
    if (mine) {
      this.self.flickerLeft = mine[7]! & BIT.flicker ? 1 : 0
      this.self.tie = mine[9]! >= 0 ? { tree: mine[9]!, progress: mine[8]! / 100, removing: !!(mine[7]! & BIT.untie) } : null
    }
    if (s.you) {
      const you = s.you
      const restore = () => { Object.assign(this.self, { x: you[0], z: you[1], vx: you[2], vz: you[3], mapRaise: you[4] }) }
      if (first) {
        this.predictor.reset()
        restore()
        this.prev = { x: this.self.x, z: this.self.z }
        this.smoother.x = this.smoother.y = 0
      } else {
        const bx = this.self.x, bz = this.self.z
        this.predictor.reconcile(s.ack, restore, (cmd) => stepMotion(this.world, this.self, cmd, ROOM_FEEL, TICK_DT))
        this.smoother.correct(bx, bz, this.self.x, this.self.z)
        this.prev.x += this.self.x - bx
        this.prev.z += this.self.z - bz
      }
    }
    this.snaps.push(s.t, s, performance.now() / 1000)
  }

  frame(dt: number) {
    this.smoother.step(dt)
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
        p.yaw = lerpAngle(a[5]! / 1000, b[5]! / 1000, br.t)
        p.pitch = a[6]! / 1000 + (b[6]! / 1000 - a[6]! / 1000) * br.t
        p.light = !!(b[7]! & BIT.light)
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
