import { HOUSE_FORMS, type HouseForm } from "./style"

/**
 * How varied the streamed homes are (AR-79). `enabled: false` is Today: every home the same three plans. The weights
 * pick a form among those that fit a lot; the shares are the chance a home is found derelict, burnt out or half built.
 *
 * Generation reads the active config (`houseVariety`), and every chunk cache keys on `houseVarietyKey()`. It is part of
 * the world like the seed: offline the Lab's World › Variety sets it before a new session, co-op rooms always use
 * `DEFAULT_HOUSE_VARIETY` (the room and every client generate the same chunks).
 */
export type HouseVariety = {
  enabled: boolean
  weights: Record<HouseForm, number>
  derelict: number
  burnt: number
  construction: number
  /** Share of a kept home's windows boarded over from the start (derelict homes and hideouts board more). */
  boarded: number
  /** Yard dressing: 0 bare lots, 1 default, 2 crowded. */
  yard: number
}

export const DEFAULT_HOUSE_WEIGHTS: Readonly<Record<HouseForm, number>> = {
  bungalow: 1.6,
  colonial: 1.1,
  ranch: 1.1,
  duplex: 0.55,
  shotgun: 0.5,
  farmhouse: 0.6,
  trailer: 0.4,
  apartment: 0.35,
  corner_store: 0.3,
}

export const DEFAULT_HOUSE_VARIETY: Readonly<HouseVariety> = Object.freeze({
  enabled: true,
  weights: Object.freeze({ ...DEFAULT_HOUSE_WEIGHTS }) as Record<HouseForm, number>,
  derelict: 0.16,
  burnt: 0.06,
  construction: 0.05,
  boarded: 0.12,
  yard: 1,
})

/** The config chunk generation reads. Mutate only through `setHouseVariety`. */
export const houseVariety: HouseVariety = { ...DEFAULT_HOUSE_VARIETY, weights: { ...DEFAULT_HOUSE_WEIGHTS } }

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)

export function setHouseVariety(v: Partial<HouseVariety>): void {
  if (v.enabled !== undefined) houseVariety.enabled = v.enabled
  if (v.weights) for (const f of HOUSE_FORMS) if (v.weights[f] !== undefined) houseVariety.weights[f] = Math.max(0, Number(v.weights[f]) || 0)
  if (v.derelict !== undefined) houseVariety.derelict = clamp01(v.derelict)
  if (v.burnt !== undefined) houseVariety.burnt = clamp01(v.burnt)
  if (v.construction !== undefined) houseVariety.construction = clamp01(v.construction)
  if (v.boarded !== undefined) houseVariety.boarded = clamp01(v.boarded)
  if (v.yard !== undefined) houseVariety.yard = Math.max(0, Math.min(2, Number(v.yard) || 0))
}

export function resetHouseVariety(): void {
  setHouseVariety({ ...DEFAULT_HOUSE_VARIETY, weights: { ...DEFAULT_HOUSE_WEIGHTS } })
}

/** Cache-key fragment: two configs that generate different chunks never share a key. */
export function houseVarietyKey(v: HouseVariety = houseVariety): string {
  if (!v.enabled) return "today"
  return `v1:${HOUSE_FORMS.map((f) => v.weights[f].toFixed(2)).join(",")}:${v.derelict.toFixed(2)}:${v.burnt.toFixed(2)}:${v.construction.toFixed(2)}:${v.boarded.toFixed(2)}:${v.yard.toFixed(2)}`
}
