import {
  ByteReader,
  ByteWriter,
  frame,
  packAngle,
  packAngle12,
  packAngle8,
  packNibblePair,
  readBitset,
  unframe,
  unpackAngle,
  unpackAngle12,
  unpackAngle8,
  unpackNibblePair,
  writeBitset,
} from "@arcade/kit/net/bytes"
import {
  AckHistory,
  DEFAULT_INTEREST,
  inInterestBubble,
  isScheduledOnSnapshot,
  selectInterestStride,
  type InterestConfig,
} from "@arcade/kit/net/interest"
import type { InputOps } from "@arcade/kit/net/jitter-buffer"
import type { LedgerDelta } from "@arcade/kit/sim/ledger"
import type { AIAgent, AIState } from "./ai"
import {
  MELEE_WEAPON_IDS,
  MELEE_WEAPONS,
  type CombatMeleeEvent,
  type CombatMeleeHit,
  type CombatShotEvent,
  type MeleeWeaponId,
} from "./combat"
import type { MeleeSwingPhase } from "@arcade/kit/human-melee"
import { createSurvivor, type CoopSim } from "./coop-sim"
import type { InteractActionId, VaultState } from "./interact"
import type { ChannelView, Notice, PickMode } from "./progression"
import type { Command, Survivor } from "./session"
import type { ChunkCoord } from "./world"

/** Co-op wire protocol. Text frames are JSON control messages; binary frames are snapshots and compact inputs. */
export const SNAPSHOT_EVERY = 3
export const MAX_NAME = 16
export const ROOM_CODE = /^[a-z0-9]{4,8}$/

export type RosterEntry = { id: string; index: number; name: string; connected: boolean }

export type ClientMsg =
  | { t: "hello"; name: string; token?: string; build: string }
  /** Commands `s`, `s+1`, … for consecutive 60 Hz ticks, plus optional `a` (last acked snapshot tick) and `v` (view tick). */
  | { t: "in"; s: number; c: CommandTuple[]; a?: number; v?: number }
  | { t: "ping"; c: number; a?: number }

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

const CLIENT_IN_MAGIC = 0x49 // 'I'

/** Binary encoder for client `"in"` command batches. */
export function encodeClientIn(
  s: number,
  c: readonly CommandTuple[],
  ackSnap = 0,
  viewTick = 0,
  w = new ByteWriter(64),
): Uint8Array {
  w.reset()
  w.u8(CLIENT_IN_MAGIC)
  w.uvar(s >>> 0)
  w.uvar(ackSnap > 0 ? ackSnap >>> 0 : 0)
  w.uvar(viewTick > 0 ? viewTick >>> 0 : 0)
  const count = Math.min(64, c.length)
  w.u8(count)
  for (let i = 0; i < count; i++) {
    const t = c[i]!
    const mx = Math.round((t[0] ?? 0) * 1000)
    const my = Math.round((t[1] ?? 0) * 1000)
    const aim = packAngle(t[2] ?? 0)
    const flags = (t[3] ?? 0) & FLAG_MAX
    const hasExtra =
      t.length > 4 && ((t[4] !== undefined && t[4] !== -1) || Boolean(t[5]) || Boolean(t[6]) || Boolean(t[7]))
    const next = !hasExtra && i + 1 < count ? c[i + 1] : undefined
    const nextHasExtra =
      next &&
      next.length > 4 &&
      ((next[4] !== undefined && next[4] !== -1) || Boolean(next[5]) || Boolean(next[6]) || Boolean(next[7]))
    const repeatNext =
      Boolean(
        next &&
          !nextHasExtra &&
          Math.round((next[0] ?? 0) * 1000) === mx &&
          Math.round((next[1] ?? 0) * 1000) === my &&
          packAngle(next[2] ?? 0) === aim &&
          ((next[3] ?? 0) & FLAG_MAX) === flags,
      )
    w.i16(mx).i16(my).u16(aim).u16(flags | (hasExtra ? 0x8000 : 0) | (repeatNext ? 0x4000 : 0))
    if (hasExtra) {
      w.u8(((t[4] ?? -1) + 1) & 0xff)
      w.u8(((t[5] ?? 0) + 128) & 0xff)
      w.u8((t[6] ?? 0) & 0xff)
      w.u8((t[7] ?? 0) & 0xff)
    }
    if (repeatNext) i++
  }
  return w.finish()
}

/** Compact ASCII wire frame ("I" + base64 of binary input batch) so WebSocket text frames stay synchronous across runtimes. */
export function encodeClientInText(
  s: number,
  c: readonly CommandTuple[],
  ackSnap = 0,
  viewTick = 0,
  w?: ByteWriter,
): string {
  const bytes = encodeClientIn(s, c, ackSnap, viewTick, w)
  let bin = ""
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!)
  return "I" + btoa(bin)
}

function decodeBinaryIn(bytes: Uint8Array): ClientMsg | null {
  if (bytes.byteLength < 5 || bytes.byteLength > 2048 || bytes[0] !== CLIENT_IN_MAGIC) return null
  try {
    const r = new ByteReader(bytes)
    r.u8()
    const s = r.uvar()
    const a = r.uvar()
    const v = r.uvar()
    const count = r.u8()
    if (count > 64) return null
    const c: CommandTuple[] = []
    while (c.length < count) {
      if (r.remaining < 8) return null
      const mx = r.i16() / 1000
      const my = r.i16() / 1000
      const aim = unpackAngle(r.u16())
      const rawFlags = r.u16()
      const flags = rawFlags & FLAG_MAX
      let tuple: CommandTuple
      if (rawFlags & 0x8000) {
        if (r.remaining < 4) return null
        const slot = r.u8() - 1
        const delta = r.u8() - 128
        const action = r.u8()
        const pick = r.u8()
        if (pick) tuple = [mx, my, aim, flags, slot, delta, action, pick]
        else tuple = [mx, my, aim, flags, slot, delta, action]
      } else {
        tuple = [mx, my, aim, flags]
      }
      c.push(tuple)
      if ((rawFlags & 0x4000) && c.length < count) {
        c.push([...tuple] as CommandTuple)
      }
    }
    return { t: "in", s, c, ...(a > 0 ? { a } : {}), ...(v > 0 ? { v } : {}) }
  } catch {
    return null
  }
}

export function decodeClient(raw: unknown): ClientMsg | null {
  if (raw && typeof raw === "object" && "byteLength" in raw) {
    const bytes = ArrayBuffer.isView(raw)
      ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      : new Uint8Array(raw as ArrayBuffer)
    return decodeBinaryIn(bytes)
  }
  if (typeof raw !== "string" || raw.length > 8192) return null
  if (raw.charCodeAt(0) === CLIENT_IN_MAGIC && raw.length >= 6) {
    try {
      const bin = atob(raw.slice(1))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return decodeBinaryIn(bytes)
    } catch {
      return null
    }
  }
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
  if (o.t === "in" && Number.isSafeInteger(o.s) && Array.isArray(o.c) && o.c.length <= 64) {
    const a = typeof o.a === "number" && Number.isSafeInteger(o.a) && o.a > 0 ? o.a : undefined
    const v = typeof o.v === "number" && Number.isSafeInteger(o.v) && o.v > 0 ? o.v : undefined
    return { t: "in", s: o.s as number, c: o.c as CommandTuple[], ...(a ? { a } : {}), ...(v ? { v } : {}) }
  }
  if (o.t === "ping" && typeof o.c === "number") {
    const a = typeof o.a === "number" && Number.isSafeInteger(o.a) && o.a > 0 ? o.a : undefined
    return { t: "ping", c: o.c, ...(a ? { a } : {}) }
  }
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
  fireHeld: 4096,
} as const
const FLAG_MAX = 8191
const ACTIONS: readonly (InteractActionId | undefined)[] = [
  undefined,
  "toggle",
  "lock",
  "peek",
  "climb",
  "search",
  "barricade",
  "smash",
  "take",
  "deposit",
  "store",
  "unlock",
  "pry",
]
const PICKS: readonly PickMode[] = ["take", "bench", "craft", "pack"]

