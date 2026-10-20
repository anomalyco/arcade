import { pushOut } from "@arcade/kit/sim/geom"
import type { Stack } from "@arcade/kit/sim/ledger"
import { createSurvivorCombatState } from "../combat"
import { dayCycle } from "../day-cycle"
import type { OutbreakSimStepSurvivorContext } from "../feature-registry"
import { createFlashlightState } from "../flashlight"
import { createInteractActorState, type InteractionHandler, type RawInteractCandidate } from "../interact"
import { DEFAULT_LOADOUT } from "../loadout"
import type { OutbreakSim, Survivor, SurvivorSlot } from "../sim-types"
import { SPAWN_POINTS } from "../spawn-points"
import { specialKindOf } from "../specials/kinds"
import { createStaminaState } from "../stamina"
import {
  CAUSE_DEAD,
  CAUSE_LAB,
  DEFAULT_DEATH_TUNING,
  fallenStoreId,
  MAX_FALLEN,
  RESPAWN_AT_DAWN,
  type DeathState,
  type DeathTuning,
  type FallenBody,
  type LifeRecord,
  type LifeState,
} from "./rules"

const isDark = (hour: number) => dayCycle(hour).darkness >= 0.5
const round2 = (n: number) => Math.round(n * 100) / 100
/** A teammate's E counts as held this long after their last tick holding it (bridges dropped input ticks). */
const REVIVE_GRACE = 0.25
/** A zombie this close when a survivor goes down took them (m). */
const CAUSE_REACH = 2.6
const FALLEN_REACH = 1.45
/** Seconds after a death before the body can be looted (s). */
const FALLEN_SETTLE = 1.5

export function createDeathState(hour: number): DeathState {
  const dark = isDark(hour)
  return { records: {}, bodies: [], night: dark ? 1 : 0, dawns: 0, wasDark: dark, dawn: false, runOver: false, runOverAt: 0, feeding: {}, counted: {}, tuning: DEFAULT_DEATH_TUNING }
}

function freshRecord(index: number, time: number): LifeRecord {
  return { index, state: "alive", since: time, bleed: 0, revive: 0, reviver: -1, reviveAt: 0, cause: CAUSE_DEAD, night: 0, dark: false, kills: 0, deaths: 0 }
}

export function recordOf(state: DeathState, slot: Pick<SurvivorSlot, "index">, time = 0): LifeRecord {
  return (state.records[slot.index] ??= freshRecord(slot.index, time))
}

/** A survivor's life in `sim` ("alive" when the death feature is absent or has not seen them yet). */
export function lifeOf(sim: Pick<OutbreakSim, "getFeatureState">, index: number): LifeState {
  return sim.getFeatureState<DeathState>("death")?.records[index]?.state ?? "alive"
}

function standing(sim: OutbreakSim, state: DeathState, except: number): number {
  let n = 0
  for (const s of sim.slots) if (s.index !== except && (state.records[s.index]?.state ?? "alive") === "alive") n++
  return n
}

/** What is beside a survivor as they fall: the nearest living zombie's kind. */
function causeAt(sim: OutbreakSim, p: Survivor): number {
  let best = CAUSE_DEAD
  let bestD = CAUSE_REACH
  for (const z of sim.ai.agents) {
    if (z.state === "dead") continue
    const d = Math.hypot(z.x - p.x, z.y - p.y)
    if (d < bestD) {
      bestD = d
      best = specialKindOf(z.seed)
    }
  }
  return best
}

/** At 0 HP: down on the floor, out of any car or closet, whatever they were doing dropped. */
export function downSurvivor(sim: OutbreakSim, state: DeathState, slot: SurvivorSlot, t: DeathTuning, cause?: number): void {
  const rec = recordOf(state, slot, sim.time)
  if (rec.state !== "alive") return
  const p = slot.survivor
  if (p.vehicleId) sim.vehicles.leaveSeat(slot.id, p)
  if (sim.progression.verbs.hiddenIn(slot.id)) sim.progression.verbs.leaveHiding(slot)
  sim.progression.ledger.cancel(slot.id)
  Object.assign(p, createInteractActorState(), { health: 0, crouching: false, sprinting: false, vx: 0, vy: 0 })
  rec.state = "down"
  rec.since = sim.time
  rec.bleed = standing(sim, state, slot.index) > 0 ? t.bleedOut : t.soloBleedOut
  rec.revive = 0
  rec.reviver = -1
  rec.cause = cause ?? causeAt(sim, p)
  rec.night = state.night
  rec.dark = isDark(sim.hour)
}

