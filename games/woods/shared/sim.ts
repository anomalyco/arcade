import { stepBody } from "@arcade/kit/sim/move"
import { stepCreature, type CreatureEvent } from "./creature"
import { createDistant, holdDistant, stepDistant, type DistantEvent, type DistantState } from "./distant"
import { BOT_ORDER, CAST_NAMES, createVoices, stepVoices, voicesBusyUntil, type VoiceCue, type VoiceEvent, type VoiceState } from "./voices"
import { isDeepWater, nextRandom, solidsNear, standHeight, treesNear, type Tree, type WoodsWorld } from "./world"

/**
 * The woods' rules as plain data, ready for a room: players (people and bots), flagging tapes, survey markers and what
 * each player's map knows. `stepWoods` is deterministic given the state, the world and the inputs; the only random
 * source is `state.rng`. Presentation (camera, beams, sound) reads the state and the events of the last step.
 */

export const FEEL = {
  walkSpeed: 1.9,
  mapWalk: 0.55,
  flashReach: 30,
  flashCone: 0.3,
  flashPower: 60,
  flashFlicker: 1.2,
  beamHaze: 5,
  beamLength: 14,
  beamPresence: 1.2,
  ownHaze: 0.04,
  mist: 0.03,
  mistFalloff: 0.035,
  mistBank: 0,
  trunkDensity: 4.5,
  tapeTieTime: 1.1,
  tapeReach: 1.7,
  tapeSeen: 9,
  tapeShine: 0.25,
  mapRaise: 0.35,
  findRadius: 2.6,
  campGlow: 1,
  ridgeGlow: 1,
  ambient: 1,
  exposure: 2.5,
  trunkShadows: true,
  botCount: 3,
  botSpeed: 1.45,
  botLeash: 70,
  botTapeEvery: 26,
  /** Each bot keeps at most this many tapes up; tying another unties its oldest. */
  botTapes: 8,
  /** How often the distant sounds come (×; `shared/distant.ts`). The room's is authoritative. */
  distantRate: 1,
  /** How often the searchers talk among themselves (×; 0 is silence apart from key moments; `shared/voices.ts`). */
  chatter: 1,
  /** People's own searchers speak at key moments (a find, a sighting): 1 on, 0 never. */
  voicePeople: 1,
  /** The thing in the woods (`shared/creature.ts`): off until Kit has seen it; a room runs these defaults. */
  creature: false,
  /** How often it comes (×; 1 ≈ every five minutes when there's a light to cross). */
  creatureRate: 1,
  /** How far from whoever sees it (m). */
  creatureNear: 45,
  creatureFar: 80,
  /** Its running speed (m/s). */
  creatureSpeed: 11,
}
export type Feel = typeof FEEL


export const PLAYER_RADIUS = 0.28
export const PLAYER_ACCEL = 18
export const EYE_HEIGHT = 1.68
/** Height of a tied tape above the ground at its tree (m). */
export const TAPE_HEIGHT = 1.5
/** Spacing of pencil samples along a walked path (m); it widens by this much every `TRAIL_COARSEN` samples. */
export const TRAIL_STEP = 3
const TRAIL_COARSEN = 500
/** Samples a path keeps at most (2000 cover about 15 km); paths only ever grow at the end, so rooms send just the new points. */
export const TRAIL_MAX = 2000
/** Tapes a room keeps up at most; past it the oldest comes down. */
export const MAX_TAPES = 300
/** Pitch above which a beam counts as pointing up: the regroup signal. */
export const SIGNAL_PITCH = 1.1
/** Seconds the beam must point up before it counts as a signal. */
export const SIGNAL_HOLD_SECONDS = 0.8
const SIGNAL_HOLD = SIGNAL_HOLD_SECONDS
/** Seconds after a signal ends before a distant sound may come. */
export const DISTANT_AFTER_SIGNAL = 6
const COMPARE_RANGE = 3.5

