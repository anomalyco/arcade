import { ByteWriter } from "@arcade/kit/net/bytes"
import { AckHistory } from "@arcade/kit/net/interest"
import { lerp, lerpAngle, SnapshotBuffer } from "@arcade/kit/net/interpolate"
import { Predictor, Smoother } from "@arcade/kit/net/prediction"
import { createAIAgent, type AIAgent, type OutbreakAISubsystem } from "../shared/ai"
import type { OutbreakCombatSubsystem } from "../shared/combat"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { COOP_TUNING, DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { CoopSim, type SurvivorSlot } from "../shared/coop-sim"
import type { InteractionRegistry } from "../shared/interact"
import {
  applyZombieState,
  commandOps,
  decodeServerText,
  decodeSnapshot,
  encodeClientInText,
  packCommand,
  unpackCommand,
  type ClientMsg,
  type CommandTuple,
  type RemoteSurvivor,
  type RosterEntry,
  type ServerMsg,
  type SharedSnapshot,
  type VehicleState,
  type ZombieState,
} from "../shared/net-protocol"
import { slotView, type Command, type Session, type SessionView } from "../shared/session"
import type { OutbreakVehicleSubsystem } from "../shared/vehicles"
import { outbreakClientFeatures } from "./feature-registry"
import "./melee/index"
import "./progression"
import "./vehicles/index"

/** Seat colours, by seat index: torso, trousers. Also used for name tags. */
export const SURVIVOR_COLOURS: readonly { torso: number; legs: number; css: string }[] = [
  { torso: 0x8c6b42, legs: 0x41474b, css: "#d6a35c" },
  { torso: 0x3f6b8c, legs: 0x3a3f46, css: "#6fb4e8" },
  { torso: 0x7d3b3b, legs: 0x463a35, css: "#e07a6a" },
  { torso: 0x4f7a43, legs: 0x3d4238, css: "#8fd17a" },
]

export type KeyValueStore = { getItem(key: string): string | null; setItem(key: string, value: string): void }

export type NetSessionOptions = {
  url: string
  room: string
  name: string
  storage?: KeyValueStore
  /** Interpolation delay for remote survivors and zombies, in seconds. */
  delay?: number
  now?: () => number
  WebSocket?: typeof WebSocket
  /** The server runs different shared code; the page should reload into the same room. */
  onReload?: () => void
}

const TOKEN_KEY = "outbreak.coop.token."
const STATUS_CONNECTING = "Connecting to room…"

/**
 * A co-op room as a `Session`: the local survivor is predicted with the room's own simulation code and reconciled
 * on every snapshot; remote survivors, zombies and the clock render 100 ms behind, between two snapshots; doors,
 * windows, barricades, containers, drops and the bench (ledger deltas) apply as soon as they arrive.
 */
export class NetSession implements Session {
  readonly sim: CoopSim
  local: SurvivorSlot
  readonly view: SessionView
  readonly predictor = new Predictor<Command>()
  readonly smoother = new Smoother(14, 2.5)
  readonly snapshots: SnapshotBuffer<SharedSnapshot>
  readonly snapHistory = new AckHistory<SharedSnapshot>(32)
  roster: RosterEntry[] = []
  id = ""
  index = 0
  status: string | null = STATUS_CONNECTING
  rtt = 0
  /** Bytes received (all frames) and snapshots decoded, for bandwidth measurements. */
  bytesIn = 0
  snapshotCount = 0
  bytesOut = 0
  lastAck = -1
  lastServerTick = 0
  replayed = 0
  private ws: WebSocket | null = null
  private outbox: CommandTuple[] = []
  private outboxSeq = 0
  private prevSent: CommandTuple[] = []
  private prevSentSeq = 0
  private outWriter = new ByteWriter(64)
  private agents = new Map<number, AIAgent>()
  private readonly prevZombies = new Map<number, ZombieState>()
  private readonly seenZombies = new Set<number>()
  private readonly prevSurvivors = new Map<number, RemoteSurvivor>()
  private readonly presentSurvivors = new Set<number>()
  private lastAppliedRevision = -1
  private retries = 0
  private closed = false
  private welcomed = false
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number
  private readonly storage: KeyValueStore | undefined

  constructor(private readonly options: NetSessionOptions) {
    const o = DEFAULT_COOP_ROOM
    this.sim = new CoopSim(o.seed, o.houseSeed, o.terrain, { zombieCount: 0 })
    this.local = this.sim.addSurvivor("local", 0)
    this.view = slotView(this.sim, () => this.local)
    this.snapshots = new SnapshotBuffer(options.delay ?? 0.1)
    this.now = options.now ?? (() => performance.now() / 1000)
    this.storage = options.storage
    this.open()
  }

  get ai(): OutbreakAISubsystem {
    return this.sim.ai
  }

  get combat(): OutbreakCombatSubsystem {
    return this.sim.combat
  }

  get vehicles(): OutbreakVehicleSubsystem {
    return this.sim.vehicles
  }

  get registry(): InteractionRegistry {
    return this.sim.registry
  }

  get connected(): boolean {
    return this.welcomed && this.ws?.readyState === 1
  }

  /** Remote survivors currently in the world (not the local one). */
  get remotes(): SurvivorSlot[] {
    return this.sim.slots.filter((s) => s !== this.local)
  }

  nameOf(index: number): string {
    return this.roster.find((r) => r.index === index)?.name ?? `Survivor ${index + 1}`
  }

  /** One fixed 60 Hz tick of local input: quantized identically to the wire, predicted at once, sent in batches. */
  update(_dt: number, command: Command): void {
    if (!this.welcomed) return
    const tuple = packCommand(command)
    const quantCmd = unpackCommand(tuple)
    const seq = this.predictor.record(quantCmd)
    if (!this.outbox.length) this.outboxSeq = seq
    this.outbox.push(tuple)
    this.sim.stepSurvivor(this.local, quantCmd, TICK_DT, COOP_TUNING, true)
    this.sim.refreshPrompt(this.local)
    if (this.outbox.length >= 2) this.flush()
  }

  flush(): void {
    if (!this.outbox.length) return
    // Re-send the previous batch when it contained a one-shot edge so a dropped packet never loses an action
    const includePrev =
      this.prevSent.length > 0 &&
      this.prevSentSeq + this.prevSent.length === this.outboxSeq &&
      this.prevSentSeq + this.prevSent.length - 1 > this.lastAck &&
      this.prevSent.some((t) => commandOps.hasEdges(unpackCommand(t)))
    const startSeq = includePrev ? this.prevSentSeq : this.outboxSeq
    const batch = includePrev ? [...this.prevSent, ...this.outbox] : this.outbox
    const renderSec = this.snapshots.size > 0 ? Math.max(0, this.snapshots.renderTime(this.now())) : 0
    const viewTick = renderSec > 0 ? Math.round(renderSec / TICK_DT) : 0
    this.sendRaw(encodeClientInText(startSeq, batch, this.lastServerTick, viewTick, this.outWriter))
    this.prevSent = this.outbox.slice(-2)
    this.prevSentSeq = this.outboxSeq + this.outbox.length - this.prevSent.length
    this.outbox = []
  }

  /** Call once per rendered frame: advances smoothing and places remote survivors and zombies. */
  sync(dt: number): void {
    this.flush()
    this.smoother.step(dt)
    const bracket = this.snapshots.sample(this.now())
    if (!bracket) return
    const { a, b, t } = bracket
    const span = Math.max(1e-3, b.time - a.time)
    this.sim.time = lerp(a.time, b.time, t)
    this.sim.hour = Math.abs(b.hour - a.hour) > 12 ? b.hour : lerp(a.hour, b.hour, t)
    this.placeZombies(a, b, t, span)
    this.placeSurvivors(a, b, t, span)
    outbreakClientFeatures.syncNetFrame(this, a, b, t, span)
    const shots = this.sim.combat.shots
    for (let i = shots.length - 1; i >= 0; i--) if (this.sim.time - shots[i]!.time > 0.6) shots.splice(i, 1)
  }

  close(): void {
    this.closed = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.ws?.close()
  }

  rebuildCollision(): void {
    this.sim.rebuildSolids()
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState !== 1) return
    const data = JSON.stringify(msg)
    this.bytesOut += data.length
    this.ws.send(data)
  }

  private sendRaw(data: string): void {
    if (this.ws?.readyState !== 1) return
    this.bytesOut += data.length
    this.ws.send(data)
  }

  private open(): void {
    const Impl = this.options.WebSocket ?? WebSocket
    const ws = new Impl(this.options.url)
    ws.binaryType = "arraybuffer"
    this.ws = ws
    ws.onopen = () => {
      this.retries = 0
      const token = this.storage?.getItem(TOKEN_KEY + this.options.room) ?? undefined
      this.send({ t: "hello", name: this.options.name, token, build: BUILD })
    }
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string") {
        this.bytesIn += e.data.length
        const msg = decodeServerText(e.data)
        if (msg) this.receive(msg)
        return
      }
      const bytes = new Uint8Array(e.data as ArrayBuffer)
      this.bytesIn += bytes.byteLength
      this.receiveSnapshot(bytes)
    }
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws || this.closed) return
      this.ws = null
      this.welcomed = false
      if (e.code === 4001 || e.code === 4003 || e.code === 4004) return
      this.status = "Connection lost. Reconnecting…"
      setTimeout(() => !this.closed && this.open(), Math.min(4000, 300 * 2 ** this.retries++))
    }
    if (!this.pingTimer) {
      this.pingTimer = setInterval(
        () => this.send({ t: "ping", c: this.now(), ...(this.lastServerTick > 0 ? { a: this.lastServerTick } : {}) }),
        2000,
      )
    }
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case "welcome": {
        this.storage?.setItem(TOKEN_KEY + this.options.room, msg.token)
        const o = DEFAULT_COOP_ROOM
        if (msg.seed !== o.seed || msg.houseSeed !== o.houseSeed || msg.terrain !== o.terrain) {
          this.status = "This room plays a different neighbourhood. Reload the page."
          this.close()
          return
        }
        this.id = msg.id
        if (this.local.index !== msg.index || this.local.id !== msg.id) {
          const old = this.local.survivor
          this.sim.removeSurvivor(this.local.id)
          this.local = this.sim.addSurvivor(msg.id, msg.index)
          Object.assign(this.local.survivor, { aim: old.aim })
        }
        this.index = msg.index
        this.predictor.reset()
        this.outbox = []
        this.prevSent = []
        this.lastServerTick = 0
        this.lastAppliedRevision = -1
        this.snapHistory.clear()
        this.snapshots.clear()
        this.welcomed = true
        this.status = null
        return
      }
      case "roster":
        this.roster = msg.players
        return
      case "pong":
        this.rtt = Math.max(0, this.now() - msg.c)
        return
      case "error":
        this.status = msg.message
        this.closed = true
        return
      case "reload":
        this.closed = true
        this.status = "A new version of Outbreak is out. Reloading…"
        this.options.onReload?.()
    }
  }

  private receiveSnapshot(bytes: Uint8Array): void {
    if (!this.welcomed) return
    const { personal, shared } = decodeSnapshot(bytes, this.sim.town.seed, this.snapHistory)
    if (shared.tick > this.lastServerTick) this.lastServerTick = shared.tick
    this.snapshotCount++
    this.applyWorld(shared)
    const p = this.local.survivor
    const beforeX = p.x
    const beforeY = p.y
    this.lastAck = personal.ack
    this.replayed = this.predictor.reconcile(
      personal.ack,
      () => {
        Object.assign(p, personal.survivor)
        outbreakClientFeatures.reconcileNetLocal(this, personal, shared)
      },
      (cmd) => this.sim.stepSurvivor(this.local, cmd, TICK_DT, COOP_TUNING, true),
    )
    this.smoother.correct(beforeX, beforeY, p.x, p.y)
    if (personal.ledger) this.sim.progression.ledger.applyDelta(personal.ledger)
    if (personal.notices.length) this.local.notices.push(...personal.notices)
    this.sim.refreshPrompt(this.local)
    this.snapshots.push(shared.tick * TICK_DT, shared, this.now())
  }

  /** Discrete shared state applies on arrival so collision and prompts match the room before replaying input. */
  private applyWorld(s: SharedSnapshot): void {
    const sim = this.sim
    // Sync survivor slots from snapshot first so active chunk windows match the server's union of survivor windows
    for (const r of s.survivors) {
      if (r.index === this.local.index) continue
      const id = this.roster.find((e) => e.index === r.index)?.id ?? `remote${r.index}`
      let slot = sim.slots.find((sl) => sl.index === r.index)
      if (!slot) slot = sim.addSurvivor(id, r.index)
      slot.survivor.x = r.x
      slot.survivor.y = r.y
    }
    const meSnap = s.survivors.find((r) => r.index === this.local.index)
    let chunksChanged = false
    if (meSnap) {
      const savedX = this.local.survivor.x
      const savedY = this.local.survivor.y
      this.local.survivor.x = meSnap.x
      this.local.survivor.y = meSnap.y
      chunksChanged = sim.syncWorldChunks()
      this.local.survivor.x = savedX
      this.local.survivor.y = savedY
    } else {
      chunksChanged = sim.syncWorldChunks()
    }
    const town = sim.town
    let topology = false
    if (chunksChanged || s.revision !== this.lastAppliedRevision) {
      this.lastAppliedRevision = s.revision
      town.doors.forEach((d, i) => {
        const n = s.doors[i]
        if (!n) return
        if (d.open !== n.open) topology = true
        d.open = n.open
        if (n.locked) d.locked = true
        else if (d.locked !== undefined) d.locked = false
      })
      town.windows.forEach((w, i) => {
        const n = s.windows[i]
        if (!n) return
        if (w.open !== n.open) topology = true
        w.open = n.open
        w.openable = n.openable
      })
      const portals = [...town.doors.map((d) => d.id), ...town.windows.map((w) => w.id)]
      portals.forEach((id, i) => {
        const st = sim.ai.portalStates.get(id)
        if (!st) return
        const planks = s.planks[i] ?? 0
        if (st.barricadePlanks !== planks) topology = true
        st.barricadePlanks = planks
        st.barricadeHp = planks * 100
      })
    }
    if (s.bashes.length) {
      const portals = [...town.doors.map((d) => d.id), ...town.windows.map((w) => w.id)]
      for (const bash of s.bashes) {
        const st = sim.ai.portalStates.get(portals[bash.portal] ?? "")
        if (st) st.lastBashTime = s.time - bash.age
      }
    }
    const shots = sim.combat.shots
    for (const shot of s.shots) if (!shots.some((x) => x.id === shot.id)) shots.push(shot)
    if (outbreakClientFeatures.applyNetWorld(this, s)) {
      topology = true
    }
    if (topology) {
      sim.revision++
      sim.rebuildSolids()
    }
  }

  private placeZombies(a: SharedSnapshot, b: SharedSnapshot, t: number, span: number): void {
    const prev = this.prevZombies
    prev.clear()
    for (let i = 0; i < a.zombies.length; i++) {
      const z = a.zombies[i]!
      prev.set(z.id, z)
    }
    const list = this.sim.ai.agents
    list.length = 0
    const seen = this.seenZombies
    seen.clear()
    for (let i = 0; i < b.zombies.length; i++) {
      const z = b.zombies[i]!
      let agent = this.agents.get(z.id)
      if (!agent) {
        agent = createAIAgent(z.id, z.seed, z.x, z.y, z.aim)
        this.agents.set(z.id, agent)
      }
      const p = prev.get(z.id) ?? z
      const teleport = Math.hypot(z.x - p.x, z.y - p.y) > 4
      agent.x = teleport ? z.x : lerp(p.x, z.x, t)
      agent.y = teleport ? z.y : lerp(p.y, z.y, t)
      agent.aim = lerpAngle(p.aim, z.aim, t)
      agent.vx = teleport ? 0 : (z.x - p.x) / span
      agent.vy = teleport ? 0 : (z.y - p.y) / span
      applyZombieState(agent, t < 0.5 ? p : z)
      list.push(agent)
      seen.add(z.id)
    }
    for (const id of this.agents.keys()) if (!seen.has(id)) this.agents.delete(id)
  }

  private placeSurvivors(a: SharedSnapshot, b: SharedSnapshot, t: number, span: number): void {
    const prev = this.prevSurvivors
    prev.clear()
    for (let i = 0; i < a.survivors.length; i++) {
      const s = a.survivors[i]!
      prev.set(s.index, s)
    }
    const present = this.presentSurvivors
    present.clear()
    for (let i = 0; i < b.survivors.length; i++) {
      const r = b.survivors[i]!
      if (r.index === this.local.index) continue
      present.add(r.index)
      const id = this.roster.find((e) => e.index === r.index)?.id ?? `remote${r.index}`
      let slot = this.sim.slots.find((s) => s.index === r.index)
      if (!slot) slot = this.sim.addSurvivor(id, r.index)
      writeRemote(slot, prev.get(r.index) ?? r, r, t, span)
    }
    for (let i = this.sim.slots.length - 1; i >= 0; i--) {
      const slot = this.sim.slots[i]!
      if (slot !== this.local && !present.has(slot.index)) this.sim.removeSurvivor(slot.id)
    }
  }
}

