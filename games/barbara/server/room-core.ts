import { type Activity, type IdleState, RoomCore } from "@arcade/kit/net/room-core"
import { VoiceRoom, type VoiceIce } from "@arcade/kit/net/voice"
import { BUILD } from "../shared/build.gen"
import {
  decodeClient, encodeServer, GRACE_MS, intentOps, MAX_PLAYERS, nightWire, playerRow, ROOM_FEEL, roundTrail, SNAP_EVERY, tapeRow, TEAM, TICK_DT,
  type ClientMsg, type Hello, type MapDelta, type PlayerRow, type RosterRow, type ServerMsg, type Snapshot,
} from "../shared/protocol"
import { addHuman, createWoods, removePlayer, setBotCount, stepWoods, type MapKnowledge, type PlayerInput, type WoodsEvent, type WoodsState } from "../shared/sim"
import { makeWorld, type WoodsWorld } from "../shared/world"

/** What a seat has already been sent, so a snapshot carries only what changed (the socket is reliable and ordered). */
type Sent = { found: number; names: string; trail: number; tapes: Set<number>; markers: number; clues: number; heard: Map<number, { serial: number; len: number }>; seed: number; night: number }
const fresh = (seed = NaN): Sent => ({ found: -1, names: "", trail: 0, tapes: new Set(), markers: -1, clues: -1, heard: new Map(), seed, night: -1 })

const HOLD_TICKS = 9

