import { audio, type SharedAudio } from "../../audio/context"
import type { LoopVoice, Sfx } from "../../audio/engine"

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
  private radio: LoopVoice | null
  private synth: Synth | null = null
  private time = 0
  private nextWhisper = 4
  /** Radio power (ignition), 0..1. */
  radioOn = 0
  /** Engine: 0 off, 1 running; `rpm` follows load and speed. */
  engineOn = 0
  private rpm = 0

  constructor(private sfx: Sfx | null) {
    this.radio = sfx ? sfx.loop("amb-radio-static", { bus: "horror" }) : null
    void sfx?.load("hor-radio-whisper")
    void sfx?.load("int-keys")
    void sfx?.load("light-switch")
    void sfx?.load("door-office-wood")
  }

  /** A one-shot from the library (null-safe). */
  play(id: Parameters<Sfx["play"]>[0], gain: number, extra: Partial<Parameters<Sfx["play"]>[1]> = {}) {
    this.sfx?.play(id, { bus: "doors", gain, jitter: 0.02, ...extra })
  }

  private ensureSynth(): Synth | null {
    const a = audio()
    if (!a) return null
    if (this.synth && this.synth.a === a) return this.synth
    const ctx = a.ctx
    const out = ctx.createGain()
    out.gain.value = 0
    out.connect(a.buses.doors)
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
    // Radio: static wandering as if the dial sits between stations; dips when a voice gets through.
    const drift = 0.5 + 0.5 * noise(t * 0.35, 3) * 0.8 + 0.2 * noise(t * 2.1, 5)
    if (this.radio) {
      this.radio.set(this.radioOn * (0.05 + 0.11 * drift), 1800 + 2600 * drift)
      this.radio.update(dt, t)
    }
    if (this.radioOn > 0.5 && t > this.nextWhisper) {
      this.nextWhisper = t + 7 + Math.random() * 6
      this.sfx?.play("hor-radio-whisper", { bus: "horror", gain: 0.22 * this.radioOn, highpass: 480, lowpass: 2600, jitter: 0.04, offset: Math.random() * 2.5 })
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
    s.hum.gain.setTargetAtTime(0.05 * running * (0.75 + 0.25 * Math.min(1, Math.max(0, accel))), now, 0.08)
    s.road.gain.setTargetAtTime(Math.min(0.09, speed * 0.0075), now, 0.15)
    s.roadBp.frequency.setTargetAtTime(260 + speed * 22, now, 0.2)
    s.out.gain.setTargetAtTime(1, now, 0.3)
  }

  /** Silences everything while the game is paused (the cutscene's frames stop, so `update` doesn't run). */
  setPaused(paused: boolean) {
    const s = this.synth
    if (s) s.out.gain.setTargetAtTime(paused ? 0 : 1, s.a.ctx.currentTime, 0.1)
    if (paused && this.radio) {
      this.radio.set(0)
      this.radio.update(0.5, this.time)
    }
  }

  /** Fades everything out and releases the synth. */
  stop() {
    this.radioOn = 0
    this.engineOn = 0
    this.radio?.set(0)
    this.radio?.update(0.016, this.time)
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
