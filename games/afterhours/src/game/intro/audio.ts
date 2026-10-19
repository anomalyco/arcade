import { audio, type SharedAudio } from "../../audio/context"
import type { Sfx } from "../../audio/engine"
import { SFX } from "../../audio/sfx-manifest"

// The drive's sound: the car radio (the shipped `amb-radio-static` loop drifting in and out of a station that isn't
// there, and `hor-radio-whisper` fragments band-limited to a dash speaker), and PLACEHOLDER car sounds synthesised here
// until real takes exist (see the sound list in index.ts): a V8 idle/drive hum, tyre and road roar, and the cabin's
// one-shots borrowed from the library. Everything is quiet by design; the radio is the hook.
//
// Nothing plays until the game's audio is unlocked (a click or key, as everywhere else); in `?shot` mode there is none.

/** Smooth 1D value noise in [-1, 1]. */
function noise(t: number, seed: number) {
  const i = Math.floor(t)
  const f = t - i
  const h = (n: number) => {
    const x = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453
    return (x - Math.floor(x)) * 2 - 1
  }
  const u = f * f * (3 - 2 * f)
  return h(i) * (1 - u) + h(i + 1) * u
}

/**
 * The car's dash speaker: everything the radio plays goes through one small, cheap speaker. Band 300 Hz–3.5 kHz (two
 * 12 dB/oct sections each side), a little cone resonance at 1.4 kHz, then the radio's volume.
 */
type Speaker = {
  a: SharedAudio
  in: GainNode
  staticGain: GainNode
  staticLp: BiquadFilterNode
  src: AudioBufferSourceNode | null
  loading: boolean
  /** Meters (automation): the static alone, the voice alone, the speaker's output, the car (engine + road). */
  meters: { static: AnalyserNode; voice: AnalyserNode; speaker: AnalyserNode; car: AnalyserNode }
}

/** Radio static level at the speaker (linear) and the voice fragments over it. ≈ −46 dB in the whole mix. */
const STATIC_GAIN = 0.075
const VOICE_GAIN = 0.03
/** Engine hum and road roar (linear): about level with the radio. */
const HUM_GAIN = 0.0095
const ROAD_MAX = 0.016

type Synth = {
  a: SharedAudio
  out: GainNode
  hum: GainNode
  oscs: OscillatorNode[]
  lp: BiquadFilterNode
  road: GainNode
  roadBp: BiquadFilterNode
}

export class IntroAudio {
  private speaker: Speaker | null = null
  private synth: Synth | null = null
  private time = 0
  private nextWhisper = 4
  private voiceUntil = 0
  /** Radio power (ignition), 0..1. */
  radioOn = 0
  /** Engine: 0 off, 1 running; `rpm` follows load and speed. */
  engineOn = 0
  private rpm = 0

  constructor(private sfx: Sfx | null) {
    void sfx?.load("hor-radio-whisper")
    void sfx?.load("int-keys")
    void sfx?.load("light-switch")
    void sfx?.load("door-office-wood")
  }

  /** A one-shot from the library (null-safe). */
  play(id: Parameters<Sfx["play"]>[0], gain: number, extra: Partial<Parameters<Sfx["play"]>[1]> = {}) {
    this.sfx?.play(id, { bus: "doors", gain, jitter: 0.02, ...extra })
  }

