import type { CoopSim } from "../../shared/coop-sim"

/**
 * Objectives drawn on the map sheet and the corner minimap: a pinned place with its route, a rough area still to be
 * found, crossed-out spots. Features hand them in through `registerMapObjectives` (the map never imports a feature).
 */
export type MapObjectives = {
  /** A known place, pinned. */
  pins: { x: number; y: number; label: string }[]
  /** Routes as polylines in world metres, drawn dashed. */
  routes: { x: number; y: number }[][]
  /** A rough area: something is out there, within `r` of the point. */
  areas: { x: number; y: number; r: number; label: string }[]
  /** Marked spots (a roadblock, a hazard). */
  crosses: { x: number; y: number; label: string }[]
}

export const NO_OBJECTIVES: MapObjectives = { pins: [], routes: [], areas: [], crosses: [] }

type Provider = (sim: CoopSim) => MapObjectives | null
const providers: Provider[] = []

export function registerMapObjectives(provider: Provider): void {
  providers.push(provider)
}

/** Every feature's objectives for this frame, merged. */
export function mapObjectives(sim: CoopSim): MapObjectives {
  let out: MapObjectives | null = null
  for (const p of providers) {
    const o = p(sim)
    if (!o) continue
    if (!out) out = { pins: [...o.pins], routes: [...o.routes], areas: [...o.areas], crosses: [...o.crosses] }
    else {
      out.pins.push(...o.pins)
      out.routes.push(...o.routes)
      out.areas.push(...o.areas)
      out.crosses.push(...o.crosses)
    }
  }
  return out ?? NO_OBJECTIVES
}