const q3 = (v: number) => Math.round(v * 1000) / 1000

export function packCommand(c: Command): CommandTuple {
  let flags = 0
  for (const k of Object.keys(FLAG) as (keyof typeof FLAG)[]) if (c[k]) flags |= FLAG[k]
  const t: CommandTuple = [q3(c.mx), q3(c.my), unpackAngle(packAngle(c.aim)), flags]
  const action = c.interactAction ? Math.max(0, ACTIONS.indexOf(c.interactAction)) : 0
  const pick = c.pick ? PICKS.indexOf(c.pick.mode) * 8 + c.pick.index + 1 : 0
  if (c.hotbarSlot !== undefined || c.hotbarDelta || action || pick) t.push(c.hotbarSlot ?? -1, c.hotbarDelta ?? 0, action)
  if (pick) t.push(pick)
  return t
}

const num = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0

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
    return {
      mx: last.mx,
      my: last.my,
      aim: last.aim,
      sprint: last.sprint,
      interactHeld: last.interactHeld,
      fireHeld: last.fireHeld,
      interact: false,
    }
  },
  hasEdges(c) {
    return (
      EDGE_KEYS.some((k) => c[k]) ||
      c.hotbarSlot !== undefined ||
      Boolean(c.hotbarDelta) ||
      Boolean(c.interactAction) ||
      Boolean(c.pick)
    )
  },
}

// ── Snapshots ───────────────────────────────────────────────────────────────────────────────────────────────────

const STATES: readonly AIState[] = [
  "wander",
  "investigate",
  "alert",
  "chase",
  "bash",
  "search",
  "stagger",
  "dead",
  "knockdown",
]
const BONES: readonly CombatShotEvent["detachBone"][] = [null, "head", "left.upperArm", "right.upperArm", "right.foreArm"]
const MELEE_BONES: readonly CombatMeleeHit["detachBone"][] = [
  null,
  "head",
  "left.upperArm",
  "right.upperArm",
  "left.foreArm",
  "right.foreArm",
]
const MELEE_PHASES: readonly MeleeSwingPhase[] = ["idle", "windup", "active", "recovery"]

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
  meleeWeapon?: MeleeWeaponId | null
  meleePhase?: MeleeSwingPhase
  meleeCombo?: 1 | 2 | 3
  meleeProgress?: number
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
  meleeSwings?: CombatMeleeEvent[]
}

/** The private part: what to reconcile against, the ledger stores this player can see that changed, and notices. */
export type PersonalSnapshot = { ack: number; survivor: Partial<Survivor>; ledger: LedgerDelta | null; notices: Notice[] }

export type SnapshotEncodeOptions = {
  /** Recipient's active 3×3 chunk window center (when supplied, culls entities outside the bubble). */
  viewerCenter?: ChunkCoord
  /** Last snapshot acknowledged by this recipient (enables delta compression against acked state). */
  baseSnap?: SharedSnapshot
  /** Canonical snapshot emitted for this bubble on the previous snapshot tick, so throttling is independent of `baseSnap`. */
  prevBubbleSnap?: SharedSnapshot
  /** Monotonic snapshot counter (0, 1, 2, …) for priority-accumulator cadence scheduling. */
  snapIndex?: number
  /** Interest bubble and stride configuration. */
  interest?: InterestConfig
  /** Optional output holder receiving the reconstructed `SharedSnapshot` emitted for this recipient/bubble. */
  outSnapshot?: { snap?: SharedSnapshot }
}

export type SnapshotFieldBreakdown = {
  total: number
  personalBytes: number
  headerBytes: number
  survivorsBytes: number
  zombiesBytes: number
  portalsBytes: number
  eventsBytes: number
}

const cm = (v: number) => Math.round(v * 100)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function writeBits(w: ByteWriter, bits: boolean[]): void {
  w.uvar(bits.length)
  writeBitset(w, bits)
}

function readBits(r: ByteReader): boolean[] {
  const n = r.uvar()
  return readBitset(r, n)
}

const SEC_PORTALS = 1
const SEC_PINGS = 2
const SEC_LURES = 4
const SEC_BASHES = 8
const SEC_SHOTS = 16
const SEC_DELTA = 32
const SEC_MELEE = 64
const V2_MAGIC_BIT = 0x80000000

const timerCapFor = (state: AIState) => (state === "knockdown" ? 1.85 : 0.75)

function defaultZombieSeed(id: number, townSeed: number): number {
  return (townSeed ^ Math.imul(id + 17, 0x85ebca6b)) >>> 0
}

function quantizeZombie(a: AIAgent, townSeed: number): ZombieState {
  const x = cm(a.x) / 100
  const y = cm(a.y) / 100
  const aim = unpackAngle8(packAngle8(a.aim))
  const hp = Math.round(clamp(a.hp, 0, 255))
  const hitFlash = Math.round(clamp(a.hitFlash, 0, 1) * 255) / 255
  const stateTime = a.state === "bash" ? Math.min(255, Math.round(a.stateTime * 20)) / 20 : 0
  const tCap = timerCapFor(a.state)
  const timer =
    a.state === "stagger" || a.state === "knockdown"
      ? (Math.round(clamp(a.timer / tCap, 0, 1) * 255) / 255) * tCap
      : 0
  const clamber = a.clamberWindowId
    ? Math.max(1, Math.round(clamp(a.clamberElapsed / Math.max(0.1, a.clamberDuration), 0, 1) * 255)) / 255
    : 0
  return {
    id: a.id,
    seed: (a.seed ?? townSeed) >>> 0,
    x,
    y,
    aim,
    state: a.state,
    hp,
    hitFlash,
    stateTime,
    timer,
    clamber,
  }
}

function writeFullZombie(w: ByteWriter, z: ZombieState, townSeed: number): void {
  const defSeed = defaultZombieSeed(z.id, townSeed)
  const seedMode = z.seed === defSeed ? 0 : z.seed === (townSeed >>> 0) ? 1 : 2
  const stateIdx = Math.max(0, STATES.indexOf(z.state))
  const hpByte = Math.round(clamp(z.hp, 0, 255))
  const hfByte = Math.round(clamp(z.hitFlash, 0, 1) * 255)
  const clByte = Math.round(clamp(z.clamber, 0, 1) * 255)
  const stByte = Math.min(255, Math.round(z.stateTime * 20))
  const tCap = timerCapFor(z.state)
  const tmByte = Math.round(clamp(z.timer / tCap, 0, 1) * 255)
  const hasOpt = hpByte !== 100 || hfByte > 0 || clByte > 0 || stByte > 0 || tmByte > 0 || seedMode === 2
  w.u16(z.id)
  w.u8((stateIdx & 7) | (seedMode << 3) | (hasOpt ? 32 : 0) | (stateIdx & 8 ? 64 : 0))
  w.i32(cm(z.x)).i32(cm(z.y)).u8(packAngle8(z.aim))
  if (hasOpt) {
    const opt =
      (hpByte !== 100 ? 1 : 0) |
      (hfByte > 0 ? 2 : 0) |
      (clByte > 0 ? 4 : 0) |
      (stByte > 0 ? 8 : 0) |
      (tmByte > 0 ? 16 : 0) |
      (seedMode === 2 ? 32 : 0)
    w.u8(opt)
    if (opt & 1) w.u8(hpByte)
    if (opt & 2) w.u8(hfByte)
    if (opt & 4) w.u8(clByte)
    if (opt & 8) w.u8(stByte)
    if (opt & 16) w.u8(tmByte)
    if (opt & 32) w.u32(z.seed)
  }
}

