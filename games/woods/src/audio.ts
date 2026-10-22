import { SoundBank } from "@arcade/kit/audio"
import { Footsteps, type FootEvent, type FootSurface } from "@arcade/kit/audio/footsteps"

import { WOODS_SFX } from "./sfx"

/**
 * The shared sound bank for library cues plus the shared quiet material footsteps (same bank as Night Shift and the
 * Lot) on their own gain, following the bank's master volume and mute.
 */
export class WoodsAudio {
  readonly bank = new SoundBank("woods", WOODS_SFX)
  private feet: Footsteps | null = null
  private out: GainNode | null = null
  private bed = false

  private ready(): boolean {
    const ctx = this.bank.runtime.ctx
    if (!ctx || ctx.state !== "running" || this.bank.runtime.isOffline) return false
    if (!this.out) {
      this.out = ctx.createGain()
      this.out.connect(ctx.destination)
      this.feet = new Footsteps(ctx, this.out)
    }
    if (!this.bed) { this.bed = true; this.bank.play("ambience.night.suburb") }
    return true
  }

  frame(x: number, z: number): void {
    this.bank.listen(x, z, 1.7)
    if (!this.ready()) return
    const v = this.bank.muted ? 0 : (this.bank.volumes.volumeMaster / 100) * (this.bank.volumes.volumeEffects / 100)
    this.out!.gain.setTargetAtTime(v, this.out!.context.currentTime, 0.05)
  }

  /** Footstep and cloth contacts from the walk clock (`Walk.events`, sample-accurate) or a friend's gait. */
  steps(events: readonly FootEvent[], surface: FootSurface, walkTime: number, gain = 1): void {
    if (!this.ready() || !events.length) return
    this.feet!.play(events, surface, walkTime, gain)
  }

  play(id: (typeof WOODS_SFX)[number], x?: number, z?: number, gain = 1): void {
    this.bank.play(id, x, z, { gain })
  }
}
