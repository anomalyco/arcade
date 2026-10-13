import type { Strike, Weather } from "../../shared/weather"
import type { WeatherSound } from "../render/weather-system"
import { smoothstep } from "./jet-math"
import { mixer } from "./mixer"
import { type LoopHandle, sfx } from "./sfx-bank"

/**
 * The sea and the weather, from the cinematic sound bank (sfx-bank.ts) once loaded: wide stereo beds for the open ocean
 * by sea state (calm swells, a rough breaking sea, a storm's surf; fading as the camera climbs away from the water), wind
 * (a light breeze, a howling gale, gusting), rain (light, heavy), and thunder (a close crack-and-boom with a lightning
 * snap, or a distant roll) after each strike. The procedural voices below are the placeholders until then:
 * a rain bed (filtered white noise plus a brighter near-patter layer), wind
 * (brown noise through a gusting low-pass), and thunder after each lightning strike, delayed by its distance at the
 * speed of sound and duller the further away it is. Starts on the first user gesture (browsers require one).
 */
export class WeatherAudio implements WeatherSound {
  /** Master volume 0..1. */
  volume = 0.7
  private ctx: AudioContext | null = null
  private master!: GainNode
  private rain!: GainNode
  private patter!: GainNode
  private wind!: GainNode
  private windFilter!: BiquadFilterNode
  private white!: AudioBuffer
  private brown!: AudioBuffer
  private gust = 0
  private time = 0
  private beds: Record<string, LoopHandle | null> = {}

