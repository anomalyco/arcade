import type { LabControl } from "@arcade/kit/lab-panel"
import type { LabCommand } from "@arcade/kit/lab/commands"
import { CALLING_IDS, callingIndex } from "../../shared/characters/callings"
import type { CharactersState } from "../../shared/characters/habits"
import { registerOutbreakClientFeature } from "../feature-registry"
import { characterControls, DEFAULT_CHARACTER_SETTINGS } from "./settings"
import { CHARACTER_SCENES, stageCharacters, type CharacterScene } from "./stage"

function summary(sim: { ai: { agents: readonly { id: number; seed: number; state: string }[] }; getFeatureState<T>(id: string): T | undefined }) {
  const st = sim.getFeatureState<CharactersState>("characters")
  const callings: Record<string, number> = {}
  for (const a of sim.ai.agents) {
    if (a.state === "dead") continue
    const id = CALLING_IDS[callingIndex(a.seed, a.id)]!
    callings[id] = (callings[id] ?? 0) + 1
  }
  return {
    callings,
    habits: st ? Object.fromEntries(Object.entries(st.live).map(([id, rt]) => [id, rt.key])) : {},
    sites: st?.sites.length ?? 0,
    used: st ? Object.keys(st.used).length : 0,
  }
}

/**
 * Characters (AR-88), client half: Lab › Characters (Today one setting away, a toggle per idea, staging buttons), the
 * `characters.stage` command and harness telemetry. The crowd renderer draws them (`src/zombies.ts`) from the frame
 * `characterFrame` builds; the rules live in `shared/characters/`.
 */
export const outbreakCharactersFeature = registerOutbreakClientFeature({
  id: "characters",
  order: 18,
  settingsGroup: { subsystem: "characters", defaults: DEFAULT_CHARACTER_SETTINGS },
  labControls: (host): LabControl[] => [
    ...characterControls,
    ...CHARACTER_SCENES.map(
      (scene): LabControl => ({
        key: `stageCharacters.${scene}`,
        label: `Stage: ${scene === "callings" ? "every calling" : scene}`,
        group: "Characters",
        type: "action",
        run: () => {
          if (!host.progressionHost.offline()) return
          stageCharacters(host.discoveryHost, host.session(), scene)
        },
      }),
    ),
  ],
  gameCommands: (host): LabCommand[] => [
    {
      id: "characters.stage",
      label: "Stage Characters",
      shortLabel: "Characters",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${CHARACTER_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: async (_ctx, args) => {
        const scene = String(args?.scene ?? "callings") as CharacterScene
        if (!CHARACTER_SCENES.includes(scene)) return { error: `unknown scene "${scene}" (${CHARACTER_SCENES.join(", ")})` }
        const out = stageCharacters(host.discoveryHost, host.session(), scene)
        await host.harness().step(1 / 60)
        return out
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a characters scene (`callings`, `knock`, `stove`, `bed`, `fence`, `wedding`, `leash`). */
    stageCharacters(scene: CharacterScene) {
      return stageCharacters(host.discoveryHost, host.session(), scene)
    },
  }),
  harnessState: (host) => ({ characters: summary(host.session().sim) }),
})
