import { CORE } from "../world/layout"
import type { LiftAudio } from "./hooks"
import type { LoopVoice, Sfx } from "./engine"

// The passenger lift's sounds, from its phase changes (src/world/interior/lift.ts → hooks.lift): the scissor gate
// rattling shut and open, the cables taking the load as it departs and creaking now and then on the way, the motor
// loop while it travels (level with speed), the stall clunk when it stops dead between floors, and the arrival bell
// (two takes, alternating). Everything sits at the car, so from a landing it is heard through the shaft walls.

const CX = (CORE.lift.min[0] + CORE.lift.max[0]) / 2
const CZ = (CORE.lift.min[1] + CORE.lift.max[1]) / 2

export class LiftSounds implements LiftAudio {
  private motor: LoopVoice
  private phase = "idle"
  private ding = 0
  private cableIn = 4
  private last = performance.now()
  private pos = { x: CX, y: 0, z: CZ }

  constructor(
    private sfx: Sfx,
    private onUnlock: () => void,
  ) {
    this.motor = sfx.loop("lift-motor", { bus: "doors", positional: true, ref: 2.5, rolloff: 1.1 })
  }

  unlock() {
    this.onUnlock()
  }

  clunk(_strength: number) {
    // Phase changes carry the recorded clunks (stall) and the cable and gate sounds; nothing extra here.
  }

  update(phase: string, vel: number, _light: number, carY: number) {
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    this.pos.y = carY + 1.4
    const at = { bus: "doors" as const, pos: this.pos, ref: 2.5, rolloff: 1.1 }
    if (phase !== this.phase) {
      const prev = this.phase
      this.phase = phase
      if (phase === "closing" || phase === "opening") this.sfx.play("lift-scissor-gate", { ...at, gain: 0.8 })
      else if (phase === "depart") this.sfx.play("lift-cable", { ...at, gain: 0.55 })
      else if (phase === "stall") this.sfx.play("lift-stall", { ...at, gain: 1 })
      else if (phase === "moving" && prev === "stall") this.sfx.play("lift-cable", { ...at, gain: 0.6, rate: 0.95 })
      else if (phase === "level") this.sfx.play("lift-ding", { ...at, gain: 0.85, variant: this.ding++ % 2, jitter: 0 })
    }
    if (phase === "moving") {
      this.cableIn -= dt
      if (this.cableIn <= 0) {
        this.cableIn = 5 + Math.random() * 5
        this.sfx.play("lift-cable", { ...at, gain: 0.3 + Math.random() * 0.2, rate: 0.9 + Math.random() * 0.15 })
      }
    }
    const level = phase === "moving" ? 0.35 + 0.65 * Math.min(1, vel / 0.85) : phase === "depart" || phase === "level" ? 0.3 : 0
    this.motor.at(this.pos.x, this.pos.y, this.pos.z)
    this.motor.set(level * 0.9)
    this.motor.update(dt, now / 1000)
  }
}
