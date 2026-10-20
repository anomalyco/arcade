import type { OutbreakAISubsystem } from "../../shared/ai"
import { FIRE_ITEMS, ringId, BURN_RING, CRACK_RING, DYN_RING, FIRE_RING, SCORCH_RING, TRAP_RING, TREE_RING } from "../../shared/fire/fire"
import { DEFAULT_FLARE_TUNING } from "../../shared/flares/flares"
import {
  fireFlareGun,
  ignite,
  placeFire,
  placeScorch,
  setBearTrap,
  throwDynamite,
  throwFirecrackers,
  throwMolotov,
  type FireState,
} from "../../shared/fire/runtime"
import type { SessionView } from "../../shared/session"
import type { OutbreakSim } from "../../shared/sim-types"
import type { DiscoveryHost } from "../discovery/stage"

/**
 * - `armory`: dusk on the street south of Ash's house, one of every fire & explosives item (and two gas cans) laid on
 *   the road in a row, and one of each in the pack.
 * - `flamethrower`: night, the flamethrower in hand and eight of the dead coming up the road.
 * - `burning`: the same, four of them already alight, a patch of fire on the road and scorch marks.
 * - `dynamite` / `dynamite-lit`: night, dynamite in hand and the dead in a knot down the road (`-lit` throws one).
 * - `firecrackers`: a string thrown up the road, popping, the dead turning to it.
 * - `molotov`: a molotov thrown into the dead.
 * - `flare-gun`: a flare fired up the road past the dead.
 * - `bear-trap`: a trap set just ahead with one of the dead walking into it.
 * - `tree`: night, the survivor six metres from the nearest tree, a molotov's fire at its trunk catching it, three of
 *   the dead about it.
 */
export const FIRE_SCENES = [
  "armory",
  "flamethrower",
  "burning",
  "dynamite",
  "dynamite-lit",
  "firecrackers",
  "molotov",
  "flare-gun",
  "bear-trap",
  "tree",
] as const
export type FireScene = (typeof FIRE_SCENES)[number]

export type FireStageSession = { sim: OutbreakSim; ai: OutbreakAISubsystem }

/** Every item the Lab can hand out: the six fire items plus gas cans and the flamethrower's pressure tank. */
export const FIRE_GIVE_ITEMS = [...FIRE_ITEMS, "fuel", "pressure-tank", "bottle"] as const

/** Gives `count` of `item` to the local survivor and puts it in hand when it can be held. */
export function giveFire(view: SessionView, item: string, count = 1): void {
  const ledger = view.progression.ledger
  ledger.apply({ kind: "grant", actor: view.actorId, item, count })
  select(view, item)
}

function select(view: SessionView, item: string): void {
  const slot = view.progression.hotbar(view.actorId)?.slots.findIndex((s) => s?.item === item) ?? -1
  if (slot >= 0) view.progression.ledger.apply({ kind: "select", actor: view.actorId, slot })
}

/** Puts out every fire, fuse, trap and scorch mark (ring stores stay, emptied). */
function clearFire(view: SessionView): void {
  const ledger = view.progression.ledger
  for (const [prefix, size] of [["fire", FIRE_RING], ["burn", BURN_RING], ["scorch", SCORCH_RING], ["dyn", DYN_RING], ["crack", CRACK_RING], ["trap", TRAP_RING], ["tree", TREE_RING]] as const) {
    for (let k = 0; k < size; k++) {
      const st = ledger.store(ringId(prefix, k))
      if (!st) continue
      for (const key of Object.keys(st.counts)) delete st.counts[key]
      st.rev = ++ledger.rev
    }
  }
}

