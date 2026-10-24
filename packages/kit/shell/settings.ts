import { DEFAULT_VOLUME_SETTINGS, loadVolumeSettings, saveVolumeSettings, type VolumeChannel, type VolumeSettings } from "../audio/volume"
import { keyLabelMode, setKeyLabelMode, type KeyLabelMode } from "../client/controls"
import type { QualityMode, QualityTier } from "../quality"

type Storage2 = Pick<Storage, "getItem" | "setItem">

/** What the shell needs from a game's quality (a `GameQuality` from `createShellQuality` fits as is). */
export interface ShellQuality {
  readonly mode: QualityMode
  /** The tier in force: what Auto settled on, or the pinned tier. */
  readonly tier: QualityTier
  /** Omitted by older adapters: Auto, High, Balanced and Low. */
  readonly modes?: readonly QualityMode[]
  readonly resolutionScale?: number
  setMode(mode: QualityMode): void
}

/** One row of a game's own settings section. Rows read and write the game's state through `get`/`set`. */
export type ShellRow =
  | { kind: "range"; id: string; label: string; min: number; max: number; step: number; unit?: string; get(): number; set(v: number): void }
  | { kind: "toggle"; id: string; label: string; get(): boolean; set(v: boolean): void }
  | { kind: "choice"; id: string; label: string; options: readonly { value: string; label: string }[]; get(): string; set(v: string): void }

/** A game-specific block in the settings screen, after Sound and Graphics and before Controls. */
export type ShellSection = { id: string; title: string; rows: readonly ShellRow[] }

export type ShellSettingsOptions = {
  /** The game's id; volume and mute are saved per game (`arcade.volume.<game>.v1`, `arcade.mute.<game>.v1`). */
  game: string
  /** The volume channels the game has, master first. A channel the game has no sound for is left out. */
  channels?: readonly VolumeChannel[]
  /** Renames a channel (Voices → "Zombies"). */
  labels?: Partial<Record<VolumeChannel, string>>
  quality?: ShellQuality | null
  sections?: readonly ShellSection[]
  /** An older key the game saved its mute in (`brawl.muted`), read once when the shell's own key is empty. */
  legacyMuteKey?: string
  /** An older key the game saved reduce camera motion in (`nightshift.reduceMotion`). */
  legacyReduceMotionKey?: string
  storage?: Storage2 | null
  /** Automation (navigator.webdriver) starts muted and ignores saved volumes so runs are reproducible and silent. */
  automated?: boolean
  /** The player's OS asks for reduced motion (the default for Reduce camera motion). */
  prefersReducedMotion?: boolean
}

export const muteStorageKey = (game: string) => `arcade.mute.${game}.v1`
/** Reduce camera motion is one choice for every game, like Key labels. */
export const REDUCE_MOTION_STORAGE_KEY = "arcade.reduceMotion"

const CHANNEL_KEY: Record<VolumeChannel, keyof VolumeSettings> = {
  master: "volumeMaster",
  effects: "volumeEffects",
  engine: "volumeEngine",
  ambience: "volumeAmbience",
  voice: "volumeVoice",
  music: "volumeMusic",
}
export const CHANNEL_LABEL: Record<VolumeChannel, string> = { master: "Master", effects: "Effects", engine: "Engines", ambience: "Ambience", voice: "Voices", music: "Music" }

/**
 * The player-facing settings every game shares: volume per channel and mute (saved per game), graphics quality (the
 * game's `ShellQuality`, saved per game by it), reduce camera motion and key labels (one choice across games), plus
 * any sections the game plugs in. Headless: views subscribe and call the setters; the game reads the values (or
 * `gain(channel)`) and subscribes to apply them live.
 */
export class ShellSettings {
  readonly game: string
  readonly channels: readonly VolumeChannel[]
  readonly labels: Readonly<Record<VolumeChannel, string>>
  readonly quality: ShellQuality | null
  readonly sections: readonly ShellSection[]
  /** The player's volumes, 0–100 per channel, in the shape `@arcade/kit/audio` games already use. */
  readonly volumes: VolumeSettings = { ...DEFAULT_VOLUME_SETTINGS }
  private _muted = false
  private _reduceMotion = false
  private readonly storage: Storage2 | null
  private readonly automated: boolean
  private savedVolumes = ""
  /** The master level unmuting comes back to when the slider was taken to 0: the last level heard. */
  private restoreMaster = DEFAULT_VOLUME_SETTINGS.volumeMaster
  private readonly listeners = new Set<() => void>()

