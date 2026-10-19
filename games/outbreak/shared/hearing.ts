import { attenuateNoise, type AIConfig as KitAIConfig, type AttenuatedNoise, type NoiseEvent } from "@arcade/kit/sim/ai"
import type { Rect } from "@arcade/kit/sim/geom"
import { inBuildingFootprint, type Town } from "./map"

/**
 * How the dead hear through buildings (AR-67). A noise that has to leave (or enter) a building loses some of its
 * reach at the building's shell: shut, the walls, glass and closed doors keep most of it in; through an open door,
 * open window or broken pane it carries on almost as in the open air, measured along the way out through that
 * opening. The loss is part multiplied, part subtracted, so quiet noises (walking, crouching, a door, a reload) stay
 * inside a shut house while loud ones (gunfire, a radio, an alarm) still reach the street, about half as far.
 *
 * Inside one building, or out in the open, the kit's straight-line wall and door muffling applies as before.
 * `hearingModel: 0` is Today: straight-line muffling everywhere (closed windows let everything through).
 */
export type HearingTuning = {
  /** 1: building shells. 0: Today (straight-line wall and door muffling only). */
  hearingModel: number
  /** Share of a noise's reach left after a shut building's shell. */
  hearingShutCarry: number
  /** Metres of reach a shut shell takes off besides (so quiet noises stay in). */
  hearingShutLoss: number
  /** Share of a noise's reach left going out through an open door or window. */
  hearingOpenCarry: number
  /** Metres an open door or window takes off besides. */
  hearingOpenLoss: number
}

export const DEFAULT_HEARING_TUNING: HearingTuning = {
  hearingModel: 1,
  hearingShutCarry: 0.6,
  hearingShutLoss: 3,
  hearingOpenCarry: 0.9,
  hearingOpenLoss: 0.25,
}

/** Lab controls (Backquote › Hearing); the values live in the AI settings and apply on the next tick. */
export const hearingControls = [
  {
    key: "hearingModel",
    label: "Hearing through buildings",
    group: "Hearing",
    options: [
      { label: "Today (walls only)", value: 0 },
      { label: "Shut houses muffle", value: 1 },
    ],
  },
  { key: "hearingShutCarry", label: "Shut house: reach kept", group: "Hearing", min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "hearingShutLoss", label: "Shut house: reach lost", group: "Hearing", min: 0, max: 12, step: 0.5, unit: "m" },
  { key: "hearingOpenCarry", label: "Open door/window: reach kept", group: "Hearing", min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "hearingOpenLoss", label: "Open door/window: reach lost", group: "Hearing", min: 0, max: 6, step: 0.25, unit: "m" },
] as const

/** Reach (m) a noise of `radius` keeps after one building shell, shut or through an opening. */
export function shellRadius(radius: number, open: boolean, t: HearingTuning): number {
  const carry = open ? t.hearingOpenCarry : t.hearingShutCarry
  const loss = open ? t.hearingOpenLoss : t.hearingShutLoss
  return Math.max(0, radius * carry - loss)
}

/** An open way through a building's shell: an open, unboarded door or window (or a broken pane), at its centre. */
export type ShellOpening = { id: string; x: number; y: number }

/** One building's open ways out; a building missing from the map, or with none, is shut. */
export type BuildingShell = { openings: ShellOpening[] }

type Portal = { id: string; rect: Rect; open: boolean }

/**
 * The open ways out of every building: each open, unboarded door or window with the building's floor on one side
 * of it and not the other (so doors between rooms never count). `planksOf` gives a portal's barricade planks.
 */
export function buildingShells(town: Town, planksOf: (id: string) => number): BuildingShell[] {
  const shells: BuildingShell[] = town.buildings.map(() => ({ openings: [] }))
  const add = (p: Portal) => {
    if (!p.open || planksOf(p.id) > 0) return
    const [x0, y0, x1, y1] = p.rect
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const horizontal = x1 - x0 > y1 - y0
    const ax = horizontal ? cx : cx - 0.4
    const ay = horizontal ? cy - 0.4 : cy
    const bx = horizontal ? cx : cx + 0.4
    const by = horizontal ? cy + 0.4 : cy
    for (let i = 0; i < town.buildings.length; i++) {
      const b = town.buildings[i]!
      if (cx < b.rect[0] - 0.6 || cx > b.rect[2] + 0.6 || cy < b.rect[1] - 0.6 || cy > b.rect[3] + 0.6) continue
      if (inBuildingFootprint(b, ax, ay) !== inBuildingFootprint(b, bx, by)) shells[i]!.openings.push({ id: p.id, x: cx, y: cy })
    }
  }
  for (const d of town.doors) add(d)
  for (const w of town.windows) add(w)
  return shells
}

/** Index of the building whose floor (x, y) is on, or -1 outdoors. */
export function buildingIndexAt(town: Town, x: number, y: number): number {
  for (let i = 0; i < town.buildings.length; i++) if (inBuildingFootprint(town.buildings[i]!, x, y)) return i
  return -1
}

type HearConfig = Pick<KitAIConfig, "hearingScale" | "wallAttenuation" | "doorAttenuation">

const NO_WAY: readonly (ShellOpening | null)[] = [null]

/**
 * How a listener at (lx, ly) in building `lb` (-1 outdoors) hears a noise at (sx, sy) in building `sb`, when the
 * two are not in the same place. Every way is tried: straight through each shut shell, or out through any of the
 * source building's openings and in through any of the listener's; the one heard loudest wins.
 */
