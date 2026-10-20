import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { heightAt } from "./height"
import { LOGGING_ROAD, loggingRoadSamples } from "./layout"
import { material } from "../render/materials"

// The dirt logging road on from the north track's turnaround, ~300 m north through the pines (layout LOGGING_ROAD):
// two wheel ruts of packed dirt with a grassy-dirt crown between them, the forest floor ragged into its edges, draped on
// the terrain (the terrain smooths its bed; the forest keeps it clear, both through `northTrackDistance`). The escape
// truck drives it (src/game/escape). Static: two merged ribbons, no per-frame work.

export function build(ctx: WorldContext): WorldModule | void {
  const root = new THREE.Group()
  root.name = "logging-road"
  const pts = loggingRoadSamples(0.6)
  const half = LOGGING_ROAD.width / 2
  // Verge: forest floor scraped to dirt, wide and ragged; then the bed (dirt) a few cm higher.
  root.add(mesh(ribbon(pts, half + 0.9, 0.02, 7, 0.45), material("dirt")))
  root.add(mesh(ribbon(pts, half, 0.04, 11, 0.2, true), material("dirt")))
  root.updateMatrixWorld(true)
  root.traverse((o) => (o.matrixAutoUpdate = false))
  ctx.scene.add(root)
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material) {
  const o = new THREE.Mesh(g, m)
  o.castShadow = false
  o.receiveShadow = true
  o.name = "logging-road"
  return o
}

/**
 * A ribbon `half` m either side of the centre line, `lift` m above the terrain, ragged edges (`rag` m) and, for the bed,
 * two shallow wheel ruts. The first ~10 m fade in from nothing so it grows out of the north track's turnaround.
 */
function ribbon(pts: readonly (readonly [number, number])[], half: number, lift: number, seed: number, rag: number, ruts = false) {
  const across = 8
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i]!
    const [nx, nz] = pts[Math.min(i + 1, pts.length - 1)]!
    const [px, pz] = pts[Math.max(i - 1, 0)]!
    const tx = nx - px
    const tz = nz - pz
    const tl = Math.hypot(tx, tz) || 1
    const ox = -tz / tl
    const oz = tx / tl
    if (i > 0) s += Math.hypot(x - pts[i - 1]![0], z - pts[i - 1]![1])
    const grow = Math.min(1, 0.25 + s / 12)
    const jl = rag * (0.6 * Math.sin(s * 0.53 + seed) + 0.4 * Math.sin(s * 1.9 + seed * 2))
    const jr = rag * (0.6 * Math.sin(s * 0.47 + seed * 3) + 0.4 * Math.sin(s * 2.3 + seed))
    for (let k = 0; k <= across; k++) {
      const u = -1 + (2 * k) / across
      const w = (u < 0 ? half + jl : half + jr) * u * grow
      const vx = x + ox * w
      const vz = z + oz * w
      // Ruts at ±0.75 m (a truck's track), 4 cm down; the crown between them a touch high; edges tucked in.
      const rut = ruts ? -0.04 * Math.exp(-(((Math.abs(w) - 0.75) / 0.28) ** 2)) : 0
      const crown = (1 - u * u) * 0.025
      pos.push(vx, heightAt(vx, vz) + lift + crown + rut - (Math.abs(u) > 0.99 ? 0.02 : 0), vz)
      uv.push(w, s)
    }
    if (i > 0) {
      const a = (i - 1) * (across + 1)
      const b = i * (across + 1)
      for (let k = 0; k < across; k++) idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  if (g.attributes.normal!.getY(Math.floor(g.attributes.normal!.count / 2)) < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2]!, idx[i + 1]!]
    g.setIndex(idx)
    g.computeVertexNormals()
  }
  return g
}