  private ensureSpeaker(): Speaker | null {
    const a = audio()
    if (!a) return null
    if (this.speaker && this.speaker.a === a) {
      this.startStatic(this.speaker)
      return this.speaker
    }
    const ctx = a.ctx
    const input = ctx.createGain()
    let node: AudioNode = input
    for (const [type, f] of [
      ["highpass", 300],
      ["highpass", 300],
      ["lowpass", 3500],
      ["lowpass", 3500],
    ] as const) {
      const b = ctx.createBiquadFilter()
      b.type = type
      b.frequency.value = f
      b.Q.value = 0.71
      node = node.connect(b)
    }
    const cone = ctx.createBiquadFilter()
    cone.type = "peaking"
    cone.frequency.value = 1400
    cone.Q.value = 1.2
    cone.gain.value = 3
    node = node.connect(cone)
    node.connect(a.buses.horror)
    const meter = () => {
      const m = ctx.createAnalyser()
      m.fftSize = 2048
      return m
    }
    const meters = { static: meter(), voice: meter(), speaker: meter(), car: meter() }
    cone.connect(meters.speaker)
    const staticLp = ctx.createBiquadFilter()
    staticLp.type = "lowpass"
    staticLp.frequency.value = 2400
    const staticGain = ctx.createGain()
    staticGain.gain.value = 0
    staticLp.connect(staticGain).connect(input)
    staticGain.connect(meters.static)
    this.speaker = { a, in: input, staticGain, staticLp, src: null, loading: false, meters }
    this.startStatic(this.speaker)
    return this.speaker
  }

  /** The static loop (the shipped take's inner loop region), started once its buffer is decoded. */
  private startStatic(sp: Speaker) {
    if (sp.src || sp.loading || !this.sfx) return
    const v = SFX["amb-radio-static"].variants[0]
    if (!v) return
    sp.loading = true
    void this.sfx.decoder(v).then((buf) => {
      sp.loading = false
      if (!buf || sp.src || this.speaker !== sp) return
      const src = sp.a.ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      src.loopStart = v.loopStart ?? 0
      src.loopEnd = v.loopEnd ?? buf.duration
      src.connect(sp.staticLp)
      src.start(sp.a.ctx.currentTime, src.loopStart + Math.random() * Math.max(0.01, src.loopEnd - src.loopStart))
      sp.src = src
    })
  }

  /** Automation: RMS dBFS of the static, the voice, the speaker output and the car (engine + road), pre-bus. */
  levels() {
    const sp = this.speaker
    if (!sp) return null
    const buf = new Float32Array(2048)
    const db = (an: AnalyserNode) => {
      an.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      return +(10 * Math.log10(sum / buf.length + 1e-12)).toFixed(1)
    }
    return { static: db(sp.meters.static), voice: db(sp.meters.voice), speaker: db(sp.meters.speaker), car: db(sp.meters.car) }
  }

