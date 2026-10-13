import type { FlybyKind } from "./jet-math"
import type { Bus, Mixer } from "./mixer"
import { sfx } from "./sfx-bank"

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

/**
 * Jet one-shots. Flybys and the sonic crack are procedural (timed to the jet's predicted pass, they must stay locked to
 * it). Discrete deck events use one recorded slot each (sfx-bank.ts: the catapult shot, the trap, the gear), with a procedural placeholder until the slot has loaded. Recorded shots go
 * through the bank's spatial chain; procedural ones get a panner, an air-absorption low-pass and reverb/echo sends.
 */
export class JetSfx {
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

  /**
   * The catapult firing: one sound, the recorded shot (thump, steam and the jet tearing away) at the start of the stroke.
   * Until it loads, one procedural thump and whoosh.
   */
  catapult(gain: number, o: ShotOptions = {}): void {
    if (this.play("catapult", { ...o, gain, echo: 0.3 })) return
    this.tone("sine", 75, 32, gain * 0.8, 0.004, 0.7, o)
    this.burst(this.mixer.noise.pink, "lowpass", 600, 2500, 0.6, gain * 0.4, 0.3, 2.2, o)
  }


  /** The afterburner lighting: a soft low whump and a short swell of rumble (the engine voice carries the roar). */
  burnerLight(gain: number, o: ShotOptions = {}): void {
    const n = this.mixer.noise
    this.tone("sine", 62, 30, gain * 0.6, 0.02, 0.6, o)
    this.burst(n.brown, "lowpass", 260, 700, 0.6, gain * 0.7, 0.08, 0.9, o)
    this.burst(n.crackle, "bandpass", 1600, 900, 0.6, gain * 0.15, 0.05, 0.6, o)
  }





  /** The trap: one sound, the recorded touchdown and wire pull-out; until it loads, one procedural thud. */
  trap(gain: number, o: ShotOptions = {}): void {
    if (this.play("trap", { ...o, gain })) return
    this.thunk(gain, o)
  }


