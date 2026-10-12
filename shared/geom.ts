/** Axis-aligned rectangle: [x0, y0, x1, y1] with x0 < x1 and y0 < y1, in metres. */
export type Rect = readonly [number, number, number, number]
export type Vec = { x: number; y: number }

/**
 * Distance along a unit ray (ox, oy) + t * (dx, dy) to the first hit with the rectangle, or Infinity.
 * An origin inside the rectangle returns 0. Matches the WGSL polar shadow pass.
 */
export function rayRect(ox: number, oy: number, dx: number, dy: number, r: Rect, maxT: number): number {
  let t0 = 0
  let t1 = maxT
  if (Math.abs(dx) < 1e-9) {
    if (ox < r[0] || ox > r[2]) return Infinity
  } else {
    const inv = 1 / dx
    let a = (r[0] - ox) * inv
    let b = (r[2] - ox) * inv
    if (a > b) [a, b] = [b, a]
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, b)
    if (t0 > t1) return Infinity
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < r[1] || oy > r[3]) return Infinity
  } else {
    const inv = 1 / dy
    let a = (r[1] - oy) * inv
    let b = (r[3] - oy) * inv
    if (a > b) [a, b] = [b, a]
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, b)
    if (t0 > t1) return Infinity
  }
  return t0
}

/** Nearest wall hit along a ray within maxT, or Infinity. */
export function raycast(ox: number, oy: number, dx: number, dy: number, walls: readonly Rect[], maxT: number): number {
  let best = maxT
  for (const w of walls) {
    const t = rayRect(ox, oy, dx, dy, w, best)
    if (t < best) best = t
  }
  return best >= maxT ? Infinity : best
}

/** True when nothing blocks the straight segment from a to b. */
export function clearLine(ax: number, ay: number, bx: number, by: number, walls: readonly Rect[]): boolean {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return true
  const t = raycast(ax, ay, dx / len, dy / len, walls, len - 1e-4)
  return t === Infinity
}

/** Pushes a circle out of any rectangle it overlaps. Two passes settle corners. */
export function pushOutCircle(p: Vec, radius: number, walls: readonly Rect[]): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const r of walls) {
      const cx = Math.max(r[0], Math.min(p.x, r[2]))
      const cy = Math.max(r[1], Math.min(p.y, r[3]))
      const dx = p.x - cx
      const dy = p.y - cy
      const d2 = dx * dx + dy * dy
      if (d2 >= radius * radius) continue
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2)
        const push = radius - d
        p.x += (dx / d) * push
        p.y += (dy / d) * push
      } else {
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
}

export function insideAny(x: number, y: number, walls: readonly Rect[]): boolean {
  return walls.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])
}

export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y)

/** Shortest distance from point p to the infinite-length-clamped segment a→b. */
export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
}