function readFullZombie(r: ByteReader, townSeed: number): ZombieState {
  const id = r.u16()
  const hdr = r.u8()
  const stateIdx = (hdr & 7) | ((hdr & 64) >>> 3)
  const state = STATES[stateIdx] ?? "wander"
  const seedMode = (hdr >>> 3) & 3
  const hasOpt = Boolean(hdr & 32)
  const x = r.i32() / 100
  const y = r.i32() / 100
  const aim = unpackAngle8(r.u8())
  let hp = 100
  let hitFlash = 0
  let clamber = 0
  let stateTime = 0
  let timer = 0
  const tCap = timerCapFor(state)
  let seed = seedMode === 0 ? defaultZombieSeed(id, townSeed) : (townSeed >>> 0)
  if (hasOpt) {
    const opt = r.u8()
    if (opt & 1) hp = r.u8()
    if (opt & 2) hitFlash = r.u8() / 255
    if (opt & 4) clamber = r.u8() / 255
    if (opt & 8) stateTime = r.u8() / 20
    if (opt & 16) timer = (r.u8() / 255) * tCap
    if (opt & 32) seed = r.u32()
  }
  return { id, seed, x, y, aim, state, hp, hitFlash, stateTime, timer, clamber }
}

/**
 * Encodes the shared/bubble part of a snapshot.
 * Supports interest filtering around `options.viewerCenter` and delta compression against `options.baseSnap`.
 */
