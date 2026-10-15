import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import type { LabCommand } from "@arcade/kit/lab/commands"
import { FLOW_UNREACHED, type FlowField } from "@arcade/kit/sim/flow-field"
import type { CoopSim } from "../../shared/coop-sim"
import {
  addHorde,
  directHorde,
  disbandHorde,
  hordeControls,
  hordesOf,
  materializeHorde,
  outbreakHordesSharedFeature,
} from "../../shared/hordes/index"
import { PISTOL_NOISE } from "../../shared/combat"
import { registerOutbreakClientFeature } from "../feature-registry"
import type { OutbreakHarness, OutbreakHarnessHost } from "../harness"
import { DEFAULT_OUTBREAK_HORDES } from "../settings"

export { outbreakHordesSharedFeature }
export * from "../../shared/hordes/index"

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

/** The field most recently read by the crowd (what the horde is following right now). */
function busiestField(sim: CoopSim): FlowField | null {
  let best: FlowField | null = null
  for (const f of sim.ai.flow.activeFields()) if (!best || f.lastUsed > best.lastUsed) best = f
  return best
}

const dir = { x: 0, y: 0 }

/**
 * Downhill direction at `(x, y)` from the cost gradient over ±`r` metres (smooth, unlike the octile next-cell step),
 * falling back to the next cell where a neighbour is unreachable. False where the field has no way down.
 */
function flowDirection(field: FlowField, x: number, y: number, r: number): boolean {
  const e = field.costAt(x + r, y)
  const w = field.costAt(x - r, y)
  const s = field.costAt(x, y + r)
  const n = field.costAt(x, y - r)
  if (e !== FLOW_UNREACHED && w !== FLOW_UNREACHED && s !== FLOW_UNREACHED && n !== FLOW_UNREACHED) {
    const gx = w - e
    const gy = n - s
    const len = Math.hypot(gx, gy)
    if (len > 0) {
      dir.x = gx / len
      dir.y = gy / len
      return true
    }
  }
  field.direction(x, y, dir)
  return dir.x !== 0 || dir.y !== 0
}

/**
 * Appends the flow-field overlay for the field the crowd read most recently: an arrow per sample point around
 * `(cx, cy)` pointing downhill, cyan near the goal and violet far from it. Returns the new alpha sprite count.
 */
export function renderFlowOverlay(
  sim: CoopSim,
  cx: number,
  cy: number,
  support: (x: number, z: number) => number,
  sprites: Float32Array,
  start: number,
  budget = 540,
): number {
  const field = busiestField(sim)
  if (!field) return start
  const max = Math.min(Math.floor(sprites.length / SPRITE_FLOATS), start + budget) - 3
  const half = 24
  // Three sprites per arrow: shaft and two barbs.
  const spacing = (2 * half) / Math.sqrt(budget / 3)
  const len = spacing * 0.36
  let count = start
  const line = (x: number, y: number, gy: number, size: number, rot: number, u: number, a: number) => {
    const o = count++ * SPRITE_FLOATS
    sprites[o] = x
    sprites[o + 1] = gy
    sprites[o + 2] = y
    sprites[o + 3] = size
    sprites[o + 4] = 0.3 + 0.45 * u
    sprites[o + 5] = 0.9 - 0.6 * u
    sprites[o + 6] = 1
    sprites[o + 7] = a
    sprites[o + 8] = 4
    sprites[o + 9] = rot
    sprites[o + 10] = 0.12 * (spacing * 0.36) / size
    sprites[o + 11] = 0
  }
  for (let y = cy - half; y <= cy + half && count < max; y += spacing) {
    for (let x = cx - half; x <= cx + half && count < max; x += spacing) {
      const c = field.costAt(x, y)
      if (c === FLOW_UNREACHED || !flowDirection(field, x, y, 1)) continue
      const u = Math.min(1, c / 900)
      const gy = support(x, y) + 0.06
      const ang = Math.atan2(dir.y, dir.x)
      line(x, y, gy, len, ang, u, 0.5)
      const tipX = x + dir.x * len
      const tipY = y + dir.y * len
      for (const side of [2.5, -2.5]) {
        const barb = ang + side
        line(tipX + Math.cos(barb) * len * 0.22, tipY + Math.sin(barb) * len * 0.22, gy, len * 0.22, barb, u, 0.5)
      }
    }
  }
  return count
}

