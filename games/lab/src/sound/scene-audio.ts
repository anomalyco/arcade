import { AudioRuntime, VehicleAudioEmitter, type AudioLabController, type VoiceHandle } from "@arcade/kit/audio"
import type { LabEvent } from "@arcade/kit/lab/types"
import { LAB_CUES, effectSounds } from "./cues"
import { MIX_STORAGE_KEY, busLevels, loadMix, saveMix, type MixState } from "./mix"

export type VehicleSample = {
  vehicle: string
  x: number
  z: number
  vx?: number
  vz?: number
  speed: number
  drift: number
  impact?: number
  airborne?: boolean
  fuel?: number
  input?: { throttle?: number; handbrake?: boolean; boost?: boolean }
}
export type WalkerSample = { x: number; z: number; speed: number; sprint?: number }
export type SceneView = {
  listener: { x: number; z: number; rightX: number; rightZ: number; earHeight: number }
  bed: { kind: "fire" | "water"; x: number; y: number; z: number } | null
  /** Street ambience level, 0 for none. */
  ambience: number
}

const STALE_MS = 250

/**
 * Scene sound for the Lab on the shared audio runtime: vehicle engine/tyres/impacts, footsteps, effect one-shots,
 * fire and water beds, and street ambience. No AudioContext exists until the first pointer or key gesture.
 */
export class SceneAudio {
  readonly runtime: AudioRuntime
  mix: MixState
  private readonly storage: Storage | null
  private readonly listeners = new Set<(mix: MixState) => void>()
  private readonly vehicleEmitter: VehicleAudioEmitter
  private audioLab?: AudioLabController
  private armed?: AbortController
  private vehicleAt = -Infinity
  private stride = 0
  private beds: Partial<Record<"fire" | "water" | "ambience", VoiceHandle>> = {}
  private crackle = 0
  unlocked = false
  /** Inputs received, audible or not (for proofs). */
  readonly counts = { events: 0, vehicleTicks: 0, steps: 0 }

  constructor(options: { storage: Storage | null; automated: boolean; baseUrl: string }) {
    this.storage = options.storage
    let raw: string | null = null
    try { raw = this.storage?.getItem(MIX_STORAGE_KEY) ?? null } catch { /* Private mode. */ }
    this.mix = loadMix(raw, options.automated)
    this.runtime = new AudioRuntime({ baseUrl: options.baseUrl, cues: LAB_CUES, maxVoices: 32, reverbWet: 0.3, autoBindDom: false })
    // The defaults (crash, clink, ambience, UI) stay registered beside the Lab cues.
    this.runtime.registerCues(LAB_CUES)
    this.runtime.muted = this.mix.muted
    this.runtime.volume = this.mix.volume
    this.vehicleEmitter = new VehicleAudioEmitter(this.runtime, { id: "lab-vehicle" })
  }

  /** Creates and resumes audio on the first gesture only; pauses with the tab. */
  arm(target: Window = window) {
    if (this.armed) return
    const armed = this.armed = new AbortController()
    const unlock = () => {
      if (this.unlocked) return
      this.unlocked = true
      void this.runtime.unlock().then(() => this.apply())
    }
    for (const type of ["pointerdown", "keydown", "touchend"]) target.addEventListener(type, unlock, { capture: true, signal: armed.signal })
    target.document.addEventListener("visibilitychange", () => { if (target.document.hidden) this.silence(); else void this.runtime.resume() }, { signal: armed.signal })
    target.addEventListener("blur", () => this.silence(), { signal: armed.signal })
    target.addEventListener("pagehide", () => this.dispose(), { signal: armed.signal })
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
    if (this.audioLab) this.audioLab.settings.muted = this.mix.muted
    if (this.mix.muted) this.beds = {}
  }

  private get live() { return Boolean(this.runtime.ctx && this.runtime.ctx.state === "running" && !this.mix.muted) }

  event(event: LabEvent) {
    this.counts.events++
    if (!this.live) return
    for (const sound of effectSounds(event.effect, event.variant)) {
      this.runtime.playCue(sound.cue, { intensity: sound.intensity, force: 0.6 + sound.intensity * 0.6, position: { x: event.x, y: event.y, z: event.z } })
    }
  }

  vehicle(sample: VehicleSample, dt: number) {
    this.vehicleAt = performance.now()
    this.counts.vehicleTicks++
    if (!this.live) return
    const position = { x: sample.x, z: sample.z, vx: sample.vx, vz: sample.vz }
    this.vehicleEmitter.update({
      vehicleClass: sample.vehicle, speed: sample.speed, throttle: sample.input?.throttle ?? 0, lateralSlip: sample.drift,
      handbrake: sample.input?.handbrake, boost: sample.input?.boost, fuel: sample.fuel, airborne: sample.airborne, position,
    }, dt)
    // `impact` is the collision's impact speed in m/s; the emitter re-arms between hits.
    this.vehicleEmitter.stepImpact(Math.min(1, (sample.impact ?? 0) / 20), dt, "metal", position)
  }

  walker(sample: WalkerSample, dt: number) {
    if (sample.speed < 0.4) { this.stride = 0; return }
    this.stride += sample.speed * dt
    const length = sample.sprint ? 1.05 : 0.75
    if (this.stride < length) return
    this.stride -= length
    this.counts.steps++
    if (this.live) this.runtime.playCue("lab_footstep", { intensity: sample.sprint ? 0.9 : 0.65, position: { x: sample.x, z: sample.z } })
  }

  update(view: SceneView, dt: number) {
    this.runtime.setListener({ ...view.listener, vx: 0, vz: 0 })
    if (performance.now() - this.vehicleAt > STALE_MS) this.vehicleEmitter.update({ speed: 0, paused: true }, dt)
    if (!this.live) { this.stopBeds(); return }
    this.bed("ambience", view.ambience > 0 ? "ambience_street_bed" : null, undefined, view.ambience)
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

  private bed(slot: "fire" | "water" | "ambience", cue: string | null, position?: { x: number; y: number; z: number }, gain = 1) {
    const current = this.beds[slot]
    if (!cue) { if (current) { current.stop(0.4); delete this.beds[slot] } return }
    if (current?.active) {
      if (position) {
        const spatial = this.runtime.spatialize(position)
        current.setParams({ gain: (this.runtime.cues.get(cue)?.masterGain ?? 1) * spatial.gain * gain, pan: spatial.pan, cutoffHz: spatial.cutoffHz }, 0.15)
      } else current.setParams({ gain: (this.runtime.cues.get(cue)?.masterGain ?? 1) * gain }, 0.3)
      return
    }
    const voice = this.runtime.playCue(cue, { position, gain, ownerKey: `bed:${slot}` })
    if (voice) this.beds[slot] = voice
  }

  private stopBeds() { for (const slot of ["fire", "water", "ambience"] as const) this.bed(slot, null) }

  silence() { this.stopBeds(); this.vehicleEmitter.stop(true); this.runtime.stopAllVoices(0.03) }

  telemetry() {
    const t = this.runtime.telemetry()
    return { ...this.mix, ...this.counts, state: t.state, contexts: this.runtime.ctx ? 1 : 0, voices: t.activeVoices, loadedSamples: t.loadedSamples, masterGain: this.runtime.master?.gain.value ?? null, vehicleActive: this.vehicleEmitter.isActive, beds: Object.keys(this.beds) }
  }

  dispose() { this.armed?.abort(); this.vehicleEmitter.dispose(); this.runtime.dispose() }
}