  private ensureSynth(): Synth | null {
    const a = audio()
    if (!a) return null
    if (this.synth && this.synth.a === a) return this.synth
    const ctx = a.ctx
    const out = ctx.createGain()
    out.gain.value = 0
    out.connect(a.buses.doors)
    const sp = this.ensureSpeaker()
    if (sp) out.connect(sp.meters.car)
    // Engine: two detuned saws at the firing frequency plus a sub at half, through a low-pass (closed hood, firewall).
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 180
    lp.Q.value = 0.9
    const hum = ctx.createGain()
    hum.gain.value = 0
    lp.connect(hum).connect(out)
    const oscs: OscillatorNode[] = []
    for (const [type, detune, g] of [
      ["sawtooth", -7, 0.45],
      ["sawtooth", 6, 0.45],
      ["sine", -1200, 0.8],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = 50
      o.detune.value = detune
      const og = ctx.createGain()
      og.gain.value = g
      o.connect(og).connect(lp)
      o.start()
      oscs.push(o)
    }
    // Tyres on asphalt and wind: band-passed noise that rises with speed.
    const src = ctx.createBufferSource()
    src.buffer = a.noise
    src.loop = true
    const roadBp = ctx.createBiquadFilter()
    roadBp.type = "bandpass"
    roadBp.frequency.value = 380
    roadBp.Q.value = 0.6
    const road = ctx.createGain()
    road.gain.value = 0
    src.connect(roadBp).connect(road).connect(out)
    src.start()
    this.synth = { a, out, hum, oscs, lp, road, roadBp }
    return this.synth
  }

  /** Per frame: radio drift and whispers, engine pitch from speed/load, road noise from speed. */
  update(dt: number, speed: number, accel: number) {
    this.time += dt
    const t = this.time
    // Radio: static wandering as if the dial sits between stations; a fragment of a voice gets through now and then,
    // the static ducking under it.
    const drift = 0.5 + 0.5 * noise(t * 0.35, 3) * 0.8 + 0.2 * noise(t * 2.1, 5)
    const sp = this.ensureSpeaker()
    if (sp) {
      const now = sp.a.ctx.currentTime
      const duck = t < this.voiceUntil ? 0.55 : 1
      sp.staticGain.gain.setTargetAtTime(this.radioOn * STATIC_GAIN * (0.45 + 0.85 * drift) * duck, now, 0.25)
      sp.staticLp.frequency.setTargetAtTime(1600 + 1900 * drift, now, 0.2)
      if (this.radioOn > 0.5 && t > this.nextWhisper) {
        this.nextWhisper = t + 7 + Math.random() * 6
        const src = this.sfx?.play("hor-radio-whisper", { bus: "horror", gain: 0, jitter: 0.04, offset: Math.random() * 2.5 })
        if (src) {
          // Re-route the take into the speaker (the engine connected it to the horror bus through its gain chain).
          src.disconnect()
          const g = sp.a.ctx.createGain()
          g.gain.value = VOICE_GAIN * this.radioOn
          src.connect(g).connect(sp.meters.voice)
          g.connect(sp.in)
          this.voiceUntil = t + (src.buffer?.duration ?? 6) * 0.8
        }
      }
    }
    const s = this.ensureSynth()
    if (!s) return
    const now = s.a.ctx.currentTime
    // V8 firing frequency = rpm / 60 × 4. Idle ~650 rpm; a loose automatic: rpm follows speed and load.
    const target = this.engineOn > 0 ? 650 + speed * 95 + Math.max(0, accel) * 160 : 0
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt * (this.engineOn > 0 ? 2.5 : 1.2)))
    const f = Math.max(8, (this.rpm / 60) * 4)
    for (const o of s.oscs) o.frequency.setTargetAtTime(f, now, 0.05)
    s.lp.frequency.setTargetAtTime(140 + this.rpm * 0.12, now, 0.1)
    const running = Math.min(1, this.rpm / 600)
    s.hum.gain.setTargetAtTime(HUM_GAIN * running * (0.75 + 0.25 * Math.min(1, Math.max(0, accel))), now, 0.08)
    s.road.gain.setTargetAtTime(Math.min(ROAD_MAX, speed * 0.0013), now, 0.15)
    s.roadBp.frequency.setTargetAtTime(260 + speed * 22, now, 0.2)
    s.out.gain.setTargetAtTime(1, now, 0.3)
  }

  /** Silences everything while the game is paused (the cutscene's frames stop, so `update` doesn't run). */
  setPaused(paused: boolean) {
    const s = this.synth
    if (s) s.out.gain.setTargetAtTime(paused ? 0 : 1, s.a.ctx.currentTime, 0.1)
    const sp = this.speaker
    if (sp) sp.in.gain.setTargetAtTime(paused ? 0 : 1, sp.a.ctx.currentTime, 0.1)
  }

  /** Fades everything out and releases the synth. */
  stop() {
    this.radioOn = 0
    this.engineOn = 0
    const sp = this.speaker
    if (sp) {
      sp.in.gain.setTargetAtTime(0, sp.a.ctx.currentTime, 0.15)
      const src = sp.src
      setTimeout(() => {
        try {
          src?.stop()
        } catch {
          // already stopped
        }
        sp.in.disconnect()
      }, 1200)
      this.speaker = null
    }
    const s = this.synth
    if (!s) return
    const now = s.a.ctx.currentTime
    s.out.gain.setTargetAtTime(0, now, 0.2)
    setTimeout(() => {
      for (const o of s.oscs) o.stop()
      s.out.disconnect()
    }, 1500)
    this.synth = null
  }
}
