import type { MixCategory } from "@arcade/kit/audio"

/** Listener-facing mix groups and the runtime buses each one drives. */
export const MIX_GROUPS = {
  vehicles: { label: "Vehicles", buses: ["engine", "tyre"] },
  effects: { label: "Effects", buses: ["impact", "spell", "weapon", "foley", "voice"] },
  ambience: { label: "Ambience", buses: ["ambience"] },
  ui: { label: "UI", buses: ["ui"] },
} as const satisfies Record<string, { label: string; buses: readonly MixCategory[] }>
export type MixGroup = keyof typeof MIX_GROUPS
export const MIX_GROUP_IDS = Object.keys(MIX_GROUPS) as MixGroup[]

export type MixState = { muted: boolean; volume: number } & Record<MixGroup, number>

export const MIX_STORAGE_KEY = "arcade.lab.audio.v1"
export const DEFAULT_MIX: Readonly<MixState> = { muted: false, volume: 0.7, vehicles: 1, effects: 1, ambience: 0.6, ui: 0.8 }

const level = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback

/**
 * Reads the saved mix. Unknown or malformed fields fall back to defaults. With nothing saved, automation
 * (`navigator.webdriver`) starts muted so headless proofs never play sound.
 */
export function loadMix(raw: string | null, automated: boolean): MixState {
  let saved: Record<string, unknown> = {}
  try { const parsed: unknown = raw ? JSON.parse(raw) : null; if (parsed && typeof parsed === "object") saved = parsed as Record<string, unknown> } catch { /* Defaults. */ }
  const mix: MixState = { ...DEFAULT_MIX, muted: typeof saved.muted === "boolean" ? saved.muted : automated, volume: level(saved.volume, DEFAULT_MIX.volume) }
  for (const group of MIX_GROUP_IDS) mix[group] = level(saved[group], DEFAULT_MIX[group])
  return mix
}

export const saveMix = (mix: MixState) => JSON.stringify(mix)

/** Bus gain for every runtime category under this mix. */
export function busLevels(mix: MixState): Record<MixCategory, number> {
  const levels = { engine: 1, tyre: 1, impact: 1, ambience: 1, spell: 1, ui: 1, weapon: 1, foley: 1, voice: 1 } satisfies Record<MixCategory, number>
  for (const group of MIX_GROUP_IDS) for (const bus of MIX_GROUPS[group].buses) levels[bus] = mix[group]
  return levels
}
