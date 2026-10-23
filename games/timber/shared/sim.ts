import type { LabControl } from "@arcade/kit/lab-panel"
import type { Rect } from "@arcade/kit/sim/geom"
import { type CircleSolid, stepBody } from "@arcade/kit/sim/move"
import { type BotBrain, newBrain, thinkBot } from "./bots"
import { alongFall, type FallFeel, fell, HINGE, inFallZone, landAngle, stepFall, sweepHalfWidth, type Tree, trunkHeightAt } from "./trees"

export const ARENA_HALF = 26
export const JACK_RADIUS = 0.35
/** Body height for crush tests. */
export const JACK_HEIGHT = 1.8
export const MAX_HP = 100
/** From the truck's centre: close enough to fit a part or climb aboard (it is 6 m long and 2.5 m wide). */
export const TRUCK_REACH = 4.2

export const WALLS: readonly Rect[] = [
  [-ARENA_HALF - 1, -ARENA_HALF - 1, ARENA_HALF + 1, -ARENA_HALF],
  [-ARENA_HALF - 1, ARENA_HALF, ARENA_HALF + 1, ARENA_HALF + 1],
  [-ARENA_HALF - 1, -ARENA_HALF, -ARENA_HALF, ARENA_HALF],
  [ARENA_HALF, -ARENA_HALF, ARENA_HALF + 1, ARENA_HALF],
]

export type ViewStyle = "iso" | "shoulder" | "top"
/** `hunt`: one chainsaw lumberjack against survivors with axes. `ffa`: everyone has a saw, last one standing. */
export type Mode = "hunt" | "ffa"
export type Role = "lumberjack" | "survivor"
export type PartKind = "fuel" | "plug" | "keys"
export const PART_KINDS: readonly PartKind[] = ["fuel", "plug", "keys"]

export const FEEL = {
  mode: "hunt" as Mode,
  playAs: "survivor" as Role,
  viewStyle: "iso" as ViewStyle,
  // Presentation: crowns (and trunks on the camera side) between the camera and the player fade out, so the forest
  // floor stays readable from above.
  canopyCut: 9,
  canopyAlpha: 0.1,
  night: 0.85,
  torchPower: 7,
  torchRange: 16,
  slowMoScale: 0.3,
  slowMoTime: 0.9,
  // Forest.
  treeCount: 260,
  heightMin: 20,
  heightMax: 30,
  notchedShare: 0.18,
  notchedCut: 0.5,
  // Felling.
  cutTime: 1.6,
  axeCutTime: 9,
  pushAt: 0.45,
  warnAt: 0.7,
  leanMax: 0.06,
  fallGravity: 22,
  fallKick: 0.14,
  bounce: 0.16,
  dominoThreshold: 0.3,
  dominoTransfer: 0.7,
  crushScale: 1,
  // Saw fight.
  sawDps: 75,
  sawReach: 1.35,
  sawArc: 60,
  sawSlow: 0.3,
  knockback: 15,
  executeTime: 1.1,
  // The engine.
  pullTime: 1.2,
  pullFlood: 0.35,
  floodSafe: 0.4,
  floodDecay: 0.15,
  floodLock: 2.5,
  fuelMax: 100,
  revBurn: 2.5,
  canFuel: 50,
  canRespawn: 35,
  gasCans: 3,
  hearRange: 30,
  // Trees on the lumberjack.
  pinTime: 4.5,
  treeHitsToKill: 2,
  // Survivors.
  survivorCount: 3,
  survivorWalk: 4.4,
  staminaMax: 4.5,
  staminaRefill: 6,
  staminaDelay: 0.8,
  downTime: 35,
  crawlSpeed: 0.8,
  reviveTime: 3,
  reviveHp: 40,
  flares: 2,
  flareThrow: 7,
  flareBurn: 9,
  flareBlindRange: 3.5,
  blindTime: 2.5,
  roundTime: 300,
  // Movement.
  moveSpeed: 5.2,
  sprintSpeed: 7.6,
  accel: 24,
  dashImpulse: 15,
  dashCooldown: 1.3,
  climbSlow: 0.45,
  // Impact presentation.
  sawHitStopMs: 60,
  landHitStopMs: 95,
  sawShake: 0.35,
  sawKick: 0.5,
  landShake: 0.95,
  // Bots.
  botCount: 3,
  botSpeed: 0.92,
  botAggro: 0.6,
  botFocus: 0.65,
  botDodge: 0.6,
  botCutRate: 0.7,
  botWarmup: 4,
  botSight: 18,
  botSightDark: 5,
  botSneak: 0.4,
  botDropTry: 0.6,
  // Round.
  restartDelay: 6,
}
export type FeelConfig = typeof FEEL

const range = (key: keyof FeelConfig, label: string, group: string, min: number, max: number, step: number, unit?: string): LabControl => ({ key, label, group, min, max, step, ...(unit ? { unit } : {}) })

