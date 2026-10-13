import { clamp, smoothstep } from "./jet-math"
import type { Mixer } from "./mixer"
import { type LoopHandle, sfx } from "./sfx-bank"

/** What ship-audio needs of a carrier this frame (shared/ship.ts Ship satisfies it). */
export type ShipLike = { x: number; z: number; heave: number; slams: number; slam: number }

/** Deck height above the waterline (m), for the listener's height on board. */
const DECK = 20

/**
 * The carriers you are near: the deck ambience bed (hull hum, machinery, deck wind; full on deck, fading out by ~700 m
 * and as you climb away), a hull slam when a bow buries itself in a wave (shared/ship.ts `slams`), creaks of the hull
 * working in heavy seas, and now and then the ship's horn. Everything from the sound bank (sfx-bank.ts); silent until
 * those slots load. Deck fires and sinking are registered slots (`deck-fire`, `sinking`) for the ship-damage code to
 * play through `sfx()`.
 */
export class ShipAudio {
  private bed: LoopHandle | null = null
  private slams = new Map<number, number>()
  private creakIn = 8
  private hornIn = 90 + Math.random() * 120

  constructor(private mixer: Mixer) {}

  update(dt: number, ships: Iterable<[number, ShipLike]>): void {
    const bank = sfx(this.mixer)
    const L = this.mixer.listener
    let near: ShipLike | null = null
    let best = Number.POSITIVE_INFINITY
    for (const [id, s] of ships) {
      const d = Math.hypot(s.x - L.eye[0], s.z - L.eye[2])
      if (d < best) {
        best = d
        near = s
      }
      // A slam: the bow burying itself in a wave.
      const prev = this.slams.get(id)
      if (prev !== undefined && s.slams > prev && d < 2500) bank.play("hull-slam", { at: [s.x, s.heave + 4, s.z], ref: 120, gain: clamp(0.6 + 0.6 * s.slam, 0.4, 1.2), echo: 0.3, travel: true })
      this.slams.set(id, s.slams)
    }
    // The deck bed: close to a hull and low.
    const h = L.eye[1] - ((near?.heave ?? 0) + DECK)
    const level = near ? (1 - smoothstep(120, 700, best)) * (1 - smoothstep(40, 400, h)) : 0
    if (!this.bed && level > 0.01 && bank.ready("carrier-bed")) this.bed = bank.loop("carrier-bed", { bus: "weather", reverb: 0 })
    if (this.bed && !this.bed.playing) this.bed = null
    this.bed?.set({ gain: level * 0.9 })
    if (!near || best > 600) return
    // The hull working in a big sea.
    const sea = this.mixer.sea
    if (sea > 0.55) {
      this.creakIn -= dt * sea
      if (this.creakIn <= 0) {
        this.creakIn = 6 + Math.random() * 10
        bank.play("hull-creak", { at: [near.x, near.heave + 6, near.z], ref: 150, gain: 0.5 + 0.5 * sea })
      }
    }
    // The horn, rarely.
    this.hornIn -= dt
    if (this.hornIn <= 0) {
      this.hornIn = 150 + Math.random() * 240
      bank.play("ship-horn", { at: [near.x, near.heave + 40, near.z], ref: 300, gain: 0.55, echo: 0.4, reverb: 0.7, travel: true })
    }
  }
}

/** The crew's ships as drawn this frame, for `JetAudio.ships` (skips any not drawn). */
export function* drawnShips(ships: Iterable<{ id: number }>, shipOf: (id: number) => ShipLike | null): Generator<[number, ShipLike]> {
  for (const s of ships) {
    const d = shipOf(s.id)
    if (d) yield [s.id, d]
  }
}