function writeRemote(slot: SurvivorSlot, a: RemoteSurvivor, b: RemoteSurvivor, t: number, span: number): void {
  const p = slot.survivor
  const teleport = Math.hypot(b.x - a.x, b.y - a.y) > 4
  p.x = teleport ? b.x : lerp(a.x, b.x, t)
  p.y = teleport ? b.y : lerp(a.y, b.y, t)
  p.aim = lerpAngle(a.aim, b.aim, t)
  p.vx = teleport ? 0 : (b.x - a.x) / span
  p.vy = teleport ? 0 : (b.y - a.y) / span
  p.flashlightOn = b.flashlightOn
  p.flashlightOutput = lerp(a.flashlightOutput, b.flashlightOutput, t)
  p.sprinting = b.sprinting
  p.exhausted = b.exhausted
  p.meleeWeapon = b.meleeWeapon ?? null
  p.equippedItem = b.meleeWeapon ? b.meleeWeapon : b.pistol ? "pistol" : "hands"
  p.meleePhase = b.meleePhase ?? "idle"
  p.meleeCombo = b.meleeCombo ?? 1
  p.meleePhaseDuration = b.meleePhase && b.meleePhase !== "idle" ? 0.14 : 0
  p.meleePhaseTime = b.meleePhase && b.meleePhase !== "idle" ? (b.meleeProgress ?? 0.5) * 0.14 : 0
  p.reloadRemaining = b.reloading ? 0.5 : 0
  p.health = b.health
  p.recoil = lerp(a.recoil, b.recoil, t)
  remoteLift.set(slot, lerp(a.lift, b.lift, t))
}

/** Vault height of a remote survivor (its vault state itself is not replicated). */
export const remoteLift = new WeakMap<SurvivorSlot, number>()