export type Tie = { tree: number; progress: number; removing: boolean }
/** One player's pencil marks: what their paper map knows. */
export type MapKnowledge = {
  /** Own path, flat x,z pairs every `TRAIL_STEP`. */
  trail: number[]
  /** Paths copied from friends' maps when comparing (`serial` tells a reused id's new walker apart). */
  heard: { from: number; serial: number; trail: number[] }[]
  tapes: number[]
  markers: number[]
}
export type Player = {
  id: number
  bot: boolean
  name: string
  x: number
  z: number
  vx: number
  vz: number
  /** View yaw (0 looks north, −z) and pitch (rad). */
  yaw: number
  pitch: number
  light: boolean
  /** Battery flicker: seconds left of the current dip, and when the next starts. */
  flickerLeft: number
  flickerNext: number
  /** 0 = map down, 1 = raised. */
  mapRaise: number
  tie: Tie | null
  /** Unique per walker in a room (ids get reused when bots leave and come back). */
  serial: number
  /** After a tie or untie, E must be let go this long (s) before it starts another, so a lost input mid-hold can't undo it. */
  tieHold: number
  /** Seconds the beam has pointed up (`SIGNAL_PITCH`). */
  signal: number
  map: MapKnowledge
}
export type Tape = { id: number; tree: number; x: number; y: number; z: number; /** Plan angle of the knot side, atan2(dz, dx) from the trunk (rad). */ yaw: number; by: number; at: number }
export type Brain = { id: number; mode: "wander" | "tie" | "regroup" | "signal" | "wait" | "found"; heading: number; timer: number; since: number; tx: number; tz: number; sweep: number }

export type WoodsEvent =
  | { kind: "tape-tied"; by: number; tape: number; x: number; z: number; tree: number; yaw: number; at: number }
  | { kind: "tape-removed"; by: number; tape: number; x: number; z: number }
  | { kind: "marker-found"; by: number; marker: number; x: number; z: number }
  | { kind: "maps-compared"; a: number; b: number }
  | { kind: "signal"; by: number; x: number; z: number }
  | { kind: "light"; by: number; on: boolean }
  /** A distant sound (`shared/distant.ts`): the same sound, take, place and emission time for every player. */
  | DistantEvent
  /** A searcher says a line (`shared/voices.ts`): the same line, place and emission time for every player. */
  | VoiceEvent
  /** The creature crossing in front of a distant light (`shared/creature.ts`), seen by everyone at the same moment. */
  | CreatureEvent

export type WoodsState = {
  t: number
  rng: { seed: number }
  players: Player[]
  brains: Brain[]
  tapes: Tape[]
  nextTape: number
  /** Marker id → ids of players who found it. */
  found: Record<number, number[]>
  /** Pair key → time of the last map compare. */
  compared: Record<string, number>
  events: WoodsEvent[]
  /** Bumped whenever `found` changes, so a room re-sends it only then. */
  rev: { found: number }
  /** Last walker serial handed out (`Player.serial`). */
  serial: number
  /** The distant-sound schedule (`shared/distant.ts`), stepped here; a room sends it on join. */
  distant: DistantState
  /** The searchers' voices (`shared/voices.ts`), stepped here. */
  voices: VoiceState
}

/** One player's controls for a step: the same for a person (sent to the room, predicted locally) and a bot. */
export type PlayerInput = {
  yaw: number
  pitch: number
  light: boolean
  tie: boolean
  map: boolean
  /** Plan move direction (x, z), length ≤ 1. */
  mx: number
  mz: number
  sprint?: boolean
}

const VOICE_CUES = new Set(["marker-found", "signal", "distant", "tape-tied", "creature"])
/** Bots are the searchers `BOT_ORDER` gives them (STORY.md). */
const NAMES = BOT_ORDER.map((c) => CAST_NAMES[c])
/** Bots take ids from here up, so they never collide with people's ids (0 solo, 1–6 in a room). */
export const BOT_ID = 100

