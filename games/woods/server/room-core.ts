import { type Activity, type IdleState, RoomCore } from "@arcade/kit/net/room-core"
import { BUILD } from "../shared/build.gen"
import {
  decodeClient, encodeServer, GRACE_MS, intentOps, MAX_PLAYERS, playerRow, ROOM_FEEL, roundTrail, SNAP_EVERY, tapeRow, TEAM, TICK_DT,
  type ClientMsg, type Hello, type PlayerRow, type RosterRow, type ServerMsg, type Snapshot,
} from "../shared/protocol"
import { addHuman, createWoods, removePlayer, setBotCount, stepWoods, type PlayerInput, type WoodsEvent, type WoodsState } from "../shared/sim"
import { makeWorld, type WoodsWorld } from "../shared/world"

/** What a seat has already been sent, so a snapshot carries only what changed (the socket is reliable and ordered). */
type Sent = { tapes: number; found: number; names: string; trail: number; mapTapes: number; mapMarkers: number; heard: string }
const fresh = (): Sent => ({ tapes: -1, found: -1, names: "", trail: 0, mapTapes: -1, mapMarkers: -1, heard: "" })

/** Room seed from its code, so each room's bots and flicker differ while the forest stays the printed one. */
function codeSeed(code: string): number {
  let h = 2166136261
  for (let i = 0; i < code.length; i++) h = Math.imul(h ^ code.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * One room's night: the authoritative `stepWoods` at 30 Hz for 2–6 people, with bots walking the empty places up to
 * `TEAM`. Seats, reconnect tokens, the input jitter buffer, rate limits and the idle kick are `@arcade/kit/net/room-core`.
 */
export class WoodsRoomCore extends RoomCore<ClientMsg, PlayerInput, RosterRow, WoodsEvent, PlayerRow[], ServerMsg> {
  readonly world: WoodsWorld
  readonly state: WoodsState
  private readonly pids = new Map<string, number>()
  private readonly names = new Map<number, string>()
  private readonly away = new Set<number>()
  private readonly inputs = new Map<number, PlayerInput>()
  private readonly acks = new Map<number, number>()
  private readonly sent = new Map<string, Sent>()
  private events: WoodsEvent[] = []
  /** Bytes encoded per seat (bandwidth measurement). */
  readonly bytes = new Map<string, number>()

  constructor(code: string, clock: () => number = Date.now, world: WoodsWorld = makeWorld(), build = BUILD) {
    super({ code, build, title: "Woods", maxPlayers: MAX_PLAYERS, snapEvery: SNAP_EVERY, inputs: intentOps, clock, graceMs: GRACE_MS, idleKickMs: 20 * 60_000, idleWarnMs: 30_000 })
    this.world = world
    this.state = createWoods(world, TEAM, codeSeed(code), [])
  }

  /** People holding a seat, connected or within their grace window. */
  get humans(): number {
    return this.pids.size
  }

  private fillBots() {
    setBotCount(this.state, this.world, Math.max(0, TEAM - this.pids.size))
  }

  protected decode(raw: unknown) {
    return decodeClient(raw)
  }
  protected encode(msg: ServerMsg) {
    return encodeServer(msg)
  }
  protected hasPlayer(id: string) {
    return this.pids.has(id)
  }
  protected join(id: string, hello: Hello) {
    let pid = 1
    while ([...this.pids.values()].includes(pid)) pid++
    this.pids.set(id, pid)
    const name = hello.name || `Hiker ${pid}`
    this.names.set(pid, name)
    // A person takes a bot's place: the bot leaves first so the new arrival stands at camp with the others.
    setBotCount(this.state, this.world, Math.max(0, TEAM - this.pids.size))
    addHuman(this.state, this.world, pid, name)
  }
  protected leave(id: string) {
    const pid = this.pids.get(id)
    this.pids.delete(id)
    this.sent.delete(id)
    if (pid === undefined) return
    removePlayer(this.state, pid)
    this.names.delete(pid)
    this.away.delete(pid)
    this.inputs.delete(pid)
    this.acks.delete(pid)
    this.fillBots()
  }
  protected override dropped(id: string) {
    const pid = this.pids.get(id)
    if (pid !== undefined) this.away.add(pid)
  }
  protected push(id: string, seq: number, intent: PlayerInput) {
    const pid = this.pids.get(id)
    // A dropped seat's buffered stand-ins don't walk them on: they wait where they were.
    if (pid === undefined || this.away.has(pid)) return
    this.inputs.set(pid, intent)
    this.acks.set(pid, seq)
  }
  protected activity(intent: PlayerInput, a: Activity) {
    const moved = intent.mx !== 0 || intent.mz !== 0 || intent.tie || intent.map || Math.abs(intent.yaw - a.aim) > 0.01
    a.aim = intent.yaw
    return moved
  }
  protected handle(id: string, msg: ClientMsg) {
    const pid = this.pids.get(id), p = this.state.players.find((q) => q.id === pid)
    if (msg.type !== "name" || pid === undefined || !p) return
    this.names.set(pid, msg.name)
    p.name = msg.name
  }
  protected idleState(id: string): IdleState {
    return this.pids.has(id) ? "play" : "gone"
  }
  protected stepWorld() {
    stepWoods(this.state, this.world, this.inputs, TICK_DT, ROOM_FEEL)
    // Held keys only last while inputs arrive: a stalled or dropped person stands still.
    this.inputs.clear()
    this.events.push(...this.state.events)
  }
  protected takeEvents(): WoodsEvent[] {
    const out = this.events
    this.events = []
    return out
  }
  protected roster(): RosterRow[] {
    return [...this.pids].map(([id, pid]) => ({ id, pid, name: this.names.get(pid) ?? `Hiker ${pid}`, connected: !this.away.has(pid) }))
  }
  protected entities(): PlayerRow[] {
    return this.state.players.map((p) => playerRow(p, this.away.has(p.id)))
  }
  /** Without `ents` (a join or a reconnect) the snapshot carries everything again. */
  protected snapshot(id: string, ents?: PlayerRow[]): ServerMsg {
    const pid = this.pids.get(id) ?? -1
    if (!ents) { this.sent.set(id, fresh()); this.away.delete(pid) }
    const sent = this.sent.get(id) ?? fresh()
    this.sent.set(id, sent)
    const s = this.state, me = s.players.find((p) => p.id === pid)
    const snap: Snapshot = { type: "s", t: Math.round(s.t * 1000) / 1000, ack: this.acks.get(pid) ?? -1, me: pid, p: ents ?? this.entities() }
    if (me) snap.you = [me.x, me.z, me.vx, me.vz, me.mapRaise].map((v) => Math.round(v * 1e5) / 1e5)
    const names = s.players.map((p) => `${p.id}:${p.name}`).join("|")
    if (names !== sent.names) { sent.names = names; snap.names = Object.fromEntries(s.players.map((p) => [p.id, p.name])) }
    if (s.rev.tapes !== sent.tapes) { sent.tapes = s.rev.tapes; snap.tapes = s.tapes.map(tapeRow) }
    if (s.rev.found !== sent.found) { sent.found = s.rev.found; snap.found = s.found }
    if (!ents) snap.sounds = { seed: s.sounds.seed, next: s.sounds.next }
    if (me) {
      const m = me.map, heard = m.heard.map((h) => `${h.from}:${h.trail.length}`).join("|")
      const map: NonNullable<Snapshot["map"]> = { from: sent.trail, trail: roundTrail(m.trail, sent.trail) }
      if (m.tapes.length !== sent.mapTapes) { sent.mapTapes = m.tapes.length; map.tapes = m.tapes }
      if (m.markers.length !== sent.mapMarkers) { sent.mapMarkers = m.markers.length; map.markers = m.markers }
      if (heard !== sent.heard) { sent.heard = heard; map.heard = m.heard.map((h) => ({ from: h.from, trail: roundTrail(h.trail) })) }
      if (map.trail.length || map.tapes || map.markers || map.heard) { sent.trail = m.trail.length; snap.map = map }
    }
    this.bytes.set(id, (this.bytes.get(id) ?? 0) + JSON.stringify(snap).length)
    return snap
  }
}
