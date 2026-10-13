export const SPELL_IDS = ["moon", "necromancy"] as const
export type SpellId = typeof SPELL_IDS[number]
export type CastIntent = { spell: SpellId | null; quality: number; x: number; y: number }
export const SPELL_NAMES: Record<SpellId, string> = { moon: "Moon Ball", necromancy: "Necromancy" }
export const SPELL_ICONS: Record<SpellId, string> = { moon: "☾", necromancy: "☠" }
export const SPELL_LIMITS = { moon: 2, necromancy: 3, moons: 8, skeletons: 12 } as const
/** Bounds also validate host tuning on the server. */
export const SPELL_CONTROLS = {
  moonCooldown: { label: "Moon cooldown", value: 0.85, min: 0.3, max: 3, step: 0.05 },
  skeletonCooldown: { label: "Summon cooldown", value: 1.4, min: 0.5, max: 4, step: 0.1 },
  moonAnticipation: { label: "Moon anticipation", value: 0.18, min: 0.05, max: 0.4, step: 0.01 },
  moonSpeed: { label: "Moon speed", value: 2.3, min: 0.5, max: 5, step: 0.1 },
  moonSize: { label: "Moon size", value: 0.65, min: 0.2, max: 1, step: 0.05 },
  moonGrowth: { label: "Moon growth", value: 0.08, min: 0, max: 0.5, step: 0.025 },
  moonLife: { label: "Moon lifetime", value: 3.2, min: 2, max: 8, step: 0.25 },
  moonPull: { label: "Moon reach", value: 0.8, min: 0.25, max: 2, step: 0.1 },
  moonDamage: { label: "Moon damage", value: 45, min: 5, max: 100, step: 5 },
  moonFling: { label: "Moon fling", value: 8, min: 2, max: 15, step: 0.5 },
  skeletonSpeed: { label: "Skeleton speed", value: 1.5, min: 0.3, max: 3, step: 0.1 },
  skeletonHealth: { label: "Skeleton health", value: 45, min: 15, max: 150, step: 5 },
  skeletonDamage: { label: "Skeleton damage", value: 18, min: 5, max: 60, step: 1 },
  skeletonLife: { label: "Skeleton lifetime", value: 12, min: 5, max: 40, step: 1 },
  skeletonRise: { label: "Skeleton rise", value: 0.6, min: 0.3, max: 3, step: 0.1 },
  matchThreshold: { label: "Rune match", value: 0.58, min: 0.35, max: 0.8, step: 0.01 },
  cleanThreshold: { label: "Clean rune", value: 0.84, min: 0.65, max: 0.98, step: 0.01 },
} as const
export type SpellConfig = Record<keyof typeof SPELL_CONTROLS, number>
export const spellDefaults = (): SpellConfig => Object.fromEntries(Object.entries(SPELL_CONTROLS).map(([k, v]) => [k, v.value])) as SpellConfig
export function spellConfig(input: unknown): SpellConfig {
  const out = spellDefaults()
  if (!input || typeof input !== "object") return out
  for (const key of Object.keys(out) as (keyof SpellConfig)[]) {
    const v = (input as Record<string, unknown>)[key], rule = SPELL_CONTROLS[key]
    if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.max(rule.min, Math.min(rule.max, v))
  }
  out.cleanThreshold = Math.max(out.matchThreshold + 0.05, out.cleanThreshold)
  return out
}