export const outbreakHordesFeature = registerOutbreakClientFeature({
  id: "hordes",
  order: 16,
  settingsGroup: {
    subsystem: "hordes",
    defaults: DEFAULT_OUTBREAK_HORDES,
  },
  labControls: (host) => {
    const stage = (scene: HordeScene) => () => {
      if (!host.progressionHost.offline()) return
      const harness = (globalThis as { __arcadeHarness?: { stageHordes?: (s: string, n: number) => unknown } }).__arcadeHarness
      harness?.stageHordes?.(scene, host.settings.hordes.hordeSize)
    }
    return [
      ...hordeControls,
      { key: "hordes.hordeFlowOverlay", field: "hordeFlowOverlay", label: "Flow-field overlay", group: "Hordes" },
      { key: "hordes.hordeWatch", field: "hordeWatch", label: "Camera follows horde", group: "Hordes" },
      { key: "stageHordeStreet", label: "Stage street horde", group: "Hordes", type: "action", run: stage("street") },
      { key: "stageHordeSplit", label: "Stage building split", group: "Hordes", type: "action", run: stage("split") },
      { key: "stageHordeFunnel", label: "Stage door funnel", group: "Hordes", type: "action", run: stage("funnel") },
      { key: "stageHordeBarricade", label: "Stage barricade pile-up", group: "Hordes", type: "action", run: stage("barricade") },
      { key: "stageHordeGunshot", label: "Stage gunshot peel", group: "Hordes", type: "action", run: stage("gunshot") },
      {
        key: "hordeNoise",
        label: "Fire a gunshot here",
        group: "Hordes",
        type: "action",
        run: () => {
          const session = host.session()
          const p = session.view.player
          session.ai.emitNoise(p.x, p.y, PISTOL_NOISE, "gunshot", session.view.time, "lab", 2.2)
        },
      },
    ]
  },
  gameCommands: (host): LabCommand[] => [
    {
      id: "hordes.stage",
      label: "Stage Horde Scene",
      shortLabel: "Horde Scene",
      category: "Scene",
      undoable: false,
      args: {
        scene: { type: "string", description: `Scene (${HORDE_SCENES.join(", ")})` },
        size: { type: "number", description: "Members (0–1000)" },
      },
      enabled: () => !host.coop.net,
      run: async (_ctx, args) => {
        const harness = host.harness() as unknown as { stageHordes: (s: string, n: number) => unknown }
        const out = harness.stageHordes(String(args?.scene ?? "street"), Number(args?.size ?? host.settings.hordes.hordeSize))
        await host.harness().step(1 / 60)
        return out
      },
    },
    {
      id: "hordes.noise",
      label: "Fire Horde Gunshot",
      shortLabel: "Horde Noise",
      category: "Scene",
      undoable: false,
      args: {
        x: { type: "number", description: "World x (default: survivor)" },
        y: { type: "number", description: "World y (default: survivor)" },
      },
      enabled: () => !host.coop.net,
      run: async (_ctx, args) => {
        const harness = host.harness() as unknown as { hordeNoise: (x?: number, y?: number) => unknown }
        const x = args?.x === undefined ? undefined : Number(args.x)
        const y = args?.y === undefined ? undefined : Number(args.y)
        return harness.hordeNoise(x, y)
      },
    },
  ],
  harnessMethods: (host, harness) => ({
    /** Stages a horde scene (street, split, funnel, barricade, gunshot) with `size` members. */
    stageHordes(scene: string = "street", size = host.settings.hordes.hordeSize) {
      return stageHordeScene(host, harness, scene, size)
    },
    /** Fires a gunshot hordes can hear, at `(x, y)` or the survivor. */
    hordeNoise(x?: number, y?: number) {
      return triggerHordeNoise(host, x, y)
    },
    /** Sends every horde to `(x, y)` without a noise. */
    directHordes(x: number, y: number) {
      return directAllHordes(host.session().sim, x, y)
    },
  }),
  harnessState: (host) => ({
    hordes: hordeSummary(host.session().sim),
  }),
})
