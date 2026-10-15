import type { LabCommand } from "@arcade/kit/lab/commands"
import { PISTOL_NOISE } from "../../shared/combat"
import { hordeControls } from "../../shared/hordes/index"
import { registerOutbreakClientFeature } from "../feature-registry"
import { DEFAULT_OUTBREAK_HORDES } from "../settings"
import { directAllHordes, HORDE_SCENES, hordeSummary, stageHordeScene, triggerHordeNoise, type HordeScene } from "./stage"

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
