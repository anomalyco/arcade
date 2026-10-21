/** One placement of a template: position, yaw, uniform scale, and an optional tilt about the template's x axis first. */
export type ScatterPlacement = { x: number; y: number; z: number; yaw: number; scale: number; tilt?: number; roll?: number; tint?: number }

/**
 * Copies of a 32-byte textured template (`packTexturedVerts`) baked into one static vertex buffer, for scattered
 * clutter drawn in a single `TexturedMeshPass` draw. Rotation order: tilt about x, roll about z, then yaw about y;
 * normals follow, and `tint` scales the vertex colour.
 */
export function bakeScatter(template: ArrayBuffer, placements: readonly ScatterPlacement[]): ArrayBuffer {
  const verts = template.byteLength / 32
  if (!Number.isInteger(verts)) throw new Error("Scatter template must use the 32-byte textured vertex layout")
  const out = new ArrayBuffer(template.byteLength * placements.length)
  const src = new Uint8Array(template), dst = new Uint8Array(out)
  const f = new Float32Array(out), n = new Int8Array(out)
  placements.forEach((p, k) => {
    const base = k * template.byteLength
    dst.set(src, base)
    const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw), ct = Math.cos(p.tilt ?? 0), st = Math.sin(p.tilt ?? 0), cr = Math.cos(p.roll ?? 0), sr = Math.sin(p.roll ?? 0)
    const rotate = (x: number, y: number, z: number): [number, number, number] => {
      const y1 = y * ct - z * st, z1 = y * st + z * ct
      const x2 = x * cr - y1 * sr, y2 = x * sr + y1 * cr
      return [x2 * cy - z1 * sy, y2, x2 * sy + z1 * cy]
    }
    for (let v = 0; v < verts; v++) {
      const o = base + v * 32, fo = o / 4
      const [x, y, z] = rotate(f[fo]!, f[fo + 1]!, f[fo + 2]!)
      f[fo] = x * p.scale + p.x; f[fo + 1] = y * p.scale + p.y; f[fo + 2] = z * p.scale + p.z
      const [nx, ny, nz] = rotate(n[o + 12]! / 127, n[o + 13]! / 127, n[o + 14]! / 127)
      n[o + 12] = Math.round(nx * 127); n[o + 13] = Math.round(ny * 127); n[o + 14] = Math.round(nz * 127)
      if (p.tint !== undefined && p.tint !== 1) for (let c = 16; c < 19; c++) dst[o + c] = Math.min(255, Math.round(dst[o + c]! * p.tint))
    }
  })
  return out
}
