import type { Rect } from "../geom"
import type { MapDef } from "../maps"
import type { LampState } from "./light"

/**
 * A map plus the parts of it that change during a round: doors, glass and lamps. The derived rectangle sets are what
 * the rules test against; both the server and client prediction use them.
 */
export class Level {
  doorsOpen: boolean[] = []
  glassBroken: boolean[] = []
  lamps: LampState[] = []
  /** Block light and sight: walls and closed doors. */
  occluders: Rect[] = []
  /** Block bullets: occluders plus windows. Glass shatters instead. */
  blockers: Rect[] = []
  /** Block movement: blockers plus intact glass and solid furniture. */
  solids: Rect[] = []

  constructor(readonly map: MapDef) {
    this.reset()
  }

  reset(): void {
    this.doorsOpen = this.map.doors.map((d) => this.map.openDoors.includes(d.id))
    this.glassBroken = this.map.glass.map(() => false)
    this.lamps = this.map.lights.map(() => ({ broken: false, off: false, dimUntil: 0, failAt: 0 }))
    this.rebuild()
  }

  rebuild(): void {
    const m = this.map
    this.occluders = [...m.walls.map((w) => w.rect), ...m.doors.filter((d) => !this.doorsOpen[d.id]).map((d) => d.rect)]
    this.blockers = [...this.occluders, ...m.windows]
    this.solids = [...this.blockers, ...m.glass.filter((g) => !this.glassBroken[g.id]).map((g) => g.rect), ...m.props.filter((p) => p.solid).map((p) => p.rect)]
  }

  /** Applies door and glass state from a snapshot. Returns true when geometry changed. */
  sync(doors: readonly boolean[], glass: readonly boolean[]): boolean {
    let changed = false
    doors.forEach((v, i) => {
      if (this.doorsOpen[i] !== v) {
        this.doorsOpen[i] = v
        changed = true
      }
    })
    glass.forEach((v, i) => {
      if (this.glassBroken[i] !== v) {
        this.glassBroken[i] = v
        changed = true
      }
    })
    if (changed) this.rebuild()
    return changed
  }
}
