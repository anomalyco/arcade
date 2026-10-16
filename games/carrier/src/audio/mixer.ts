/**
 * The game's one AudioContext and its mix. Everything (sfx-bank.ts slots, weather, weapons, jets, ships, gunnery,
 * boats) plays through it:
 *
 *   engines (other jets) ─┐
 *   flyby ────────────────┼─ duck ─► canopy low-pass (closes in the cockpit) ─┐
 *   weather / ambience ───┘                                  ▲                │
 *   reverb send ─► outdoor ocean convolver ──────────────────┤                │
 *   echo send ─► water slapback (140 ms, dark) ──────────────┘                │
 *   own (your engine, cockpit, already muffled) ─ duck ─ cockpit-room reverb ─┼─► glue compressor ─► limiter
 *   sfx (carrier ops, crashes) ───────────────────────────────────────────────┤     ─► makeup trim ─► master ─► soft clip
 *   weapons (guns, missiles, explosions) ─────────────────────────────────────┤
 *   ui (menus, cues, warnings; dry) ──────────────────────────────────────────┘
 *
 * Started on the first user gesture (browsers require one), suspended while the tab is hidden. M mutes. Levels and
 * mute persist in localStorage ("carrier.audio.v4"). `duck` dips engines, flybys and ambience so explosions punch
 * through. The reverbs are synthesized impulse responses (a big soft open-air ocean, a small metal cockpit). Also holds
 * the shared noise bank (procedural placeholders) and the listener pose (`listener`, set each frame by jet-audio.ts) so
 * any module can place a sound in the world. Works on an OfflineAudioContext too (`use`), for scripted renders.
 */

import { DEFAULT_VOLUME_SETTINGS, loadVolumeSettings, saveVolumeSettings, type VolumeSettings } from "@arcade/kit/audio/volume"
import { isEditableEventTarget } from "@arcade/kit/client/controls"

export type Level = "master" | "engines" | "flyby" | "sfx" | "weapons" | "weather" | "ui"
export type Levels = Record<Level, number>
export type Bus = "engines" | "own" | "flyby" | "sfx" | "weapons" | "weather" | "ui"

export const DEFAULT_LEVELS: Readonly<Levels> = { master: 1, engines: 0.7, flyby: 0.8, sfx: 0.9, weapons: 0.9, weather: 0.8, ui: 0.45 }
const STORE = "carrier.audio.v4"
/** Output trim after the glue and limiter (which add their own makeup gain): sets the integrated loudness of a typical
 *  dogfight near -16 LUFS (scripts/audio-demo.ts "montage") with peaks under -1 dBFS. */
const MAKEUP_TRIM = 0.9
/** Cockpit canopy: the world bus low-pass at full muffle (Hz). */
const CANOPY_HZ = 1300

/** Loopable noise, all RMS-normalised to NOISE_RMS: white, pink (-3 dB/oct), brown (-6 dB/oct), and crackle (sparse
 *  decaying impulses of random size: afterburner pops). */
export type NoiseBank = { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer; crackle: AudioBuffer }
export const NOISE_RMS = 0.3


/** The listener (camera) in the world: position and orthonormal basis (x right, y up, z forward). */
export type Listener = { eye: [number, number, number]; right: [number, number, number]; up: [number, number, number]; fwd: [number, number, number]; vel: [number, number, number] }

