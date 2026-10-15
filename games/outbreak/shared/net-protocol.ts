import { ByteReader, ByteWriter, frame, packAngle, unframe, unpackAngle } from "@arcade/kit/net/bytes"
import type { InputOps } from "@arcade/kit/net/jitter-buffer"
import type { AIAgent, AIState } from "./ai"
import type { CombatShotEvent } from "./combat"
import { createSurvivor, type CoopSim } from "./coop-sim"
import type { InteractActionId } from "./interact"
import type { LedgerDelta } from "@arcade/kit/sim/ledger"
import type { Notice, PickMode } from "./progression"
import type { Command, Survivor } from "./session"

/** Co-op wire protocol. Text frames are JSON control messages; binary frames are snapshots. */
export const SNAPSHOT_EVERY = 3
export const MAX_NAME = 16
export const ROOM_CODE = /^[a-z0-9]{4,8}$/

export type RosterEntry = { id: string; index: number; name: string; connected: boolean }

export type ClientMsg =
  | { t: "hello"; name: string; token?: string; build: string }
  /** Commands `s`, `s+1`, … for consecutive 60 Hz ticks. */
  | { t: "in"; s: number; c: CommandTuple[] }
  | { t: "ping"; c: number }

export type ServerMsg =
  | {
      t: "welcome"
      id: string
      token: string
      index: number
      room: string
      seed: number
      houseSeed: number
      terrain: number
      zombieCount: number
    }
  | { t: "roster"; players: RosterEntry[] }
  | { t: "error"; message: string }
  | { t: "reload" }
  | { t: "pong"; c: number }

export function decodeClient(raw: unknown): ClientMsg | null {
  if (typeof raw !== "string" || raw.length > 8192) return null
  let m: unknown
  try {
    m = JSON.parse(raw)
  } catch {
    return null
  }
  if (!m || typeof m !== "object") return null
  const o = m as Record<string, unknown>
  if (o.t === "hello" && typeof o.build === "string")
    return {
      t: "hello",
      name: typeof o.name === "string" ? o.name : "",
      token: typeof o.token === "string" ? o.token.slice(0, 64) : undefined,
      build: o.build,
    }
  if (o.t === "in" && Number.isSafeInteger(o.s) && Array.isArray(o.c) && o.c.length <= 64) return { t: "in", s: o.s as number, c: o.c as CommandTuple[] }
  if (o.t === "ping" && typeof o.c === "number") return { t: "ping", c: o.c }
  return null
}

export function decodeServerText(raw: string): ServerMsg | null {
  try {
    const m = JSON.parse(raw) as ServerMsg
    return m && typeof m === "object" && typeof m.t === "string" ? m : null
  } catch {
    return null
  }
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────────

/** [mx, my, aim, flags, hotbarSlot (−1 none), hotbarDelta, interactAction code, pick code (mode·8 + index + 1)] */
export type CommandTuple = [number, number, number, number, number?, number?, number?, number?]

const FLAG = {
  interact: 1,
  interactHeld: 2,
  flashlight: 4,
  sprint: 8,
  jump: 16,
  fire: 32,
  reload: 64,
  melee: 128,
  barricade: 256,
  drop: 512,
  bundle: 1024,
  ping: 2048,
} as const
const FLAG_MAX = 4095
const ACTIONS: readonly (InteractActionId | undefined)[] = [undefined, "toggle", "lock", "peek", "climb", "search", "barricade", "smash", "take", "deposit", "store", "unlock", "pry"]
const PICKS: readonly PickMode[] = ["take", "bench", "craft", "pack"]

const q3 = (v: number) => Math.round(v * 1000) / 1000

export function packCommand(c: Command): CommandTuple {
  let flags = 0
  for (const k of Object.keys(FLAG) as (keyof typeof FLAG)[]) if (c[k]) flags |= FLAG[k]
  const t: CommandTuple = [q3(c.mx), q3(c.my), q3(c.aim), flags]
  const action = c.interactAction ? Math.max(0, ACTIONS.indexOf(c.interactAction)) : 0
  const pick = c.pick ? PICKS.indexOf(c.pick.mode) * 8 + c.pick.index + 1 : 0
  if (c.hotbarSlot !== undefined || c.hotbarDelta || action || pick) t.push(c.hotbarSlot ?? -1, c.hotbarDelta ?? 0, action)
  if (pick) t.push(pick)
  return t
}

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0)

