import { GADGETS, SPIKE_THICK } from "../../shared/config"
import { MAT, Mesh } from "./mesh"

/** Spike strip in local space: spans x across the road (±radius), SPIKE_THICK deep along z, low-poly spikes on top. */
export function buildSpikeStrip(): Mesh {
  const m = new Mesh()
  const r = GADGETS.spike.radius
  const d = SPIKE_THICK / 2
  // Hinged accordion segments, alternating hazard yellow and black.
  const segs = 12
  for (let i = 0; i < segs; i++) {
    const x0 = -r + (i / segs) * 2 * r + 0.04
    const x1 = -r + ((i + 1) / segs) * 2 * r - 0.04
    m.box(x0, x1, 0.02, 0.12, -d, d, i % 2 ? [0.08, 0.08, 0.09] : [0.95, 0.72, 0.1])
    // Two rows of spikes per segment.
    for (const sz of [-d * 0.5, d * 0.5])
      for (let k = 0; k < 3; k++) {
        const cx = x0 + ((k + 0.5) / 3) * (x1 - x0)
        const s = 0.07
        const top = [cx, 0.38, sz]
        const a = [cx - s, 0.12, sz - s]
        const b = [cx + s, 0.12, sz - s]
        const c = [cx + s, 0.12, sz + s]
        const e = [cx - s, 0.12, sz + s]
        const steel: [number, number, number] = [0.78, 0.8, 0.84]
        m.facet(a, top, b, steel)
        m.facet(b, top, c, steel)
        m.facet(c, top, e, steel)
        m.facet(e, top, a, steel)
      }
  }
  // Red reflectors on the ends.
  for (const sx of [-1, 1]) m.box(sx * r - 0.12, sx * r + 0.12, 0.02, 0.22, -d, d, [1, 0.1, 0.06], MAT.emissive)
  return m
}