export const FEEL_CONTROLS: LabControl[] = [
  {
    key: "mode",
    label: "Mode (next round)",
    group: "Round",
    type: "select",
    options: [
      { value: "hunt", label: "1 vs all: lumberjack hunts survivors" },
      { value: "ffa", label: "Free-for-all: everyone has a saw" },
    ],
  },
  {
    key: "playAs",
    label: "Play as (next round)",
    group: "Round",
    type: "select",
    options: [
      { value: "survivor", label: "Survivor" },
      { value: "lumberjack", label: "Lumberjack" },
    ],
  },
  range("roundTime", "Round length", "Round", 60, 900, 10, "s"),
  range("restartDelay", "Auto restart after", "Round", 1, 15, 0.5, "s"),
  {
    key: "viewStyle",
    label: "Camera",
    group: "Style",
    type: "select",
    options: [
      { value: "iso", label: "High chase (shows fall lines)" },
      { value: "shoulder", label: "Over the shoulder (mouse look)" },
      { value: "top", label: "Top-down" },
    ],
  },
  range("canopyCut", "Canopy cutaway width", "Style", 0, 20, 0.5, "m"),
  range("canopyAlpha", "Canopy inside cutaway", "Style", 0, 1, 0.05, "opacity"),
  range("night", "Night", "Style", 0, 1, 0.05),
  range("torchPower", "Torch brightness", "Style", 0, 10, 0.1),
  range("torchRange", "Torch reach", "Style", 2, 40, 0.5, "m"),
  range("slowMoScale", "Slow-mo speed", "Style", 0.05, 1, 0.05, "×"),
  range("slowMoTime", "Slow-mo length (crush, 3+ domino)", "Style", 0, 3, 0.05, "s"),
  range("cutTime", "Saw felling time", "Felling", 0.6, 8, 0.1, "s"),
  range("axeCutTime", "Axe felling time", "Felling", 2, 30, 0.5, "s"),
  range("pushAt", "Shove over a tree cut past", "Felling", 0.1, 1, 0.05, "cut"),
  range("warnAt", "Creak warning at", "Felling", 0.3, 0.95, 0.05, "cut"),
  range("leanMax", "Warning lean", "Felling", 0, 0.2, 0.01, "rad"),
  range("fallGravity", "Fall acceleration (g)", "Felling", 4, 60, 1, "m/s²"),
  range("fallKick", "Fall kick-off", "Felling", 0, 0.8, 0.02, "rad/s"),
  range("bounce", "Landing bounce", "Felling", 0, 0.5, 0.02),
  range("dominoThreshold", "Domino threshold", "Felling", 0, 1, 0.05, "cut"),
  range("dominoTransfer", "Domino push", "Felling", 0.1, 1.5, 0.05, "×"),
  range("crushScale", "Crown crush width", "Felling", 0.2, 1.5, 0.05, "×"),
  range("pullTime", "Pull-cord start", "Engine", 0.2, 3, 0.05, "s"),
  range("pullFlood", "Flood per pull", "Engine", 0, 1, 0.05),
  range("floodSafe", "Flood before a pull can fail", "Engine", 0, 1, 0.05),
  range("floodDecay", "Flood clearing", "Engine", 0, 1, 0.01, "/s"),
  range("floodLock", "Flooded: no start for", "Engine", 0, 8, 0.25, "s"),
  range("fuelMax", "Tank (idle seconds)", "Engine", 10, 400, 5, "s"),
  range("revBurn", "Revving burns", "Engine", 1, 6, 0.25, "×"),
  range("canFuel", "Gas can refill", "Engine", 5, 200, 5, "s"),
  range("canRespawn", "Gas can respawn", "Engine", 5, 120, 5, "s"),
  range("gasCans", "Gas cans (next round)", "Engine", 0, 8, 1),
  range("hearRange", "Engine heard within", "Engine", 5, 80, 1, "m"),
  range("sawDps", "Saw damage", "Saw fight", 10, 300, 5, "hp/s"),
  range("sawReach", "Saw reach", "Saw fight", 0.8, 2.2, 0.05, "m"),
  range("sawArc", "Saw arc", "Saw fight", 20, 120, 5, "°"),
  range("sawSlow", "Victim slowed to", "Saw fight", 0, 1, 0.05, "×"),
  range("knockback", "Release knockback", "Saw fight", 0, 30, 0.5, "m/s"),
  range("executeTime", "Execution hold", "Saw fight", 0.2, 4, 0.1, "s"),
  range("pinTime", "Tree pins the lumberjack for", "Counterplay", 0.5, 10, 0.25, "s"),
  range("treeHitsToKill", "Trees to kill the lumberjack", "Counterplay", 1, 4, 1),
  range("flares", "Flares each", "Counterplay", 0, 6, 1),
  range("flareThrow", "Flare throw", "Counterplay", 2, 15, 0.5, "m"),
  range("flareBurn", "Flare burn", "Counterplay", 1, 30, 0.5, "s"),
  range("flareBlindRange", "Flare blinds within", "Counterplay", 0.5, 8, 0.25, "m"),
  range("blindTime", "Blinded for", "Counterplay", 0.2, 6, 0.1, "s"),
  range("survivorCount", "Survivors (next round)", "Survivors", 1, 6, 1),
  range("survivorWalk", "Survivor walk", "Survivors", 2, 8, 0.1, "m/s"),
  range("sprintSpeed", "Sprint speed", "Survivors", 3, 14, 0.1, "m/s"),
  range("staminaMax", "Stamina", "Survivors", 0.5, 15, 0.25, "s"),
  range("staminaRefill", "Stamina refill", "Survivors", 1, 20, 0.5, "s"),
  range("staminaDelay", "Refill delay", "Survivors", 0, 3, 0.1, "s"),
  range("downTime", "Downed bleed-out", "Survivors", 5, 90, 1, "s"),
  range("crawlSpeed", "Crawl speed", "Survivors", 0, 2, 0.05, "m/s"),
  range("reviveTime", "Revive hold", "Survivors", 0.5, 8, 0.25, "s"),
  range("reviveHp", "Revived with", "Survivors", 5, 100, 5, "hp"),
  range("sawHitStopMs", "Saw contact hit-stop", "Impact", 0, 120, 5, "ms"),
  range("landHitStopMs", "Tree landing hit-stop", "Impact", 0, 120, 5, "ms"),
  range("sawShake", "Saw shake", "Impact", 0, 1, 0.05),
  range("sawKick", "Chain kickback", "Impact", 0, 2, 0.05, "m"),
  range("landShake", "Landing shake", "Impact", 0, 1.5, 0.05),
  range("moveSpeed", "Lumberjack walk", "Movement", 2, 10, 0.1, "m/s"),
  range("accel", "Acceleration", "Movement", 6, 50, 1, "/s"),
  range("dashImpulse", "Lunge impulse (revved)", "Movement", 4, 30, 0.5, "m/s"),
  range("dashCooldown", "Lunge cooldown", "Movement", 0.2, 4, 0.05, "s"),
  range("climbSlow", "Climbing a log", "Movement", 0.1, 1, 0.05, "×"),
  range("treeCount", "Tree count (next round)", "Forest", 30, 400, 5),
  range("heightMin", "Tree height min (next round)", "Forest", 8, 30, 1, "m"),
  range("heightMax", "Tree height max (next round)", "Forest", 10, 40, 1, "m"),
  range("notchedShare", "Pre-notched trees (next round)", "Forest", 0, 0.8, 0.02),
  range("notchedCut", "Pre-notch depth", "Forest", 0, 0.95, 0.05, "cut"),
  range("botCount", "Free-for-all bots (next round)", "Bots", 0, 7, 1),
  range("botSpeed", "Bot speed", "Bots", 0, 1.5, 0.02, "×"),
  range("botAggro", "Bot aggression", "Bots", 0, 1, 0.05),
  range("botFocus", "Bots target you", "Bots", 0, 1, 0.05),
  range("botDodge", "Bots dodge falling trees", "Bots", 0, 1, 0.05),
  range("botCutRate", "Bot cutting speed", "Bots", 0.1, 2, 0.05, "×"),
  range("botWarmup", "Bots hold off at round start", "Bots", 0, 15, 0.5, "s"),
  range("botSight", "Lumberjack bot sees a torch at", "Bots", 2, 40, 1, "m"),
  range("botSightDark", "…and a dark survivor at", "Bots", 0, 15, 0.5, "m"),
  range("botSneak", "Lumberjack bot sneaks (engine off)", "Bots", 0, 1, 0.05),
  range("botDropTry", "Survivor bots try tree drops", "Bots", 0, 1, 0.05),
]

export type SawTarget = { kind: "tree" | "jack"; id: number } | null
export type Engine = "off" | "pulling" | "on"

