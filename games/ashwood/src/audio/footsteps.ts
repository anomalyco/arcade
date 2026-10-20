import type { WorldContext } from "../world/context"
import type { Player, StepEvent } from "../player"
import { audio } from "./context"
import type { Sfx } from "./engine"
import type { SfxId } from "./sfx-manifest"
import { surfaceAt, type Surface } from "./surfaces"

// The walker's footsteps, driven by `Player.onStep`, from the picked recordings, sliced offline into single steps
// (scripts/audio-build.ts): linoleum, the concrete stairwell (three takes; also every other bare concrete floor), steel
// grating, wet asphalt, gravel and the forest floor. Surfaces without a recording borrow the nearest one, shaped:
// carpet is a muffled, quieter linoleum step; tile and the computer room's access floor are brighter linoleum (the
// access floor with a faint hollow ring); chequer plate is a darker grating step; dry asphalt is a darker concrete one.
// Per step: no-repeat variant, pitch and level jitter, the two feet slightly apart in pitch and pan, level by speed and
// crouch (walk 0 dB, run +6 dB and heavier, crouch −12 dB). Landings add a body thud and the second foot, jumps a
// light scuff. Steps go to the footsteps bus, so they pick up the room or outdoor reverb.

/** A walking step's level (the reference: −6 dB under the first mix, which players found too loud). */
const WALK_LEVEL = 0.22

type Voicing = { id: SfxId; rate: number; gain: number; lowpass?: number; highpass?: number; ring?: number[] }

const VOICING: Record<Surface, Voicing> = {
  linoleum: { id: "foot-linoleum", rate: 1, gain: 1 },
  carpet: { id: "foot-linoleum", rate: 0.93, gain: 0.55, lowpass: 1100 },
  tile: { id: "foot-linoleum", rate: 1.06, gain: 1, highpass: 160 },
  raised: { id: "foot-linoleum", rate: 1.03, gain: 0.9, ring: [210, 470, 1130] },
  wood: { id: "foot-linoleum", rate: 0.9, gain: 0.95, lowpass: 4500 },
  concrete: { id: "foot-stairwell", rate: 1, gain: 1 },
  metal: { id: "foot-grating", rate: 0.9, gain: 0.75, lowpass: 5000 },
  grating: { id: "foot-grating", rate: 1, gain: 0.9 },
  ladder: { id: "foot-grating", rate: 1.15, gain: 0.45, highpass: 300 },
  gravel: { id: "foot-gravel", rate: 1, gain: 1 },
  asphalt: { id: "foot-wet-asphalt", rate: 1, gain: 1 },
  grass: { id: "foot-forest", rate: 1.03, gain: 1 },
  forest: { id: "foot-forest", rate: 1, gain: 1 },
}

export class Footsteps {
  /** Automation: steps played per surface. */
  readonly stats = { surfaces: {} as Record<string, number> }

  constructor(
    private ctx: WorldContext,
    private player: Player,
    private sfx: Sfx,
  ) {
    player.onStep((e) => this.step(e))
  }

  private step(e: StepEvent) {
    const a = audio()
    if (!a) return
    const s = this.player.state
    let surface = surfaceAt(e.surface, s.pos.x, s.pos.y, s.pos.z)
    // Dry asphalt (the Lab's wetness turned down) sounds like concrete outdoors.
    const wet = Number(this.ctx.settings["materials.wetness"] ?? 1)
    if (surface === "asphalt" && Math.random() > wet) surface = "concrete"
    const v = VOICING[surface]
    this.stats.surfaces[surface] = (this.stats.surfaces[surface] ?? 0) + 1
    // Level by gait, relative to a walk (0 dB, quiet): a run's steps +3 dB each, heavier (low boost, a touch lower),
    // which with their faster cadence measures about +7 dB of loudness (scripts/audio-levels.ts); a crouch-walk about
    // −11 dB.
    const crouch = 1 - 0.73 * s.crouch
    const right = e.foot === "right"
    const pan = right ? 0.08 : -0.08
    const foot = right ? 1.015 : 0.985
    if (e.kind === "jump") {
      this.sfx.play(v.id, { bus: "footsteps", gain: 0.35 * v.gain * crouch, rate: v.rate * foot * 1.06, pan, lowpass: v.lowpass, highpass: 200 })
      return
    }
    const run = e.kind === "land" || s.running
    const pace = Math.max(0, Math.min(1, (e.speed - 1.6) / 2.9))
    const gait = WALK_LEVEL * 10 ** ((3 * pace) / 20)
    const level = (e.kind === "land" ? 0.5 + 0.5 * e.intensity : gait) * crouch * v.gain
    this.sfx.play(v.id, {
      bus: "footsteps",
      gain: level * (0.88 + Math.random() * 0.24),
      rate: v.rate * foot * (run ? 0.97 : 1),
      lowBoost: 5 * pace,
      jitter: 0.035,
      pan,
      lowpass: v.lowpass,
      highpass: v.highpass,
    })
    if (v.ring) this.ring(v.ring, 0.12, 0.05 * level)
    if (e.kind === "land") {
      // The body coming down: a low thud under the step, and the second foot a beat later.
      const t = a.ctx.currentTime
      const o = a.ctx.createOscillator()
      o.frequency.setValueAtTime(95, t)
      o.frequency.exponentialRampToValueAtTime(48, t + 0.12)
      const g = a.ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.3 * e.intensity + 0.08, t + 0.006)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
      o.connect(g).connect(a.buses.footsteps)
      o.start(t)
      o.stop(t + 0.3)
      this.sfx.play(v.id, { bus: "footsteps", gain: level * 0.55, rate: v.rate * 0.97, pan: -pan, offset: -0.07, lowpass: v.lowpass })
    }
  }

  /** The access floor's hollow panels: decaying inharmonic partials. */
  private ring(partials: number[], decay: number, gain: number) {
    const a = audio()
    if (!a) return
    const at = a.ctx.currentTime + 0.01
    const detune = 0.97 + Math.random() * 0.06
    partials.forEach((hz, i) => {
      const o = a.ctx.createOscillator()
      o.frequency.value = hz * detune
      const g = a.ctx.createGain()
      const d = decay / (1 + i * 0.6)
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(gain / (1 + i * 0.7), at + 0.002)
      g.gain.exponentialRampToValueAtTime(0.0001, at + d)
      o.connect(g).connect(a.buses.footsteps)
      o.start(at)
      o.stop(at + d + 0.02)
    })
  }
}
