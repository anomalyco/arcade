export type SurvivorVariant = 0 | 1 | 2 | 3

export const SURVIVOR_VARIANT_COUNT = 4

export function isSurvivorVariant(v: unknown): v is SurvivorVariant {
  return v === 0 || v === 1 || v === 2 || v === 3
}

export function clampSurvivorVariant(v: unknown, fallback: SurvivorVariant = 0): SurvivorVariant {
  const n = typeof v === "number" && Number.isInteger(v) ? v : fallback
  return (((n % SURVIVOR_VARIANT_COUNT) + SURVIVOR_VARIANT_COUNT) % SURVIVOR_VARIANT_COUNT) as SurvivorVariant
}

export type LoadoutId = "standard" | "medic" | "breacher" | "scavenger"

export const DEFAULT_LOADOUT: LoadoutId = "standard"

export type LoadoutItemGrant = {
  readonly item: "bandage" | "pipe" | "bottle" | "rag"
  readonly count: number
  readonly charge?: number
}

export type LoadoutSpec = {
  readonly id: LoadoutId
  readonly label: string
  readonly role: string
  readonly summary: string
  readonly items: readonly LoadoutItemGrant[]
}

/**
 * Starting loadout kits built strictly from existing Outbreak progression items (`shared/progression/catalog.ts`).
 * `standard` is the exact baseline kit every survivor starts with by default.
 */
export const LOADOUTS: readonly LoadoutSpec[] = [
  {
    id: "standard",
    label: "Standard Kit",
    role: "9mm & Planks",
    summary: "Flashlight · 9mm pistol · +6 reserve rounds · 2 planks",
    items: [],
  },
  {
    id: "medic",
    label: "Field Medic",
    role: "+1 Bandage",
    summary: "Standard kit + Bandage in hand slot 3",
    items: [{ item: "bandage", count: 1 }],
  },
  {
    id: "breacher",
    label: "Breacher",
    role: "+Lead Pipe",
    summary: "Standard kit + Lead Pipe (16 durability) in hand slot 3",
    items: [{ item: "pipe", count: 1, charge: 16 }],
  },
  {
    id: "scavenger",
    label: "Night Runner",
    role: "+Bottle & Rag",
    summary: "Standard kit + Glass Bottle in hand slot 3 & Rag on belt",
    items: [
      { item: "bottle", count: 1 },
      { item: "rag", count: 1 },
    ],
  },
] as const

const LOADOUT_BY_ID = new Map<string, LoadoutSpec>(LOADOUTS.map((l) => [l.id, l]))

export function isLoadoutId(v: unknown): v is LoadoutId {
  return typeof v === "string" && LOADOUT_BY_ID.has(v)
}

export function loadoutSpec(id: unknown): LoadoutSpec {
  return (typeof id === "string" ? LOADOUT_BY_ID.get(id) : undefined) ?? LOADOUTS[0]!
}
