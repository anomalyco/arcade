import type { ItemDef, Ledger, Stack, StoreState } from "@arcade/kit/sim/ledger"
import { GIVE_RANGE } from "../../shared/inventory-ops/ops"
import type { InvAt, InventoryOp, InvRef } from "../../shared/inventory-ops/types"
import { HOTBAR_SIZE } from "../../shared/progression/catalog"
import type { SessionView } from "../../shared/session"

/** One thing in the case, a hand slot, or a stack in what you face. */
export type InvCell = {
  ref: InvRef
  stack: Stack | null
  def?: ItemDef
  label: string
  /** Rounds in the gun, durability left, fuel: shown on the item. */
  charge?: { value: number; max: number; kind: "rounds" | "wear" | "fuel" }
  /** The hand slot that is selected. */
  selected?: boolean
  /** Can't come out (a part installed in the stash), or no room for it on you. */
  blocked?: "installed" | "full"
}

/** A stack lying in the case: its top-left cell and its cells across and down as it lies (turned when `r`). */
export type CaseItem = InvCell & { x: number; y: number; w: number; h: number; r: boolean }

export type InvCase = {
  cols: number
  rows: number
  items: CaseItem[]
  /** Which item (index in `items`) fills each cell, row-major; -1 free. */
  occ: number[]
  /** Cells taken. */
  used: number
  /** The bag the case is, and the pouches sewn on (a row each). */
  bag: string
  pouches: number
}

export type InvMate = { index: number; name: string; colour: string; distance: number; dx: number; dy: number }

export type InvModel = {
  hands: InvCell[]
  case: InvCase
  /** What you face, when it is open: a container, a drop on the floor, a fallen body or the house stash. */
  target: { kind: string; title: string; cells: InvCell[] } | null
  /** Teammates close enough to hand something to. */
  mates: InvMate[]
  /** A cache key: changes whenever anything drawn changes. */
  key: string
}

const TARGET_TITLES: Record<string, string> = { container: "Search", drop: "On the floor", body: "Their things", stash: "Stash" }

/** Cells across and down an item takes in the case (long side across), turned or not. */
export function shapeOf(ledger: Pick<Ledger, "footprint">, item: string, turned = false): { w: number; h: number } {
  return ledger.footprint(item, turned)
}

function chargeOf(def: ItemDef | undefined, stack: Stack): InvCell["charge"] {
  if (!def?.charge) return undefined
  const kind = def.charge.ammo ? "rounds" : stack.item === "flamethrower" ? "fuel" : "wear"
  return { value: stack.charge ?? def.charge.initial ?? def.charge.max, max: def.charge.max, kind }
}

function cell(view: SessionView, at: InvAt, slot: number, stack: Stack | null): InvCell {
  const def = stack ? view.progression.ledger.items.get(stack.item) : undefined
  return { ref: { at, slot }, stack, def, label: stack ? view.progression.stackLabel(stack) : "", charge: stack ? chargeOf(def, stack) : undefined }
}

/** The case as drawn: every placed stack in slot order and the cells they fill. */
export function caseOf(view: SessionView, pack: StoreState | undefined): InvCase {
  const ledger = view.progression.ledger
  const cols = pack?.grid?.cols ?? 0
  const rows = pack?.grid?.rows ?? 0
  const items: CaseItem[] = []
  const occ = new Array<number>(cols * rows).fill(-1)
  pack?.slots.forEach((s, i) => {
    const p = pack.places?.[i]
    if (!s || !p) return
    const fp = ledger.footprint(s.item, p.r === 1)
    const n = items.length
    items.push({ ...cell(view, "pack", i, s), x: p.x, y: p.y, w: fp.w, h: fp.h, r: p.r === 1 })
    for (let y = p.y; y < p.y + fp.h; y++) for (let x = p.x; x < p.x + fp.w; x++) if (x < cols && y < rows) occ[y * cols + x] = n
  })
  const bag = view.progression.bagOf(view.actorId)
  return { cols, rows, items, occ, used: occ.filter((i) => i >= 0).length, bag: bag.bag.label, pouches: bag.pouches }
}

type MateSource = { sim?: { slots: readonly { id: string; index: number; survivor: { x: number; y: number; health: number } }[] } }

/** Builds the case from the session view; `names` gives a seat's name, `colours` its colour. */
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
  const worn = ledger.store(`${actorId}/worn`)
  const hands = Array.from({ length: HOTBAR_SIZE }, (_, i) => ({ ...cell(view, "hotbar", i, hotbar?.slots[i] ?? null), selected: (hotbar?.selected ?? 0) === i }))

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
    worn?.rev,
    st?.rev ?? "",
    storeId ?? "",
    target?.cells.map((c) => c.blocked ?? "").join(",") ?? "",
    mates.map((m) => m.index).join(","),
    me.magAmmo,
  ].join("|")
  return { hands, case: caseOf(view, pack), target, mates, key }
}

