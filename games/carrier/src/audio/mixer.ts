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
 * The graph is `CARRIER_MIX`, built by the kit's `AudioRuntime` (`@arcade/kit/audio/runtime`, `mix` option), which also
 * owns the context: started on the first user gesture (browsers require one), suspended while the tab is hidden, M
 * mutes. Levels and mute persist in localStorage ("carrier.audio.v4"); player volumes are the kit's volume settings. `duck` dips engines, flybys and ambience so explosions punch
 * through. The reverbs are synthesized impulse responses (a big soft open-air ocean, a small metal cockpit). Also holds
 * the shared noise bank (procedural placeholders) and the listener pose (`listener`, set each frame by jet-audio.ts) so
 * any module can place a sound in the world. Works on an OfflineAudioContext too (`use`), for scripted renders.
 */

import { AudioRuntime } from "@arcade/kit/audio/runtime"
import { impulseResponse, type MixSpec, noiseBank, type NoiseBank } from "@arcade/kit/audio/mix"
import { DEFAULT_VOLUME_SETTINGS, loadVolumeSettings, saveVolumeSettings, type VolumeSettings } from "@arcade/kit/audio/volume"

export type Level = "master" | "engines" | "flyby" | "sfx" | "weapons" | "weather" | "ui"
export type Levels = Record<Level, number>
export type Bus = "engines" | "own" | "flyby" | "sfx" | "weapons" | "weather" | "ui"
type Send = "reverb" | "echo" | "room"

export const DEFAULT_LEVELS: Readonly<Levels> = { master: 1, engines: 0.7, flyby: 0.8, sfx: 0.9, weapons: 0.9, weather: 0.8, ui: 0.45 }
const STORE = "carrier.audio.v4"

/**
 * Carrier's mix on the kit runtime. Order matters only for readability: buses behind the canopy first.
 * Output trim 0.9 after the glue and limiter (which add their own makeup gain) sets the integrated loudness of a typical
 * dogfight near -16 LUFS (scripts/audio-demo.ts "montage") with peaks under -1 dBFS. The canopy closes to 1.3 kHz.
 */
export const CARRIER_MIX: MixSpec<Bus, Send> = {
  buses: {
    engines: { muffled: true, ducked: true },
    flyby: { muffled: true, ducked: true },
    weather: { muffled: true, ducked: true },
    own: { ducked: true },
    sfx: {},
    weapons: {},
    ui: {},
  },
  sends: {
    // A big soft open-air ocean reverb (behind the canopy with the world), a dark slapback off the water that also feeds
    // the reverb, and the cockpit's small metal room for your own sounds.
    reverb: { impulse: (ctx) => impulseResponse(ctx, { rt60: 3.4, preDelay: 0.025, brightHz: 2600, open: true }), wet: 0.55, muffled: true },
    echo: { delay: 0.14, lowpassHz: 2200, wet: 0.32, muffled: true, feed: { send: "reverb", gain: 0.25 } },
    room: { impulse: (ctx) => impulseResponse(ctx, { rt60: 0.35, preDelay: 0.002, brightHz: 5000, open: false }), wet: 0.35 },
  },
  muffle: { closedHz: 1300, q: 0.6, tau: 0.08 },
  glue: { threshold: -20, knee: 12, ratio: 2, attack: 0.02, release: 0.3 },
  limiter: { threshold: -3, knee: 1, ratio: 20, attack: 0.001, release: 0.15 },
  trim: 0.9,
  softClipKnee: 0.85,
  analyserFftSize: 2048,
  route: { engine: "engines", tyre: "engines", impact: "weapons", weapon: "weapons", ambience: "weather", spell: "sfx", foley: "sfx", voice: "sfx", ui: "ui" },
  reverb: "reverb",
}

export { NOISE_RMS, type NoiseBank } from "@arcade/kit/audio/mix"

/** The listener (camera) in the world: position and orthonormal basis (x right, y up, z forward). */
export type Listener = { eye: [number, number, number]; right: [number, number, number]; up: [number, number, number]; fwd: [number, number, number]; vel: [number, number, number] }

/**
 * The game's one mix: `CARRIER_MIX` on the kit's `AudioRuntime` (context, buses, canopy muffle, ducks, sends, output
 * chain, gesture unlock, tab suspend, M mute), plus Carrier's own state: designer levels per bus, the 3D listener, the
 * cockpit amount and the procedural noise bank.
 */
export class Mixer {
  readonly runtime: AudioRuntime
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
  volumes: VolumeSettings = { volumeMaster: 100, volumeEffects: 100, volumeEngine: 100, volumeAmbience: 100, volumeVoice: 100, volumeMusic: 100 }
  private savedVolumes = ""
  noise!: NoiseBank
  /** Where each kind of sound plugs in. */
  bus!: Record<Bus, GainNode>
  /** Recorded sounds (sfx-bank.ts) on; off plays only the procedural placeholders (comparisons, the AUDIO tab). */
  samplesOn = true
  private starters: ((ctx: BaseAudioContext) => void)[] = []
  private toast: HTMLElement | null = null
  private toastTimer = 0

