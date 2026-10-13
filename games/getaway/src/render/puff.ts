import { MAT, Mesh } from "./mesh"

/** Faceted smoke puff: a jittered icosahedron, unit radius, origin at center. */
export function buildPuff(): Mesh {
  const m = new Mesh()
  const t = (1 + Math.sqrt(5)) / 2
  const v = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((p, i) => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!)
    const j = 0.85 + 0.3 * ((i * 7919) % 13) / 13
    return [(p[0]! / l) * j, (p[1]! / l) * j * 0.8, (p[2]! / l) * j]
  })
  const f = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]
  for (const [a, b, c] of f) m.facet(v[a!]!, v[b!]!, v[c!]!, [0.94, 0.95, 0.98], MAT.smoke)
  return m
}