export class Mixer {
  ctx: BaseAudioContext | null = null
  /** Where the camera is (jet-audio.ts updates it every frame). */
  readonly listener: Listener = { eye: [0, 20, 0], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1], vel: [0, 0, 0] }
  /** 0 outside .. 1 in the cockpit (set with setCockpit). */
  cockpit = 0
  /** Current rain and sea state 0..1 (weather-audio.ts), for the canopy rain and the hull's creaks. */
  rain = 0
  sea = 0
  /** The SOUNDS tab can hold the cockpit muffle while auditioning (null: the game decides). */
  forceCockpit: number | null = null
  /** Sends: the outdoor reverb, the water slapback, the cockpit's small room. */
  reverb!: GainNode
  echo!: GainNode
  room!: GainNode
  levels: Levels = { ...DEFAULT_LEVELS }
  volumes: VolumeSettings = { volumeMaster: 100, volumeEffects: 100, volumeAmbience: 100, volumeVoice: 100, volumeMusic: 100 }
  muted = false
  private savedVolumes = ""
  noise!: NoiseBank
  analyser!: AnalyserNode
  /** Where each kind of sound plugs in. */
  bus!: Record<Bus, GainNode>
  /** Recorded sounds (sfx-bank.ts) on; off plays only the procedural placeholders (comparisons, the AUDIO tab). */
  samplesOn = true
  private master!: GainNode
  private canopy!: BiquadFilterNode
  private ducks: GainNode[] = []
  private ownLevel!: GainNode
  private starters: ((ctx: BaseAudioContext) => void)[] = []
  private toast: HTMLElement | null = null
  private toastTimer = 0
  private peakBuf: Float32Array<ArrayBuffer> | null = null

  constructor(attach = true) {
    if (attach) {
      this.volumes = { ...DEFAULT_VOLUME_SETTINGS }
      const storage = typeof localStorage !== "undefined" ? localStorage : null
      loadVolumeSettings(storage, "carrier", this.volumes)
      this.savedVolumes = saveVolumeSettings(null, "carrier", this.volumes)
    }
    this.restore()
    if (!attach || typeof window === "undefined") return
    const start = () => {
      this.start()
      if (this.ctx && this.ctx.state === "running") {
        window.removeEventListener("pointerdown", start, true)
        window.removeEventListener("keydown", start, true)
      }
    }
    window.addEventListener("pointerdown", start, true)
    window.addEventListener("keydown", start, true)
    document.addEventListener("visibilitychange", () => {
      const c = this.ctx
      if (!(c instanceof AudioContext)) return
      if (document.hidden) void c.suspend().catch(() => undefined)
      else void c.resume().catch(() => undefined)
    })
    window.addEventListener("keydown", (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditableEventTarget(e.target)) return
      if (e.code === "KeyM") this.setMuted(!this.muted)
    })
  }

  /** The live context (created on the first call, from a user gesture), resumed if the browser suspended it. */
  start(): BaseAudioContext | null {
    if (!this.ctx) {
      const AC = typeof window !== "undefined" ? window.AudioContext : undefined
      if (!AC) return null
      try {
        this.use(new AC({ latencyHint: "interactive" }))
      } catch (err) {
        console.warn("[audio] Web Audio unavailable", err)
        return null
      }
    }
    const c = this.ctx
    if (c instanceof AudioContext && c.state === "suspended" && !(typeof document !== "undefined" && document.hidden)) void c.resume().catch(() => undefined)
    return c
  }

  /** Builds the mix on `ctx` (a live or an offline context). */
  use(ctx: BaseAudioContext): void {
    this.ctx = ctx
    this.noise = makeNoise(ctx)
    const gain = (v: number, to?: AudioNode) => {
      const g = ctx.createGain()
      g.gain.value = v
      if (to) g.connect(to)
      return g
    }
    // Output: a gentle glue compressor, then a fast peak limiter, the makeup trim (Web Audio's compressors add makeup gain;
    // the trim takes it back out so quiet sounds pass at unity), the master volume and a soft clip for anything the
    // limiter's attack lets through.
    const glue = ctx.createDynamicsCompressor()
    glue.threshold.value = -20
    glue.knee.value = 12
    glue.ratio.value = 2
    glue.attack.value = 0.02
    glue.release.value = 0.3
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 1
    limiter.ratio.value = 20
    limiter.attack.value = 0.001
    limiter.release.value = 0.15
    const trim = gain(MAKEUP_TRIM)
    this.master = gain(this.masterGain())
    const clip = ctx.createWaveShaper()
    clip.curve = softClip()
    clip.oversample = "2x"
    glue.connect(limiter).connect(trim).connect(this.master).connect(clip).connect(ctx.destination)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    clip.connect(this.analyser)
    const sum = gain(1, glue)

    this.canopy = ctx.createBiquadFilter()
    this.canopy.type = "lowpass"
    this.canopy.frequency.value = 20000
    this.canopy.Q.value = 0.6
    this.canopy.connect(sum)
    const duckEng = gain(1, this.canopy)
    const duckFly = gain(1, this.canopy)
    const duckWx = gain(1, this.canopy)
    const duckOwn = gain(1, sum)
    this.ducks = [duckEng, duckFly, duckWx, duckOwn]
    this.ownLevel = gain(this.busGain("engines"), duckOwn)
    this.bus = {
      engines: gain(this.busGain("engines"), duckEng),
      own: this.ownLevel,
      flyby: gain(this.busGain("flyby"), duckFly),
      weather: gain(this.busGain("weather"), duckWx),
      sfx: gain(this.busGain("sfx"), sum),
      weapons: gain(this.busGain("weapons"), sum),
      ui: gain(this.busGain("ui"), sum),
    }
    // Space: a big soft open-air ocean reverb (behind the canopy with the world), a dark slapback off the water, and the
    // cockpit's small metal room for your own sounds.
    const outdoor = ctx.createConvolver()
    outdoor.normalize = false
    outdoor.buffer = impulse(ctx, 3.4, 0.025, 2600, true)
    this.reverb = gain(1)
    this.reverb.connect(outdoor).connect(gain(0.55, this.canopy))
    const slap = ctx.createDelay(1)
    slap.delayTime.value = 0.14
    const slapLp = ctx.createBiquadFilter()
    slapLp.type = "lowpass"
    slapLp.frequency.value = 2200
    this.echo = gain(1)
    this.echo.connect(slap).connect(slapLp).connect(gain(0.32, this.canopy))
    slapLp.connect(gain(0.25, this.reverb))
    const cockpitRoom = ctx.createConvolver()
    cockpitRoom.normalize = false
    cockpitRoom.buffer = impulse(ctx, 0.35, 0.002, 5000, false)
    this.room = gain(1)
    this.room.connect(cockpitRoom).connect(gain(0.35, sum))
    for (const f of this.starters) f(ctx)
    this.starters.length = 0
  }

  /** Runs `f` once the context exists (now if it already does). */
  onStart(f: (ctx: BaseAudioContext) => void): void {
    if (this.ctx) f(this.ctx)
    else this.starters.push(f)
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0
  }

  setLevel(name: Level, v: number): void {
    this.levels[name] = Math.max(0, Math.min(1.5, v))
    this.apply()
    this.save()
  }

  setVolumes(): void {
    this.apply()
    const storage = typeof localStorage !== "undefined" ? localStorage : null
    this.savedVolumes = saveVolumeSettings(storage, "carrier", this.volumes, this.savedVolumes)
  }

  private masterGain(): number {
    return this.muted ? 0 : this.levels.master * (this.volumes.volumeMaster / 100)
  }

  private busGain(name: Exclude<Level, "master">): number {
    const ch = name === "weather" ? this.volumes.volumeAmbience : this.volumes.volumeEffects
    return this.levels[name] * (ch / 100)
  }

  setMuted(m: boolean): void {
    this.muted = m
    this.apply()
    this.save()
    this.flash(m ? "SOUND OFF  (M)" : "SOUND ON")
  }

  /** Cockpit muffle on the world bus, 0 (outside) .. 1 (canopy closed around you). */
  setCockpit(k: number): void {
    if (this.forceCockpit !== null) k = this.forceCockpit
    this.cockpit = k
    if (!this.ctx) return
    const hz = 20000 * Math.pow(CANOPY_HZ / 20000, Math.max(0, Math.min(1, k)))
    this.canopy.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.08)
  }

  /** Dips engines, flybys (unless `spareFlyby`) and weather to `depth` (0..1) for `hold` seconds, then recovers. */
  duck(depth: number, hold: number, delay = 0, spareFlyby = false): void {
    const c = this.ctx
    if (!c) return
    const at = c.currentTime + delay
    for (const g of this.ducks) {
      if (spareFlyby && g === this.ducks[1]) continue
      const p = g.gain
      p.cancelScheduledValues(at)
      p.setTargetAtTime(depth, at, 0.015)
      p.setTargetAtTime(1, at + hold, 0.35)
    }
  }

  /** Peak of the output over the last ~43 ms (0..1+). */
  peak(): number {
    if (!this.ctx) return 0
    const a = this.analyser
    if (!this.peakBuf) this.peakBuf = new Float32Array(a.fftSize)
    a.getFloatTimeDomainData(this.peakBuf)
    let m = 0
    for (let i = 0; i < this.peakBuf.length; i++) m = Math.max(m, Math.abs(this.peakBuf[i]!))
    return m
  }

  private apply(): void {
    const c = this.ctx
    if (!c) return
    const now = c.currentTime
    const set = (g: GainNode, v: number) => g.gain.setTargetAtTime(v, now, 0.03)
    set(this.master, this.masterGain())
    set(this.bus.engines, this.busGain("engines"))
    set(this.ownLevel, this.busGain("engines"))
    set(this.bus.flyby, this.busGain("flyby"))
    set(this.bus.sfx, this.busGain("sfx"))
    set(this.bus.weapons, this.busGain("weapons"))
    set(this.bus.weather, this.busGain("weather"))
    set(this.bus.ui, this.busGain("ui"))
  }

  private restore(): void {
    if (typeof localStorage === "undefined") return
    try {
      const s = JSON.parse(localStorage.getItem(STORE) ?? "null") as { levels?: Partial<Levels>; muted?: boolean } | null
      if (!s) return
      for (const k of Object.keys(DEFAULT_LEVELS) as Level[]) {
        const v = s.levels?.[k]
        if (typeof v === "number" && Number.isFinite(v)) this.levels[k] = Math.max(0, Math.min(1.5, v))
      }
      this.muted = s.muted === true
    } catch {
      // A corrupt entry: defaults.
    }
  }

  private save(): void {
    if (typeof localStorage === "undefined") return
    try {
      localStorage.setItem(STORE, JSON.stringify({ levels: this.levels, muted: this.muted }))
    } catch {
      // Storage full or blocked: levels last for this session.
    }
  }

  private flash(text: string): void {
    if (typeof document === "undefined") return
    if (!this.toast) {
      const el = (this.toast = document.createElement("div"))
      el.style.cssText =
        "position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:900;pointer-events:none;font:300 11px/1 'IBM Plex Mono',ui-monospace,monospace;letter-spacing:.3em;color:#e8eef4;background:rgba(7,12,18,.7);padding:8px 14px;border:1px solid rgba(255,255,255,.14);transition:opacity .4s"
      document.body.append(el)
    }
    this.toast.textContent = text
    this.toast.style.opacity = "1"
    clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toast && (this.toast.style.opacity = "0"), 1200)
  }
}

