import { distToRect } from "@arcade/kit/sim/geom"
import type { StoreState } from "@arcade/kit/sim/ledger"
import type { BodiesState } from "../bodies/runtime"
import { dayCycle } from "../day-cycle"
import type { DeathState } from "../death/rules"
import type { InteractAction, InteractionHandler, RawInteractCandidate } from "../interact"
import { radioState } from "../radios/radios"
import type { RadiosState } from "../radios/runtime"
import type { OutbreakSim, SurvivorSlot } from "../sim-types"
import {
  broadcastOn,
  carriesFlyer,
  CLUE_CODE,
  CLUE_TIER,
  clueWords,
  EVENT_ESCAPED,
  EVENT_LATE_BOAT,
  EVENT_LEFT_BEHIND,
  EVENT_MISSED,
  EVENT_SIGNAL,
  hash01,
  noteSites,
  policeSites,
  roadSites,
  type ClueKind,
  type ClueSite,
} from "./clues"
import { DESTINATION_WORDS, planSeed, wayOutPlan, type WayOutPlan } from "./plan"
import { roadblocksOf } from "./roadblocks"
import { ds, WAY_OUT_STORE } from "./state"
import { DEFAULT_WAY_OUT_TUNING, MISSED_LATE_BOAT, STAND_FIXED, type WayOutTuning } from "./tuning"

/** Per-sim state the store does not need to carry: the dark edge, the siege's dead, and clue sites for this town. */
export type WayOutState = {
  tuning: WayOutTuning
  wasDark: boolean
  siege: number[]
  sitesKey: string
  sites: ClueSite[]
  /** The last noise-bus event checked for blasts at the roadblocks. */
  blastSeen: number
  /** When each car's driver was last told the pumps are dry. */
  pumpsToldAt: Record<number, number>
}

/** Arriving this near the destination confirms it (m). */
export const ARRIVE_RANGE = 60
/** How near a clue or the signal post a survivor must stand to use it (m). */
const REACH = 1.35
const SIGNAL_REACH = 1.8

const isDark = (hour: number) => dayCycle(hour).darkness >= 0.5

export function createWayOutState(sim: OutbreakSim): WayOutState {
  return { tuning: DEFAULT_WAY_OUT_TUNING, wasDark: isDark(sim.hour), siege: [], sitesKey: "", sites: [], blastSeen: 0, pumpsToldAt: {} }
}

export const planOf = (sim: Pick<OutbreakSim, "town">, t: WayOutTuning): WayOutPlan => wayOutPlan(sim.town.seed, sim.town.houseSeed, t)
export const seedOf = (sim: Pick<OutbreakSim, "town">) => planSeed(sim.town.seed, sim.town.houseSeed)

/** The `wayout` store, made on first use with the night count and the deadline. */
export function wayOutStore(sim: OutbreakSim, t: WayOutTuning): StoreState {
  const ledger = sim.progression.ledger
  const st = ledger.store(WAY_OUT_STORE)
  if (st) return st
  return ledger.createStore({ id: WAY_OUT_STORE, mode: "counters", scope: "shared", initial: { night: isDark(sim.hour) ? 1 : 0, deadline: Math.max(1, Math.round(t.deadlineNight)) } })
}

function touch(sim: OutbreakSim, st: StoreState): void {
  st.rev = ++sim.progression.ledger.rev
}

function event(sim: OutbreakSim, st: StoreState, code: number, by?: SurvivorSlot): void {
  st.counts.last = code
  st.counts.lastAt = Math.max((st.counts.lastAt ?? 0) + 1, ds(sim.time))
  st.counts.lastBy = by ? by.index + 1 : 0
  touch(sim, st)
}

function tell(sim: OutbreakSim, text: string): void {
  for (const s of sim.slots) sim.progression.notify(s, text, "result", "wayout")
}

