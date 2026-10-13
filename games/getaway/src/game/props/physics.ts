import type { GroundShape } from "./contact-shape"

/** Decorative rigid bodies. Positions are mesh origins; velocities and rotation use the mass centre. */
export type Body = {
  id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number
  yaw: number; roll: number; pitch: number; wx: number; wy: number; wz: number
  hx: number; hy: number; hz: number; mass: number; radius: number
  sleep: number; awake: boolean; enabled: boolean; cell: number
  shape?: GroundShape
}
export type Solid = { x0: number; x1: number; z0: number; z1: number; h: number }

/** Centre-in-cell hash. Queries expand by the largest body's radius. Sleeping entries never move. */
export class SpatialHash<T extends { x: number; z: number }> {
  readonly cells = new Map<number, Set<T>>()
  constructor(readonly size = 6) {}
  key(x: number, z: number) { return (Math.floor(x / this.size) + 32768) * 65536 + Math.floor(z / this.size) + 32768 }
  add(b: T) {
    const key = this.key(b.x, b.z)
    let cell = this.cells.get(key)
    if (!cell) this.cells.set(key, cell = new Set())
    cell.add(b)
    return key
  }
  remove(b: T, key = this.key(b.x, b.z)) {
    const cell = this.cells.get(key)
    cell?.delete(b)
    if (!cell?.size) this.cells.delete(key)
  }
  query(x: number, z: number, radius: number, visit: (b: T) => void) {
    const s = this.size
    for (let ix = Math.floor((x - radius) / s); ix <= Math.floor((x + radius) / s); ix++)
      for (let iz = Math.floor((z - radius) / s); iz <= Math.floor((z + radius) / s); iz++) {
        const cell = this.cells.get((ix + 32768) * 65536 + iz + 32768)
        if (cell) for (const b of cell) visit(b)
      }
  }
}

export function body(id: number, x: number, y: number, z: number, hx: number, hy: number, hz: number, mass: number, yaw = 0, shape?: GroundShape): Body {
  return { id, x, y, z, hx, hy, hz, mass, yaw, shape, radius: Math.hypot(hx, hy, hz), vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, roll: 0, pitch: 0, sleep: 0, awake: false, enabled: true, cell: 0 }
}

/** World up in mesh coordinates, matching yaw * pitch * roll in the shader. */
export function groundNormal(b: Body): readonly [number, number, number] {
  return [Math.sin(b.roll) * Math.cos(b.pitch), Math.cos(b.roll) * Math.cos(b.pitch), -Math.sin(b.pitch)]
}

/** Exact ground support of the convex/compound points, or the default box. */
export function support(b: Body) {
  const [x, y, z] = groundNormal(b)
  if (b.shape) {
    let height = -Infinity
    for (const p of b.shape.points) height = Math.max(height, -x * p[0] - y * p[1] - z * p[2])
    return height
  }
  return Math.abs(x) * b.hx + Math.abs(y) * b.hy + Math.abs(z) * b.hz
}

/** Keep world COM fixed when rotating a mesh whose heavy base is below its geometric centre. */
function rotate(b: Body, roll: number, pitch: number, yaw: number) {
  const cy = b.shape?.centerY ?? 0
  if (!cy) { b.roll = roll; b.pitch = pitch; b.yaw = yaw; return }
  const x0 = -Math.sin(b.roll) * cy, z0 = Math.cos(b.roll) * Math.sin(b.pitch) * cy
  const ox0 = x0 * Math.cos(b.yaw) + z0 * Math.sin(b.yaw), oy0 = Math.cos(b.roll) * Math.cos(b.pitch) * cy, oz0 = -x0 * Math.sin(b.yaw) + z0 * Math.cos(b.yaw)
  b.roll = roll; b.pitch = pitch; b.yaw = yaw
  const x1 = -Math.sin(roll) * cy, z1 = Math.cos(roll) * Math.sin(pitch) * cy
  b.x += ox0 - (x1 * Math.cos(yaw) + z1 * Math.sin(yaw))
  b.y += oy0 - Math.cos(roll) * Math.cos(pitch) * cy
  b.z += oz0 - (-x1 * Math.sin(yaw) + z1 * Math.cos(yaw))
}

