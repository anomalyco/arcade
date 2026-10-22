/**
 * Reads a people GLB (scripts/people/build-people.ts) into plain arrays: the skeleton from its inverse bind matrices,
 * and per level of detail one packed skinning source (64 bytes per vertex), one index list and the primitive ranges
 * with their materials. Pure (gltf-transform `Document` in, typed arrays out), so Bun tests can read the real asset.
 */
import type { Document, Material, Primitive, Texture } from "@gltf-transform/core"
import type { V3 } from "../rig"
import { qBasis, type Q } from "./quat"
import type { Skeleton } from "./retarget"

/** Shading kinds, written to the vertex aux channel (`PEOPLE_AUX + kind`) for `personHooks`. */
export const KINDS = ["skin", "cloth", "nylon", "hair", "brow", "eye", "knit"] as const
export type Kind = (typeof KINDS)[number]
export const PEOPLE_AUX = 60

export type PersonMaterial = {
  name: string
  kind: Kind
  /** Outfit piece (`jacket`, `trousers`, `beanie`, `hair`, ...); runtime tints are keyed by it. */
  piece: string
  base: Texture | null
  normal: Texture | null
  color: [number, number, number, number]
  /** Luminance textures average this, so a tint albedo `a` is the factor `a / mean`. 1 for coloured textures. */
  mean: number
  roughness: number
  alphaCutoff: number
}

export type PersonRange = { start: number; count: number; material: number }
export type PersonLod = {
  /** Per vertex 16 floats: position xyz, joints (4×u8 as u32 bits), normal xyz, kind aux, weights xyzw, uv, 0, 0. */
  source: ArrayBuffer
  indices: Uint32Array<ArrayBuffer>
  ranges: PersonRange[]
  vertices: number
  triangles: number
}
export type PersonAsset = { id: string; skeleton: Skeleton; materials: PersonMaterial[]; lods: PersonLod[] }

const SRC_FLOATS = 16