/**
 * A synthesized stereo impulse response: `pre` seconds of pre-delay, a few early reflections (outdoors: the bounce off
 * the water), then decorrelated noise decaying to -60 dB over `rt60` seconds and darkening as it decays (a one-pole
 * low-pass whose cutoff falls from `bright` Hz). Energy-normalised so the send level means the same for any length.
 */
export function impulse(ctx: BaseAudioContext, rt60: number, pre: number, bright: number, outdoor: boolean): AudioBuffer {
  const rate = ctx.sampleRate
  const len = Math.floor(rate * (pre + rt60))
  const buf = ctx.createBuffer(2, len, rate)
  let seed = outdoor ? 0x1234567 : 0x7654321
  const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  const p0 = Math.floor(pre * rate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    for (let i = p0; i < len; i++) {
      const t = (i - p0) / rate
      const env = Math.exp((-6.9 * t) / rt60)
      // Slow attack into the diffuse tail (a soft, not a sudden, reverb).
      const swell = outdoor ? Math.min(1, t / 0.06) : Math.min(1, t / 0.004)
      const fc = bright * Math.exp(-t * (outdoor ? 0.9 : 3)) + 300
      const a = 1 - Math.exp((-2 * Math.PI * fc) / rate)
      lp += a * (rnd() * 2 - 1 - lp)
      d[i] = lp * env * swell
    }
    // Early reflections.
    const taps = outdoor ? [0.018, 0.031, 0.047, 0.071, 0.093] : [0.003, 0.006, 0.009, 0.013]
    taps.forEach((tt, k) => {
      const at = p0 + Math.floor((tt + (c ? 0.0021 * (k + 1) : 0)) * rate)
      if (at < len) d[at] = (d[at] ?? 0) + (outdoor ? 0.45 : 0.3) * Math.pow(0.72, k) * (k % 2 ? -1 : 1)
    })
  }
  let e = 0
  for (let c = 0; c < 2; c++) for (const v of buf.getChannelData(c)) e += v * v
  const k = 1 / Math.sqrt(e / 2 || 1)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < len; i++) d[i] = d[i]! * k
  }
  return buf
}