const angle = (n: number) => Math.atan2(Math.sin(n), Math.cos(n))

/** Low-speed contact relaxation onto an actual supporting face, never a box face through empty space.
 * The compiled face polygon must contain the projected COM with a finite tipping margin. */
function settle(b: Body) {
  if (!b.shape) {
    const quarter = Math.PI / 2
    b.roll += (Math.round(b.roll / quarter) * quarter - b.roll) * .16
    b.pitch += (Math.round(b.pitch / quarter) * quarter - b.pitch) * .16
    return true
  }
  const up = groundNormal(b)
  let best = b.shape.rests[0]!, score = -Infinity
  for (const face of b.shape.rests) {
    const dot = up[0] * face[0] + up[1] * face[1] + up[2] * face[2]
    if (dot > score) { score = dot; best = face }
  }
  let r = Math.hypot(best[0], best[1]) < 1e-7 ? b.roll : Math.atan2(best[0], best[1])
  let p = Math.atan2(-best[2], Math.hypot(best[0], best[1]))
  // Both Euler representations have the same ground normal. Choose the continuous, nearby one.
  if (angle(r + Math.PI - b.roll) ** 2 + angle(Math.PI - p - b.pitch) ** 2 < angle(r - b.roll) ** 2 + angle(p - b.pitch) ** 2) {
    r += Math.PI; p = Math.PI - p
  }
  const dr = angle(r - b.roll), dp = angle(p - b.pitch), stable = Math.hypot(dr, dp) < .001
  rotate(b, b.roll + dr * (stable ? 1 : .08), b.pitch + dp * (stable ? 1 : .08), b.yaw)
  return stable
}

