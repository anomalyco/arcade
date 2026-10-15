import { OCC_FLOATS } from "@arcade/kit/limits"
import { propShape, type Town } from "../shared/map"

type Rect = readonly [number, number, number, number]

/** Height of a full light caster: taller than every lens, lamp and headlight, so nothing passes over it. */
export const WALL_CASTER_HEIGHT = 2.8
/** An open window only blocks below its sill. */
export const OPEN_WINDOW_SILL = 0.85

const sameRect = (a: Rect, b: Rect) =>
  Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4 && Math.abs(a[2] - b[2]) < 1e-4 && Math.abs(a[3] - b[3]) < 1e-4

/**
 * Packs the static light casters every shadowed light (flashlight, room lamps, muzzle flash, co-op flashlights,
 * headlights) shares: walls and closed doors (`blockers`) and closed windows at full height, open windows as their
 * sill, then tall props. Heights are the real geometry, not the cutaway stubs the camera sees indoors, so light only
 * leaves a room through an open door or window. Returns how many occluders were written and the full-height
 * rects (walls, closed doors, closed windows) for CPU light raycasts such as the flashlight's bounce and reach.
 */
export function packLightOccluders(
  town: Town,
  blockers: readonly Rect[],
  out: Float32Array,
  max: number,
): { count: number; walls: Rect[] } {
  out.fill(0)
  const walls: Rect[] = [...blockers]
  let n = 0
  const put = (r: Rect, h: number) => {
    out[n * OCC_FLOATS] = r[0]
    out[n * OCC_FLOATS + 1] = r[1]
    out[n * OCC_FLOATS + 2] = r[2]
    out[n * OCC_FLOATS + 3] = r[3]
    out[n * OCC_FLOATS + 4] = h
    n++
  }
  for (let i = 0; i < blockers.length && n < max; i++) put(blockers[i]!, WALL_CASTER_HEIGHT)
  for (const b of town.barriers) {
    if (b.kind !== "window" || n >= max) continue
    const open = town.windows.find((w) => sameRect(w.rect, b.rect))?.open ?? false
    put(b.rect, open ? OPEN_WINDOW_SILL : WALL_CASTER_HEIGHT)
    if (!open) walls.push(b.rect)
  }
  for (const pr of town.props) {
    if (pr.kind === "coffee" || pr.kind === "table" || pr.kind === "chair" || pr.kind === "nightstand") continue
    if (n >= max) break
    const s = propShape(pr)
    if (s) put(s.rect, s.height)
  }
  return { count: n, walls }
}

/** Changes whenever a window opens or closes, so the casters are rebuilt even without a topology revision. */
export function windowStateKey(town: Town): number {
  let h = town.windows.length
  for (let i = 0; i < town.windows.length; i++) if (town.windows[i]!.open) h = (Math.imul(h, 31) + i + 1) | 0
  return h
}
