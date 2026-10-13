import { alignPeak, type FlybyKind } from "./jet-math"
import type { Bus, Mixer } from "./mixer"
import { type Shot, sfx } from "./sfx-bank"

/** A point in listener space (x right, y up, -z ahead), or null: head-locked (your own cockpit). */
export type Where = { x: number; y: number; z: number } | null

export type ShotOptions = {
  at?: Where
  bus?: Bus
  gain?: number
  /** Playback rate (pitch and speed). */
  rate?: number
  /** Seconds from now. */
  delay?: number
  /** Seconds into the take. */
  offset?: number
  /** Air-absorption low-pass (Hz), for the procedural placeholders (the bank computes its own from the position). */
  cutoff?: number
  /** Reverb send and water slapback (recorded takes). */
  reverb?: number
  echo?: number
}

/** A pass in progress: `move` follows the jet until `end`. */
export type FlybyHandle = { id: number; move(at: { x: number; y: number; z: number }): void; end: number }

const FLYBY_SLOT: Record<FlybyKind, string> = { low: "flyby-low", burner: "flyby-burner", snap: "flyby-fast", high: "flyby-distant" }

/**
 * Jet one-shots: the cinematic recorded slots (sfx-bank.ts: flybys, the catapult shot and shuttle slam, the trap, gear,
 * tailhook, the sonic crack), each with a procedural placeholder built from the noise bank that plays until the slot has
 * loaded. Recorded shots go through the bank's spatial chain (distance, air, panning, reverb); placeholders get a fixed
 * panner and an air-absorption low-pass.
 */
export class JetSfx {
  private pick = 0

  constructor(private mixer: Mixer) {}

  private get ctx(): BaseAudioContext {
    return this.mixer.ctx!
  }

  /** The input chain for a shot: [entry] → low-pass → panner (or straight into the bus when head-locked). */
  private chain(at: Where, bus: Bus, cutoff: number, hrtf = true): { entry: AudioNode; panner: PannerNode | null } {
    const ctx = this.ctx
    const dest = this.mixer.bus[bus]
    let node: AudioNode = dest
    let panner: PannerNode | null = null
    if (at) {
      panner = ctx.createPanner()
      panner.panningModel = hrtf ? "HRTF" : "equalpower"
      panner.distanceModel = "linear"
      panner.rolloffFactor = 0
      panner.positionX.value = at.x
      panner.positionY.value = at.y
      panner.positionZ.value = at.z
      panner.connect(dest)
      node = panner
    }
    if (cutoff < 19000) {
      const lp = ctx.createBiquadFilter()
      lp.type = "lowpass"
      lp.frequency.value = cutoff
      lp.Q.value = 0.5
      lp.connect(node)
      node = lp
    }
    return { entry: node, panner }
  }

  /** Plays a recorded slot; false when it has not loaded (play the placeholder). */
  play(slot: string, o: ShotOptions = {}): boolean {
    const at = o.at ?? null
    return !!sfx(this.mixer).play(slot, { local: at ?? undefined, gain: o.gain, rate: o.rate, delay: o.delay, offset: o.offset, bus: o.bus, reverb: at ? o.reverb : (o.reverb ?? 0.05), echo: o.echo, ref: 40 })
  }

