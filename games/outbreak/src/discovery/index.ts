import type { OutbreakAISubsystem } from "../../shared/ai"
import type { SessionView } from "../../shared/session"
import { registerOutbreakClientFeature } from "../feature-registry"
import type { ProgressionLabHost } from "../progression/index"
import type { DiscoveryProps } from "./props"
import { DEFAULT_DISCOVERY_SETTINGS, discoveryControls } from "./settings"

export { DEFAULT_DISCOVERY_SETTINGS, discoveryControls, type DiscoverySettings } from "./settings"
export { DiscoveryProps } from "./props"

/** What the Discovery Lab scenes need: the progression host (view, pose, clock, inventory HUD) and the world props. */
export type DiscoveryHost = ProgressionLabHost & { props: DiscoveryProps }

/** Staged scenes for the `outbreak-discovery` Lab station and proofs. */
export const DISCOVERY_SCENES = ["low-flashlight", "weakened-barricade", "open-containers", "drops"] as const
export type DiscoveryScene = (typeof DISCOVERY_SCENES)[number]

function stock(view: SessionView, id: string, items: readonly (readonly [string, number])[]): void {
  const ledger = view.progression.ledger
  const st = ledger.store(id)
  if (!st) return
  st.slots.fill(null)
  items.forEach(([item, count], i) => (st.slots[i] = { item, count }))
  st.revealed = true
  st.rev = ++ledger.rev
}

/** Boards up a portal with `planks` boards and sets the barricade's hit points to `wear` of nominal. */
export function boardUp(view: SessionView, ai: OutbreakAISubsystem, id: string, planks: number, wear: number): void {
  const st = ai.portalStates.get(id)
  if (!st) return
  st.barricadePlanks = 0
  st.barricadeHp = 0
  for (let i = 0; i < planks; i++) ai.addBarricadePlank(id, 100)
  st.barricadeHp = planks * 100 * wear
  ai.rebuildTopology(view.town)
}

export function stageDiscovery(host: DiscoveryHost, scene: DiscoveryScene, ai: OutbreakAISubsystem): void {
  const view = host.view()
  host.hud.close()
  const ash = view.town.buildings.find((b) => b.id === "ash")!
  switch (scene) {
    case "low-flashlight": {
      host.setHour(23)
      const p = view.player
      p.flashlightOn = true
      p.battery = 0.12
      p.batteryDepleted = false
      host.pose(ash.rect[0] + 6.2, ash.rect[3] + 3.4, Math.PI / 2 - 0.35)
      return
    }
    case "weakened-barricade": {
      host.setHour(17)
      const win = view.town.windows.find((w) => w.id === "ash-south-west")!
      const door = view.town.doors.find((d) => d.id === "ash-front")!
      boardUp(view, ai, win.id, 3, 0.5)
      boardUp(view, ai, door.id, 2, 1)
      // From inside, where the defenders watch the boards give.
      host.pose((win.rect[0] + win.rect[2]) / 2 + 1.2, win.rect[1] - 2.2, Math.PI / 2 + 0.3)
      return
    }
    case "open-containers": {
      host.setHour(15)
      const mine = view.containers.filter((c) => c.buildingId === "ash")
      const fill: Record<string, [string, number][]> = {
        dresser: [["ammo", 6], ["medkit", 1], ["scrap", 2]],
        nightstand: [["battery", 1], ["noisemaker", 1]],
        counter: [["chem", 2], ["knife", 1]],
        fridge: [["chem", 1]],
        shelf: [["plank", 2], ["hammer", 1]],
      }
      for (const c of mine) stock(view, c.id, fill[c.kind] ?? [])
      const dresser = mine.find((c) => c.kind === "dresser") ?? mine[0]!
      // Beside it rather than in front, so the survivor does not hide the open drawer from the camera.
      host.pose(dresser.x + 1.7, dresser.y + 1.0, Math.atan2(-1.0, -1.7))
      return
    }
    case "drops": {
      host.setHour(19)
      host.pose(44, 44, 0)
      const ledger = view.progression.ledger
      for (const [item, count] of [["medkit", 1], ["ammo", 12], ["plank", 2], ["crowbar", 1]] as const)
        ledger.apply({ kind: "grant", actor: view.actorId, item, count })
      ledger.apply({ kind: "drop", actor: view.actorId, at: { x: 45.2, y: 44.1 }, items: { medkit: 1, ammo: 6 } })
      ledger.apply({ kind: "drop", actor: view.actorId, at: { x: 44.4, y: 45.3 }, items: { plank: 2 } })
    }
  }
}

export const outbreakDiscoveryFeature = registerOutbreakClientFeature({
  id: "discovery",
  order: 24,
  settingsGroup: { subsystem: "discovery", defaults: DEFAULT_DISCOVERY_SETTINGS },
  labControls: (host) => [
    ...discoveryControls,
    {
      key: "discoveryForgetPrompts",
      label: "Forget learned prompts",
      group: "Discovery",
      type: "action",
      run: () => host.progressionHost.hud.resetFamiliar(),
    },
    ...DISCOVERY_SCENES.map((scene) => ({
      key: `discoveryStage-${scene}`,
      label: `Stage: ${scene.replace(/-/g, " ")}`,
      group: "Discovery",
      type: "action" as const,
      run: () => stageDiscovery(host.discoveryHost, scene, host.session().ai),
    })),
  ],
  gameCommands: (host) => [
    {
      id: "discovery.stage",
      label: "Stage a Discovery Scene",
      shortLabel: "Discovery Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${DISCOVERY_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "weakened-barricade") as DiscoveryScene
        if (!DISCOVERY_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        stageDiscovery(host.discoveryHost, scene, host.session().ai)
        return { scene }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a Discovery scene (`discovery.stage`). */
    stageDiscovery(scene: DiscoveryScene) {
      stageDiscovery(host.discoveryHost, scene, host.session().ai)
    },
    /** Boards up a portal at a given wear (0..1 of nominal hit points). */
    boardUp(id: string, planks: number, wear: number) {
      boardUp(host.session().view, host.session().ai, id, planks, wear)
    },
  }),
  harnessState: (host) => ({
    discovery: {
      shown: Object.fromEntries(host.discoveryHost.props.shown),
      barricades: Object.fromEntries(host.discoveryHost.props.barricades.looks),
    },
  }),
})
