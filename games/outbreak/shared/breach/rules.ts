import type { AIAgent, PortalBashEvent } from "@arcade/kit/sim/ai"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import type { PortalBashRules, PortalState } from "../ai"
import { survivorDamage } from "../feature-registry"
import type { Door, Town, WindowOpening } from "../map"
import type { OutbreakSim } from "../sim-types"

/**
 * Door and barricade breaches (AR-97). Kit, after co-op: "When the zombies are breaking down a door, there's no way to
 * tell if they're gonna break through." The rules here make a door's health something you can read and plan around:
 *
 * - A door wears through stages (cracked, split, failing) instead of popping open at an invisible 0, and below
 *   `breachHoleAt` some doors get a panel punched through with arms reaching in (a grab hazard on the room side).
 * - The last of it never just vanishes: when a door or the last plank would give, it holds for `breachWarn` seconds
 *   (the warning beat: the door bulges, the last board hangs) so players can fall back, ambush the gap or throw a
 *   molotov. Bashes in that beat change nothing.
 * - How it gives depends on what is pushing: off its hinges and slammed flat (one or two), split down the middle (a
 *   Brute, or by chance), a crush that bursts the frame (`breachCrushPushers` or more), boards flying in, or a window
 *   bursting glass and boards. The dead spill in staggered, the first stumbling in over the door.
 * - A torn-out door stays open for good (it can be boarded, not shut), and the slab lies inside where it fell: wedged
 *   back into the frame (E) it becomes a strong board.
 * - Survivors standing against a shut door on the room side brace it (each one scales damage by `breachBrace`) and
 *   are jolted by every hit.
 *
 * Everything is in the sim (bashes go through `OutbreakAISubsystem.bashRules`) and replicated by `net.ts`, so a late
 * joiner sees the same cracked doors and fallen slabs. `breachMode` 0 is Today: no rules, the game as it was.
 */
export type BreachTuning = {
  /** 1: Readable breaches. 0: Today (doors pop open at 0 and can be shut again good as new). */
  breachMode: number
  /** Seconds between "about to give" and the break: the warning beat. */
  breachWarn: number
  /** Door damage × this for each survivor bracing it (two at most count). */
  breachBrace: number
  /** How close to a shut door (m) a survivor on the room side must stand to brace it. */
  breachBraceReach: number
  /** Stamina each bash on a braced door costs every bracer (0..1). */
  breachBraceStamina: number
  /** Door integrity (of 100) below which some doors get a panel punched through with arms reaching in. */
  breachHoleAt: number
  /** Damage per second the reaching arms deal to a survivor in front of the hole. */
  breachGrabDps: number
  /** How close to a holed door (m) the arms reach. */
  breachGrabReach: number
  /** This many of the dead pushing at once crush the frame instead of knocking the door off its hinges. */
  breachCrushPushers: number
  /** Seconds between each of the dead spilling through a breach after the first. */
  breachSpillGap: number
  /** 1: a window whose boards burst is smashed open for good (glass gone, the dead climb in). */
  breachWindowsShatter: number
}

export const DEFAULT_BREACH_TUNING: BreachTuning = {
  breachMode: 1,
  breachWarn: 1.1,
  breachBrace: 0.45,
  breachBraceReach: 0.8,
  breachBraceStamina: 0.05,
  breachHoleAt: 30,
  breachGrabDps: 7,
  breachGrabReach: 0.85,
  breachCrushPushers: 4,
  breachSpillGap: 0.35,
  breachWindowsShatter: 1,
}

export function breachTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): BreachTuning {
  const src = features?.breach as Partial<BreachTuning> | undefined
  return src ? { ...DEFAULT_BREACH_TUNING, ...src } : DEFAULT_BREACH_TUNING
}

export const breachOn = (t: Pick<BreachTuning, "breachMode">): boolean => t.breachMode >= 1