export function encodeShared(
  sim: CoopSim,
  tick: number,
  shooters: ReadonlyMap<number, number>,
  w = new ByteWriter(4096),
  options?: SnapshotEncodeOptions,
): Uint8Array {
  w.reset()
  const baseSnap = options?.baseSnap
  const isDelta = baseSnap !== undefined && baseSnap.tick > 0 && baseSnap.tick < tick
  const interest = options?.interest ?? DEFAULT_INTEREST
  const snapIndex = options?.snapIndex ?? Math.floor(tick / SNAPSHOT_EVERY)
  const viewerCenter = options?.viewerCenter
  const bubbleCx = viewerCenter ? (viewerCenter.cx + 0.5) * 32 : 48
  const bubbleCy = viewerCenter ? (viewerCenter.cy + 0.5) * 32 : 48

  // 1. Build survivors list
  const survivors: RemoteSurvivor[] = []
  for (const slot of sim.slots) {
    const p = slot.survivor
    const liftRaw = p.vault ? Math.sin(Math.min(1, p.vault.elapsed / Math.max(0.01, p.vault.duration)) * Math.PI) : 0
    const flByte = Math.round(clamp(p.flashlightOutput, 0, 1) * 127)
    const healthByte = Math.round(clamp(p.health, 0, 255))
    const recoilByte = Math.round(clamp(p.recoil, 0, 1) * 255)
    const liftByte = Math.round(clamp(liftRaw, 0, 1) * 255)
    const meleeProgress =
      p.meleePhase && p.meleePhase !== "idle" && p.meleePhaseDuration > 0
        ? Math.round(clamp(p.meleePhaseTime / p.meleePhaseDuration, 0, 1) * 63) / 63
        : 0
    survivors.push({
      index: slot.index,
      x: cm(p.x) / 100,
      y: cm(p.y) / 100,
      aim: unpackAngle12(packAngle12(p.aim)),
      flashlightOn: p.flashlightOn,
      sprinting: p.sprinting,
      pistol: p.equippedItem === "pistol",
      reloading: p.reloadRemaining > 0,
      exhausted: p.exhausted,
      flashlightOutput: flByte / 127,
      health: healthByte,
      recoil: recoilByte / 255,
      lift: liftByte / 255,
      ...(p.meleeWeapon ? { meleeWeapon: p.meleeWeapon } : {}),
      ...(p.meleePhase && p.meleePhase !== "idle"
        ? { meleePhase: p.meleePhase, meleeCombo: p.meleeCombo, meleeProgress }
        : {}),
    })
  }

  // 2. Filter & quantize zombies in the recipient's interest bubble.
  // Use `prevBubbleSnap` (when provided) for cadence holdback so the target `emittedZombies` at `tick` is identical
  // for every client in the bubble even when two clients have acknowledged different `baseSnap` ticks over the WAN.
  const throttleBase = options?.prevBubbleSnap ?? (isDelta ? baseSnap : undefined)
  const throttleZombieMap = throttleBase ? new Map(throttleBase.zombies.map((z) => [z.id, z])) : null
  const emittedZombies: ZombieState[] = []
  for (const a of sim.ai.agents) {
    if (viewerCenter && !inInterestBubble(a.x, a.y, bubbleCx, bubbleCy, interest.bubbleHalfExtent)) continue
    const q = quantizeZombie(a, sim.town.seed)
    const prev = throttleZombieMap?.get(q.id)
    if (prev && (isDelta || options?.prevBubbleSnap)) {
      const urgent =
        q.state !== prev.state ||
        q.hp !== prev.hp ||
        q.hitFlash !== prev.hitFlash ||
        q.clamber !== prev.clamber ||
        q.state === "chase" ||
        q.state === "alert" ||
        q.state === "stagger" ||
        q.state === "knockdown" ||
        q.state === "bash"
      if (!urgent) {
        let minDist = Infinity
        for (const s of sim.slots) {
          const d = Math.hypot(a.x - s.survivor.x, a.y - s.survivor.y)
          if (d < minDist) minDist = d
        }
        const idle = q.state === "wander" || q.state === "search" || q.state === "dead"
        const stride = selectInterestStride(minDist, false, idle, interest)
        if (!isScheduledOnSnapshot(snapIndex, q.id, stride)) {
          emittedZombies.push(prev)
          continue
        }
      }
    }
    emittedZombies.push(q)
  }
  emittedZombies.sort((a, b) => a.id - b.id)

  // 3. Portals & events
  const town = sim.town
  const portals = [...town.doors.map((d) => d.id), ...town.windows.map((x) => x.id)]
  const hasPortals =
    !isDelta ||
    (sim.revision & 0xffff) !== (baseSnap.revision & 0xffff) ||
    town.doors.length !== baseSnap.doors.length ||
    town.windows.length !== baseSnap.windows.length
  const doors = hasPortals ? town.doors.map((d) => ({ open: d.open, locked: Boolean(d.locked) })) : baseSnap.doors
  const windows = hasPortals ? town.windows.map((x) => ({ open: x.open, openable: x.openable })) : baseSnap.windows
  const planks = hasPortals ? portals.map((id) => sim.ai.getBarricadePlanks(id)) : baseSnap.planks

  const progression = sim.progression
  const pings = progression.pings.map((p) => ({
    id: p.id & 0xffff,
    by: p.by,
    x: cm(p.x) / 100,
    y: cm(p.y) / 100,
    left: Math.round(clamp(p.until - sim.time, 0, 25.5) * 10) / 10,
    label: p.label,
  }))
  const lures = progression.lures.map((l) => ({
    id: l.id & 0xffff,
    x: cm(l.x) / 100,
    y: cm(l.y) / 100,
    left: Math.round(clamp(l.until - sim.time, 0, 25.5) * 10) / 10,
  }))
  const bashes: { portal: number; age: number }[] = []
  portals.forEach((id, i) => {
    const age = sim.time - (sim.ai.portalStates.get(id)?.lastBashTime ?? -Infinity)
    if (age >= 0 && age < 0.2) bashes.push({ portal: i, age: Math.round(age * 1000) / 1000 })
  })

  const maxBaseShotId = isDelta ? baseSnap.shots.reduce((m, s) => Math.max(m, s.id), 0) : 0
  const newShots: (CombatShotEvent & { shooter: number })[] = []
  for (const s of sim.combat.shots) {
    if (isDelta && s.id <= maxBaseShotId) continue
    const fx = cm(s.fromX)
    const fy = cm(s.fromY)
    const dx = cm(s.toX) - fx
    const dy = cm(s.toY) - fy
    const ageMs = clamp(Math.round((sim.time - s.time) * 1000), 0, 65535)
    newShots.push({
      id: s.id,
      time: Number((sim.time - ageMs / 1000).toFixed(4)),
      fromX: fx / 100,
      fromY: fy / 100,
      toX: (fx + dx) / 100,
      toY: (fy + dy) / 100,
      aim: unpackAngle(packAngle(s.aim)),
      hitZombieId: s.hitZombieId,
      killed: s.killed,
      detachBone: s.detachBone,
      seed: s.seed >>> 0,
      shooter: shooters.get(s.id) ?? 0,
    })
  }
  const allShots = isDelta
    ? [...baseSnap.shots.filter((s) => sim.time - s.time <= 0.6), ...newShots]
    : newShots

  const maxBaseMeleeId = isDelta ? (baseSnap.meleeSwings ?? []).reduce((m, s) => Math.max(m, s.id), 0) : 0
  const newMelee: CombatMeleeEvent[] = []
  for (const m of sim.combat.meleeSwings) {
    if (isDelta && m.id <= maxBaseMeleeId) continue
    const ageMs = clamp(Math.round((sim.time - m.time) * 1000), 0, 65535)
    newMelee.push({
      ...m,
      time: Number((sim.time - ageMs / 1000).toFixed(4)),
      x: cm(m.x) / 100,
      y: cm(m.y) / 100,
      aim: unpackAngle(packAngle(m.aim)),
      arc: Math.round(m.arc * 100) / 100,
      reach: Math.round(m.reach * 100) / 100,
      charge: Math.round(m.charge * 100) / 100,
      hits: m.hits.map((h) => ({
        ...h,
        x: cm(h.x) / 100,
        y: cm(h.y) / 100,
      })),
    })
  }
  const allMelee = isDelta
    ? [...(baseSnap.meleeSwings ?? []).filter((m) => sim.time - m.time <= 0.6), ...newMelee]
    : newMelee

  const sectionFlags =
    (hasPortals ? SEC_PORTALS : 0) |
    (pings.length > 0 ? SEC_PINGS : 0) |
    (lures.length > 0 ? SEC_LURES : 0) |
    (bashes.length > 0 ? SEC_BASHES : 0) |
    (newShots.length > 0 ? SEC_SHOTS : 0) |
    (isDelta ? SEC_DELTA : 0) |
    (newMelee.length > 0 ? SEC_MELEE : 0)

  const hourQuant = Math.round((((sim.hour % 24) + 24) % 24) * 2000) & 0xffff
  const timeF32 = Math.fround(sim.time)

  if (options?.outSnapshot) {
    options.outSnapshot.snap = {
      tick,
      time: timeF32,
      hour: hourQuant / 2000,
      revision: sim.revision & 0xffff,
      survivors,
      zombies: emittedZombies,
      doors,
      windows,
      planks,
      pings,
      lures,
      bashes,
      shots: allShots,
      ...(allMelee.length > 0 ? { meleeSwings: allMelee } : {}),
    }
  }

  // Write Header
  w.u32((tick & 0x7fffffff) | V2_MAGIC_BIT)
  w.f32(timeF32)
  w.u16(hourQuant)
  w.u16(sim.revision & 0xffff)
  w.u8(sectionFlags)
  if (isDelta) w.u32(baseSnap.tick)

  // Write Survivors
  w.u8(survivors.length)
  for (const s of survivors) {
    const recoilByte = Math.round(s.recoil * 255)
    const liftByte = Math.round(s.lift * 255)
    const wpnIdx = s.meleeWeapon ? MELEE_WEAPON_IDS.indexOf(s.meleeWeapon) + 1 : 0
    const phaseIdx = s.meleePhase ? Math.max(0, MELEE_PHASES.indexOf(s.meleePhase)) : 0
    const hasExtra = recoilByte > 0 || liftByte > 0 || phaseIdx > 0
    w.u8((s.index & 0x03) | ((wpnIdx & 0x0f) << 2) | (phaseIdx > 0 ? 64 : 0) | (hasExtra ? 128 : 0))
    w.i32(cm(s.x)).i32(cm(s.y))
    const flags4 = (s.flashlightOn ? 1 : 0) | (s.sprinting ? 2 : 0) | (s.pistol ? 4 : 0) | (s.reloading ? 8 : 0)
    w.u16(packAngle12(s.aim) | (flags4 << 12))
    w.u8(Math.round(s.flashlightOutput * 127) | (s.exhausted ? 128 : 0))
    w.u8(s.health)
    if (hasExtra) {
      if (phaseIdx > 0) {
        const comboBits = ((s.meleeCombo ?? 1) - 1) & 3
        const progBits = Math.round(clamp(s.meleeProgress ?? 0, 0, 1) * 15) & 15
        w.u8((phaseIdx & 3) | (comboBits << 2) | (progBits << 4)).u8(liftByte)
      } else {
        w.u8(recoilByte).u8(liftByte)
      }
    }
  }

  // Write Zombies (Full or Delta against baseSnap.zombies)
  if (!isDelta) {
    w.uvar(emittedZombies.length)
    for (const z of emittedZombies) writeFullZombie(w, z, sim.town.seed)
  } else {
    const baseZ = baseSnap.zombies
    const removedIndices: number[] = []
    const retainedPairs: { prev: ZombieState; cur: ZombieState }[] = []
    const addedZombies: ZombieState[] = []
    let bi = 0
    let ei = 0
    while (bi < baseZ.length && ei < emittedZombies.length) {
      const bz = baseZ[bi]!
      const ez = emittedZombies[ei]!
      if (bz.id === ez.id) {
        retainedPairs.push({ prev: bz, cur: ez })
        bi++
        ei++
      } else if (bz.id < ez.id) {
        removedIndices.push(bi++)
      } else {
        addedZombies.push(ez)
        ei++
      }
    }
    while (bi < baseZ.length) removedIndices.push(bi++)
    while (ei < emittedZombies.length) addedZombies.push(emittedZombies[ei++]!)

    w.uvar(removedIndices.length)
    for (const idx of removedIndices) w.uvar(idx)

    const changedBits = retainedPairs.map(({ prev, cur }) => {
      const dx = cm(cur.x) - cm(prev.x)
      const dy = cm(cur.y) - cm(prev.y)
      return (
        dx !== 0 ||
        dy !== 0 ||
        packAngle8(cur.aim) !== packAngle8(prev.aim) ||
        cur.state !== prev.state ||
        cur.hp !== prev.hp ||
        cur.hitFlash !== prev.hitFlash ||
        cur.clamber !== prev.clamber ||
        cur.stateTime !== prev.stateTime ||
        cur.timer !== prev.timer
      )
    })
    writeBitset(w, changedBits)

    for (let i = 0; i < retainedPairs.length; i++) {
      if (!changedBits[i]) continue
      const { prev, cur } = retainedPairs[i]!
      const dx = cm(cur.x) - cm(prev.x)
      const dy = cm(cur.y) - cm(prev.y)
      const posMode =
        dx === 0 && dy === 0
          ? 0
          : dx >= -8 && dx <= 7 && dy >= -8 && dy <= 7
            ? 1
            : dx >= -128 && dx <= 127 && dy >= -128 && dy <= 127
              ? 2
              : 3
      const aimChanged = packAngle8(cur.aim) !== packAngle8(prev.aim)
      const stateChanged = cur.state !== prev.state
      const hpChanged = cur.hp !== prev.hp
      const fxChanged =
        cur.hitFlash !== prev.hitFlash ||
        cur.clamber !== prev.clamber ||
        cur.stateTime !== prev.stateTime ||
        cur.timer !== prev.timer
      const hdr =
        posMode |
        (aimChanged ? 4 : 0) |
        (stateChanged ? 8 : 0) |
        (hpChanged ? 16 : 0) |
        (fxChanged ? 32 : 0)
      w.u8(hdr)
      if (posMode === 1) w.u8(packNibblePair(dx, dy))
      else if (posMode === 2) w.u8(dx & 0xff).u8(dy & 0xff)
      else if (posMode === 3) w.ivar(dx).ivar(dy)
      if (aimChanged) w.u8(packAngle8(cur.aim))
      if (stateChanged) w.u8(Math.max(0, STATES.indexOf(cur.state)))
      if (hpChanged) w.u8(cur.hp)
      if (fxChanged) {
        const fxFlags =
          (cur.hitFlash !== prev.hitFlash ? 1 : 0) |
          (cur.clamber !== prev.clamber ? 2 : 0) |
          (cur.stateTime !== prev.stateTime ? 4 : 0) |
          (cur.timer !== prev.timer ? 8 : 0)
        w.u8(fxFlags)
        if (fxFlags & 1) w.u8(Math.round(cur.hitFlash * 255))
        if (fxFlags & 2) w.u8(Math.round(cur.clamber * 255))
        if (fxFlags & 4) w.u8(Math.min(255, Math.round(cur.stateTime * 20)))
        if (fxFlags & 8) w.u8(Math.round((cur.timer / timerCapFor(cur.state)) * 255))
      }
    }

    w.uvar(addedZombies.length)
    for (const z of addedZombies) writeFullZombie(w, z, sim.town.seed)
  }

  // Write Portals (only when hasPortals is set)
  if (sectionFlags & SEC_PORTALS) {
    writeBits(w, doors.flatMap((d) => [d.open, Boolean(d.locked)]))
    writeBits(w, windows.flatMap((x) => [x.open, x.openable]))
    w.uvar(planks.length)
    let nonZero = 0
    for (const p of planks) if (p > 0) nonZero++
    w.uvar(nonZero)
    for (let i = 0; i < planks.length; i++) {
      if (planks[i]! > 0) w.uvar(i).u8(planks[i]!)
    }
  }

  // Write Events (only when non-empty)
  if (sectionFlags & SEC_PINGS) {
    w.u8(pings.length)
    for (const p of pings) {
      w.u16(p.id & 0xffff).u8(p.by).i32(cm(p.x)).i32(cm(p.y)).u8(Math.round(p.left * 10)).str(p.label)
    }
  }
  if (sectionFlags & SEC_LURES) {
    w.u8(lures.length)
    for (const l of lures) {
      w.u16(l.id & 0xffff).i32(cm(l.x)).i32(cm(l.y)).u8(Math.round(l.left * 10))
    }
  }
  if (sectionFlags & SEC_BASHES) {
    w.u8(bashes.length)
    for (const b of bashes) w.uvar(b.portal).u8(Math.round(b.age * 1000))
  }
  if (sectionFlags & SEC_SHOTS) {
    w.u8(newShots.length)
    for (const s of newShots) {
      const fx = cm(s.fromX)
      const fy = cm(s.fromY)
      const dx = cm(s.toX) - fx
      const dy = cm(s.toY) - fy
      const ageMs = clamp(Math.round((timeF32 - s.time) * 1000), 0, 65535)
      w.uvar(s.id)
      w.u16(ageMs)
      w.i32(fx).i32(fy).ivar(dx).ivar(dy)
      w.u16(packAngle(s.aim))
      w.uvar(s.hitZombieId === null ? 0 : s.hitZombieId + 1)
      w.u8((s.killed ? 1 : 0) | (BONES.indexOf(s.detachBone) << 1) | ((s.shooter & 0x0f) << 4))
      w.u32(s.seed)
    }
  }
  if (sectionFlags & SEC_MELEE) {
    w.u8(newMelee.length)
    for (const m of newMelee) {
      const ageMs = clamp(Math.round((timeF32 - m.time) * 1000), 0, 65535)
      const wpnIdx = Math.max(0, MELEE_WEAPON_IDS.indexOf(m.weapon))
      const flags =
        ((m.combo - 1) & 3) |
        (m.heavy ? 4 : 0) |
        (m.weaponBroke ? 8 : 0) |
        (m.durabilityLow ? 16 : 0) |
        (m.doorBroke ? 32 : 0) |
        (m.hitDoorId ? 64 : 0)
      w.uvar(m.id)
      w.u16(ageMs)
      w.u8(((m.attackerIndex & 0x0f) << 4) | (wpnIdx & 0x0f))
      w.u8(flags)
      w.i32(cm(m.x)).i32(cm(m.y)).u16(packAngle(m.aim))
      w.u8(Math.round(clamp(m.arc, 0, 2.55) * 100))
      w.u8(Math.round(clamp(m.reach, 0, 2.55) * 100))
      w.u8(Math.round(clamp(m.charge, 0, 1) * 100))
      if (m.hitDoorId) w.str(m.hitDoorId)
      w.u32(m.seed)
      w.u8(m.hits.length)
      for (const h of m.hits) {
        w.uvar(h.zombieId)
        w.i32(cm(h.x)).i32(cm(h.y))
        w.u8(Math.round(clamp(h.damage, 0, 255)))
        const hFlags =
          (h.killed ? 1 : 0) |
          (h.knockdown ? 2 : 0) |
          (h.headshot ? 4 : 0) |
          (Math.max(0, MELEE_BONES.indexOf(h.detachBone)) << 3)
        w.u8(hFlags)
        w.u32(h.seed)
      }
    }
  }

  return w.finish()
}

