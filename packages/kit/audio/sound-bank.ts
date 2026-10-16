import type { LabPanel } from "../lab-panel"
import { DEFAULT_CUES } from "./cues"
import { selectSfx, sfxCues, sfxManifest } from "./library"
import { DEFAULT_SAMPLE_MANIFEST } from "./manifest"
import { AudioRuntime, MIX_CATEGORIES } from "./runtime"
import {
  bindVolumeControls,
  busVolume,
  DEFAULT_VOLUME_SETTINGS,
  loadVolumeSettings,
  saveVolumeSettings,
  type VolumeChannel,
  type VolumeSettings,
} from "./volume"

/** Default shared sound-library placeholders wired into new toy prototypes (`scripts/new-toy.ts`). */
export const TOY_SFX = [
  "foot.concrete.walk",
  "foot.concrete.run",
  "melee.swing.light",
  "melee.swing.heavy",
  "melee.hit.wood",
  "melee.hit.metal",
  "melee.shove",
  "body.hurt",
  "door.bash",
  "ui.click",
  "ui.ping",
  "ui.tick",
] as const

/**
 * Shared sound bank for toys and games: combines the shared synth cues (`DEFAULT_CUES`) and curated library
 * samples (`selectSfx(sfx)`), unlocks on the first gesture, respects `navigator.webdriver` mute defaults, and
 * binds `Volume` controls (`Mute (M)` + channel sliders) to `LabPanel`.
 */
export class SoundBank {
  readonly runtime: AudioRuntime
  readonly volumes: VolumeSettings = { ...DEFAULT_VOLUME_SETTINGS }
  readonly played: Record<string, number> = {}
  private unlocked = false
  private savedJson = ""
  private readonly muteKey: string

  constructor(
    readonly game: string,
    sfx: readonly string[] = TOY_SFX,
  ) {
    this.muteKey = `arcade.muted.${game}.v1`
    const entries = selectSfx(sfx)
    this.runtime = new AudioRuntime({
      manifest: [...DEFAULT_SAMPLE_MANIFEST, ...sfxManifest(entries)],
      cues: [...DEFAULT_CUES, ...sfxCues(entries)],
      maxVoices: 36,
      reverbWet: 0.14,
      autoBindDom: false,
    })
    if (typeof localStorage !== "undefined") {
      loadVolumeSettings(localStorage, game, this.volumes)
      this.savedJson = JSON.stringify(this.volumes)
      const savedMute = localStorage.getItem(this.muteKey)
      this.runtime.muted = savedMute === null ? Boolean(globalThis.navigator?.webdriver) : savedMute === "1"
    }
    if (typeof addEventListener === "function") {
      const unlock = () => {
        if (this.unlocked) return
        this.unlocked = true
        void this.runtime.unlock().then(() => this.applyVolumes())
      }
      for (const type of ["pointerdown", "keydown"] as const) addEventListener(type, unlock, { capture: true })
    }
  }

  get muted(): boolean {
    return this.runtime.muted
  }

  setMuted(muted: boolean): void {
    this.runtime.setMuted(muted)
    try {
      localStorage.setItem(this.muteKey, muted ? "1" : "0")
    } catch {}
  }

  toggleMute(): void {
    this.setMuted(!this.muted)
  }

  applyVolumes(): void {
    if (typeof localStorage !== "undefined") {
      this.savedJson = saveVolumeSettings(localStorage, this.game, this.volumes, this.savedJson)
    }
    if (!this.runtime.ctx || this.runtime.isOffline) return
    this.runtime.setVolume(this.volumes.volumeMaster / 100)
    for (const cat of MIX_CATEGORIES) {
      this.runtime.setBusGain(cat, busVolume(this.volumes, cat))
    }
  }

  bindControls(panel: Pick<LabPanel, "addControls">, channels: readonly VolumeChannel[] = ["master", "effects", "ambience"]): void {
    bindVolumeControls(panel, {
      volumes: this.volumes,
      channels,
      getMuted: () => this.muted,
      setMuted: (m) => this.setMuted(m),
      onChange: () => this.applyVolumes(),
    })
  }

  listen(x: number, y: number, earHeight = 12): void {
    this.runtime.setListener({ x, z: y, y: earHeight })
  }

  play(id: string, x?: number, y?: number, opts: { gain?: number; rate?: number; intensity?: number } = {}): void {
    this.played[id] = (this.played[id] ?? 0) + 1
    if (!this.runtime.ctx) return
    this.runtime.playCue(id, {
      ...opts,
      position: x === undefined ? undefined : { x, z: y ?? 0, y: 0, refDistance: 14, maxDistance: 70 },
    })
  }
}