const GROUP = "Doors & barricades"
export const breachControls = [
  {
    key: "breachMode",
    label: "Doors & barricades",
    group: GROUP,
    options: [
      { label: "Today", value: 0 },
      { label: "Readable breaches", value: 1 },
    ],
  },
  { key: "breachWarn", label: "Warning beat before the break", group: GROUP, min: 0, max: 3, step: 0.05, unit: "s" },
  { key: "breachBrace", label: "Damage while braced (each)", group: GROUP, min: 0.1, max: 1, step: 0.05, unit: "×" },
  { key: "breachBraceReach", label: "Brace reach", group: GROUP, min: 0.3, max: 1.5, step: 0.05, unit: "m" },
  { key: "breachBraceStamina", label: "Stamina per hit while bracing", group: GROUP, min: 0, max: 0.3, step: 0.01 },
  { key: "breachHoleAt", label: "Panel punched through below", group: GROUP, min: 0, max: 80, step: 1, unit: "hp" },
  { key: "breachGrabDps", label: "Reaching arms damage", group: GROUP, min: 0, max: 30, step: 0.5, unit: "/s" },
  { key: "breachGrabReach", label: "Reaching arms reach", group: GROUP, min: 0.3, max: 1.6, step: 0.05, unit: "m" },
  { key: "breachCrushPushers", label: "Pushers that crush the frame", group: GROUP, min: 2, max: 8, step: 1 },
  { key: "breachSpillGap", label: "Spill-in gap", group: GROUP, min: 0, max: 1.2, step: 0.05, unit: "s" },
  {
    key: "breachWindowsShatter",
    label: "Burst windows stay open",
    group: GROUP,
    options: [
      { label: "Off", value: 0 },
      { label: "On", value: 1 },
    ],
  },
] as const

// ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const KIND_NONE = 0
export const KIND_HINGES = 1
export const KIND_SPLIT = 2
export const KIND_CRUSH = 3
export const KIND_BOARDS = 4
export const KIND_BURST = 5
export const BREACH_KIND_NAMES = ["none", "hinges", "split", "crush", "boards", "burst"] as const
export type BreachKindName = (typeof BREACH_KIND_NAMES)[number]

/** What is giving in the warning beat: the door itself, or the last plank across it. */
export const GIVING_DOOR = 0
export const GIVING_BOARDS = 1

/** One door or window's damage beyond what the AI's portal state holds (integrity and planks stay there). */
export type PortalWear = {
  /** Recent hitters as [agent id, last hit time]. */
  hitters: [number, number][]
  /** How many of the dead are pushing at it (hit it in the last `PRESSURE_WINDOW` seconds). */
  pushers: number
  /** The heaviest recent hit (a Brute's). */
  heavy: number
  /** Which side of the opening the dead are on: +1 / -1 along its normal (+y for an east-west opening), 0 unknown. */
  outside: number
  /** Survivors (and other sources) bracing it this tick. */
  braced: number
  /** Whether the arms through a punched panel have hold of someone this tick. */
  grabbing: boolean
  /** Sim time the warning beat began, or -1. */
  givingAt: number
  /** `GIVING_DOOR` or `GIVING_BOARDS`. */
  giving: number
  /** A door torn out: open for good, never shut again (it can still be boarded). */
  broken: boolean
  /** How it last gave (`KIND_*`) and when (-1 never). */
  kind: number
  /** How the door itself gave (`KIND_HINGES`, `KIND_SPLIT`, `KIND_CRUSH`), kept when boards across the gap give later. */
  doorKind: number
  breachAt: number
  /** A panel punched through (arms reach in while the dead push). */
  holed: boolean
  /** Where the torn-out door lies (inside, where it fell), or null. */
  debris: { x: number; y: number } | null
  /** The slab wedged back into the frame as a board. */
  wedged: boolean
  /** Lab staging: how this opening will give (`KIND_*`, 0 = by the rules). */
  forced: number
  /** Bashes taken, for seeding. */
  hits: number
}

export type BreachEvent = { seq: number; portalId: string; kind: number; at: number; x: number; y: number; inward: number }

export type BreachState = {
  /** Whether the rules are on (the last tick's `breachMode`), for interaction handlers that have no tuning. */
  on: boolean
  portals: Record<string, PortalWear>
  /** The last few breaches, newest last (`recentBreaches`). */
  events: BreachEvent[]
  seq: number
}

/** Seconds a hit counts toward the pressure on a door. */
export const PRESSURE_WINDOW = 2.4
/** Board hit points held in the warning beat (the last board hanging by a nail). */
const GIVING_PLANK_HP = 1
/** Hit points of a door slab wedged back into its frame (a plain plank is 100). */
export const WEDGED_PLANK_HP = 150
const MAX_EVENTS = 8