  constructor() {
    const start = () => {
      this.start()
      removeEventListener("pointerdown", start)
      removeEventListener("keydown", start)
    }
    addEventListener("pointerdown", start)
    addEventListener("keydown", start)
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx) return
      if (document.hidden) void this.ctx.suspend()
      else void this.ctx.resume()
    })
  }

  private start(): void {
    if (this.ctx) return
    // The shared mix (mixer.ts): one context for every sound, this one on its own bus.
    const ctx = (this.ctx = mixer().start() as AudioContext | null)
    if (!ctx) return
    const rate = ctx.sampleRate
    const len = rate * 3
    this.white = ctx.createBuffer(2, len, rate)
    this.brown = ctx.createBuffer(2, len, rate)
    for (let c = 0; c < 2; c++) {
      const w = this.white.getChannelData(c)
      const b = this.brown.getChannelData(c)
      let last = 0
      for (let i = 0; i < len; i++) {
        const r = Math.random() * 2 - 1
        w[i] = r
        last = (last + 0.02 * r) / 1.02
        b[i] = last * 3.5
      }
    }
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(mixer().bus.weather)

    const loop = (buf: AudioBuffer) => {
      const s = ctx.createBufferSource()
      s.buffer = buf
      s.loop = true
      s.loopStart = Math.random()
      s.start(0, Math.random() * 2)
      return s
    }
    const filter = (type: BiquadFilterType, freq: number, q = 0.7) => {
      const f = ctx.createBiquadFilter()
      f.type = type
      f.frequency.value = freq
      f.Q.value = q
      return f
    }
    // Rain: a broad hiss, and a brighter close patter.
    this.rain = ctx.createGain()
    this.rain.gain.value = 0
    loop(this.white).connect(filter("lowpass", 6500)).connect(filter("highpass", 400)).connect(this.rain).connect(this.master)
    this.patter = ctx.createGain()
    this.patter.gain.value = 0
    loop(this.white).connect(filter("bandpass", 3200, 0.9)).connect(this.patter).connect(this.master)
    // Wind: brown noise through a low-pass that opens with the gusts.
    this.wind = ctx.createGain()
    this.wind.gain.value = 0
    this.windFilter = filter("lowpass", 400, 1.4)
    loop(this.brown).connect(this.windFilter).connect(this.wind).connect(this.master)
  }

  update(w: Weather, dt: number): void {
    const ctx = this.ctx
    if (!ctx) return
    this.time += dt
    const now = ctx.currentTime
    // Slow, irregular gusts.
    this.gust = 0.5 + 0.3 * Math.sin(this.time * 0.37) + 0.2 * Math.sin(this.time * 1.13 + 1.7)
    const ramp = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.25)
    ramp(this.master.gain, this.volume)
    const m = mixer()
    m.rain = w.rain
    m.sea = w.sea
    // Recorded beds, each wide stereo, crossfaded by sea state, wind and rain.
    const bank = sfx(m)
    const height = m.listener.eye[1]
    const water = 1 - smoothstep(60, 700, height)
    const sea = Math.max(w.sea, w.wind * 0.8)
    const rain = w.rain
    const gale = smoothstep(0.4, 0.9, w.wind)
    const want: Record<string, number> = {
      "ocean-calm": water * 0.8 * (1 - smoothstep(0.2, 0.55, sea)),
      "ocean-rough": water * 0.85 * smoothstep(0.2, 0.55, sea) * (1 - smoothstep(0.6, 0.9, sea)),
      "ocean-storm": water * 0.95 * smoothstep(0.6, 0.9, sea),
      "wind-light": (0.25 + 0.45 * w.wind) * (1 - gale) * (0.7 + 0.3 * this.gust),
      "wind-gale": gale * (0.55 + 0.45 * this.gust),
      "rain-light": smoothstep(0.02, 0.3, rain) * (1 - smoothstep(0.5, 0.9, rain)) * 0.8,
      "rain-heavy": smoothstep(0.4, 0.9, rain) * 0.9,
    }
    let recorded = true
    for (const [slot, level] of Object.entries(want)) {
      let h = this.beds[slot] ?? null
      if (!h && level > 0.005 && bank.ready(slot)) h = this.beds[slot] = bank.loop(slot, { bus: "weather", reverb: 0 })
      if (h && !h.playing) h = this.beds[slot] = null
      if (!bank.ready(slot)) recorded = false
      h?.set({ gain: level, tc: 0.4 })
    }
    const proc = recorded ? 0 : 1
    ramp(this.rain.gain, proc * 0.32 * w.rain ** 1.2)
    ramp(this.patter.gain, proc * 0.12 * w.rain ** 2 * (0.8 + 0.4 * this.gust))
    ramp(this.wind.gain, proc * (0.05 + 0.4 * w.wind ** 2 * (0.6 + 0.6 * this.gust)))
    ramp(this.windFilter.frequency, 250 + 900 * w.wind * this.gust)
  }

  strike(s: Strike, delay: number): void {
    const ctx = this.ctx
    if (!ctx) return
    // Recorded thunder: close strikes crack and boom (with the lightning's snap), far ones roll.
    const bank = sfx(mixer())
    const pan = Math.sin(s.bearing)
    const local = { x: pan * s.dist * 0.6, y: 300, z: -s.dist }
    if (s.dist < 2500 ? bank.play("thunder-near", { local, delay, ref: 600, rolloff: 0.6, gain: 0.9 * s.power, reverb: 0.5, echo: 0.3 }) : bank.play("thunder-far", { local, delay, ref: 1500, rolloff: 0.6, gain: s.power, reverb: 0.6 })) {
      if (s.dist < 900) bank.play("lightning-crack", { local, delay: Math.max(0, delay - 0.05), ref: 500, gain: 0.8 * s.power, reverb: 0.4 })
      return
    }
    const at = ctx.currentTime + delay
    const near = Math.max(0, 1 - s.dist / 6000)
    const loud = (0.25 + 0.75 * near) * s.power
    // Rumble: low-passed noise with a slow, wobbling envelope; a close strike gets a sharp crack first.
    const src = ctx.createBufferSource()
    src.buffer = this.brown
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.setValueAtTime(180 + 900 * near, at)
    lp.frequency.exponentialRampToValueAtTime(90 + 200 * near, at + 4)
    const g = ctx.createGain()
    const length = 3 + 4 * (1 - near) + 2 * s.power
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(loud * 0.9, at + 0.05 + 0.4 * (1 - near))
    let tt = at + 0.4
    for (let i = 0; i < 5; i++) {
      tt += length / 6
      g.gain.linearRampToValueAtTime(loud * (0.3 + 0.5 * Math.random()) * (1 - i / 6), tt)
    }
    g.gain.linearRampToValueAtTime(0, at + length)
    src.connect(lp).connect(g).connect(this.master)
    src.start(at, Math.random() * 2)
    src.stop(at + length + 0.1)
    if (near > 0.4) {
      const crack = ctx.createBufferSource()
      crack.buffer = this.white
      const hp = ctx.createBiquadFilter()
      hp.type = "highpass"
      hp.frequency.value = 900
      const cg = ctx.createGain()
      cg.gain.setValueAtTime(loud * 0.5 * near, at)
      cg.gain.exponentialRampToValueAtTime(0.001, at + 0.5)
      crack.connect(hp).connect(cg).connect(this.master)
      crack.start(at, Math.random())
      crack.stop(at + 0.6)
    }
  }
}
