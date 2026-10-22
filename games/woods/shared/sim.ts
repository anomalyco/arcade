import type { LabControl } from "@arcade/kit/lab-panel"
import { stepBody } from "@arcade/kit/sim/move"
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
}
export type Feel = typeof FEEL

export const FEEL_CONTROLS: LabControl[] = [
  { key: "walkSpeed", label: "Walk speed", group: "Walking", min: 1, max: 4, step: 0.05, unit: "m/s" },
  { key: "mapWalk", label: "Walk speed with map up", group: "Walking", min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "flashReach", label: "Flashlight reach", group: "Flashlight", min: 8, max: 70, step: 1, unit: "m" },
  { key: "flashCone", label: "Flashlight cone (half-angle)", group: "Flashlight", min: 0.1, max: 0.7, step: 0.01, unit: "rad" },
  { key: "flashPower", label: "Flashlight brightness", group: "Flashlight", min: 4, max: 200, step: 1, unit: "cd-ish" },
  { key: "flashFlicker", label: "Battery flicker", group: "Flashlight", min: 0, max: 6, step: 0.1, unit: "/min" },
  { key: "beamHaze", label: "Beam haze in mist", group: "Flashlight", min: 0, max: 40, step: 0.5, unit: "×" },
  { key: "beamPresence", label: "Far beams read (0 = physical)", group: "Flashlight", min: 0, max: 1.5, step: 0.05, unit: "" },
  { key: "ownHaze", label: "Your own beam's haze", group: "Flashlight", min: 0, max: 1, step: 0.01, unit: "×" },
  { key: "beamLength", label: "Visible beam length", group: "Flashlight", min: 2, max: 40, step: 0.5, unit: "m" },
  { key: "mist", label: "Mist density", group: "Mist", min: 0, max: 0.09, step: 0.001, unit: "m⁻¹" },
  { key: "mistFalloff", label: "Mist height falloff", group: "Mist", min: 0, max: 0.15, step: 0.002, unit: "m⁻¹" },
  { key: "mistBank", label: "Drifting ground mist", group: "Mist", min: 0, max: 0.08, step: 0.002, unit: "m⁻¹" },
  { key: "ambient", label: "Night sky light", group: "Mist", min: 0, max: 4, step: 0.05, unit: "×" },
  { key: "exposure", label: "Exposure", group: "Mist", min: 0.2, max: 4, step: 0.05, unit: "×" },
  { key: "trunkDensity", label: "Trunk density", group: "Forest", min: 1, max: 10, step: 0.25, unit: "/100 m²" },
  { key: "trunkShadows", label: "Trunk shadows", group: "Forest", type: "toggle" },
  { key: "campGlow", label: "Camp lights", group: "Forest", min: 0, max: 4, step: 0.05, unit: "×" },
  { key: "ridgeGlow", label: "Ridge light", group: "Forest", min: 0, max: 4, step: 0.05, unit: "×" },
  { key: "tapeTieTime", label: "Tape tie time", group: "Tape & map", min: 0.2, max: 3, step: 0.05, unit: "s" },
  { key: "tapeReach", label: "Tape reach", group: "Tape & map", min: 0.8, max: 3, step: 0.05, unit: "m" },
  { key: "tapeShine", label: "Tape shine with distance", group: "Tape & map", min: 0, max: 1.5, step: 0.05, unit: "/m" },
  { key: "tapeSeen", label: "Tape noticed within", group: "Tape & map", min: 2, max: 25, step: 0.5, unit: "m" },
  { key: "mapRaise", label: "Map raise time", group: "Tape & map", min: 0.08, max: 1.2, step: 0.01, unit: "s" },
  { key: "findRadius", label: "Marker find radius", group: "Tape & map", min: 1, max: 6, step: 0.1, unit: "m" },
  { key: "botCount", label: "Friends (bots)", group: "Friends", min: 0, max: 5, step: 1 },
  { key: "botSpeed", label: "Friend walk speed", group: "Friends", min: 0.5, max: 3, step: 0.05, unit: "m/s" },
  { key: "botLeash", label: "Friends stray up to", group: "Friends", min: 15, max: 180, step: 5, unit: "m" },
  { key: "botTapeEvery", label: "Friends tie tape every", group: "Friends", min: 8, max: 80, step: 1, unit: "m" },
]

export const PLAYER_RADIUS = 0.28
export const PLAYER_ACCEL = 18
export const EYE_HEIGHT = 1.68
/** Height of a tied tape above the ground at its tree (m). */
export const TAPE_HEIGHT = 1.5
/** Spacing of pencil samples along a walked path (m). */
export const TRAIL_STEP = 3
const TRAIL_MAX = 6000
/** Pitch above which a beam counts as pointing up: the regroup signal. */
export const SIGNAL_PITCH = 1.1
const SIGNAL_HOLD = 0.8
const COMPARE_RANGE = 3.5

