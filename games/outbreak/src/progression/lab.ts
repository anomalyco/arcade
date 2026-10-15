import type { LabControl } from "@arcade/kit/lab-panel"
import { RECIPES } from "../../shared/progression/catalog"
import { DEFAULT_PROGRESSION_TUNING, progressionControls } from "../../shared/progression/tuning"
import type { SessionView } from "../../shared/session"
import type { InventoryHud } from "../inventory-hud"

export type ProgressionLabHost = {
  view: () => SessionView
  /** Moves the survivor and the camera, as the harness `pose` does. */
  pose: (x: number, y: number, aim: number) => void
  setHour: (hour: number) => void
  hud: InventoryHud
  /** Is this an offline session (Lab tuning stays local in co-op)? */
  offline: () => boolean
}

/** Staged scenes for the Lab station and proofs. */
export const PROGRESSION_SCENES = [
  "search",
  "strip",
  "bench",
  "dark-bench",
  "generator",
  "field-craft",
  "handoff",
] as const
export type ProgressionScene = (typeof PROGRESSION_SCENES)[number]

const KIT: readonly [string, number][] = [
  ["scrap", 6],
  ["chem", 3],
  ["plank", 3],
  ["battery", 1],
  ["toolbox", 1],
]

function give(view: SessionView, items: readonly (readonly [string, number])[]): void {
  for (const [item, count] of items) view.progression.ledger.apply({ kind: "grant", actor: view.actorId, item, count })
}

function learnAll(view: SessionView): void {
  for (const r of RECIPES)
    view.progression.ledger.apply({ kind: "grant", actor: view.actorId, item: `learned:${r.id}`, store: "team/known" })
}

/** Sets a container's contents and whether it has been searched. */
function stock(view: SessionView, id: string, items: readonly (readonly [string, number])[], revealed: boolean): void {
  const ledger = view.progression.ledger
  const st = ledger.store(id)!
  st.slots.fill(null)
  items.forEach(([item, count], i) => (st.slots[i] = { item, count }))
  st.revealed = revealed
  st.rev = ++ledger.rev
}

/** Puts the offline session into one of the staged scenes. */
export function stageProgression(host: ProgressionLabHost, scene: ProgressionScene): void {
  const view = host.view()
  const progression = view.progression
  host.hud.close()
  const dresser = view.containers.find((c) => c.kind === "dresser" && c.buildingId === "ash")!
  const bench = progression.benches.find((b) => b.id === "bench:ash")!
  const atBench = () => host.pose(bench.bench.x - 0.85, bench.bench.y, 0)
  switch (scene) {
    case "search":
    case "strip":
      host.setHour(15)
      stock(view, dresser.id, [["ammo", 6], ["medkit", 1], ["scrap", 2]], scene === "strip")
      host.pose(dresser.x, dresser.y + 0.75, -Math.PI / 2)
      return
    case "bench":
      host.setHour(15)
      give(view, KIT)
      atBench()
      return
    case "dark-bench":
      host.setHour(23)
      give(view, KIT)
      view.player.flashlightOn = false
      atBench()
      return
    case "generator":
      host.setHour(23)
      give(view, KIT)
      progression.ledger.apply({ kind: "grant", actor: view.actorId, item: "car-battery", store: bench.id })
      atBench()
      return
    case "field-craft":
      host.setHour(22)
      learnAll(view)
      give(view, [["chem", 2], ["scrap", 3], ["battery", 1], ["plank", 1]])
      host.pose(44, 44, 0)
      if (!host.hud.craftOpen) host.hud.toggleCraft()
      return
    case "handoff":
      host.setHour(19)
      host.pose(44, 44, 0)
      give(view, [["medkit", 1], ["ammo", 6]])
      progression.ledger.apply({ kind: "drop", actor: view.actorId, at: { x: 44.7, y: 44.2 }, items: { medkit: 1 } })
      progression.ledger.apply({
        kind: "drop",
        actor: view.actorId,
        at: { x: 44.2, y: 44.8 },
        items: { ammo: 6, plank: 2 },
      })
      progression.pings.push({ id: 1e6, by: 1, x: 47, y: 42.5, label: "Zombie", until: view.time + 6 })
      progression.lures.push({ id: 1e6, x: 49, y: 45, until: view.time + 8, next: view.time + 1 })
  }
}

/** Lab rows: every progression tunable plus actions that set up what you are tuning. */
export function progressionLabControls(host: ProgressionLabHost): LabControl[] {
  const view = host.view
  const action = (key: string, label: string, run: () => void): LabControl => ({
    key,
    label,
    group: "Progression",
    type: "action",
    run,
  })
  return [
    ...progressionControls.map((c) => ({ ...c })),
    action("progressionGiveKit", "Give bench materials", () => give(view(), KIT)),
    action("progressionLearnAll", "Learn every recipe", () => learnAll(view())),
    action("progressionRestock", "Restock unsearched containers", () => view().progression.restock()),
    action("progressionStageBench", "Go to the Ash workbench", () => stageProgression(host, "bench")),
  ]
}

/** Applies a changed Lab key to the offline session's progression. Returns whether it was a progression key. */
export function applyProgressionSetting(host: ProgressionLabHost, key: string, settings: object): boolean {
  if (!(key in DEFAULT_PROGRESSION_TUNING)) return false
  if (host.offline()) host.view().progression.setTuning(settings)
  return true
}