export type Jack = {
  id: number
  bot: boolean
  role: Role
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  hp: number
  alive: boolean
  /** Mouse0 held: the saw is revved (or the axe swinging). */
  trigger: boolean
  target: SawTarget
  /** Seconds of continuous contact with the current lumberjack target. */
  contact: number
  goreT: number
  dashCd: number
  dashing: number
  /** Being sawed: slowed and held on the bar. */
  held: number
  /** Knocked: input ignored and friction low, so the body skids. */
  knocked: number
  /** Standing on a fallen log (0..1), for the climb slowdown and the lift you see. */
  climb: number
  killedBy: number
  cause: "saw" | "crush" | "bleed" | null
  brain: BotBrain
  // The lumberjack's saw.
  engine: Engine
  pullT: number
  flood: number
  floodLock: number
  fuel: number
  // Survivors.
  stamina: number
  restT: number
  exhausted: boolean
  sprinting: boolean
  torch: boolean
  downed: boolean
  bleed: number
  /** Revive progress 0..1 while a teammate holds E on them, and when they last did. */
  revive: number
  helpedAt: number
  /** Execution progress (s) while the saw is on them downed. */
  exec: number
  carrying: PartKind | null
  flares: number
  /** Lumberjack: blinded by a flare (s), pinned under a tree (s), and trees taken. */
  blind: number
  stun: number
  treeHits: number
  escaped: boolean
  chopT: number
  /** How loud (×`hearRange`) this body is right now. */
  noise: number
}

export type JackInput = {
  mx: number
  my: number
  aim: number
  saw: boolean
  dash: boolean
  sprint: boolean
  /** Presses (one tick): pull or kill the engine, the torch switch, throw a flare. */
  engine: boolean
  torch: boolean
  flare: boolean
  /** Held: revive a teammate, shove over a cut tree. */
  use: boolean
}
export const NO_INPUT: JackInput = { mx: 0, my: 0, aim: 0, saw: false, dash: false, sprint: false, engine: false, torch: false, flare: false, use: false }

/** A truck part or (for the lumberjack) a gas can, lying in the woods. */
export type Item = { id: number; kind: PartKind | "gas"; x: number; y: number; taken: boolean; respawn: number }
export type Flare = { id: number; by: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; landed: boolean; blinded: number[] }
export type Truck = { x: number; y: number; yaw: number; parts: PartKind[]; started: boolean }

export type SimEvent =
  | { kind: "warn"; tree: number }
  | { kind: "fell"; tree: number; by: number }
  | { kind: "domino"; from: number; tree: number; chain: number }
  | { kind: "brush"; from: number; tree: number }
  | { kind: "land"; tree: number; speed: number }
  | { kind: "settle"; tree: number }
  | { kind: "crush"; jack: number; tree: number; by: number }
  | { kind: "pin"; jack: number; tree: number; by: number }
  | { kind: "sawStart"; by: number; jack: number }
  | { kind: "gore"; by: number; jack: number; x: number; y: number; dir: number }
  | { kind: "fling"; by: number; jack: number; dir: number }
  | { kind: "kill"; by: number; jack: number; dir: number }
  | { kind: "down"; by: number; jack: number; dir: number }
  | { kind: "execute"; by: number; jack: number; dir: number }
  | { kind: "bleedout"; jack: number }
  | { kind: "revive"; jack: number; by: number }
  | { kind: "clash"; a: number; b: number; x: number; y: number; dir: number }
  | { kind: "dash"; jack: number }
  | { kind: "pull"; jack: number; extra: boolean }
  | { kind: "start"; jack: number }
  | { kind: "sputter"; jack: number; flooded: boolean }
  | { kind: "stop"; jack: number; why: "off" | "dry" | "stall" }
  | { kind: "chop"; jack: number; tree: number }
  | { kind: "push"; jack: number; tree: number }
  | { kind: "torch"; jack: number; on: boolean }
  | { kind: "flare"; jack: number; flare: number }
  | { kind: "blind"; jack: number; flare: number }
  | { kind: "pickup"; jack: number; item: PartKind | "gas" }
  | { kind: "drop"; jack: number; item: PartKind }
  | { kind: "install"; jack: number; part: PartKind }
  | { kind: "truck" }
  | { kind: "escape"; jack: number }
  | { kind: "over"; winner: number; side: Role | null }

export type World = {
  t: number
  seed: number
  rng: number
  round: number
  mode: Mode
  trees: Tree[]
  jacks: Jack[]
  items: Item[]
  flares: Flare[]
  truck: Truck | null
  events: SimEvent[]
  phase: "play" | "over"
  overAt: number
  /** Free-for-all: the last one standing (−1 none). */
  winner: number
  /** 1 vs all: the side that won. */
  side: Role | null
}

/** Seeded mulberry32 on plain state, so a World is plain data. */
export function rand(w: { rng: number }): number {
  w.rng = (w.rng + 0x6d2b79f5) >>> 0
  let t = w.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function spawnPoints(n: number, radius = 12): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + (i / n) * Math.PI * 2
    out.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius })
  }
  return out
}

export function newJack(id: number, bot: boolean, x: number, y: number, role: Role = "lumberjack", feel: Readonly<FeelConfig> = FEEL): Jack {
  return {
    id, bot, role, x, y, vx: 0, vy: 0, aim: Math.atan2(-y, -x), hp: MAX_HP, alive: true, trigger: false, target: null,
    contact: 0, goreT: 0, dashCd: 0, dashing: 0, held: 0, knocked: 0, climb: 0, killedBy: -1, cause: null, brain: newBrain(id + 1),
    engine: role === "lumberjack" ? "on" : "off", pullT: 0, flood: 0, floodLock: 0, fuel: feel.fuelMax,
    stamina: feel.staminaMax, restT: 0, exhausted: false, sprinting: false, torch: role === "survivor", downed: false, bleed: 0,
    revive: 0, helpedAt: -1, exec: 0, carrying: null, flares: role === "survivor" ? Math.round(feel.flares) : 0, blind: 0, stun: 0, treeHits: 0,
    escaped: false, chopT: 0, noise: 0,
  }
}

export function newTree(id: number, x: number, y: number, h: number): Tree {
  return {
    id, x, y, r: 0.25, h, crownR: 2.2, crown0: 0.45, cut: 0, cdx: 0, cdy: 0, state: "standing", theta: 0, omega: 0,
    fx: 1, fy: 0, warned: false, notched: false, credit: -1, bounces: 0, touched: [], crushed: [], chain: 0,
  }
}

/** In play: alive and not yet driven off in the truck. */
export const active = (j: Jack) => j.alive && !j.escaped
/** On their feet. */
export const upright = (j: Jack) => j.alive && !j.escaped && !j.downed
export const lumberjackOf = (w: World) => w.jacks.find((j) => j.role === "lumberjack" && w.mode === "hunt")

type Clear = { x: number; y: number; r: number }

