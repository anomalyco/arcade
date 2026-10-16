import type { LabStation, StationCommand, StationVariant } from "./types"

/** The group of a station whose variants name none. */
export const VARIANTS_GROUP = "Variants"

/** One axis of a station's variants (Look, Hero, Beam): a single choice that composes with the other groups' choices. */
export type VariantGroup<V extends Grouped = StationVariant> = { id: string; variants: readonly V[] }
type Grouped = { id: string; group?: string }

export const groupOf = (v: Grouped) => v.group ?? VARIANTS_GROUP

/** The station's (or a lab's) variants by group, groups in the order they first appear. */
export function variantGroups<V extends Grouped>(variants: readonly V[] = []): VariantGroup<V>[] {
  const groups = new Map<string, V[]>()
  for (const v of variants) {
    const id = groupOf(v)
    const list = groups.get(id)
    if (list) list.push(v)
    else groups.set(id, [v])
  }
  return [...groups].map(([id, list]) => ({ id, variants: list }))
}

/** Variants in group order: what number keys pick (1–9, then 0). */
export function orderedVariants(variants: readonly StationVariant[] = []): StationVariant[] {
  return variantGroups(variants).flatMap(g => g.variants)
}

/** `defaultVariant` (a station's) or `variant` (a lab's) as a list. */
export const variantIdList = (ids: string | readonly string[] | undefined): readonly string[] =>
  ids === undefined ? [] : typeof ids === "string" ? [ids] : ids
export const defaultVariantIds = (station: Pick<LabStation, "defaultVariant">) => variantIdList(station.defaultVariant)

/**
 * What each group shows when the station opens. With one group, its `defaultVariant` or nothing (the demo's own setup).
 * With several, every group has a pick so they compose: its `defaultVariant`, else its first variant.
 */
export function defaultPicks(station: Pick<LabStation, "variants" | "defaultVariant" | "pickOne">): Map<string, StationVariant> {
  const groups = variantGroups(station.variants)
  const defaults = new Set(defaultVariantIds(station))
  const picks = new Map<string, StationVariant>()
  for (const g of groups) {
    const v = g.variants.find(x => defaults.has(x.id)) ?? (composes(station) ? g.variants[0] : undefined)
    if (v) picks.set(g.id, v)
  }
  return picks
}

/** Whether the station's picks stack: several groups, not `pickOne`. */
export const composes = (station: Pick<LabStation, "variants" | "pickOne">) => !station.pickOne && variantGroups(station.variants).length > 1

/** The picks after choosing `v`: its group's pick replaced, or with `pickOne` (or one group) only `v`. */
export function pickAfter(station: Pick<LabStation, "variants" | "pickOne">, picks: ReadonlyMap<string, StationVariant>, v: StationVariant) {
  return composes(station) ? new Map(picks).set(groupOf(v), v) : new Map([[groupOf(v), v]])
}

/**
 * What choosing `v` runs. With one group (or `pickOne`), its own setup, as a one-shot apply. With several, every group's
 * pick in group order with `v` in its group, so a later group refines an earlier one (a Hero over a Look) and changing
 * one group keeps the others.
 */
export function composedSetup(station: Pick<LabStation, "variants" | "pickOne">, picks: ReadonlyMap<string, StationVariant>, v: StationVariant): StationCommand[] {
  if (!composes(station)) return [...(v.setup ?? [])]
  return variantGroups(station.variants).flatMap(g => (g.id === groupOf(v) ? v : picks.get(g.id))?.setup ?? [])
}

/** Problems with a station's groups and defaults, for `validateStations`. */
export function variantProblems(station: Pick<LabStation, "variants" | "defaultVariant" | "pickOne">): string[] {
  const problems: string[] = []
  const variants = station.variants ?? []
  const grouped = variants.filter(v => v.group !== undefined).length
  if (grouped && grouped < variants.length) problems.push("give every variant a group, or none")
  for (const v of variants) if (v.group !== undefined && !v.group.trim()) problems.push(`variant "${v.id}" has an empty group`)
  const ids = new Set(variants.map(v => v.id))
  const seen = new Set<string>()
  for (const id of defaultVariantIds(station)) {
    const v = variants.find(x => x.id === id)
    if (!ids.has(id) || !v) { problems.push(`defaultVariant "${id}" is not one of its variants`); continue }
    if (seen.has(groupOf(v))) problems.push(`defaultVariant names two variants in group "${groupOf(v)}"`)
    seen.add(groupOf(v))
  }
  if (station.pickOne && defaultVariantIds(station).length > 1) problems.push("a pickOne station opens on one variant")
  return problems
}
