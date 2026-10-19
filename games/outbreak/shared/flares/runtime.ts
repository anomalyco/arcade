import { clearLine, raycast, type Rect } from "@arcade/kit/sim/geom"
import type { AIAgent } from "@arcade/kit/sim/ai"
import { dayCycle } from "../day-cycle"
import { sightRects } from "../map"
import { ds } from "../radios/radios"
import type { OutbreakSim, SurvivorSlot } from "../sim-types"
import { DEFAULT_FLARE_TUNING, FLARE_STRIKE_NOISE, isFlareStore, type FlareTuning } from "./flares"

/** Per-sim flare state: the beat each burning flare last pulled on, and the tuning last used. */
export type FlaresState = { beats: Record<string, number>; tuning: FlareTuning }

export function createFlaresState(): FlaresState {
  return { beats: {}, tuning: DEFAULT_FLARE_TUNING }
}

export function flareTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): FlareTuning {
  return (features?.flares as FlareTuning | undefined) ?? DEFAULT_FLARE_TUNING
}

/** Throws the flare in hand: it lands where a bottle would, struck and burning. */
export function throwFlare(sim: OutbreakSim, slot: SurvivorSlot, tuning: FlareTuning): boolean {
  const progression = sim.progression
  const p = slot.survivor
  const res = progression.ledger.apply({ kind: "run", actor: slot.id, rule: "throw:flare" })
  if (!res.ok) return false
  const dx = Math.cos(p.aim)
  const dy = Math.sin(p.aim)
  const reach = Math.max(0.6, Math.min(tuning.flareThrow, raycast(p.x, p.y, dx, dy, sightRects(sim.town), tuning.flareThrow)) - 0.3)
  const x = Number((p.x + dx * reach).toFixed(2))
  const y = Number((p.y + dy * reach).toFixed(2))
  progression.ledger.createStore({
    id: `flare:${progression.takeId()}`,
    mode: "counters",
    scope: "shared",
    owner: slot.id,
    at: { x, y },
    initial: { t: ds(sim.time), until: ds(sim.time + tuning.flareSeconds) },
  })
  sim.ai.emitNoise(p.x, p.y, FLARE_STRIKE_NOISE, "flare", sim.time, slot.id, 0.6)
  progression.project(slot)
  return true
}

/** The dead a flare can pull: anyone not already after a survivor, fighting a door, or down. */
const LURABLE: ReadonlySet<AIAgent["state"]> = new Set(["wander", "investigate", "search"])

/**
 * Once per tick: burnt-out flares go, and on each burning flare's beat every one of the dead that can see it (in
 * reach, in clear sight past walls and shut doors, not already after a survivor) turns and goes to stand in its glow,
 * each at its own spot round it so they ring it rather than pile on it.
 */
export function stepFlares(sim: OutbreakSim, state: FlaresState, tuning: FlareTuning): void {
  const ledger = sim.progression.ledger
  const time = sim.time
  const t = ds(time)
  for (const st of [...ledger.stores.values()]) {
    if (!isFlareStore(st.id) || !st.at) continue
    if (t >= (st.counts.until ?? 0)) {
      ledger.deleteStore(st.id)
      delete state.beats[st.id]
      continue
    }
    const due = Math.floor(Math.max(0, time - (st.counts.t ?? 0) / 10) / Math.max(0.05, tuning.flareBeat))
    if ((state.beats[st.id] ?? -1) >= due) continue
    state.beats[st.id] = due
    pullToward(sim, sightRects(sim.town), st.at.x, st.at.y, tuning.flareReach * (0.45 + 0.55 * dayCycle(sim.hour).darkness))
  }
  for (const id of Object.keys(state.beats)) if (!ledger.store(id)) delete state.beats[id]
}

/** Sends every lurable zombie within `reach` that can see `(x, y)` to a spot of its own round it. */
export function pullToward(sim: OutbreakSim, blockers: readonly Rect[], x: number, y: number, reach: number): number {
  let pulled = 0
  for (const a of sim.ai.agents) {
    if (!LURABLE.has(a.state) || a.seesTarget) continue
    const d = Math.hypot(a.x - x, a.y - y)
    if (d > reach || !clearLine(x, y, a.x, a.y, blockers)) continue
    const ang = a.id * 2.39996
    const r = 0.9 + (a.id % 3) * 0.4
    const tx = x + Math.cos(ang) * r
    const ty = y + Math.sin(ang) * r
    if (Math.hypot(a.targetX - tx, a.targetY - ty) > 0.5) a.repathAt = 0
    a.targetX = tx
    a.targetY = ty
    a.targetKind = "light"
    a.awareness = Math.max(a.awareness, 0.45)
    if (a.state !== "investigate") {
      a.state = "investigate"
      a.stateTime = 0
    }
    pulled++
  }
  return pulled
}