/** Unity below 0.85, then a smooth knee into ±1: catches what the limiter's 1 ms attack lets through. */
function softClip(): Float32Array<ArrayBuffer> {
  const n = 2048
  const curve = new Float32Array(n)
  const knee = 0.85
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    const a = Math.abs(x)
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee))
    curve[i] = Math.sign(x) * y
  }
  return curve
}

/** Renders the noise bank (~4 s each, seamless loops). */
function makeNoise(ctx: BaseAudioContext): NoiseBank {
  const rate = ctx.sampleRate
  const len = Math.floor(rate * 4)
  const fade = Math.floor(rate * 0.05)
  let seed = 0x9e3779b9
  const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  const make = (fill: (a: Float32Array) => void): AudioBuffer => {
    const a = new Float32Array(len + fade)
    fill(a)
    // Remove DC, normalise RMS, crossfade the tail into the head.
    let mean = 0
    for (let i = 0; i < a.length; i++) mean += a[i]!
    mean /= a.length
    let s = 0
    for (let i = 0; i < a.length; i++) {
      a[i] = a[i]! - mean
      s += a[i]! * a[i]!
    }
    const k = NOISE_RMS / Math.sqrt(s / a.length || 1)
    const buf = ctx.createBuffer(1, len, rate)
    const b = buf.getChannelData(0)
    for (let i = 0; i < len; i++) b[i] = Math.max(-1, Math.min(1, a[i]! * k))
    for (let i = 0; i < fade; i++) {
      const w = (i + 0.5) / fade
      b[i] = Math.max(-1, Math.min(1, (a[i]! * Math.sin((w * Math.PI) / 2) + a[len + i]! * Math.cos((w * Math.PI) / 2)) * k))
    }
    return buf
  }
  const white = make((a) => {
    for (let i = 0; i < a.length; i++) a[i] = rnd() * 2 - 1
  })
  const pink = make((a) => {
    // Paul Kellet's refined pink filter.
    let b0 = 0
    let b1 = 0
    let b2 = 0
    let b3 = 0
    let b4 = 0
    let b5 = 0
    let b6 = 0
    for (let i = 0; i < a.length; i++) {
      const w = rnd() * 2 - 1
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      a[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
      b6 = w * 0.115926
    }
  })
  const brown = make((a) => {
    let last = 0
    for (let i = 0; i < a.length; i++) {
      last = (last + 0.02 * (rnd() * 2 - 1)) / 1.02
      a[i] = last
    }
  })
  const crackle = make((a) => {
    // Poisson pops, ~110 a second, sizes power-law distributed, each a short decaying burst of random polarity.
    let t = 0
    while (t < a.length) {
      t += Math.floor((-Math.log(1 - rnd()) / 110) * rate)
      const size = Math.pow(rnd(), 3.2)
      const decay = (0.0004 + 0.0035 * rnd()) * rate
      const sign = rnd() < 0.5 ? -1 : 1
      const n = Math.min(a.length - t, Math.floor(decay * 6))
      for (let j = 0; j < n; j++) a[t + j] = a[t + j]! + sign * size * Math.exp(-j / decay) * (0.6 + 0.4 * (rnd() * 2 - 1))
    }
  })
  return { white, pink, brown, crackle }
}

let shared: Mixer | null = null
/** The game's mixer (one per page). */
export function mixer(): Mixer {
  return (shared ??= new Mixer(true))
}