/** Takes everything a survivor carried out of their hotbar, belt and pack. */
function strip(sim: OutbreakSim, slot: SurvivorSlot): Stack[] {
  const ledger = sim.progression.ledger
  const out: Stack[] = []
  for (const tpl of ledger.actorTemplates) {
    const st = ledger.store(`${slot.id}/${tpl.suffix}`)
    if (!st) continue
    if (st.mode === "slots") {
      // Bare hands stay with the survivor; everything else stays with the body.
      for (const s of st.slots) if (s && !ledger.isBound(s.item)) out.push({ ...s })
      st.slots = st.slots.map((s) => (s && ledger.isBound(s.item) ? s : null))
    } else {
      for (const [item, count] of Object.entries(st.counts)) if (count > 0) out.push({ item, count })
      st.counts = {}
    }
    st.rev = ++ledger.rev
  }
  sim.progression.project(slot)
  return out
}

/** Dead: the body stays where they fell with what they carried; their light goes out. */
export function killSurvivor(sim: OutbreakSim, state: DeathState, slot: SurvivorSlot, t: DeathTuning, cause?: number): void {
  const rec = recordOf(state, slot, sim.time)
  if (rec.state === "dead") return
  if (rec.state === "alive") downSurvivor(sim, state, slot, t, cause)
  const p = slot.survivor
  rec.state = "dead"
  rec.since = sim.time
  rec.bleed = 0
  rec.revive = 0
  rec.reviver = -1
  rec.deaths++
  Object.assign(p, { health: 0, flashlightOn: false, noise: 0, vx: 0, vy: 0 })
  // A departed survivor's bodies outlive their record, and a new survivor can reuse the seat.
  let n = rec.deaths
  for (const b of state.bodies) if (b.index === slot.index) n = Math.max(n, b.n + 1)
  const body: FallenBody = { index: slot.index, n, x: round2(p.x), y: round2(p.y), yaw: round2(p.aim) }
  const stacks = strip(sim, slot)
  const ledger = sim.progression.ledger
  if (stacks.length) {
    ledger.createStore({ id: fallenStoreId(body), mode: "slots", scope: "shared", size: stacks.length, revealed: true, at: { x: body.x, y: body.y }, initial: stacks })
  }
  state.bodies.push(body)
  while (state.bodies.length > MAX_FALLEN) {
    const old = state.bodies.shift()!
    if (ledger.store(fallenStoreId(old))) ledger.deleteStore(fallenStoreId(old))
  }
}

/** Back on their feet with a little health. */
export function reviveSurvivor(sim: OutbreakSim, state: DeathState, slot: SurvivorSlot, t: DeathTuning): void {
  const rec = recordOf(state, slot, sim.time)
  if (rec.state !== "down") return
  rec.state = "alive"
  rec.since = sim.time
  rec.bleed = 0
  rec.revive = 0
  rec.reviver = -1
  slot.survivor.health = Math.min(slot.survivor.maxHealth, Math.max(1, t.reviveHealth))
}

/** A new start at the safehouse: full health and a starting kit. */
export function respawnSurvivor(sim: OutbreakSim, state: DeathState, slot: SurvivorSlot): void {
  const rec = recordOf(state, slot, sim.time)
  if (rec.state !== "dead") return
  const p = slot.survivor
  const [x, y] = SPAWN_POINTS[slot.index % SPAWN_POINTS.length]!
  Object.assign(p, createStaminaState(), createFlashlightState(true), createInteractActorState(), createSurvivorCombatState(), {
    x,
    y,
    vx: 0,
    vy: 0,
    health: p.maxHealth,
    vehicleId: null,
    seatIndex: 0,
    crouching: false,
    noise: 0,
  })
  pushOut(p, 0.3, sim.solids)
  sim.progression.setLoadout(slot, DEFAULT_LOADOUT)
  rec.state = "alive"
  rec.since = sim.time
}

/** Today: everyone down or dead is back up where they are (health stays where it was, as before). */
function restoreToday(sim: OutbreakSim, state: DeathState): void {
  for (const rec of Object.values(state.records)) {
    if (rec.state === "alive") continue
    rec.state = "alive"
    rec.since = sim.time
    rec.bleed = rec.revive = 0
    rec.reviver = -1
  }
  state.runOver = false
}