export function createBreachState(): BreachState {
  return { on: false, portals: {}, events: [], seq: 0 }
}

export function freshWear(): PortalWear {
  return {
    hitters: [],
    pushers: 0,
    heavy: 0,
    outside: 0,
    braced: 0,
    grabbing: false,
    givingAt: -1,
    giving: GIVING_DOOR,
    broken: false,
    kind: KIND_NONE,
    doorKind: KIND_NONE,
    breachAt: -1,
    holed: false,
    debris: null,
    wedged: false,
    forced: KIND_NONE,
    hits: 0,
  }
}

export function wearOf(state: BreachState, id: string): PortalWear {
  return (state.portals[id] ??= freshWear())
}

// ── Geometry ───────────────────────────────────────────────────────────────────────────────────────────────────

export const isHorizontal = (r: Rect): boolean => r[2] - r[0] > r[3] - r[1]

/** +1 when the building's inside is on the positive side of the opening's normal (+y east-west, +x north-south). */
export function inwardSign(town: Pick<Town, "buildings">, rect: Rect): number {
  const [x0, y0, x1, y1] = rect
  const cx = (x0 + x1) * 0.5
  const cy = (y0 + y1) * 0.5
  const horizontal = isHorizontal(rect)
  const b = town.buildings.find((b) => cx >= b.rect[0] - 0.3 && cx <= b.rect[2] + 0.3 && cy >= b.rect[1] - 0.3 && cy <= b.rect[3] + 0.3)
  if (!b) return 1
  const mid = horizontal ? (b.rect[1] + b.rect[3]) * 0.5 : (b.rect[0] + b.rect[2]) * 0.5
  return (horizontal ? mid - cy : mid - cx) >= 0 ? 1 : -1
}

/** Which side of `rect` (+1 / -1 along its normal) the point is on. */
export function sideOf(rect: Rect, x: number, y: number): number {
  const d = isHorizontal(rect) ? y - (rect[1] + rect[3]) * 0.5 : x - (rect[0] + rect[2]) * 0.5
  return d >= 0 ? 1 : -1
}

/** The side the dead are on: where they were seen hitting it, else outside the building. */
export function outsideOf(town: Pick<Town, "buildings">, rect: Rect, wear: PortalWear | undefined): number {
  return wear?.outside || -inwardSign(town, rect)
}

/** Where a door torn off its hinges comes to rest (inside, about its own height from the frame). */
export function debrisSpot(rect: Rect, inward: number, kind: number): { x: number; y: number } {
  const cx = (rect[0] + rect[2]) * 0.5
  const cy = (rect[1] + rect[3]) * 0.5
  const reach = kind === KIND_CRUSH ? 1.9 : 1.15
  return isHorizontal(rect) ? { x: cx, y: cy + inward * reach } : { x: cx + inward * reach, y: cy }
}

// ── Stages ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** 0 sound, 1 cracked, 2 split and bowing, 3 failing, 4 giving (the warning beat), 5 broken. */
export type DoorStage = 0 | 1 | 2 | 3 | 4 | 5
export const DOOR_STAGE_NAMES = ["sound", "cracked", "split", "failing", "giving", "broken"] as const

export function doorStage(integrity: number, wear: Pick<PortalWear, "broken" | "givingAt" | "giving"> | undefined): DoorStage {
  if (wear?.broken) return 5
  if (wear && wear.givingAt >= 0 && wear.giving === GIVING_DOOR) return 4
  if (integrity < 30) return 3
  if (integrity < 55) return 2
  if (integrity < 80) return 1
  return 0
}