export function newPlayer(id: number, bot: boolean, name: string, x: number, z: number, yaw: number): Player {
  return {
    id, bot, name, x, z, vx: 0, vz: 0, yaw, pitch: -0.1, light: true,
    flickerLeft: 0, flickerNext: 20 + (id % 16) * 7, mapRaise: 0, tie: null, serial: 0, tieHold: 0, signal: 0,
    map: { trail: [x, z], heard: [], tapes: [], markers: [] },
  }
}

export type Human = { id: number; name: string }

/** A fresh night: `humans` start at camp (solo is one person with id 0), `bots` friends spread just north of them. */
export function createWoods(world: WoodsWorld, bots = FEEL.botCount, seed = world.params.seed, humans: readonly Human[] = [{ id: 0, name: "You" }]): WoodsState {
  const state: WoodsState = { t: 0, rng: { seed }, players: [], brains: [], tapes: [], nextTape: 1, found: {}, compared: {}, events: [], rev: { found: 0 }, serial: 0, distant: createDistant(seed ^ 0x51ed), voices: createVoices(seed ^ 0x3a7c) }
  for (const h of humans) addHuman(state, world, h.id, h.name)
  setBotCount(state, world, bots)
  return state
}

/** A person joins at camp (spread so nobody spawns inside another). */
export function addHuman(state: WoodsState, world: WoodsWorld, id: number, name: string): Player {
  const s = world.camp.spawn, k = id % 6
  const p = newPlayer(id, false, name, s.x + ((k % 3) - 1) * 1.6, s.z + Math.floor(k / 3) * 1.6, s.yaw)
  p.serial = ++state.serial
  state.players.splice(state.players.filter((q) => !q.bot).length, 0, p)
  return p
}

/** A walker leaves for good: their tapes and the room's finds stay, the copies of their path on other maps go. */
export function removePlayer(state: WoodsState, id: number): void {
  state.players = state.players.filter((p) => p.id !== id)
  state.brains = state.brains.filter((b) => b.id !== id)
  for (const p of state.players) if (p.map.heard.some((h) => h.from === id)) p.map.heard = p.map.heard.filter((h) => h.from !== id)
}

/** A tape comes down: out of the room and off every map that knew it. */
export function removeTape(state: WoodsState, tape: Tape, by: number): void {
  state.tapes = state.tapes.filter((t) => t !== tape)
  for (const p of state.players) { const i = p.map.tapes.indexOf(tape.id); if (i >= 0) p.map.tapes.splice(i, 1) }
  state.events.push({ kind: "tape-removed", by, tape: tape.id, x: tape.x, z: tape.z })
}

export function setBotCount(state: WoodsState, world: WoodsWorld, n: number): void {
  const want = Math.max(0, Math.round(n))
  while (state.brains.length > want) {
    removePlayer(state, state.brains.at(-1)!.id)
  }
  while (state.brains.length < want) {
    let id = BOT_ID
    while (state.players.some((p) => p.id === id)) id++
    const s = world.camp.spawn, k = state.brains.length
    const x = s.x - 7 + k * 6, z = s.z - 12 - (k % 2) * 3
    const bot = newPlayer(id, true, NAMES[(id - BOT_ID) % NAMES.length]!, x, z, -0.4 + k * 0.4)
    bot.serial = ++state.serial
    state.players.push(bot)
    state.brains.push({ id, mode: "wander", heading: -0.5 + k * 0.5 + (nextRandom(state.rng) - 0.5) * 0.4, timer: 1 + k * 1.5, since: 0, tx: x, tz: z, sweep: nextRandom(state.rng) * 6 })
  }
}

/** Unit view direction of a yaw/pitch (yaw 0 looks along −z). */
export function viewDir(yaw: number, pitch: number): [number, number, number] {
  const c = Math.cos(pitch)
  return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c]
}