export function decodeShared(
  bytes: Uint8Array,
  townSeed: number,
  history?: AckHistory<SharedSnapshot>,
): SharedSnapshot {
  const r = new ByteReader(bytes)
  const rawTick = r.u32()
  const tick = (rawTick & 0x7fffffff) >>> 0
  const time = r.f32()
  const hour = r.u16() / 2000
  const revision = r.u16()
  const sectionFlags = r.u8()
  const isDelta = Boolean(sectionFlags & SEC_DELTA)
  const baseTick = isDelta ? r.u32() : 0
  const baseSnap = isDelta ? history?.get(baseTick) : undefined

  const survivors: RemoteSurvivor[] = []
  for (let n = r.u8(), i = 0; i < n; i++) {
    const idxByte = r.u8()
    const index = idxByte & 0x03
    const wpnIdx = (idxByte >>> 2) & 0x0f
    const hasMeleePhase = Boolean(idxByte & 64)
    const hasExtra = Boolean(idxByte & 128)
    const x = r.i32() / 100
    const y = r.i32() / 100
    const aimAndFlags = r.u16()
    const aim = unpackAngle12(aimAndFlags & 0x0fff)
    const flags4 = aimAndFlags >>> 12
    const flAndExh = r.u8()
    const health = r.u8()
    const extra0 = hasExtra ? r.u8() : 0
    const lift = hasExtra ? r.u8() / 255 : 0
    const recoil = hasExtra && !hasMeleePhase ? extra0 / 255 : 0
    const meleeWeapon = wpnIdx > 0 ? (MELEE_WEAPON_IDS[wpnIdx - 1] ?? null) : undefined
    const meleePhase = hasMeleePhase ? (MELEE_PHASES[extra0 & 3] ?? "idle") : undefined
    const meleeCombo = hasMeleePhase ? ((((extra0 >>> 2) & 3) + 1) as 1 | 2 | 3) : undefined
    const meleeProgress = hasMeleePhase ? Math.round((((extra0 >>> 4) & 15) / 15) * 63) / 63 : undefined
    survivors.push({
      index,
      x,
      y,
      aim,
      flashlightOn: Boolean(flags4 & 1),
      sprinting: Boolean(flags4 & 2),
      pistol: Boolean(flags4 & 4),
      reloading: Boolean(flags4 & 8),
      exhausted: Boolean(flAndExh & 128),
      flashlightOutput: (flAndExh & 0x7f) / 127,
      health,
      recoil,
      lift,
      ...(meleeWeapon ? { meleeWeapon } : {}),
      ...(meleePhase && meleePhase !== "idle" ? { meleePhase, meleeCombo, meleeProgress } : {}),
    })
  }

  let zombies: ZombieState[] = []
  if (!isDelta) {
    for (let n = r.uvar(), i = 0; i < n; i++) {
      zombies.push(readFullZombie(r, townSeed))
    }
  } else {
    const baseZ = baseSnap?.zombies ?? []
    const removedCount = r.uvar()
    const removedSet = new Set<number>()
    for (let i = 0; i < removedCount; i++) removedSet.add(r.uvar())
    const retained = baseZ.filter((_, i) => !removedSet.has(i))
    const changedBits = readBitset(r, retained.length)
    const updatedRetained: ZombieState[] = new Array(retained.length)
    for (let i = 0; i < retained.length; i++) {
      const prev = retained[i]!
      if (!changedBits[i]) {
        updatedRetained[i] = prev
        continue
      }
      const hdr = r.u8()
      const posMode = hdr & 3
      let dx = 0
      let dy = 0
      if (posMode === 1) {
        ;[dx, dy] = unpackNibblePair(r.u8())
      } else if (posMode === 2) {
        const rx = r.u8()
        const ry = r.u8()
        dx = rx >= 128 ? rx - 256 : rx
        dy = ry >= 128 ? ry - 256 : ry
      } else if (posMode === 3) {
        dx = r.ivar()
        dy = r.ivar()
      }
      const x = (cm(prev.x) + dx) / 100
      const y = (cm(prev.y) + dy) / 100
      const aim = hdr & 4 ? unpackAngle8(r.u8()) : prev.aim
      const state = hdr & 8 ? (STATES[r.u8()] ?? prev.state) : prev.state
      const hp = hdr & 16 ? r.u8() : prev.hp
      let hitFlash = prev.hitFlash
      let clamber = prev.clamber
      let stateTime = prev.stateTime
      let timer = prev.timer
      if (hdr & 32) {
        const fxFlags = r.u8()
        if (fxFlags & 1) hitFlash = r.u8() / 255
        if (fxFlags & 2) clamber = r.u8() / 255
        if (fxFlags & 4) stateTime = r.u8() / 20
        if (fxFlags & 8) timer = (r.u8() / 255) * timerCapFor(state)
      }
      updatedRetained[i] = { id: prev.id, seed: prev.seed, x, y, aim, state, hp, hitFlash, stateTime, timer, clamber }
    }
    const addedCount = r.uvar()
    const added: ZombieState[] = []
    for (let i = 0; i < addedCount; i++) added.push(readFullZombie(r, townSeed))
    zombies = added.length ? [...updatedRetained, ...added].sort((a, b) => a.id - b.id) : updatedRetained
  }

  let doors: { open: boolean; locked: boolean }[]
  let windows: { open: boolean; openable: boolean }[]
  let planks: number[]
  if (sectionFlags & SEC_PORTALS) {
    const doorBits = readBits(r)
    const windowBits = readBits(r)
    doors = Array.from({ length: doorBits.length / 2 }, (_, i) => ({
      open: doorBits[i * 2]!,
      locked: doorBits[i * 2 + 1]!,
    }))
    windows = Array.from({ length: windowBits.length / 2 }, (_, i) => ({
      open: windowBits[i * 2]!,
      openable: windowBits[i * 2 + 1]!,
    }))
    const totalPortals = r.uvar()
    const nonZero = r.uvar()
    planks = new Array<number>(totalPortals).fill(0)
    for (let i = 0; i < nonZero; i++) {
      const idx = r.uvar()
      const val = r.u8()
      if (idx < totalPortals) planks[idx] = val
    }
  } else {
    doors = baseSnap?.doors ?? []
    windows = baseSnap?.windows ?? []
    planks = baseSnap?.planks ?? []
  }

  const pings: SharedSnapshot["pings"] = []
  if (sectionFlags & SEC_PINGS) {
    for (let n = r.u8(), i = 0; i < n; i++) {
      pings.push({ id: r.u16(), by: r.u8(), x: r.i32() / 100, y: r.i32() / 100, left: r.u8() / 10, label: r.str() })
    }
  }
  const lures: SharedSnapshot["lures"] = []
  if (sectionFlags & SEC_LURES) {
    for (let n = r.u8(), i = 0; i < n; i++) {
      lures.push({ id: r.u16(), x: r.i32() / 100, y: r.i32() / 100, left: r.u8() / 10 })
    }
  }
  const bashes: SharedSnapshot["bashes"] = []
  if (sectionFlags & SEC_BASHES) {
    for (let n = r.u8(), i = 0; i < n; i++) {
      bashes.push({ portal: r.uvar(), age: r.u8() / 1000 })
    }
  }
  const newShots: SharedSnapshot["shots"] = []
  if (sectionFlags & SEC_SHOTS) {
    for (let n = r.u8(), i = 0; i < n; i++) {
      const id = r.uvar()
      const ageMs = r.u16()
      const fx = r.i32()
      const fy = r.i32()
      const dx = r.ivar()
      const dy = r.ivar()
      const aim = unpackAngle(r.u16())
      const hitRaw = r.uvar()
      const flagsAndShooter = r.u8()
      const seed = r.u32()
      newShots.push({
        id,
        time: Number((time - ageMs / 1000).toFixed(4)),
        fromX: fx / 100,
        fromY: fy / 100,
        toX: (fx + dx) / 100,
        toY: (fy + dy) / 100,
        aim,
        hitZombieId: hitRaw === 0 ? null : hitRaw - 1,
        killed: Boolean(flagsAndShooter & 1),
        detachBone: BONES[(flagsAndShooter >>> 1) & 7] ?? null,
        seed,
        shooter: (flagsAndShooter >>> 4) & 0x0f,
      })
    }
  }
  const shots = isDelta && baseSnap
    ? [...baseSnap.shots.filter((s) => time - s.time <= 0.6), ...newShots]
    : newShots

  const newMelee: CombatMeleeEvent[] = []
  if (sectionFlags & SEC_MELEE) {
    for (let n = r.u8(), i = 0; i < n; i++) {
      const id = r.uvar()
      const ageMs = r.u16()
      const attAndWpn = r.u8()
      const attackerIndex = (attAndWpn >>> 4) & 0x0f
      const weapon = MELEE_WEAPON_IDS[attAndWpn & 0x0f] ?? "crowbar"
      const flags = r.u8()
      const combo = (((flags & 3) + 1) as 1 | 2 | 3)
      const heavy = Boolean(flags & 4)
      const weaponBroke = Boolean(flags & 8)
      const durabilityLow = Boolean(flags & 16)
      const doorBroke = Boolean(flags & 32)
      const hasDoor = Boolean(flags & 64)
      const x = r.i32() / 100
      const y = r.i32() / 100
      const aim = unpackAngle(r.u16())
      const arc = r.u8() / 100
      const reach = r.u8() / 100
      const charge = r.u8() / 100
      const hitDoorId = hasDoor ? r.str() : null
      const seed = r.u32()
      const hitCount = r.u8()
      const hits: CombatMeleeHit[] = []
      for (let k = 0; k < hitCount; k++) {
        const zombieId = r.uvar()
        const hx = r.i32() / 100
        const hy = r.i32() / 100
        const damage = r.u8()
        const hFlags = r.u8()
        const hSeed = r.u32()
        hits.push({
          zombieId,
          x: hx,
          y: hy,
          damage,
          killed: Boolean(hFlags & 1),
          knockdown: Boolean(hFlags & 2),
          headshot: Boolean(hFlags & 4),
          detachBone: MELEE_BONES[(hFlags >>> 3) & 7] ?? null,
          seed: hSeed,
        })
      }
      newMelee.push({
        id,
        time: Number((time - ageMs / 1000).toFixed(4)),
        attackerId: `seat:${attackerIndex}`,
        attackerIndex,
        weapon,
        x,
        y,
        aim,
        arc,
        reach,
        combo,
        heavy,
        charge,
        hits,
        hitDoorId,
        doorBroke,
        weaponBroke,
        durabilityLow,
        seed,
      })
    }
  }
  const meleeSwings = isDelta && baseSnap
    ? [...(baseSnap.meleeSwings ?? []).filter((m) => time - m.time <= 0.6), ...newMelee]
    : newMelee

  const snap: SharedSnapshot = {
    tick,
    time,
    hour,
    revision,
    survivors,
    zombies,
    doors,
    windows,
    planks,
    pings,
    lures,
    bashes,
    shots,
    ...(meleeSwings.length > 0 ? { meleeSwings } : {}),
  }
  history?.record(tick, snap)
  return snap
}