/** What changed on a map since `sent` (which it updates): new path points, tape ids learned and gone, copied paths' new points. */
function mapDelta(m: MapKnowledge, sent: Sent, reset: boolean): MapDelta | null {
  const d: MapDelta = { from: sent.trail, trail: roundTrail(m.trail, sent.trail) }
  if (reset) d.reset = true
  sent.trail = m.trail.length
  const known = new Set(m.tapes)
  const learned = m.tapes.filter((t) => !sent.tapes.has(t)), gone = [...sent.tapes].filter((t) => !known.has(t))
  if (learned.length) d.tapes = learned
  if (gone.length) d.gone = gone
  sent.tapes = known
  if (m.markers.length !== sent.markers) { sent.markers = m.markers.length; d.markers = m.markers.slice() }
  if (m.clues.length !== sent.clues) { sent.clues = m.clues.length; d.clues = m.clues.slice() }
  const heard: NonNullable<MapDelta["heard"]> = []
  for (const h of m.heard) {
    const was = sent.heard.get(h.from)
    // Paths only grow at the end, so the same walker's longer copy is the old one plus new points.
    const same = !!was && was.serial === h.serial && was.len <= h.trail.length
    const at = same ? was!.len : 0
    if (!same || at < h.trail.length) heard.push({ from: h.from, at, trail: roundTrail(h.trail, at) })
    sent.heard.set(h.from, { serial: h.serial, len: h.trail.length })
  }
  const unheard = [...sent.heard.keys()].filter((from) => !m.heard.some((h) => h.from === from))
  for (const from of unheard) sent.heard.delete(from)
  if (heard.length) d.heard = heard
  if (unheard.length) d.unheard = unheard
  return reset || d.trail.length || d.tapes || d.gone || d.markers || d.clues || d.heard || d.unheard ? d : null
}

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
  /** The night being played; `again` replaces it with the next once one has ended. */
  state: WoodsState
  /** Nights this room has played (the next night's seed). */
  private nights = 0
  private readonly seed: number
  private readonly pids = new Map<string, number>()
  private readonly names = new Map<number, string>()
  private readonly away = new Set<number>()
  private readonly inputs = new Map<number, PlayerInput>()
  /** Each person's last applied input and how many ticks ago, to hold their keys over a tick the jitter buffer skips. */
  private readonly last = new Map<number, { input: PlayerInput; age: number }>()
  private readonly acks = new Map<number, number>()
  private readonly sent = new Map<string, Sent>()
  private events: WoodsEvent[] = []
  /** Bytes encoded per seat (bandwidth measurement). */
  readonly bytes = new Map<string, number>()

  constructor(code: string, clock: () => number = Date.now, world: WoodsWorld = makeWorld(), build = BUILD, ice?: () => Promise<VoiceIce>) {
    super({ code, build, title: "Woods", maxPlayers: MAX_PLAYERS, snapEvery: SNAP_EVERY, inputs: intentOps, clock, graceMs: GRACE_MS, idleKickMs: 20 * 60_000, idleWarnMs: 30_000 })
    this.world = world
    this.voice = new VoiceRoom(ice, clock)
    this.seed = codeSeed(code)
    this.state = createWoods(world, TEAM, this.seed, [])
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
    this.last.delete(pid)
    this.acks.delete(pid)
    this.fillBots()
  }
  protected override dropped(id: string) {
    const pid = this.pids.get(id)
    if (pid === undefined) return
    this.away.add(pid)
    // Keys held when the socket dropped don't replay on reconnect.
    this.last.delete(pid)
  }
  protected push(id: string, seq: number, intent: PlayerInput) {
    const pid = this.pids.get(id)
    // A dropped seat's buffered stand-ins don't walk them on: they wait where they were.
    if (pid === undefined || this.away.has(pid)) return
    this.inputs.set(pid, intent)
    this.last.set(pid, { input: intent, age: 0 })
    this.acks.set(pid, seq)
  }
  protected activity(intent: PlayerInput, a: Activity) {
    const moved = intent.mx !== 0 || intent.mz !== 0 || intent.tie || intent.map || Math.abs(intent.yaw - a.aim) > 0.01
    a.aim = intent.yaw
    return moved
  }
  /** The next night: a new layout from the room's seed, everyone back at camp with fresh torches and clean maps. */
  private again() {
    const n = this.state.night
    if (n.phase !== "won" && n.phase !== "lost") return
    this.nights++
    this.state = createWoods(this.world, 0, (this.seed + Math.imul(this.nights, 7919)) >>> 0, [])
    for (const [, pid] of [...this.pids].sort((a, b) => a[1] - b[1])) addHuman(this.state, this.world, pid, this.names.get(pid) ?? `Hiker ${pid}`)
    this.fillBots()
    this.last.clear()
  }
  protected handle(id: string, msg: ClientMsg) {
    if (msg.type === "again") { if (this.pids.has(id)) this.again(); return }
    const pid = this.pids.get(id), p = this.state.players.find((q) => q.id === pid)
    if (msg.type !== "name" || pid === undefined || !p) return
    this.names.set(pid, msg.name)
    p.name = msg.name
  }
  protected idleState(id: string): IdleState {
    return this.pids.has(id) ? "play" : "gone"
  }
  protected stepWorld() {
    // A tick without a fresh input (the jitter buffer balancing a stand-in, or a short stall) keeps the person's held
    // keys and look but doesn't walk them; after `HOLD_TICKS`, or once dropped, they stand still with hands down.
    for (const [pid, l] of this.last) {
      if (this.inputs.has(pid) || this.away.has(pid) || ++l.age > HOLD_TICKS) continue
      this.inputs.set(pid, { ...l.input, mx: 0, mz: 0, sprint: false })
    }
    stepWoods(this.state, this.world, this.inputs, TICK_DT, ROOM_FEEL)
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
    const s = this.state
    // A join, a reconnect or a new night sends everything again.
    const reset = !ents || this.sent.get(id)?.seed !== s.night.seed
    if (reset) { this.sent.set(id, fresh(s.night.seed)); this.away.delete(pid) }
    const sent = this.sent.get(id)!
    const me = s.players.find((p) => p.id === pid)
    const snap: Snapshot = { type: "s", t: Math.round(s.t * 1000) / 1000, ack: this.acks.get(pid) ?? -1, me: pid, p: ents ?? this.entities() }
    if (me) snap.you = [me.x, me.z, me.vx, me.vz, me.mapRaise].map((v) => Math.round(v * 1e5) / 1e5)
    const names = s.players.map((p) => `${p.id}:${p.name}`).join("|")
    if (names !== sent.names) { sent.names = names; snap.names = Object.fromEntries(s.players.map((p) => [p.id, p.name])) }
    if (s.rev.found !== sent.found) { sent.found = s.rev.found; snap.found = s.found }
    if (reset) { snap.tapes = s.tapes.map(tapeRow); snap.distant = { ...s.distant, rng: { ...s.distant.rng }, recent: [...s.distant.recent] } }
    if (s.night.rev !== sent.night) { sent.night = s.night.rev; snap.night = nightWire(s.night) }
    if (me) {
      const map = mapDelta(me.map, sent, reset)
      if (map) snap.map = map
    }
    this.bytes.set(id, (this.bytes.get(id) ?? 0) + JSON.stringify(snap).length)
    return snap
  }
}
