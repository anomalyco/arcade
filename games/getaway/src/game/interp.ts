import { hermite2 } from "@arcade/kit/net/interpolate"
import type { CarView, WorldView } from "../../shared/sim/world"

function lerpAngle(a: number, b: number, t: number) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a))
  return a + d * t
}

/**
 * Blends two snapshots car by car (cubic Hermite on x/z through velocities when `span > 0`, coasting `over` seconds
 * past `b` during a stall). Cars missing from the older one (or teleporting) snap to the newer state.
 */
export function lerpView(a: WorldView, b: WorldView, t: number, span = 0, over = 0): WorldView {
  if (a.round !== b.round) return b
  const prev = new Map(a.cars.map((c) => [c.id, c]))
  const cars: CarView[] = b.cars.map((c) => {
    const p = prev.get(c.id)
    if (!p || p.ghost !== c.ghost || p.tunnels !== c.tunnels || Math.hypot(p.x - c.x, p.z - c.z) > 25) {
      return over > 0 && !c.ghost ? { ...c, x: c.x + c.vx * over, z: c.z + c.vz * over, h: c.h + (c.yaw ?? 0) * over } : c
    }
    if (span > 0) {
      const m = hermite2({ x: p.x, y: p.z, vx: p.vx, vy: p.vz }, { x: c.x, y: c.z, vx: c.vx, vy: c.vz }, span, t, over, 4)
      return {
        ...c,
        y: (p.y ?? 0) + ((c.y ?? 0) - (p.y ?? 0)) * t,
        vy: (p.vy ?? 0) + ((c.vy ?? 0) - (p.vy ?? 0)) * t,
        x: m.x,
        z: m.y,
        h: lerpAngle(p.h, c.h, t) + (c.yaw ?? 0) * over,
        vx: m.vx,
        vz: m.vy,
      }
    }
    return {
      ...c,
      y: (p.y ?? 0) + ((c.y ?? 0) - (p.y ?? 0)) * t,
      vy: (p.vy ?? 0) + ((c.vy ?? 0) - (p.vy ?? 0)) * t,
      x: p.x + (c.x - p.x) * t + c.vx * over,
      z: p.z + (c.z - p.z) * t + c.vz * over,
      h: lerpAngle(p.h, c.h, t) + (c.yaw ?? 0) * over,
      vx: p.vx + (c.vx - p.vx) * t,
      vz: p.vz + (c.vz - p.vz) * t,
    }
  })
  const h = b.heli
  const ph = a.heli
  const heli = ph.active && h.active ? { ...h, x: ph.x + (h.x - ph.x) * t, y: ph.y + (h.y - ph.y) * t, z: ph.z + (h.z - ph.z) * t, sx: ph.sx + (h.sx - ph.sx) * t, sz: ph.sz + (h.sz - ph.sz) * t, h: lerpAngle(ph.h, h.h, t) } : h
  return { ...b, cars, heli }
}