  constructor(o: ShellSettingsOptions) {
    this.game = o.game
    this.channels = o.channels ?? ["master", "effects", "ambience"]
    this.labels = { ...CHANNEL_LABEL, ...o.labels }
    this.quality = o.quality ?? null
    this.sections = o.sections ?? []
    this.storage = o.storage === undefined ? safeStorage() : o.storage
    this.automated = o.automated ?? (typeof navigator !== "undefined" && Boolean(navigator.webdriver))
    if (!this.automated) loadVolumeSettings(this.storage, this.game, this.volumes)
    this.savedVolumes = JSON.stringify(this.volumes)
    const muted = read(this.storage, muteStorageKey(this.game)) ?? (o.legacyMuteKey ? read(this.storage, o.legacyMuteKey) : null)
    this._muted = this.automated || muted === "1" || muted === "true"
    // Master and mute are one control: master at 0 is muted.
    if (this.volumes.volumeMaster > 0) this.restoreMaster = this.volumes.volumeMaster
    else this._muted = true
    const motion = read(this.storage, REDUCE_MOTION_STORAGE_KEY) ?? (o.legacyReduceMotionKey ? read(this.storage, o.legacyReduceMotionKey) : null)
    this._reduceMotion = motion === null ? Boolean(o.prefersReducedMotion ?? prefersReducedMotion()) : motion === "true" || motion === "1"
  }

  get muted(): boolean {
    return this._muted
  }

  get reduceMotion(): boolean {
    return this._reduceMotion
  }

  get keyLabels(): KeyLabelMode {
    return keyLabelMode()
  }

  /** A channel's level, 0–100. */
  volume(channel: VolumeChannel): number {
    return this.volumes[CHANNEL_KEY[channel]]
  }

  /** A channel's gain for the game's mix, 0..1: master × channel, 0 while muted. */
  gain(channel: VolumeChannel): number {
    if (this._muted) return 0
    const master = this.volumes.volumeMaster / 100
    return channel === "master" ? master : master * (this.volumes[CHANNEL_KEY[channel]] / 100)
  }

  setVolume(channel: VolumeChannel, value: number): void {
    const v = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 100)))
    const key = CHANNEL_KEY[channel]
    if (this.volumes[key] === v) return
    this.volumes[key] = v
    if (channel === "master") {
      if (v > 0) this.restoreMaster = v
      // Master and mute are one control: taking it to 0 mutes, and moving it up from muted is asking to hear it.
      if (v === 0 || this._muted) this.writeMuted(v === 0)
    }
    if (!this.automated) this.savedVolumes = saveVolumeSettings(this.storage, this.game, this.volumes, this.savedVolumes)
    this.emit()
  }

  /** Unmuting with master at 0 brings master back to the last level heard. */
  setMuted(muted: boolean): void {
    if (this._muted === muted) return
    this.writeMuted(muted)
    if (!muted && this.volumes.volumeMaster === 0) {
      this.volumes.volumeMaster = this.restoreMaster
      if (!this.automated) this.savedVolumes = saveVolumeSettings(this.storage, this.game, this.volumes, this.savedVolumes)
    }
    this.emit()
  }

  private writeMuted(muted: boolean): void {
    if (this._muted === muted) return
    this._muted = muted
    if (!this.automated) write(this.storage, muteStorageKey(this.game), muted ? "1" : "0")
  }

  toggleMute(): void {
    this.setMuted(!this._muted)
  }

  setQuality(mode: QualityMode): void {
    if (!this.quality || this.quality.mode === mode) return
    this.quality.setMode(mode)
    this.emit()
  }

  setReduceMotion(on: boolean): void {
    if (this._reduceMotion === on) return
    this._reduceMotion = on
    write(this.storage, REDUCE_MOTION_STORAGE_KEY, String(on))
    this.emit()
  }

  setKeyLabels(mode: KeyLabelMode): void {
    if (keyLabelMode() === mode) return
    setKeyLabelMode(mode)
    this.emit()
  }

  /** Tell views something changed outside the shell (the Lab panel, a game row, Auto stepping down). */
  changed(): void {
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}

function read(storage: Storage2 | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(storage: Storage2 | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    /* Private mode. */
  }
}

function safeStorage(): Storage2 | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}
