// Continuous per-vehicle engine voices: jet turbines and the Apache rotor.
import type { VehicleEntity, VehicleKind } from "../sim/types"
import { VEHICLES } from "../sim/vehicles"
import { clamp, type Core, Spatial } from "./core"

/** Relative loudness per airframe, used for voice selection and distance culling. */
export const ENGINE_LOUDNESS: Record<VehicleKind, number> = { fighter: 1, apache: 0.4, warthog: 0.8, blackbird: 1.3 }
export const ENGINE_REF: Record<VehicleKind, number> = { fighter: 40, apache: 22, warthog: 35, blackbird: 50 }

const TC = 0.06

interface Tone { osc: OscillatorNode; gain: GainNode }
interface Noise { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode }

export class EngineVoice {
  readonly spatial: Spatial
  readonly mix: GainNode
  private readonly sources: AudioScheduledSourceNode[] = []
  private readonly nodes: AudioNode[] = []
  private whineA: Tone | null = null
  private whineB: Tone | null = null
  private whistleA: Tone | null = null
  private whistleB: Tone | null = null
  private sub: Tone | null = null
  private tail: Tone | null = null
  private tailFilter: BiquadFilterNode | null = null
  private roar: Noise | null = null
  private roar2: Noise | null = null
  private burner: Noise | null = null
  private crackle: Noise | null = null
  private chop: Noise | null = null
  private own = false
  private doppler = 1
  private burn = 0
  private subBase = 40
  dying = false
  stopAt = Infinity
  /** Selection score this frame (set by the manager). */
  score = 0

  constructor(private core: Core, readonly vehicleId: string, readonly kind: VehicleKind, v: VehicleEntity) {
    const ctx = core.ctx
    this.spatial = new Spatial(core, core.engineBus, v.flight.position, ENGINE_REF[kind], 1, false, true)
    this.mix = ctx.createGain()
    this.mix.gain.value = 0
    this.mix.connect(this.spatial.input)
    const bank = core.bank
    if (kind === "apache") {
      this.chop = this.noise(bank.rotor, "lowpass", 1500, 0.8)
      this.whineA = this.tone("sine", 1700)
      this.whineB = this.tone("sine", 3900)
      this.tailFilter = ctx.createBiquadFilter()
      this.tailFilter.type = "lowpass"
      this.tailFilter.frequency.value = 480
      this.nodes.push(this.tailFilter)
      this.tail = this.tone("sawtooth", 107, this.tailFilter)
      this.roar = this.noise(bank.pink, "lowpass", 600, 0.5)
    } else {
      this.whineA = this.tone("triangle", 400)
      this.whineB = this.tone("sine", 1100)
      this.roar = this.noise(kind === "blackbird" ? bank.brown : bank.pink, "lowpass", 800, 0.5)
      if (kind === "blackbird") this.roar2 = this.noise(bank.pink, "lowpass", 1200, 0.5)
      if (kind === "warthog") {
        this.whistleA = this.tone("sine", 4200)
        this.whistleB = this.tone("sine", 2200)
      } else {
        this.burner = this.noise(bank.brown, "lowpass", kind === "blackbird" ? 180 : 280, 0.7)
        this.crackle = this.noise(bank.crackle, "highpass", kind === "blackbird" ? 900 : 1500, 0.6)
        this.subBase = kind === "blackbird" ? 32 : 42
        this.sub = this.tone("sine", this.subBase)
      }
    }
    const now = ctx.currentTime
    for (const s of this.sources) s.start(now)
    this.mix.gain.setTargetAtTime(1, now, 0.12)
  }

  private tone(type: OscillatorType, freq: number, via?: AudioNode): Tone {
    const ctx = this.core.ctx
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    // Random phase/detune so two identical airframes never phase-lock into a comb filter.
    osc.detune.value = (Math.random() - 0.5) * 30
    const gain = ctx.createGain()
    gain.gain.value = 0
    if (via) {
      osc.connect(via)
      via.connect(gain)
    } else osc.connect(gain)
    gain.connect(this.mix)
    this.sources.push(osc)
    this.nodes.push(gain)
    return { osc, gain }
  }