/** Packs the arena with trees (rejection-sampled, min spacing), clear round the spawns, the truck and the items. */
export function growForest(w: World, feel: Readonly<FeelConfig>, clear: readonly Clear[] = []): void {
  const trees: Tree[] = []
  const lo = Math.min(feel.heightMin, feel.heightMax)
  const hi = Math.max(feel.heightMin, feel.heightMax)
  const want = Math.round(feel.treeCount)
  const area = (ARENA_HALF * 2 - 2) ** 2
  const spacing = Math.max(1.4, Math.min(3.2, Math.sqrt(area / Math.max(1, want)) * 0.72))
  for (let tries = 0; trees.length < want && tries < want * 60; tries++) {
    const x = (rand(w) * 2 - 1) * (ARENA_HALF - 1.2)
    const y = (rand(w) * 2 - 1) * (ARENA_HALF - 1.2)
    if (clear.some((s) => Math.hypot(s.x - x, s.y - y) < s.r)) continue
    if (trees.some((t) => (t.x - x) ** 2 + (t.y - y) ** 2 < spacing * spacing)) continue
    const t = newTree(trees.length, x, y, lo + rand(w) * (hi - lo))
    t.crownR = 1.8 + rand(w) * 1.0
    if (rand(w) < feel.notchedShare) {
      t.notched = true
      t.cut = feel.notchedCut
    }
    trees.push(t)
  }
  w.trees = trees
}

export function createWorld(seed = 1, feel: Readonly<FeelConfig> = FEEL): World {
  const w: World = { t: 0, seed, rng: seed >>> 0, round: 0, mode: feel.mode, trees: [], jacks: [], items: [], flares: [], truck: null, events: [], phase: "play", overAt: 0, winner: -1, side: null }
  resetRound(w, feel)
  return w
}

/** A spot inside the arena at least `gap` from every point in `away`. */
function openSpot(w: World, away: readonly Clear[], inset = 3): { x: number; y: number } {
  let best = { x: 0, y: 0 }
  let bestGap = -Infinity
  for (let i = 0; i < 80; i++) {
    const p = { x: (rand(w) * 2 - 1) * (ARENA_HALF - inset), y: (rand(w) * 2 - 1) * (ARENA_HALF - inset) }
    const gap = Math.min(...away.map((a) => Math.hypot(a.x - p.x, a.y - p.y) - a.r), 99)
    if (gap >= 0) return p
    if (gap > bestGap) {
      bestGap = gap
      best = p
    }
  }
  return best
}

