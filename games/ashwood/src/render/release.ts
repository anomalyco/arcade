import type * as THREE from "three/webgpu"
import type { WorldContext } from "../world/context"
import { renderState } from "./shared"

// Frees the CPU copy of static geometry once the GPU has it. The interior's merged meshes are non-indexed and large
// (storey 3's painted surfaces alone are 1.5 M vertices × five attributes): ~630 MB of Float32Arrays that nothing
// reads after the upload (colliders are boxes, bounds are computed at flush, nothing raycasts them). Each attribute's
// array is swapped for an empty one after the renderer has created its GPU buffer; `count` stays, so draws are
// unchanged. Geometry whose meshes are never drawn keeps its arrays.
//
// Only in the game (no query string) or with `?releaseGeometry`: debug automation (hygiene, overlap and walk checks)
// reads interior vertex data after boot.

type Pending = { geo: THREE.BufferGeometry; attrs: THREE.BufferAttribute[] }
const pending = new Set<Pending>()
const EMPTY = new Float32Array(0)
let installed = false
let frame = 0

export function releaseAfterUpload(ctx: WorldContext, geo: THREE.BufferGeometry) {
  const p = ctx.params
  if (!(p.has("releaseGeometry") || [...p.keys()].length === 0)) return
  const attrs = Object.values(geo.attributes) as THREE.BufferAttribute[]
  if (geo.index) attrs.push(geo.index)
  pending.add({ geo, attrs })
  if (installed) return
  installed = true
  const backend = ctx.renderer.backend as unknown as { get(o: object): { buffer?: unknown } }
  renderState.beforeRender.push(() => {
    // A slice of the list now and then: uploads happen when a mesh is first drawn (or warmed), not every frame.
    if (++frame % 30 !== 0 || pending.size === 0) return
    for (const q of pending) {
      if (!q.attrs.every((a) => backend.get(a).buffer !== undefined)) continue
      for (const a of q.attrs) (a as { array: ArrayLike<number> }).array = EMPTY
      pending.delete(q)
    }
  })
}