/** The tree a player would tie on: trunk within reach of their position, closest to where they look. */
export function tieTarget(world: WoodsWorld, p: Player, reach: number): Tree | null {
  const [dx, , dz] = viewDir(p.yaw, 0)
  let best: Tree | null = null, bestScore = Infinity
  for (const t of treesNear(world, p.x, p.z, reach + 0.6)) {
    const ox = t.x - p.x, oz = t.z - p.z
    const d = Math.hypot(ox, oz) - t.radius
    if (d > reach) continue
    const facing = (ox * dx + oz * dz) / Math.max(Math.hypot(ox, oz), 1e-3)
    if (facing < 0.55) continue
    const score = d + (1 - facing) * 2
    if (score < bestScore) { bestScore = score; best = t }
  }
  return best
}

export const tapeOnTree = (state: WoodsState, tree: number) => state.tapes.find((t) => t.tree === tree)

function addUnique(list: number[], v: number) {
  if (!list.includes(v)) list.push(v)
}

function stepFlicker(state: WoodsState, p: Player, feel: Feel, dt: number) {
  p.flickerLeft = Math.max(0, p.flickerLeft - dt)
  p.flickerNext -= dt
  if (p.flickerNext <= 0) {
    p.flickerLeft = 0.12 + nextRandom(state.rng) * 0.5
    const rate = Math.max(feel.flashFlicker, 0.01)
    p.flickerNext = (60 / rate) * (0.4 + nextRandom(state.rng) * 1.2)
  }
}

/**
 * 0..1 output of a player's flashlight at presentation time `t` (a continuous local clock, not the tick or snapshot
 * time, so a dip doesn't step). A dip is a sputter between 0.15 and 0.8 at a few hertz, not a strobe;
 * `feel.flashFlicker` 0 disables dips.
 */
export function beamLevel(p: Player, t: number, feel: Feel): number {
  if (!p.light) return 0
  if (p.flickerLeft <= 0 || feel.flashFlicker <= 0) return 1
  const n = Math.sin(t * 17.3 + p.id * 4.1) * 0.6 + Math.sin(t * 7.9 + p.id) * 0.4
  const k = Math.max(0, Math.min(1, (n + 0.1) / 0.6))
  return 0.8 - 0.65 * k * k * (3 - 2 * k)
}

const TIE_RELEASE = 0.2

function stepTie(state: WoodsState, world: WoodsWorld, p: Player, held: boolean, feel: Feel, dt: number) {
  if (p.tieHold > 0) {
    if (held) { p.tieHold = TIE_RELEASE; return }
    p.tieHold = Math.max(0, p.tieHold - dt)
    p.tie = null
    return
  }
  const target = held ? tieTarget(world, p, feel.tapeReach) : null
  if (!target) { p.tie = null; return }
  const existing = tapeOnTree(state, target.id)
  if (!p.tie || p.tie.tree !== target.id) p.tie = { tree: target.id, progress: 0, removing: !!existing }
  const time = feel.tapeTieTime * (p.tie.removing ? 0.7 : 1)
  p.tie.progress = Math.min(1, p.tie.progress + dt / Math.max(time, 0.05))
  if (p.tie.progress < 1) return
  if (p.tie.removing) {
    if (existing) removeTape(state, existing, p.id)
  } else if (!existing) {
    const tape: Tape = { id: state.nextTape++, tree: target.id, x: target.x, y: target.y + TAPE_HEIGHT, z: target.z, yaw: Math.atan2(p.z - target.z, p.x - target.x), by: p.id, at: state.t }
    state.tapes.push(tape)
    addUnique(p.map.tapes, tape.id)
    state.events.push({ kind: "tape-tied", by: p.id, tape: tape.id, x: tape.x, z: tape.z, tree: tape.tree, yaw: tape.yaw, at: tape.at })
    // Bots keep a short trail of tape behind them, and the room a bounded number in all.
    if (p.bot) {
      const mine = state.tapes.filter((t) => t.by === p.id)
      for (let k = 0; k < mine.length - Math.max(1, feel.botTapes); k++) removeTape(state, mine[k]!, p.id)
    }
    while (state.tapes.length > MAX_TAPES) removeTape(state, state.tapes[0]!, -1)
  }
  // Keep holding does nothing more until the key is released (for `TIE_RELEASE`) and pressed again.
  p.tie = { tree: target.id, progress: 1, removing: p.tie.removing }
  p.tieHold = TIE_RELEASE
}

