import type { OutbreakAISubsystem } from "../../shared/ai"
import type { CoopSim } from "../../shared/coop-sim"
import type { SessionView } from "../../shared/session"
import type { InteractionsState } from "../../shared/interactions/index"
import { setDown } from "../../shared/interactions/drag"
import { FURNITURE_KINDS, furnKind, furnStoreId, type FurnitureKind } from "../../shared/interactions/furniture"
import type { DiscoveryHost } from "../discovery/stage"
import type { BreachState } from "../../shared/breach/rules"
import { THROWABLES } from "../../shared/interactions/throwables"
import { DEFAULT_DEATH_TUNING } from "../../shared/death/rules"
import { forceLife } from "../../shared/death/runtime"

/** Staged scenes for the `outbreak-interactions` Lab station, the `interactions.stage` command and the clip. */
export const INTERACTION_SCENES = ["baseball", "can", "bottle", "brick", "drag", "brace", "board", "pry"] as const
export type InteractionScene = (typeof INTERACTION_SCENES)[number]

type StageSession = { sim: CoopSim; ai: OutbreakAISubsystem }

const THROWN = Object.keys(THROWABLES)

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

/** Takes every throwable off the survivor, so the next scene's item has a hotbar slot. */
function emptyHands(view: SessionView): void {
  const ledger = view.progression.ledger
  for (const st of [...ledger.stores.values()]) {
    if (!st.id.startsWith(`${view.actorId}/`)) continue
    for (const item of THROWN) {
      const n = ledger.count(st.id, item)
      if (n > 0) ledger.apply({ kind: "drain", store: st.id, item, count: n })
    }
  }
}

/** Hangs Ash's front door back up if the dead tore it off in an earlier scene (`shared/breach`). */
function mendDoor(sim: CoopSim, id: string): void {
  const breach = sim.getFeatureState<BreachState>("breach")
  if (breach) delete breach.portals[id]
  const st = sim.ai.portalStates.get(id)
  if (st) st.integrity = 100
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
 * - `board`: night inside Ash's front door, bare, three planks in the belt and the dead in the street. One B nails all
 *   three.
 * - `pry`: morning inside the same door with three boards on it. Hold E: one comes off and goes back in the belt.
 */
export function stageInteraction(host: DiscoveryHost, session: StageSession, scene: InteractionScene): { x: number; y: number } {
  const view = host.view()
  const { sim, ai } = session
  const ledger = view.progression.ledger
  for (const st of [...ledger.stores.values()]) if (st.id.startsWith("toss:") || st.id.startsWith("drop:t:")) ledger.deleteStore(st.id)
  for (const z of ai.agents) z.state = "dead"
  // Every scene starts on its feet at full health, whatever the last one did to the survivor.
  const me = sim.slot(view.actorId)
  if (me) {
    forceLife(sim, me, "alive", DEFAULT_DEATH_TUNING)
    me.survivor.health = me.survivor.maxHealth
    sim.progression.ledger.cancel(me.id)
    // A light on in the dark is what the dead see first; the lures want them looking at the throw.
    me.survivor.flashlightOn = scene !== "can" && scene !== "bottle"
  }
  emptyHands(view)
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
  if (scene === "board" || scene === "pry") {
    host.setHour(scene === "board" ? 21.5 : 7.5)
    const door = view.town.doors.find((d) => d.id === "ash-front")!
    mendDoor(sim, door.id)
    door.open = false
    while (ai.getBarricadePlanks(door.id) > 0) ai.removeBarricadePlank(door.id)
    if (scene === "pry") for (let i = 0; i < 3; i++) ai.addBarricadePlank(door.id)
    ai.rebuildTopology(view.town)
    sim.rebuildSolids()
    const cx = (door.rect[0] + door.rect[2]) / 2
    if (scene === "board") {
      for (let i = 0; i < 3; i++) ai.spawnZombie(view.town, cx - 2 + i * 2, door.rect[3] + 7 + (i % 2), "wander")
      const have = ledger.count(view.actorId, "plank")
      if (have < 3) ledger.apply({ kind: "grant", actor: view.actorId, item: "plank", count: 3 - have })
    }
    const st = ledger.store(furnStoreId("ash", 0))
    if (st?.at && Math.abs(st.at.x - cx) < 2 && Math.abs(st.at.y - door.rect[1]) < 3) loosePiece(sim, furnKind(st), cx + 3, door.rect[1] - 3)
    host.pose(cx, door.rect[1] - 1.1, Math.PI / 2)
    return { x: cx, y: door.rect[1] - 1.1 }
  }
  if (scene === "drag" || scene === "brace") {
    host.setHour(22)
    const door = view.town.doors.find((d) => d.id === "ash-front")!
    mendDoor(sim, door.id)
    while (ai.getBarricadePlanks(door.id) > 0) ai.removeBarricadePlank(door.id)
    door.open = false
    ai.rebuildTopology(view.town)
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
      // Already battered, and a bang on the door from inside to bring the dead to it.
      st.counts.hp = 90
      ai.emitNoise(cx, inside, 24, "bash", sim.time, "stage", 1.5)
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