function hash01(s: string, k: number): number {
  let h = (2166136261 ^ Math.imul(k, 0x9e3779b1)) >>> 0
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

/** Whether a failing door gets a panel punched through (arms reaching in) rather than its hinges bending. */
export const punchesThrough = (id: string): boolean => hash01(id, 7) < 0.6

/** How a door gives: crushed by a crowd, split by a heavy hitter (or by chance), else kicked off its hinges. */
export function chooseDoorBreach(id: string, wear: Pick<PortalWear, "pushers" | "heavy" | "hits" | "forced">, t: Pick<BreachTuning, "breachCrushPushers">): number {
  if (wear.forced === KIND_HINGES || wear.forced === KIND_SPLIT || wear.forced === KIND_CRUSH) return wear.forced
  if (wear.pushers >= t.breachCrushPushers) return KIND_CRUSH
  if (wear.heavy >= 45 || hash01(id, wear.hits) < 0.35) return KIND_SPLIT
  return KIND_HINGES
}

// ── Bashes ─────────────────────────────────────────────────────────────────────────────────────────────────────

const braceScale = (braced: number, t: BreachTuning) => Math.pow(Math.max(0.05, Math.min(1, t.breachBrace)), Math.min(2, braced))

/**
 * Applies one tick of the crowd's bashes. Like Today, except: bracing scales door damage, the last plank and a door's
 * last hit points start the warning beat instead of giving, and nothing changes while it plays.
 */
export function applyBashes(
  state: BreachState,
  t: BreachTuning,
  town: Town,
  portalStates: Map<string, PortalState>,
  bashes: readonly PortalBashEvent[],
  time: number,
  agents: readonly AIAgent[],
  slots: OutbreakSim["slots"],
): boolean {
  let topology = false
  for (const bash of bashes) {
    const st = portalStates.get(bash.portalId)
    if (!st) continue
    st.lastBashTime = time
    const w = wearOf(state, bash.portalId)
    w.hits++
    const known = w.hitters.find((h) => h[0] === bash.agentId)
    if (known) known[1] = time
    else w.hitters.push([bash.agentId, time])
    w.heavy = Math.max(w.heavy, bash.damage)
    const rect = bash.portalKind === "door" ? town.doors.find((d) => d.id === bash.portalId)?.rect : town.windows.find((x) => x.id === bash.portalId)?.rect
    const agent = agents.find((a) => a.id === bash.agentId)
    if (rect && agent) w.outside = sideOf(rect, agent.x, agent.y)
    if (w.givingAt >= 0) continue
    if (st.barricadePlanks > 0) {
      const perPlank = st.barricadeHp / st.barricadePlanks
      const hp = Math.max(0, st.barricadeHp - bash.damage)
      const next = Math.max(0, Math.min(st.barricadePlanks, Math.ceil(hp / perPlank - 1e-9)))
      if (next <= 0) {
        // The last board hangs by a nail for the warning beat.
        st.barricadePlanks = 1
        st.barricadeHp = GIVING_PLANK_HP
        w.givingAt = time
        w.giving = GIVING_BOARDS
        continue
      }
      st.barricadeHp = hp
      if (next !== st.barricadePlanks) {
        st.barricadePlanks = next
        topology = true
      }
      continue
    }
    if (bash.portalKind !== "door") continue
    const door = town.doors.find((d) => d.id === bash.portalId)
    if (!door || door.open || w.broken) continue
    // Bracers count from the first hit (the tick's tally starts once the door has been hit).
    let bracers = 0
    for (const s of slots) {
      if (!isBracing(s.survivor, door.rect, w, t)) continue
      bracers++
      s.survivor.stamina = Math.max(0, s.survivor.stamina - t.breachBraceStamina)
    }
    w.braced = Math.max(w.braced, bracers)
    st.integrity = Math.max(0, st.integrity - bash.damage * braceScale(w.braced, t))
    if (st.integrity < t.breachHoleAt && punchesThrough(door.id)) w.holed = true
    if (st.integrity <= 0) {
      st.integrity = 0
      w.givingAt = time
      w.giving = GIVING_DOOR
    }
  }
  return topology
}

type BraceBody = { x: number; y: number; health: number; vehicleId?: number | null }

/** Standing against the shut opening on the room side, within reach. */
export function isBracing(s: BraceBody, rect: Rect, w: Pick<PortalWear, "outside">, t: Pick<BreachTuning, "breachBraceReach">): boolean {
  if (s.health <= 0 || s.vehicleId) return false
  if (distToRect(s.x, s.y, rect) > t.breachBraceReach) return false
  return w.outside === 0 || sideOf(rect, s.x, s.y) !== w.outside
}

// ── Hooks for other features ───────────────────────────────────────────────────────────────────────────────────

/** Something else holding a door shut (furniture pushed against it, say): how many bracers it counts as. */
export type BraceSource = (sim: OutbreakSim, portalId: string) => number
const braceSources: BraceSource[] = []

/** Lets another feature brace doors (e.g. furniture shoved against one); pure functions of the sim only. */
export function registerBraceSource(source: BraceSource): void {
  if (!braceSources.includes(source)) braceSources.push(source)
}

/** The last few breaches, newest last: a feature that blocks doors (furniture, say) topples its own pieces in on these. */
export function recentBreaches(sim: OutbreakSim): readonly BreachEvent[] {
  return sim.getFeatureState<BreachState>("breach")?.events ?? []
}

/** One door or window's wear (pushers, warning beat, breach), or undefined while untouched. */
export function portalWear(sim: OutbreakSim, portalId: string): Readonly<PortalWear> | undefined {
  return sim.getFeatureState<BreachState>("breach")?.portals[portalId]
}

// ── Per tick ───────────────────────────────────────────────────────────────────────────────────────────────────

const rulesByState = new WeakMap<BreachState, { rules: PortalBashRules; t: BreachTuning; sim: OutbreakSim }>()

function rulesFor(sim: OutbreakSim, state: BreachState, t: BreachTuning): PortalBashRules {
  let r = rulesByState.get(state)
  if (!r) {
    const box = { t, sim, rules: null as unknown as PortalBashRules }
    box.rules = { apply: (town, portalStates, bashes, time, agents) => applyBashes(state, box.t, town, portalStates, bashes, time, agents, box.sim.slots) }
    rulesByState.set(state, box)
    r = box
  }
  r.t = t
  r.sim = sim
  return r.rules
}

function openingOf(town: Town, id: string): { door?: Door; win?: WindowOpening; rect: Rect } | undefined {
  const door = town.doors.find((d) => d.id === id)
  if (door) return { door, rect: door.rect }
  const win = town.windows.find((w) => w.id === id)
  return win ? { win, rect: win.rect } : undefined
}

/** Runs before the crowd each tick: pressure, bracing, the reaching arms, and breaches whose warning beat is over. */
export function stepBreach(sim: OutbreakSim, state: BreachState, t: BreachTuning, dt: number): { topologyChanged?: boolean } | void {
  state.on = breachOn(t)
  if (!state.on) {
    sim.ai.bashRules = null
    return
  }
  sim.ai.bashRules = rulesFor(sim, state, t)
  const time = sim.time
  const town = sim.town
  let topology = false
  for (const id in state.portals) {
    const w = state.portals[id]!
    const at = openingOf(town, id)
    const st = sim.ai.portalStates.get(id)
    if (!at || !st) continue
    w.hitters = w.hitters.filter((h) => time - h[1] < PRESSURE_WINDOW && sim.ai.agents.some((a) => a.id === h[0] && a.state !== "dead"))
    w.pushers = w.hitters.length
    if (w.pushers === 0) w.heavy = 0

    // A torn-out door is open whenever no boards hold the gap (boarding closes the opening, as for any door).
    if (at.door && w.broken && st.barricadePlanks <= 0 && !at.door.open) {
      at.door.open = true
      at.door.locked = false
      topology = true
    }
    if (w.wedged && st.barricadePlanks <= 0) w.wedged = false
    if (w.debris && !w.broken) w.debris = null

    // Bracing: survivors against the shut door on the room side, plus any other registered source.
    w.braced = 0
    const shut = at.door ? !at.door.open && !w.broken : false
    if (shut) {
      for (const s of sim.slots) if (isBracing(s.survivor, at.rect, w, t)) w.braced++
      for (const src of braceSources) w.braced += Math.max(0, src(sim, id))
    }

    // The arms through a punched panel grab whoever stands in front of it while the dead push.
    w.grabbing = false
    if (at.door && w.holed && shut && w.pushers > 0 && w.givingAt < 0 && t.breachGrabDps > 0) {
      for (const s of sim.slots) {
        const p = s.survivor
        if (p.health <= 0 || p.vehicleId) continue
        if (distToRect(p.x, p.y, at.rect) > t.breachGrabReach || sideOf(at.rect, p.x, p.y) === outsideOf(town, at.rect, w)) continue
        w.grabbing = true
        const dmg = survivorDamage(sim, s, t.breachGrabDps * dt, "crowd")
        if (dmg <= 0) continue
        p.health = Math.max(0, p.health - dmg)
        p.regenCooldown = Math.max(p.regenCooldown, 0.5)
        p.vx *= 0.6
        p.vy *= 0.6
      }
    }

    if (w.givingAt < 0) continue
    // The warning beat. Repaired boards or an opened door call it off.
    if (w.giving === GIVING_BOARDS && (st.barricadePlanks > 1 || st.barricadeHp > GIVING_PLANK_HP + 0.5 || st.barricadePlanks <= 0)) {
      w.givingAt = -1
      continue
    }
    if (w.giving === GIVING_DOOR && at.door && (at.door.open || st.barricadePlanks > 0)) {
      w.givingAt = -1
      continue
    }
    if (time - w.givingAt < t.breachWarn) continue
    w.givingAt = -1
    if (breach(sim, state, t, id, w, at, st)) topology = true
  }
  return topology ? { topologyChanged: true } : undefined
}

function breach(
  sim: OutbreakSim,
  state: BreachState,
  t: BreachTuning,
  id: string,
  w: PortalWear,
  at: { door?: Door; win?: WindowOpening; rect: Rect },
  st: PortalState,
): boolean {
  const inward = -outsideOf(sim.town, at.rect, w)
  let kind: number
  let passable: boolean
  if (w.giving === GIVING_BOARDS) {
    st.barricadePlanks = 0
    st.barricadeHp = 0
    w.wedged = false
    if (at.win) {
      kind = KIND_BURST
      if (t.breachWindowsShatter >= 1) {
        at.win.open = true
        at.win.openable = false
      }
      passable = at.win.open
    } else {
      kind = KIND_BOARDS
      if (at.door && w.broken) at.door.open = true
      passable = Boolean(at.door?.open)
    }
  } else {
    if (!at.door) return false
    kind = chooseDoorBreach(id, w, t)
    w.doorKind = kind
    at.door.open = true
    at.door.locked = false
    at.door.keyed = false
    st.integrity = 0
    w.broken = true
    w.holed = false
    w.debris = kind === KIND_SPLIT ? null : debrisSpot(at.rect, inward, kind)
    passable = true
  }
  w.kind = kind
  w.breachAt = sim.time
  w.forced = KIND_NONE
  const cx = (at.rect[0] + at.rect[2]) * 0.5
  const cy = (at.rect[1] + at.rect[3]) * 0.5
  state.events.push({ seq: ++state.seq, portalId: id, kind, at: sim.time, x: cx, y: cy, inward })
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
  if (passable) spill(sim.ai.agents, id, at.rect, inward, kind, t)
  return true
}

/** The dead at the breach come through one after another: the first falls in with the door, the rest stumble after. */
function spill(agents: AIAgent[], id: string, rect: Rect, inward: number, kind: number, t: BreachTuning): void {
  const cx = (rect[0] + rect[2]) * 0.5
  const cy = (rect[1] + rect[3]) * 0.5
  const nx = isHorizontal(rect) ? 0 : inward
  const ny = isHorizontal(rect) ? inward : 0
  const at = agents
    .filter((a) => a.state !== "dead" && (a.activePortalId === id || (a.state === "bash" && Math.hypot(a.x - cx, a.y - cy) < 1.8)))
    .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy) || a.id - b.id)
  at.forEach((a, i) => {
    a.activePortalId = null
    a.stateTime = 0
    a.repathAt = 0
    if (i === 0 && (kind === KIND_HINGES || kind === KIND_CRUSH)) {
      // Falls in over the door.
      const push = kind === KIND_CRUSH ? 3.4 : 2.4
      a.state = "knockdown"
      a.timer = kind === KIND_CRUSH ? 1.2 : 0.95
      a.staggerVx = nx * push
      a.staggerVy = ny * push
      return
    }
    a.state = "stagger"
    a.timer = 0.2 + i * Math.max(0, t.breachSpillGap)
    a.staggerVx = nx * 0.9
    a.staggerVy = ny * 0.9
  })
}

// ── Wedging the slab back ──────────────────────────────────────────────────────────────────────────────────────

/** Wedges a torn-out door's slab back across its frame as one strong board; false if there is no slab or no room. */
export function wedgeSlab(sim: OutbreakSim, state: BreachState, id: string): boolean {
  const w = state.portals[id]
  const door = sim.town.doors.find((d) => d.id === id)
  if (!w?.debris || !w.broken || !door) return false
  if (!sim.ai.addBarricadePlank(id, WEDGED_PLANK_HP)) return false
  w.debris = null
  w.wedged = true
  door.open = false
  return true
}
