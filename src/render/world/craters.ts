// Persistent terrain damage: craters drawn directly in the terrain shader (so they conform exactly
// to the ground), plus flattened/burnt trees around them. Visual only — physics is unchanged.
import { Color, Matrix4, Quaternion, Vector3, Vector4, type InstancedMesh } from "three"
import type { MeshStandardNodeMaterial } from "three/webgpu"
import {
  Fn, Loop, float, length, max, min, mix, positionWorld, smoothstep, uniform, uniformArray, vec3, vertexColor,
} from "three/tsl"
import type { Crater } from "../../sim/protocol"
import { vnoise, type N } from "./atmosphere"

export const MAX_CRATERS = 64

export function createCraters(terrain: MeshStandardNodeMaterial) {
  const list = uniformArray(Array.from({ length: MAX_CRATERS }, () => new Vector4(1e7, 1e7, 1, 0)), "vec4")
  const count = uniform(0)
  const char = new Color("#090807"), burnt = new Color("#2b2925"), rim = new Color("#6a645a")

  // Per fragment: strongest crater influence (0 outside) and rim mask.
  const influence = Fn(() => {
    const burn = float(0).toVar()
    const ring = float(0).toVar()
    const p: N = positionWorld.xz
    Loop(MAX_CRATERS, ({ i }: { i: N }) => {
      const c: N = list.element(i)
      const d: N = length(p.sub(c.xy)).div(c.z)
      const wob: N = vnoise(p.mul(0.15)).mul(0.25)
      const dd: N = d.add(wob.sub(0.12))
      burn.assign(max(burn, smoothstep(1.7, 0.6, dd).mul(c.w)))
      ring.assign(max(ring, smoothstep(0.18, 0.0, dd.sub(0.95).abs()).mul(c.w)))
    })
    return vec3(burn, ring, 0)
  })()
  const inf: N = influence
  const core: N = smoothstep(0.55, 0.85, inf.x)
  const base: N = vertexColor().rgb
  // Ash-grey scorched apron (reads lighter than the dark wet jungle), black blast core, pale ejecta rim.
  let col: N = mix(base, vec3(burnt.r, burnt.g, burnt.b), inf.x)
  col = mix(col, vec3(char.r, char.g, char.b), core)
  col = mix(col, vec3(rim.r, rim.g, rim.b), inf.y.mul(0.8))
  // colorNode now carries the vertex colour itself (avoid multiplying it in twice).
  terrain.vertexColors = false
  terrain.colorNode = col
  // Rain-wet burnt ground: glossier.
  terrain.roughnessNode = mix(float(0.5), float(0.22), min(inf.x, 1))
  terrain.needsUpdate = true

  const craters: Crater[] = []
  const keys = new Set<string>()
  let head = 0
  const trees = new Set<InstancedMesh>()

  /** Flatten/blacken trees near craters for one instanced tree mesh (call when trees are (re)built). */
  const m = new Matrix4(), p = new Vector3(), q = new Quaternion(), s = new Vector3(), dark = new Color(0.12, 0.1, 0.08)
  function scorchTrees(mesh: InstancedMesh, only?: Crater[]) {
    const use = only ?? craters
    if (!use.length) return
    const ox = mesh.position.x, oz = mesh.position.z
    let changed = false
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m)
      m.decompose(p, q, s)
      if (s.y < 1e-3) continue
      const x = p.x + ox, z = p.z + oz
      for (const c of use) {
        const d = Math.hypot(x - c.position[0], z - c.position[2]) / c.radius
        if (d > 1.9) continue
        if (d < 1.0) s.set(0, 0, 0) // vaporised
        else {
          // Snapped and charred: short, tilted away from the blast.
          s.y *= 0.3
          const ang = Math.atan2(z - c.position[2], x - c.position[0])
          q.setFromAxisAngle(new Vector3(-Math.sin(ang), 0, Math.cos(ang)), 0.9)
          if (!mesh.instanceColor) for (let k = 0; k < mesh.count; k++) mesh.setColorAt(k, new Color(1, 1, 1))
          mesh.setColorAt(i, dark)
        }
        m.compose(p, q, s)
        mesh.setMatrixAt(i, m)
        changed = true
        break
      }
    }
    if (changed) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  return {
    /** Add craters (deduplicated); the oldest are recycled beyond MAX_CRATERS. */
    add(listIn: readonly Crater[] | undefined) {
      if (!listIn?.length) return
      const fresh: Crater[] = []
      for (const c of listIn) {
        const key = `${Math.round(c.position[0])},${Math.round(c.position[2])},${Math.round(c.radius)}`
        if (keys.has(key)) continue
        keys.add(key)
        const v = list.array[head] as Vector4
        v.set(c.position[0], c.position[2], Math.max(3, c.radius), 1)
        head = (head + 1) % MAX_CRATERS
        craters.push(c)
        if (craters.length > MAX_CRATERS) craters.shift()
        fresh.push(c)
      }
      count.value = Math.min(MAX_CRATERS, craters.length)
      for (const t of trees) scorchTrees(t, fresh)
    },
    /** Register a tree InstancedMesh (applies existing craters now). */
    trackTrees(mesh: InstancedMesh) { trees.add(mesh); scorchTrees(mesh) },
    untrackTrees(mesh: InstancedMesh) { trees.delete(mesh) },
    get count() { return craters.length },
  }
}
