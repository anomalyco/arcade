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
  mesh.finishBytes = finishBytes(bake, lookIndex(opts.look), opts.wear ?? 1)
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
 * One range of packed vertices (`stride` 24 or 32), the look (and wear) it gets, and any curvature its builder already
 * knows (NaN = bake). A look of null leaves the range unfinished but lets it occlude the others.
 */
export type FinishRange = { buf: ArrayBuffer; stride: number; first: number; count: number; look: FinishLookId | null; wear?: number; hints?: ArrayLike<number> }

/**
 * Finishes ranges of packed vertices in place. Every range's triangles occlude every other's, so a porch roof shades
 * the deck under it even when they live in different buffers.
 */
export function finishPacked(ranges: readonly FinishRange[], bake: FinishBakeOptions = {}): FinishBake {
  const looked = ranges.filter(r => r.look !== null), blockers = ranges.filter(r => r.look === null)
  const total = looked.reduce((s, r) => s + r.count, 0)
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), hints = new Float32Array(total).fill(NaN)
  let at = 0
  for (const r of looked) {
    const p = readPacked(r.buf, r.stride, r.first, r.count)
    pos.set(p.pos, at * 3); nrm.set(p.nrm, at * 3)
    if (r.hints) for (let i = 0; i < r.count; i++) hints[at + i] = r.hints[i] ?? NaN
    at += r.count
  }
  // Unfinished ranges only occlude: their own vertices are never baked.
  const extra = bake.occluders ? Array.from(bake.occluders) : []
  for (const r of blockers) for (const v of readPacked(r.buf, r.stride, r.first, r.count - (r.count % 3)).pos) extra.push(v)
  const result = bakeFinish(pos, nrm, { ...bake, occluders: extra, curvatureHints: hints })
  at = 0
  for (const r of looked) {
    const i8 = new Int8Array(r.buf), u8 = new Uint8Array(r.buf)
    const look = lookIndex(r.look!), wear = r.wear ?? 1
    for (let i = 0; i < r.count; i++, at++) {
      const o = (r.first + i) * r.stride
      i8[o + 15] = finishByte15(result.curvature[at]! * wear, look)
      u8[o + 19] = finishByte19(1 - (1 - result.ao[at]!) * wear, result.exposure[at]!)
    }
  }
  return result
}
