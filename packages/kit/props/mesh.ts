import { hex, MAT, Mesh, type Mat } from "../gpu/mesh"
import { propSpec } from "./catalogue"
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

/** Lamp faces: triangles whose lowest corner is at or above `from` metres draw as `MAT.lamp` tied to map light `aux`. */
export type PropGlow = { from: number; aux: number }

/** Expands one LOD into the kit's non-indexed vertex list (24-byte packed on upload), ready for `Renderer.addModel`. */
export function propMesh(lod: PropLod, look: PropLook = DEFAULT_PROP_LOOK, glow?: PropGlow): Mesh {
  const { positions: p, normals: n, colors: c, ao, mats, indices } = lod
  const mesh = new Mesh()
  const v = mesh.v
  for (let t = 0; t < indices.length; t += 3) {
    const lamp = glow !== undefined && Math.min(p[indices[t]! * 3 + 1]!, p[indices[t + 1]! * 3 + 1]!, p[indices[t + 2]! * 3 + 1]!) >= glow.from
    for (let i = t; i < t + 3; i++) {
      const k = indices[i]!
      const occ = 1 - look.ao * (1 - ao[k]! / 255)
      let r = c[k * 3]! / 255, g = c[k * 3 + 1]! / 255, b = c[k * 3 + 2]! / 255
      const y = r * 0.299 + g * 0.587 + b * 0.114
      r = (y + (r - y) * look.saturation) * look.brightness * occ
      g = (y + (g - y) * look.saturation) * look.brightness * occ
      b = (y + (b - y) * look.saturation) * look.brightness * occ
      // Lit or shiny only: other ids are actor, hero or emissive paths with their own colour rules.
      const mat: Mat = lamp ? MAT.lamp : mats[k] === MAT.shiny ? MAT.shiny : MAT.lit
      v.push(p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!, n[k * 3]!, n[k * 3 + 1]!, n[k * 3 + 2]!, r, g, b, mat, lamp ? glow.aux : 0)
    }
  }
  return mesh
}

/** Box-furniture placeholder matching a catalogue prop's footprint and height while its `.prop` mesh loads or if it fails. */
export function propBoxMesh(id: string): Mesh {
  const [w, h, d] = propSpec(id).size
  const mesh = new Mesh()
  mesh.bevelBox(-w / 2, 0, -d / 2, w / 2, Math.max(0.12, h), d / 2, Math.min(0.03, w * 0.05, d * 0.05), hex(0x5c4026), hex(0x6e4e30), MAT.timber, MAT.timber)
  return mesh
}
