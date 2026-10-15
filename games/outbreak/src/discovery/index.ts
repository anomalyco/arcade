import { registerOutbreakClientFeature } from "../feature-registry"
import { DEFAULT_DISCOVERY_SETTINGS, discoveryControls } from "./settings"
import { boardUp, DISCOVERY_SCENES, stageDiscovery, type DiscoveryScene } from "./stage"

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
      reinforced: [...host.discoveryHost.props.barricades.reinforced],
      glance: host.discoveryHost.glance.showing,
      pages: host.session().view.progression.knowledge.pages.map((p) => ({ ...p, unread: host.session().view.progression.ledger.count(p.id, "page") })),
      practice: { ...host.session().view.progression.knowledge.mastery },
      verbs: { ...host.discoveryHost.props.verbs.shown, hidden: host.discoveryHost.closet?.hidden ?? false, crouching: Boolean(host.session().view.player.crouching) },
      vignettes: { ...host.discoveryHost.props.vignettes.shown, scenes: [...host.discoveryHost.props.vignettes.shown.scenes] },
    },
  }),
})
