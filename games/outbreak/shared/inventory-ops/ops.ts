import { raycast } from "@arcade/kit/sim/geom"
import type { ItemId, LedgerEvent, Stack } from "@arcade/kit/sim/ledger"
import { lifeOf } from "../death/runtime"
import { sightRects } from "../map"
import { BELT_ITEMS } from "../progression/catalog"
import { GIVE_RANGE } from "../progression/give"
import type { OutbreakSim, SurvivorSlot } from "../sim-types"
import type { InvAt, InventoryOp, InvRef } from "./types"

export { INV_AT, type InvAt, type InventoryOp, type InvRef } from "./types"
export { packInventoryOp, unpackInventoryOp } from "./wire"

/**
 * Inventory moves (AR-94): one command moves a stack between your hands (hotbar), pack and belt, the container, drop,
 * stash or body you face, the ground in front of you and a teammate in reach. Every move is a run of the ledger's own
 * transactions (swap, take, deposit, drop), so the room decides and the filtered ledger deltas replicate it.
 */
/** Furthest a teammate can be handed something: G's reach (AR-93), so the bag offers whoever G would. */
export { GIVE_RANGE }

/** The store behind an own end (`hotbar`, `pack`, `belt`), or null. */
function ownStore(actor: string, at: InvAt): string | null {
  return at === "hotbar" || at === "pack" || at === "belt" ? `${actor}/${at}` : null
}

/** The store the survivor's prompt reads from (container, drop, body or stash), if it is open. */
export function targetStore(sim: Pick<OutbreakSim, "progression">, slot: Pick<SurvivorSlot, "prompt">): string | null {
  const target = slot.prompt
  if (!target || target.kind === "bench") return null
  const id = sim.progression.storeFor(target)
  const st = id ? sim.progression.ledger.store(id) : undefined
  return st?.revealed ? st.id : null
}

/** A teammate `slot` can hand things to: alive, standing within `GIVE_RANGE`. */
export function mateInReach(sim: OutbreakSim, slot: SurvivorSlot, index: number): SurvivorSlot | null {
  const mate = sim.slots.find((s) => s.index === index)
  if (!mate || mate === slot) return null
  if (lifeOf(sim, mate.index) !== "alive" || lifeOf(sim, slot.index) !== "alive") return null
  const d = Math.hypot(mate.survivor.x - slot.survivor.x, mate.survivor.y - slot.survivor.y)
  return d <= GIVE_RANGE ? mate : null
}

/** Where something set down lands: a short way along the aim, short of any wall. */
function dropPoint(sim: OutbreakSim, s: { x: number; y: number; aim: number }): { x: number; y: number } {
  const dx = Math.cos(s.aim)
  const dy = Math.sin(s.aim)
  const d = Math.max(0.25, Math.min(0.7, raycast(s.x, s.y, dx, dy, sightRects(sim.town), 0.7) - 0.25))
  return { x: Number((s.x + dx * d).toFixed(3)), y: Number((s.y + dy * d).toFixed(3)) }
}

/** The stack at an own or target end, with its real slot index in the store. */
function stackAt(sim: OutbreakSim, slot: SurvivorSlot, ref: InvRef): { store: string; index: number; stack: Stack } | null {
  const ledger = sim.progression.ledger
  if (ref.at === "belt") {
    const item = BELT_ITEMS[ref.slot]
    const count = item ? ledger.count(`${slot.id}/belt`, item) : 0
    return item && count > 0 ? { store: `${slot.id}/belt`, index: ref.slot, stack: { item, count } } : null
  }
  const id = ref.at === "target" ? targetStore(sim, slot) : ownStore(slot.id, ref.at)
  const st = id ? ledger.store(id) : undefined
  if (!st) return null
  if (ref.at === "target") {
    const stack = sim.progression.contents(st.id)[ref.slot]
    if (!stack) return null
    return { store: st.id, index: st.mode === "slots" ? st.slots.indexOf(stack) : -1, stack }
  }
  const stack = st.slots[ref.slot]
  return stack ? { store: st.id, index: ref.slot, stack } : null
}

const labelOf = (sim: OutbreakSim, item: ItemId, count: number) => {
  const label = sim.progression.ledger.label(item)
  return count > 1 ? `${count} ${label}` : label
}

/** What a move did, for tests and the HUD (`ok` false with `reason` when the room refused it). */
export type InventoryOpResult = { ok: boolean; reason?: string; moved?: number }

/**
 * Applies one move for `slot` against the authoritative sim. Refusals become a notice (full hands, nobody in reach),
 * never a silent no-op, and anything handed to a full teammate lands at their feet.
 */