/** Validates a client tuple into a command. Never throws. */
export function unpackCommand(t: unknown): Command {
  const a = Array.isArray(t) ? t : []
  const flags = num(a[3], 0, FLAG_MAX) | 0
  const c: Command = { mx: num(a[0], -1.5, 1.5), my: num(a[1], -1.5, 1.5), aim: num(a[2], -100, 100), interact: false }
  for (const k of Object.keys(FLAG) as (keyof typeof FLAG)[]) if (flags & FLAG[k]) c[k] = true
  const slot = num(a[4], -1, 9) | 0
  if (slot >= 0 && a.length > 4) c.hotbarSlot = slot
  const delta = num(a[5], -9, 9) | 0
  if (delta) c.hotbarDelta = delta
  const action = ACTIONS[num(a[6], 0, ACTIONS.length - 1) | 0]
  if (action) c.interactAction = action
  const pick = num(a[7], 0, PICKS.length * 8) | 0
  if (pick > 0) c.pick = { mode: PICKS[Math.floor((pick - 1) / 8)]!, index: (pick - 1) % 8 }
  return c
}

const EDGE_KEYS = ["interact", "flashlight", "jump", "fire", "reload", "melee", "barricade", "drop", "bundle", "ping"] as const

/** Jitter-buffer semantics: movement is held, presses are one-shot edges. */
export const commandOps: InputOps<Command> = {
  merge(earlier, later) {
    const out: Command = { ...later }
    for (const k of EDGE_KEYS) if (earlier[k]) out[k] = true
    if (earlier.interactAction && !later.interactAction) out.interactAction = earlier.interactAction
    if (earlier.hotbarSlot !== undefined && later.hotbarSlot === undefined) out.hotbarSlot = earlier.hotbarSlot
    if (earlier.hotbarDelta) out.hotbarDelta = (later.hotbarDelta ?? 0) + earlier.hotbarDelta
    if (earlier.pick && !later.pick) out.pick = earlier.pick
    return out
  },
  standIn(last) {
    return { mx: last.mx, my: last.my, aim: last.aim, sprint: last.sprint, interactHeld: last.interactHeld, interact: false }
  },
  hasEdges(c) {
    return EDGE_KEYS.some((k) => c[k]) || c.hotbarSlot !== undefined || Boolean(c.hotbarDelta) || Boolean(c.interactAction) || Boolean(c.pick)
  },
}

// ── Snapshots ───────────────────────────────────────────────────────────────────────────────────────────────────

const STATES: readonly AIState[] = ["wander", "investigate", "alert", "chase", "bash", "search", "stagger", "dead"]
const BONES: readonly CombatShotEvent["detachBone"][] = [null, "head", "left.upperArm", "right.upperArm", "right.foreArm"]

export type RemoteSurvivor = {
  index: number
  x: number
  y: number
  aim: number
  flashlightOn: boolean
  sprinting: boolean
  pistol: boolean
  reloading: boolean
  exhausted: boolean
  flashlightOutput: number
  health: number
  recoil: number
  lift: number
}

export type ZombieState = {
  id: number
  seed: number
  x: number
  y: number
  aim: number
  state: AIState
  hp: number
  hitFlash: number
  stateTime: number
  timer: number
  clamber: number
}

