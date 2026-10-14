import { AudioRuntime, type AudioLabController, type VoiceHandle } from "@arcade/kit/audio"
import type { LabAudioAdapter } from "@arcade/kit/lab/audio-adapter"
import type { LabEvent } from "@arcade/kit/lab/types"
import { LAB_CUES, effectSounds } from "./cues"
import { MIX_STORAGE_KEY, busLevels, loadMix, saveMix, type MixState } from "./mix"

export type SceneView = {
  listener: { x: number; z: number; rightX: number; rightZ: number; earHeight: number }
  bed: { kind: "fire" | "water"; x: number; y: number; z: number } | null
  /** Street ambience level, 0 for none. */
  ambience: number
}

/**
 * Lab sound. Each loaded game plays its own sound through its `LabAudioAdapter` (Getaway's car audio, Blackout's
 * Sound); the shared runtime only covers effects no game has a sound for (glass, sparks, splats, fire and water
 * beds). One AudioContext, created on the first pointer or key gesture and handed to every adapter.
 */
export class SceneAudio {
  readonly runtime: AudioRuntime
  readonly adapters: LabAudioAdapter[] = []
  mix: MixState
  private readonly storage: Storage | null
  private readonly listeners = new Set<(mix: MixState) => void>()
  private audioLab?: AudioLabController
  private armed?: AbortController
  private characters: { id: string; state: unknown }[] = []
  private listener = { x: 0, z: 0 }
  private beds: Partial<Record<"fire" | "water", VoiceHandle>> = {}
  private crackle = 0
  unlocked = false
  /** Inputs received, audible or not (for proofs). */
  readonly counts = { events: 0, characterTicks: 0, gameEvents: 0, sharedEvents: 0 }

  constructor(options: { storage: Storage | null; automated: boolean; baseUrl: string }) {
    this.storage = options.storage
    let raw: string | null = null
    try { raw = this.storage?.getItem(MIX_STORAGE_KEY) ?? null } catch { /* Private mode. */ }
    this.mix = loadMix(raw, options.automated)
    this.runtime = new AudioRuntime({ baseUrl: options.baseUrl, cues: LAB_CUES, maxVoices: 32, reverbWet: 0.3, autoBindDom: false })
    this.runtime.registerCues(LAB_CUES)
    this.runtime.muted = this.mix.muted
    this.runtime.volume = this.mix.volume
  }

  /** Creates and resumes audio on the first gesture only; pauses with the tab. */
  arm(target: Window = window) {
    if (this.armed) return
    const armed = this.armed = new AbortController()
    const unlock = () => {
      if (this.unlocked) return
      this.unlocked = true
      void this.runtime.unlock().then(() => { this.apply(); for (const adapter of this.adapters) void this.attach(adapter) })
    }
    for (const type of ["pointerdown", "keydown", "touchend"]) target.addEventListener(type, unlock, { capture: true, signal: armed.signal })
    target.document.addEventListener("visibilitychange", () => { if (target.document.hidden) this.silence(); else void this.runtime.resume() }, { signal: armed.signal })
    target.addEventListener("blur", () => this.silence(), { signal: armed.signal })
    target.addEventListener("pagehide", () => this.dispose(), { signal: armed.signal })
  }

  /** Adds a game's audio; attaches at once if audio is already unlocked. */
  add(adapter: LabAudioAdapter) {
    this.adapters.push(adapter)
    adapter.mix(this.mix)
    if (this.runtime.ctx) void this.attach(adapter)
  }

  private async attach(adapter: LabAudioAdapter) {
    const ctx = this.runtime.ctx
    if (!ctx) return
    await adapter.attach(ctx)
    adapter.mix(this.mix)
  }

  onChange(fn: (mix: MixState) => void) { this.listeners.add(fn); fn(this.mix); return () => { this.listeners.delete(fn) } }

  set(patch: Partial<MixState>) {
    this.mix = { ...this.mix, ...patch }
    try { this.storage?.setItem(MIX_STORAGE_KEY, saveMix(this.mix)) } catch { /* Private mode. */ }
    this.apply()
    if (patch.muted === false) this.runtime.playCue("ui_confirm", { intensity: 0.5 })
    for (const fn of this.listeners) fn(this.mix)
  }

  toggleMute() { this.set({ muted: !this.mix.muted }) }

  /** The Audio section's audition runtime follows the same mute and volume. */
  attachAudioLab(controller: AudioLabController) { this.audioLab = controller; this.apply() }