function stepKnowledge(state: WoodsState, world: WoodsWorld, p: Player, feel: Feel) {
  const m = p.map
  const lx = m.trail[m.trail.length - 2]!, lz = m.trail[m.trail.length - 1]!
  const n = m.trail.length / 2
  if (n < TRAIL_MAX && Math.hypot(p.x - lx, p.z - lz) >= TRAIL_STEP * (1 + Math.floor(n / TRAIL_COARSEN))) m.trail.push(p.x, p.z)
  for (const t of state.tapes) if (Math.hypot(t.x - p.x, t.z - p.z) < feel.tapeSeen) addUnique(m.tapes, t.id)
  for (const k of world.markers) {
    if (m.markers.includes(k.id) || Math.hypot(k.x - p.x, k.z - p.z) > feel.findRadius) continue
    m.markers.push(k.id)
    const by = (state.found[k.id] ??= [])
    addUnique(by, p.id)
    state.rev.found++
    state.events.push({ kind: "marker-found", by: p.id, marker: k.id, x: k.x, z: k.z })
  }
}

/** Two players standing together, one with the map up, copy each other's pencil marks. */
function compareMaps(state: WoodsState, a: Player, b: Player) {
  const key = `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`
  if (state.t - (state.compared[key] ?? -99) < 4) return
  state.compared[key] = state.t
  for (const [from, to] of [[a, b], [b, a]] as const) {
    for (const id of from.map.tapes) addUnique(to.map.tapes, id)
    for (const id of from.map.markers) addUnique(to.map.markers, id)
    const heard = to.map.heard.filter((h) => h.from !== from.id)
    heard.push({ from: from.id, serial: from.serial, trail: from.map.trail.slice() })
    for (const h of from.map.heard) if (h.from !== to.id && !heard.some((x) => x.from === h.from)) heard.push({ from: h.from, serial: h.serial, trail: h.trail.slice() })
    to.map.heard = heard
  }
  state.events.push({ kind: "maps-compared", a: a.id, b: b.id })
}

/** Moves a player through the forest (the shared `stepBody`, trunks and rocks as solids, deep water refused). */
export function movePlayer(world: WoodsWorld, p: Player, mx: number, mz: number, speed: number, dt: number) {
  const body = { x: p.x, y: p.z, vx: p.vx, vy: p.vz }
  stepBody(body, mx, mz, speed, solidsNear(world, p.x, p.z, 3), dt, PLAYER_RADIUS, PLAYER_ACCEL)
  if (isDeepWater(world, body.x, body.y)) { body.x = p.x; body.y = p.z; body.vx = body.vy = 0 }
  p.x = body.x; p.z = body.y; p.vx = body.vx; p.vz = body.vy
}

/**
 * One step of a player's own motion: look, the map's raise, then walking (slower with the map up). The room, solo
 * play and a client predicting itself all run exactly this, so replaying unacknowledged inputs lands where the room did.
 */