/** Clue sites in the town as it stands: notes and police map pieces stream with their buildings; the roadside two are fixed. */
export function clueSites(sim: OutbreakSim, state: WayOutState, plan: WayOutPlan): ClueSite[] {
  const town = sim.town
  const t = state.tuning
  const key = `${plan.key}:${t.noteShare}:${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}`
  if (key !== state.sitesKey) {
    state.sitesKey = key
    state.sites = [...noteSites(town, seedOf(sim), t.noteShare), ...policeSites(town), ...roadSites(plan)]
  }
  return state.sites
}

/** The squad has found a clue: it counts once, may raise the tier, and every survivor hears of it. */
export function findClue(sim: OutbreakSim, state: WayOutState, id: string, kind: ClueKind, by?: SurvivorSlot): boolean {
  const t = state.tuning
  const st = wayOutStore(sim, t)
  if (st.counts[`c:${id}`] || st.counts.won) return false
  st.counts[`c:${id}`] = 1
  const kinds = new Set<ClueKind>()
  let arrived = false
  for (const k of Object.keys(st.counts)) {
    if (!k.startsWith("c:")) continue
    const clue = k.slice(2)
    const ck = (clue.includes(":") ? clue.slice(0, clue.indexOf(":")) : clue) as ClueKind
    if (ck === "arrive") arrived = true
    else if (CLUE_TIER[ck] === 2) kinds.add(ck)
  }
  const tier = arrived || kinds.size >= 2 ? 3 : kinds.size >= 1 ? 2 : 1
  st.counts.tier = Math.max(st.counts.tier ?? 0, tier)
  const plan = planOf(sim, t)
  const blocks = roadblocksOf(plan, t)
  // The soldier's orders mark the roadblocks on the map.
  if (kind === "soldier") for (const b of blocks) st.counts[`rbs:${b.index}`] = 1
  event(sim, st, CLUE_CODE[kind], by)
  const words = clueWords(kind, plan, st.counts.deadline ?? t.deadlineNight, blocks.filter((b) => !st.counts[`rb:${b.index}`]))
  tell(sim, `${words.title} — ${words.lines.join(" ")}`)
  return true
}

/** Signal the evacuation from the destination: the stand begins and the dead come. */
export function signalEvac(sim: OutbreakSim, state: WayOutState, by?: SurvivorSlot): boolean {
  const t = state.tuning
  const st = wayOutStore(sim, t)
  if (st.counts.sig || st.counts.missed || st.counts.won) return false
  const plan = planOf(sim, t)
  findClue(sim, state, "arrive", "arrive", by)
  st.counts.sig = Math.max(1, ds(sim.time))
  st.counts.standEnd = t.standRule === STAND_FIXED ? ds(sim.time + Math.max(1, t.standHold)) : 0
  st.counts.wave = 0
  st.counts.nextWave = ds(sim.time + 3)
  st.counts.ex = Math.round(plan.signal.x * 10)
  st.counts.ey = Math.round(plan.signal.y * 10)
  event(sim, st, EVENT_SIGNAL, by)
  sim.ai.emitNoise(plan.x, plan.y, 70, "horn", sim.time, by?.id ?? "wayout", 2.5)
  tell(sim, `Signal sent. Hold the ${DESTINATION_WORDS[plan.kind].place} until ${t.standRule === STAND_FIXED ? "they come" : "dawn"}.`)
  return true
}

/** Alive or down, inside the evac zone (or in a car there). */
function inZone(sim: OutbreakSim, plan: WayOutPlan, t: WayOutTuning): SurvivorSlot[] {
  const death = sim.getFeatureState<DeathState>("death")
  return sim.slots.filter((s) => {
    if ((death?.records[s.index]?.state ?? "alive") === "dead") return false
    const p = s.survivor
    return Math.hypot(p.x - plan.x, p.y - plan.y) <= t.evacRadius
  })
}