export function resetRound(w: World, feel: Readonly<FeelConfig> = FEEL): void {
  w.round++
  w.rng = (w.seed * 7919 + w.round * 104729) >>> 0
  w.t = 0
  w.mode = feel.mode
  w.phase = "play"
  w.winner = -1
  w.side = null
  w.events = []
  w.items = []
  w.flares = []
  w.truck = null
  const clear: Clear[] = []
  if (w.mode === "ffa") {
    const n = 1 + Math.max(0, Math.round(feel.botCount))
    w.jacks = spawnPoints(n).map((p, i) => newJack(i, i > 0, p.x, p.y, "lumberjack", feel))
    for (const j of w.jacks) clear.push({ x: j.x, y: j.y, r: 2.6 })
    growForest(w, feel, clear)
    return
  }
  // The logging truck parks on one edge, nose in; the lumberjack starts in the middle, survivors round the far side.
  const side = Math.floor(rand(w) * 4)
  const along = (rand(w) * 2 - 1) * (ARENA_HALF - 8)
  const inset = ARENA_HALF - 3.2
  const truckAt = [
    { x: along, y: inset, yaw: -Math.PI / 2 },
    { x: inset, y: along, yaw: Math.PI },
    { x: along, y: -inset, yaw: Math.PI / 2 },
    { x: -inset, y: along, yaw: 0 },
  ][side]!
  w.truck = { ...truckAt, parts: [], started: false }
  clear.push({ x: truckAt.x, y: truckAt.y, r: 6.5 })
  const survivors = Math.max(1, Math.round(feel.survivorCount))
  const roles: Role[] = feel.playAs === "lumberjack" ? ["lumberjack", ...Array<Role>(survivors).fill("survivor")] : ["survivor", "lumberjack", ...Array<Role>(survivors - 1).fill("survivor")]
  const away = Math.atan2(-truckAt.y, -truckAt.x)
  let s = 0
  w.jacks = roles.map((role, i) => {
    if (role === "lumberjack") return newJack(i, i > 0, -truckAt.x * 0.15, -truckAt.y * 0.15, role, feel)
    // Survivors spread along an arc on the truck's side of the woods, but not at it.
    const a = away + Math.PI + ((s++ - (survivors - 1) / 2) / Math.max(1, survivors)) * 2.4
    return newJack(i, i > 0, Math.cos(a) * 15, Math.sin(a) * 15, role, feel)
  })
  for (const j of w.jacks) clear.push({ x: j.x, y: j.y, r: 2.6 })
  // Parts are far from the truck and from each other; gas cans anywhere.
  const spots: Clear[] = [{ x: truckAt.x, y: truckAt.y, r: ARENA_HALF * 0.9 }]
  for (const kind of PART_KINDS) {
    const p = openSpot(w, spots)
    spots.push({ ...p, r: 12 })
    w.items.push({ id: w.items.length, kind, x: p.x, y: p.y, taken: false, respawn: 0 })
  }
  for (let i = 0; i < Math.round(feel.gasCans); i++) {
    const p = openSpot(w, [...spots.slice(1).map((c) => ({ ...c, r: 6 })), { x: truckAt.x, y: truckAt.y, r: 8 }])
    spots.push({ ...p, r: 10 })
    w.items.push({ id: w.items.length, kind: "gas", x: p.x, y: p.y, taken: false, respawn: 0 })
  }
  for (const it of w.items) clear.push({ x: it.x, y: it.y, r: 1.4 })
  growForest(w, feel, clear)
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** Can `j`'s blade bite `o`? Saws cut anyone in free-for-all; in a hunt only the lumberjack's saw cuts, and only survivors. */
function canCut(w: World, j: Jack, o: Jack): boolean {
  if (o === j || !active(o)) return false
  if (w.mode === "ffa") return true
  return j.role === "lumberjack" && o.role === "survivor"
}

/** What the blade would bite now: a body in the arc first (lumberjacks only), else the nearest trunk in front. */
export function sawTarget(w: World, j: Jack, feel: Readonly<FeelConfig>): SawTarget {
  const ax = Math.cos(j.aim)
  const ay = Math.sin(j.aim)
  const arc = ((feel.sawArc * Math.PI) / 180) * 0.5
  let best: SawTarget = null
  let bestD = Infinity
  if (j.role === "lumberjack") {
    for (const o of w.jacks) {
      if (!canCut(w, j, o)) continue
      const dx = o.x - j.x
      const dy = o.y - j.y
      const d = Math.hypot(dx, dy)
      // A downed body is low: the bar reaches it from a step further back.
      const reach = feel.sawReach + JACK_RADIUS + (o.downed ? 0.35 : 0)
      if (d > reach || d < 1e-6) continue
      if (Math.abs(wrap(Math.atan2(dy, dx) - j.aim)) > arc) continue
      if (d < bestD) {
        bestD = d
        best = { kind: "jack", id: o.id }
      }
    }
    if (best) return best
  }
  // The blade sits ahead of the body; a trunk within its reach and in front bites.
  const sx = j.x + ax * 0.55
  const sy = j.y + ay * 0.55
  for (const t of w.trees) {
    if (t.state !== "standing") continue
    const d = Math.hypot(t.x - sx, t.y - sy) - t.r
    if (d > 0.6) continue
    if ((t.x - j.x) * ax + (t.y - j.y) * ay < 0) continue
    if (d < bestD) {
      bestD = d
      best = { kind: "tree", id: t.id }
    }
  }
  return best
}

/** A standing tree in front of `j`, cut deep enough to shove over, within arm's reach. */
export function pushTarget(w: World, j: Jack, feel: Readonly<FeelConfig>): Tree | null {
  const ax = Math.cos(j.aim)
  const ay = Math.sin(j.aim)
  let best: Tree | null = null
  let bestD = Infinity
  for (const t of w.trees) {
    if (t.state !== "standing" || t.cut < feel.pushAt) continue
    const dx = t.x - j.x
    const dy = t.y - j.y
    const d = Math.hypot(dx, dy) - t.r
    if (d > 1.1 || dx * ax + dy * ay < -0.2) continue
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return best
}

/** A downed teammate within reach of `j`'s hands. */
export function reviveTarget(w: World, j: Jack): Jack | null {
  if (j.role !== "survivor" || !upright(j)) return null
  let best: Jack | null = null
  let bestD = 1.6
  for (const o of w.jacks) {
    if (o === j || !o.alive || !o.downed || o.role !== "survivor") continue
    const d = Math.hypot(o.x - j.x, o.y - j.y)
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best
}

function nearbyTrunks(w: World, x: number, y: number, out: CircleSolid[]): CircleSolid[] {
  out.length = 0
  for (const t of w.trees) {
    // Stumps stay solid after the tree falls.
    if ((t.x - x) ** 2 + (t.y - y) ** 2 < 9) out.push({ x: t.x, y: t.y, radius: t.r, collisionId: 1000 + t.id })
  }
  for (const o of w.jacks) {
    if (active(o) && (o.x - x) ** 2 + (o.y - y) ** 2 < 9) out.push({ x: o.x, y: o.y, radius: JACK_RADIUS, collisionId: o.id })
  }
  const tr = w.truck
  if (tr && (tr.x - x) ** 2 + (tr.y - y) ** 2 < 36) {
    // The truck as three circles along its length.
    const fx = Math.cos(tr.yaw)
    const fy = Math.sin(tr.yaw)
    for (const k of [-1.9, 0, 1.9]) out.push({ x: tr.x + fx * k, y: tr.y + fy * k, radius: 1.25, collisionId: 5000 })
  }
  return out
}

/** How much a body at (x, y) is up on a fallen trunk or in its crown (0..1). */
export function logClimb(w: World, x: number, y: number): number {
  let best = 0
  for (const t of w.trees) {
    if (t.state !== "down") continue
    const { s, d } = alongFall(t, t.fx, t.fy, x, y)
    if (s < 0 || s > t.h) continue
    const c0 = t.crown0 * t.h
    const reach = s < c0 ? t.r + JACK_RADIUS : sweepHalfWidth(t, s) * 0.7
    if (d < reach) best = Math.max(best, s < c0 ? 1 - (d / reach) * 0.5 : 0.6)
  }
  return best
}

const scratch: CircleSolid[] = []

function stopEngine(w: World, j: Jack, why: "off" | "dry" | "stall"): void {
  if (j.engine === "off") return
  j.engine = "off"
  j.pullT = 0
  w.events.push({ kind: "stop", jack: j.id, why })
}

/** Pull-cord starts: each pull (and every extra yank mid-pull) floods the engine a little; a flooded one fails. */
function stepEngine(w: World, j: Jack, input: JackInput, dt: number, feel: Readonly<FeelConfig>): void {
  j.flood = Math.max(0, j.flood - feel.floodDecay * dt)
  j.floodLock = Math.max(0, j.floodLock - dt)
  if (w.mode === "ffa") {
    j.engine = "on"
    return
  }
  if (j.stun > 0) {
    stopEngine(w, j, "stall")
    return
  }
  if (input.engine) {
    if (j.engine === "on") stopEngine(w, j, "off")
    else if (j.engine === "pulling") {
      j.flood = Math.min(1.5, j.flood + feel.pullFlood)
      w.events.push({ kind: "pull", jack: j.id, extra: true })
    } else if (j.floodLock > 0) w.events.push({ kind: "sputter", jack: j.id, flooded: true })
    else {
      j.engine = "pulling"
      j.pullT = 0
      j.flood = Math.min(1.5, j.flood + feel.pullFlood)
      w.events.push({ kind: "pull", jack: j.id, extra: false })
    }
  }
  if (j.engine === "pulling") {
    j.pullT += dt
    if (j.pullT >= feel.pullTime) {
      const fail = Math.min(1, Math.max(0, (j.flood - feel.floodSafe) / Math.max(0.01, 1 - feel.floodSafe)))
      j.pullT = 0
      if (j.fuel <= 0 || rand(w) < fail) {
        j.engine = "off"
        const flooded = j.flood >= 1
        if (flooded) {
          j.floodLock = feel.floodLock
          j.flood = 0.5
        }
        w.events.push({ kind: "sputter", jack: j.id, flooded })
      } else {
        j.engine = "on"
        w.events.push({ kind: "start", jack: j.id })
      }
    }
  }
  if (j.engine === "on") {
    j.fuel = Math.max(0, j.fuel - dt * (j.trigger ? feel.revBurn : 1))
    if (j.fuel <= 0) stopEngine(w, j, "dry")
  }
}

function stepJack(w: World, j: Jack, input: JackInput, dt: number, feel: Readonly<FeelConfig>): void {
  j.dashCd = Math.max(0, j.dashCd - dt)
  j.dashing = Math.max(0, j.dashing - dt)
  j.held = Math.max(0, j.held - dt)
  j.knocked = Math.max(0, j.knocked - dt)
  j.blind = Math.max(0, j.blind - dt)
  j.stun = Math.max(0, j.stun - dt)
  if (!active(j)) {
    j.trigger = false
    j.target = null
    j.contact = 0
    j.noise = 0
    return
  }
  const hunt = w.mode === "hunt"
  const knocked = j.knocked > 0
  const stunned = j.stun > 0
  if (!stunned) j.aim = input.aim
  if (j.role === "lumberjack") stepEngine(w, j, input, dt, feel)
  const revved = j.role === "lumberjack" && j.engine === "on" && input.saw
  if (input.dash && revved && j.dashCd <= 0 && !knocked && j.held <= 0 && !stunned && j.blind <= 0) {
    j.vx += Math.cos(j.aim) * feel.dashImpulse
    j.vy += Math.sin(j.aim) * feel.dashImpulse
    j.dashCd = feel.dashCooldown
    j.dashing = 0.22
    w.events.push({ kind: "dash", jack: j.id })
  }
  const survivor = hunt && j.role === "survivor"
  let reviving: Jack | null = null
  if (survivor && !j.downed) {
    if (input.torch) {
      j.torch = !j.torch
      w.events.push({ kind: "torch", jack: j.id, on: j.torch })
    }
    if (input.flare && j.flares > 0) throwFlare(w, j, feel)
    if (input.use) {
      reviving = reviveTarget(w, j)
      if (reviving) {
        reviving.revive += dt / Math.max(0.1, feel.reviveTime)
        reviving.helpedAt = w.t
        reviving.bleed += dt // the bleed pauses while someone holds them
        if (reviving.revive >= 1) {
          reviving.downed = false
          reviving.revive = 0
          reviving.exec = 0
          reviving.hp = feel.reviveHp
          w.events.push({ kind: "revive", jack: reviving.id, by: j.id })
        }
      } else {
        const t = pushTarget(w, j, feel)
        if (t) {
          // Shove it over away from you: your push wins over whichever side it was cut from.
          const dx = t.x - j.x
          const dy = t.y - j.y
          const l = Math.hypot(dx, dy) || 1
          t.cdx = (dx / l) * 10
          t.cdy = (dy / l) * 10
          t.cut = 1
          t.credit = j.id
          w.events.push({ kind: "push", jack: j.id, tree: t.id })
        }
      }
    }
  }
  j.climb = logClimb(w, j.x, j.y)
  const working = j.trigger && j.target !== null
  // Sprint: free in a free-for-all, on stamina for survivors; the lumberjack walks.
  let speed = feel.moveSpeed
  j.sprinting = false
  if (!hunt) speed = input.sprint && !working ? feel.sprintSpeed : feel.moveSpeed
  else if (survivor) {
    const moving = Math.hypot(input.mx, input.my) > 0.2
    const canSprint = input.sprint && moving && !working && !j.downed && !j.exhausted && j.stamina > 0
    if (canSprint) {
      j.sprinting = true
      j.stamina = Math.max(0, j.stamina - dt)
      j.restT = 0
      if (j.stamina <= 0) j.exhausted = true
    } else {
      j.restT += dt
      if (j.restT >= feel.staminaDelay) j.stamina = Math.min(feel.staminaMax, j.stamina + (dt * feel.staminaMax) / Math.max(0.1, feel.staminaRefill))
      if (j.exhausted && j.stamina >= feel.staminaMax * 0.35) j.exhausted = false
    }
    speed = j.sprinting ? feel.sprintSpeed : feel.survivorWalk
    if (j.carrying) speed *= 0.92
    if (j.downed) speed = feel.crawlSpeed
    if (reviving) speed = 0
  }
  if (j.bot) speed *= feel.botSpeed
  if (working) speed *= j.role === "survivor" && hunt ? 0.15 : 0.55
  if (j.engine === "pulling") speed *= 0.45
  if (j.blind > 0) speed *= 0.45
  if (j.held > 0) speed *= feel.sawSlow
  if (stunned) speed = 0
  speed *= 1 - j.climb * (1 - feel.climbSlow)
  const accel = knocked || j.dashing > 0 ? 2.2 : feel.accel
  const mx = knocked || stunned ? 0 : input.mx
  const my = knocked || stunned ? 0 : input.my
  stepBody(j, mx, my, speed, WALLS, dt, JACK_RADIUS, accel, nearbyTrunks(w, j.x, j.y, scratch).filter((c) => c.collisionId !== j.id))
  // Noise: what the others hear, as a multiple of `hearRange`.
  const moving = Math.hypot(j.vx, j.vy) > 1
  if (j.role === "lumberjack") j.noise = j.engine === "on" ? (j.trigger ? (j.target ? 2 : 1.6) : 1) : j.engine === "pulling" ? 0.6 : moving ? 0.15 : 0
  else j.noise = j.sprinting ? 0.35 : working ? 0.5 : moving ? 0.08 : 0
  if (hunt) pickUp(w, j, feel)
}

function throwFlare(w: World, j: Jack, feel: Readonly<FeelConfig>): void {
  j.flares--
  const vz = 4
  const z0 = 1.2
  const g = 9.8
  const tFlight = (vz + Math.sqrt(vz * vz + 2 * g * z0)) / g
  const v = feel.flareThrow / tFlight
  const f: Flare = {
    id: w.flares.length, by: j.id, x: j.x + Math.cos(j.aim) * 0.4, y: j.y + Math.sin(j.aim) * 0.4, z: z0,
    vx: Math.cos(j.aim) * v + j.vx * 0.3, vy: Math.sin(j.aim) * v + j.vy * 0.3, vz, age: 0, landed: false, blinded: [],
  }
  w.flares.push(f)
  w.events.push({ kind: "flare", jack: j.id, flare: f.id })
}

function stepFlares(w: World, dt: number, feel: Readonly<FeelConfig>): void {
  for (const f of w.flares) {
    f.age += dt
    if (!f.landed) {
      f.vz -= 9.8 * dt
      f.x += f.vx * dt
      f.y += f.vy * dt
      f.z += f.vz * dt
      if (f.z <= 0.05) {
        f.z = 0.05
        f.landed = true
        f.vx *= 0.25
        f.vy *= 0.25
      }
    } else {
      f.x += f.vx * dt
      f.y += f.vy * dt
      f.vx *= Math.exp(-6 * dt)
      f.vy *= Math.exp(-6 * dt)
    }
    f.x = Math.max(-ARENA_HALF + 0.2, Math.min(ARENA_HALF - 0.2, f.x))
    f.y = Math.max(-ARENA_HALF + 0.2, Math.min(ARENA_HALF - 0.2, f.y))
    if (f.age > feel.flareBurn) continue
    for (const j of w.jacks) {
      if (j.role !== "lumberjack" || !active(j) || f.blinded.includes(j.id)) continue
      if (Math.hypot(j.x - f.x, j.y - f.y) > feel.flareBlindRange) continue
      f.blinded.push(j.id)
      j.blind = feel.blindTime
      w.events.push({ kind: "blind", jack: j.id, flare: f.id })
    }
  }
}

function pickUp(w: World, j: Jack, feel: Readonly<FeelConfig>): void {
  if (j.downed) return
  for (const it of w.items) {
    if (it.taken || Math.hypot(it.x - j.x, it.y - j.y) > 1.1) continue
    if (it.kind === "gas") {
      if (j.role !== "lumberjack" || j.fuel > feel.fuelMax - 5) continue
      j.fuel = Math.min(feel.fuelMax, j.fuel + feel.canFuel)
      it.taken = true
      it.respawn = feel.canRespawn
      w.events.push({ kind: "pickup", jack: j.id, item: "gas" })
    } else if (j.role === "survivor" && !j.carrying) {
      j.carrying = it.kind
      it.taken = true
      w.events.push({ kind: "pickup", jack: j.id, item: it.kind })
    }
  }
  const tr = w.truck
  if (!tr || j.role !== "survivor") return
  const d = Math.hypot(tr.x - j.x, tr.y - j.y)
  if (j.carrying && d < TRUCK_REACH) {
    tr.parts.push(j.carrying)
    w.events.push({ kind: "install", jack: j.id, part: j.carrying })
    j.carrying = null
    if (!tr.started && PART_KINDS.every((k) => tr.parts.includes(k))) {
      tr.started = true
      w.events.push({ kind: "truck" })
    }
  }
  if (tr.started && d < TRUCK_REACH) {
    j.escaped = true
    j.vx = j.vy = 0
    j.trigger = false
    j.target = null
    j.contact = 0
    w.events.push({ kind: "escape", jack: j.id })
  }
}

/** Drop what they carry where they fall: the part goes back into the woods. */
function dropPart(w: World, j: Jack): void {
  if (!j.carrying) return
  const it = w.items.find((i) => i.kind === j.carrying)
  if (it) {
    it.x = j.x
    it.y = j.y
    it.taken = false
  }
  w.events.push({ kind: "drop", jack: j.id, item: j.carrying })
  j.carrying = null
}

function release(w: World, j: Jack, feel: Readonly<FeelConfig>): void {
  const t = j.target
  if (t?.kind === "jack" && j.contact > 0) {
    const v = w.jacks[t.id]
    if (v && upright(v)) {
      const dir = Math.atan2(v.y - j.y, v.x - j.x)
      v.vx += Math.cos(dir) * feel.knockback
      v.vy += Math.sin(dir) * feel.knockback
      v.knocked = 0.35
      w.events.push({ kind: "fling", by: j.id, jack: v.id, dir })
    }
  }
  j.contact = 0
}

/** What each blade bites this tick, decided for everyone before any blade cuts (so two saws meeting see each other). */
function aimSaw(w: World, j: Jack, input: JackInput, feel: Readonly<FeelConfig>): void {
  if (!active(j)) return
  const hunt = w.mode === "hunt"
  const able = j.knocked <= 0 && j.stun <= 0 && !j.downed && (j.role === "survivor" || !hunt || j.engine === "on")
  const want = input.saw && able
  const next = want ? sawTarget(w, j, feel) : null
  const prev = j.target
  const same = prev && next && prev.kind === next.kind && prev.id === next.id
  if (prev && !same) {
    // Letting go of the trigger on someone throws them; sliding off them does not.
    if (!want) release(w, j, feel)
    else j.contact = 0
  }
  j.trigger = want
  j.target = next
  if (!next) j.contact = 0
}

function stepSaw(w: World, j: Jack, dt: number, feel: Readonly<FeelConfig>): void {
  const next = j.target
  if (!active(j) || !next) return
  const hunt = w.mode === "hunt"
  if (next.kind === "tree") {
    const t = w.trees[next.id]!
    const dx = t.x - j.x
    const dy = t.y - j.y
    const l = Math.hypot(dx, dy) || 1
    const axe = hunt && j.role === "survivor"
    const time = axe ? feel.axeCutTime : feel.cutTime
    t.cut = Math.min(1, t.cut + (dt * (j.bot ? feel.botCutRate : 1)) / Math.max(0.05, time))
    t.cdx += (dx / l) * dt
    t.cdy += (dy / l) * dt
    if (!t.notched || t.cut > feel.notchedCut) t.credit = j.id
    if (axe) {
      j.chopT -= dt
      if (j.chopT <= 0) {
        j.chopT = 0.55
        w.events.push({ kind: "chop", jack: j.id, tree: t.id })
      }
    }
    return
  }
  const v = w.jacks[next.id]!
  if (!active(v)) {
    j.target = null
    j.contact = 0
    return
  }
  const dir = Math.atan2(v.y - j.y, v.x - j.x)
  // Bar on bar: two revved saws meeting bind and throw sparks, and shove their owners apart.
  if (v.trigger && v.target?.kind === "jack" && v.target.id === j.id) {
    j.goreT -= dt
    if (j.goreT <= 0) {
      j.goreT = 0.09
      w.events.push({ kind: "clash", a: j.id, b: v.id, x: (v.x + j.x) / 2, y: (v.y + j.y) / 2, dir })
      j.vx -= Math.cos(dir) * feel.knockback * 0.35
      j.vy -= Math.sin(dir) * feel.knockback * 0.35
    }
    return
  }
  if (j.contact === 0) w.events.push({ kind: "sawStart", by: j.id, jack: v.id })
  j.contact += dt
  v.held = 0.12
  j.goreT -= dt
  if (j.goreT <= 0) {
    j.goreT = 0.07
    w.events.push({ kind: "gore", by: j.id, jack: v.id, x: (v.x + j.x) / 2, y: (v.y + j.y) / 2, dir })
  }
  if (v.downed) {
    // The execution: a short hold on someone already down.
    v.exec += dt
    if (v.exec >= feel.executeTime) {
      kill(w, v, j.id, "saw", dir)
      w.events[w.events.length - 1] = { kind: "execute", by: j.id, jack: v.id, dir }
      j.target = null
      j.contact = 0
    }
    return
  }
  v.hp -= feel.sawDps * dt
  if (v.hp > 0) return
  if (hunt && v.role === "survivor") {
    down(w, v, j.id, dir, feel)
    v.vx += Math.cos(dir) * feel.knockback * 0.12
    v.vy += Math.sin(dir) * feel.knockback * 0.12
    return
  }
  kill(w, v, j.id, "saw", dir)
  v.vx += Math.cos(dir) * feel.knockback * 0.6
  v.vy += Math.sin(dir) * feel.knockback * 0.6
  j.target = null
  j.contact = 0
}

function down(w: World, v: Jack, by: number, dir: number, feel: Readonly<FeelConfig>): void {
  v.downed = true
  v.hp = 0
  v.bleed = feel.downTime
  v.revive = 0
  v.exec = 0
  v.trigger = false
  v.target = null
  v.contact = 0
  v.killedBy = by
  dropPart(w, v)
  w.events.push({ kind: "down", by, jack: v.id, dir })
}

function kill(w: World, v: Jack, by: number, cause: "saw" | "crush" | "bleed", dir: number): void {
  if (!v.alive) return
  v.alive = false
  v.downed = false
  v.hp = 0
  v.cause = cause
  v.killedBy = by
  v.trigger = false
  v.target = null
  v.contact = 0
  if (v.role === "lumberjack") stopEngine(w, v, "stall")
  dropPart(w, v)
  w.events.push(cause === "crush" ? { kind: "crush", jack: v.id, tree: -1, by } : cause === "bleed" ? { kind: "bleedout", jack: v.id } : { kind: "kill", by, jack: v.id, dir })
}

/** Body height for the crush test: lying bodies are low, a pinned lumberjack is down on one knee. */
const bodyHeight = (j: Jack) => (j.downed ? 0.6 : j.stun > 0 ? 1.1 : JACK_HEIGHT)

function stepTrees(w: World, dt: number, feel: Readonly<FeelConfig>): void {
  const fallFeel: FallFeel = feel
  for (const t of w.trees) {
    if (t.state === "standing") {
      if (!t.warned && t.cut >= feel.warnAt && t.cut < 1) {
        t.warned = true
        w.events.push({ kind: "warn", tree: t.id })
      }
      if (t.cut >= 1) {
        const m = Math.hypot(t.cdx, t.cdy)
        const fx = m > 1e-6 ? t.cdx / m : 1
        const fy = m > 1e-6 ? t.cdy / m : 0
        fell(t, fx, fy, Math.max(0.02, fallFeel.leanMax), feel.fallKick, t.credit)
        w.events.push({ kind: "fell", tree: t.id, by: t.credit })
      }
      continue
    }
    if (t.state !== "falling") continue
    const w0 = t.omega
    const res = stepFall(t, dt, fallFeel)
    if (res === "land") w.events.push({ kind: "land", tree: t.id, speed: w0 * t.h })
    if (res === "settle") w.events.push({ kind: "settle", tree: t.id })
    // Crush anything under the trunk or crown while it is still coming down.
    if (t.omega > 0.15 || res === "land") {
      for (const j of w.jacks) {
        if (!active(j) || t.crushed.includes(j.id)) continue
        const { s, d } = alongFall(t, t.fx, t.fy, j.x, j.y)
        if (s < -JACK_RADIUS) continue
        const reach = sweepHalfWidth(t, Math.max(0, s), feel.crushScale) + JACK_RADIUS
        if (d > reach) continue
        const hgt = trunkHeightAt(t, Math.max(0, s))
        // The crown sags below the trunk line; give it a little extra drop.
        const crownDrop = s > t.crown0 * t.h ? 1.2 : 0
        if (hgt - crownDrop > bodyHeight(j)) continue
        t.crushed.push(j.id)
        crush(w, j, t, feel)
      }
    }
    // Strike standing trees in its path: partly cut ones go over with it (dominoes), sound ones shrug it off.
    if (t.state !== "falling") continue
    const reach = t.h * Math.sin(Math.min(t.theta, Math.PI / 2))
    for (const o of w.trees) {
      if (o === t || o.state !== "standing" || t.touched.includes(o.id)) continue
      const { s, d } = alongFall(t, t.fx, t.fy, o.x, o.y)
      if (s <= 0 || s > reach + o.r) continue
      const half = s < t.crown0 * t.h ? t.r + o.r + 0.05 : sweepHalfWidth(t, s) * 0.55 + o.r
      if (d > half) continue
      // Contact height must be below the other tree's top.
      if (trunkHeightAt(t, Math.min(s, reach)) > o.h + HINGE) continue
      t.touched.push(o.id)
      if (o.cut >= feel.dominoThreshold) {
        const lever = Math.min(1, s / t.h)
        fell(o, t.fx, t.fy, Math.max(0.04, o.theta), Math.max(feel.fallKick, t.omega * feel.dominoTransfer * (0.4 + lever)), t.credit)
        o.chain = t.chain + 1
        t.omega *= 0.85
        w.events.push({ kind: "domino", from: t.id, tree: o.id, chain: o.chain })
      } else {
        t.omega *= 0.96
        w.events.push({ kind: "brush", from: t.id, tree: o.id })
      }
    }
  }
}

/** A tree comes down on someone: it kills, except the hunting lumberjack, whom the first tree only pins. */
function crush(w: World, j: Jack, t: Tree, feel: Readonly<FeelConfig>): void {
  if (w.mode === "hunt" && j.role === "lumberjack") {
    const pinned = j.stun > 0
    j.treeHits++
    if (!pinned && j.treeHits < feel.treeHitsToKill) {
      j.stun = feel.pinTime
      j.trigger = false
      j.target = null
      j.contact = 0
      stopEngine(w, j, "stall")
      w.events.push({ kind: "pin", jack: j.id, tree: t.id, by: t.credit })
      return
    }
  }
  kill(w, j, t.credit, "crush", Math.atan2(t.fy, t.fx))
  const ev = w.events[w.events.length - 1]
  if (ev?.kind === "crush") ev.tree = t.id
}

function stepRound(w: World, dt: number, feel: Readonly<FeelConfig>): void {
  for (const it of w.items) {
    if (it.kind !== "gas" || !it.taken) continue
    it.respawn -= dt
    if (it.respawn <= 0) it.taken = false
  }
  for (const j of w.jacks) {
    if (!j.alive || !j.downed) continue
    j.bleed -= dt
    if (w.t - j.helpedAt > dt * 1.5) j.revive = Math.max(0, j.revive - dt * 0.15)
    if (j.bleed <= 0) kill(w, j, j.killedBy, "bleed", 0)
  }
  if (w.phase !== "play") return
  const over = (winner: number, side: Role | null) => {
    w.phase = "over"
    w.overAt = w.t
    w.winner = winner
    w.side = side
    w.events.push({ kind: "over", winner, side })
  }
  if (w.mode === "ffa") {
    const alive = w.jacks.filter((j) => j.alive)
    const human = w.jacks.find((j) => !j.bot)
    if (alive.length <= 1 || (human && !human.alive)) over(alive.length === 1 ? alive[0]!.id : -1, null)
    return
  }
  const lj = lumberjackOf(w)
  const survivors = w.jacks.filter((j) => j.role === "survivor")
  const escaped = survivors.some((s) => s.escaped)
  if (!lj?.alive) over(-1, "survivor")
  else if (survivors.every((s) => !s.alive || s.escaped) || w.t >= feel.roundTime) over(-1, escaped ? "survivor" : "lumberjack")
}

/** One fixed tick. `inputs[i]` drives jack i; bots think for themselves (their slot is ignored). */
export function stepWorld(w: World, inputs: readonly JackInput[], dt: number, feel: Readonly<FeelConfig> = FEEL): void {
  w.t += dt
  w.events.length = 0
  // Everyone moves, then every blade picks its target, then they cut: no one aims at where someone was.
  const taken = w.jacks.map((j) => {
    const input = j.bot ? thinkBot(w, j, dt, feel) : (inputs[j.id] ?? NO_INPUT)
    stepJack(w, j, input, dt, feel)
    return input
  })
  w.jacks.forEach((j, i) => aimSaw(w, j, taken[i]!, feel))
  for (const j of w.jacks) stepSaw(w, j, dt, feel)
  stepFlares(w, dt, feel)
  stepTrees(w, dt, feel)
  stepRound(w, dt, feel)
}

export const fallAngleDone = (t: Tree) => t.theta >= landAngle(t) - 1e-6
export { inFallZone }