export function stepMotion(world: WoodsWorld, p: Player, input: PlayerInput, feel: Feel, dt: number): void {
  p.yaw = input.yaw
  p.pitch = input.pitch
  const raiseRate = dt / Math.max(feel.mapRaise, 0.02)
  p.mapRaise = Math.max(0, Math.min(1, p.mapRaise + (input.map ? raiseRate : -raiseRate * 1.4)))
  const speed = (p.bot ? feel.botSpeed : feel.walkSpeed * (input.sprint ? 1.8 : 1)) * (p.mapRaise > 0.5 ? feel.mapWalk : 1)
  movePlayer(world, p, input.mx, input.mz, speed, dt)
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

function nearestHuman(state: WoodsState, p: Player, signalling = false): Player | undefined {
  let best: Player | undefined, bd = Infinity
  for (const q of state.players) {
    if (q.bot || (signalling && q.signal <= SIGNAL_HOLD)) continue
    const d = Math.hypot(q.x - p.x, q.z - p.z)
    if (d < bd) { bd = d; best = q }
  }
  return best
}

function botInput(state: WoodsState, world: WoodsWorld, b: Brain, p: Player, feel: Feel, dt: number): PlayerInput {
  const you = nearestHuman(state, p)
  const caller = nearestHuman(state, p, true)
  b.timer -= dt
  b.sweep += dt
  let speed = 1, tie = false, pitch = -0.22 + Math.sin(b.sweep * 0.7) * 0.12, yawOffset = Math.sin(b.sweep * 0.45) * 0.55
  const toYou = you ? Math.hypot(you.x - p.x, you.z - p.z) : 0
  if (caller && b.mode !== "regroup" && b.mode !== "signal" && Math.hypot(caller.x - p.x, caller.z - p.z) < 260) {
    // Reply with your own beam, then head over.
    b.mode = "signal"; b.timer = 1.6; b.tx = caller.x; b.tz = caller.z
  }
  switch (b.mode) {
    case "signal":
      speed = 0; pitch = 1.35; yawOffset = 0
      if (b.timer <= 0) b.mode = Math.hypot(b.tx - p.x, b.tz - p.z) > 8 ? "regroup" : "wander"
      break
    case "regroup": {
      b.heading = Math.atan2(-(b.tx - p.x), -(b.tz - p.z))
      yawOffset *= 0.3
      if (Math.hypot(b.tx - p.x, b.tz - p.z) < 5) { b.mode = "wander"; b.timer = 3 }
      break
    }
    case "tie":
      speed = 0; tie = true; yawOffset = 0; pitch = -0.1
      if (b.timer <= 0 || (p.tie && (p.tie.progress >= 1 || p.tie.removing))) { b.mode = "wander"; b.since = 0; b.timer = 2 }
      break
    case "wait":
      speed = 0
      if (b.timer <= 0) b.mode = "wander"
      break
    case "found":
      // Found a marker: beam straight up for a while so the others can find the spot, then wait there.
      speed = 0; pitch = b.timer > 14 ? 1.35 : pitch
      if (b.timer <= 0) b.mode = "wander"
      break
    default: {
      if (b.timer <= 0) {
        b.heading += (nextRandom(state.rng) - 0.5) * 1.6
        b.timer = 4 + nextRandom(state.rng) * 7
      }
      // Stay within reach of you; keep out of the lake and inside the map.
      if (you && toYou > feel.botLeash) b.heading += wrap(Math.atan2(-(you.x - p.x), -(you.z - p.z)) - b.heading) * Math.min(1, dt * 1.5)
      const [ax, , az] = viewDir(b.heading, 0)
      const ahead = { x: p.x + ax * 8, z: p.z + az * 8 }
      const h = world.params.half - 12
      if (isDeepWater(world, ahead.x, ahead.z) || Math.abs(ahead.x) > h || Math.abs(ahead.z) > h) b.heading += dt * 2.5
      b.since += Math.hypot(p.vx, p.vz) * dt
      if (b.since > feel.botTapeEvery) {
        // Only a bare trunk: a bot never takes down a tape someone else put up.
        const t = tieTarget(world, { ...p, yaw: b.heading }, feel.tapeReach + 0.6)
        if (t && !tapeOnTree(state, t.id)) { b.mode = "tie"; b.timer = feel.tapeTieTime + 0.6 }
      }
      if (nextRandom(state.rng) < dt / 110) { b.mode = "wait"; b.timer = 6 + nextRandom(state.rng) * 8 }
    }
  }
  // Steer around the trunk straight ahead.
  const [fx, , fz] = viewDir(b.heading, 0)
  for (const t of treesNear(world, p.x + fx * 1.4, p.z + fz * 1.4, 0.9)) {
    const side = (t.x - p.x) * -fz + (t.z - p.z) * fx
    b.heading += (side > 0 ? -1 : 1) * dt * 2.2
  }
  const [mx, , mz] = viewDir(b.heading, 0)
  return { yaw: b.heading + yawOffset, pitch, light: true, tie, map: false, mx: mx * speed, mz: mz * speed }
}

/**
 * One tick of the night for everyone. People without an input this tick (a dropped seat) stand still with their
 * light as it was; bots think for themselves.
 */
export function stepWoods(state: WoodsState, world: WoodsWorld, inputs: ReadonlyMap<number, PlayerInput>, dt: number, feel: Feel = FEEL): void {
  state.t += dt
  state.events.length = 0
  for (const p of state.players) {
    const brain = p.bot ? state.brains.find((b) => b.id === p.id) : undefined
    const input = brain ? botInput(state, world, brain, p, feel, dt) : inputs.get(p.id) ?? { yaw: p.yaw, pitch: p.pitch, light: p.light, tie: false, map: false, mx: 0, mz: 0 }
    stepMotion(world, p, input, feel, dt)
    if (input.light !== p.light) state.events.push({ kind: "light", by: p.id, on: input.light })
    p.light = input.light
    stepFlicker(state, p, feel, dt)
    stepTie(state, world, p, input.tie && p.mapRaise < 0.3, feel, dt)
    const wasSignal = p.signal > SIGNAL_HOLD
    p.signal = p.light && p.pitch > SIGNAL_PITCH ? p.signal + dt : 0
    if (!wasSignal && p.signal > SIGNAL_HOLD) state.events.push({ kind: "signal", by: p.id, x: p.x, z: p.z })
    stepKnowledge(state, world, p, feel)
    if (brain && state.events.some((e) => e.kind === "marker-found" && e.by === p.id)) { brain.mode = "found"; brain.timer = 24 }
  }
  for (let i = 0; i < state.players.length; i++) for (let j = i + 1; j < state.players.length; j++) {
    const a = state.players[i]!, b = state.players[j]!
    if ((a.mapRaise > 0.9 || b.mapRaise > 0.9) && Math.hypot(a.x - b.x, a.z - b.z) < COMPARE_RANGE) compareMaps(state, a, b)
  }
  // The woods keep quiet while anyone is signalling and for a few seconds after.
  if (state.players.some((p) => p.signal > SIGNAL_HOLD)) holdDistant(state.distant, state.t + DISTANT_AFTER_SIGNAL)
  const sound = stepDistant(state.distant, world, state.players.filter((p) => !p.bot), state.t, feel.distantRate)
  if (sound) state.events.push(sound)
  const creature = stepCreature(state.distant, world, state.players, state.t, feel, SIGNAL_HOLD)
  if (creature) state.events.push(creature)
  // A sighting cues the searchers too (`VOICE_CUES`).
  const cues = (state.events as readonly { kind: string }[]).filter((e) => VOICE_CUES.has(e.kind)) as VoiceCue[]
  state.events.push(...stepVoices(state.voices, world, state.players, cues, state.t, dt, feel, BOT_ID))
  holdDistant(state.distant, voicesBusyUntil(state.voices))
}

/** Eye position of a player standing on the terrain. */
export function eyeOf(world: WoodsWorld, p: Player): [number, number, number] {
  return [p.x, standHeight(world, p.x, p.z) + EYE_HEIGHT, p.z]
}
