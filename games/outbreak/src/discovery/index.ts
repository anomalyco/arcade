import type { OutbreakAISubsystem } from "../../shared/ai"
import { ideaToken, matStoreId, pinStoreId, triedToken } from "../../shared/discovery/tinker"
import type { SessionView } from "../../shared/session"
import { registerOutbreakClientFeature } from "../feature-registry"
import type { ProgressionLabHost } from "../progression/index"
import type { DiscoveryProps } from "./props"
import { DEFAULT_DISCOVERY_SETTINGS, discoveryControls } from "./settings"

export { DEFAULT_DISCOVERY_SETTINGS, discoveryControls, type DiscoverySettings } from "./settings"
export { DiscoveryProps } from "./props"
export { BenchLean } from "./lean"

/** What the Discovery Lab scenes need: the progression host (view, pose, clock, inventory HUD) and the world props. */
export type DiscoveryHost = ProgressionLabHost & { props: DiscoveryProps }

/** Staged scenes for the `outbreak-discovery` Lab station and proofs. */
export const DISCOVERY_SCENES = ["low-flashlight", "weakened-barricade", "open-containers", "drops", "bench-tinker", "corkboard", "dark-bench"] as const
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

/** Gives the survivor `items` and stands them at the Ash workbench, facing it. */
function atBench(host: DiscoveryHost, hour: number, items: readonly (readonly [string, number])[]): string {
  const view = host.view()
  const ledger = view.progression.ledger
  const bench = view.progression.benches.find((b) => b.id === "bench:ash")!
  host.setHour(hour)
  for (const [item, count] of items) ledger.apply({ kind: "grant", actor: view.actorId, item, count })
  host.pose(bench.bench.x - 0.85, bench.bench.y + 0.25, 0)
  return bench.id
}

/** Pins `recipe` to the corkboard as if the survivor in `seat` had made it. Lab staging only. */
function pin(view: SessionView, recipe: string, seat: number): void {
  const ledger = view.progression.ledger
  const bench = view.progression.benches.find((b) => b.id === "bench:ash")!
  if (!view.progression.learned(recipe)) ledger.apply({ kind: "grant", actor: view.actorId, item: `learned:${recipe}`, store: "team/known" })
  if (ledger.store(pinStoreId(recipe))) ledger.deleteStore(pinStoreId(recipe))
  ledger.createStore({ id: pinStoreId(recipe), mode: "counters", scope: "shared", owner: `seat${seat}`, at: { x: bench.bench.x, y: bench.bench.y }, initial: { seat: seat + 1 } })
}

export function stageDiscovery(host: DiscoveryHost, scene: DiscoveryScene, ai: OutbreakAISubsystem): void {
  const view = host.view()
  host.hud.close()
  const ash = view.town.buildings.find((b) => b.id === "ash")!
  const ledger = view.progression.ledger
  switch (scene) {
    case "bench-tinker": {
      // Daylight, a handful of materials, and plank + scrap already laid on the mat: hold E to try them.
      const bench = atBench(host, 15, [["plank", 1], ["scrap", 3], ["chem", 2], ["battery", 1]])
      view.player.flashlightOn = false
      ledger.apply({ kind: "deposit", actor: view.actorId, to: matStoreId(bench), items: { plank: 1, scrap: 1 } })
      return
    }
    case "corkboard": {
      // A few days in: three sketches by three players, an idea waiting on the toolbox, two crossed-out tries, and
      // a fresh spiked board on the mat.
      const bench = atBench(host, 15, [["scrap", 2], ["chem", 1]])
      view.player.flashlightOn = false
      pin(view, "bandage", 0)
      pin(view, "spiked-board", 1)
      pin(view, "lure", 2)
      for (const token of [ideaToken("battery"), triedToken("plank+plank"), triedToken("plank+chem")]) {
        if (!ledger.count("team/known", token)) ledger.apply({ kind: "grant", actor: view.actorId, item: token, store: "team/known" })
      }
      if (!view.progression.mat(bench).length) ledger.apply({ kind: "grant", actor: view.actorId, item: "spiked-board", store: matStoreId(bench) })
      return
    }
    case "dark-bench": {
      // Night with the flashlight off: too dark to try the pair on the mat until a beam is on it.
      const bench = atBench(host, 23, [["chem", 2]])
      view.player.flashlightOn = false
      ledger.apply({ kind: "deposit", actor: view.actorId, to: matStoreId(bench), items: { chem: 2 } })
      return
    }
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
      host.setHour(13)
      view.player.flashlightOn = false
      const win = view.town.windows.find((w) => w.id === "ash-south-west")!
      const door = view.town.doors.find((d) => d.id === "ash-front")!
      boardUp(view, ai, win.id, 3, 0.5)
      boardUp(view, ai, door.id, 2, 1)
      // From inside, where the defenders watch the boards give.
      host.pose((win.rect[0] + win.rect[2]) / 2 + 0.9, win.rect[1] - 2.6, Math.PI / 2 + 0.35)
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
      host.pose(dresser.x + 0.85, dresser.y + 0.95, Math.atan2(-0.95, -1.2))
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
      bench: Object.fromEntries(host.discoveryHost.props.bench.shown),
    },
  }),
})