const round = (_k: string, v: unknown) =>
  typeof v === "number" ? (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v > 0 ? 1e9 : -1e9) : v

const PERSONAL_BINARY_MAGIC = 0x50 // 'P'
const P_TIMERS = 1
const P_PEEK = 2
const P_HOLD = 4
const P_VAULT = 8
const P_CHANNEL = 16
const P_LOOT_MSG = 32
const P_CAPS = 64
const P_LEDGER = 128
const P_NOTICES = 256
const P_MELEE = 512

/** The private part for one player: packed binary survivor state, ledger delta, and notices. */
export function encodePersonal(
  ack: number,
  survivor: Survivor,
  ledger: LedgerDelta | null,
  notices: readonly Notice[] = [],
  w = new ByteWriter(256),
): Uint8Array {
  w.reset()
  w.u8(PERSONAL_BINARY_MAGIC)
  w.u32(ack < 0 ? 0xffffffff : ack >>> 0)
  w.f32(survivor.x)
    .f32(survivor.y)
    .f32(survivor.aim)
    .f32(survivor.stamina)
    .f32(survivor.battery)
    .f32(survivor.flashlightOutput)
    .f32(survivor.lightSignature)
    .f32(survivor.noise)

  const boolFlags =
    (survivor.sprinting ? 1 : 0) |
    (survivor.exhausted ? 2 : 0) |
    (survivor.flashlightOn ? 4 : 0) |
    (survivor.batteryDepleted ? 8 : 0) |
    (survivor.equippedItem === "pistol" ? 16 : 0)
  w.u8(boolFlags)
  w.u8(Math.round(clamp(survivor.health, 0, 255)))
  w.u8(Math.round(clamp(survivor.magAmmo, 0, 255)))
  w.u8(Math.round(clamp(survivor.reserveAmmo, 0, 255)))
  w.u8(Math.round(clamp(survivor.planks, 0, 255)))

  const hasTimers =
    survivor.regenCooldown > 0 ||
    survivor.batteryCooldown > 0 ||
    survivor.fireCooldown > 0 ||
    survivor.reloadRemaining > 0 ||
    survivor.shoveCooldown > 0 ||
    survivor.recoil > 0 ||
    survivor.shoveAnim > 0
  const hasPeek = Boolean(survivor.peekingWindowId)
  const hasHold = Boolean(survivor.holdTargetId || survivor.holdElapsed > 0 || survivor.holdTriggered || survivor.holdPendingPrimary)
  const hasVault = Boolean(survivor.vault)
  const hasChannel = Boolean(survivor.channel)
  const hasLootMsg = Boolean(survivor.lootMessage)
  const hasCaps = (survivor.maxHealth ?? 100) !== 100 || (survivor.magCapacity ?? 8) !== 8
  const hasLedger = Boolean(ledger)
  const hasNotices = notices.length > 0
  const hasMelee =
    Boolean(survivor.meleeWeapon) ||
    (survivor.meleePhase !== undefined && survivor.meleePhase !== "idle") ||
    (survivor.meleeSwingId ?? 0) > 0

  const mask =
    (hasTimers ? P_TIMERS : 0) |
    (hasPeek ? P_PEEK : 0) |
    (hasHold ? P_HOLD : 0) |
    (hasVault ? P_VAULT : 0) |
    (hasChannel ? P_CHANNEL : 0) |
    (hasLootMsg ? P_LOOT_MSG : 0) |
    (hasCaps ? P_CAPS : 0) |
    (hasLedger ? P_LEDGER : 0) |
    (hasNotices ? P_NOTICES : 0) |
    (hasMelee ? P_MELEE : 0)
  w.u16(mask)

  if (hasTimers) {
    const tmMask =
      (survivor.regenCooldown > 0 ? 1 : 0) |
      (survivor.batteryCooldown > 0 ? 2 : 0) |
      (survivor.fireCooldown > 0 ? 4 : 0) |
      (survivor.reloadRemaining > 0 ? 8 : 0) |
      (survivor.shoveCooldown > 0 ? 16 : 0) |
      (survivor.recoil > 0 ? 32 : 0) |
      (survivor.shoveAnim > 0 ? 64 : 0)
    w.u8(tmMask)
    if (tmMask & 1) w.f32(survivor.regenCooldown)
    if (tmMask & 2) w.f32(survivor.batteryCooldown)
    if (tmMask & 4) w.f32(survivor.fireCooldown)
    if (tmMask & 8) w.f32(survivor.reloadRemaining)
    if (tmMask & 16) w.f32(survivor.shoveCooldown)
    if (tmMask & 32) w.f32(survivor.recoil)
    if (tmMask & 64) w.f32(survivor.shoveAnim)
  }
  if (hasPeek) {
    w.str(survivor.peekingWindowId ?? "")
      .f32(survivor.peekOriginX)
      .f32(survivor.peekOriginY)
      .f32(survivor.peekOriginDist)
  }
  if (hasHold) {
    w.str(survivor.holdTargetId ?? "")
      .f32(survivor.holdElapsed)
      .u8(survivor.holdTriggered ? 1 : 0)
      .str(survivor.holdPendingPrimary ?? "")
  }
  if (hasVault) w.str(JSON.stringify(survivor.vault, round))
  if (hasChannel) w.str(JSON.stringify(survivor.channel, round))
  if (hasLootMsg) w.str(survivor.lootMessage ?? "").f32(survivor.lootMessageUntil)
  if (hasCaps) {
    w.u8(Math.round(clamp(survivor.maxHealth, 1, 255))).u8(Math.round(clamp(survivor.magCapacity, 0, 255)))
  }
  if (hasLedger) w.str(JSON.stringify(ledger))
  if (hasNotices) w.str(JSON.stringify(notices))
  if (hasMelee) {
    const wpnIdx = survivor.meleeWeapon ? MELEE_WEAPON_IDS.indexOf(survivor.meleeWeapon) + 1 : 0
    const phaseIdx = Math.max(0, MELEE_PHASES.indexOf(survivor.meleePhase ?? "idle"))
    w.u8(wpnIdx)
    w.u8(Math.round(clamp(survivor.meleeDurability ?? 0, 0, 255)))
    w.u8(Math.round(clamp(survivor.meleeMaxDurability ?? 0, 0, 255)))
    w.u8(
      (phaseIdx & 3) |
        ((((survivor.meleeCombo ?? 1) - 1) & 3) << 2) |
        (survivor.meleeHeavy ? 16 : 0) |
        (survivor.meleeComboQueued ? 32 : 0),
    )
    w.f32(survivor.meleePhaseTime ?? 0)
    w.f32(survivor.meleePhaseDuration ?? 0)
    w.f32(survivor.meleeCharge ?? 0)
    w.uvar((survivor.meleeSwingId ?? 0) >>> 0)
  }
  return w.finish()
}

