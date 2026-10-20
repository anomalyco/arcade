import type { LabControl } from "@arcade/kit/lab-panel"
import { HOUSE_FORM_LABELS, HOUSE_FORMS, type HouseForm } from "../../shared/houses/style"
import { DEFAULT_HOUSE_VARIETY, houseVarietyKey, setHouseVariety, type HouseVariety } from "../../shared/houses/variety"

/**
 * Lab › World › Variety (AR-79): how varied the streamed homes are. Part of the world settings, like the house seed:
 * a change regenerates an offline world. Co-op rooms always build `DEFAULT_HOUSE_VARIETY` (`NetSession` resets it), so
 * every client streams the same houses as the room.
 */

const WEIGHT_KEYS: Record<HouseForm, string> = {
  bungalow: "hvBungalow",
  colonial: "hvColonial",
  ranch: "hvRanch",
  duplex: "hvDuplex",
  shotgun: "hvShotgun",
  farmhouse: "hvFarmhouse",
  trailer: "hvTrailer",
  apartment: "hvApartment",
  corner_store: "hvCornerStore",
}

export type HouseVarietySettings = {
  /** 0 Today (three plans, one look), 1 Varied (styled homes). */
  houseVariety: number
  hvBungalow: number
  hvColonial: number
  hvRanch: number
  hvDuplex: number
  hvShotgun: number
  hvFarmhouse: number
  hvTrailer: number
  hvApartment: number
  hvCornerStore: number
  /** Share of homes found derelict, burnt out or half built. */
  hvDerelict: number
  hvBurnt: number
  hvConstruction: number
  /** Share of a kept home's windows boarded over. */
  hvBoarded: number
  /** Yard dressing: 0 bare, 1 default, 2 crowded. */
  hvYard: number
}

export const DEFAULT_HOUSE_VARIETY_SETTINGS: HouseVarietySettings = {
  houseVariety: 1,
  hvBungalow: DEFAULT_HOUSE_VARIETY.weights.bungalow,
  hvColonial: DEFAULT_HOUSE_VARIETY.weights.colonial,
  hvRanch: DEFAULT_HOUSE_VARIETY.weights.ranch,
  hvDuplex: DEFAULT_HOUSE_VARIETY.weights.duplex,
  hvShotgun: DEFAULT_HOUSE_VARIETY.weights.shotgun,
  hvFarmhouse: DEFAULT_HOUSE_VARIETY.weights.farmhouse,
  hvTrailer: DEFAULT_HOUSE_VARIETY.weights.trailer,
  hvApartment: DEFAULT_HOUSE_VARIETY.weights.apartment,
  hvCornerStore: DEFAULT_HOUSE_VARIETY.weights.corner_store,
  hvDerelict: DEFAULT_HOUSE_VARIETY.derelict,
  hvBurnt: DEFAULT_HOUSE_VARIETY.burnt,
  hvConstruction: DEFAULT_HOUSE_VARIETY.construction,
  hvBoarded: DEFAULT_HOUSE_VARIETY.boarded,
  hvYard: DEFAULT_HOUSE_VARIETY.yard,
}

export const HOUSE_VARIETY_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_HOUSE_VARIETY_SETTINGS))

/** The generation config these settings ask for. */
export function houseVarietyFrom(s: Readonly<HouseVarietySettings>): HouseVariety {
  const weights = {} as Record<HouseForm, number>
  for (const f of HOUSE_FORMS) weights[f] = s[WEIGHT_KEYS[f] as keyof HouseVarietySettings]
  return { enabled: s.houseVariety >= 0.5, weights, derelict: s.hvDerelict, burnt: s.hvBurnt, construction: s.hvConstruction, boarded: s.hvBoarded, yard: s.hvYard }
}

/** Applies the settings to generation; true when the houses change (the caller regenerates). */
export function syncHouseVariety(s: Readonly<HouseVarietySettings>): boolean {
  const before = houseVarietyKey()
  setHouseVariety(houseVarietyFrom(s))
  return houseVarietyKey() !== before
}

const GROUP = "World · Variety"
const varied = (s: Readonly<Record<string, unknown>>) => Number(s.houseVariety ?? 1) >= 0.5

export const houseVarietyControls: readonly LabControl[] = [
  { key: "houseVariety", label: "Houses", group: GROUP, type: "select", options: [{ value: 0, label: "Today (three plans)" }, { value: 1, label: "Varied (styled homes)" }] },
  ...HOUSE_FORMS.map((f): LabControl => ({ key: WEIGHT_KEYS[f], label: HOUSE_FORM_LABELS[f], group: GROUP, subsection: "Archetype weights", min: 0, max: 4, step: 0.05, unit: "", enabled: varied })),
  { key: "hvDerelict", label: "Derelict share", group: GROUP, subsection: "Condition", min: 0, max: 0.8, step: 0.01, unit: "", enabled: varied },
  { key: "hvBurnt", label: "Burnt-out share", group: GROUP, subsection: "Condition", min: 0, max: 0.5, step: 0.01, unit: "", enabled: varied },
  { key: "hvConstruction", label: "Under construction share", group: GROUP, subsection: "Condition", min: 0, max: 0.5, step: 0.01, unit: "", enabled: varied },
  { key: "hvBoarded", label: "Boarded windows (kept homes)", group: GROUP, subsection: "Condition", min: 0, max: 1, step: 0.02, unit: "", enabled: varied },
  { key: "hvYard", label: "Yard dressing", group: GROUP, subsection: "Condition", min: 0, max: 2, step: 0.1, unit: "×", enabled: varied },
]
