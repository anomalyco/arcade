import type { ItemDef, Stack } from "@arcade/kit/sim/ledger"
import type { InvAt, InventoryOp, InvRef } from "../../shared/inventory-ops/types"
import { GIVE_RANGE } from "../../shared/inventory-ops/ops"
import { BELT_ITEMS, HOTBAR_SIZE, PACK_SIZE } from "../../shared/progression/catalog"
import type { SessionView } from "../../shared/session"

/** One place in the bag: a hand slot, a pack slot, a belt pouch or a stack in what you face. */
export type InvCell = {
  ref: InvRef
  stack: Stack | null
  def?: ItemDef
  label: string
  /** Rounds in the gun, durability left, flashlight battery: shown on the item. */
  charge?: { value: number; max: number; kind: "rounds" | "wear" | "battery" | "fuel" }
  /** The hand slot that is selected. */
  selected?: boolean
  /** Can't come out (a part installed in the stash), or no room for it on you. */
  blocked?: "installed" | "full"
}

export type InvMate = { index: number; name: string; colour: string; distance: number; dx: number; dy: number }

export type InvModel = {
  hands: InvCell[]
  pack: InvCell[]
  belt: InvCell[]
  /** What you face, when it is open: a container, a drop on the floor, a fallen body or the house stash. */
  target: { kind: string; title: string; cells: InvCell[] } | null
  /** Teammates close enough to hand something to. */
  mates: InvMate[]
  /** A cache key: changes whenever anything drawn changes. */
  key: string
}

const TARGET_TITLES: Record<string, string> = { container: "Search", drop: "On the floor", body: "Their things", stash: "Stash" }

function chargeOf(def: ItemDef | undefined, stack: Stack, view: SessionView): InvCell["charge"] {
  if (!def) return undefined
  if (stack.item === "flashlight") return { value: Math.round(view.player.battery * 100), max: 100, kind: "battery" }
  if (!def.charge) return undefined
  const kind = def.charge.ammo ? "rounds" : stack.item === "flamethrower" ? "fuel" : "wear"
  return { value: stack.charge ?? def.charge.initial ?? def.charge.max, max: def.charge.max, kind }
}

function cell(view: SessionView, at: InvAt, slot: number, stack: Stack | null): InvCell {
  const def = stack ? view.progression.ledger.items.get(stack.item) : undefined
  return { ref: { at, slot }, stack, def, label: stack ? view.progression.stackLabel(stack) : "", charge: stack ? chargeOf(def, stack, view) : undefined }
}

type MateSource = { sim?: { slots: readonly { id: string; index: number; survivor: { x: number; y: number; health: number } }[] } }

/** Builds the bag from the session view; `names` gives a seat's name, `colours` its colour. */
export function inventoryModel(
  view: SessionView,
  session: MateSource,
  names: (index: number) => string,
  colours: (index: number) => string,
): InvModel {
  const { progression: pr, actorId } = view
  const ledger = pr.ledger
  const hotbar = ledger.store(`${actorId}/hotbar`)
  const pack = ledger.store(`${actorId}/pack`)
  const belt = ledger.store(`${actorId}/belt`)
  const hands = Array.from({ length: HOTBAR_SIZE }, (_, i) => ({ ...cell(view, "hotbar", i, hotbar?.slots[i] ?? null), selected: (hotbar?.selected ?? 0) === i }))
  const packCells = Array.from({ length: PACK_SIZE }, (_, i) => cell(view, "pack", i, pack?.slots[i] ?? null))
  const beltCells = BELT_ITEMS.map((item, i) => {
    const count = belt?.counts[item] ?? 0
    return count > 0 ? cell(view, "belt", i, { item, count }) : null
  }).filter((c): c is InvCell => c !== null)

  let target: InvModel["target"] = null
  const prompt = view.prompt
  const storeId = prompt && prompt.kind !== "bench" ? pr.storeFor(prompt) : null
  const st = storeId ? ledger.store(storeId) : undefined
  if (prompt && st?.revealed) {
    const stash = prompt.kind === "stash"
    target = {
      kind: prompt.kind,
      title: TARGET_TITLES[prompt.kind] ?? prompt.kind,
      cells: pr.contents(st.id).map((s, i) => {
        const c = cell(view, "target", i, s)
        if (stash && c.def?.tag === "part") c.blocked = "installed"
        else if (ledger.room(actorId, s.item, 1) <= 0) c.blocked = "full"
        return c
      }),
    }
  }

  const me = view.player
  const mates: InvMate[] = []
  for (const s of session.sim?.slots ?? []) {
    if (s.id === actorId || s.survivor.health <= 0) continue
    const dx = s.survivor.x - me.x
    const dy = s.survivor.y - me.y
    const distance = Math.hypot(dx, dy)
    if (distance <= GIVE_RANGE) mates.push({ index: s.index, name: names(s.index), colour: colours(s.index), distance, dx, dy })
  }

  const key = [
    hotbar?.rev,
    hotbar?.selected,
    pack?.rev,
    belt?.rev,
    st?.rev ?? "",
    storeId ?? "",
    target?.cells.map((c) => c.blocked ?? "").join(",") ?? "",
    mates.map((m) => m.index).join(","),
    Math.round(me.battery * 20),
    me.magAmmo,
  ].join("|")
  return { hands, pack: packCells, belt: beltCells, target, mates, key }
}

