import type { OutbreakAISubsystem } from "../../shared/ai"
import { createBreachState, freshWear, KIND_CRUSH, KIND_HINGES, KIND_SPLIT, type BreachState } from "../../shared/breach/rules"
import type { OutbreakSim } from "../../shared/sim-types"
import type { ProgressionLabHost } from "../progression/lab"

/**
 * Staged doors for the `outbreak-breach` Lab station, `breach.stage` and the clip (`scripts/breach-clip.ts`). Ash's
 * front door at dusk with the survivor inside facing it and the dead outside:
 *
 * - wear stages: `sound`, `cracked`, `split`, `failing`, `holed` (arms reaching through), `giving` (the warning beat);
 *   each is held by one of the dead bashing (`giving` plays straight into its breach);
 * - breaches: `hinges`, `split-door`, `crush` (five pushing), `boards` (the last board hanging), `burst` (a boarded
 *   window), each one hit from giving;
 * - `brace`: the survivor leaning on the door from inside while three push.
 */
export const BREACH_SCENES = ["sound", "cracked", "split", "failing", "holed", "giving", "hinges", "split-door", "crush", "boards", "burst", "brace"] as const
export type BreachScene = (typeof BREACH_SCENES)[number]

export type BreachStageHost = {
  readonly progressionHost: ProgressionLabHost
  session(): { sim: OutbreakSim; ai: OutbreakAISubsystem; rebuildCollision?(): void }
}

const DOOR = "ash-front"
const WINDOW = "ash-south-west"

export function stageBreach(host: BreachStageHost, scene: BreachScene): { scene: BreachScene; portal: string; zombies: number } {
  const ph = host.progressionHost
  const session = host.session()
  const { sim, ai } = session
  const town = sim.town
  const state = sim.getFeatureState<BreachState>("breach") ?? createBreachState()
  ai.agents.length = 0
  // Fresh doors and windows round Ash.
  for (const id of [DOOR, WINDOW]) {
    const st = ai.portalStates.get(id)
    if (st) Object.assign(st, { integrity: 100, barricadePlanks: 0, barricadeHp: 0, lastBashTime: -Infinity })
    delete state.portals[id]
  }
  const door = town.doors.find((d) => d.id === DOOR)!
  door.open = false
  door.locked = false
  const win = town.windows.find((w) => w.id === WINDOW)!
  win.open = false
  win.openable = true
  ph.setHour(19.1)
  const inside = scene === "brace" ? { x: 27.7, y: 34.9 } : scene === "burst" ? { x: 24.6, y: 33.3 } : { x: 27.7, y: 32.6 }
  const lookAt = scene === "burst" ? { x: 24.5, y: 35.4 } : { x: 27.7, y: 35.4 }
  ph.pose(inside.x, inside.y, Math.atan2(lookAt.y - inside.y, lookAt.x - inside.x))

  const pushers = scene === "crush" ? 5 : scene === "brace" ? 3 : scene === "sound" ? 1 : scene === "holed" ? 2 : 1
  const at = scene === "burst" ? { x: 24.5, y: 36.0 } : { x: 27.7, y: 36.0 }
  for (let i = 0; i < pushers; i++) {
    const z = ai.spawnZombie(town, at.x - 0.42 * (pushers - 1) * 0.5 + i * 0.42, at.y + (i % 2) * 0.35, "chase", -Math.PI / 2)
    z.targetX = inside.x
    z.targetY = inside.y
    z.awareness = 1
  }
  const st = ai.portalStates.get(DOOR)!
  const w = (state.portals[DOOR] = freshWear())
  w.outside = 1
  const integrity: Partial<Record<BreachScene, number>> = { sound: 100, cracked: 70, split: 45, failing: 22, holed: 22, giving: 4, hinges: 4, "split-door": 4, crush: 4, brace: 100 }
  st.integrity = integrity[scene] ?? 100
  if (scene === "holed") w.holed = true
  if (scene === "failing") w.holed = false
  if (scene === "hinges" || scene === "giving") w.forced = KIND_HINGES
  if (scene === "split-door") w.forced = KIND_SPLIT
  if (scene === "crush") w.forced = KIND_CRUSH
  if (scene === "boards") {
    st.integrity = 100
    ai.addBarricadePlank(DOOR, 100)
    st.barricadeHp = 18
  }
  if (scene === "burst") {
    delete state.portals[DOOR]
    ai.addBarricadePlank(WINDOW, 100)
    ai.portalStates.get(WINDOW)!.barricadeHp = 18
  }
  // Hold the wear stages where they are: the dead keep pushing, but the door doesn't lose more.
  if (["sound", "cracked", "split", "failing", "holed"].includes(scene)) holdWear(sim, { integrity: st.integrity, holed: scene === "holed" })
  else holdWear(sim, null)
  if (session.rebuildCollision) session.rebuildCollision()
  else ai.rebuildTopology(town)
  return { scene, portal: scene === "burst" ? WINDOW : DOOR, zombies: ai.agents.length }
}

type Held = { integrity: number; holed: boolean }
const holds = new WeakMap<OutbreakSim, Held | null>()

/** Pins Ash's front door at a wear stage (null releases it), so a staged stage holds while the dead hit it. */
function holdWear(sim: OutbreakSim, held: Held | null): void {
  holds.set(sim, held)
}

/** Called each frame by the client feature: keeps a held stage's integrity where it was staged. */
export function applyStageHold(sim: OutbreakSim): void {
  const held = holds.get(sim)
  if (!held) return
  const st = sim.ai.portalStates.get(DOOR)
  if (st) st.integrity = held.integrity
  const w = sim.getFeatureState<BreachState>("breach")?.portals[DOOR]
  if (w) {
    w.givingAt = -1
    w.holed = held.holed
  }
}