/** Down: drag yourself along the floor, nothing else. Dead: nothing at all. Returns whether it handled the survivor. */
export function stepDeathMovement(ctx: OutbreakSimStepSurvivorContext<DeathState>, t: DeathTuning): boolean {
  if (!t.deathMode) return false
  const { sim, slot, command, dt, state } = ctx
  const life = state.records[slot.index]?.state ?? "alive"
  if (life === "alive") return false
  const p = slot.survivor
  const x = p.x
  const y = p.y
  p.crouching = false
  p.sprinting = false
  if (life === "down") {
    const len = Math.hypot(command.mx, command.my)
    if (len > 1e-4 && t.crawlSpeed > 0) {
      const step = (t.crawlSpeed * dt) / Math.max(1, len)
      p.x += command.mx * step
      p.y += command.my * step
      pushOut(p, 0.3, sim.solids)
    }
    p.noise = 0
  }
  p.vx = dt > 0 ? (p.x - x) / dt : 0
  p.vy = dt > 0 ? (p.y - y) / dt : 0
  return true
}

/** A standing survivor holding E at a downed teammate fills their revive. */
export function stepReviver(ctx: OutbreakSimStepSurvivorContext<DeathState>, t: DeathTuning): void {
  if (!t.deathMode) return
  const { sim, slot, command, dt, state } = ctx
  if (!command.interactHeld || (state.records[slot.index]?.state ?? "alive") !== "alive") return
  const target = slot.prompt
  if (target?.kind !== "downed") return
  const index = Number(target.id.slice(7))
  const rec = state.records[index]
  const other = sim.slots.find((s) => s.index === index)
  if (!rec || rec.state !== "down" || !other) return
  if (Math.hypot(other.survivor.x - slot.survivor.x, other.survivor.y - slot.survivor.y) > t.reviveRange + 0.3) return
  if (rec.reviver >= 0 && rec.reviver !== slot.index && sim.time - rec.reviveAt < REVIVE_GRACE) return
  rec.reviver = slot.index
  rec.reviveAt = sim.time
  rec.revive = Math.min(1, rec.revive + dt / Math.max(0.05, t.reviveTime))
  if (rec.revive >= 1) reviveSurvivor(sim, state, other, t)
}

/** Once per tick, after the crowd's attacks: who goes down, who bleeds out, who comes back, and whether it is over. */
export function stepDeath(sim: OutbreakSim, state: DeathState, t: DeathTuning, dt: number): void {
  const dark = isDark(sim.hour)
  state.dawn = !dark && state.wasDark
  if (dark && !state.wasDark) state.night++
  if (state.dawn) state.dawns++
  state.wasDark = dark
  if (!t.deathMode) {
    restoreToday(sim, state)
    state.feeding = {}
    return
  }
  creditKills(sim, state)
  const present = new Set<number>()
  for (const slot of sim.slots) {
    present.add(slot.index)
    const rec = recordOf(state, slot, sim.time)
    const p = slot.survivor
    if (rec.state === "alive") {
      if (p.health <= 0) downSurvivor(sim, state, slot, t)
      continue
    }
    p.health = 0
    if (rec.state !== "down") continue
    rec.bleed -= dt + (state.feeding[slot.index] ?? 0) * t.feedBleed
    if (standing(sim, state, slot.index) === 0) rec.bleed = Math.min(rec.bleed, t.soloBleedOut)
    if (rec.revive > 0 && sim.time - rec.reviveAt > REVIVE_GRACE) {
      rec.revive = 0
      rec.reviver = -1
    }
    if (rec.bleed <= 0) killSurvivor(sim, state, slot, t)
  }
  for (const key of Object.keys(state.records)) if (!present.has(Number(key))) delete state.records[Number(key)]
  state.feeding = {}
  if (state.dawn && t.respawnRule === RESPAWN_AT_DAWN && standing(sim, state, -1) > 0) {
    for (const slot of sim.slots) if (state.records[slot.index]?.state === "dead") respawnSurvivor(sim, state, slot)
  }
  if (!state.runOver && sim.slots.length > 0 && sim.slots.every((s) => state.records[s.index]?.state === "dead")) {
    state.runOver = true
    state.runOverAt = sim.time
  }
}

/** Every zombie that fell to a survivor's shot, blow or shove counts for them. */
function creditKills(sim: OutbreakSim, state: DeathState): void {
  for (const z of sim.ai.agents) {
    if (z.state !== "dead" || state.counted[z.id]) continue
    state.counted[z.id] = 1
    const by = z.lastHitBy ? sim.slots.find((s) => s.id === z.lastHitBy) : undefined
    if (by) recordOf(state, by, sim.time).kills++
  }
  const tracked = Object.keys(state.counted)
  if (tracked.length > sim.ai.agents.length + 32) {
    const live = new Set(sim.ai.agents.map((z) => z.id))
    for (const id of tracked) if (!live.has(Number(id))) delete state.counted[Number(id)]
  }
}

