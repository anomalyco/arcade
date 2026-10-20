import { distToRect, pushOut, type Rect } from "@arcade/kit/sim/geom"
import type { StoreState } from "@arcade/kit/sim/ledger"
import type { PortalHolds } from "../ai"
import type { InteractAction, InteractionHandler, RawInteractCandidate } from "../interact"
import { solidRects } from "../map"
import type { OutbreakSim, Survivor, SurvivorSlot } from "../sim-types"
import {
  braceTarget,
  bracedPortal,
  bracePose,
  FURNITURE,
  FURNITURE_KINDS,
  furnitureSites,
  furnKind,
  furnRect,
  furnYaw,
  isFurnStore,
  type FurnitureKind,
} from "./furniture"
import type { InteractionsTuning } from "./tuning"

/** How near a piece a survivor must be to take hold of it. */
const GRAB_RANGE = 1.1
/** How near a door or window a piece set down must be to brace it. */
const BRACE_RANGE = 1.4
/** How far behind the dragger a hauled teammate lies. */
const HAUL_BACK = 0.8

/** Who acts: a sim slot, or progression's view of one (what interaction handlers get). */
type Actor = { id: string; index: number; survivor: { x: number; y: number; aim: number } }

export type DragState = {
  /** Houses whose loose furniture has been put out (once each). */
  seeded: Record<string, 1>
  siteKey: string
  /** Every furniture store this sim has put out (to step without scanning the ledger). */
  pieces: string[]
  /** Braced store id → the portal id it holds. */
  braced: Record<string, string>
}

export const createDragState = (): DragState => ({ seeded: {}, siteKey: "", pieces: [], braced: {} })

const ds = (s: number) => Math.round(s * 10)
const cm = (m: number) => Math.round(m * 100) || 0
const touch = (sim: OutbreakSim, st: StoreState) => {
  st.rev = ++sim.progression.ledger.rev
}

export const haulStoreId = (index: number) => `haul:${index}`

/** Puts each streamed-in house's loose furniture out, once (`furniture.ts`). */
export function seedFurniture(sim: OutbreakSim, state: DragState, t: InteractionsTuning): void {
  const town = sim.town
  const key = `${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}:${t.furniture}`
  if (key === state.siteKey) return
  state.siteKey = key
  const ledger = sim.progression.ledger
  const solids = solidRects(town)
  for (const b of town.buildings) {
    if (state.seeded[b.id]) continue
    state.seeded[b.id] = 1
    for (const site of furnitureSites(town, b, t.furniture > 0 ? 2 : 0, solids)) {
      if (!ledger.store(site.id)) {
        ledger.createStore({ id: site.id, mode: "counters", scope: "shared", at: { x: site.x, y: site.y }, initial: { k: FURNITURE_KINDS.indexOf(site.kind), yaw: Math.round(site.yaw * 100) } })
      }
      if (!state.pieces.includes(site.id)) state.pieces.push(site.id)
    }
  }
}

function pieces(sim: OutbreakSim, state: DragState): StoreState[] {
  const ledger = sim.progression.ledger
  const out: StoreState[] = []
  for (const id of state.pieces) {
    const st = ledger.store(id)
    if (st?.at) out.push(st)
  }
  return out
}

/** The piece `slot` is dragging, if any. */
export function draggedBy(sim: OutbreakSim, state: DragState, slotId: string): StoreState | null {
  for (const st of pieces(sim, state)) if (st.counts.drag && st.owner === slotId) return st
  return null
}

/** Where a piece being dragged by `p` sits: square in front of them along their aim. */
export function dragPose(p: Pick<Survivor, "x" | "y" | "aim">, kind: FurnitureKind): { x: number; y: number; yaw: number } {
  const def = FURNITURE[kind]
  const reach = def.d / 2 + 0.42
  return { x: p.x + Math.cos(p.aim) * reach, y: p.y + Math.sin(p.aim) * reach, yaw: p.aim + Math.PI / 2 }
}