export type Tie = { tree: number; progress: number; removing: boolean }
/** One player's pencil marks: what their paper map knows. */
export type MapKnowledge = {
  /** Own path, flat x,z pairs every `TRAIL_STEP`. */
  trail: number[]
  /** Paths copied from friends' maps when comparing. */
  heard: { from: number; trail: number[] }[]
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
  /** Seconds the beam has pointed up (`SIGNAL_PITCH`). */
  signal: number
  map: MapKnowledge
}
export type Tape = { id: number; tree: number; x: number; y: number; z: number; /** Plan angle of the knot side, atan2(dz, dx) from the trunk (rad). */ yaw: number; by: number; at: number }
export type Brain = { id: number; mode: "wander" | "tie" | "regroup" | "signal" | "wait" | "found"; heading: number; timer: number; since: number; tx: number; tz: number; sweep: number }

export type WoodsEvent =
  | { kind: "tape-tied"; by: number; tape: number; x: number; z: number }
  | { kind: "tape-removed"; by: number; tape: number; x: number; z: number }
  | { kind: "marker-found"; by: number; marker: number; x: number; z: number }
  | { kind: "maps-compared"; a: number; b: number }
  | { kind: "signal"; by: number; x: number; z: number }
  | { kind: "light"; by: number; on: boolean }

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
}

/** One player's controls for a step. A person's position comes from their own client in the toy (`pos`). */
export type PlayerInput = {
  yaw: number
  pitch: number
  light: boolean
  tie: boolean
  map: boolean
  /** Plan move direction (x, z), length ≤ 1; ignored when `pos` is given. */
  mx?: number
  mz?: number
  sprint?: boolean
  pos?: { x: number; z: number; vx: number; vz: number }
}

const NAMES = ["Sam", "Robin", "Alex", "Jo", "Casey"]

function newPlayer(id: number, bot: boolean, x: number, z: number, yaw: number): Player {
  return {
    id, bot, name: bot ? NAMES[(id - 1) % NAMES.length]! : "You", x, z, vx: 0, vz: 0, yaw, pitch: -0.1, light: bot,
    flickerLeft: 0, flickerNext: 20 + id * 7, mapRaise: 0, tie: null, signal: 0,
    map: { trail: [x, z], heard: [], tapes: [], markers: [] },
  }
}

export function createWoods(world: WoodsWorld, bots = FEEL.botCount, seed = world.params.seed): WoodsState {
  const s = world.camp.spawn
  const state: WoodsState = { t: 0, rng: { seed }, players: [newPlayer(0, false, s.x, s.z, s.yaw)], brains: [], tapes: [], nextTape: 1, found: {}, compared: {}, events: [] }
  setBotCount(state, world, bots)
  return state
}

