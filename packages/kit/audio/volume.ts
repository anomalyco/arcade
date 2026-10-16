import type { LabControl, LabPanel } from "../lab-panel"
import type { MixCategory } from "./types"

/**
 * Player volume: Master, Effects, Ambience, Voices and Music, as percentages, saved per game. They multiply on top of a
 * game's own mix (its designer bus levels), so a player turning Ambience down never changes how the game is mixed.
 * A game lists the channels it has; a channel with no buses (Music in a game without music) is not shown.
 */
export type VolumeChannel = "master" | "effects" | "ambience" | "voice" | "music"

export type VolumeSettings = {
  volumeMaster: number
  volumeEffects: number
  volumeAmbience: number
  volumeVoice: number
  volumeMusic: number
}

export const DEFAULT_VOLUME_SETTINGS: VolumeSettings = {
  volumeMaster: 80,
  volumeEffects: 100,
  volumeAmbience: 100,
  volumeVoice: 100,
  volumeMusic: 100,
}

const KEY: Record<VolumeChannel, keyof VolumeSettings> = {
  master: "volumeMaster",
  effects: "volumeEffects",
  ambience: "volumeAmbience",
  voice: "volumeVoice",
  music: "volumeMusic",
}

const LABEL: Record<VolumeChannel, string> = {
  master: "Master",
  effects: "Effects",
  ambience: "Ambience",
  voice: "Voices",
  music: "Music",
}

/** Which runtime buses each channel scales. Music has no bus in the shared runtime yet. */
export const VOLUME_BUSES: Readonly<Record<Exclude<VolumeChannel, "master">, readonly MixCategory[]>> = {
  effects: ["weapon", "foley", "impact", "ui", "engine", "tyre", "spell"],
  ambience: ["ambience"],
  voice: ["voice"],
  music: [],
}

export const volumeStorageKey = (game: string) => `arcade.volume.${game}.v1`

/** Lab rows for the channels a game has, in the order given (`labels` renames one, e.g. Voices → "Zombie voices"). */
export function volumeControls(channels: readonly VolumeChannel[], group = "Volume", labels: Partial<Record<VolumeChannel, string>> = {}): LabControl[] {
  return channels.map((c) => ({ key: KEY[c], label: labels[c] ?? LABEL[c], group, min: 0, max: 100, step: 5, unit: "%" }))
}

/** Binds a `Volume` group (Mute + channel sliders) on a `LabPanel` to a game's `VolumeSettings` and mute state. */
export function bindVolumeControls(
  panel: Pick<LabPanel, "addControls">,
  opts: {
    volumes: VolumeSettings
    channels: readonly VolumeChannel[]
    labels?: Partial<Record<VolumeChannel, string>>
    group?: string
    getMuted: () => boolean
    setMuted: (muted: boolean) => void
    onChange: () => void
  },
): void {
  const group = opts.group ?? "Volume"
  const bag: Record<string, boolean | number | string> = {}
  Object.defineProperty(bag, "audioMuted", {
    enumerable: true,
    configurable: true,
    get: opts.getMuted,
    set: (v) => opts.setMuted(Boolean(v)),
  })
  for (const ch of opts.channels) {
    const k = KEY[ch]
    Object.defineProperty(bag, k, {
      enumerable: true,
      configurable: true,
      get: () => opts.volumes[k],
      set: (v) => {
        opts.volumes[k] = clampLevel(Number(v))
        opts.onChange()
      },
    })
  }
  panel.addControls(
    bag,
    [{ key: "audioMuted", label: "Mute (M)", group }, ...volumeControls(opts.channels, group, opts.labels)],
    { audioMuted: false, ...DEFAULT_VOLUME_SETTINGS },
  )
}

/** The player's volume for one bus, 0..1, master excluded (the runtime applies master on its own). */
export function busVolume(settings: VolumeSettings, bus: MixCategory): number {
  for (const channel of ["effects", "ambience", "voice", "music"] as const) {
    if (VOLUME_BUSES[channel].includes(bus)) return clampLevel(settings[KEY[channel]]) / 100
  }
  return 1
}

/** Reads a saved choice into `into` (unknown or out-of-range values keep the defaults). */
export function loadVolumeSettings(storage: Pick<Storage, "getItem"> | null | undefined, game: string, into: VolumeSettings): boolean {
  if (!storage) return false
  try {
    const saved = JSON.parse(storage.getItem(volumeStorageKey(game)) ?? "null") as Partial<Record<keyof VolumeSettings, unknown>> | null
    if (!saved || typeof saved !== "object") return false
    for (const key of Object.values(KEY)) {
      const v = saved[key]
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) into[key] = v
    }
    return true
  } catch {
    return false
  }
}

/** Saves the player's volumes when they changed since `previous` (the last saved JSON); returns the JSON now saved. */
export function saveVolumeSettings(storage: Pick<Storage, "setItem"> | null | undefined, game: string, settings: VolumeSettings, previous = ""): string {
  const json = JSON.stringify(Object.fromEntries(Object.values(KEY).map((k) => [k, settings[k]])))
  if (json !== previous) {
    try {
      storage?.setItem(volumeStorageKey(game), json)
    } catch {
      /* Private mode. */
    }
  }
  return json
}

function clampLevel(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100
}
