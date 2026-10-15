import type { LabControl } from "@arcade/kit/lab-panel"
import {
  DEFAULT_PROGRESSION_TUNING,
  outbreakProgressionSharedFeature,
  progressionControls,
  RECIPES,
} from "../../shared/progression/index"
import type { SessionView } from "../../shared/session"
import { registerOutbreakClientFeature } from "../feature-registry"
import type { InventoryHud } from "../inventory-hud"

export { DEFAULT_PROGRESSION_TUNING, outbreakProgressionSharedFeature }
export * from "../../shared/progression/index"

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

export const outbreakProgressionFeature = registerOutbreakClientFeature({
  id: "progression",
  order: 20,
  settingsGroup: {
    subsystem: "progression",
    defaults: DEFAULT_PROGRESSION_TUNING,
  },
  labControls: (host) => (host.progressionHost ? progressionLabControls(host.progressionHost) : []),
  onSettingChanged: (host, rawKey, routed) =>
    host.progressionHost
      ? applyProgressionSetting(host.progressionHost, routed?.field ?? rawKey, host.settings.progression)
      : false,
  gameCommands: (host) => [
    {
      id: "progression.stage",
      label: "Stage an Inventory or Workbench Scene",
      shortLabel: "Progression Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${PROGRESSION_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "bench") as ProgressionScene
        if (!PROGRESSION_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        stageProgression(host.progressionHost, scene)
        return { scene }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Sets loaded rounds and, optionally, belt counts (`{ ammo: 4, plank: 3 }`) through the progression ledger. */
    stock(loaded?: number, belt: Record<string, number> = {}) {
      const session = host.session()
      const { progression, actorId } = session.view
      const ledger = progression.ledger
      if (loaded !== undefined) ledger.apply({ kind: "setCharge", actor: actorId, item: "pistol", charge: loaded })
      for (const [item, n] of Object.entries(belt)) {
        const have = ledger.count(`${actorId}/belt`, item)
        if (have) ledger.apply({ kind: "drain", store: `${actorId}/belt`, item, count: have })
        if (n) ledger.apply({ kind: "grant", actor: actorId, item, count: n })
      }
      const slot = session.sim.slot(actorId)
      if (slot) progression.project(slot)
    },
    /** Stages a Lab scene (`progression.stage`): search, strip, bench, dark-bench, generator, field-craft, handoff. */
    stageProgression(scene: ProgressionScene) {
      stageProgression(host.progressionHost, scene)
    },
    /** The inventory HUD (pack, field craft, prompts), for proofs. */
    inventoryHud() {
      return host.progressionHost.hud
    },
    /** Gives the local survivor an item, routed to belt, hand or pack. */
    give(item: string, count = 1) {
      const session = host.session()
      return session.view.progression.ledger.apply({ kind: "grant", actor: session.view.actorId, item, count }).ok
    },
  }),
  netSession: {
    onApplyWorld: (net, s) => {
      const progression = net.sim.progression
      if (progression.pings.length || s.pings.length) {
        progression.pings.splice(
          0,
          progression.pings.length,
          ...s.pings.map((p) => ({ id: p.id, by: p.by, x: p.x, y: p.y, label: p.label, until: s.time + p.left })),
        )
      }
      if (progression.lures.length || s.lures.length) {
        progression.lures.splice(
          0,
          progression.lures.length,
          ...s.lures.map((l) => ({ id: l.id, x: l.x, y: l.y, until: s.time + l.left, next: Infinity })),
        )
      }
    },
  },
})