  /** The gear locking up: one subtle recorded take; until it loads, one soft thunk. */
  gear(up: boolean, gain: number, o: ShotOptions = {}): void {
    if (this.play("gear", { ...o, gain, rate: up ? 1 : 0.94 })) return
    this.thunk(gain * 0.5, { ...o, delay: (o.delay ?? 0) + 2 })
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

  /** Sends a node into the outdoor reverb and the water slapback. */
  private space(node: AudioNode, reverb: number, echo: number): void {
    const ctx = this.ctx
    if (reverb > 0) {
      const g = ctx.createGain()
      g.gain.value = reverb
      node.connect(g).connect(this.mixer.reverb)
    }
    if (echo > 0) {
      const g = ctx.createGain()
      g.gain.value = echo
      node.connect(g).connect(this.mixer.echo)
    }
  }

  /**
   * The crack of a very fast, very close pass: an N-wave (two sharp cracks 0.11 s apart, the second a little softer), a sub thump under them, and a rolling tail that lives mostly in the reverb and the water's echo.
   */
  boom(gain: number, o: ShotOptions = {}): void {
    const ctx = this.ctx
    const n = this.mixer.noise
    const at = ctx.currentTime + 0.005 + (o.delay ?? 0)
    const { entry } = this.chain(o.at ?? null, o.bus ?? "flyby", o.cutoff ?? 20000)
    const out = ctx.createGain()
    out.gain.value = gain
    out.connect(entry)
    this.space(out, 0.7, 0.5)
    const crack = (t: number, g: number) => {
      const src = ctx.createBufferSource()
      src.buffer = n.white
      const lp = ctx.createBiquadFilter()
      lp.type = "lowpass"
      lp.frequency.setValueAtTime(11000, t)
      lp.frequency.exponentialRampToValueAtTime(1800, t + 0.08)
      const hp = ctx.createBiquadFilter()
      hp.type = "highpass"
      hp.frequency.value = 60
      const e = ctx.createGain()
      e.gain.setValueAtTime(0.0001, t)
      e.gain.linearRampToValueAtTime(g, t + 0.0015)
      e.gain.exponentialRampToValueAtTime(g * 0.25, t + 0.012)
      e.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
      src.connect(hp).connect(lp).connect(e).connect(out)
      src.start(t, Math.random() * 3)
      src.stop(t + 0.15)
    }
    crack(at, 1)
    crack(at + 0.11, 0.8)
    // Sub thump.
    const o2 = ctx.createOscillator()
    o2.frequency.setValueAtTime(52, at)
    o2.frequency.exponentialRampToValueAtTime(24, at + 0.7)
    const sg = ctx.createGain()
    sg.gain.setValueAtTime(0.0001, at)
    sg.gain.linearRampToValueAtTime(0.9, at + 0.008)
    sg.gain.exponentialRampToValueAtTime(0.0001, at + 0.8)
    o2.connect(sg).connect(out)
    o2.start(at)
    o2.stop(at + 0.85)
    // Rolling tail.
    const tail = ctx.createBufferSource()
    tail.buffer = n.brown
    const tlp = ctx.createBiquadFilter()
    tlp.type = "lowpass"
    tlp.frequency.setValueAtTime(500, at)
    tlp.frequency.exponentialRampToValueAtTime(80, at + 2.6)
    const tg = ctx.createGain()
    tg.gain.setValueAtTime(0.0001, at)
    tg.gain.linearRampToValueAtTime(0.7, at + 0.06)
    tg.gain.exponentialRampToValueAtTime(0.0001, at + 2.8)
    tail.connect(tlp).connect(tg).connect(out)
    tail.start(at, Math.random() * 3)
    tail.stop(at + 2.9)
    this.mixer.duck(0.6, 0.5, o.delay ?? 0)
  }

  /**
   * A pass, all procedural so it stays locked to the jet: the closest approach is `t` seconds from now (predicted every
   * frame by jet-math.ts); the engine voice carries the pitch and its Doppler drop, and this adds the air the jet tears
   * through, in three layers that peak at the pass:
   * - the rush: pink noise whose low-pass sweeps up into the pass and falls away after it (the spectral Doppler);
   * - the body: low brown-noise thunder that swells just after the pass and rolls on (more for close, burner passes);
   * - the tear: for the fastest, closest passes, a short bright band sweeping down through the moment of passing.
   * Panned with the jet (`move`), sent to the reverb and (when close) the water slapback.
   */
  flyby(id: number, kind: FlybyKind, t: number, gain: number, _rate: number, at: Where): FlybyHandle | null {
    if (gain < 0.01 || !at) return null
    const ctx = this.ctx
    const n = this.mixer.noise
    const now = ctx.currentTime + 0.005
    const { entry, panner } = this.chain(at, "flyby", 20000)
    const out = ctx.createGain()
    out.gain.value = gain
    out.connect(entry)
    const far = kind === "high"
    this.space(out, far ? 0.6 : 0.35, far ? 0 : 0.22)
    const lead = Math.min(t, far ? 2.4 : 1.7)
    const start = now + t - lead
    const peak = now + t
    const tail = far ? 3.5 : kind === "snap" ? 1.6 : 2.4
    const layer = (buf: AudioBuffer, f0: number, fPeak: number, fEnd: number, g: number, at0: number, pk: number, end: number, hp = 120) => {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      const h = ctx.createBiquadFilter()
      h.type = "highpass"
      h.frequency.value = hp
      h.Q.value = 0.5
      const lp = ctx.createBiquadFilter()
      lp.type = "lowpass"
      lp.Q.value = 0.4
      lp.frequency.setValueAtTime(f0, at0)
      lp.frequency.exponentialRampToValueAtTime(fPeak, pk)
      lp.frequency.exponentialRampToValueAtTime(fEnd, end)
      const e = ctx.createGain()
      e.gain.setValueAtTime(0.0001, at0)
      e.gain.exponentialRampToValueAtTime(g, pk)
      e.gain.exponentialRampToValueAtTime(0.0001, end)
      src.connect(h).connect(lp).connect(e).connect(out)
      src.start(at0, Math.random() * 3)
      src.stop(end + 0.05)
    }
    const top = far ? 1500 : kind === "snap" ? 5200 : kind === "burner" ? 3600 : 3200
    layer(n.pink, top * 0.28, top, top * 0.1, 0.6, start, peak, peak + tail)
    const body = kind === "burner" ? 0.9 : kind === "snap" ? 0.6 : far ? 0.5 : 0.55
    layer(n.brown, 180, 700, 90, body, start + lead * 0.3, peak + 0.15, peak + tail * 1.3, 30)
    if (kind === "snap" || kind === "burner") layer(n.white, 3000, 7000, 1500, 0.18, peak - 0.35, peak - 0.02, peak + 0.5, 1500)
    const pn = panner!
    return {
      id,
      move: (p) => {
        const tt = ctx.currentTime
        pn.positionX.setTargetAtTime(p.x, tt, 0.02)
        pn.positionY.setTargetAtTime(p.y, tt, 0.02)
        pn.positionZ.setTargetAtTime(p.z, tt, 0.02)
      },
      end: peak + tail * 1.3,
    }
  }

}
