/**
 * The finishing pass for code-built props: chamfered boxes and cylinders, baked AO, curvature and sky exposure per
 * vertex, a look, and an albedo check, so a prop built from primitives renders worn and grounded by default once a
 * game's shader reads the finish (`SceneHooks.finish` + `materials/wear.ts`).
 *
 *   const { mesh, report } = finish(m => { m.box(...); m.cylinder(...) }, { look: "painted-steel", chamfer: "auto" })
 *   finish(existing, { look: "old-wood", bake: { ground: 0 } })   // bake an already-built mesh
 *
 * Packed buffers (24- or 32-byte vertices, e.g. the forest's camp) use `finishPacked`.
 */
import { FLOATS_PER_VERT, Mesh } from "./mesh"
import { bakeFinish, finishByte15, finishByte19, readPacked, type FinishBake, type FinishBakeOptions } from "./finish-bake"
import { checkAlbedo, finishLook, lookIndex, srgbToLinear, type AlbedoClass, type FinishLookId } from "./materials/wear"

export type FinishOptions = {
  look: FinishLookId
  /** Chamfer for the builder form (`Mesh` options); an existing mesh keeps the edges it was built with. */
  chamfer?: number | "auto"
  /** How worn this prop is (0 pristine … 1 the look's full wear): scales the baked edge and cavity data. */
  wear?: number
  bake?: FinishBakeOptions
}

export type FinishReport = {
  look: FinishLookId
  vertices: number
  triangles: number
  /** Mean and minimum baked AO, share of convex-edge vertices, mean sky exposure. */
  ao: { mean: number; min: number }
  edges: number
  exposure: number
  /** Vertex colours checked against the look's albedo class (skipped when the look replaces albedo). */
  albedo: { checked: number; dark: number; bright: number; cls: AlbedoClass }
  ms: number
}

/** Writes finishing bytes for `bake` with one look and wear amount. */
export function finishBytes(bake: FinishBake, look: number, wear = 1): Uint8Array {
  const n = bake.ao.length, out = new Uint8Array(n * 2)
  for (let i = 0; i < n; i++) {
    out[i * 2] = finishByte15(bake.curvature[i]! * wear, look) & 255
    out[i * 2 + 1] = finishByte19(1 - (1 - bake.ao[i]!) * wear, bake.exposure[i]!)
  }
  return out
}

function summarise(bake: FinishBake) {
  const n = bake.ao.length || 1
  let sum = 0, min = 1, edges = 0, expo = 0
  for (let i = 0; i < bake.ao.length; i++) {
    sum += bake.ao[i]!; min = Math.min(min, bake.ao[i]!); expo += bake.exposure[i]!
    if (bake.curvature[i]! > 0.4) edges++
  }
  return { ao: { mean: sum / n, min }, edges: edges / n, exposure: expo / n }
}

/**
 * Bakes the vertices `Mesh.finishPart` tagged and sets `mesh.finishBytes` (untagged vertices stay unfinished, 0 and
 * 255). Untagged triangles near the tagged ones occlude them: the wall behind a cabinet darkens its back corners.
 * Returns the mesh, or it untouched when nothing is tagged.
 */
export function finishTagged(mesh: Mesh, bake: FinishBakeOptions = {}, wear = 1): Mesh {
  const n = mesh.count, v = mesh.v, looks = mesh.finishLooks
  const tagged: number[] = []
  for (let i = 0; i < n; i++) if (looks[i] !== undefined) tagged.push(i)
  if (!tagged.length) return mesh
  const pos = new Float32Array(tagged.length * 3), nrm = new Float32Array(tagged.length * 3), hints = new Float32Array(tagged.length).fill(NaN)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  tagged.forEach((vi, j) => {
    const s = vi * FLOATS_PER_VERT
    for (let k = 0; k < 3; k++) {
      pos[j * 3 + k] = v[s + k]!; nrm[j * 3 + k] = v[s + 3 + k]!
      lo[k] = Math.min(lo[k]!, v[s + k]!); hi[k] = Math.max(hi[k]!, v[s + k]!)
    }
    const h = mesh.curvatureHints[vi]
    if (h !== undefined) hints[j] = h
  })
  // Occluders: untagged triangles touching the tagged parts' box grown by the longest ray.
  const pad = Math.max(bake.reach ?? 0.6, bake.exposure !== undefined ? 0 : bake.skyReach ?? 4)
  const occluders: number[] = bake.occluders ? Array.from(bake.occluders) : []
  for (let t = 0; t + 2 < n; t += 3) {
    if (looks[t] !== undefined && looks[t + 1] !== undefined && looks[t + 2] !== undefined) continue
    let inside = true
    for (let k = 0; k < 3 && inside; k++) {
      const a = v[t * FLOATS_PER_VERT + k]!, b = v[(t + 1) * FLOATS_PER_VERT + k]!, c = v[(t + 2) * FLOATS_PER_VERT + k]!
      inside = Math.max(a, b, c) >= lo[k]! - pad && Math.min(a, b, c) <= hi[k]! + pad
    }
    if (inside) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) occluders.push(v[(t + j) * FLOATS_PER_VERT + k]!)
  }
  const result = bakeFinish(pos, nrm, { ...bake, occluders, curvatureHints: hints })
  const out = new Uint8Array(n * 2)
  for (let i = 0; i < n; i++) out[i * 2 + 1] = 255
  tagged.forEach((vi, j) => {
    out[vi * 2] = finishByte15(result.curvature[j]! * wear, looks[vi]!) & 255
    out[vi * 2 + 1] = finishByte19(1 - (1 - result.ao[j]!) * wear, result.exposure[j]!)
  })
  mesh.finishBytes = out
  return mesh
}

