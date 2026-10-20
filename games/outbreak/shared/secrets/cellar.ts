import { distToRect } from "@arcade/kit/sim/geom"
import type { Stack, StoreState } from "@arcade/kit/sim/ledger"
import type { InteractAction, InteractionHandler, RawInteractCandidate } from "../interact"
import { buildingAt } from "../progression/loot"
import type { OutbreakSim } from "../sim-types"
import { DEFAULT_SECRETS_TUNING, secretsTuning, type SecretId, type SecretsTuning } from "./catalog"
import { secretHosts, type SecretHost } from "./hosts"
import { secretSitesIn, type SecretSite } from "./places"
import { secretRun, type SecretRun } from "./select"

/**
 * The radio man's cellar (`docs/outbreak-secrets.md#hidden`): a hatch with a three-dial padlock in one house. E turns
 * the dial you are on, hold E moves to the next; set to the run's code it drops open, and E takes what he left.
 *
 * | Store | Counts | Meaning |
 * | --- | --- | --- |
 * | `secret:cellar` | `d0`, `d1`, `d2` (0–9), `dial` (0–2), `open`, `turns` | the dials, the one being turned, open, how many turns so far (so clients hear each click) |
 * | `secret:cellar:stash` | slots | what he left; created as it opens |
 *
 * No store is a lock nobody has touched: dials at 0 0 0, shut. Shared ledger stores, so the lock snapshots, saves,
 * reaches every co-op client (a late joiner too) and Restart or New town shuts it again with a fresh ledger.
 */
export const CELLAR_STORE = "secret:cellar"
export const CELLAR_STASH = "secret:cellar:stash"

/** What the radio man left. */
export const CELLAR_LOOT: readonly Stack[] = [
  { item: "flamethrower", count: 1 },
  { item: "flare-gun", count: 1 },
  { item: "ammo", count: 12 },
  { item: "medkit", count: 1 },
]

/** How loud the padlock is: a click per turn, a clunk as it opens (m). */
export const DIAL_NOISE = 1.2
export const OPEN_NOISE = 5

/** Per-sim secrets state: the run, its one-house hosts, and the cellar's hatch while its house is in the world. */
export type SecretsState = {
  tuning: SecretsTuning
  run: SecretRun
  hosts: ReadonlyMap<SecretId, SecretHost>
  hatch: SecretSite | null
  key: string
  lastTuning?: SecretsTuning
}

export function createSecretsState(sim: OutbreakSim): SecretsState {
  const state: SecretsState = { tuning: DEFAULT_SECRETS_TUNING, run: secretRun(sim.town, DEFAULT_SECRETS_TUNING), hosts: new Map(), hatch: null, key: "" }
  syncSecrets(sim, state)
  return state
}

/** Re-plans when the tuning changes, and finds the hatch when its house streams in or out. */
export function syncSecrets(sim: OutbreakSim, state: SecretsState, tuning: SecretsTuning = state.tuning): void {
  const town = sim.town
  const tkey = JSON.stringify(tuning)
  const key = `${tkey}:${town.seed}:${town.houseSeed}:${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}`
  if (key === state.key) return
  if (tkey !== JSON.stringify(state.tuning) || !state.key) {
    state.tuning = tuning
    state.run = secretRun(town, tuning)
    state.hosts = secretHosts(town, sim.worldStream.mode, state.run.picked)
  }
  state.key = key
  state.hatch = null
  const host = state.hosts.get("cellar")
  const b = host && town.buildings.find((x) => x.id === host.buildingId)
  if (b) state.hatch = secretSitesIn(town, b, state.run, state.hosts).find((s) => s.piece === "hatch") ?? null
}

/** The dials, which one is being turned and whether it is open, from the store (or none: 0 0 0, shut). */
export type CellarLock = { dials: [number, number, number]; dial: number; open: boolean; turns: number }

export function cellarLock(st: StoreState | undefined): CellarLock {
  const c = st?.counts ?? {}
  return { dials: [c.d0 ?? 0, c.d1 ?? 0, c.d2 ?? 0], dial: c.dial ?? 0, open: Boolean(c.open), turns: c.turns ?? 0 }
}

/** Reach from the hatch's edge to use it (m). */
const REACH = 1.3