export function hearAcrossShells(
  sx: number,
  sy: number,
  radius: number,
  loudness: number,
  lx: number,
  ly: number,
  sourceShell: BuildingShell | null,
  listenerShell: BuildingShell | null,
  config: HearConfig,
  perceptionScale: number,
  t: HearingTuning,
): AttenuatedNoise {
  const exits: readonly (ShellOpening | null)[] = sourceShell ? [null, ...sourceShell.openings] : NO_WAY
  const entries: readonly (ShellOpening | null)[] = listenerShell ? [null, ...listenerShell.openings] : NO_WAY
  const straight = Math.hypot(lx - sx, ly - sy)
  const shells = (sourceShell ? 1 : 0) + (listenerShell ? 1 : 0)
  let best: AttenuatedNoise = {
    audible: false,
    distance: straight,
    effectiveRadius: 0,
    perceivedLoudness: 0,
    wallHits: shells,
    doorHits: 0,
  }
  for (const out of exits) {
    const afterExit = sourceShell ? shellRadius(radius, out !== null, t) : radius
    for (const into of entries) {
      const reach = listenerShell ? shellRadius(afterExit, into !== null, t) : afterExit
      const effectiveRadius = reach * config.hearingScale * perceptionScale
      if (effectiveRadius <= 1e-4) continue
      let distance = straight
      if (out || into) {
        let px = sx
        let py = sy
        distance = 0
        for (const via of [out, into]) {
          if (!via) continue
          distance += Math.hypot(via.x - px, via.y - py)
          px = via.x
          py = via.y
        }
        distance += Math.hypot(lx - px, ly - py)
      }
      if (distance > effectiveRadius) continue
      const attenuation = radius > 1e-4 ? reach / radius : 0
      const perceivedLoudness = loudness * (1 - distance / effectiveRadius) * attenuation
      if (!best.audible || perceivedLoudness > best.perceivedLoudness) {
        best = { audible: true, distance, effectiveRadius, perceivedLoudness, wallHits: shells, doorHits: 0 }
      }
    }
  }
  return best
}

/**
 * The crowd's hearing for one town: building shells rebuilt when doors, windows or barricades change, and small
 * caches so the per-listener, per-noise lookups stay cheap. `hear` is the kit crowd's `hearNoise` hook.
 */
export class HearingMap {
  private town: Town | null = null
  private shells: BuildingShell[] = []
  private walls: readonly Rect[] = []
  private closedDoors: readonly Rect[] = []
  /** Building per noise id, with where it was looked up: coalesced footsteps keep their id as they move. */
  private readonly sourceBuilding = new Map<number, { x: number; y: number; b: number }>()
  private lastLx = Number.NaN
  private lastLy = Number.NaN
  private lastLb = -1
  tuning: HearingTuning = { ...DEFAULT_HEARING_TUNING }

  rebuild(town: Town, walls: readonly Rect[], closedDoors: readonly Rect[], planksOf: (id: string) => number): void {
    this.town = town
    this.walls = walls
    this.closedDoors = closedDoors
    this.shells = buildingShells(town, planksOf)
    this.sourceBuilding.clear()
    this.lastLx = Number.NaN
  }

  /** Open ways out of building `index` (empty when shut). */
  shell(index: number): BuildingShell | null {
    return index >= 0 ? (this.shells[index] ?? { openings: [] }) : null
  }

  buildingAt(x: number, y: number): number {
    return this.town ? buildingIndexAt(this.town, x, y) : -1
  }

  readonly hear = (ev: NoiseEvent, lx: number, ly: number, perceptionScale: number, config: HearConfig): AttenuatedNoise => {
    const t = this.tuning
    if (!this.town || !(t.hearingModel >= 1)) {
      return attenuateNoise(ev.x, ev.y, ev.radius, ev.loudness, lx, ly, this.walls, this.closedDoors, config, perceptionScale)
    }
    // Most of the dead are nowhere near: skip the building lookups for noise that could not reach them anyway.
    const reachable = ev.radius * config.hearingScale * perceptionScale
    const dx = lx - ev.x
    const dy = ly - ev.y
    if (dx * dx + dy * dy > reachable * reachable) {
      return { audible: false, distance: Math.hypot(dx, dy), effectiveRadius: reachable, perceivedLoudness: 0, wallHits: 0, doorHits: 0 }
    }
    let cached = this.sourceBuilding.get(ev.id)
    if (!cached || cached.x !== ev.x || cached.y !== ev.y) {
      if (this.sourceBuilding.size > 512) this.sourceBuilding.clear()
      cached = { x: ev.x, y: ev.y, b: this.buildingAt(ev.x, ev.y) }
      this.sourceBuilding.set(ev.id, cached)
    }
    const sb = cached.b
    if (lx !== this.lastLx || ly !== this.lastLy) {
      this.lastLx = lx
      this.lastLy = ly
      this.lastLb = this.buildingAt(lx, ly)
    }
    const lb = this.lastLb
    if (sb === lb) {
      return attenuateNoise(ev.x, ev.y, ev.radius, ev.loudness, lx, ly, this.walls, this.closedDoors, config, perceptionScale)
    }
    return hearAcrossShells(ev.x, ev.y, ev.radius, ev.loudness, lx, ly, this.shell(sb), this.shell(lb), config, perceptionScale, t)
  }
}
