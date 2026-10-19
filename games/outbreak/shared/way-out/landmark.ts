import type { Rect } from "@arcade/kit/sim/geom"
import type { Compass, DestinationKind, WayOutPlan } from "./plan"

/**
 * The destination's solid parts (AR-64): the ferry's hull, the checkpoint's booth and truck, the airfield's hangar and
 * plane, the dam's wall. Boxes in the landmark's own frame: +x is the way the route arrives (so the far road holds the
 * ferry, the gate, the runway, the wall), +z to the right of it, the crossroads at the origin. The client draws these
 * and more (`src/way-out/props.ts`); survivors and cars collide with these.
 */
export type LandmarkBox = { x0: number; z0: number; x1: number; z1: number; h: number }

export const LANDMARK_SOLIDS: Readonly<Record<DestinationKind, readonly LandmarkBox[]>> = {
  ferry: [{ x0: 12, z0: -3.6, x1: 30, z1: 3.6, h: 2.4 }],
  checkpoint: [
    { x0: 8.4, z0: 7, x1: 10.6, z1: 9.6, h: 2.6 },
    { x0: 13, z0: 2.2, x1: 19, z1: 4.6, h: 2.8 },
    { x0: 11, z0: -11, x1: 13, z1: -9, h: 1 },
  ],
  airfield: [
    { x0: 9, z0: 9.5, x1: 15.5, z1: 15.5, h: 5 },
    { x0: 15, z0: -0.7, x1: 23, z1: 0.7, h: 1.6 },
  ],
  dam: [
    { x0: 9, z0: -16, x1: 11, z1: 16, h: 6.5 },
    { x0: 4, z0: 9, x1: 8, z1: 13, h: 2.8 },
  ],
}

/** The way the route arrives, as a heading in plan space (x east, y south). */
export function arrivalHeading(arrival: Compass): number {
  return arrival === "west" ? 0 : arrival === "east" ? Math.PI : arrival === "north" ? Math.PI / 2 : -Math.PI / 2
}

/** A point in the landmark's frame, in world metres. */
export function landmarkToWorld(plan: Pick<WayOutPlan, "x" | "y" | "arrival">, x: number, z: number): { x: number; y: number } {
  const h = arrivalHeading(plan.arrival)
  const c = Math.round(Math.cos(h))
  const s = Math.round(Math.sin(h))
  return { x: plan.x + x * c - z * s, y: plan.y + x * s + z * c }
}

/** The destination's solid boxes as world rects (roads meet at right angles, so they stay axis-aligned). */
const rectCache = new WeakMap<WayOutPlan, readonly Rect[]>()

export function landmarkRects(plan: WayOutPlan): readonly Rect[] {
  const hit = rectCache.get(plan)
  if (hit) return hit
  const out = LANDMARK_SOLIDS[plan.kind].map((b) => {
    const a = landmarkToWorld(plan, b.x0, b.z0)
    const c = landmarkToWorld(plan, b.x1, b.z1)
    return [Math.min(a.x, c.x), Math.min(a.y, c.y), Math.max(a.x, c.x), Math.max(a.y, c.y)] as Rect
  })
  rectCache.set(plan, out)
  return out
}
