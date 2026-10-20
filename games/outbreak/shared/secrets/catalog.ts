/**
 * Outbreak's secrets (AR-85, `docs/outbreak-secrets.md`): what they are, how rare, and the Secrets tuning. Pure data;
 * which secrets a run has is `select.ts`, where they are `places.ts` and `hosts.ts`.
 */

export type SecretTier = "subtle" | "strange" | "hidden" | "event"

export type SecretDef = {
  readonly id: string
  readonly tier: SecretTier
  /** Chance a run has it (subtle ones are in every run); Rarity scale multiplies the strange, hidden and event ones. */
  readonly chance: number
  /** Lab label. */
  readonly label: string
  /** Whether it lives in one house picked for the run (`hosts.ts`). */
  readonly oneHouse?: boolean
}

export const SECRETS = [
  { id: "calendar", tier: "subtle", chance: 1, label: "The circled day" },
  { id: "clock", tier: "subtle", chance: 1, label: "The stopped clocks" },
  { id: "photo", tier: "subtle", chance: 1, label: "The scratched faces" },
  { id: "chalk", tier: "subtle", chance: 1, label: "The chalk drawings" },
  { id: "nod", tier: "subtle", chance: 0.25, label: "A moving company", oneHouse: true },
  { id: "tallMan", tier: "strange", chance: 0.35, label: "The tall man" },
  { id: "audience", tier: "strange", chance: 0.25, label: "The audience", oneHouse: true },
  { id: "litWindow", tier: "strange", chance: 0.3, label: "The lit window", oneHouse: true },
  { id: "footprints", tier: "strange", chance: 0.35, label: "The footprints", oneHouse: true },
  { id: "phone", tier: "strange", chance: 0.3, label: "The phone", oneHouse: true },
  { id: "rockingChair", tier: "strange", chance: 0.3, label: "The rocking chair", oneHouse: true },
  { id: "cellar", tier: "hidden", chance: 0.45, label: "The radio man's cellar", oneHouse: true },
  { id: "procession", tier: "event", chance: 0.03, label: "The procession" },
  { id: "visitor", tier: "event", chance: 0.04, label: "The visitor" },
] as const satisfies readonly SecretDef[]

export type SecretId = (typeof SECRETS)[number]["id"]
export const SECRET_IDS: readonly SecretId[] = SECRETS.map((s) => s.id)
export const secretDef = (id: SecretId): SecretDef => SECRETS.find((s) => s.id === id)!

/** The per-secret toggle's tuning key. */
export const secretToggleKey = (id: SecretId) => `secret_${id}` as const
type Toggles = { [K in SecretId as `secret_${K}`]: number }

export type SecretsTuning = Toggles & {
  /** 0 is Today (no secrets at all), 1 on. */
  secrets: number
  /** Multiplies the strange, hidden and event chances. */
  secretRarity: number
  /** Strange secrets every run has at least (topped up from the nearest misses). */
  secretMinStrange: number
  /** Index into `SECRETS` of a secret every run has (streams and testing), or −1. */
  secretForce: number
}

export const DEFAULT_SECRETS_TUNING: SecretsTuning = {
  secrets: 1,
  secretRarity: 1,
  secretMinStrange: 2,
  secretForce: -1,
  ...(Object.fromEntries(SECRETS.map((s) => [secretToggleKey(s.id), 1])) as Toggles),
}

export function secretsTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): SecretsTuning {
  return (features?.secrets as SecretsTuning | undefined) ?? DEFAULT_SECRETS_TUNING
}

const G = "Secrets"

/** Lab controls for what a run has (Backquote › Secrets); the client adds its look values and stages. */
export const secretsControls = [
  {
    key: "secrets.secrets",
    field: "secrets",
    label: "Secrets",
    group: G,
    options: [
      { label: "Today (none)", value: 0 },
      { label: "On", value: 1 },
    ],
  },
  { key: "secrets.secretRarity", field: "secretRarity", label: "Rarity scale", group: G, min: 0, max: 4, step: 0.05, unit: "×" },
  { key: "secrets.secretMinStrange", field: "secretMinStrange", label: "Fewest strange per run", group: G, min: 0, max: 6, step: 1, unit: "" },
  {
    key: "secrets.secretForce",
    field: "secretForce",
    label: "Force a secret",
    group: G,
    options: [{ label: "None", value: -1 }, ...SECRETS.map((s, i) => ({ label: s.label, value: i }))],
  },
  ...SECRETS.map((s) => ({
    key: `secrets.${secretToggleKey(s.id)}`,
    field: secretToggleKey(s.id),
    label: `${s.label} (${s.tier})`,
    group: G,
    type: "toggle" as const,
    on: 1,
    off: 0,
  })),
]

/** A stable 32-bit hash of a string. */
export function secretHash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return h >>> 0
}

/** A stable 0–1 roll for `key` in the town `seeds`. */
export const secretRoll = (seeds: SecretSeeds, key: string) => secretHash(`${seeds.seed}:${seeds.houseSeed}:secret:${key}`) / 4294967296

export type SecretSeeds = { readonly seed: number; readonly houseSeed: number }