export function readPerson(doc: Document, id = ""): PersonAsset {
  const root = doc.getRoot()
  const skins = root.listSkins()
  const first = skins[0]
  if (!first) throw new Error("person GLB has no skin")
  const jointNodes = first.listJoints()
  const names = jointNodes.map((j) => j.getName())
  const index = new Map(names.map((n, i) => [n, i]))
  const parent = jointNodes.map((j) => { const p = j.getParentNode(); return p ? index.get(p.getName()) ?? -1 : -1 })
  for (let i = 0; i < parent.length; i++) if (parent[i]! >= i) throw new Error("person skeleton joints must be ordered parents first")
  // Bind pose from the joints' node transforms (what a glTF renderer shows at rest). Vertices are baked into that
  // model space below (jointWorld · inverseBind · v), so the runtime inverse binds are just the rigid joint inverses.
  const world = jointNodes.map((j) => j.getWorldMatrix() as number[])
  const ibm = new Float32Array(names.length * 16)
  const bindPos: V3[] = [], bindRot: Q[] = []
  for (let i = 0; i < names.length; i++) {
    const m = world[i]!
    const c = (k: number): V3 => { const v: V3 = [m[k]!, m[k + 1]!, m[k + 2]!]; const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
    const x = c(0), y = c(4), z = c(8)
    bindPos.push([m[12]!, m[13]!, m[14]!])
    bindRot.push(qBasis(x, y, z))
    const rigid = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, m[12]!, m[13]!, m[14]!, 1]
    ibm.set(invertAffine(rigid), i * 16)
  }
  const skeleton: Skeleton = { names, parent, bindPos, bindRot, ibm }

  const materials: PersonMaterial[] = []
  const matIndex = new Map<unknown, number>()
  const material = (m: Material | null) => {
    if (!m) throw new Error("person primitive has no material")
    const known = matIndex.get(m)
    if (known !== undefined) return known
    const extras = (m.getExtras() as { people?: { kind?: string; piece?: string; mean?: number } }).people ?? {}
    const kind = (KINDS as readonly string[]).includes(extras.kind ?? "") ? (extras.kind as Kind) : "cloth"
    materials.push({
      name: m.getName(), kind, piece: extras.piece ?? m.getName(),
      base: m.getBaseColorTexture(), normal: m.getNormalTexture(),
      color: m.getBaseColorFactor() as [number, number, number, number], mean: extras.mean ?? 1,
      roughness: m.getRoughnessFactor(), alphaCutoff: m.getAlphaMode() === "MASK" ? m.getAlphaCutoff() : 0,
    })
    matIndex.set(m, materials.length - 1)
    return materials.length - 1
  }

  const lodPrims: { prim: Primitive; remap: number[]; bake: number[][] }[][] = []
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(), skin = node.getSkin()
    if (!mesh || !skin) continue
    const lod = Number(/^LOD(\d)\./.exec(node.getName())?.[1] ?? 0)
    const remap = skin.listJoints().map((j) => { const i = index.get(j.getName()); if (i === undefined) throw new Error(`unknown joint ${j.getName()}`); return i })
    const acc = skin.getInverseBindMatrices()
    if (!acc) throw new Error(`${node.getName()}: skin has no inverse bind matrices`)
    const bake = skin.listJoints().map((j, k) => mul4(j.getWorldMatrix() as number[], acc.getElement(k, []) as number[]))
    for (const prim of mesh.listPrimitives()) (lodPrims[lod] ??= []).push({ prim, remap, bake })
  }
  const lods: PersonLod[] = []
  for (const prims of lodPrims) {
    if (!prims) continue
    // Opaque first, then alpha-tested (hair, brows), so each draws as one pipeline run.
    prims.sort((a, b) => Number(materials[material(a.prim.getMaterial())]!.alphaCutoff > 0) - Number(materials[material(b.prim.getMaterial())]!.alphaCutoff > 0))
    let vertices = 0, indexCount = 0
    for (const { prim } of prims) { vertices += prim.getAttribute("POSITION")!.getCount(); indexCount += prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION")!.getCount() }
    const source = new ArrayBuffer(vertices * SRC_FLOATS * 4)
    const f = new Float32Array(source), u = new Uint32Array(source)
    const indices = new Uint32Array(indexCount)
    const ranges: PersonRange[] = []
    let vBase = 0, iBase = 0
    const p: number[] = [], nn: number[] = [], t: number[] = [], jj: number[] = [], w: number[] = []
    for (const { prim, remap, bake } of prims) {
      const mi = material(prim.getMaterial())
      const pos = prim.getAttribute("POSITION")!, nor = prim.getAttribute("NORMAL"), uv = prim.getAttribute("TEXCOORD_0")
      const joints = prim.getAttribute("JOINTS_0"), weights = prim.getAttribute("WEIGHTS_0")
      if (!nor || !joints || !weights) throw new Error(`${materials[mi]!.name}: skinned primitives need NORMAL, JOINTS_0 and WEIGHTS_0`)
      const kind = PEOPLE_AUX + KINDS.indexOf(materials[mi]!.kind)
      const count = pos.getCount()
      for (let v = 0; v < count; v++) {
        const o = (vBase + v) * SRC_FLOATS
        pos.getElement(v, p); nor.getElement(v, nn); joints.getElement(v, jj); weights.getElement(v, w)
        if (uv) uv.getElement(v, t); else { t[0] = 0; t[1] = 0 }
        const ws = w[0]! + w[1]! + w[2]! + w[3]! || 1
        let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0
        for (let k = 0; k < 4; k++) {
          const wk = w[k]! / ws
          if (wk <= 0) continue
          const m = bake[jj[k]!]!
          px += wk * (m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!)
          py += wk * (m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!)
          pz += wk * (m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!)
          nx += wk * (m[0]! * nn[0]! + m[4]! * nn[1]! + m[8]! * nn[2]!)
          ny += wk * (m[1]! * nn[0]! + m[5]! * nn[1]! + m[9]! * nn[2]!)
          nz += wk * (m[2]! * nn[0]! + m[6]! * nn[1]! + m[10]! * nn[2]!)
        }
        const nl = Math.hypot(nx, ny, nz) || 1
        p[0] = px; p[1] = py; p[2] = pz; nn[0] = nx / nl; nn[1] = ny / nl; nn[2] = nz / nl
        f[o] = p[0]!; f[o + 1] = p[1]!; f[o + 2] = p[2]!
        u[o + 3] = (remap[jj[0]!]! | (remap[jj[1]!]! << 8) | (remap[jj[2]!]! << 16) | (remap[jj[3]!]! << 24)) >>> 0
        f[o + 4] = nn[0]!; f[o + 5] = nn[1]!; f[o + 6] = nn[2]!; f[o + 7] = kind
        f[o + 8] = w[0]! / ws; f[o + 9] = w[1]! / ws; f[o + 10] = w[2]! / ws; f[o + 11] = w[3]! / ws
        f[o + 12] = t[0]!; f[o + 13] = t[1]!
      }
      const idx = prim.getIndices()
      const n = idx?.getCount() ?? count
      for (let i = 0; i < n; i++) indices[iBase + i] = vBase + (idx ? idx.getScalar(i) : i)
      ranges.push({ start: iBase, count: n, material: mi })
      vBase += count; iBase += n
    }
    lods.push({ source, indices, ranges, vertices, triangles: indexCount / 3 })
  }
  if (!lods.length) throw new Error("person GLB has no skinned meshes")
  return { id, skeleton, materials, lods }
}

function mul4(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const o = new Array<number>(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!
  return o
}

/** Inverse of a column-major affine 4×4 (rotation, uniform or not scale, translation). */
function invertAffine(m: ArrayLike<number>): number[] {
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[4]!, e = m[5]!, f = m[6]!, g = m[8]!, h = m[9]!, k = m[10]!
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  const i = 1 / det
  const out = [
    A * i, -(b * k - c * h) * i, (b * f - c * e) * i, 0,
    B * i, (a * k - c * g) * i, -(a * f - c * d) * i, 0,
    C * i, -(a * h - b * g) * i, (a * e - b * d) * i, 0,
    0, 0, 0, 1,
  ]
  const tx = m[12]!, ty = m[13]!, tz = m[14]!
  out[12] = -(out[0]! * tx + out[4]! * ty + out[8]! * tz)
  out[13] = -(out[1]! * tx + out[5]! * ty + out[9]! * tz)
  out[14] = -(out[2]! * tx + out[6]! * ty + out[10]! * tz)
  return out
}