export type SharedSnapshot = {
  tick: number
  time: number
  hour: number
  revision: number
  survivors: RemoteSurvivor[]
  zombies: ZombieState[]
  doors: { open: boolean; locked: boolean }[]
  windows: { open: boolean; openable: boolean }[]
  planks: number[]
  pings: { id: number; by: number; x: number; y: number; label: string; left: number }[]
  lures: { id: number; x: number; y: number; left: number }[]
  bashes: { portal: number; age: number }[]
  shots: (CombatShotEvent & { shooter: number })[]
}

/** The private part: what to reconcile against, the ledger stores this player can see that changed, and notices. */
export type PersonalSnapshot = { ack: number; survivor: Partial<Survivor>; ledger: LedgerDelta | null; notices: Notice[] }

const cm = (v: number) => Math.round(v * 100)

function writeBits(w: ByteWriter, bits: boolean[]): void {
  w.u16(bits.length)
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let k = 0; k < 8 && i + k < bits.length; k++) if (bits[i + k]) b |= 1 << k
    w.u8(b)
  }
}

function readBits(r: ByteReader): boolean[] {
  const n = r.u16()
  const out: boolean[] = []
  for (let i = 0; i < n; i += 8) {
    const b = r.u8()
    for (let k = 0; k < 8 && i + k < n; k++) out.push(Boolean(b & (1 << k)))
  }
  return out
}

/**
 * Encodes the part of a snapshot every player receives. Called once per snapshot, not once per player.
 * `shooters` maps a shot id to the survivor index that fired it.
 */
export function encodeShared(sim: CoopSim, tick: number, shooters: ReadonlyMap<number, number>, w = new ByteWriter(4096)): Uint8Array {
  w.reset()
  w.u32(tick).f64(sim.time).f32(sim.hour).u16(sim.revision & 0xffff)
  w.u8(sim.slots.length)
  for (const slot of sim.slots) {
    const p = slot.survivor
    const flags =
      (p.flashlightOn ? 1 : 0) |
      (p.sprinting ? 2 : 0) |
      (p.equippedItem === "pistol" ? 4 : 0) |
      (p.reloadRemaining > 0 ? 8 : 0) |
      (p.exhausted ? 16 : 0)
    const lift = p.vault ? Math.sin(Math.min(1, p.vault.elapsed / Math.max(0.01, p.vault.duration)) * Math.PI) : 0
    w.u8(slot.index).i32(cm(p.x)).i32(cm(p.y)).u16(packAngle(p.aim)).u8(flags)
    w.u8(Math.round(Math.max(0, Math.min(1, p.flashlightOutput)) * 255))
    w.u8(Math.round(Math.max(0, Math.min(255, p.health))))
    w.u8(Math.round(Math.max(0, Math.min(1, p.recoil)) * 255))
    w.u8(Math.round(lift * 255))
  }
  const agents = sim.ai.agents
  w.u16(agents.length)
  for (const a of agents) {
    const custom = a.seed !== sim.town.seed
    const clamber = a.clamberWindowId ? Math.max(1, Math.round(Math.min(1, a.clamberElapsed / Math.max(0.1, a.clamberDuration)) * 255)) : 0
    w.u16(a.id).u8(STATES.indexOf(a.state) | (custom ? 128 : 0))
    if (custom) w.u32(a.seed)
    w.i32(cm(a.x)).i32(cm(a.y)).u16(packAngle(a.aim))
    w.u8(Math.round(Math.max(0, Math.min(255, a.hp))))
    w.u8(Math.round(Math.max(0, Math.min(1, a.hitFlash)) * 255))
    w.u8(Math.min(255, Math.round(a.stateTime * 20)))
    w.u8(Math.round(Math.max(0, Math.min(1, a.timer / 0.75)) * 255))
    w.u8(clamber)
  }
  const town = sim.town
  writeBits(w, town.doors.flatMap((d) => [d.open, Boolean(d.locked)]))
  writeBits(w, town.windows.flatMap((x) => [x.open, x.openable]))
  const portals = [...town.doors.map((d) => d.id), ...town.windows.map((x) => x.id)]
  w.u16(portals.length)
  for (const id of portals) w.u8(sim.ai.getBarricadePlanks(id))
  const progression = sim.progression
  w.u8(progression.pings.length)
  for (const p of progression.pings) w.u16(p.id & 0xffff).u8(p.by).i16(cm(p.x)).i16(cm(p.y)).u8(Math.round(Math.max(0, Math.min(25.5, p.until - sim.time)) * 10)).str(p.label)
  w.u8(progression.lures.length)
  for (const l of progression.lures) w.u16(l.id & 0xffff).i16(cm(l.x)).i16(cm(l.y)).u8(Math.round(Math.max(0, Math.min(25.5, l.until - sim.time)) * 10))
  const bashes: [number, number][] = []
  portals.forEach((id, i) => {
    const age = sim.time - (sim.ai.portalStates.get(id)?.lastBashTime ?? -Infinity)
    if (age >= 0 && age < 0.2) bashes.push([i, Math.round(age * 1000)])
  })
  w.u8(bashes.length)
  for (const [i, age] of bashes) w.u16(i).u8(age)
  const shots = sim.combat.shots
  w.u8(shots.length)
  for (const s of shots) {
    w.u32(s.id).f64(s.time).i32(cm(s.fromX)).i32(cm(s.fromY)).i32(cm(s.toX)).i32(cm(s.toY)).u16(packAngle(s.aim))
    w.u16(s.hitZombieId ?? 0xffff).u8((s.killed ? 1 : 0) | (BONES.indexOf(s.detachBone) << 1)).u32(s.seed).u8(shooters.get(s.id) ?? 0)
  }
  return w.finish()
}

