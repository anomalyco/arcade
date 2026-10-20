import { raycast } from "@arcade/kit/sim/geom"
import type { ItemId, LedgerEvent, Stack, StoreState } from "@arcade/kit/sim/ledger"
import { lifeOf } from "../death/runtime"
import { sightRects } from "../map"
import { GIVE_RANGE } from "../progression/give"
import type { OutbreakSim, SurvivorSlot } from "../sim-types"
import type { InventoryOp, InvRef } from "./types"

export { INV_AT, type InvAt, type InventoryOp, type InvRef } from "./types"
export { packInventoryOp, unpackInventoryOp } from "./wire"

/**
 * Inventory moves (AR-94, the Attaché Case): one command moves a stack between your hands (hotbar) and the case, to a
 * cell of the case (turned or not), out of the container, drop, stash or body you face, onto the ground in front of you
 * or to a teammate in reach. Every move is a run of the ledger's own transactions (place, swap, take, deposit, drop),
 * so the room decides and the filtered ledger deltas replicate it.
 */
/** Furthest a teammate can be handed something: G's reach (AR-93), so the case offers whoever G would. */
export { GIVE_RANGE }

/** The store behind an own end (`hotbar`, `pack`/`case`), or null. */
function ownStore(actor: string, at: InvRef["at"]): string | null {
  if (at === "hotbar") return `${actor}/hotbar`
  if (at === "pack" || at === "case") return `${actor}/pack`
  return null
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

/** The stack at an own or target end, with its store and real slot index (-1 in a counters store such as the stash). */
function stackAt(sim: OutbreakSim, slot: SurvivorSlot, ref: InvRef): { store: StoreState; index: number; stack: Stack } | null {
  const ledger = sim.progression.ledger
  const id = ref.at === "target" ? targetStore(sim, slot) : ref.at === "hotbar" || ref.at === "pack" ? ownStore(slot.id, ref.at) : null
  const st = id ? ledger.store(id) : undefined
  if (!st) return null
  if (ref.at === "target") {
    const stack = sim.progression.contents(st.id)[ref.slot]
    if (!stack) return null
    return { store: st, index: st.mode === "slots" ? st.slots.indexOf(stack) : -1, stack }
  }
  const stack = st.slots[ref.slot]
  return stack ? { store: st, index: ref.slot, stack } : null
}

const labelOf = (sim: OutbreakSim, item: ItemId, count: number) => {
  const label = sim.progression.ledger.label(item)
  return count > 1 ? `${count} ${label}` : label
}

/** What a move did, for tests and the HUD (`ok` false with `reason` when the room refused it). */
export type InventoryOpResult = { ok: boolean; reason?: string; moved?: number }

/**
 * Applies one move for `slot` against the authoritative sim. Refusals become a notice (no room there, nobody in reach),
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
  if (ledger.isBound(src.stack.item)) return { ok: false, reason: "bound" }
  const want = op.count && op.count > 0 ? Math.min(op.count, src.stack.count) : src.stack.count
  const events: LedgerEvent[] = []
  const finish = (moved: number): InventoryOpResult => {
    progression.feedback(slot, events)
    progression.project(slot)
    return moved > 0 ? { ok: true, moved } : { ok: false, reason: "full" }
  }
  const pack = ledger.store(`${slot.id}/pack`)

  // A bag is worn, not packed: wherever it is dragged, taking it puts it on (and the case grows).
  if (op.from.at === "target" && ledger.items.get(src.stack.item)?.tag === "bag") {
    return progression.take(slot, src.store.id, op.from.slot) ? { ok: true, moved: 1 } : { ok: false, reason: "full" }
  }

  // Onto a cell of the case: placed there as it lies or turned, moved within the case, or brought in from your hands
  // or what you face. Dropped on a stack of the same supply, it tops that stack up.
  if (op.to.at === "case" || (op.to.at === "pack" && op.from.at !== "pack" && op.from.at !== "target")) {
    if (!pack?.grid) return { ok: false, reason: "no_case" }
    let x: number
    let y: number
    let r = Boolean(op.to.r)
    if (op.to.at === "case") {
      x = op.to.slot % pack.grid.cols
      y = Math.floor(op.to.slot / pack.grid.cols)
    } else {
      // Anywhere it fits: the case's own first fit.
      const place = ledger.findPlace(pack, src.stack.item)
      if (!place) return refuse("full", "No room in your case")
      x = place.x
      y = place.y
      r = place.r === 1
    }
    if (src.index < 0) return { ok: false, reason: "unsupported" }
    const res = ledger.apply({ kind: "place", actor: slot.id, from: { store: src.store.id, slot: src.index }, to: pack.id, x, y, r, count: want })
    events.push(...res.events)
    if (!res.ok) return refuse(res.reason ?? "full", src.store.owner === slot.id ? "It doesn't fit there" : "No room there in your case")
    if (src.store.owner !== slot.id) progression.notify(slot, labelOf(sim, src.stack.item, want), "result", `take:${src.store.id}`)
    return finish(want)
  }

  // From the container you face into you: a take, routed into your hands or the case's first fit.
  if (op.from.at === "target") {
    if (op.to.at !== "me" && op.to.at !== "hotbar" && op.to.at !== "pack") return { ok: false, reason: "unsupported" }
    const before = snapshotHands(sim, slot)
    const ok = progression.take(slot, src.store.id, op.from.slot)
    if (!ok) return { ok: false, reason: "full" }
    if (op.to.at === "hotbar" && op.to.slot >= 0) {
      const landed = changedHand(sim, slot, before, src.stack.item)
      if (landed >= 0 && landed !== op.to.slot) {
        ledger.apply({ kind: "swap", actor: slot.id, a: { store: `${slot.id}/hotbar`, slot: landed }, b: { store: `${slot.id}/hotbar`, slot: op.to.slot } })
        progression.project(slot)
      }
    }
    return { ok: true, moved: 1 }
  }

  // Between your hands, and from the case into a hand: a swap (what was in that hand goes back into the case).
  if ((op.from.at === "hotbar" || op.from.at === "pack") && op.to.at === "hotbar") {
    if (op.from.at === "hotbar" && op.from.slot === op.to.slot) return { ok: false, reason: "same" }
    const res = ledger.apply({ kind: "swap", actor: slot.id, a: { store: src.store.id, slot: src.index }, b: { store: `${slot.id}/hotbar`, slot: op.to.slot } })
    if (!res.ok) return refuse(res.reason ?? "full", op.from.at === "pack" ? "That stays in the case" : "No room in your case for that")
    progression.project(slot)
    return { ok: true, moved: src.stack.count }
  }

  // Into the container you face (or the house stash).
  if (op.to.at === "target") {
    const to = targetStore(sim, slot)
    if (!to) return refuse("no_target", "Nothing open to put it in")
    const res = ledger.apply({ kind: "deposit", actor: slot.id, to, from: { store: src.store.id, slot: src.index }, count: want })
    events.push(...res.events)
    if (!res.ok) return refuse(res.reason ?? "full", "No room in there")
    const moved = res.events.reduce((n, e) => (e.kind === "changed" && e.store === to && e.delta > 0 ? n + e.delta : n), 0)
    return finish(moved)
  }

  // On the ground in front of you, or handed to a teammate (it lands at their feet, then they pick it up).
  if (op.to.at === "ground" || op.to.at === "mate") {
    const mate = op.to.at === "mate" ? mateInReach(sim, slot, op.to.slot) : null
    if (op.to.at === "mate" && !mate) return refuse("no_mate", "Get closer to hand it over")
    const at = mate ? { x: mate.survivor.x, y: mate.survivor.y } : dropPoint(sim, slot.survivor)
    const res = ledger.apply({ kind: "drop", actor: slot.id, at, store: src.store.id, slot: src.index, count: want })
    events.push(...res.events)
    if (!res.ok || !res.dropId) return finish(0)
    if (!mate) {
      progression.notify(slot, `Dropped ${labelOf(sim, src.stack.item, want)}`, "info", "inventory")
      return finish(want)
    }
    // The teammate takes it at once (AR-93's hand-over: notices name both, what doesn't fit stays at their feet).
    if (ledger.store(res.dropId)) progression.handOver(slot, mate, res.dropId)
    return finish(want)
  }

  return { ok: false, reason: "unsupported" }
}

function snapshotHands(sim: OutbreakSim, slot: SurvivorSlot): (string | null)[] {
  return sim.progression.ledger.store(`${slot.id}/hotbar`)?.slots.map((s) => (s ? `${s.item}:${s.count}` : null)) ?? []
}

function changedHand(sim: OutbreakSim, slot: SurvivorSlot, before: readonly (string | null)[], item: ItemId): number {
  const st = sim.progression.ledger.store(`${slot.id}/hotbar`)
  if (!st) return -1
  return st.slots.findIndex((s, i) => s?.item === item && before[i] !== `${s.item}:${s.count}`)
}