/** The evacuation comes: everyone in the zone goes, and the run is won. Nobody there and it leaves without them. */
export function evacuate(sim: OutbreakSim, state: WayOutState): boolean {
  const t = state.tuning
  const st = wayOutStore(sim, t)
  if (st.counts.won) return true
  const plan = planOf(sim, t)
  const aboard = inZone(sim, plan, t)
  const words = DESTINATION_WORDS[plan.kind]
  if (!aboard.length) {
    st.counts.sig = 0
    st.counts.standEnd = 0
    event(sim, st, EVENT_LEFT_BEHIND)
    tell(sim, `The ${words.craft} came and went. Nobody was there.`)
    return false
  }
  const death = sim.getFeatureState<DeathState>("death")
  for (const s of aboard) {
    st.counts[`esc:${s.index}`] = 1
    if (s.survivor.vehicleId) sim.vehicles.leaveSeat(s.id, s.survivor)
  }
  for (const s of sim.slots) {
    const kills = death?.records[s.index]?.kills ?? 0
    if (kills > 0) st.counts[`kills:${s.index}`] = kills
    if (s.survivor.vehicleId) sim.vehicles.leaveSeat(s.id, s.survivor)
  }
  st.counts.won = Math.max(1, ds(sim.time))
  st.counts.wonNight = Math.max(1, st.counts.night ?? 1)
  st.counts.played = Math.max(1, Math.round(sim.time))
  event(sim, st, EVENT_ESCAPED, aboard[0])
  tell(sim, `Escaped ${words.by}.`)
  return true
}

/** The dawn after the deadline night came and went: one late boat if the tuning allows it, else the way out is gone. */
function deadlinePassed(sim: OutbreakSim, st: StoreState, t: WayOutTuning): void {
  if (t.missedRule === MISSED_LATE_BOAT && !st.counts.late) {
    st.counts.late = 1
    st.counts.deadline = (st.counts.deadline ?? t.deadlineNight) + Math.max(1, Math.round(t.lateNights))
    event(sim, st, EVENT_LATE_BOAT)
    tell(sim, `They say there's one more ${DESTINATION_WORDS[planOf(sim, t).kind].craft}. Dawn, Day ${st.counts.deadline + 1}.`)
    return
  }
  st.counts.missed = 1
  st.counts.sig = 0
  st.counts.standEnd = 0
  event(sim, st, EVENT_MISSED)
  tell(sim, `The last ${DESTINATION_WORDS[planOf(sim, t).kind].craft} has gone.`)
}

/** A wave of the dead from all sides, walking in on whoever is holding the destination. */
function siegeWave(sim: OutbreakSim, state: WayOutState, st: StoreState, plan: WayOutPlan): void {
  const t = state.tuning
  const alive = new Set(sim.ai.agents.filter((a) => a.state !== "dead").map((a) => a.id))
  state.siege = state.siege.filter((id) => alive.has(id))
  const wave = st.counts.wave ?? 0
  const want = Math.round(t.siegeWave) + Math.floor(wave / Math.max(1, Math.round(t.siegeGrowth)))
  const n = Math.max(0, Math.min(want, Math.round(t.siegeMax) - state.siege.length))
  const targets = inZone(sim, plan, t)
  for (let i = 0; i < n; i++) {
    const a = hash01(`siege:${plan.key}:${wave}:${i}`) * Math.PI * 2
    const r = t.siegeRadius * (0.85 + 0.3 * hash01(`siege-r:${plan.key}:${wave}:${i}`))
    const x = plan.x + Math.cos(a) * r
    const y = plan.y + Math.sin(a) * r
    const z = sim.ai.spawnZombie(sim.town, x, y, "chase")
    state.siege.push(z.id)
    const target = targets[i % Math.max(1, targets.length)]?.survivor
    const tx = target?.x ?? plan.x
    const ty = target?.y ?? plan.y
    z.targetX = tx
    z.targetY = ty
    z.targetKind = "proximity"
    z.aim = Math.atan2(ty - z.y, tx - z.x)
    z.awareness = 1
  }
  st.counts.wave = wave + 1
  st.counts.nextWave = ds(sim.time + Math.max(1, t.siegeEvery))
  touch(sim, st)
}

