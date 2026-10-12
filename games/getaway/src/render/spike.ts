import { GADGETS, SPIKE_THICK } from "../../shared/config"
import { MAT, Mesh } from "./mesh"

/**
 * Spike strip in local space: spans x across the road (±radius), low-poly spikes on top. Drawn a little deeper than
 * SPIKE_THICK, with oversized spikes, so it reads at gameplay zoom.
 */
export function buildSpikeStrip(): Mesh {
  const m = new Mesh()
  const r = GADGETS.spike.radius
  const d = SPIKE_THICK * 0.7
  // Dark rubber backing so the hazard segments pop against wet asphalt.
  m.box(-r - 0.1, r + 0.1, 0, 0.05, -d - 0.12, d + 0.12, [0.03, 0.03, 0.035])
  // Hinged accordion segments, alternating hazard yellow and black.
  const segs = 12
  for (let i = 0; i < segs; i++) {
    const x0 = -r + (i / segs) * 2 * r + 0.04
    const x1 = -r + ((i + 1) / segs) * 2 * r - 0.04
    m.box(x0, x1, 0.05, 0.14, -d, d, i % 2 ? [0.08, 0.08, 0.09] : [1, 0.8, 0.12])
    // Two rows of spikes per segment.
    for (const sz of [-d * 0.5, d * 0.5])
      for (let k = 0; k < 3; k++) {
        const cx = x0 + ((k + 0.5) / 3) * (x1 - x0)
        const s = 0.11
        const top = [cx, 0.5, sz]
        const a = [cx - s, 0.14, sz - s]
        const b = [cx + s, 0.14, sz - s]
        const c = [cx + s, 0.14, sz + s]
        const e = [cx - s, 0.14, sz + s]
        const steel: [number, number, number] = [0.9, 0.92, 0.96]
        m.facet(a, top, b, steel)
        m.facet(b, top, c, steel)
        m.facet(c, top, e, steel)
        m.facet(e, top, a, steel)
      }
  }
  // Red reflectors on the ends.
  for (const sx of [-1, 1]) m.box(sx * r - 0.16, sx * r + 0.16, 0.05, 0.28, -d, d, [1, 0.1, 0.06], MAT.emissive)
  return m
}
