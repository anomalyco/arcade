// Reading baked ramp tables (`ramps.ts` bakes them). Kept apart so hot paths such as `fx/particles` read tables
// without pulling in knobs.

/** A table's value at `t` (0…1, clamped), linearly between samples; `stride` 3 with `channel` 0–2 reads a gradient table. */
export function sampleTable(table: Float32Array, t: number, stride = 1, channel = 0): number {
  const n = table.length / stride
  const f = (t > 0 ? (t < 1 ? t : 1) : 0) * (n - 1)
  const i = Math.min(n - 2, Math.floor(f))
  const a = table[i * stride + channel]!
  return a + (table[(i + 1) * stride + channel]! - a) * (f - i)
}