export function decodePersonal(bytes: Uint8Array): PersonalSnapshot {
  const r = new ByteReader(bytes)
  const magic = r.u8()
  if (magic !== PERSONAL_BINARY_MAGIC) {
    throw new Error(`Invalid personal snapshot magic: ${magic}`)
  }
  const raw = r.u32()
  const x = r.f32()
  const y = r.f32()
  const aim = r.f32()
  const stamina = r.f32()
  const battery = r.f32()
  const flashlightOutput = r.f32()
  const lightSignature = r.f32()
  const noise = r.f32()
  const boolFlags = r.u8()
  const health = r.u8()
  const magAmmo = r.u8()
  const reserveAmmo = r.u8()
  const planks = r.u8()
  const mask = r.u16()

  const survivor: Partial<Survivor> = {
    x,
    y,
    aim,
    stamina,
    battery,
    flashlightOutput,
    lightSignature,
    noise,
    sprinting: Boolean(boolFlags & 1),
    exhausted: Boolean(boolFlags & 2),
    flashlightOn: Boolean(boolFlags & 4),
    batteryDepleted: Boolean(boolFlags & 8),
    equippedItem: boolFlags & 16 ? "pistol" : "hands",
    meleeWeapon: null,
    meleeDurability: 0,
    meleeMaxDurability: 0,
    meleePhase: "idle",
    meleePhaseTime: 0,
    meleePhaseDuration: 0,
    meleeCombo: 1,
    meleeCharge: 0,
    meleeHeavy: false,
    meleeComboQueued: false,
    meleeComboUntil: -Infinity,
    meleeSwingId: 0,
    health,
    maxHealth: 100,
    magAmmo,
    magCapacity: 8,
    reserveAmmo,
    planks,
    regenCooldown: 0,
    batteryCooldown: 0,
    fireCooldown: 0,
    reloadRemaining: 0,
    shoveCooldown: 0,
    recoil: 0,
    shoveAnim: 0,
    peekingWindowId: null,
    peekOriginX: 0,
    peekOriginY: 0,
    peekOriginDist: 0,
    holdTargetId: null,
    holdElapsed: 0,
    holdTriggered: false,
    holdPendingPrimary: null,
    vault: null,
    channel: null,
    lootMessage: null,
    lootMessageUntil: -Infinity,
  }

  if (mask & P_TIMERS) {
    const tmMask = r.u8()
    if (tmMask & 1) survivor.regenCooldown = r.f32()
    if (tmMask & 2) survivor.batteryCooldown = r.f32()
    if (tmMask & 4) survivor.fireCooldown = r.f32()
    if (tmMask & 8) survivor.reloadRemaining = r.f32()
    if (tmMask & 16) survivor.shoveCooldown = r.f32()
    if (tmMask & 32) survivor.recoil = r.f32()
    if (tmMask & 64) survivor.shoveAnim = r.f32()
  }
  if (mask & P_PEEK) {
    const pw = r.str()
    survivor.peekingWindowId = pw || null
    survivor.peekOriginX = r.f32()
    survivor.peekOriginY = r.f32()
    survivor.peekOriginDist = r.f32()
  }
  if (mask & P_HOLD) {
    const ht = r.str()
    survivor.holdTargetId = ht || null
    survivor.holdElapsed = r.f32()
    survivor.holdTriggered = r.u8() !== 0
    const hp = r.str()
    survivor.holdPendingPrimary = (hp || null) as InteractActionId | null
  }
  if (mask & P_VAULT) survivor.vault = JSON.parse(r.str()) as VaultState
  if (mask & P_CHANNEL) survivor.channel = JSON.parse(r.str()) as ChannelView
  if (mask & P_LOOT_MSG) {
    survivor.lootMessage = r.str()
    survivor.lootMessageUntil = r.f32()
  }
  if (mask & P_CAPS) {
    survivor.maxHealth = r.u8()
    survivor.magCapacity = r.u8()
  }
  const ledger = mask & P_LEDGER ? (JSON.parse(r.str()) as LedgerDelta) : null
  const notices = mask & P_NOTICES ? (JSON.parse(r.str()) as Notice[]) : []
  if (mask & P_MELEE) {
    const wpnIdx = r.u8()
    const wpn = wpnIdx > 0 ? (MELEE_WEAPON_IDS[wpnIdx - 1] ?? null) : null
    survivor.meleeWeapon = wpn
    if (wpn) survivor.equippedItem = wpn
    survivor.meleeDurability = r.u8()
    survivor.meleeMaxDurability = r.u8()
    const mFlags = r.u8()
    survivor.meleePhase = MELEE_PHASES[mFlags & 3] ?? "idle"
    survivor.meleeCombo = (((mFlags >>> 2) & 3) + 1) as 1 | 2 | 3
    survivor.meleeHeavy = Boolean(mFlags & 16)
    survivor.meleeComboQueued = Boolean(mFlags & 32)
    survivor.meleePhaseTime = r.f32()
    survivor.meleePhaseDuration = r.f32()
    survivor.meleeCharge = r.f32()
    survivor.meleeSwingId = r.uvar()
  }

  return {
    ack: raw === 0xffffffff ? -1 : raw,
    survivor,
    ledger,
    notices,
  }
}

