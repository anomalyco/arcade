import { MAT, Mesh, type Mat } from "../gpu/mesh"
import type { PropLod } from "./format"

/** How a prop's baked data turns into vertex colours. Live Lab knobs; changing them rebuilds the models. */
export type PropLook = {
  /** Multiplier on the generated base colour (the model's albedo is darker than the photo it came from). */
  brightness: number
  /** 0 ignores the baked ambient occlusion, 1 applies it fully. */
  ao: number
  /** 0 grey, 1 as generated. */
  saturation: number
}

export const DEFAULT_PROP_LOOK: PropLook = { brightness: 1.6, ao: 0.55, saturation: 1 }

const KNOWN_MATS = new Set<number>(Object.values(MAT))

/** Expands one LOD into the kit's non-indexed vertex list (24-byte packed on upload), ready for `Renderer.addModel`. */
export function propMesh(lod: PropLod, look: PropLook = DEFAULT_PROP_LOOK, mesh = new Mesh()): Mesh {
  const { positions: p, normals: n, colors: c, ao, mats, indices } = lod
  const v = mesh.v
  for (let i = 0; i < indices.length; i++) {
    const k = indices[i]!
    const occ = 1 - look.ao * (1 - ao[k]! / 255)
    let r = c[k * 3]! / 255, g = c[k * 3 + 1]! / 255, b = c[k * 3 + 2]! / 255
    const y = r * 0.299 + g * 0.587 + b * 0.114
    r = (y + (r - y) * look.saturation) * look.brightness * occ
    g = (y + (g - y) * look.saturation) * look.brightness * occ
    b = (y + (b - y) * look.saturation) * look.brightness * occ
    const m = mats[k]!
    v.push(p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!, n[k * 3]!, n[k * 3 + 1]!, n[k * 3 + 2]!, r, g, b, (KNOWN_MATS.has(m) ? m : MAT.lit) as Mat, 0)
  }
  return mesh
}
