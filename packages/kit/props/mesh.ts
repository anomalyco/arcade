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
  const vertCount = p.length / 3
  const smooth = indices.length > 12 && vertCount > 4
  let smoothAo: Float32Array | null = null
  let smoothCol: Float32Array | null = null
  let smoothNorm: Float32Array | null = null

  if (smooth) {
    // 1. Weld split UV/crease vertices that share the same 3D coordinate (2 mm grid) so Cycles corner-bake seams
    //    (where one corner baked ao = 0 inside a folded micro-crevice and the adjacent corner at the exact same point
    //    baked ao = 255) cannot create a 28:1 luminance step across a sub-pixel triangle edge.
    const bucketMap = new Map<number, number>()
    const vertToWeld = new Int32Array(vertCount)
    const groupHead = new Int32Array(vertCount).fill(-1)
    const groupNext = new Int32Array(vertCount).fill(-1)
    let weldCount = 0
    for (let vIdx = 0; vIdx < vertCount; vIdx++) {
      const kx = (Math.round(p[vIdx * 3]! * 500) + 512) & 0x3ff
      const ky = (Math.round(p[vIdx * 3 + 1]! * 500) + 512) & 0x3ff
      const kz = (Math.round(p[vIdx * 3 + 2]! * 500) + 512) & 0x3ff
      const key = (kx << 20) | (ky << 10) | kz
      let wIdx = bucketMap.get(key)
      if (wIdx === undefined) {
        wIdx = weldCount++
        bucketMap.set(key, wIdx)
      }
      groupNext[vIdx] = groupHead[wIdx]!
      groupHead[wIdx] = vIdx
      vertToWeld[vIdx] = wIdx
    }

    let wAo = new Float32Array(weldCount)
    const col0 = new Float32Array(vertCount * 3)
    smoothNorm = new Float32Array(vertCount * 3)

    for (let wIdx = 0; wIdx < weldCount; wIdx++) {
      let maxA = 0
      let sumA = 0
      let gLen = 0
      for (let idx = groupHead[wIdx]!; idx !== -1; idx = groupNext[idx]!) {
        const aVal = ao[idx]! / 255
        if (aVal > maxA) maxA = aVal
        sumA += aVal
        gLen++
      }
      // Weight toward the open corner at split seams so pinched inner remesh corners do not blacken visible faces.
      wAo[wIdx] = Math.max(0.45, 0.68 * maxA + 0.32 * (sumA / gLen))

      for (let idx = groupHead[wIdx]!; idx !== -1; idx = groupNext[idx]!) {
        const r0 = c[idx * 3]! / 255
        const g0 = c[idx * 3 + 1]! / 255
        const b0 = c[idx * 3 + 2]! / 255
        const nx0 = n[idx * 3]!
        const ny0 = n[idx * 3 + 1]!
        const nz0 = n[idx * 3 + 2]!
        let sr = r0
        let sg = g0
        let sb = b0
        let cw = 1
        let sx = nx0
        let sy = ny0
        let sz = nz0
        for (let oIdx = groupHead[wIdx]!; oIdx !== -1; oIdx = groupNext[oIdx]!) {
          if (oIdx === idx) continue
          const r1 = c[oIdx * 3]! / 255
          const g1 = c[oIdx * 3 + 1]! / 255
          const b1 = c[oIdx * 3 + 2]! / 255
          const dc2 = (r0 - r1) * (r0 - r1) + (g0 - g1) * (g0 - g1) + (b0 - b1) * (b0 - b1)
          if (dc2 < 0.09) {
            sr += r1
            sg += g1
            sb += b1
            cw += 1
          }
          const nx1 = n[oIdx * 3]!
          const ny1 = n[oIdx * 3 + 1]!
          const nz1 = n[oIdx * 3 + 2]!
          if (nx0 * nx1 + ny0 * ny1 + nz0 * nz1 > 0.30) {
            sx += nx1
            sy += ny1
            sz += nz1
          }
        }
        col0[idx * 3] = sr / cw
        col0[idx * 3 + 1] = sg / cw
        col0[idx * 3 + 2] = sb / cw
        const invLen = 1 / (Math.hypot(sx, sy, sz) || 1)
        smoothNorm[idx * 3] = sx * invLen
        smoothNorm[idx * 3 + 1] = sy * invLen
        smoothNorm[idx * 3 + 2] = sz * invLen
      }
    }

    // 2. Topological 1-ring smoothing on the welded position graph so AO and surface colour are C0-continuous
    //    across UV/crease seams and band-limited against sub-pixel (4-10 cm) triangle rasterization.
    const smoothColor = indices.length <= 12000
    const passes = smoothColor ? 2 : 1
    const wSumAo = new Float32Array(weldCount)
    const wDeg = new Uint16Array(weldCount)
    const vSumCol = smoothColor ? new Float32Array(vertCount * 3) : null
    const vWeight = smoothColor ? new Float32Array(vertCount) : null
    let curCol = col0
    for (let pass = 0; pass < passes; pass++) {
      wSumAo.fill(0)
      wDeg.fill(0)
      if (vSumCol && vWeight) {
        vSumCol.set(curCol)
        vWeight.fill(1)
      }
      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t]!
        const i1 = indices[t + 1]!
        const i2 = indices[t + 2]!
        const w0 = vertToWeld[i0]!
        const w1 = vertToWeld[i1]!
        const w2 = vertToWeld[i2]!
        const a0 = wAo[w0]!
        const a1 = wAo[w1]!
        const a2 = wAo[w2]!
        wSumAo[w0]! += a1 + a2
        wSumAo[w1]! += a0 + a2
        wSumAo[w2]! += a0 + a1
        wDeg[w0]! += 2
        wDeg[w1]! += 2
        wDeg[w2]! += 2

        if (vSumCol && vWeight) {
          const pairCol = (u: number, v: number) => {
            const ru = curCol[u * 3]!, gu = curCol[u * 3 + 1]!, bu = curCol[u * 3 + 2]!
            const rv = curCol[v * 3]!, gv = curCol[v * 3 + 1]!, bv = curCol[v * 3 + 2]!
            const dc2 = (ru - rv) * (ru - rv) + (gu - gv) * (gu - gv) + (bu - bv) * (bu - bv)
            const w = dc2 < 0.09 ? 1.7 : 0.24
            vSumCol[u * 3]! += rv * w
            vSumCol[u * 3 + 1]! += gv * w
            vSumCol[u * 3 + 2]! += bv * w
            vWeight[u]! += w
            vSumCol[v * 3]! += ru * w
            vSumCol[v * 3 + 1]! += gu * w
            vSumCol[v * 3 + 2]! += bu * w
            vWeight[v]! += w
          }
          pairCol(i0, i1)
          pairCol(i1, i2)
          pairCol(i2, i0)
        }
      }
      const nextWAo = new Float32Array(weldCount)
      for (let wIdx = 0; wIdx < weldCount; wIdx++) {
        const deg = wDeg[wIdx]!
        nextWAo[wIdx] = deg === 0 ? wAo[wIdx]! : 0.40 * wAo[wIdx]! + 0.60 * (wSumAo[wIdx]! / deg)
      }
      wAo = nextWAo

      if (vSumCol && vWeight) {
        const nextCol = new Float32Array(vertCount * 3)
        for (let vIdx = 0; vIdx < vertCount; vIdx++) {
          const invW = 1 / vWeight[vIdx]!
          nextCol[vIdx * 3] = vSumCol[vIdx * 3]! * invW
          nextCol[vIdx * 3 + 1] = vSumCol[vIdx * 3 + 1]! * invW
          nextCol[vIdx * 3 + 2] = vSumCol[vIdx * 3 + 2]! * invW
        }
        curCol = nextCol
      }
    }
    smoothAo = new Float32Array(vertCount)
    for (let wIdx = 0; wIdx < weldCount; wIdx++) {
      const occLin = Math.max(0, 1 - look.ao * (1 - wAo[wIdx]!))
      wAo[wIdx] = Math.pow(occLin, 1 / 2.2)
    }
    for (let vIdx = 0; vIdx < vertCount; vIdx++) {
      const occ = wAo[vertToWeld[vIdx]!]!
      const r0 = curCol[vIdx * 3]!
      const g0 = curCol[vIdx * 3 + 1]!
      const b0 = curCol[vIdx * 3 + 2]!
      const y = r0 * 0.299 + g0 * 0.587 + b0 * 0.114
      curCol[vIdx * 3] = Math.max(0, (y + (r0 - y) * look.saturation) * look.brightness * occ)
      curCol[vIdx * 3 + 1] = Math.max(0, (y + (g0 - y) * look.saturation) * look.brightness * occ)
      curCol[vIdx * 3 + 2] = Math.max(0, (y + (b0 - y) * look.saturation) * look.brightness * occ)
    }
    smoothCol = curCol
  }

  const mesh = new Mesh()
  const v = mesh.v
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t]!
    const i1 = indices[t + 1]!
    const i2 = indices[t + 2]!
    const lamp = glow !== undefined && Math.min(p[i0 * 3 + 1]!, p[i1 * 3 + 1]!, p[i2 * 3 + 1]!) >= glow.from
    // On full meshes, require all three corners to be MAT.shiny so isolated vertices don't flip flat-interpolated triangles.
    const triShiny = smooth && mats[i0] === MAT.shiny && mats[i1] === MAT.shiny && mats[i2] === MAT.shiny
    for (let i = t; i < t + 3; i++) {
      const k = indices[i]!
      const k3 = k * 3
      let r: number, g: number, b: number
      if (smoothCol) {
        r = smoothCol[k3]!
        g = smoothCol[k3 + 1]!
        b = smoothCol[k3 + 2]!
      } else {
        const occ = Math.max(0, 1 - look.ao * (1 - ao[k]! / 255))
        const r0 = c[k3]! / 255
        const g0 = c[k3 + 1]! / 255
        const b0 = c[k3 + 2]! / 255
        const y = r0 * 0.299 + g0 * 0.587 + b0 * 0.114
        r = Math.max(0, (y + (r0 - y) * look.saturation) * look.brightness * occ)
        g = Math.max(0, (y + (g0 - y) * look.saturation) * look.brightness * occ)
        b = Math.max(0, (y + (b0 - y) * look.saturation) * look.brightness * occ)
      }
      const nx = smoothNorm ? smoothNorm[k3]! : n[k3]!
      const ny = smoothNorm ? smoothNorm[k3 + 1]! : n[k3 + 1]!
      const nz = smoothNorm ? smoothNorm[k3 + 2]! : n[k3 + 2]!
      // Lit or shiny only: other ids are actor, hero or emissive paths with their own colour rules.
      const mat: Mat = lamp ? MAT.lamp : (smooth ? triShiny : mats[k] === MAT.shiny) ? MAT.shiny : MAT.lit
      v.push(p[k3]!, p[k3 + 1]!, p[k3 + 2]!, nx, ny, nz, r, g, b, mat, lamp ? glow.aux : 0)
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
