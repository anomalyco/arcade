import type { OutbreakAISubsystem } from "../../shared/ai"
import type { CoopSim } from "../../shared/coop-sim"
import type { SessionView } from "../../shared/session"
import type { InteractionsState } from "../../shared/interactions/index"
import { setDown } from "../../shared/interactions/drag"
import { FURNITURE_KINDS, furnStoreId, type FurnitureKind } from "../../shared/interactions/furniture"
import type { DiscoveryHost } from "../discovery/stage"

/** Staged scenes for the `outbreak-interactions` Lab station, the `interactions.stage` command and the clip. */
export const INTERACTION_SCENES = ["baseball", "can", "bottle", "brick", "drag", "brace"] as const
export type InteractionScene = (typeof INTERACTION_SCENES)[number]

type StageSession = { sim: CoopSim; ai: OutbreakAISubsystem }

/** Puts Ash's first loose piece as a `kind` at `(x, y)` (unbraced, standing), clearing any drag or brace. */
function loosePiece(sim: CoopSim, kind: FurnitureKind, x: number, y: number, yaw = 0) {
  const ledger = sim.progression.ledger
  const state = sim.getFeatureState<InteractionsState>("interactions")!
  let st = ledger.store(furnStoreId("ash", 0))
  if (!st) st = ledger.createStore({ id: furnStoreId("ash", 0), mode: "counters", scope: "shared", at: { x, y }, initial: {} })
  if (!state.drag.pieces.includes(st.id)) state.drag.pieces.push(st.id)
  delete state.drag.braced[st.id]
  st.at = { x, y }
  st.owner = undefined
  st.counts = { k: FURNITURE_KINDS.indexOf(kind), yaw: Math.round(yaw * 100) }
  st.rev = ++ledger.rev
  return st
}

function inHand(view: SessionView, item: string, count: number): void {
  const ledger = view.progression.ledger
  const have = ledger.count(view.actorId, item)
  if (have < count) ledger.apply({ kind: "grant", actor: view.actorId, item, count: count - have })
  const slot = view.progression.hotbar(view.actorId)?.slots.findIndex((s) => s?.item === item) ?? -1
  if (slot >= 0) ledger.apply({ kind: "select", actor: view.actorId, slot })
}

/**
 * - `baseball`: dusk on the street south of Ash's house, three baseballs in hand and three of the dead shambling up
 *   the road six to nine metres off. A quick throw bonks the nearest down.
 * - `can`: night, tin cans in hand and five of the dead in a knot ahead; a long lob over them lands behind and they
 *   turn to the clatter.
 * - `bottle`: the same knot with bottles: they shatter where they land.
 * - `brick`: four metres off one of Ash's shut windows, facing it, a brick in hand.
 * - `drag`: night inside Ash's house, a loose dresser between the survivor and the front door, four of the dead in
 *   the street. E takes hold of it; walk it to the door and E braces it.
 * - `brace`: the dresser already braced against the front door and the dead outside coming for it: they bash it
 *   until it is shoved over.
 */
export function stageInteraction(host: DiscoveryHost, session: StageSession, scene: InteractionScene): { x: number; y: number } {
  const view = host.view()
  const { sim, ai } = session
  const ledger = view.progression.ledger
  for (const st of [...ledger.stores.values()]) if (st.id.startsWith("toss:") || st.id.startsWith("drop:t:")) ledger.deleteStore(st.id)
  for (const z of ai.agents) z.state = "dead"
  const ash = view.town.buildings.find((b) => b.id === "ash")!
  const street = ash.rect[3] + 7
  const x = (ash.rect[0] + ash.rect[2]) / 2
  if (scene === "brick") {
    host.setHour(17.5)
    const w = view.town.windows.filter((o) => o.buildingId === "ash" && !o.boarded).sort((a, b) => b.rect[3] - a.rect[3])[0]!
    w.open = false
    sim.rebuildSolids()
    const cx = (w.rect[0] + w.rect[2]) / 2
    const cy = w.rect[3] + 4
    inHand(view, "brick", 2)
    host.pose(cx, cy, -Math.PI / 2)
    return { x: cx, y: cy }
  }
  if (scene === "drag" || scene === "brace") {
    host.setHour(22)
    const door = view.town.doors.find((d) => d.id === "ash-front")!
    door.open = false
    sim.rebuildSolids()
    const cx = (door.rect[0] + door.rect[2]) / 2
    const inside = door.rect[1] - 1
    for (let i = 0; i < 4; i++) ai.spawnZombie(view.town, cx - 2 + i * 1.3, door.rect[3] + 5 + (i % 2), scene === "brace" ? "chase" : "wander")
    const st = loosePiece(sim, "dresser", cx, inside - 0.8)
    if (scene === "brace") {
      const me = sim.slots[0]!
      Object.assign(me.survivor, { x: cx, y: inside - 1.6, aim: Math.PI / 2 })
      st.counts.drag = 1
      st.owner = me.id
      st.at = { x: cx, y: door.rect[1] - 0.6 }
      const state = sim.getFeatureState<InteractionsState>("interactions")!
      setDown(sim, state.drag, me, st, state.tuning)
      host.pose(cx - 0.6, inside - 2.2, Math.PI / 2)
      return { x: cx, y: inside - 2.2 }
    }
    host.pose(cx, inside - 2.1, Math.PI / 2)
    return { x: cx, y: inside - 2.1 }
  }
  host.setHour(scene === "baseball" ? 18.6 : 22)
  if (scene === "baseball") {
    for (let i = 0; i < 3; i++) ai.spawnZombie(view.town, x + 6 + i * 1.5, street + (i - 1) * 1.2, "wander")
    inHand(view, "baseball", 3)
  } else {
    for (let i = 0; i < 5; i++) ai.spawnZombie(view.town, x + 7 + (i % 3) * 1.1, street - 1 + Math.floor(i / 3) * 1.6, "wander")
    inHand(view, scene === "can" ? "tin-can" : "bottle", 3)
  }
  host.pose(x, street, 0)
  return { x, y: street }
}