function unbrace(state: DragState, st: StoreState): boolean {
  if (!st.counts.br) return false
  st.counts.br = 0
  delete state.braced[st.id]
  return true
}

/** E at a loose piece: take hold of it (pulling it off a door or window it braced, or up off the floor). */
export function grab(sim: OutbreakSim, state: DragState, slot: Actor, st: StoreState): { topology: boolean } {
  if (draggedBy(sim, state, slot.id)) return { topology: false }
  const topology = unbrace(state, st)
  st.counts.drag = 1
  st.counts.down = 0
  st.owner = slot.id
  touch(sim, st)
  return { topology }
}

/** E again: set it down where it is, or flush against the door or window in front of it, bracing that. */
export function setDown(sim: OutbreakSim, state: DragState, slot: Actor, st: StoreState, t: InteractionsTuning): { topology: boolean; braced: boolean } {
  const kind = furnKind(st)
  const p = slot.survivor
  st.counts.drag = 0
  st.owner = undefined
  const portal = t.furniture > 0 ? braceTarget(sim.town, st.at!.x, st.at!.y, kind, BRACE_RANGE) : null
  if (!portal) {
    touch(sim, st)
    return { topology: false, braced: false }
  }
  const pose = bracePose(portal, kind, p.x, p.y)
  st.at = { x: Number(pose.x.toFixed(2)), y: Number(pose.y.toFixed(2)) }
  st.counts.yaw = Math.round(pose.yaw * 100)
  st.counts.br = 1
  st.counts.px = cm(portal.x)
  st.counts.py = cm(portal.y)
  st.counts.hp = Math.round(FURNITURE[kind].hp * Math.max(0.1, t.braceStrength))
  st.counts.t = ds(sim.time)
  state.braced[st.id] = portal.id
  // Shoved against a door, it slams it shut.
  const door = portal.kind === "door" ? sim.town.doors.find((d) => d.id === portal.id) : undefined
  if (door) door.open = false
  touch(sim, st)
  // Step back off it if the piece landed on the survivor.
  pushOut(p, 0.3, [furnRect(st.at.x, st.at.y, kind, pose.yaw)])
  return { topology: true, braced: true }
}

/** The crowd's hook (`PortalHolds`): braced pieces hold their portal until bashed to nothing, then are shoved aside. */
export function holdsFor(sim: OutbreakSim, state: DragState): PortalHolds & { sim: OutbreakSim } {
  const byPortal = (portalId: string): StoreState | null => {
    for (const [storeId, pid] of Object.entries(state.braced)) {
      if (pid !== portalId) continue
      const st = sim.progression.ledger.store(storeId)
      if (st?.counts.br && (st.counts.hp ?? 0) > 0) return st
    }
    return null
  }
  return {
    sim,
    held: (portalId) => byPortal(portalId) !== null,
    absorb: (portalId, damage) => {
      const st = byPortal(portalId)
      if (!st) return damage
      const left = (st.counts.hp ?? 0) - damage
      if (left > 0) {
        st.counts.hp = Math.round(left)
        touch(sim, st)
        return 0
      }
      topple(sim, state, st)
      return -left
    },
  }
}

/** Bashed through: the piece is shoved off the portal into the room and falls over. */
function topple(sim: OutbreakSim, state: DragState, st: StoreState): void {
  const portal = bracedPortal(sim.town, st)
  unbrace(state, st)
  st.counts.hp = 0
  st.counts.down = 1
  if (portal && st.at) {
    const dx = st.at.x - portal.x
    const dy = st.at.y - portal.y
    const len = Math.hypot(dx, dy) || 1
    st.at = { x: Number((st.at.x + (dx / len) * 0.7).toFixed(2)), y: Number((st.at.y + (dy / len) * 0.7).toFixed(2)) }
  }
  sim.ai.emitNoise(st.at!.x, st.at!.y, 9, "bash", sim.time, "furniture", 1.3)
  touch(sim, st)
}