/** The cell a ref points at in the model, if any. */
export function cellAt(model: InvModel, ref: InvRef): InvCell | undefined {
  if (ref.at === "hotbar") return model.hands[ref.slot]
  if (ref.at === "pack") return model.pack[ref.slot]
  if (ref.at === "belt") return model.belt.find((c) => c.ref.slot === ref.slot)
  if (ref.at === "target") return model.target?.cells[ref.slot]
  return undefined
}

const own = (at: InvAt) => at === "hotbar" || at === "pack" || at === "belt"

/**
 * The move for dragging `from` onto `to` (a slot, a whole area as slot -1, the floor or a teammate), or null when the
 * drop means nothing. Areas resolve to a free slot here so the room gets an exact slot.
 */
export function moveFor(model: InvModel, from: InvRef, to: InvRef, count = 0): InventoryOp | null {
  const src = cellAt(model, from)
  if (!src?.stack || src.def?.bound) return null
  if (from.at === to.at && (from.slot === to.slot || to.slot < 0)) return null
  if (from.at === "belt" && (to.at === "hotbar" || to.at === "pack")) return null
  if (from.at === "target") {
    if (to.at === "target" || to.at === "ground" || to.at === "mate") return null
    if (to.at === "belt" || to.slot < 0) return { from, to: { at: "me", slot: 0 }, count }
    return { from, to, count }
  }
  if (!own(from.at)) return null
  if (to.at === "target") return model.target ? { from, to: { at: "target", slot: 0 }, count } : null
  if (to.at === "ground" || to.at === "mate") return { from, to, count }
  if (to.at === "hotbar" || to.at === "pack") {
    const slot = to.slot >= 0 ? to.slot : (to.at === "pack" ? model.pack : model.hands).findIndex((c) => !c.stack)
    return slot >= 0 ? { from, to: { at: to.at, slot }, count } : null
  }
  return null
}

/**
 * The quick move (click or Shift+click): out of what you face into you; into what you face when it is open; otherwise
 * between your hands and your pack.
 */
export function quickMoveFor(model: InvModel, from: InvRef): InventoryOp | null {
  const src = cellAt(model, from)
  if (!src?.stack || src.def?.bound) return null
  if (from.at === "target") return src.blocked ? null : { from, to: { at: "me", slot: 0 } }
  if (model.target) return moveFor(model, from, { at: "target", slot: -1 })
  if (from.at === "hotbar") return moveFor(model, from, { at: "pack", slot: -1 })
  if (from.at === "pack") return moveFor(model, from, { at: "hotbar", slot: -1 })
  return null
}

/** Parses a `data-ref` attribute ("pack:2", "mate:3", "ground:0", "target:-1"). */
export function parseRef(raw: string | undefined | null): InvRef | null {
  if (!raw) return null
  const [at, slot] = raw.split(":")
  const n = Number(slot)
  if (!at || !Number.isFinite(n)) return null
  if (!["hotbar", "pack", "belt", "target", "ground", "mate", "me"].includes(at)) return null
  return { at: at as InvAt, slot: n }
}

export const refAttr = (ref: InvRef) => `${ref.at}:${ref.slot}`