export function applyInventoryOp(sim: OutbreakSim, slot: SurvivorSlot, op: InventoryOp): InventoryOpResult {
  const progression = sim.progression
  const ledger = progression.ledger
  const refuse = (reason: string, text: string): InventoryOpResult => {
    progression.notify(slot, text, "info", "inventory")
    return { ok: false, reason }
  }
  const src = stackAt(sim, slot, op.from)
  if (!src) return { ok: false, reason: "empty" }
  const want = op.count && op.count > 0 ? Math.min(op.count, src.stack.count) : src.stack.count
  const events: LedgerEvent[] = []
  const finish = (moved: number): InventoryOpResult => {
    progression.feedback(slot, events)
    progression.project(slot)
    return moved > 0 ? { ok: true, moved } : { ok: false, reason: "full" }
  }

  // From the container you face into your stores: a take, then, if a slot was named, a swap into it.
  if (op.from.at === "target") {
    if (op.to.at === "ground" || op.to.at === "mate" || op.to.at === "target") return { ok: false, reason: "unsupported" }
    const before = snapshotSlots(sim, slot)
    const ok = progression.take(slot, src.store, op.from.slot)
    if (!ok) return { ok: false, reason: "full" }
    const dest = ownStore(slot.id, op.to.at)
    if (dest && op.to.at !== "belt") {
      const landed = changedSlot(sim, slot, before, src.stack.item)
      if (landed && (landed.store !== dest || landed.index !== op.to.slot)) {
        ledger.apply({ kind: "swap", actor: slot.id, a: { store: landed.store, slot: landed.index }, b: { store: dest, slot: op.to.slot } })
        progression.project(slot)
      }
    }
    return { ok: true, moved: 1 }
  }

  // Between your own hands and pack: a swap (the other slot's stack, if any, comes back).
  if ((op.from.at === "hotbar" || op.from.at === "pack") && (op.to.at === "hotbar" || op.to.at === "pack")) {
    if (op.from.at === op.to.at && op.from.slot === op.to.slot) return { ok: false, reason: "same" }
    const res = ledger.apply({ kind: "swap", actor: slot.id, a: { store: src.store, slot: src.index }, b: { store: `${slot.id}/${op.to.at}`, slot: op.to.slot } })
    if (!res.ok) return refuse(res.reason ?? "full", op.to.at === "hotbar" ? "That goes in the pack" : "That stays in your hands")
    progression.project(slot)
    return { ok: true, moved: src.stack.count }
  }

  // Into the container you face (or the house stash): a deposit, one at a time for stacks.
  if (op.to.at === "target") {
    const to = targetStore(sim, slot)
    if (!to) return refuse("no_target", "Nothing open to put it in")
    let moved = 0
    if (op.from.at === "belt") {
      const res = ledger.apply({ kind: "deposit", actor: slot.id, to, items: { [src.stack.item]: want } })
      events.push(...res.events)
      if (res.ok) moved = want
      else return refuse(res.reason ?? "full", "No room in there")
    } else {
      for (let i = 0; i < want; i++) {
        const res = ledger.apply({ kind: "deposit", actor: slot.id, to, from: { store: src.store, slot: src.index } })
        events.push(...res.events)
        if (!res.ok) break
        moved++
      }
      if (!moved) return refuse("full", "No room in there")
    }
    return finish(moved)
  }

  // On the ground in front of you, or handed to a teammate (it lands at their feet, then they pick it up).
  if (op.to.at === "ground" || op.to.at === "mate") {
    const mate = op.to.at === "mate" ? mateInReach(sim, slot, op.to.slot) : null
    if (op.to.at === "mate" && !mate) return refuse("no_mate", "Get closer to hand it over")
    const at = mate ? { x: mate.survivor.x, y: mate.survivor.y } : dropPoint(sim, slot.survivor)
    const dropIds: string[] = []
    let moved = 0
    if (op.from.at === "belt") {
      const res = ledger.apply({ kind: "drop", actor: slot.id, at, items: { [src.stack.item]: want } })
      events.push(...res.events)
      if (res.ok && res.dropId) {
        dropIds.push(res.dropId)
        moved = want
      }
    } else {
      for (let i = 0; i < want; i++) {
        const st = ledger.store(src.store)
        if (!st?.slots[src.index]) break
        const res = ledger.apply({ kind: "drop", actor: slot.id, at, store: src.store, slot: src.index })
        events.push(...res.events)
        if (!res.ok || !res.dropId) break
        dropIds.push(res.dropId)
        moved += res.events.reduce((n, e) => (e.kind === "dropped" ? n + e.items.reduce((m, s) => m + s.count, 0) : n), 0)
        if (moved >= want) break
      }
    }
    if (!moved) return finish(0)
    if (!mate) {
      progression.notify(slot, `Dropped ${labelOf(sim, src.stack.item, moved)}`, "info", "inventory")
      return finish(moved)
    }
    // The teammate takes it at once (AR-93's hand-over: notices name both, what doesn't fit stays at their feet).
    for (const id of dropIds) if (ledger.store(id)) progression.handOver(slot, mate, id)
    return finish(moved)
  }

  // Back into your own stores from the belt, or to "me": nothing to route.
  return { ok: false, reason: "unsupported" }
}

type SlotsSnapshot = Map<string, (string | null)[]>

function snapshotSlots(sim: OutbreakSim, slot: SurvivorSlot): SlotsSnapshot {
  const out: SlotsSnapshot = new Map()
  for (const at of ["hotbar", "pack"] as const) {
    const st = sim.progression.ledger.store(`${slot.id}/${at}`)
    if (st) out.set(st.id, st.slots.map((s) => (s ? `${s.item}:${s.count}` : null)))
  }
  return out
}

function changedSlot(sim: OutbreakSim, slot: SurvivorSlot, before: SlotsSnapshot, item: ItemId): { store: string; index: number } | null {
  for (const [id, prev] of before) {
    const st = sim.progression.ledger.store(id)
    if (!st) continue
    for (let i = 0; i < st.slots.length; i++) {
      const s = st.slots[i]
      if (s?.item === item && prev[i] !== `${s.item}:${s.count}`) return { store: id, index: i }
    }
  }
  return null
}
