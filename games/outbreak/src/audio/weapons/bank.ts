import type { AudioRuntime, CueRecipe, VoiceHandle } from "@arcade/kit/audio"
import type { AudioSettings } from "../settings"
import { WEAPON_GROUP_KEYS, WEAPON_TOGGLE_KEYS } from "../settings"
import type { SoundEvent } from "../types"
import { variantId, WEAPON_KEYS, WEAPON_SAMPLE_RATE, weaponSound, type WeaponSoundDef } from "./catalog"
import type { WeaponMix } from "./weapons"

/** The cue for a weapon sound: its baked takes, round-robin, with its own jitter, on its bus. */
export function weaponCue(def: WeaponSoundDef): CueRecipe {
  return {
    id: def.id,
    label: def.label,
    category: def.bus,
    masterGain: def.gain,
    loop: def.loop ?? false,
    wet: def.wet,
    maxVoices: def.maxVoices,
    ...(def.priority !== undefined ? { priority: def.priority } : {}),
    steal: "steal-oldest",
    pitchVariation: def.pitchJitter,
    gainVariation: def.gainJitter,
    ...(def.duck ? { duck: def.duck } : {}),
    layers: [{ kind: "sample", samples: Array.from({ length: def.variants }, (_, v) => variantId(def.id, v)), selection: "round-robin", ...(def.loop ? { envelope: { attack: 0.08 } } : {}) }],
  }
}

/** Writes the Lab's Weapons settings into `mix` (no allocation). */
export function weaponMix(s: AudioSettings, mix: WeaponMix): WeaponMix {
  mix.on = s.audioWeaponSet > 0
  mix.impacts = Boolean(s.audioWpnSurfaces)
  mix.nearRange = s.audioWpnNear
  for (const k of WEAPON_KEYS) mix.weapons[k] = Boolean(s[WEAPON_TOGGLE_KEYS[k]])
  return mix
}

/** The ids nearly every session needs early: the pistol, its tails and brass, flesh and the common surfaces. */
export const WEAPON_PREWARM = [
  "wpn.pistol.report",
  "wpn.tail.room.small",
  "wpn.tail.street.small",
  "wpn.tail.alley.small",
  "wpn.tail.open.small",
  "wpn.pistol.far",
  "wpn.brass.hard",
  "wpn.brass.wood",
  "wpn.brass.soft",
  "wpn.impact.flesh",
  "wpn.impact.wood",
  "wpn.impact.plaster",
  "wpn.hit.flesh-light",
  "wpn.hit.flesh-heavy",
  "wpn.pistol.release",
  "wpn.pistol.out",
  "wpn.pistol.in",
  "wpn.pistol.slide",
  "wpn.pistol.dry",
] as const

/**
 * Layered weapon sounds in the game: bakes each sound's takes on first use (in a Worker, so a frame never pays for
 * synthesis), registers them as round-robin cues and plays them positioned like the library's. A sound not baked yet
 * returns null, and the caller plays the event's Today fallback instead, so nothing is ever silent.
 */
export class WeaponBank {
  private readonly ready = new Set<string>()
  private readonly baking = new Set<string>()
  private worker: Worker | null = null
  private workerFailed = false
  readonly counts = { bakes: 0, bakeMs: 0, maxBakeMs: 0, played: 0, fallbacks: 0 }

  constructor(
    private readonly runtime: AudioRuntime,
    private readonly useWorker = typeof Worker !== "undefined",
  ) {}

  prewarm(ids: readonly string[] = WEAPON_PREWARM): void {
    for (const id of ids) this.ensure(id)
  }

  /** Whether `id` is baked and registered; starts baking it if not. */
  ensure(id: string): boolean {
    if (this.ready.has(id)) return true
    if (this.baking.has(id)) return false
    const def = weaponSound(id)
    if (!def) return false
    this.baking.add(id)
    const worker = this.useWorker && !this.workerFailed ? this.bakeWorker() : null
    if (worker) {
      worker.postMessage({ id })
      return false
    }
    const t0 = performance.now()
    this.register(def, Array.from({ length: def.variants }, (_, v) => def.bake(WEAPON_SAMPLE_RATE, v)), performance.now() - t0)
    return true
  }

  /** Plays a `wpn.*` event, or returns null when it is not baked yet (or unknown). */
  play(event: SoundEvent, s: AudioSettings, rolloff: number): VoiceHandle | null {
    const def = weaponSound(event.id)
    if (!def || !this.ensure(event.id)) {
      this.counts.fallbacks++
      return null
    }
    const level = (s[WEAPON_GROUP_KEYS[def.group]] as number) / 100
    const variation = s.audioWpnVariation / 100
    const voice = this.runtime.playCue(event.id, {
      time: this.runtime.now + (event.delay ?? 0),
      gain: (event.gain ?? 1) * level,
      rate: event.rate,
      cutoffHz: event.cutoffHz,
      priority: event.priority,
      pitchVariation: def.pitchJitter * variation,
      gainVariation: def.gainJitter * variation,
      position: { x: event.x, z: event.y, refDistance: def.range.ref * 0.78, maxDistance: def.range.max, rolloff },
    })
    if (voice) this.counts.played++
    return voice
  }

  /** The range and level of a held weapon loop, or null while it bakes. */
  held(id: string, s: AudioSettings): { range: { ref: number; max: number }; gain: number; level: number } | null {
    const def = weaponSound(id)
    if (!def || !this.ensure(id)) return null
    const level = (s[WEAPON_GROUP_KEYS[def.group]] as number) / 100
    return { range: def.range, gain: def.gain * level, level }
  }

  private bakeWorker(): Worker | null {
    if (this.worker) return this.worker
    try {
      const w = new Worker(new URL("./bake-worker.ts", import.meta.url), { type: "module" })
      w.onmessage = (e: MessageEvent<{ id: string; takes: Float32Array[]; ms: number }>) => {
        const def = weaponSound(e.data.id)
        if (def) this.register(def, e.data.takes, e.data.ms)
      }
      w.onerror = () => {
        this.workerFailed = true
        this.baking.clear()
      }
      this.worker = w
      return w
    } catch {
      this.workerFailed = true
      return null
    }
  }

  private register(def: WeaponSoundDef, takes: Float32Array[], ms: number): void {
    takes.forEach((pcm, v) => this.runtime.sampleBank.setDecoded(variantId(def.id, v), { sampleRate: WEAPON_SAMPLE_RATE, channels: [pcm] }, true))
    this.runtime.registerCues([weaponCue(def)])
    this.baking.delete(def.id)
    this.ready.add(def.id)
    this.counts.bakes++
    this.counts.bakeMs += ms
    this.counts.maxBakeMs = Math.max(this.counts.maxBakeMs, ms)
  }

  telemetry() {
    return { ...this.counts, ready: this.ready.size, baking: this.baking.size }
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
