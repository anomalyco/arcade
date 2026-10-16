import * as THREE from "three/webgpu"
import { abs, float, max, positionLocal, step, uniform, vec3 } from "three/tsl"
import type { WorldContext, WorldModule } from "./context"
import {
  DITCH,
  SHOULDER,
  compoundDistance,
  ditchAt,
  heightAt,
  microAt,
  roadEdgeDistance,
  smoothstep,
} from "./height"
import { WORLD_HALF } from "./layout"
import { groundMaterial } from "./terrain/surface"

// Ground: a static coarse mesh over the whole world plus a dense patch that follows the player. The patch is rebuilt
// on the CPU from `heightAt` a few rows per frame whenever the player has moved far enough, then swapped in, so the
// ground under your feet shows the ditches, hummocks and road banks at 0.5 m while the far mesh stays cheap. The far
// mesh sinks out of sight under the patch in its vertex shader.

const FAR_SEGMENTS = 320
const NEAR_SPACING = 0.5
const NEAR_HALF = 64
const NEAR_N = Math.round((NEAR_HALF * 2) / NEAR_SPACING) + 1
/** Recentre the near patch once the camera is this far (metres, per axis) from its centre. */
const RECENTER = 10
/** Rows of the next patch built per frame. */
const ROWS_PER_FRAME = 48

function surfaceWeights(x: number, z: number, road: number, comp: number, out: Float32Array, o: number) {
  const n = microAt(x * 0.37 + 11, z * 0.37 - 7) * 6
  const dirt = Math.max(1 - smoothstep(SHOULDER - 0.3, SHOULDER + 0.9 + n * 0.3, road), ditchAt(road, comp) / -DITCH.depth * 0.45)
  let grass = smoothstep(SHOULDER - 0.2, SHOULDER + 1.2, road) * (1 - smoothstep(5.5 + n, 9.5 + n * 1.5, road))
  grass = Math.max(grass, 1 - smoothstep(1 + n * 0.5, 7 + n, comp))
  out[o] = grass
  out[o + 1] = dirt
}

function buildFar(ground: THREE.Material, center: { value: THREE.Vector2; x: any; y: any }) {
  const n = FAR_SEGMENTS + 1
  const size = WORLD_HALF * 2
  const pos = new Float32Array(n * n * 3)
  const uv = new Float32Array(n * n * 2)
  const surface = new Float32Array(n * n * 2)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      const x = -WORLD_HALF + (i / FAR_SEGMENTS) * size
      const z = -WORLD_HALF + (j / FAR_SEGMENTS) * size
      pos[k * 3] = x
      pos[k * 3 + 1] = heightAt(x, z)
      pos[k * 3 + 2] = z
      uv[k * 2] = x
      uv[k * 2 + 1] = -z
      surfaceWeights(x, z, roadEdgeDistance(x, z), compoundDistance(x, z), surface, k * 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
  geo.setAttribute("surface", new THREE.BufferAttribute(surface, 2))
  geo.setIndex(gridIndex(n))
  geo.computeVertexNormals()
  const mat = (ground as THREE.MeshStandardNodeMaterial).clone()
  // Sink the far mesh well inside the near patch (two far cells clear of its edge) so the patch alone shows there.
  const cell = size / FAR_SEGMENTS
  const inner = NEAR_HALF - RECENTER - cell * 2.5
  const d = max(abs(positionLocal.x.sub(center.x)), abs(positionLocal.z.sub(center.y)))
  mat.positionNode = positionLocal.sub(vec3(0, step(d, float(inner)).mul(3), 0))
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = "terrain-far"
  mesh.receiveShadow = true
  mesh.renderOrder = 2
  return mesh
}

function gridIndex(n: number) {
  const idx = new Uint32Array((n - 1) * (n - 1) * 6)
  let o = 0
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      const b = a + 1
      const c = a + n
      const d = c + 1
      // Alternate the diagonal so slopes don't show a uniform grain.
      if ((i + j) & 1) {
        idx[o++] = a; idx[o++] = c; idx[o++] = b
        idx[o++] = b; idx[o++] = c; idx[o++] = d
      } else {
        idx[o++] = a; idx[o++] = c; idx[o++] = d
        idx[o++] = a; idx[o++] = d; idx[o++] = b
      }
    }
  }
  return new THREE.BufferAttribute(idx, 1)
}

type Patch = { mesh: THREE.Mesh; geo: THREE.BufferGeometry; cx: number; cz: number }

function makePatch(mat: THREE.Material, index: THREE.BufferAttribute): Patch {
  const count = NEAR_N * NEAR_N
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2))
  geo.setAttribute("surface", new THREE.BufferAttribute(new Float32Array(count * 2), 2))
  geo.setIndex(index)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = "terrain-near"
  mesh.receiveShadow = true
  // Ground is drawn after the trees (renderOrder -1) so the expensive floor shader skips pixels they cover, and the
  // near patch before the far mesh so the far mesh's sunken triangles fail the depth test.
  mesh.renderOrder = 1
  mesh.frustumCulled = false
  mesh.visible = false
  return { mesh, geo, cx: 0, cz: 0 }
}