/** Pushes a survivor out of every piece near them except the one they drag. */
export function pushOutOfFurniture(sim: OutbreakSim, state: DragState, p: Survivor, radius: number): void {
  for (const st of pieces(sim, state)) {
    const at = st.at!
    if (Math.abs(at.x - p.x) > 2.5 || Math.abs(at.y - p.y) > 2.5) continue
    if (st.counts.drag) {
      const dragger = sim.slots.find((s) => s.id === st.owner)
      if (dragger?.survivor === p) continue
    }
    pushOut(p, radius, [furnRect(at.x, at.y, furnKind(st), furnYaw(st), Boolean(st.counts.down))])
  }
}

/** Every piece no one is dragging, for survivor bots to path round. */
export function restingFurniture(sim: OutbreakSim, state: DragState): Rect[] {
  const out: Rect[] = []
  for (const st of pieces(sim, state)) {
    if (!st.counts.drag) out.push(furnRect(st.at!.x, st.at!.y, furnKind(st), furnYaw(st), Boolean(st.counts.down)))
  }
  return out
}

/** Share of walking speed `slot` keeps: dragging a piece, hauling a teammate, or carrying a car battery. */
export function dragSpeed(sim: OutbreakSim, state: DragState, slot: SurvivorSlot, t: InteractionsTuning): number {
  const st = draggedBy(sim, state, slot.id)
  if (st) return FURNITURE[furnKind(st)].speed * t.dragSpeed
  if (sim.progression.ledger.store(haulStoreId(slot.index))?.counts.who) return t.haulSpeed
  if (t.heavyCarry > 0 && sim.progression.ledger.count(slot.id, "car-battery") > 0) return t.heavyCarry
  return 1
}

/** Once per tick in the room: dragged pieces follow their dragger (and are let go by anyone who cannot hold them). */
export function stepDragged(sim: OutbreakSim, state: DragState): void {
  for (const st of pieces(sim, state)) {
    if (!st.counts.drag) continue
    const slot = sim.slots.find((s) => s.id === st.owner)
    const p = slot?.survivor
    if (!slot || !p || p.health <= 0 || p.vehicleId) {
      st.counts.drag = 0
      st.owner = undefined
      touch(sim, st)
      continue
    }
    const kind = furnKind(st)
    const pose = dragPose(p, kind)
    const c = { x: pose.x, y: pose.y }
    pushOut(c, Math.min(FURNITURE[kind].w, FURNITURE[kind].d) / 2, sim.solids)
    const x = Number(c.x.toFixed(2))
    const y = Number(c.y.toFixed(2))
    const yaw = Math.round(pose.yaw * 100)
    if (Math.abs(x - st.at!.x) < 0.02 && Math.abs(y - st.at!.y) < 0.02 && Math.abs(yaw - (st.counts.yaw ?? 0)) < 4) continue
    st.at = { x, y }
    st.counts.yaw = yaw
    touch(sim, st)
  }
}

