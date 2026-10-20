import type { LabControl } from "@arcade/kit/lab-panel"
import type { LabCommand } from "@arcade/kit/lab/commands"
import type { OutbreakSim } from "../../shared/sim-types"
import { DEFAULT_SPECIALS_TUNING, SPECIAL_KIND_IDS, SPECIAL_RULES, specialKindFromId, specialsControls } from "../../shared/specials/kinds"
import { spawnSpecial, specialCounts, specialsOf } from "../../shared/specials/specials"
import { supportHeight } from "../../shared/terrain"
import { registerOutbreakClientFeature } from "../feature-registry"
import { GasClouds } from "./gas"

type SessionLike = { sim: OutbreakSim; view: { player: { x: number; y: number; aim: number } } }

const gas = new GasClouds()

/** Spawns a special `distance` metres ahead of the survivor (offline sessions only). */
function spawnAhead(session: SessionLike, kindId: string, distance = 5) {
  const kind = specialKindFromId(kindId)
  if (kind === 0) return { error: `unknown kind "${kindId}" (${SPECIAL_KIND_IDS.join(", ")})` }
  const p = session.view.player
  const x = p.x + Math.cos(p.aim) * distance
  const y = p.y + Math.sin(p.aim) * distance
  const a = spawnSpecial(session.sim, kind, x, y, p.aim + Math.PI)
  if (!a) return { error: "no free Lab zombie id" }
  return { kind: kindId, id: a.id, x: a.x, y: a.y, hp: a.hp }
}

function summary(sim: OutbreakSim) {
  const st = specialsOf(sim)
  const counts = specialCounts(sim)
  const alive: Record<string, number> = {}
  for (const rule of SPECIAL_RULES) alive[rule.id] = counts[rule.kind] ?? 0
  return { alive, night: st.night, shrieks: st.shrieks, bursts: st.bursts, clouds: st.clouds.length }
}

/** Special zombies (shared/specials): Lab › Specials (rarity, stats, spawn buttons) and `arcade cmd specials.spawn`. */
export const outbreakSpecialsFeature = registerOutbreakClientFeature({
  id: "specials",
  order: 17,
  netSession: {
    onApplyWorld: (net, shared) => {
      specialsOf(net.sim).clouds = (shared.specials?.clouds ?? []).map((c) => ({ ...c }))
      return false
    },
  },
  settingsGroup: { subsystem: "specials", defaults: DEFAULT_SPECIALS_TUNING },
  labControls: (host): LabControl[] => [
    ...(specialsControls as readonly LabControl[]),
    ...SPECIAL_RULES.map(
      (rule): LabControl => ({
        key: `spawnSpecial.${rule.id}`,
        label: `Spawn ${rule.label} ahead`,
        group: "Specials",
        type: "action",
        run: () => {
          if (!host.progressionHost.offline()) return
          spawnAhead(host.session(), rule.id)
        },
      }),
    ),
  ],
  gameCommands: (host): LabCommand[] => [
    {
      id: "specials.spawn",
      label: "Spawn Special Zombie",
      shortLabel: "Special",
      category: "Scene",
      undoable: false,
      args: {
        kind: { type: "string", description: `Kind (${SPECIAL_KIND_IDS.join(", ")})` },
        distance: { type: "number", description: "Metres ahead of the survivor (default 5)" },
      },
      enabled: () => !host.coop.net,
      run: async (_ctx, args) => {
        const out = spawnAhead(host.session(), String(args?.kind ?? "brute"), Number(args?.distance ?? 5))
        await host.harness().step(1 / 60)
        return out
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Spawns a special (`runner`, `brute`, `screamer`, `bloater`, `riot`, `lurker`) `distance` m ahead. */
    spawnSpecial(kind: string, distance = 5) {
      return spawnAhead(host.session(), kind, distance)
    },
  }),
  harnessState: (host) => ({ specials: { ...summary(host.session().sim), gasDrawn: gas.clouds.length } }),
  feel: {
    reset: () => gas.reset(),
    processFrame: ({ session, addSprites, addCount }) => {
      const { town, time } = session.view
      gas.sync(specialsOf(session.sim).clouds, time)
      return gas.draw(addSprites, addCount, time, (x, y) => supportHeight(town, x, y))
    },
  },
})
