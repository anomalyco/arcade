import type { Rect } from "@arcade/kit/sim/geom"

/** Plan area the contact map covers: the office floor (metres). */
export const LOOK_CONTACT = { x: -6, z: -9, w: 12, d: 18 } as const

/**
 * Contact shading baked once from the office's occluder footprints into one RGBA layer: r = how open the floor is
 * (darkening toward every partition, desk, cabinet and wall base), g = the height of a desk top overhead (0 in the open).
 */
export function bakeContact(occluders: readonly { rect: Rect; h: number }[], size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size * size * 4), { x: x0, z: z0, w, d } = LOOK_CONTACT
  for (let j = 0; j < size; j++) {
    const z = z0 + (j + .5) / size * d
    const near = occluders.filter(o => z > o.rect[1] - .45 && z < o.rect[3] + .45)
    for (let i = 0; i < size; i++) {
      const x = x0 + (i + .5) / size * w
      let open = 1, over = 0
      for (const { rect: [ax, az, bx, bz], h } of near) {
        const inside = Math.min(x - ax, bx - x, z - az, bz - z)
        if (inside > .03) { if (h < .85) over = Math.max(over, h); continue }
        if (inside > 0) continue
        const dist = Math.hypot(Math.max(ax - x, 0, x - bx), Math.max(az - z, 0, z - bz))
        if (dist < .45) open *= 1 - .55 * Math.exp(-dist / .09)
      }
      const k = (j * size + i) * 4
      out[k] = Math.round(open * 255); out[k + 1] = Math.round(over * 255); out[k + 3] = 255
    }
  }
  return out
}