/** Once per tick, after the crowd: the clock, clues heard and found by searching, the signal, the siege and the evac. */
export function stepWayOut(sim: OutbreakSim, state: WayOutState): void {
  const t = state.tuning
  const dark = isDark(sim.hour)
  const dusk = dark && !state.wasDark
  const dawn = !dark && state.wasDark
  state.wasDark = dark
  if (!t.wayOut) return
  const st = wayOutStore(sim, t)
  if (st.counts.won) return
  const plan = planOf(sim, t)
  if (dusk) {
    st.counts.night = (st.counts.night ?? 0) + 1
    touch(sim, st)
  }
  const ledger = sim.progression.ledger
  const death = sim.getFeatureState<DeathState>("death")
  const standing = sim.slots.filter((s) => (death?.records[s.index]?.state ?? "alive") === "alive")

  // Rumours: a broadcast on a playing radio, a flyer on a searched body.
  if (!st.counts["c:radio"] && broadcastOn(sim.hour, t.broadcastEvery, t.broadcastLength)) {
    for (const r of sim.getFeatureState<RadiosState>("radios")?.sites ?? []) {
      if (radioState(ledger.store(r.id), sim.time) !== "playing") continue
      const by = standing.find((s) => Math.hypot(s.survivor.x - r.x, s.survivor.y - r.y) <= t.radioHear)
      if (by) {
        findClue(sim, state, "radio", "radio", by)
        break
      }
    }
  }
  const seed = seedOf(sim)
  for (const b of sim.getFeatureState<BodiesState>("bodies")?.sites ?? []) {
    if (st.counts[`c:flyer:${b.key}`] || !carriesFlyer(seed, b.key, t.flyerShare)) continue
    const body = ledger.store(b.id)
    if (!body?.revealed || body.counts.rise) continue
    const by = standing.reduce<SurvivorSlot | undefined>((best, s) => (!best || Math.hypot(s.survivor.x - b.x, s.survivor.y - b.y) < Math.hypot(best.survivor.x - b.x, best.survivor.y - b.y) ? s : best), undefined)
    findClue(sim, state, `flyer:${b.key}`, "flyer", by)
  }

  // Arriving confirms it.
  if (!st.counts["c:arrive"]) {
    const by = standing.find((s) => Math.hypot(s.survivor.x - plan.x, s.survivor.y - plan.y) <= ARRIVE_RANGE)
    if (by) findClue(sim, state, "arrive", "arrive", by)
  }

  // Signals: a flare burning in the zone or a horn sounding there.
  if (!st.counts.sig && !st.counts.missed) {
    const now = ds(sim.time)
    let by: SurvivorSlot | undefined
    let signalled = false
    for (const [id, s] of ledger.stores) {
      if (!id.startsWith("flare:") || !s.at || now >= (s.counts.until ?? 0)) continue
      if (Math.hypot(s.at.x - plan.x, s.at.y - plan.y) > t.evacRadius) continue
      by = sim.slots.find((x) => x.id === s.owner)
      signalled = true
      break
    }
    if (!signalled) {
      for (const v of sim.vehicles.list) {
        if (!v.horn || Math.hypot(v.x - plan.x, v.y - plan.y) > t.evacRadius) continue
        by = sim.slots.find((x) => x.id === v.seats[0])
        signalled = true
        break
      }
    }
    if (signalled) signalEvac(sim, state, by)
  }

  if (st.counts.sig) {
    if (ds(sim.time) >= (st.counts.nextWave ?? 0)) siegeWave(sim, state, st, plan)
    if (t.standRule === STAND_FIXED ? ds(sim.time) >= (st.counts.standEnd ?? 0) : dawn) evacuate(sim, state)
  }
  if (dawn && !st.counts.won && !st.counts.missed && (st.counts.night ?? 0) >= (st.counts.deadline ?? t.deadlineNight)) deadlinePassed(sim, st, t)
}

const CLUE_ACTIONS: Readonly<Record<string, InteractAction>> = {
  note: { id: "read", label: "Read" },
  sign: { id: "read", label: "Read" },
  police: { id: "take", label: "Take map" },
  soldier: { id: "search", label: "Search" },
}