export const encodeSnapshot = frame
export function decodeSnapshot(
  data: Uint8Array,
  townSeed: number,
  history?: AckHistory<SharedSnapshot>,
): { personal: PersonalSnapshot; shared: SharedSnapshot } {
  const { personal, shared } = unframe(data)
  return { personal: decodePersonal(personal), shared: decodeShared(shared, townSeed, history) }
}

/**
 * Inspects a binary snapshot frame and returns the exact byte count of each logical field section.
 */
export function inspectSnapshotBreakdown(
  data: Uint8Array,
  historyOrBaseCount?: AckHistory<SharedSnapshot> | number,
): SnapshotFieldBreakdown {
  const { personal, shared } = unframe(data)
  const r = new ByteReader(shared)
  const h0 = r.offset
  r.u32()
  r.f32()
  r.u16()
  r.u16()
  const sectionFlags = r.u8()
  const isDelta = Boolean(sectionFlags & SEC_DELTA)
  const baseTick = isDelta ? r.u32() : 0
  const baseZombiesCount =
    typeof historyOrBaseCount === "number"
      ? historyOrBaseCount
      : isDelta && historyOrBaseCount
        ? (historyOrBaseCount.get(baseTick)?.zombies.length ?? 0)
        : 0
  const headerBytes = 4 + (r.offset - h0)

  const s0 = r.offset
  for (let n = r.u8(), i = 0; i < n; i++) {
    const idxByte = r.u8()
    r.i32()
    r.i32()
    r.u16()
    r.u8()
    r.u8()
    if (idxByte & 128) {
      r.u8()
      r.u8()
    }
  }
  const survivorsBytes = r.offset - s0

  const z0 = r.offset
  if (!isDelta) {
    for (let n = r.uvar(), i = 0; i < n; i++) readFullZombie(r, 0)
  } else {
    const removedCount = r.uvar()
    for (let i = 0; i < removedCount; i++) r.uvar()
    const retainedCount = Math.max(0, baseZombiesCount - removedCount)
    const changedBits = readBitset(r, retainedCount)
    for (let i = 0; i < retainedCount; i++) {
      if (!changedBits[i]) continue
      const hdr = r.u8()
      const posMode = hdr & 3
      if (posMode === 1) r.u8()
      else if (posMode === 2) {
        r.u8()
        r.u8()
      } else if (posMode === 3) {
        r.ivar()
        r.ivar()
      }
      if (hdr & 4) r.u8()
      if (hdr & 8) r.u8()
      if (hdr & 16) r.u8()
      if (hdr & 32) {
        const fx = r.u8()
        if (fx & 1) r.u8()
        if (fx & 2) r.u8()
        if (fx & 4) r.u8()
        if (fx & 8) r.u8()
      }
    }
    const addedCount = r.uvar()
    for (let i = 0; i < addedCount; i++) readFullZombie(r, 0)
  }
  const zombiesBytes = r.offset - z0

  const p0 = r.offset
  if (sectionFlags & SEC_PORTALS) {
    readBits(r)
    readBits(r)
    r.uvar()
    const nonZero = r.uvar()
    for (let i = 0; i < nonZero; i++) {
      r.uvar()
      r.u8()
    }
  }
  const portalsBytes = r.offset - p0
  const eventsBytes = shared.byteLength - r.offset

  return {
    total: data.byteLength,
    personalBytes: personal.byteLength,
    headerBytes,
    survivorsBytes,
    zombiesBytes,
    portalsBytes,
    eventsBytes,
  }
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