/** The dead keep feeding on a downed survivor: their bites come off the bleed-out instead of health. */
export function feedOnDowned(state: DeathState, slot: SurvivorSlot, damage: number): void {
  if (state.records[slot.index]?.state === "down") state.feeding[slot.index] = (state.feeding[slot.index] ?? 0) + damage
}

/** E at a downed teammate: hold to revive (`stepReviver` fills it; the tap does nothing on its own). */
export function downedHandler(sim: OutbreakSim, of: () => DeathState | undefined): InteractionHandler {
  return {
    kind: "downed",
    candidates: (_town, actor) => {
      const state = of()
      const t = state?.tuning
      if (!state || !t?.deathMode) return []
      const me = sim.progression.slotOf(actor)
      if (!me || (state.records[me.index]?.state ?? "alive") !== "alive") return []
      const out: RawInteractCandidate[] = []
      for (const s of sim.slots) {
        if (s.index === me.index || state.records[s.index]?.state !== "down") continue
        const p = s.survivor
        if (Math.hypot(p.x - actor.x, p.y - actor.y) > t.reviveRange) continue
        const primary = { id: "revive" as const, label: "Revive", hold: true }
        out.push({ kind: "downed", id: `downed:${s.index}`, label: "Down", rect: [p.x - 0.4, p.y - 0.4, p.x + 0.4, p.y + 0.4], worldX: p.x, worldY: p.y, primary, actions: [primary], priority: 4 })
      }
      return out
    },
    execute: (_town, _actor, targetId, action) => ({ handled: action === "revive", kind: "downed", targetId, action }),
  }
}

/** E at a fallen teammate's body: take what they carried. */
export function fallenHandler(sim: OutbreakSim, of: () => DeathState | undefined): InteractionHandler {
  return {
    kind: "fallen",
    candidates: (_town, actor) => {
      const state = of()
      if (!state?.bodies.length) return []
      const me = sim.progression.slotOf(actor)
      if (me && (state.records[me.index]?.state ?? "alive") !== "alive") return []
      const out: RawInteractCandidate[] = []
      for (const b of state.bodies) {
        if (Math.hypot(actor.x - b.x, actor.y - b.y) > FALLEN_REACH) continue
        const id = fallenStoreId(b)
        if (!sim.progression.contents(id).length) continue
        // Not in the first moments after a teammate dies, so an E held to revive them never strips their body.
        const rec = state.records[b.index]
        if (rec?.state === "dead" && b.n === rec.deaths && sim.time - rec.since < FALLEN_SETTLE) continue
        // Taking their whole kit is a hold (playtest: E at a body to "bring him back" took everything by surprise);
        // the strip's digits take one thing at a time.
        const take = { id: "take" as const, label: "Take all", hold: true }
        out.push({ kind: "fallen", id, label: `${sim.progression.names(b.index)}'s kit`, rect: [b.x - 0.45, b.y - 0.45, b.x + 0.45, b.y + 0.45], worldX: b.x, worldY: b.y, primary: take, secondary: take, deferPrimary: true, actions: [take] })
      }
      return out
    },
    execute: (_town, actor, targetId, action) => {
      const slot = sim.progression.slotOf(actor)
      // Only a completed hold takes everything; the tap does nothing.
      if (!slot || action !== "take" || !actor.holdTriggered) return { handled: false }
      return { handled: sim.progression.take(slot, targetId), kind: "fallen", targetId, action }
    },
  }
}

/** Lab and test commands: put a survivor down, kill them, or bring them back. */
export function forceLife(sim: OutbreakSim, slot: SurvivorSlot, life: LifeState, t: DeathTuning): void {
  const state = sim.getFeatureState<DeathState>("death")
  if (!state) return
  if (life === "down") downSurvivor(sim, state, slot, t, CAUSE_LAB)
  else if (life === "dead") killSurvivor(sim, state, slot, t, CAUSE_LAB)
  else {
    const rec = recordOf(state, slot, sim.time)
    if (rec.state === "down") reviveSurvivor(sim, state, slot, t)
    else if (rec.state === "dead") respawnSurvivor(sim, state, slot)
    else slot.survivor.health = slot.survivor.maxHealth
    state.runOver = false
  }
}
