import { AudioRuntime, MIX_CATEGORIES, selectSfx, sfxCues, sfxEntry, sfxManifest, type VoiceHandle } from "@arcade/kit/audio"
import { dayCycle } from "../../shared/day-cycle"
import type { Town } from "../../shared/map"
import { SoundDirector, type SoundEvent, type SoundWorld } from "./director"
import type { SoundHold } from "./inventory"
import { AUDIO_BUS_LEVELS, DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "./settings"
import { indoors, SoundOcclusion, surfaceAt } from "./space"
import { ZombieFootsteps } from "./zombie-steps"

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
  /** The local pack panel (`Tab`), for its zipper. */
  packOpen?: boolean
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
/** Voices kept free of zombie feet, so a crowd never crowds out a shot, a door or a groan. */
const CROWD_HEADROOM = 8

/**
 * Outbreak's sound: the shared library through one `AudioRuntime`, positioned around the local survivor, muffled by
 * walls and closed doors, with street or room reverb, day/night/threat beds, and every sound driven by world state
 * through `SoundDirector`. Silent until the first pointer or key press; `M` mutes.
 */
export class OutbreakAudio {
  readonly runtime: AudioRuntime
  readonly director = new SoundDirector()
  readonly occlusion = new SoundOcclusion()
  readonly zombieSteps = new ZombieFootsteps()
  private holds = new Map<string, { voice: VoiceHandle; hold: SoundHold }>()
  private horde: VoiceHandle | null = null
  private hordeLevel = 0
  private packOpen = false
  private beds: Partial<Record<Bed, VoiceHandle>> = {}
  private bedLevels: Record<Bed, number> = { "ambience.day.suburb": 0, "ambience.night.suburb": 0, "ambience.threat": 0 }
  private armed?: AbortController
  private unlocked = false
  private indoor = 0
  private town: Town | null = null
  private saved = ""
  private applied = ""
  /** Sounds played per library id, for proofs. */
  readonly playedById: Record<string, number> = {}
  /** Inputs and outputs, audible or not, for proofs. */
  readonly counts = { updates: 0, events: 0, played: 0, footsteps: 0, zombieSteps: 0, impacts: 0, maxVoicesSeen: 0, updateMs: 0, maxUpdateMs: 0 }

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
    if (frame.packOpen !== undefined && frame.packOpen !== this.packOpen) {
      this.packOpen = frame.packOpen
      events.push({ id: frame.packOpen ? "pack.open" : "pack.close", x: listener.x, y: listener.y, source: "pack" })
    }
    this.counts.events += events.length
    const live = this.live
    if (live) for (const event of events) {
      if (event.id.startsWith("impact.")) this.counts.impacts++
      this.play(event)
    }
    // Zombie feet: the nearest few step by step, within the crowd budget and never into the last free voices.
    const town = world.town
    const steps = this.zombieSteps.update(world.zombies, listener, world.time, frame.dt, (x, y) => surfaceAt(town, x, y))
    if (live) for (const step of steps) {
      if (this.runtime.activeVoiceCount >= this.runtime.maxVoices - CROWD_HEADROOM) break
      if (this.play({ ...step, source: "zombie" })) this.counts.zombieSteps++
    }
    this.held(this.director.holds, live)
    this.ambience(frame)
    if (live) this.counts.maxVoicesSeen = Math.max(this.counts.maxVoicesSeen, this.runtime.activeVoiceCount)
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
      rate: event.rate,
      position: entry.range.max > 0 ? { x: event.x, z: event.y, refDistance: entry.range.ref, maxDistance: entry.range.max, rolloff: 1.4 } : undefined,
    })
    if (voice) {
      this.counts.played++
      this.playedById[event.id] = (this.playedById[event.id] ?? 0) + 1
    }
    return voice
  }

  /** A foot contact from the zombie crowd rig; `drag` is how much this foot drags, `variant` its shamble archetype. */
  zombieFootstep(agentId: number, x: number, y: number, speed: number, drag: number, variant: string): void {
    this.zombieSteps.contact(agentId, x, y, speed, drag, variant)
  }

  /**
   * Held positional loops (crafting, research, prying, noisemakers, the generator): started when they appear, stopped
   * with a short fade when they end, and re-spatialised each frame as the listener moves.
   */
  private held(holds: readonly SoundHold[], live: boolean): void {
    const wanted = new Set<string>()
    for (const hold of holds) {
      wanted.add(hold.key)
      if (!live) continue
      const entry = sfxEntry(hold.id)
      const pose = { x: hold.x, z: hold.y, refDistance: entry.range.ref, maxDistance: entry.range.max, rolloff: 1.4 }
      const have = this.holds.get(hold.key)
      if (have?.voice.active && have.hold.id === hold.id) {
        const mix = this.runtime.spatialize(pose)
        have.voice.setParams({ gain: entry.gain * mix.gain, pan: mix.pan, cutoffHz: mix.cutoffHz }, 0.1)
        continue
      }
      have?.voice.stop(0.15)
      const voice = this.runtime.playCue(hold.id, { position: pose, ownerKey: hold.key })
      if (voice) this.holds.set(hold.key, { voice, hold })
      else this.holds.delete(hold.key)
    }
    for (const [key, have] of this.holds) {
      if (wanted.has(key) && live) continue
      have.voice.stop(0.25)
      this.holds.delete(key)
    }
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
   * Day birds fade into night insects with the sun; the threat drone follows the day cycle's threat and zombies on you.
   * Indoors the beds drop and lose their top end, as if heard through the walls.
   */
  private ambience(frame: AudioFrame): void {
    const day = dayCycle(frame.hour)
    const dark = 1 - day.sun
    // The day cycle's threat curve (the one the AI and the look follow), raised further by zombies on you.
    const threat = Math.min(1, day.threat * 0.45 + Math.min(1, frame.pursuing / 3) * 0.55)
    const muffle = 1 - this.indoor * 0.55
    const wanted: Record<Bed, number> = {
      "ambience.day.suburb": day.sun * muffle,
      "ambience.night.suburb": dark * muffle,
      "ambience.threat": threat * (0.6 + 0.4 * muffle),
    }
    const cutoff = 18000 * Math.pow(1100 / 18000, this.indoor)
    const ease = Math.min(1, frame.dt * 1.5)
    // The horde: every moving zombie near you beyond the few heard step by step, panned toward the crowd.
    this.hordeLevel += (this.zombieSteps.horde.level - this.hordeLevel) * Math.min(1, frame.dt * 2)
    const hordeGain = this.hordeLevel * muffle * sfxEntry("zombie.horde.shuffle").gain
    if (!this.live) this.horde = null
    else if (this.horde?.active) this.horde.setParams({ gain: hordeGain, pan: this.zombieSteps.horde.pan, cutoffHz: cutoff }, 0.2)
    else if (hordeGain > 0.01) this.horde = this.runtime.playCue("zombie.horde.shuffle", { gain: Math.max(0.01, this.hordeLevel * muffle), ownerKey: "horde" })
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
    this.holds.clear()
    this.horde = null
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
      horde: Math.round(this.hordeLevel * 100) / 100,
      holds: [...this.holds.keys()],
      zombieFeet: { ...this.zombieSteps.counts },
      playedById: { ...this.playedById },
      ...this.counts,
      meanUpdateMs: this.counts.updates ? this.counts.updateMs / this.counts.updates : 0,
    }
  }

  dispose(): void {
    this.armed?.abort()
    this.runtime.dispose()
  }
}