/** The cell a ref points at in the model, if any. */
export function cellAt(model: InvModel, ref: InvRef): InvCell | undefined {
  if (ref.at === "hotbar") return model.hands[ref.slot]
  if (ref.at === "pack") return model.case.items.find((c) => c.ref.slot === ref.slot)
  if (ref.at === "target") return model.target?.cells[ref.slot]
  return undefined
}

/**
 * Whether `from` (as it lies, or turned) could land with its top-left on (`x`, `y`) of the case: "fit" on free
 * cells, "merge" onto a stack of the same supply with room, otherwise "blocked". A whole stack moved within the case
 * does not block itself.
 */
export function fitAt(model: InvModel, ledger: Pick<Ledger, "footprint">, from: InvRef, x: number, y: number, turned: boolean, count = 0): "fit" | "merge" | "blocked" {
  const src = cellAt(model, from)
  const c = model.case
  if (!src?.stack || src.def?.bound || src.def?.tag === "bag") return "blocked"
  const whole = !count || count >= src.stack.count
  const self = from.at === "pack" && whole ? model.case.items.findIndex((it) => it.ref.slot === from.slot) : -1
  const under = x >= 0 && y >= 0 && x < c.cols && y < c.rows ? c.occ[y * c.cols + x]! : -1
  if (under >= 0 && under !== self) {
    const top = c.items[under]!
    const max = src.def?.stack ?? 1
    if (top.stack?.item === src.stack.item && max > 1 && top.stack.count < max && !(from.at === "pack" && top.ref.slot === from.slot)) return "merge"
  }
  const fp = ledger.footprint(src.stack.item, turned)
  if (x < 0 || y < 0 || x + fp.w > c.cols || y + fp.h > c.rows) return "blocked"
  for (let yy = y; yy < y + fp.h; yy++) for (let xx = x; xx < x + fp.w; xx++) {
    const o = c.occ[yy * c.cols + xx]!
    if (o >= 0 && o !== self) return "blocked"
  }
  return "fit"
}

const own = (at: InvAt) => at === "hotbar" || at === "pack"

/**
 * The move for dragging `from` onto `to` (a hand slot, a cell of the case, a whole area as slot -1, the floor or a
 * teammate), or null when the drop means nothing.
 */
export function moveFor(model: InvModel, from: InvRef, to: InvRef, count = 0): InventoryOp | null {
  const src = cellAt(model, from)
  if (!src?.stack || src.def?.bound) return null
  if (from.at === to.at && (from.slot === to.slot || to.slot < 0)) return null
  if (from.at === "target") {
    if (to.at === "target" || to.at === "ground" || to.at === "mate") return null
    if (src.def?.tag === "bag" || to.at === "pack" || to.slot < 0 || to.at === "me") return { from, to: { at: "me", slot: 0 }, count }
    return { from, to, count }
  }
  if (!own(from.at)) return null
  if (to.at === "case") return { from, to, count }
  if (to.at === "target") return model.target ? { from, to: { at: "target", slot: 0 }, count } : null
  if (to.at === "ground" || to.at === "mate") return { from, to, count }
  if (to.at === "hotbar") {
    const slot = to.slot >= 0 ? to.slot : model.hands.findIndex((c) => !c.stack)
    return slot >= 0 ? { from, to: { at: "hotbar", slot }, count } : null
  }
  if (to.at === "pack" && from.at === "hotbar") return { from, to: { at: "pack", slot: 0 }, count }
  return null
}

/**
 * The quick move (click or Shift+click): out of what you face into you; into what you face when it is open; otherwise
 * between your hands and the case.
 */
export function quickMoveFor(model: InvModel, from: InvRef): InventoryOp | null {
  const src = cellAt(model, from)
  if (!src?.stack || src.def?.bound) return null
  if (from.at === "target") return src.blocked ? null : { from, to: { at: "me", slot: 0 } }
  if (model.target) return moveFor(model, from, { at: "target", slot: -1 })
  if (from.at === "hotbar") return moveFor(model, from, { at: "pack", slot: -1 })
  if (from.at === "pack") {
    const tag = src.def?.tag
    return tag === "gun" || tag === "tool" ? moveFor(model, from, { at: "hotbar", slot: -1 }) : null
  }
  return null
}

const AT: readonly InvAt[] = ["hotbar", "pack", "case", "target", "ground", "mate", "me"]

/** Parses a `data-ref` attribute ("pack:2", "mate:3", "ground:0", "target:-1", "case:7"). */
export function parseRef(raw: string | undefined | null): InvRef | null {
  if (!raw) return null
  const [at, slot] = raw.split(":")
  const n = Number(slot)
  if (!at || !Number.isFinite(n)) return null
  if (!(AT as readonly string[]).includes(at)) return null
  return { at: at as InvAt, slot: n }
}

export const refAttr = (ref: InvRef) => `${ref.at}:${ref.slot}`
