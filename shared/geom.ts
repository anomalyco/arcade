/** Axis-aligned rectangle on the floor plan: [x0, y0, x1, y1] in metres with x0 < x1 and y0 < y1. */
export type Rect = readonly [number, number, number, number]
export type Vec = { x: number; y: number }

/**
 * Distance along a unit ray from (ox, oy) in direction (dx, dy) to where it enters the rectangle, or Infinity when it
 * misses within maxT. An origin inside the rectangle returns 0. The WGSL shadow pass uses the same slab test.
 */
export function rayRect(ox: number, oy: number, dx: number, dy: number, r: Rect, maxT: number): number {
  let t0 = 0
  let t1 = maxT
  if (Math.abs(dx) < 1e-9) {
    if (ox < r[0] || ox > r[2]) return Infinity
  } else {
    let a = (r[0] - ox) / dx
    let b = (r[2] - ox) / dx
    if (a > b) [a, b] = [b, a]
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, b)
    if (t0 > t1) return Infinity
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < r[1] || oy > r[3]) return Infinity
  } else {
    let a = (r[1] - oy) / dy
    let b = (r[3] - oy) / dy
    if (a > b) [a, b] = [b, a]
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, b)
    if (t0 > t1) return Infinity
  }
  return t0
}

/** Nearest hit along a ray within maxT, or Infinity. */
export function raycast(ox: number, oy: number, dx: number, dy: number, rects: readonly Rect[], maxT: number): number {
  let best = maxT
  let hit = false
  for (const r of rects) {
    const t = rayRect(ox, oy, dx, dy, r, best)
    if (t < best || (t === best && !hit && t !== Infinity)) {
      best = t
      hit = true
    }
  }
  return hit ? best : Infinity
}

/** True when nothing blocks the straight segment from a to b. */
export function clearLine(ax: number, ay: number, bx: number, by: number, rects: readonly Rect[]): boolean {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return true
  return raycast(ax, ay, dx / len, dy / len, rects, len - 1e-4) === Infinity
}

/** Pushes a circle out of any rectangle it overlaps. Two passes settle corners. */
export function pushOut(p: Vec, radius: number, rects: readonly Rect[]): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const r of rects) {
      const cx = Math.max(r[0], Math.min(p.x, r[2]))
      const cy = Math.max(r[1], Math.min(p.y, r[3]))
      const dx = p.x - cx
      const dy = p.y - cy
      const d2 = dx * dx + dy * dy
      if (d2 >= radius * radius) continue
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2)
        p.x += (dx / d) * (radius - d)
        p.y += (dy / d) * (radius - d)
        continue
      }
      const left = p.x - r[0]
      const right = r[2] - p.x
      const up = p.y - r[1]
      const down = r[3] - p.y
      const m = Math.min(left, right, up, down)
      if (m === left) p.x = r[0] - radius
      else if (m === right) p.x = r[2] + radius
      else if (m === up) p.y = r[1] - radius
      else p.y = r[3] + radius
    }
  }
}

export function inRect(x: number, y: number, r: Rect, pad = 0): boolean {
  return x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad
}

export function distToRect(x: number, y: number, r: Rect): number {
  const cx = Math.max(r[0], Math.min(x, r[2]))
  const cy = Math.max(r[1], Math.min(y, r[3]))
  return Math.hypot(x - cx, y - cy)
}

export const rectCenter = (r: Rect): Vec => ({ x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 })

export function angleDiff(a: number, b: number): number {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}
