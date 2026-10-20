import { setLevels, unlockAudio, type SharedAudio } from "../../audio/context"

// The loading screen's sound, synthesised (no assets): the shared noise buffer through a full-band path and a bandpassed
// path that narrows as the signal comes in, random swells, sparse crackles, a faint formant "voice" mid-way, and a
// relay-like thunk at the lock, after which it falls silent. Everything goes through a 5 kHz low-pass, the player's
// "Menu static" volume and an analyser into the shared "ui" bus (scaled by the SFX slider; the master volume applies).
// Silent until a user input starts it; never starts after the lock.

type Graph = {
  a: SharedAudio
  out: GainNode
  level: GainNode
  analyser: AnalyserNode
  harsh: GainNode
  band: GainNode
  bp: BiquadFilterNode
  crackle: GainNode
  voice: GainNode
  syllable: GainNode
  saw: OscillatorNode
  sources: AudioScheduledSourceNode[]
}

/** Level of every static layer (hiss, swells, crackles, ghost voice): −18 dB from the first take. The thunk is apart. */
const STATIC_GAIN = 0.125
/** Crackles a further −6 dB on top. */
const CRACKLE_GAIN = 0.5
/** The "Menu static" setting that plays at STATIC_GAIN; the slider scales linearly from it (0 = off). */
export const MENU_STATIC_DEFAULT = 0.25
/** The lock thunk's level (about −2 dB from its first take). */
const THUNK_GAIN = 0.8

const bump = (x: number, c: number, w: number) => Math.max(0, 1 - ((x - c) / w) ** 2)