  private apply() {
    for (const runtime of [this.runtime, this.audioLab?.runtime]) {
      if (!runtime) continue
      runtime.setVolume(this.mix.volume)
      runtime.setMuted(this.mix.muted)
      for (const [bus, level] of Object.entries(busLevels(this.mix))) runtime.setBusGain(bus as keyof ReturnType<typeof busLevels>, level)
    }
    for (const adapter of this.adapters) adapter.mix(this.mix)
    if (this.audioLab) this.audioLab.settings.muted = this.mix.muted
    if (this.mix.muted) { this.beds = {}; for (const adapter of this.adapters) adapter.silence() }
  }

  private get live() { return Boolean(this.runtime.ctx && this.runtime.ctx.state === "running" && !this.mix.muted) }

  /** A game plays its own sound for the effect; the shared one only stands in when none covers it. */
  event(event: LabEvent) {
    this.counts.events++
    if (!this.live) return
    let covered = false
    for (const adapter of this.adapters) if (adapter.event?.(event, this.listener)) covered = true
    if (covered) { this.counts.gameEvents++; return }
    const sounds = effectSounds(event.effect, event.variant)
    if (sounds.length) this.counts.sharedEvents++
    for (const sound of sounds) {
      this.runtime.playCue(sound.cue, { intensity: sound.intensity, force: 0.6 + sound.intensity * 0.6, position: { x: event.x, y: event.y, z: event.z } })
    }
  }

  /** A character's `sound()` state after a simulated tick, delivered to the adapters on the next frame. */
  character(id: string, state: unknown) {
    this.counts.characterTicks++
    if (state !== undefined) this.characters.push({ id, state })
  }

  update(view: SceneView, dt: number) {
    this.listener = { x: view.listener.x, z: view.listener.z }
    this.runtime.setListener({ ...view.listener, vx: 0, vz: 0 })
    // Only the latest state per character: adapters run once per frame however many ticks were simulated.
    const latest = new Map<string, unknown>()
    for (const { id, state } of this.characters) latest.set(id, state)
    const ticks = this.characters
    this.characters = []
    if (!this.live) { this.stopBeds(); return }
    const frame = { dt, listener: view.listener, ambience: view.ambience, characters: [...latest].map(([id, state]) => ({ id, state })) }
    for (const adapter of this.adapters) {
      // Animation cues (footsteps) are per tick; let adapters see each one.
      adapter.update({ ...frame, characters: adapter.id === "blackout" ? ticks : frame.characters })
    }
    const bed = view.bed
    this.bed("fire", bed?.kind === "fire" ? "lab_fire_bed" : null, bed ?? undefined)
    this.bed("water", bed?.kind === "water" ? "lab_water_bed" : null, bed ?? undefined)
    if (bed?.kind === "fire") {
      this.crackle -= dt
      if (this.crackle <= 0) {
        this.crackle = 0.04 + this.runtime.nextRandom() * 0.16
        this.runtime.playCue("lab_fire_crackle", { intensity: 0.4 + this.runtime.nextRandom() * 0.6, position: bed })
      }
    }
  }

  private bed(slot: "fire" | "water", cue: string | null, position?: { x: number; y: number; z: number }) {
    const current = this.beds[slot]
    if (!cue) { if (current) { current.stop(0.4); delete this.beds[slot] } return }
    if (current?.active) {
      if (position) {
        const spatial = this.runtime.spatialize(position)
        current.setParams({ gain: (this.runtime.cues.get(cue)?.masterGain ?? 1) * spatial.gain, pan: spatial.pan, cutoffHz: spatial.cutoffHz }, 0.15)
      }
      return
    }
    const voice = this.runtime.playCue(cue, { position, ownerKey: `bed:${slot}` })
    if (voice) this.beds[slot] = voice
  }

  private stopBeds() { this.bed("fire", null); this.bed("water", null) }

  silence() { this.stopBeds(); this.runtime.stopAllVoices(0.03); for (const adapter of this.adapters) adapter.silence() }

  telemetry() {
    const t = this.runtime.telemetry()
    return {
      ...this.mix, ...this.counts, state: t.state, contexts: this.runtime.ctx ? 1 : 0, voices: t.activeVoices, loadedSamples: t.loadedSamples,
      masterGain: this.runtime.master?.gain.value ?? null, beds: Object.keys(this.beds),
      adapters: Object.fromEntries(this.adapters.map(adapter => [adapter.id, adapter.inspect?.() ?? true])),
    }
  }

  dispose() { this.armed?.abort(); this.runtime.dispose() }
}
