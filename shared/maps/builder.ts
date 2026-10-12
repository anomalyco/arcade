import type { Rect, Vec } from "../geom"
import type { LightDef } from "../sim/light"
import type { Breaker, Door, Floor, FloorKind, Glass, MapDef, Noisy, Prop, PropKind, Wall, WallStyle } from "./types"

export const WALL_H = 2.7
export const PARTITION_H = 1.3
export const T = 0.3
/** Static lights per map. The GPU holds MAX_LIGHTS, which leaves room for live flares. */
export const LIGHT_BUDGET = 24

/** A gap in a wall: a door unless marked "open". */
export type Gap = readonly [number, number] | readonly [number, number, "open"]

/** Collects map geometry. Used by the procedural generator and by test maps. */
export class Builder {
  floors: Floor[] = []
  walls: Wall[] = []
  windows: Rect[] = []
  glass: Glass[] = []
  doors: Door[] = []
  openDoors: number[] = []
  props: Prop[] = []
  lights: LightDef[] = []
  breakers: Breaker[] = []
  noisy: Noisy[] = []
  spawns: Vec[] = []
  tape: Rect[] = []
  cores: Rect[] = []

  floor(kind: FloorKind, x0: number, y0: number, x1: number, y1: number): void {
    this.floors.push({ kind, rect: [x0, y0, x1, y1] })
  }

  wall(x0: number, y0: number, x1: number, y1: number, h = WALL_H, style: WallStyle = "wall"): void {
    if (x1 - x0 > 0.01 && y1 - y0 > 0.01) this.walls.push({ rect: [x0, y0, x1, y1], h, style })
  }

  /** A wall centred on y from x0 to x1 with doors (or openings) in the gaps. Returns the new door ids. */
  hwall(y: number, x0: number, x1: number, gaps: Gap[] = [], openDoor = false): number[] {
    const ids: number[] = []
    let x = x0
    for (const g of [...gaps].sort((a, b) => a[0] - b[0])) {
      this.wall(x, y - T / 2, g[0], y + T / 2)
      if (g[2] !== "open") ids.push(this.door([g[0], y - T / 2, g[1], y + T / 2], openDoor))
      x = g[1]
    }
    this.wall(x, y - T / 2, x1, y + T / 2)
    return ids
  }

  vwall(x: number, y0: number, y1: number, gaps: Gap[] = [], openDoor = false): number[] {
    const ids: number[] = []
    let y = y0
    for (const g of [...gaps].sort((a, b) => a[0] - b[0])) {
      this.wall(x - T / 2, y, x + T / 2, g[0])
      if (g[2] !== "open") ids.push(this.door([x - T / 2, g[0], x + T / 2, g[1]], openDoor))
      y = g[1]
    }
    this.wall(x - T / 2, y, x + T / 2, y1)
    return ids
  }

  door(rect: Rect, open = false): number {
    const id = this.doors.length
    this.doors.push({ id, rect })
    if (open) this.openDoors.push(id)
    return id
  }

  pane(x0: number, y0: number, x1: number, y1: number): void {
    this.glass.push({ id: this.glass.length, rect: [x0, y0, x1, y1] })
  }

  prop(kind: PropKind, x0: number, y0: number, x1: number, y1: number, rot: Prop["rot"] = 0, solid = true, light?: number): void {
    this.props.push({ kind, rect: [x0, y0, x1, y1], rot, solid, light: light !== undefined && light >= 0 ? light : undefined })
  }

  /** Adds a light and returns its id, or -1 when the map's light budget is spent. */
  light(def: Omit<LightDef, "id">): number {
    if (this.lights.length >= LIGHT_BUDGET) return -1
    const id = this.lights.length
    this.lights.push({ ...def, id })
    return id
  }

  get lightsLeft(): number {
    return LIGHT_BUDGET - this.lights.length
  }

  /** A desk lamp standing on a desk. Skipped when the light budget is spent. */
  deskLamp(x: number, y: number, rot: Prop["rot"] = 0): number {
    const id = this.light({ kind: "desk", x, y, h: 1.05, r: 5, power: 1.25, color: [1, 0.72, 0.42], shootable: true })
    if (id >= 0) this.prop("lamp", x - 0.15, y - 0.15, x + 0.15, y + 0.15, rot, false, id)
    return id
  }

  /**
   * Four desks back to back inside low partitions, 3.48 m by 2.4 m around (cx, cy). Pockets open north and south.
   * `lamps` names the pockets that get a desk lamp.
   */
  cluster(cx: number, cy: number, lamps: ("ne" | "nw" | "se" | "sw")[] = []): void {
    const P = PARTITION_H
    this.wall(cx - 1.74, cy - 0.04, cx + 1.74, cy + 0.04, P, "partition")
    this.wall(cx - 0.04, cy - 1.2, cx + 0.04, cy - 0.04, P, "partition")
    this.wall(cx - 0.04, cy + 0.04, cx + 0.04, cy + 1.2, P, "partition")
    for (const sx of [-1, 1]) {
      const ex = cx + sx * 1.7
      this.wall(ex - 0.04, cy - 1.2, ex + 0.04, cy - 0.04, P, "partition")
      this.wall(ex - 0.04, cy + 0.04, ex + 0.04, cy + 1.2, P, "partition")
    }
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const x0 = sx < 0 ? cx - 1.62 : cx + 0.08
      const x1 = sx < 0 ? cx - 0.08 : cx + 1.62
      const y0 = sy < 0 ? cy - 0.75 : cy + 0.06
      const y1 = sy < 0 ? cy - 0.06 : cy + 0.75
      this.prop("desk", x0, y0, x1, y1, sy < 0 ? 2 : 0)
      const chairY = cy + sy * 1.15
      this.prop("chair", cx + sx * 0.85 - 0.25, chairY - 0.25, cx + sx * 0.85 + 0.25, chairY + 0.25, sy < 0 ? 0 : 2, false)
      const name = `${sy < 0 ? "n" : "s"}${sx < 0 ? "w" : "e"}` as const
      if (lamps.includes(name)) this.deskLamp(cx + sx * 1.32, cy + sy * 0.3, sy < 0 ? 2 : 0)
    }
  }

  build(base: Pick<MapDef, "id" | "seed" | "name" | "blurb" | "size" | "ambient">): MapDef {
    return {
      ...base,
      floors: this.floors,
      walls: this.walls,
      windows: this.windows,
      glass: this.glass,
      doors: this.doors,
      openDoors: this.openDoors,
      props: this.props,
      lights: this.lights,
      breakers: this.breakers,
      noisy: this.noisy,
      spawns: this.spawns,
      tape: this.tape,
      cores: this.cores,
    }
  }
}