/** E at a clue: read the note or the sign, take the map piece, search the soldier. */
export function clueHandler(sim: OutbreakSim, of: () => WayOutState | undefined): InteractionHandler {
  return {
    kind: "clue",
    candidates: (_town, actor) => {
      const state = of()
      if (!state?.tuning.wayOut || actor.peekingWindowId) return []
      const st = sim.progression.ledger.store(WAY_OUT_STORE)
      if (st?.counts.won) return []
      const out: RawInteractCandidate[] = []
      for (const c of clueSites(sim, state, planOf(sim, state.tuning))) {
        if (distToRect(actor.x, actor.y, c.rect) > REACH || st?.counts[`c:${c.id}`]) continue
        const primary = CLUE_ACTIONS[c.kind]
        if (!primary) continue
        const label = c.kind === "soldier" ? "Soldier" : c.kind === "sign" ? "Road sign" : c.kind === "police" ? "Map piece" : "Note"
        out.push({ kind: "clue", id: c.id, label, rect: c.rect, worldX: c.x, worldY: c.y, primary, actions: [primary], priority: 0.6 })
      }
      return out
    },
    execute: (_town, actor, targetId, action) => {
      const state = of()
      const slot = sim.progression.slotOf(actor)
      if (!state || !slot) return { handled: false }
      const c = clueSites(sim, state, planOf(sim, state.tuning)).find((s) => s.id === targetId)
      if (!c || distToRect(actor.x, actor.y, c.rect) > REACH + 0.6) return { handled: false }
      const s = sim.slots.find((x) => x.id === slot.id)
      return { handled: findClue(sim, state, c.id, c.kind, s), kind: "clue", targetId, action, noise: c.kind === "soldier" ? 3 : 0, noiseKind: "search" }
    },
  }
}

/** E at the destination's signal post: a flare stand, a field radio, a siren: whatever the place has. */
export function signalHandler(sim: OutbreakSim, of: () => WayOutState | undefined): InteractionHandler {
  return {
    kind: "signal",
    candidates: (_town, actor) => {
      const state = of()
      if (!state?.tuning.wayOut) return []
      const plan = planOf(sim, state.tuning)
      if (Math.hypot(actor.x - plan.signal.x, actor.y - plan.signal.y) > SIGNAL_REACH + 0.5) return []
      const st = sim.progression.ledger.store(WAY_OUT_STORE)
      if (st?.counts.sig || st?.counts.missed || st?.counts.won) return []
      const primary: InteractAction = { id: "toggle", label: "Signal" }
      const { x, y } = plan.signal
      return [{ kind: "signal", id: "signal", label: DESTINATION_WORDS[plan.kind].short, rect: [x - 0.4, y - 0.4, x + 0.4, y + 0.4], worldX: x, worldY: y, primary, actions: [primary], priority: 1 }]
    },
    execute: (_town, actor, targetId, action) => {
      const state = of()
      const slot = sim.progression.slotOf(actor)
      if (!state || !slot || action !== "toggle") return { handled: false }
      const s = sim.slots.find((x) => x.id === slot.id)
      return { handled: signalEvac(sim, state, s), kind: "signal", targetId, action, noise: 30, noiseKind: "horn" }
    },
  }
}

/** Whether the run is won (everyone left is frozen, unseen and unhurt while the card is up). */
export const runWon = (sim: Pick<OutbreakSim, "progression">) => (sim.progression.ledger.store(WAY_OUT_STORE)?.counts.won ?? 0) > 0

// ── Lab and test commands ───────────────────────────────────────────────────────────────────────────────────────

/** Gives the squad every clue up to `tier` (1 rumour, 2 direction, 3 confirmed). */
export function revealTo(sim: OutbreakSim, state: WayOutState, tier: number): void {
  if (tier >= 1) findClue(sim, state, "radio", "radio")
  if (tier >= 2) findClue(sim, state, "sign", "sign")
  if (tier >= 3) findClue(sim, state, "soldier", "soldier")
}

/** Rolls the clock to just before `hour`'s next dawn edge (for the stand): leaves it dark, minutes from light. */
export function nearDawnHour(): number {
  for (let h = 5; h < 9; h += 1 / 60) if (!isDark(h)) return h - 0.08
  return 6.5
}