export class PropPhysics {
  readonly hash = new SpatialHash<Body>()
  readonly active = new Set<Body>()
  private remainder = 0
  private maxRadius = 0
  private walls = new Map<number, Solid[]>()
  private seenWalls = new Set<Solid>()
  constructor(readonly ground: (x: number, z: number) => number = () => 0, solids: readonly Solid[] = []) {
    for (const b of solids) for (let x = Math.floor(b.x0 / 6); x <= Math.floor(b.x1 / 6); x++) for (let z = Math.floor(b.z0 / 6); z <= Math.floor(b.z1 / 6); z++) {
      const k = this.hash.key(x * 6, z * 6), cell = this.walls.get(k) ?? []
      cell.push(b); this.walls.set(k, cell)
    }
  }
  add(b: Body) { b.cell = this.hash.add(b); this.maxRadius = Math.max(this.maxRadius, b.radius) }
  remove(b: Body) { this.hash.remove(b, b.cell); this.active.delete(b); b.enabled = false; b.awake = false }
  move(b: Body) {
    const next = this.hash.key(b.x, b.z)
    if (next === b.cell) return
    this.hash.remove(b, b.cell); b.cell = this.hash.add(b)
  }
  wake(b: Body) { if (b.enabled) { b.awake = true; b.sleep = 0; this.active.add(b) } }
  impulse(b: Body, x: number, y: number, z: number, spin = 1) {
    this.wake(b)
    b.vx += x / b.mass; b.vy += y / b.mass; b.vz += z / b.mass
    b.wx += z / b.mass * spin / Math.max(0.4, b.hy * 2)
    b.wz -= x / b.mass * spin / Math.max(0.4, b.hy * 2)
    b.wy += (x - z) / b.mass * spin * 0.17
  }
  update(dt: number) {
    if (!this.active.size) { this.remainder = 0; return }
    this.remainder += Math.max(0, Math.min(dt, 0.05))
    while (this.remainder >= 1 / 120 - 1e-10) { this.step(1 / 120); this.remainder -= 1 / 120 }
  }
  private step(dt: number) {
    for (const b of this.active) {
      b.vy -= 18 * dt
      b.vx *= 0.998; b.vz *= 0.998
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt
      // Angular speed is bounded: small fragments cannot explode numerically at contact.
      b.wx = Math.max(-18, Math.min(18, b.wx)); b.wz = Math.max(-18, Math.min(18, b.wz))
      rotate(b, b.roll + b.wz * dt, b.pitch + b.wx * dt, b.yaw + b.wy * dt)
      const floor = this.ground(b.x, b.z) + support(b)
      if (b.y <= floor + 0.015) {
        b.y = floor
        const impact = -b.vy
        if (b.vy < 0) b.vy = impact > 1.3 ? impact * 0.28 : 0
        const friction = Math.max(0, 1 - 8 * dt)
        b.vx *= friction; b.vz *= friction
        b.wx *= 0.91; b.wy *= 0.94; b.wz *= 0.91
        let stable = false
        if (Math.abs(b.wx) + Math.abs(b.wz) < 2 && impact < 2) {
          stable = settle(b)
          b.y = this.ground(b.x, b.z) + support(b)
        }
        if (stable && b.vx ** 2 + b.vy ** 2 + b.vz ** 2 + b.wx ** 2 + b.wy ** 2 + b.wz ** 2 < 0.055) b.sleep += dt
        else b.sleep = 0
      } else b.sleep = 0
      this.collideWalls(b)
      this.move(b)
    }
    // A rounded contact proxy is deliberate: debris doesn't need stack-quality convex manifolds.
    for (const a of this.active) this.hash.query(a.x, a.z, a.radius + this.maxRadius, b => {
      if (a === b || !b.enabled || b.awake && b.id < a.id) return
      const ra = Math.min(a.radius, Math.max(a.hx, a.hy, a.hz)), rb = Math.min(b.radius, Math.max(b.hx, b.hy, b.hz))
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, r = ra + rb
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 >= r * r) return
      const d = Math.sqrt(d2), nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0, nz = d > 1e-6 ? dz / d : 0
      const speed = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny + (b.vz - a.vz) * nz
      if (speed < -0.25) this.wake(b)
      const ia = 1 / a.mass, ib = b.awake ? 1 / b.mass : 0, inv = 1 / (ia + ib)
      const correction = Math.max(0, r - d - 0.025) * 0.45 * inv
      a.x -= nx * correction * ia; a.y -= ny * correction * ia; a.z -= nz * correction * ia
      b.x += nx * correction * ib; b.y += ny * correction * ib; b.z += nz * correction * ib
      if (speed < 0) {
        const j = -speed * 1.2 * inv
        a.vx -= nx * j * ia; a.vy -= ny * j * ia; a.vz -= nz * j * ia
        b.vx += nx * j * ib; b.vy += ny * j * ib; b.vz += nz * j * ib
      }
    })
    for (const b of this.active) {
      b.y = Math.max(b.y, this.ground(b.x, b.z) + support(b))
      this.move(b)
      if (b.sleep > 0.65) {
        b.vx = b.vy = b.vz = b.wx = b.wy = b.wz = 0
        b.awake = false; this.active.delete(b)
      }
    }
  }
  private collideWalls(b: Body) {
    const r = Math.min(b.radius, Math.max(b.hx, b.hz)), seen = this.seenWalls
    seen.clear()
    for (let x = Math.floor((b.x - r) / 6); x <= Math.floor((b.x + r) / 6); x++) for (let z = Math.floor((b.z - r) / 6); z <= Math.floor((b.z + r) / 6); z++) {
      for (const wall of this.walls.get(this.hash.key(x * 6, z * 6)) ?? []) {
        if (seen.has(wall) || b.y - support(b) > wall.h) continue
        seen.add(wall)
        const dx = b.x - Math.max(wall.x0, Math.min(wall.x1, b.x)), dz = b.z - Math.max(wall.z0, Math.min(wall.z1, b.z)), d = Math.hypot(dx, dz)
        if (d >= r) continue
        if (d > 0.001) {
          b.x += dx / d * (r - d); b.z += dz / d * (r - d)
          const v = (b.vx * dx + b.vz * dz) / d
          if (v < 0) { b.vx -= dx / d * v * 1.3; b.vz -= dz / d * v * 1.3 }
        } else {
          const distances = [b.x - wall.x0, wall.x1 - b.x, b.z - wall.z0, wall.z1 - b.z]
          const side = distances.indexOf(Math.min(...distances))
          if (side < 2) { b.x = side === 0 ? wall.x0 - r : wall.x1 + r; b.vx *= -0.3 }
          else { b.z = side === 2 ? wall.z0 - r : wall.z1 + r; b.vz *= -0.3 }
        }
      }
    }
  }
}