/** Fills `patch` centred on (cx, cz), yielding every few rows so the work spreads over frames. */
function* fillPatch(patch: Patch, cx: number, cz: number, heights: Float32Array) {
  const P = NEAR_N + 2
  const x0 = cx - NEAR_HALF
  const z0 = cz - NEAR_HALF
  // Heights on a one-cell border too, so edge normals are right.
  for (let j = 0; j < P; j++) {
    const z = z0 + (j - 1) * NEAR_SPACING
    for (let i = 0; i < P; i++) heights[j * P + i] = heightAt(x0 + (i - 1) * NEAR_SPACING, z)
    if (j % ROWS_PER_FRAME === ROWS_PER_FRAME - 1) yield
  }
  const pos = patch.geo.attributes.position!.array as Float32Array
  const nor = patch.geo.attributes.normal!.array as Float32Array
  const uv = patch.geo.attributes.uv!.array as Float32Array
  const surf = patch.geo.attributes.surface!.array as Float32Array
  const inv = 1 / (2 * NEAR_SPACING)
  for (let j = 0; j < NEAR_N; j++) {
    const z = z0 + j * NEAR_SPACING
    for (let i = 0; i < NEAR_N; i++) {
      const x = x0 + i * NEAR_SPACING
      const k = j * NEAR_N + i
      const h = (j + 1) * P + i + 1
      pos[k * 3] = x
      pos[k * 3 + 1] = heights[h]!
      pos[k * 3 + 2] = z
      const dx = (heights[h + 1]! - heights[h - 1]!) * inv
      const dz = (heights[h + P]! - heights[h - P]!) * inv
      const l = 1 / Math.sqrt(dx * dx + 1 + dz * dz)
      nor[k * 3] = -dx * l
      nor[k * 3 + 1] = l
      nor[k * 3 + 2] = -dz * l
      uv[k * 2] = x
      uv[k * 2 + 1] = -z
      surfaceWeights(x, z, roadEdgeDistance(x, z), compoundDistance(x, z), surf, k * 2)
    }
    if (j % ROWS_PER_FRAME === ROWS_PER_FRAME - 1) yield
  }
  for (const a of Object.values(patch.geo.attributes)) a.needsUpdate = true
  patch.cx = cx
  patch.cz = cz
}

export function build(ctx: WorldContext): WorldModule | void {
  const ground = groundMaterial()
  const center = uniform(new THREE.Vector2(1e6, 1e6)) as unknown as { value: THREE.Vector2; x: any; y: any }
  if (!ctx.params.has("tnofar")) ctx.scene.add(buildFar(ground, center))

  const index = gridIndex(NEAR_N)
  const patches = [makePatch(ground, index), makePatch(ground, index)]
  for (const p of patches) ctx.scene.add(p.mesh)
  const heights = new Float32Array((NEAR_N + 2) * (NEAR_N + 2))
  let front = -1
  let job: Generator<undefined, void> | null = null
  let jobTarget: [number, number] = [0, 0]

  const snap = (v: number) => Math.round(v / (NEAR_SPACING * 2)) * NEAR_SPACING * 2
  const start = (x: number, z: number) => {
    jobTarget = [snap(x), snap(z)]
    job = fillPatch(patches[front === 0 ? 1 : 0]!, jobTarget[0], jobTarget[1], heights)
  }
  const swap = () => {
    const back = front === 0 ? 1 : 0
    if (front >= 0) patches[front]!.mesh.visible = false
    patches[back]!.mesh.visible = !ctx.params.has("tnonear")
    front = back
    center.value.set(patches[back]!.cx, patches[back]!.cz)
  }

  // First patch synchronously at the starting camera so the opening frame is complete.
  const cam = ctx.camera.position
  start(cam.x, cam.z)
  while (!job!.next().done);
  job = null
  swap()

  return {
    update(_dt, _time, camera) {
      const p = camera.position
      if (job) {
        if (job.next().done) {
          job = null
          swap()
        }
        return
      }
      const f = patches[front]!
      if (Math.abs(p.x - f.cx) > RECENTER || Math.abs(p.z - f.cz) > RECENTER) {
        start(p.x, p.z)
        // A big jump (viewpoint teleport): finish now rather than show the far mesh for several frames.
        if (Math.abs(p.x - f.cx) > NEAR_HALF * 0.6 || Math.abs(p.z - f.cz) > NEAR_HALF * 0.6) {
          while (!job!.next().done);
          job = null
          swap()
        }
      }
    },
  }
}