  constructor(attach = true) {
    if (attach) {
      this.volumes = { ...DEFAULT_VOLUME_SETTINGS }
      const storage = typeof localStorage !== "undefined" ? localStorage : null
      loadVolumeSettings(storage, "carrier", this.volumes)
      this.savedVolumes = saveVolumeSettings(null, "carrier", this.volumes)
    }
    this.runtime = new AudioRuntime({ mix: CARRIER_MIX, manifest: [], cues: [], pacer: false })
    this.restore()
    this.runtime.setVolume(this.masterLevel())
    this.runtime.onContext((ctx) => this.attached(ctx))
    if (!attach || typeof window === "undefined") return
    // First gesture starts the context; hidden tab suspends; M mutes (kit lifecycle). Mute persists here, with a toast.
    this.runtime.bindDomLifecycle()
    let first = true
    this.runtime.onMute((m) => {
      if (first) return void (first = false)
      // The kit leaves a context suspended while muted through a hidden tab; unmuting brings it back.
      if (!m) void this.runtime.resume()
      this.save()
      this.flash(m ? "SOUND OFF  (M)" : "SOUND ON")
    })
  }

  get ctx(): BaseAudioContext | null {
    return this.runtime.ctx
  }

  get muted(): boolean {
    return this.runtime.muted
  }

  /** Raw mute flag (scripted renders set it, then `apply`); players use `setMuted`. */
  set muted(m: boolean) {
    this.runtime.muted = m
  }

  get analyser(): AnalyserNode | null {
    return this.runtime.analyser
  }

  /** The live context (created on the first call, from a user gesture), resumed if the browser suspended it. */
  start(): BaseAudioContext | null {
    if (!this.ctx) void this.runtime.unlock()
    else if (!(typeof document !== "undefined" && document.hidden)) void this.runtime.resume()
    return this.ctx
  }

  /** Builds the mix on `ctx` (a live or an offline context). */
  use(ctx: BaseAudioContext): void {
    this.runtime.attachContext(ctx as AudioContext | OfflineAudioContext)
  }

  private attached(ctx: BaseAudioContext): void {
    const rt = this.runtime
    this.noise = noiseBank(ctx)
    const bus = (b: Bus) => rt.mixBus(b)!
    this.bus = { engines: bus("engines"), own: bus("own"), flyby: bus("flyby"), weather: bus("weather"), sfx: bus("sfx"), weapons: bus("weapons"), ui: bus("ui") }
    for (const b of Object.keys(this.bus) as Bus[]) this.bus[b].gain.value = this.busGain(b)
    this.reverb = rt.mixSend("reverb")!
    this.echo = rt.mixSend("echo")!
    this.room = rt.mixSend("room")!
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

  private masterLevel(): number {
    return this.levels.master * (this.volumes.volumeMaster / 100)
  }

  /** A bus's gain: its designer level times the player's channel volume (the own engine follows the engines level). */
  private busGain(b: Bus): number {
    const name: Exclude<Level, "master"> = b === "own" ? "engines" : b
    const ch = name === "weather" ? this.volumes.volumeAmbience : this.volumes.volumeEffects
    return this.levels[name] * (ch / 100)
  }

  setMuted(m: boolean): void {
    this.runtime.setMuted(m)
  }

  /** Cockpit muffle on the world bus, 0 (outside) .. 1 (canopy closed around you). */
  setCockpit(k: number): void {
    if (this.forceCockpit !== null) k = this.forceCockpit
    this.cockpit = k
    this.runtime.setMuffle(k)
  }

  /** Dips engines, flybys (unless `spareFlyby`), weather and your own engine to `depth` (0..1) for `hold` seconds. */
  duck(depth: number, hold: number, delay = 0, spareFlyby = false): void {
    this.runtime.duckBuses(depth, hold, { delay, spare: spareFlyby ? ["flyby"] : undefined })
  }

  /** Peak of the output over the last ~43 ms (0..1+). */
  peak(): number {
    return this.runtime.peak()
  }

  apply(): void {
    const rt = this.runtime
    rt.setVolume(this.masterLevel())
    if (rt.muted && rt.mix) rt.mix.master.gain.setTargetAtTime(0, this.now, 0.03)
    if (!this.ctx) return
    for (const b of Object.keys(this.bus) as Bus[]) rt.setMixBusGain(b, this.busGain(b))
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
      this.runtime.muted = s.muted === true
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

let shared: Mixer | null = null
/** The game's mixer (one per page). */
export function mixer(): Mixer {
  return (shared ??= new Mixer(true))
}