/** E at a piece: Drag (or Pull away from what it braces); E while dragging it: Set down, or Brace at a door or window. */
export function furnitureHandler(sim: OutbreakSim, of: () => { drag: DragState; tuning: InteractionsTuning } | undefined): InteractionHandler {
  return {
    kind: "furniture",
    candidates: (town, actor) => {
      const s = of()
      if (!s || s.tuning.furniture <= 0 || actor.peekingWindowId) return []
      const slot = sim.progression.slotOf(actor)
      if (!slot) return []
      const out: RawInteractCandidate[] = []
      const held = draggedBy(sim, s.drag, slot.id)
      if (held) {
        const kind = furnKind(held)
        const portal = braceTarget(town, held.at!.x, held.at!.y, kind, BRACE_RANGE)
        const primary: InteractAction = { id: "set-down", label: portal ? "Brace" : "Set down" }
        const rect = furnRect(held.at!.x, held.at!.y, kind, furnYaw(held))
        out.push({ kind: "furniture", id: held.id, label: FURNITURE[kind].label, rect, worldX: held.at!.x, worldY: held.at!.y, primary, actions: [primary], priority: 20 })
        return out
      }
      for (const st of pieces(sim, s.drag)) {
        if (st.counts.drag) continue
        const kind = furnKind(st)
        const rect = furnRect(st.at!.x, st.at!.y, kind, furnYaw(st), Boolean(st.counts.down))
        if (distToRect(actor.x, actor.y, rect) > GRAB_RANGE) continue
        const primary: InteractAction = { id: "drag", label: st.counts.br ? "Pull away" : "Drag" }
        out.push({ kind: "furniture", id: st.id, label: FURNITURE[kind].label, rect, worldX: st.at!.x, worldY: st.at!.y, primary, actions: [primary], priority: 1 })
      }
      return out
    },
    execute: (_town, actor, targetId, action) => {
      const s = of()
      const slot = sim.progression.slotOf(actor)
      const st = sim.progression.ledger.store(targetId)
      if (!s || !slot || !st || !isFurnStore(st.id)) return { handled: false }
      if (action === "drag" && !st.counts.drag) {
        const { topology } = grab(sim, s.drag, slot, st)
        return { handled: true, kind: "furniture", targetId, action, noise: 3, noiseKind: "bash", topologyChanged: topology }
      }
      if (action === "set-down" && st.counts.drag && st.owner === slot.id) {
        const { topology, braced } = setDown(sim, s.drag, slot, st, s.tuning)
        return { handled: true, kind: "furniture", targetId, action, noise: braced ? 6 : 3, noiseKind: "bash", topologyChanged: topology }
      }
      return { handled: false }
    },
  }
}

// ── Hauling a downed teammate ──────────────────────────────────────────────────────────────────────────────────

/** Tap E at a downed teammate: take them under the arms and drag them (tap again to let go). Hold E still revives. */
export function toggleHaul(sim: OutbreakSim, dragger: Actor, downedIndex: number): boolean {
  const ledger = sim.progression.ledger
  const id = haulStoreId(dragger.index)
  const st = ledger.store(id)
  if (st?.counts.who) {
    st.counts.who = 0
    touch(sim, st)
    return true
  }
  // Someone else already has them.
  for (const s of sim.slots) if (s.index !== dragger.index && ledger.store(haulStoreId(s.index))?.counts.who === downedIndex + 1) return false
  if (st) {
    st.counts.who = downedIndex + 1
    touch(sim, st)
  } else ledger.createStore({ id, mode: "counters", scope: "shared", at: { x: dragger.survivor.x, y: dragger.survivor.y }, initial: { who: downedIndex + 1 } })
  return true
}

/** Whom `slot` is hauling (their seat index), or -1. */
export function haulingWho(sim: OutbreakSim, slot: Pick<Actor, "index">): number {
  return (sim.progression.ledger.store(haulStoreId(slot.index))?.counts.who ?? 0) - 1
}

/**
 * Once per tick in the room: a hauled teammate lies behind their dragger. The haul ends when either is gone, the
 * dragger goes down or into a car, or the teammate is back up (or dead).
 */
export function stepHauls(sim: OutbreakSim, isDown: (index: number) => boolean): void {
  const ledger = sim.progression.ledger
  for (const dragger of sim.slots) {
    const st = ledger.store(haulStoreId(dragger.index))
    const who = (st?.counts.who ?? 0) - 1
    if (!st || who < 0) continue
    const other = sim.slots.find((s) => s.index === who)
    const p = dragger.survivor
    if (!other || !isDown(who) || isDown(dragger.index) || p.health <= 0 || p.vehicleId) {
      st.counts.who = 0
      touch(sim, st)
      continue
    }
    const q = other.survivor
    const tx = p.x - Math.cos(p.aim) * HAUL_BACK
    const ty = p.y - Math.sin(p.aim) * HAUL_BACK
    // Pulled along, not teleported: they trail toward the spot behind.
    const k = Math.min(1, Math.hypot(tx - q.x, ty - q.y) > 2 ? 1 : 0.35)
    q.x += (tx - q.x) * k
    q.y += (ty - q.y) * k
    pushOut(q, 0.3, sim.solids)
  }
}