  private noise(buffer: AudioBuffer, type: BiquadFilterType, freq: number, q: number): Noise {
    const ctx = this.core.ctx
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = freq
    filter.Q.value = q
    const gain = ctx.createGain()
    gain.gain.value = 0
    src.connect(filter)
    filter.connect(gain)
    gain.connect(this.mix)
    this.sources.push(src)
    this.nodes.push(filter, gain)
    return { src, filter, gain }
  }

  /** Per-frame parameter update. `hrtf` = this voice is among the nearest few. */
  update(v: VehicleEntity, own: boolean, hrtf: boolean): void {
    const core = this.core
    const now = core.now
    const f = v.flight
    if (own !== this.own) {
      this.own = own
      this.spatial.setDirect(own)
    }
    if (!own) {
      this.spatial.update(f.position)
      this.spatial.setHrtf(hrtf)
    }
    const dop = own ? 1 : core.doppler(f.position, f.velocity)
    this.doppler += (dop - this.doppler) * 0.35
    const d = this.doppler
    const thr = clamp(f.throttle, 0, 1)
    const vel = f.velocity
    const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2])
    const spec = VEHICLES[this.kind]
    const sn = clamp(speed / spec.boost, 0, 1.3)
    const burnTarget = thr > 0.95 ? (thr - 0.95) / 0.05 : 0
    this.burn += (burnTarget - this.burn) * 0.08
    const b = this.burn
    // Wobble: tiny slow pitch drift so loops feel mechanical rather than synthetic.
    const wob = 1 + Math.sin(now * 1.7 + this.vehicleId.length) * 0.003
    // Own engine heard from the cockpit/chase cam: brighter, more turbine detail.
    const near = own ? 1.25 : 1
    const set = (p: AudioParam, value: number) => p.setTargetAtTime(value, now, TC)

    switch (this.kind) {
      case "fighter": {
        // Twin F404s: mid triangle whine + inharmonic overtone, pink-noise roar, afterburner.
        const fw = (420 + 900 * thr) * d * wob
        set(this.whineA!.osc.frequency, fw)
        set(this.whineA!.gain.gain, (0.04 + 0.06 * thr) * near)
        set(this.whineB!.osc.frequency, fw * 2.76)
        set(this.whineB!.gain.gain, (0.018 + 0.03 * thr) * near)
        set(this.roar!.src.playbackRate, (0.8 + 0.4 * thr) * d)
        set(this.roar!.filter.frequency, (500 + 3000 * Math.pow(thr, 1.3)) * near * d)
        set(this.roar!.gain.gain, 0.2 + 0.32 * thr + 0.08 * sn)
        this.updateBurner(b, 0.55, 0.28, 0.22, d)
        break
      }
      case "blackbird": {
        // J58: deep brown-noise roar dominates, low whine, heavy sub afterburner.
        const fw = (260 + 520 * thr) * d * wob
        set(this.whineA!.osc.frequency, fw)
        set(this.whineA!.gain.gain, (0.03 + 0.04 * thr) * near)
        set(this.whineB!.osc.frequency, fw * 2.76)
        set(this.whineB!.gain.gain, (0.012 + 0.02 * thr) * near)
        set(this.roar!.src.playbackRate, (0.75 + 0.35 * thr) * d)
        set(this.roar!.filter.frequency, (300 + 1200 * thr) * d)
        set(this.roar!.gain.gain, 0.32 + 0.4 * thr)
        set(this.roar2!.src.playbackRate, (0.8 + 0.3 * thr) * d)
        set(this.roar2!.filter.frequency, (900 + 1500 * thr) * near * d)
        set(this.roar2!.gain.gain, 0.06 + 0.12 * thr + 0.06 * sn)
        this.updateBurner(b, 0.7, 0.4, 0.28, d)
        break
      }
      case "warthog": {
        // TF34 high-bypass fans: the famous "vacuum-cleaner" whistle + fan tone, soft roar.
        // No afterburner on an A-10; full throttle just pushes the whistle harder.
        const boost = 1 + 0.35 * b
        const fwh = (3600 + 1600 * thr) * d * wob
        set(this.whistleA!.osc.frequency, fwh)
        set(this.whistleA!.gain.gain, (0.03 + 0.04 * thr) * boost * near)
        set(this.whistleB!.osc.frequency, fwh * 0.53)
        set(this.whistleB!.gain.gain, (0.02 + 0.03 * thr) * boost * near)
        set(this.whineA!.osc.frequency, (260 + 380 * thr) * d * wob)
        set(this.whineA!.gain.gain, (0.04 + 0.04 * thr) * near)
        set(this.whineB!.osc.frequency, (260 + 380 * thr) * 3.1 * d)
        set(this.whineB!.gain.gain, 0.012 + 0.015 * thr)
        set(this.roar!.src.playbackRate, (0.8 + 0.3 * thr) * d)
        set(this.roar!.filter.frequency, (400 + 1400 * thr) * near * d)
        set(this.roar!.gain.gain, 0.14 + 0.22 * thr + 0.06 * sn)
        break
      }
      case "apache": {
        // Governed rotor: rpm barely moves (97–102%); collective loads the blades so the chop
        // gets louder and brighter, and forward speed adds blade-slap brightness.
        const rpm = (0.97 + 0.05 * thr) * d
        set(this.chop!.src.playbackRate, rpm)
        set(this.chop!.filter.frequency, (700 + 1600 * thr + 1200 * sn) * near)
        set(this.chop!.gain.gain, 0.45 + 0.35 * thr)
        set(this.whineA!.osc.frequency, (1650 + 300 * thr) * d * wob)
        set(this.whineA!.gain.gain, (0.018 + 0.02 * thr) * near)
        set(this.whineB!.osc.frequency, (1650 + 300 * thr) * 2.31 * d)
        set(this.whineB!.gain.gain, (0.007 + 0.008 * thr) * near)
        set(this.tail!.osc.frequency, 19.2 * 5.6 * rpm)
        set(this.tail!.gain.gain, 0.06 + 0.04 * thr)
        set(this.roar!.filter.frequency, 500 + 500 * thr)
        set(this.roar!.gain.gain, 0.05 + 0.1 * thr)
        break
      }
    }
  }

  private updateBurner(b: number, roar: number, sub: number, crackle: number, d: number): void {
    const now = this.core.now
    if (!this.burner || !this.sub || !this.crackle) return
    this.burner.gain.gain.setTargetAtTime(roar * b, now, 0.15)
    this.burner.src.playbackRate.setTargetAtTime(d, now, TC)
    this.sub.gain.gain.setTargetAtTime(sub * b, now, 0.15)
    this.sub.osc.frequency.setTargetAtTime(this.subBase * d, now, TC)
    this.crackle.gain.gain.setTargetAtTime(crackle * b * (this.own ? 1.2 : 1), now, 0.15)
  }

  /** Fade out; the manager disposes after `stopAt`. */
  release(): void {
    if (this.dying) return
    this.dying = true
    const now = this.core.now
    this.mix.gain.cancelScheduledValues(now)
    this.mix.gain.setTargetAtTime(0, now, 0.08)
    this.stopAt = now + 0.45
  }

  dispose(): void {
    for (const s of this.sources) {
      try { s.stop() } catch { /* already stopped */ }
      s.disconnect()
    }
    for (const n of this.nodes) n.disconnect()
    this.mix.disconnect()
    this.spatial.dispose()
  }
}

/** Own-vehicle wind rush, rising with airspeed. One shared voice. */
export class Wind {
  private readonly src: AudioBufferSourceNode
  private readonly filter: BiquadFilterNode
  private readonly gain: GainNode

  constructor(private core: Core) {
    const ctx = core.ctx
    this.src = ctx.createBufferSource()
    this.src.buffer = core.bank.pink
    this.src.loop = true
    this.filter = ctx.createBiquadFilter()
    this.filter.type = "bandpass"
    this.filter.Q.value = 0.6
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.src.connect(this.filter)
    this.filter.connect(this.gain)
    this.gain.connect(core.engineBus)
    this.src.start()
  }

  update(speed: number): void {
    const now = this.core.now
    const s = clamp((speed - 20) / 220, 0, 1)
    this.gain.gain.setTargetAtTime(0.28 * Math.pow(s, 1.5), now, 0.1)
    this.filter.frequency.setTargetAtTime(350 + speed * 9, now, 0.1)
  }

  dispose(): void {
    try { this.src.stop() } catch { /* ignore */ }
    this.src.disconnect()
    this.filter.disconnect()
    this.gain.disconnect()
  }
}
