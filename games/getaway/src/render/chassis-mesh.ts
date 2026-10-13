import { wheelParts } from "./car-mesh"
import { Mesh, FLOATS_PER_VERT } from "./mesh"

/** Split the existing geometry, retaining its exact axle positions and tire dimensions. */
export function splitChassis(source: Mesh) {
  const body = new Mesh()
  let cursor = 0
  const wheels = (wheelParts.get(source) ?? []).map(part => {
    body.v.push(...source.v.slice(cursor, part.start))
    cursor = part.end
    const mesh = new Mesh()
    mesh.v.push(...source.v.slice(part.start, part.end))
    for (let i = 0; i < mesh.v.length; i += FLOATS_PER_VERT) {
      mesh.v[i] -= part.x
      mesh.v[i + 1] -= part.y
      mesh.v[i + 2] -= part.z
    }
    // Three pale spokes make rotation readable on the otherwise uniform octagonal rim.
    let outer = 0
    for (let i = 0; i < mesh.v.length; i += FLOATS_PER_VERT) outer = Math.max(outer, mesh.v[i] * part.side)
    const x = part.side * (outer + 0.002), r = part.y
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI * 2 / 3
      const point = (radius: number, angle: number) => [x, Math.sin(angle) * radius, Math.cos(angle) * radius]
      const points = [point(r * 0.16, a - 0.2), point(r * 0.55, a - 0.12), point(r * 0.55, a + 0.12), point(r * 0.16, a + 0.2)]
      if (part.side > 0) points.reverse()
      mesh.quad(points[0], points[1], points[2], points[3], [part.side, 0, 0], [0.64, 0.65, 0.68])
    }
    return { ...part, mesh }
  })
  body.v.push(...source.v.slice(cursor))
  return { body, wheels }
}