export function decodeShared(bytes: Uint8Array, townSeed: number): SharedSnapshot {
  const r = new ByteReader(bytes)
  const tick = r.u32()
  const time = r.f64()
  const hour = r.f32()
  const revision = r.u16()
  const survivors: RemoteSurvivor[] = []
  for (let n = r.u8(), i = 0; i < n; i++) {
    const index = r.u8()
    const x = r.i32() / 100
    const y = r.i32() / 100
    const aim = unpackAngle(r.u16())
    const flags = r.u8()
    survivors.push({
      index,
      x,
      y,
      aim,
      flashlightOn: Boolean(flags & 1),
      sprinting: Boolean(flags & 2),
      pistol: Boolean(flags & 4),
      reloading: Boolean(flags & 8),
      exhausted: Boolean(flags & 16),
      flashlightOutput: r.u8() / 255,
      health: r.u8(),
      recoil: r.u8() / 255,
      lift: r.u8() / 255,
    })
  }
  const zombies: ZombieState[] = []
  for (let n = r.u16(), i = 0; i < n; i++) {
    const id = r.u16()
    const code = r.u8()
    const seed = code & 128 ? r.u32() : null
    zombies.push({
      id,
      seed: seed ?? townSeed,
      x: r.i32() / 100,
      y: r.i32() / 100,
      aim: unpackAngle(r.u16()),
      state: STATES[code & 127] ?? "wander",
      hp: r.u8(),
      hitFlash: r.u8() / 255,
      stateTime: r.u8() / 20,
      timer: (r.u8() / 255) * 0.75,
      clamber: r.u8() / 255,
    })
  }
  const doorBits = readBits(r)
  const windowBits = readBits(r)
  const doors = Array.from({ length: doorBits.length / 2 }, (_, i) => ({ open: doorBits[i * 2]!, locked: doorBits[i * 2 + 1]! }))
  const windows = Array.from({ length: windowBits.length / 2 }, (_, i) => ({ open: windowBits[i * 2]!, openable: windowBits[i * 2 + 1]! }))
  const planks: number[] = []
  for (let n = r.u16(), i = 0; i < n; i++) planks.push(r.u8())
  const pings: SharedSnapshot["pings"] = []
  for (let n = r.u8(), i = 0; i < n; i++) pings.push({ id: r.u16(), by: r.u8(), x: r.i16() / 100, y: r.i16() / 100, left: r.u8() / 10, label: r.str() })
  const lures: SharedSnapshot["lures"] = []
  for (let n = r.u8(), i = 0; i < n; i++) lures.push({ id: r.u16(), x: r.i16() / 100, y: r.i16() / 100, left: r.u8() / 10 })
  const bashes: SharedSnapshot["bashes"] = []
  for (let n = r.u8(), i = 0; i < n; i++) bashes.push({ portal: r.u16(), age: r.u8() / 1000 })
  const shots: SharedSnapshot["shots"] = []
  for (let n = r.u8(), i = 0; i < n; i++) {
    const id = r.u32()
    const t = r.f64()
    const fromX = r.i32() / 100
    const fromY = r.i32() / 100
    const toX = r.i32() / 100
    const toY = r.i32() / 100
    const aim = unpackAngle(r.u16())
    const hit = r.u16()
    const flags = r.u8()
    shots.push({
      id,
      time: t,
      fromX,
      fromY,
      toX,
      toY,
      aim,
      hitZombieId: hit === 0xffff ? null : hit,
      killed: Boolean(flags & 1),
      detachBone: BONES[flags >> 1] ?? null,
      seed: r.u32(),
      shooter: r.u8(),
    })
  }
  return { tick, time, hour, revision, survivors, zombies, doors, windows, planks, pings, lures, bashes, shots }
}