export function createTunerAudio() {
  let graph: Graph | null = null
  let locked = false
  let swell = 1
  let nextSwell = 0
  let nextCrackle = 0
  let nextSyllable = 0
  let volume = MENU_STATIC_DEFAULT
  const buf = new Float32Array(1024)

  function build(a: SharedAudio): Graph {
    const { ctx } = a
    const t = ctx.currentTime
    const out = ctx.createGain()
    out.gain.setValueAtTime(0, t)
    out.gain.setTargetAtTime(1, t, 0.25)
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 5000
    lp.Q.value = 0.5
    const level = ctx.createGain()
    level.gain.value = volume / MENU_STATIC_DEFAULT
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    out.connect(lp).connect(level).connect(analyser)
    analyser.connect(a.buses.ui)

    const noise = (rate: number) => {
      const s = ctx.createBufferSource()
      s.buffer = a.noise
      s.loop = true
      s.playbackRate.value = rate
      s.start(t, Math.random() * 1.5)
      return s
    }
    const n1 = noise(1)
    const n2 = noise(0.83)
    // Harsh: full-band snow, top end pushed.
    const shelf = ctx.createBiquadFilter()
    shelf.type = "highshelf"
    shelf.frequency.value = 3200
    shelf.gain.value = -4
    const harsh = ctx.createGain()
    harsh.gain.value = 0
    n1.connect(shelf).connect(harsh).connect(out)
    // Tuned: a bandpass that narrows and rises as the signal strengthens.
    const bp = ctx.createBiquadFilter()
    bp.type = "bandpass"
    bp.frequency.value = 800
    bp.Q.value = 0.7
    const band = ctx.createGain()
    band.gain.value = 0
    n1.connect(bp).connect(band).connect(out)
    // Crackles: short high-passed bursts.
    const hp = ctx.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.value = 2400
    const crackle = ctx.createGain()
    crackle.gain.value = 0
    n2.connect(hp).connect(crackle).connect(out)
    // The ghost voice: a buzzing source through two vowel formants, gated in syllables, telephone-band.
    const saw = ctx.createOscillator()
    saw.type = "sawtooth"
    saw.frequency.value = 118
    const vib = ctx.createOscillator()
    vib.frequency.value = 5.2
    const vibDepth = ctx.createGain()
    vibDepth.gain.value = 2.5
    vib.connect(vibDepth).connect(saw.frequency)
    const syllable = ctx.createGain()
    syllable.gain.value = 0
    const voice = ctx.createGain()
    voice.gain.value = 0
    const tel = ctx.createBiquadFilter()
    tel.type = "bandpass"
    tel.frequency.value = 1300
    tel.Q.value = 0.8
    for (const [f, q] of [
      [660, 6],
      [1180, 7],
    ] as const) {
      const fm = ctx.createBiquadFilter()
      fm.type = "bandpass"
      fm.frequency.value = f
      fm.Q.value = q
      saw.connect(fm).connect(syllable)
    }
    syllable.connect(voice).connect(tel).connect(out)
    saw.start(t)
    vib.start(t)
    return { a, out, level, analyser, harsh, band, bp, crackle, voice, syllable, saw, sources: [n1, n2, saw, vib] }
  }

  /** Start (or resume) from a user-input handler. `levels`: the player's master and ui-bus volumes. */
  function start(levels: { master: number; ui: number; menuStatic: number }) {
    volume = levels.menuStatic
    if (graph || locked || volume <= 0) return
    const a = unlockAudio()
    if (!a) return
    setLevels(levels.master, { ui: levels.ui })
    graph = build(a)
  }

  /** The "Menu static" slider, live. */
  function setVolume(v: number) {
    volume = v
    if (graph) graph.level.gain.setTargetAtTime(v / MENU_STATIC_DEFAULT, graph.a.ctx.currentTime, 0.05)
  }

  /** Per frame with the tuner's signal (0..1). */
  function update(signal: number) {
    if (!graph || locked) return
    const { a, harsh, band, bp, crackle, voice, syllable, saw } = graph
    const t = a.ctx.currentTime
    const s = Math.min(1, Math.max(0, signal))
    if (t >= nextSwell) {
      // Swells: the hiss breathes, wider early on.
      swell = 1 + (Math.random() * 2 - 1) * (0.25 + 0.35 * (1 - s))
      nextSwell = t + 0.25 + Math.random() * 0.7
    }
    harsh.gain.setTargetAtTime(STATIC_GAIN * 0.32 * (1 - s) ** 1.6 * swell, t, 0.08)
    band.gain.setTargetAtTime(STATIC_GAIN * (0.14 * Math.sin(Math.PI * Math.min(1, s * 1.05)) ** 0.6 + 0.02) * (0.7 + 0.3 * swell), t, 0.1)
    bp.frequency.setTargetAtTime(700 + 1800 * s, t, 0.2)
    bp.Q.setTargetAtTime(0.7 + 5 * s, t, 0.2)
    if (t >= nextCrackle) {
      const amp = 0.25 + Math.random() * 0.5
      crackle.gain.setValueAtTime(STATIC_GAIN * CRACKLE_GAIN * amp * (0.4 + 0.6 * (1 - s)), t)
      crackle.gain.setTargetAtTime(0, t + 0.004, 0.008 + Math.random() * 0.02)
      const rate = 4 * (1 - s) + 0.6
      nextCrackle = t - Math.log(1 - Math.random()) / rate
    }
    voice.gain.setTargetAtTime(STATIC_GAIN * 0.06 * bump(s, 0.62, 0.28), t, 0.3)
    if (t >= nextSyllable) {
      const on = Math.random() < 0.62
      syllable.gain.setTargetAtTime(on ? 1 : 0, t, 0.025)
      if (on) saw.frequency.setTargetAtTime(100 + Math.random() * 40, t, 0.05)
      nextSyllable = t + 0.09 + Math.random() * (on ? 0.22 : 0.35)
    }
  }

  /** The lock: a thunk, the static drops to a whisper (or starts there if it wasn't playing yet). */
  function lock() {
    locked = true
    if (!graph) return
    const { a, out, harsh, band, bp, crackle, voice } = graph
    const { ctx } = a
    const t = ctx.currentTime
    harsh.gain.cancelScheduledValues(t)
    harsh.gain.setTargetAtTime(0, t, 0.03)
    crackle.gain.cancelScheduledValues(t)
    crackle.gain.setTargetAtTime(0, t, 0.02)
    voice.gain.setTargetAtTime(0, t, 0.05)
    // Silence after the lock: the hiss dies under the thunk and the nodes are freed.
    band.gain.setTargetAtTime(0, t + 0.05, 0.2)
    thunk(a, out)
    setTimeout(() => stop(0.4), 1600)
  }

  function thunk(a: SharedAudio, out: AudioNode) {
    const { ctx } = a
    const t = ctx.currentTime + 0.01
    const osc = ctx.createOscillator()
    osc.frequency.setValueAtTime(92, t)
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.18)
    const og = ctx.createGain()
    og.gain.setValueAtTime(0, t)
    og.gain.linearRampToValueAtTime(THUNK_GAIN * 0.55, t + 0.004)
    og.gain.setTargetAtTime(0, t + 0.01, 0.06)
    osc.connect(og).connect(out)
    osc.start(t)
    osc.stop(t + 0.6)
    const click = ctx.createBufferSource()
    click.buffer = a.noise
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 1100
    const cg = ctx.createGain()
    cg.gain.setValueAtTime(THUNK_GAIN * 0.35, t)
    cg.gain.setTargetAtTime(0, t, 0.012)
    click.connect(lp).connect(cg).connect(out)
    click.start(t, Math.random())
    click.stop(t + 0.15)
  }

  /** Fades everything out and frees the nodes (Play). */
  function stop(seconds = 0.8) {
    if (!graph) return
    const g = graph
    graph = null
    const t = g.a.ctx.currentTime
    g.out.gain.setTargetAtTime(0, t, seconds / 4)
    for (const s of g.sources) s.stop(t + seconds + 0.1)
    setTimeout(() => g.out.disconnect(), (seconds + 0.3) * 1000)
  }

  return {
    start,
    setVolume,
    update,
    lock,
    stop,
    get playing() {
      return graph !== null
    },
    /** Output level (RMS, dBFS) for automation; -Infinity when silent or not started. */
    level() {
      if (!graph) return -Infinity
      graph.analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      return 10 * Math.log10(sum / buf.length + 1e-12)
    },
  }
}
