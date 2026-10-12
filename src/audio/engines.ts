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
  private whistleA: Tone | null = null
  private sub: Tone | null = null
  private tail: Tone | null = null
  private tailFilter: BiquadFilterNode | null = null
  private roar: Noise | null = null
  private roar2: Noise | null = null
  private burner: Noise | null = null
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
    // Smooth, natural engines: noise roar does the work, tones are quiet sines kept under ~2.5 kHz.
    if (kind === "apache") {
      this.chop = this.noise(bank.rotor, "lowpass", 900, 0.5)
      this.whineA = this.tone("sine", 1150)
      this.tailFilter = ctx.createBiquadFilter()
      this.tailFilter.type = "lowpass"
      this.tailFilter.frequency.value = 250
      this.nodes.push(this.tailFilter)
      this.tail = this.tone("triangle", 107, this.tailFilter)
      this.roar = this.noise(bank.pink, "lowpass", 500, 0.5)
    } else {
      this.whineA = this.tone("sine", 300)
      // Roar = brighter pink layer (filter opens with throttle) over a deep brown body.
      this.roar = this.noise(bank.pink, "lowpass", 600, 0.5)
      this.roar2 = this.noise(bank.brown, "lowpass", 300, 0.5)
      if (kind === "warthog") {
        this.whistleA = this.tone("sine", 2000)
      } else {
        this.burner = this.noise(bank.brown, "lowpass", kind === "blackbird" ? 160 : 220, 0.6)
        this.subBase = kind === "blackbird" ? 32 : 40
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

    const roar = (lpBase: number, lpRange: number, gBase: number, gRange: number, rate: number) => {
      set(this.roar!.src.playbackRate, (0.85 + 0.25 * thr) * d * rate)
      set(this.roar!.filter.frequency, (lpBase + lpRange * Math.pow(thr, 1.2)) * near * d)
      set(this.roar!.gain.gain, gBase + gRange * thr + 0.06 * sn)
    }
    const body = (lpBase: number, lpRange: number, gBase: number, gRange: number) => {
      set(this.roar2!.src.playbackRate, (0.85 + 0.2 * thr) * d)
      set(this.roar2!.filter.frequency, (lpBase + lpRange * thr) * d)
      set(this.roar2!.gain.gain, gBase + gRange * thr)
    }
    const hum = (f0: number, f1: number, g0: number, g1: number) => {
      set(this.whineA!.osc.frequency, (f0 + f1 * thr) * d * wob)
      set(this.whineA!.gain.gain, (g0 + g1 * thr) * near)
    }

    switch (this.kind) {
      case "fighter":
        // Twin F404s: a smooth roar that opens up with throttle, faint turbine hum, afterburner rumble.
        roar(350, 1400, 0.2, 0.3, 1)
        body(220, 260, 0.25, 0.25)
        hum(280, 420, 0.01, 0.018)
        this.updateBurner(b, 0.55, 0.25, d)
        break
      case "blackbird":
        // J58: deeper and heavier — the brown body dominates.
        roar(280, 1000, 0.12, 0.2, 0.9)
        body(180, 300, 0.35, 0.4)
        hum(200, 320, 0.008, 0.014)
        this.updateBurner(b, 0.7, 0.35, d)
        break
      case "warthog": {
        // TF34 high-bypass fans: softer roar + the A-10's whistle, kept low and quiet.
        // No afterburner on an A-10; full throttle just pushes the whistle a little harder.
        roar(400, 1000, 0.14, 0.22, 1)
        body(200, 200, 0.16, 0.16)
        hum(220, 300, 0.016, 0.016)
        set(this.whistleA!.osc.frequency, (1800 + 800 * thr) * d * wob)
        set(this.whistleA!.gain.gain, (0.01 + 0.014 * thr) * (1 + 0.3 * b) * near)
        break
      }
      case "apache": {
        // Governed rotor: rpm barely moves (97–102%); collective and forward speed make the
        // chop louder and a little brighter.
        const rpm = (0.97 + 0.05 * thr) * d
        set(this.chop!.src.playbackRate, rpm)
        set(this.chop!.filter.frequency, (500 + 700 * thr + 500 * sn) * near)
        set(this.chop!.gain.gain, 0.45 + 0.35 * thr)
        set(this.whineA!.osc.frequency, (1100 + 200 * thr) * d * wob)
        set(this.whineA!.gain.gain, (0.006 + 0.006 * thr) * near)
        set(this.tail!.osc.frequency, 19.2 * 5.6 * rpm)
        set(this.tail!.gain.gain, 0.03 + 0.02 * thr)
        set(this.roar!.filter.frequency, 400 + 300 * thr)
        set(this.roar!.gain.gain, 0.05 + 0.1 * thr)
        break
      }
    }
  }

  private updateBurner(b: number, roar: number, sub: number, d: number): void {
    const now = this.core.now
    if (!this.burner || !this.sub) return
    this.burner.gain.gain.setTargetAtTime(roar * b, now, 0.15)
    this.burner.src.playbackRate.setTargetAtTime(d, now, TC)
    this.sub.gain.gain.setTargetAtTime(sub * b, now, 0.15)
    this.sub.osc.frequency.setTargetAtTime(this.subBase * d, now, TC)
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