const round = (_k: string, v: unknown) =>
  typeof v === "number" ? (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v > 0 ? 1e9 : -1e9) : v

/** Survivor fields in wire order (both ends run the same shared code: the build handshake guarantees it). */
const PERSONAL_KEYS = (Object.keys(createSurvivor(0, 0)) as (keyof Survivor)[]).filter((k) => k !== "vx" && k !== "vy")

/** The private part for one player: what to reconcile against, the ledger delta they can see, and notices. */
export function encodePersonal(ack: number, survivor: Survivor, ledger: LedgerDelta | null, notices: readonly Notice[] = []): Uint8Array {
  const w = new ByteWriter(1024)
  w.u32(ack < 0 ? 0xffffffff : ack)
  w.str(JSON.stringify(PERSONAL_KEYS.map((k) => survivor[k]), round))
  w.str(ledger ? JSON.stringify(ledger) : "")
  w.str(notices.length ? JSON.stringify(notices) : "")
  return w.finish()
}

export function decodePersonal(bytes: Uint8Array): PersonalSnapshot {
  const r = new ByteReader(bytes)
  const raw = r.u32()
  const values = JSON.parse(r.str()) as unknown[]
  const survivor: Record<string, unknown> = {}
  PERSONAL_KEYS.forEach((k, i) => {
    const v = values[i]
    survivor[k] = v === 1e9 ? Infinity : v === -1e9 ? -Infinity : v
  })
  const ledger = r.str()
  const notices = r.str()
  return {
    ack: raw === 0xffffffff ? -1 : raw,
    survivor: survivor as Partial<Survivor>,
    ledger: ledger ? (JSON.parse(ledger) as LedgerDelta) : null,
    notices: notices ? (JSON.parse(notices) as Notice[]) : [],
  }
}

export const encodeSnapshot = frame
export function decodeSnapshot(data: Uint8Array, townSeed: number): { personal: PersonalSnapshot; shared: SharedSnapshot } {
  const { personal, shared } = unframe(data)
  return { personal: decodePersonal(personal), shared: decodeShared(shared, townSeed) }
}

/** Writes a decoded zombie onto a client-side agent (positions are interpolated separately). */
export function applyZombieState(a: AIAgent, z: ZombieState): void {
  a.state = z.state
  a.hp = z.hp
  a.hitFlash = z.hitFlash
  a.stateTime = z.stateTime
  a.timer = z.timer
  a.clamberWindowId = z.clamber > 0 ? "net" : null
  a.clamberElapsed = z.clamber
  a.clamberDuration = 1
}