  /** A filtered noise burst with an attack and an exponential tail, its filter gliding f0 → f1. */
  burst(buf: AudioBuffer, type: BiquadFilterType, f0: number, f1: number, q: number, gain: number, attack: number, length: number, o: ShotOptions = {}): void {
    if (gain < 0.001) return
    const ctx = this.ctx
    const at = ctx.currentTime + 0.005 + (o.delay ?? 0)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = o.rate ?? 1
    const f = ctx.createBiquadFilter()
    f.type = type
    f.Q.value = q
    f.frequency.setValueAtTime(f0, at)
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + length)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(gain, at + Math.max(0.003, attack))
    g.gain.exponentialRampToValueAtTime(0.0001, at + length)
    src.connect(f).connect(g).connect(this.chain(o.at ?? null, o.bus ?? "sfx", o.cutoff ?? 20000).entry)
    src.start(at, Math.random() * 3)
    src.stop(at + length + 0.05)
  }

  /** A pitched tone gliding f0 → f1 with an attack and an exponential tail. */
  tone(type: OscillatorType, f0: number, f1: number, gain: number, attack: number, length: number, o: ShotOptions = {}): void {
    if (gain < 0.001) return
    const ctx = this.ctx
    const at = ctx.currentTime + 0.005 + (o.delay ?? 0)
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(f0, at)
    osc.frequency.exponentialRampToValueAtTime(Math.max(10, f1), at + length)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(gain, at + Math.max(0.003, attack))
    g.gain.exponentialRampToValueAtTime(0.0001, at + length)
    osc.connect(g).connect(this.chain(o.at ?? null, o.bus ?? "sfx", o.cutoff ?? 20000).entry)
    osc.start(at)
    osc.stop(at + length + 0.05)
  }

  /** A heavy metallic thud: a falling sine plus a short noise knock. */
  thunk(gain: number, o: ShotOptions = {}): void {
    const n = this.mixer.noise
    this.tone("sine", 95, 38, gain, 0.004, 0.45, o)
    this.burst(n.brown, "lowpass", 900, 140, 0.8, gain * 0.9, 0.002, 0.25, o)
    this.burst(n.white, "bandpass", 2200, 900, 1.2, gain * 0.25, 0.001, 0.08, o)
  }

  /** The catapult firing: the shuttle's thunk, the steam's rush along the track, the deck's shudder. */
  catapult(gain: number, o: ShotOptions = {}): void {
    const n = this.mixer.noise
    const recorded = this.play("catapult", { ...o, gain, echo: 0.3 })
    // Always a low thud under it: the deck taking the shot.
    this.tone("sine", 70, 32, gain * (recorded ? 0.5 : 0.8), 0.004, 0.7, o)
    if (recorded) return
    this.thunk(gain * 0.8, o)
    this.burst(n.white, "bandpass", 3800, 1600, 0.7, gain * 0.35, 0.05, 2.6, o)
    this.burst(n.pink, "lowpass", 600, 2500, 0.6, gain * 0.4, 1.2, 2.4, o)
  }

  /** The hold-back bar taking the strain as the engines spool: a metallic clank. */
  holdback(gain: number, o: ShotOptions = {}): void {
    const n = this.mixer.noise
    this.burst(n.white, "bandpass", 1600, 1200, 6, gain * 0.5, 0.001, 0.18, o)
    this.tone("triangle", 410, 380, gain * 0.12, 0.002, 0.25, o)
    this.burst(n.brown, "lowpass", 500, 120, 0.7, gain * 0.5, 0.002, 0.2, o)
  }

  /** The shuttle slamming into the water brake at the bow as the jet leaves. */
  shuttleBrake(gain: number, o: ShotOptions = {}): void {
    if (this.play("shuttle-slam", { ...o, gain, echo: 0.3 })) return
    const n = this.mixer.noise
    this.tone("sine", 60, 30, gain * 0.7, 0.003, 0.9, o)
    this.burst(n.brown, "lowpass", 700, 90, 0.7, gain * 0.8, 0.003, 0.7, o)
    this.burst(n.white, "highpass", 2500, 1200, 0.7, gain * 0.25, 0.002, 0.5, o)
  }

  /** The trap: wheels and hook slam the deck, the wire screams out under tension, the jet stops. */
  trap(gain: number, o: ShotOptions = {}): void {
    const n = this.mixer.noise
    if (this.play("trap", { ...o, gain })) return
    this.thunk(gain, o)
    this.burst(n.pink, "bandpass", 1400, 420, 3, gain * 0.35, 0.05, 1.7, o)
    this.tone("sawtooth", 900, 260, gain * 0.05, 0.05, 1.6, { ...o, cutoff: Math.min(o.cutoff ?? 20000, 3000) })
    this.thunk(gain * 0.5, { ...o, delay: (o.delay ?? 0) + 1.6 })
  }

  /** Gear moving: the hydraulic whirr, then the lock's clunk. */
  gear(up: boolean, gain: number, o: ShotOptions = {}): void {
    const n = this.mixer.noise
    if (this.play("gear", { ...o, gain: gain * 0.8, rate: up ? 1 : 0.94 })) return
    this.tone("sawtooth", 95, up ? 130 : 110, gain * 0.035, 0.15, 2.1, { ...o, cutoff: 900 })
    this.burst(n.pink, "bandpass", 700, 900, 1.5, gain * 0.15, 0.2, 2.1, o)
    this.thunk(gain * 0.6, { ...o, delay: (o.delay ?? 0) + 2.1 })
  }

  /** The tailhook dropping. */
  hook(gain: number, o: ShotOptions = {}): void {
    if (this.play("tailhook", { ...o, gain })) return
    const n = this.mixer.noise
    this.burst(n.white, "bandpass", 1900, 1500, 4, gain * 0.3, 0.001, 0.12, o)
    this.burst(n.brown, "lowpass", 600, 150, 0.7, gain * 0.5, 0.002, 0.25, o)
  }

  /** A crash: a big blast and its long tail; into the sea, the splash take on top. */
  crash(water: boolean, gain: number, o: ShotOptions = {}): void {
    const n = this.mixer.noise
    this.tone("sine", 70, 24, gain * 0.9, 0.004, 1.6, o)
    this.burst(n.brown, "lowpass", 2200, 80, 0.7, gain * 1.1, 0.004, 3.4, o)
    this.burst(n.pink, "lowpass", 900, 120, 0.6, gain * 0.5, 0.3, 4.5, o)
    this.burst(n.crackle, "bandpass", 2400, 700, 0.6, gain * 0.5, 0.05, 2.2, o)
    this.mixer.duck(0.45, 1.2, o.delay ?? 0)
  }

  /** The crack of a very fast, very close pass. */
  boom(gain: number, o: ShotOptions = {}): void {
    if (this.play("sonic-crack", { ...o, gain, echo: 0.5, reverb: 0.6 })) return
    const n = this.mixer.noise
    // An N-wave: two sharp cracks a tenth of a second apart, then a rolling tail.
    this.burst(n.white, "lowpass", 9000, 2000, 0.5, gain, 0.001, 0.09, o)
    this.burst(n.white, "lowpass", 9000, 2000, 0.5, gain * 0.8, 0.001, 0.09, { ...o, delay: (o.delay ?? 0) + 0.11 })
    this.burst(n.brown, "lowpass", 400, 60, 0.7, gain, 0.01, 2.2, o)
  }

  /**
   * A pass: the recorded take for its kind lined up so its loudest moment lands at the closest approach (`t` seconds
   * from now), its panner left for the caller to move with the jet. The fallback is a swept noise whoosh with the same
   * timing. Returns the handle (null when culled).
   */
  flyby(id: number, kind: FlybyKind, t: number, gain: number, rate: number, at: Where): FlybyHandle | null {
    if (gain < 0.01 || !at) return null
    const ctx = this.ctx
    const bank = sfx(this.mixer)
    const slot = FLYBY_SLOT[kind]
    const loudest = bank.info(slot)?.peak
    const now = ctx.currentTime + 0.005
    if (loudest !== undefined && bank.ready(slot)) {
      const { delay, offset } = alignPeak(t, loudest / rate)
      const shot: Shot | null = bank.play(slot, { local: at, gain, rate, delay, offset: offset * rate, bus: "flyby", ref: 60, rolloff: 0.4, echo: kind === "high" ? 0 : 0.25 })
      if (shot) return { id, move: (p) => shot.move({ local: p }), end: shot.end }
    }
    const { entry, panner } = this.chain(at, "flyby", 20000)
    // Procedural: an air rush that swells to the pass and falls away, its low-pass sweeping up into the pass and down
    // after it (the engine voice's own Doppler carries the pitch drop). Smooth: pink noise, low Q, no band-pass edge.
    const n = this.mixer.noise
    const lead = Math.min(t, kind === "high" ? 2.2 : 1.6)
    const start = now + t - lead
    const peak = now + t
    const tail = kind === "high" ? 3 : kind === "snap" ? 1.2 : 2
    const top = kind === "high" ? 1400 : kind === "snap" ? 4200 : 3200
    const src = ctx.createBufferSource()
    src.buffer = n.pink
    src.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.Q.value = 0.4
    lp.frequency.setValueAtTime(top * 0.3, start)
    lp.frequency.exponentialRampToValueAtTime(top, peak)
    lp.frequency.exponentialRampToValueAtTime(top * 0.12, peak + tail)
    const hp = ctx.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.value = 120
    hp.Q.value = 0.5
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, start)
    g.gain.exponentialRampToValueAtTime(gain * 0.6, peak)
    g.gain.exponentialRampToValueAtTime(0.0001, peak + tail)
    src.connect(hp).connect(lp).connect(g).connect(entry)
    src.start(start, Math.random() * 3)
    src.stop(peak + tail + 0.05)
    const pn = panner!
    return {
      id,
      move: (p) => {
        const tt = ctx.currentTime
        pn.positionX.setTargetAtTime(p.x, tt, 0.02)
        pn.positionY.setTargetAtTime(p.y, tt, 0.02)
        pn.positionZ.setTargetAtTime(p.z, tt, 0.02)
      },
      end: peak + tail,
    }
  }
}
