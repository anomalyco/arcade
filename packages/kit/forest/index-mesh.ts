/** Deduplicate complete packed vertices, preserving triangle order, seams and every attribute bit. */
export function indexForestMesh(data: ArrayBuffer): { vertices: Uint32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const words = new Uint32Array(data), unique: number[] = [], seen = new Map<string, number>()
  const indices = new Uint32Array(data.byteLength / 32)
  for (let i = 0; i < indices.length; i++) {
    const vertex = words.subarray(i * 8, (i + 1) * 8), key = vertex.join(",")
    let index = seen.get(key)
    if (index === undefined) { index = unique.length / 8; seen.set(key, index); unique.push(...vertex) }
    indices[i] = index
  }
  return { vertices: new Uint32Array(unique), indices }
}
