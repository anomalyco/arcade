import type { CoopSim } from "../../shared/coop-sim"
import { PISTOL_NOISE } from "../../shared/combat"
import { addHorde, directHorde, disbandHorde, hordesOf, materializeHorde } from "../../shared/hordes/index"
import type { OutbreakHarness, OutbreakHarnessHost } from "../harness"

export const HORDE_SCENES = ["street", "crossroads", "split", "funnel", "barricade", "gunshot"] as const
export type HordeScene = (typeof HORDE_SCENES)[number]

/** Inside Elm House with its doors shut: out of the horde's way, with the main street in view. */
const SAFE_SPOT = [28.5, 60] as const
/** The town's central crossroads, between the four buildings. */
const CROSSROADS = [45, 46] as const
const HARDWARE_DOOR = "hardware-front"

function resetWorld(sim: CoopSim): void {
  for (const h of [...hordesOf(sim).hordes]) disbandHorde(sim, h)
  sim.ai.agents.length = 0
  sim.ai.noiseBus.reset()
  hordesOf(sim).lastNoise = 0
  const door = sim.town.doors.find((d) => d.id === HARDWARE_DOOR)
  const st = sim.ai.portalStates.get(HARDWARE_DOOR)
  if (door) door.open = false
  if (st) Object.assign(st, { barricadePlanks: 0, barricadeHp: 0, integrity: 100 })
}

/** Stages a Lab horde scene in the classic town (seed 7 layout) and returns what was placed. */
export function stageHordeScene(host: OutbreakHarnessHost, harness: OutbreakHarness, scene: string, size: number) {
  const { settings, lab } = host
  const session = host.session()
  const sim = session.sim
  const n = Math.max(0, Math.min(1000, Math.round(size)))
  resetWorld(sim)
  // Watching a horde from a distance: every member drawn, camera on the horde rather than the survivor.
  settings.unseen.hideUnseenZombies = false
  settings.hordes.hordeWatch = true
  settings.dayCycle.hour = 23
  session.view.hour = 23
  harness.pose(SAFE_SPOT[0], SAFE_SPOT[1], -Math.PI / 2)
  const placed: { id: number; size: number; x: number; y: number; goal?: [number, number] }[] = []
  const place = (x: number, y: number, count: number, goal?: [number, number]) => {
    if (count <= 0) return
    const h = addHorde(sim, x, y, count, goal ? { x: goal[0], y: goal[1] } : undefined)
    materializeHorde(sim, h)
    placed.push({ id: h.id, size: count, x, y, goal })
    return h
  }
  if (scene === "split") {
    place(44, 30.5, n, [82, 30.5])
  } else if (scene === "funnel" || scene === "barricade") {
    const door = sim.town.doors.find((d) => d.id === HARDWARE_DOOR)
    if (door && scene === "funnel") door.open = true
    if (scene === "barricade") for (let i = 0; i < 3; i++) sim.ai.addBarricadePlank(HARDWARE_DOOR)
    session.rebuildCollision()
    place(60, 47, n, [63, 33])
  } else if (scene === "gunshot") {
    place(80, 40, Math.round(n / 2))
    place(82, 86, n - Math.round(n / 2))
    session.ai.emitNoise(84, 14, PISTOL_NOISE, "gunshot", session.view.time, "lab", 2.2)
  } else if (scene === "crossroads") {
    // The survivor stands in the open; two idle hordes wait up the north and east streets for a noise.
    harness.pose(CROSSROADS[0], CROSSROADS[1], -Math.PI / 2)
    place(45, 10, Math.round(n * 0.55))
    place(86, 46, n - Math.round(n * 0.55))
  } else {
    // A night horde walks the length of the main street toward a gunshot at the south end.
    place(45, 10, n, [46, 88])
  }
  lab.refresh()
  return { scene, hordes: placed, live: sim.ai.agents.filter((a) => a.hordeId !== undefined).length }
}

/** Fires a gunshot at `(x, y)` (default: the survivor) that every horde in earshot turns toward. */
export function triggerHordeNoise(host: OutbreakHarnessHost, x?: number, y?: number) {
  const session = host.session()
  const p = session.view.player
  const ev = session.ai.emitNoise(x ?? p.x, y ?? p.y, PISTOL_NOISE, "gunshot", session.view.time, "lab", 2.2)
  return { x: ev.x, y: ev.y, radius: ev.radius }
}

/** Points every horde at `(x, y)` directly (Lab), without a noise. */
export function directAllHordes(sim: CoopSim, x: number, y: number): number {
  const hordes = hordesOf(sim).hordes
  for (const h of hordes) directHorde(sim, h, x, y)
  return hordes.length
}

export function hordeSummary(sim: CoopSim) {
  const hordes = hordesOf(sim).hordes
  const flow = sim.ai.flow
  return {
    hordes: hordes.map((h) => ({
      id: h.id,
      x: Math.round(h.x * 10) / 10,
      y: Math.round(h.y * 10) / 10,
      live: h.live,
      pending: h.pending,
      goal: h.goal,
    })),
    members: sim.ai.agents.filter((a) => a.hordeId !== undefined && a.state !== "dead").length,
    flow: { builds: flow.builds, hits: flow.hits, deferred: flow.deferred },
  }
}

/** Where the Lab's horde camera looks: the biggest live horde's centre, or null when no horde is in the world. */
export function hordeWatchPoint(sim: CoopSim): { x: number; y: number } | null {
  let best: { x: number; y: number; live: number } | null = null
  for (const h of hordesOf(sim).hordes) if (h.live > 0 && (!best || h.live > best.live)) best = h
  return best ? { x: best.x, y: best.y } : null
}
