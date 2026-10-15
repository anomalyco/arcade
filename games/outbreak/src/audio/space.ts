import { blocked } from "@arcade/kit/audio"
import type { SfxSurface } from "@arcade/kit/audio"
import type { Rect } from "@arcade/kit/sim/geom"
import { inBuildingFootprint, sightRects, type Town } from "../../shared/map"

/**
 * What a footstep lands on. Mirrors the ground shader's layout (`ground.ts`): roads are the 40–48 m bands on both axes,
 * sidewalks the 2 m strips beside them and the front walkways, house floors are wood and shop floors concrete.
 */
export function surfaceAt(town: Town, x: number, y: number): SfxSurface {
  const building = town.buildings.find((b) => inBuildingFootprint(b, x, y))
  if (building) return building.kind === "house" ? "wood" : "concrete"
  const band = (v: number) => v >= 37.9 && v <= 50.1
  if (band(x) || band(y)) return "concrete"
  for (const b of town.buildings) {
    // Front walkway from the door to the sidewalk.
    const [x0, , , y1] = b.rect
    if (x > x0 + 4.4 && x < x0 + 7.0 && y > y1 && y < 38) return "concrete"
  }
  return "grass"
}

export function indoors(town: Town, x: number, y: number): boolean {
  return town.buildings.some((b) => inBuildingFootprint(b, x, y))
}

const box = (r: Rect) => ({ x0: r[0], z0: r[1], x1: r[2], z1: r[3] })

/**
 * Sound occlusion from the same geometry that blocks sight: each wall or closed door between listener and source adds
 * 0.6, each window pane 0.25, capped at 1. `strength` scales it (the Lab's Occlusion control).
 */
export class SoundOcclusion {
  private solid: ReturnType<typeof box>[] = []
  private panes: ReturnType<typeof box>[] = []
  private revision = -1
  strength = 1

  sync(town: Town, revision: number): void {
    if (revision === this.revision) return
    this.revision = revision
    this.solid = sightRects(town).map(box)
    this.panes = town.barriers.filter((b) => b.kind === "window").map((b) => box(b.rect))
  }

  query = (lx: number, lz: number, sx: number, sz: number): number => {
    if (this.strength <= 0) return 0
    let amount = 0
    for (const b of this.solid) if (blocked(lx, lz, sx, sz, b) && (amount += 0.6) >= 1) return this.strength
    for (const b of this.panes) if (blocked(lx, lz, sx, sz, b) && (amount += 0.25) >= 1) return this.strength
    return Math.min(1, amount) * this.strength
  }
}
