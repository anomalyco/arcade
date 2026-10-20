import { HOTBAR_SIZE } from "./progression/catalog"
import type { OutbreakProgression } from "./progression/progression"

export { HOTBAR_SIZE }

/** One hotbar slot as the HUD and tests read it. The progression ledger holds the real stack. */
export type InventoryItem = {
  id: string
  kind: string
  label: string
  shortLabel: string
  charge?: number
  count?: number
  active?: boolean
}

export type InventoryState = {
  slots: (InventoryItem | null)[]
  selectedSlot: number
}

/** The actor's hotbar from the ledger. The shoulder light is not a slot: it is the survivor's `flashlightOn`/`battery`. */
export function inventoryView(
  progression: OutbreakProgression,
  actor: string,
  _survivor?: { flashlightOn: boolean; battery: number },
): InventoryState {
  const hotbar = progression.hotbar(actor)
  const slots: (InventoryItem | null)[] = Array.from({ length: HOTBAR_SIZE }, (_, i) => {
    const s = hotbar?.slots[i]
    if (!s) return null
    const def = progression.ledger.items.get(s.item)
    const item: InventoryItem = { id: s.item, kind: s.item, label: def?.label ?? s.item, shortLabel: def?.shortLabel ?? s.item }
    if (s.charge !== undefined) item.charge = s.charge
    if ((def?.stack ?? 1) > 1) item.count = s.count
    return item
  })
  return { slots, selectedSlot: hotbar?.selected ?? 0 }
}
