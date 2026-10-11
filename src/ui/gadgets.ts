import { GADGETS, LOADOUT, type Role } from "../../shared/config"
import type { CarView } from "../../shared/sim/world"

export type GadgetSlot = {
  key: "Q" | "E"
  id: string
  name: string
  /** 0..1 cooldown remaining (0 = ready). */
  cooldown: number
  /** Seconds until ready. */
  seconds: number
  charges: number
  ready: boolean
  /** The car view carries live gadget state (only the viewer's own car does). */
  live: boolean
}

export const GADGET_ICONS: Record<string, string> = {
  oil: `<svg viewBox="0 0 32 32"><path d="M16 4c4 6 8 10.5 8 15a8 8 0 0 1-16 0c0-4.5 4-9 8-15z" fill="currentColor" opacity=".9"/><path d="M12 20a4 4 0 0 0 4 4" stroke="#000" stroke-opacity=".45" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
  smoke: `<svg viewBox="0 0 32 32" fill="currentColor"><circle cx="11" cy="19" r="6" opacity=".75"/><circle cx="19" cy="15" r="7"/><circle cx="23" cy="21" r="5" opacity=".8"/><rect x="7" y="21" width="20" height="5" rx="2.5" opacity=".7"/></svg>`,
  spike: `<svg viewBox="0 0 32 32" fill="currentColor"><rect x="3" y="21" width="26" height="3" rx="1"/><path d="M5 21l2.5-9 2.5 9zM11 21l2.5-11 2.5 11zM17 21l2.5-9 2.5 9zM23 21l2.5-11 2.5 11z"/></svg>`,
  roadblock: `<svg viewBox="0 0 32 32"><rect x="3" y="10" width="26" height="8" rx="1" fill="currentColor"/><path d="M7 10l-4 8M14 10l-4 8M21 10l-4 8M28 10l-4 8" stroke="#000" stroke-opacity=".55" stroke-width="2.4"/><path d="M7 18v8M25 18v8" stroke="currentColor" stroke-width="2.4"/></svg>`,
}

/** Q / E slots for the HUD, from the car view's gadget state, or the role's loadout when the view doesn't carry it. */
export function gadgetSlots(car: CarView | undefined, role: Role): GadgetSlot[] {
  return LOADOUT[role].map((fallback, i) => {
    const key = i === 0 ? "Q" : "E"
    const g = car?.gadgets?.[i]
    const spec = GADGETS[g?.id ?? fallback]
    if (!g) return { key, id: spec.id, name: spec.name, cooldown: 0, seconds: 0, charges: spec.charges, ready: false, live: false }
    return { key, id: g.id, name: spec.name, cooldown: spec.cooldown > 0 ? Math.min(1, g.cooldown / spec.cooldown) : 0, seconds: g.cooldown, charges: g.charges, ready: g.ready, live: true }
  })
}
