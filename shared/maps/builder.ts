import type { Rect, Vec } from "../geom"
import type { LightDef } from "../sim/light"
import type { Breaker, Door, Floor, FloorKind, Glass, MapDef, Noisy, Prop, PropKind, Wall, WallStyle } from "./types"

export const WALL_H = 2.7
export const PARTITION_H = 1.3
const T = 0.3

type Gap = readonly [number, number]

/** Small helper for authoring maps as code: walls with door gaps, cubicle clusters, lights with ids. */
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

  floor(kind: FloorKind, x0: number, y0: number, x1: number, y1: number): void {
    this.floors.push({ kind, rect: [x0, y0, x1, y1] })
  }

  wall(x0: number, y0: number, x1: number, y1: number, h = WALL_H, style: WallStyle = "wall"): void {
    this.walls.push({ rect: [x0, y0, x1, y1], h, style })
  }

  /** A wall centred on y from x0 to x1. Gaps become doors (or openings when `open` is set). */
  hwall(y: number, x0: number, x1: number, gaps: Gap[] = [], opts: { open?: boolean; openDoor?: boolean } = {}): number[] {
    const ids: number[] = []
    let x = x0
    for (const [a, b] of gaps) {
      if (a > x) this.wall(x, y - T / 2, a, y + T / 2)
      if (!opts.open) ids.push(this.door([a, y - T / 2, b, y + T / 2], !!opts.openDoor))
      x = b
    }
    if (x1 > x) this.wall(x, y - T / 2, x1, y + T / 2)
    return ids
  }

  vwall(x: number, y0: number, y1: number, gaps: Gap[] = [], opts: { open?: boolean; openDoor?: boolean } = {}): number[] {
    const ids: number[] = []
    let y = y0
    for (const [a, b] of gaps) {
      if (a > y) this.wall(x - T / 2, y, x + T / 2, a)
      if (!opts.open) ids.push(this.door([x - T / 2, a, x + T / 2, b], !!opts.openDoor))
      y = b
    }
    if (y1 > y) this.wall(x - T / 2, y, x + T / 2, y1)
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
    this.props.push({ kind, rect: [x0, y0, x1, y1], rot, solid, light })
  }

  light(def: Omit<LightDef, "id">): number {
    const id = this.lights.length
    this.lights.push({ ...def, id })
    return id
  }

  /** A desk lamp standing on a desk. */
  deskLamp(x: number, y: number, rot: Prop["rot"] = 0): number {
    const id = this.light({ kind: "desk", x, y, h: 1.05, r: 5, power: 1.25, color: [1, 0.74, 0.44], shootable: true, flicker: 0 })
    this.prop("lamp", x - 0.15, y - 0.15, x + 0.15, y + 0.15, rot, false, id)
    return id
  }

  /**
   * Four desks back to back inside a box of low partitions. Each pocket opens to the aisle on its north or south side.
   * `lamps` names the pockets (ne, nw, se, sw) that get a desk lamp.
   */
  cluster(cx: number, cy: number, lamps: ("ne" | "nw" | "se" | "sw")[] = []): void {
    const P = PARTITION_H
    this.wall(cx - 1.74, cy - 0.04, cx + 1.74, cy + 0.04, P, "partition")
    this.wall(cx - 0.04, cy - 1.2, cx + 0.04, cy - 0.04, P, "partition")
    this.wall(cx - 0.04, cy + 0.04, cx + 0.04, cy + 1.2, P, "partition")
    this.wall(cx - 1.74, cy - 1.2, cx - 1.66, cy - 0.04, P, "partition")
    this.wall(cx - 1.74, cy + 0.04, cx - 1.66, cy + 1.2, P, "partition")
    this.wall(cx + 1.66, cy - 1.2, cx + 1.74, cy - 0.04, P, "partition")
    this.wall(cx + 1.66, cy + 0.04, cx + 1.74, cy + 1.2, P, "partition")
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const x0 = sx < 0 ? cx - 1.62 : cx + 0.08
      const x1 = sx < 0 ? cx - 0.08 : cx + 1.62
      const y0 = sy < 0 ? cy - 0.84 : cy + 0.06
      const y1 = sy < 0 ? cy - 0.06 : cy + 0.84
      this.prop("desk", x0, y0, x1, y1, sy < 0 ? 2 : 0)
      const chairY = sy < 0 ? cy - 1.25 : cy + 1.25
      this.prop("chair", cx + sx * 0.85 - 0.25, chairY - 0.25, cx + sx * 0.85 + 0.25, chairY + 0.25, sy < 0 ? 0 : 2, false)
      const name = `${sy < 0 ? "n" : "s"}${sx < 0 ? "w" : "e"}` as "ne"
      if (lamps.includes(name)) this.deskLamp(cx + sx * 1.32, cy + sy * 0.32, sy < 0 ? 2 : 0)
    }
  }

  build(base: Pick<MapDef, "id" | "name" | "blurb" | "size" | "ambient">): MapDef {
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
    }
  }
}