function lockStore(sim: OutbreakSim, at: { x: number; y: number }): StoreState {
  const ledger = sim.progression.ledger
  return ledger.store(CELLAR_STORE) ?? ledger.createStore({ id: CELLAR_STORE, mode: "counters", scope: "shared", at, initial: { d0: 0, d1: 0, d2: 0, dial: 0, open: 0, turns: 0 } })
}

/**
 * Turns the dial being turned one notch (`next` false) or moves on to the next dial; opens the lock when the dials
 * read the code. Returns whether it just opened.
 */
export function workLock(sim: OutbreakSim, state: SecretsState, next: boolean): boolean {
  const hatch = state.hatch
  if (!hatch) return false
  const ledger = sim.progression.ledger
  const st = lockStore(sim, hatch)
  if (st.counts.open) return false
  const dial = st.counts.dial ?? 0
  if (next) st.counts.dial = (dial + 1) % 3
  else {
    const k = `d${dial}`
    st.counts[k] = ((st.counts[k] ?? 0) + 1) % 10
    st.counts.turns = (st.counts.turns ?? 0) + 1
  }
  const [a, b, c] = state.run.code
  const opened = st.counts.d0 === a && st.counts.d1 === b && st.counts.d2 === c
  if (opened) {
    st.counts.open = 1
    if (!ledger.store(CELLAR_STASH)) ledger.createStore({ id: CELLAR_STASH, mode: "slots", scope: "shared", size: CELLAR_LOOT.length, at: { x: hatch.x, y: hatch.y }, initial: CELLAR_LOOT.map((s) => ({ ...s })) })
  }
  st.rev = ++ledger.rev
  return opened
}

/** E at the hatch: turn a dial, hold E for the next dial; once open, take what he left. */
export function cellarHandler(sim: OutbreakSim, id: string): InteractionHandler {
  const of = () => sim.getFeatureState<SecretsState>(id)
  return {
    kind: "padlock",
    candidates: (town, actor) => {
      const state = of()
      const hatch = state?.hatch
      if (!hatch || actor.peekingWindowId || distToRect(actor.x, actor.y, hatch.rect) > REACH) return []
      if ((buildingAt(town, actor.x, actor.y)?.id ?? null) !== hatch.buildingId) return []
      const lock = cellarLock(sim.progression.ledger.store(CELLAR_STORE))
      const base = { id: CELLAR_STORE, rect: hatch.rect, worldX: hatch.x, worldY: hatch.y, buildingId: hatch.buildingId, priority: 2 }
      if (lock.open) {
        if (!sim.progression.contents(CELLAR_STASH).length) return []
        const primary: InteractAction = { id: "take", label: "Take all" }
        return [{ ...base, kind: "padlock", label: "Cellar", primary, actions: [primary] } satisfies RawInteractCandidate]
      }
      const primary: InteractAction = { id: "board", label: "Turn" }
      const secondary: InteractAction = { id: "install", label: "Next dial", hold: true }
      return [{ ...base, kind: "padlock", label: "Padlock", primary, secondary, actions: [primary, secondary], deferPrimary: true } satisfies RawInteractCandidate]
    },
    execute: (_town, actor, targetId, action) => {
      const state = of()
      const hatch = state?.hatch
      if (!state || !hatch || targetId !== CELLAR_STORE || distToRect(actor.x, actor.y, hatch.rect) > REACH + 0.4) return { handled: false }
      const lock = cellarLock(sim.progression.ledger.store(CELLAR_STORE))
      if (lock.open) {
        const slot = sim.progression.slotOf(actor)
        if (action !== "take" || !slot) return { handled: false }
        return { handled: sim.progression.take(slot, CELLAR_STASH), kind: "padlock", targetId, action }
      }
      if (action !== "board" && action !== "install") return { handled: false }
      const opened = workLock(sim, state, action === "install")
      return { handled: true, kind: "padlock", targetId, action, noise: opened ? OPEN_NOISE : DIAL_NOISE, noiseKind: "door" }
    },
  }
}

/** Once a tick: re-plans only when the tuning object changed (the town's changes come through `syncSecrets`). */
export function stepSecrets(sim: OutbreakSim, state: SecretsState, features: Readonly<Record<string, Record<string, unknown>>> | undefined): void {
  const t = secretsTuning(features)
  if (t === state.lastTuning) return
  state.lastTuning = t
  syncSecrets(sim, state, t)
}
