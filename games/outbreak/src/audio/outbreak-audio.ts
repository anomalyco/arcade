import { AudioRuntime, MIX_CATEGORIES, selectSfx, sfxCues, sfxEntry, sfxManifest, type VoiceHandle } from "@arcade/kit/audio"
import { dayCycle } from "../../shared/day-cycle"
import type { Town } from "../../shared/map"
import { SoundDirector, type SoundEvent, type SoundWorld } from "./director"
import { AUDIO_BUS_LEVELS, DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "./settings"
import { indoors, SoundOcclusion, surfaceAt } from "./space"

export type AudioFrame = {
  dt: number
  world: SoundWorld
  /** The local survivor's drawn position: the listener. */
  listener: { x: number; y: number }
  hour: number
  /** Town topology revision (doors opened, barricades changed) for the occlusion geometry. */
  revision: number
  /** Zombies chasing or attacking the local survivor. */
  pursuing: number
}

const STORAGE_KEY = "outbreak.audio.v1"
/** Above this speed a footfall is a run (between walk 3.4 and sprint 5.6 m/s). */
const RUN_SPEED = 4.4
const EAR_HEIGHT = 1.7
/** Lateral metres for near-full pan: the top-down camera frames about 30 m across. */
const PAN_SCALE = 12
const AUDIO_KEYS = Object.keys(DEFAULT_AUDIO_SETTINGS) as (keyof AudioSettings)[]
const BEDS = ["ambience.day.suburb", "ambience.night.suburb", "ambience.threat"] as const
type Bed = (typeof BEDS)[number]

/**
 * Outbreak's sound: the shared library through one `AudioRuntime`, positioned around the local survivor, muffled by
 * walls and closed doors, with street or room reverb, day/night/threat beds, and every sound driven by world state
 * through `SoundDirector`. Silent until the first pointer or key press; `M` mutes.
 */
export class OutbreakAudio {
  readonly runtime: AudioRuntime
  readonly director = new SoundDirector()
  readonly occlusion = new SoundOcclusion()
  private beds: Partial<Record<Bed, VoiceHandle>> = {}
  private bedLevels: Record<Bed, number> = { "ambience.day.suburb": 0, "ambience.night.suburb": 0, "ambience.threat": 0 }
  private armed?: AbortController
  private unlocked = false
  private indoor = 0
  private town: Town | null = null
  private saved = ""
  private applied = ""
  /** Inputs and outputs, audible or not, for proofs. */
  readonly counts = { updates: 0, events: 0, played: 0, footsteps: 0, updateMs: 0, maxUpdateMs: 0 }

  constructor(
    private readonly settings: AudioSettings,
    private readonly options: { baseUrl: string; storage: Storage | null; automated: boolean },
  ) {
    const entries = selectSfx(["game:outbreak"])
    this.runtime = new AudioRuntime({
      baseUrl: options.baseUrl,
      manifest: sfxManifest(entries),
      cues: sfxCues(entries),
      maxVoices: settings.audioVoiceCap,
      reverbWet: settings.audioReverb,
      roomReverbSeconds: 0.55,
      visibilityQuery: this.occlusion.query,
      autoBindDom: false,
    })
    let saved: { muted?: unknown; master?: unknown } = {}
    try { saved = JSON.parse(options.storage?.getItem(STORAGE_KEY) ?? "{}") ?? {} } catch { /* Defaults. */ }
    // Automation (navigator.webdriver) starts muted unless a saved choice says otherwise: proofs never make sound.
    settings.audioMuted = typeof saved.muted === "boolean" ? Number(saved.muted) : options.automated ? 1 : settings.audioMuted
    if (typeof saved.master === "number" && saved.master >= 0 && saved.master <= 100) settings.audioMaster = saved.master
    this.runtime.muted = Boolean(settings.audioMuted)
  }

  /** Starts audio on the first pointer or key press (autoplay rules), binds `M`, and pauses with the tab. */
  arm(target: Window = window): void {
    if (this.armed) return
    const signal = (this.armed = new AbortController()).signal
    const unlock = () => {
      if (this.unlocked) return
      this.unlocked = true
      void this.runtime.unlock().then(() => this.apply())
    }
    for (const type of ["pointerdown", "keydown", "touchend"]) target.addEventListener(type, unlock, { capture: true, signal })
    target.addEventListener("keydown", (e) => {
      if (e.code !== "KeyM" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return
      this.toggleMute()
    }, { signal })
    target.document.addEventListener("visibilitychange", () => (target.document.hidden ? this.silence() : void this.runtime.resume()), { signal })
    target.addEventListener("blur", () => this.silence(), { signal })
    target.addEventListener("pagehide", () => this.dispose(), { signal })
  }

  toggleMute(): void {
    this.settings.audioMuted = this.settings.audioMuted ? 0 : 1
    this.apply()
  }

  get live(): boolean {
    const ctx = this.runtime.ctx
    return Boolean(ctx && ctx.state === "running" && !this.runtime.muted)
  }

  private apply(): void {
    const s = this.settings
    const rt = this.runtime
    const key = AUDIO_KEYS.map((k) => s[k]).join() + (rt.ctx ? "1" : "0")
    if (key === this.applied) return
    this.applied = key
    rt.setMuted(Boolean(s.audioMuted))
    rt.setVolume(s.audioMaster / 100)
    rt.maxVoices = Math.round(s.audioVoiceCap)
    rt.setReverbWet(s.audioReverb)
    for (const bus of MIX_CATEGORIES) rt.setBusGain(bus, (s[AUDIO_BUS_LEVELS[bus]] as number) / 100)
    this.occlusion.strength = s.audioOcclusion
    const saved = JSON.stringify({ muted: Boolean(s.audioMuted), master: s.audioMaster })
    if (saved !== this.saved) {
      this.saved = saved
      try { this.options.storage?.setItem(STORAGE_KEY, saved) } catch { /* Private mode. */ }
    }
  }

  update(frame: AudioFrame): void {
    const t0 = performance.now()
    const { world, listener } = frame
    this.town = world.town
    this.occlusion.sync(world.town, frame.revision)
    this.apply()
    this.runtime.setListener({ x: listener.x, z: listener.y, vx: 0, vz: 0, rightX: 1, rightZ: 0, earHeight: EAR_HEIGHT, panScale: PAN_SCALE })
    // Room reverb inside a house, street reverb outside, eased through the doorway.
    const target = indoors(world.town, listener.x, listener.y) ? 1 : 0
    this.indoor += (target - this.indoor) * Math.min(1, frame.dt * 4)
    this.runtime.setSpace(this.indoor)
    // The director runs muted too, so unmuting never replays stale changes.
    const events = this.director.observe(world, listener)
    this.counts.events += events.length
    if (this.live) for (const event of events) this.play(event)
    this.ambience(frame)
    this.counts.updates++
    const ms = performance.now() - t0
    this.counts.updateMs += ms
    this.counts.maxUpdateMs = Math.max(this.counts.maxUpdateMs, ms)
  }

  /** Plays one library sound at a plan position with the entry's range. */
  play(event: SoundEvent): VoiceHandle | null {
    const entry = sfxEntry(event.id)
    const voice = this.runtime.playCue(event.id, {
      time: this.runtime.now + (event.delay ?? 0),
      gain: event.gain,
      position: entry.range.max > 0 ? { x: event.x, z: event.y, refDistance: entry.range.ref, maxDistance: entry.range.max, rolloff: 1.4 } : undefined,
    })
    if (voice) this.counts.played++
    return voice
  }

  /** A foot contact from the rig (local or remote survivor), on whatever surface it landed on. */
  footstep(x: number, y: number, speed: number): void {
    this.counts.footsteps++
    if (!this.live || !this.town) return
    const run = speed > RUN_SPEED
    const gain = run ? 1 : 0.75 + 0.25 * Math.min(1, speed / 3.4)
    this.play({ id: `foot.${surfaceAt(this.town, x, y)}.${run ? "run" : "walk"}`, x, y, gain, source: "foot" })
  }

  /**
   * Day birds fade into night insects with the sun; the threat drone rises with darkness and with zombies on you.
   * Indoors the beds drop and lose their top end, as if heard through the walls.
   */
  private ambience(frame: AudioFrame): void {
    const day = dayCycle(frame.hour)
    const dark = 1 - day.sun
    const threat = Math.min(1, dark * 0.45 + Math.min(1, frame.pursuing / 3) * 0.55)
    const muffle = 1 - this.indoor * 0.55
    const wanted: Record<Bed, number> = {
      "ambience.day.suburb": day.sun * muffle,
      "ambience.night.suburb": dark * muffle,
      "ambience.threat": threat * (0.6 + 0.4 * muffle),
    }
    const cutoff = 18000 * Math.pow(1100 / 18000, this.indoor)
    const ease = Math.min(1, frame.dt * 1.5)
    for (const bed of BEDS) {
      this.bedLevels[bed] += (wanted[bed] - this.bedLevels[bed]) * ease
      const gain = this.bedLevels[bed] * sfxEntry(bed).gain
      const voice = this.beds[bed]
      if (!this.live) {
        if (voice) delete this.beds[bed]
        continue
      }
      if (voice?.active) voice.setParams({ gain, cutoffHz: cutoff }, 0.2)
      else if (gain > 0.01) {
        const started = this.runtime.playCue(bed, { gain: Math.max(0.01, this.bedLevels[bed]), ownerKey: bed })
        if (started) this.beds[bed] = started
      }
    }
  }

  silence(): void {
    this.beds = {}
    this.runtime.stopAllVoices(0.03)
  }

  telemetry() {
    const t = this.runtime.telemetry()
    return {
      state: t.state,
      muted: t.muted,
      unlocked: this.unlocked,
      voices: t.activeVoices,
      maxVoices: t.maxVoices,
      byBus: t.categoryVoices,
      dropped: t.droppedVoices,
      stolen: t.stolenVoices,
      loadedSamples: this.runtime.sampleBank.decodedAssetCount,
      indoor: Math.round(this.indoor * 100) / 100,
      beds: Object.fromEntries(Object.entries(this.bedLevels).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      ...this.counts,
      meanUpdateMs: this.counts.updates ? this.counts.updateMs / this.counts.updates : 0,
    }
  }

  dispose(): void {
    this.armed?.abort()
    this.runtime.dispose()
  }
}
