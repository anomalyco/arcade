import type { StoreState } from "@arcade/kit/sim/ledger"
import { CLUE_CODE, EVENT_BLOWN, EVENT_CUT, EVENT_ESCAPED, EVENT_HOTWIRED, EVENT_LEFT_BEHIND, EVENT_MISSED, EVENT_SIGNAL } from "../../shared/way-out/clues"
import { WAY_OUT_STORE } from "../../shared/way-out/state"
import type { SoundHold } from "../audio/inventory"
import type { SoundEvent } from "../audio/types"

const CLUES = new Set(Object.values(CLUE_CODE))

/**
 * The Way Out's sounds (AR-64), from the `wayout` store alone like the rest of the director, so a co-op client hears
 * what the room did: paper for a clue, tinkering while a car is hotwired and the click when it catches, the cutters
 * working at a padlock and the gate swinging, metal coming down when a roadblock is blown, the flare at the signal,
 * and a chime when the squad gets out. Library samples only.
 */
export class WayOutSounds {
  private lastAt = 0

  reset(): void {
    this.lastAt = 0
  }

  observe(ledger: { readonly stores: ReadonlyMap<string, StoreState> } | undefined, listener: { x: number; y: number }, emit: (e: SoundEvent) => void, holds: SoundHold[]): void {
    const st = ledger?.stores.get(WAY_OUT_STORE)
    if (!st) {
      this.lastAt = 0
      return
    }
    const c = st.counts
    const hx = (c.hx ?? 0) / 10
    const hy = (c.hy ?? 0) / 10
    if (c.hw) holds.push({ key: "wayout:hotwire", id: "craft.tinker.loop", x: hx, y: hy })
    if (c.cut) holds.push({ key: "wayout:cut", id: "door.pry.loop", x: hx, y: hy })
    const at = c.lastAt ?? 0
    if (at === this.lastAt) return
    this.lastAt = at
    const code = c.last ?? 0
    const ex = (c.ex ?? 0) / 10
    const ey = (c.ey ?? 0) / 10
    const here = { x: listener.x, y: listener.y, source: "wayout" }
    const there = { x: ex, y: ey, source: "wayout" }
    if (CLUES.has(code)) emit({ id: "pickup.item", ...here, gain: 0.9, rate: 0.82 })
    else if (code === EVENT_HOTWIRED) {
      emit({ id: "craft.tinker.done", ...there })
      emit({ id: "flashlight.click", ...there, gain: 1.4, rate: 0.6, delay: 0.25 })
    } else if (code === EVENT_CUT) {
      emit({ id: "melee.break", ...there, gain: 1.1, rate: 1.3 })
      emit({ id: "door.wood.open", ...there, gain: 1.2, rate: 0.62, delay: 0.3 })
    } else if (code === EVENT_BLOWN) {
      emit({ id: "melee.hit.metal", ...there, gain: 1.3, rate: 0.7, delay: 0.18 })
      emit({ id: "impact.bullet.metal", ...there, gain: 1.1, rate: 0.6, delay: 0.42 })
    } else if (code === EVENT_SIGNAL) emit({ id: "flare.ignite", ...there, gain: 1.5, rate: 0.66 })
    else if (code === EVENT_ESCAPED) emit({ id: "bench.research.done", ...here, gain: 1.2, rate: 0.8 })
    else if (code === EVENT_MISSED || code === EVENT_LEFT_BEHIND) emit({ id: "zombie.groan.idle", ...here, gain: 0.7, rate: 0.7 })
  }
}