/** Finishes a mesh (or builds one with `chamfer` and finishes it): bakes, tags the look, and checks vertex albedo. */
export function finish(target: Mesh | ((m: Mesh) => void), opts: FinishOptions): { mesh: Mesh; report: FinishReport } {
  const t0 = performance.now()
  let mesh: Mesh
  if (typeof target === "function") {
    mesh = new Mesh({ chamfer: opts.chamfer ?? "auto" })
    target(mesh)
  } else mesh = target
  const n = mesh.count, v = mesh.v
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const s = i * FLOATS_PER_VERT
    pos[i * 3] = v[s]!; pos[i * 3 + 1] = v[s + 1]!; pos[i * 3 + 2] = v[s + 2]!
    nrm[i * 3] = v[s + 3]!; nrm[i * 3 + 1] = v[s + 4]!; nrm[i * 3 + 2] = v[s + 5]!
  }
  const hints = new Float32Array(n).fill(NaN)
  mesh.curvatureHints.forEach((k, i) => { if (i < n && k !== undefined) hints[i] = k })
  const bake = bakeFinish(pos, nrm, { ...opts.bake, curvatureHints: hints })
  const index = lookIndex(opts.look)
  for (let i = 0; i < n; i++) mesh.finishLooks[i] = index
  mesh.finishBytes = finishBytes(bake, index, opts.wear ?? 1)
  const look = finishLook(opts.look)
  const albedo = { checked: 0, dark: 0, bright: 0, cls: look.albedoClass }
  if (!look.replace) for (let i = 0; i < n; i++) {
    const s = i * FLOATS_PER_VERT
    const c = checkAlbedo([srgbToLinear(v[s + 6]!), srgbToLinear(v[s + 7]!), srgbToLinear(v[s + 8]!)], look.albedoClass)
    albedo.checked++
    if (c.verdict === "dark") albedo.dark++
    else if (c.verdict === "bright") albedo.bright++
  }
  return { mesh, report: { look: opts.look, vertices: n, triangles: n / 3, ...summarise(bake), albedo, ms: performance.now() - t0 } }
}

/**
 * One range of triangle-list vertices (`stride` 24 or 32) and the look its triangles get: one for the range, or per
 * triangle from its first vertex's index in `buf` (e.g. by material). Null leaves a triangle unfinished but lets it
 * occlude the others. `hints` is curvature its builder already knows, per vertex of the range (NaN = bake).
 */
export type FinishRange = {
  buf: ArrayBuffer
  stride: number
  first: number
  count: number
  look: FinishLookId | null | ((vertex: number) => FinishLookId | null)
  wear?: number
  hints?: ArrayLike<number>
  /** Convex part per vertex of the range, unique across ranges (negative = none; `FinishBakeOptions.parts`). */
  parts?: ArrayLike<number>
}

/**
 * Finishes ranges of packed vertices in place. Every range's triangles occlude every other's, so a porch roof shades
 * the deck under it even when they live in different buffers.
 */
export function finishPacked(ranges: readonly FinishRange[], bake: FinishBakeOptions = {}): FinishBake {
  // Per range, the look index of each triangle (−1 = occluder only).
  const looks = ranges.map(r => {
    const out = new Int8Array(Math.floor(r.count / 3))
    for (let t = 0; t < out.length; t++) {
      const id = typeof r.look === "function" ? r.look(r.first + t * 3) : r.look
      out[t] = id === null ? -1 : lookIndex(id)
    }
    return out
  })
  const total = looks.reduce((s, l) => s + l.reduce((n, k) => n + (k >= 0 ? 3 : 0), 0), 0)
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), hints = new Float32Array(total).fill(NaN), parts = new Int32Array(total).fill(-1)
  const extra = bake.occluders ? Array.from(bake.occluders) : []
  let at = 0
  ranges.forEach((r, ri) => {
    const p = readPacked(r.buf, r.stride, r.first, looks[ri]!.length * 3)
    looks[ri]!.forEach((k, t) => {
      if (k < 0) { for (let j = 0; j < 9; j++) extra.push(p.pos[t * 9 + j]!); return }
      pos.set(p.pos.subarray(t * 9, t * 9 + 9), at * 3); nrm.set(p.nrm.subarray(t * 9, t * 9 + 9), at * 3)
      if (r.hints) for (let j = 0; j < 3; j++) hints[at + j] = r.hints[t * 3 + j] ?? NaN
      if (r.parts) for (let j = 0; j < 3; j++) parts[at + j] = r.parts[t * 3 + j] ?? -1
      at += 3
    })
  })
  const result = bakeFinish(pos, nrm, { ...bake, occluders: extra, curvatureHints: hints, parts })
  at = 0
  ranges.forEach((r, ri) => {
    const i8 = new Int8Array(r.buf), u8 = new Uint8Array(r.buf), wear = r.wear ?? 1
    looks[ri]!.forEach((k, t) => {
      if (k < 0) return
      for (let j = 0; j < 3; j++, at++) {
        const o = (r.first + t * 3 + j) * r.stride
        i8[o + 15] = finishByte15(result.curvature[at]! * wear, k)
        u8[o + 19] = finishByte19(1 - (1 - result.ao[at]!) * wear, result.exposure[at]!)
      }
    })
  })
  return result
}