/** Stages a scene on the road south of Ash's house; returns where the survivor stands. */
export function stageFire(host: DiscoveryHost, session: FireStageSession, scene: FireScene): { x: number; y: number } {
  const view = host.view()
  const { sim, ai } = session
  const ledger = view.progression.ledger
  clearFire(view)
  for (const z of ai.agents) z.state = "dead"
  const ash = view.town.buildings.find((b) => b.id === "ash")!
  const street = ash.rect[3] + 7
  const x = (ash.rect[0] + ash.rect[2]) / 2
  host.setHour(scene === "armory" ? 19.5 : 22)
  if (scene === "tree") return stageTree(host, session, x, street)
  host.pose(x, street, 0)
  const me = sim.slots[0]!
  const state = sim.getFeatureState<FireState>("fire")
  const t = state!.tuning
  const horde = (n: number, from: number) => {
    const out = []
    for (let i = 0; i < n; i++) out.push(ai.spawnZombie(view.town, x + from + (i % 4) * 1.3, street - 1.8 + Math.floor(i / 4) * 1.8, "wander"))
    return out
  }
  switch (scene) {
    case "armory": {
      FIRE_ITEMS.forEach((item, i) => {
        if (ledger.count(view.actorId, item) < 1) ledger.apply({ kind: "grant", actor: view.actorId, item, count: 1 })
        ledger.apply({ kind: "drop", actor: view.actorId, at: { x: x + 2 + i * 1.1, y: street + 1.4 }, items: { [item]: 1 } })
        ledger.apply({ kind: "grant", actor: view.actorId, item, count: 1 })
      })
      ledger.apply({ kind: "grant", actor: view.actorId, item: "fuel", count: 2 })
      ledger.apply({ kind: "drop", actor: view.actorId, at: { x: x + 2 + FIRE_ITEMS.length * 1.1, y: street + 1.4 }, items: { fuel: 1 } })
      select(view, "flamethrower")
      break
    }
    case "flamethrower":
    case "burning": {
      giveFire(view, "fuel", 2)
      giveFire(view, "flamethrower", ledger.count(view.actorId, "flamethrower") ? 0 : 1)
      const dead = horde(8, 7)
      if (scene === "burning") {
        for (const z of dead.slice(0, 4)) ignite(sim, z, me.id, t)
        placeFire(sim, x + 4, street + 0.6, 1.4, 30, 0, me.id)
        placeScorch(sim, x + 3, street - 1, 1.2)
        placeScorch(sim, x + 5.5, street + 1.5, 0.9)
      }
      break
    }
    case "dynamite":
    case "dynamite-lit":
      horde(8, 9)
      giveFire(view, "dynamite", 2)
      if (scene === "dynamite-lit") throwDynamite(sim, me, { ...t, dynThrow: 9 })
      break
    case "firecrackers":
      horde(6, 14)
      giveFire(view, "firecrackers", 2)
      throwFirecrackers(sim, me, t)
      break
    case "molotov":
      horde(6, 8)
      giveFire(view, "molotov", 2)
      throwMolotov(sim, me, { ...t, molotovThrow: 9 })
      break
    case "flare-gun":
      horde(6, 12)
      giveFire(view, "flare-gun", ledger.count(view.actorId, "flare-gun") ? 0 : 1)
      fireFlareGun(sim, me, t, DEFAULT_FLARE_TUNING)
      break
    case "bear-trap": {
      giveFire(view, "bear-trap", 2)
      setBearTrap(sim, me)
      const z = ai.spawnZombie(view.town, x + 6, street, "wander")
      z.state = "chase"
      break
    }
  }
  return { x, y: street }
}

/** The `tree` scene: the tree nearest the road south of Ash's house, alight at its trunk, the survivor watching. */
function stageTree(host: DiscoveryHost, session: FireStageSession, x: number, street: number): { x: number; y: number } {
  const view = host.view()
  let tree = view.town.props.find((p) => p.kind === "tree")
  let best = Infinity
  for (const p of view.town.props) {
    if (p.kind !== "tree") continue
    const d = Math.hypot(p.x - x, p.y - street)
    if (d < best) {
      best = d
      tree = p
    }
  }
  if (!tree) {
    host.pose(x, street, 0)
    return { x, y: street }
  }
  const px = tree.x - 6
  const py = tree.y + 1.5
  host.pose(px, py, Math.atan2(tree.y - py, tree.x - px))
  const me = session.sim.slots[0]!
  placeFire(session.sim, tree.x + 0.7, tree.y, 0.8, 3, 1, me.id)
  for (let i = 0; i < 3; i++) session.ai.spawnZombie(view.town, tree.x + 2.5 + i * 1.2, tree.y - 1.5 + i * 1.4, "wander")
  return { x: px, y: py }
}