export function setBotCount(state: WoodsState, world: WoodsWorld, n: number): void {
  const want = Math.max(0, Math.round(n))
  while (state.brains.length > want) {
    const b = state.brains.pop()!
    state.players = state.players.filter((p) => p.id !== b.id)
  }
  while (state.brains.length < want) {
    const id = Math.max(0, ...state.players.map((p) => p.id)) + 1
    const s = world.camp.spawn, k = state.brains.length
    const x = s.x - 7 + k * 6, z = s.z - 12 - (k % 2) * 3
    state.players.push(newPlayer(id, true, x, z, -0.4 + k * 0.4))
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

/** 0..1 output of a player's flashlight this step (presentation reads it; `feel.flashFlicker` 0 disables dips). */
export function beamLevel(p: Player, t: number, feel: Feel): number {
  if (!p.light) return 0
  if (p.flickerLeft <= 0 || feel.flashFlicker <= 0) return 1
  const n = Math.sin(t * 61.3 + p.id * 4.1) * Math.sin(t * 23.7 + p.id)
  return n > 0.15 ? 0.15 : 0.75
}

function stepTie(state: WoodsState, world: WoodsWorld, p: Player, held: boolean, feel: Feel, dt: number) {
  const target = held ? tieTarget(world, p, feel.tapeReach) : null
  if (!target) { p.tie = null; return }
  const existing = tapeOnTree(state, target.id)
  if (!p.tie || p.tie.tree !== target.id) p.tie = { tree: target.id, progress: 0, removing: !!existing }
  const time = feel.tapeTieTime * (p.tie.removing ? 0.7 : 1)
  p.tie.progress = Math.min(1, p.tie.progress + dt / Math.max(time, 0.05))
  if (p.tie.progress < 1) return
  if (p.tie.removing) {
    if (existing) {
      state.tapes = state.tapes.filter((t) => t !== existing)
      state.events.push({ kind: "tape-removed", by: p.id, tape: existing.id, x: existing.x, z: existing.z })
    }
  } else if (!existing) {
    const tape: Tape = { id: state.nextTape++, tree: target.id, x: target.x, y: target.y + TAPE_HEIGHT, z: target.z, yaw: Math.atan2(p.z - target.z, p.x - target.x), by: p.id, at: state.t }
    state.tapes.push(tape)
    addUnique(p.map.tapes, tape.id)
    state.events.push({ kind: "tape-tied", by: p.id, tape: tape.id, x: tape.x, z: tape.z })
  }
  // Keep holding does nothing more until the key is released and pressed again.
  p.tie = { tree: target.id, progress: 1, removing: p.tie.removing }
}

function stepKnowledge(state: WoodsState, world: WoodsWorld, p: Player, feel: Feel) {
  const m = p.map
  const lx = m.trail[m.trail.length - 2]!, lz = m.trail[m.trail.length - 1]!
  if (Math.hypot(p.x - lx, p.z - lz) >= TRAIL_STEP && m.trail.length < TRAIL_MAX * 2) m.trail.push(p.x, p.z)
  for (const t of state.tapes) if (Math.hypot(t.x - p.x, t.z - p.z) < feel.tapeSeen) addUnique(m.tapes, t.id)
  for (const k of world.markers) {
    if (m.markers.includes(k.id) || Math.hypot(k.x - p.x, k.z - p.z) > feel.findRadius) continue
    m.markers.push(k.id)
    const by = (state.found[k.id] ??= [])
    addUnique(by, p.id)
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
    heard.push({ from: from.id, trail: from.map.trail.slice() })
    for (const h of from.map.heard) if (h.from !== to.id && !heard.some((x) => x.from === h.from)) heard.push({ from: h.from, trail: h.trail.slice() })
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

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

function botInput(state: WoodsState, world: WoodsWorld, b: Brain, p: Player, feel: Feel, dt: number): PlayerInput {
  const you = state.players[0]!
  b.timer -= dt
  b.sweep += dt
  let speed = 1, tie = false, pitch = -0.22 + Math.sin(b.sweep * 0.7) * 0.12, yawOffset = Math.sin(b.sweep * 0.45) * 0.55
  const toYou = Math.hypot(you.x - p.x, you.z - p.z)
  if (you.signal > SIGNAL_HOLD && b.mode !== "regroup" && b.mode !== "signal" && toYou < 260) {
    // Reply with your own beam, then head over.
    b.mode = "signal"; b.timer = 1.6; b.tx = you.x; b.tz = you.z
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
      if (b.timer <= 0 || (p.tie && p.tie.progress >= 1)) { b.mode = "wander"; b.since = 0; b.timer = 2 }
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
      if (toYou > feel.botLeash) b.heading += wrap(Math.atan2(-(you.x - p.x), -(you.z - p.z)) - b.heading) * Math.min(1, dt * 1.5)
      const [ax, , az] = viewDir(b.heading, 0)
      const ahead = { x: p.x + ax * 8, z: p.z + az * 8 }
      const h = world.params.half - 12
      if (isDeepWater(world, ahead.x, ahead.z) || Math.abs(ahead.x) > h || Math.abs(ahead.z) > h) b.heading += dt * 2.5
      b.since += Math.hypot(p.vx, p.vz) * dt
      if (b.since > feel.botTapeEvery && tieTarget(world, { ...p, yaw: b.heading }, feel.tapeReach + 0.6)) { b.mode = "tie"; b.timer = feel.tapeTieTime + 0.6 }
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

export function stepWoods(state: WoodsState, world: WoodsWorld, inputs: ReadonlyMap<number, PlayerInput>, dt: number, feel: Feel = FEEL): void {
  state.t += dt
  state.events.length = 0
  for (const p of state.players) {
    const brain = p.bot ? state.brains.find((b) => b.id === p.id) : undefined
    const input = brain ? botInput(state, world, brain, p, feel, dt) : inputs.get(p.id)
    if (!input) continue
    if (input.pos) {
      p.x = input.pos.x; p.z = input.pos.z; p.vx = input.pos.vx; p.vz = input.pos.vz
    } else {
      const speed = (p.bot ? feel.botSpeed : feel.walkSpeed * (input.sprint ? 1.8 : 1)) * (p.mapRaise > 0.5 ? feel.mapWalk : 1)
      movePlayer(world, p, input.mx ?? 0, input.mz ?? 0, speed, dt)
    }
    p.yaw = input.yaw
    p.pitch = input.pitch
    if (input.light !== p.light) state.events.push({ kind: "light", by: p.id, on: input.light })
    p.light = input.light
    stepFlicker(state, p, feel, dt)
    const raiseRate = dt / Math.max(feel.mapRaise, 0.02)
    p.mapRaise = Math.max(0, Math.min(1, p.mapRaise + (input.map ? raiseRate : -raiseRate * 1.4)))
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
}

/** Eye position of a player standing on the terrain. */
export function eyeOf(world: WoodsWorld, p: Player): [number, number, number] {
  return [p.x, standHeight(world, p.x, p.z) + EYE_HEIGHT, p.z]
}
