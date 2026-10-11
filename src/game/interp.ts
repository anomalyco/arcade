import type { CarView, WorldView } from "../../shared/sim/world"

function lerpAngle(a: number, b: number, t: number) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a))
  return a + d * t
}

/** Blends two snapshots car by car. Cars missing from the older one (or teleporting) snap to the newer state. */
export function lerpView(a: WorldView, b: WorldView, t: number): WorldView {
  if (a.round !== b.round) return b
  const prev = new Map(a.cars.map((c) => [c.id, c]))
  const cars: CarView[] = b.cars.map((c) => {
    const p = prev.get(c.id)
    if (!p || p.ghost !== c.ghost || Math.hypot(p.x - c.x, p.z - c.z) > 25) return c
    return { ...c, x: p.x + (c.x - p.x) * t, z: p.z + (c.z - p.z) * t, h: lerpAngle(p.h, c.h, t), vx: p.vx + (c.vx - p.vx) * t, vz: p.vz + (c.vz - p.vz) * t }
  })
  const h = b.heli
  const ph = a.heli
  const heli = ph.active && h.active ? { ...h, x: ph.x + (h.x - ph.x) * t, y: ph.y + (h.y - ph.y) * t, z: ph.z + (h.z - ph.z) * t, sx: ph.sx + (h.sx - ph.sx) * t, sz: ph.sz + (h.sz - ph.sz) * t, h: lerpAngle(ph.h, h.h, t) } : h
  return { ...b, cars, heli }
}
