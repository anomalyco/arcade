import { addSearchSpot } from "./search-spots"
import * as THREE from "three/webgpu"
import { float, smoothstep, uv } from "three/tsl"
import { MODELS, type ModelInfo, type ModelName, type Placement, loadModel, modelCollider, yawToward } from "../../render/models"
import { decalBias } from "../../render/materials"
import { type Builder, type Mat, FLOOR_Y, M, T } from "./kit"

// Real models for the interior's furniture and props (render/models.ts). Colliders and contact shadows are placed
// synchronously; the models stream in afterwards and join the interior group, so nothing here blocks the first frame.

export type Prop = Placement & { collide?: boolean; inset?: number; blob?: number; /** Extra local tilt (tipped-over props). */ tilt?: THREE.Euler }

/** Soft dark ellipse on the floor under a prop: the ambient-occlusion contact the light rig can't give small props. */
export const blobMat = (() => {
  const m = new THREE.MeshBasicNodeMaterial({ color: 0x000000, transparent: true, depthWrite: false })
  const d = uv().sub(0.5).length().mul(2)
  m.opacityNode = float(1).sub(smoothstep(0.35, 1, d)).mul(0.55)
  decalBias(m, 2) // pulls the decal toward the camera whatever the depth convention (reversed-Z)
  m.name = "interior_contact_blob"
  return m
})()

const tq = new THREE.Quaternion()
const te = new THREE.Euler()

/**
 * Places a model at every prop (local ground-floor coordinates; the builder's storey lifts them), instanced. Colliders
 * and contact shadows go in immediately; the model streams in and joins the builder's group when loaded.
 */
/** Desk-top and bench-top props: never cast shadows, drawn only on the camera's own storey. */
const SMALL = new Set<ModelName>([
  "crt_terminal",
  "telephone",
  "glassware",
  "microscope",
  "chemistry_set",
  "cardboard_box",
  "television",
  "wet_floor_sign",
  "fire_extinguisher",
  "desk_fan",
  "desk_lamp",
  "drinking_fountain",
])
/** Dense models that only read from close up (chairs: ~5–9k triangles each): same visibility as the small props, but
 *  they keep their shadows in open rooms. */
const NEAR_ONLY = new Set<ModelName>(["office_chair", "stack_chair", "lab_stool", "lounge_chair", "coat_rack", "radiator", "water_cooler"])

/** Steel mesh-sided wastebasket profile: tapered body with a rolled rim and a recessed base, lathed at 24 segments. */
const basketGeo = (() => {
  const pts = [
    [0.0, 0.004], [0.112, 0.004], [0.118, 0.012], [0.121, 0.02], [0.14, 0.3], [0.148, 0.304], [0.152, 0.312],
    [0.148, 0.32], [0.139, 0.318], [0.134, 0.3], [0.115, 0.03], [0.0, 0.026],
  ].map(([x, y]) => new THREE.Vector2(x!, y!))
  return new THREE.LatheGeometry(pts, 24)
})()

export function wastebasket(b: Builder, x: number, z: number, mat: Mat = M.darkSteel) {
  b.add(mat, basketGeo.clone().translate(x, FLOOR_Y, z))
  b.collide(x - 0.15, FLOOR_Y, z - 0.15, x + 0.15, FLOOR_Y + 0.32, z + 0.15)
}

export function placeModels(b: Builder, name: ModelName, props: Prop[], opts: { cast?: boolean } = {}) {
  if (b.ctx.interactions) props = props.filter(p => !b.ctx.interactions!.placeModel(b, name, p))
  if (!props.length) return
  const [w, , d] = MODELS[name].size
  const oy = b.oy
  const matrices: THREE.Matrix4[] = []
  const bounds = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }
  for (const p of props) {
    const world = { ...p, position: [p.position[0], p.position[1] + oy, p.position[2]] as const }
    bounds.x0 = Math.min(bounds.x0, p.position[0] - 1)
    bounds.x1 = Math.max(bounds.x1, p.position[0] + 1)
    bounds.z0 = Math.min(bounds.z0, p.position[2] - 1)
    bounds.z1 = Math.max(bounds.z1, p.position[2] + 1)
    if ((p.collide ?? true) && !p.tilt) b.ctx.colliders.push(modelCollider(name, world, p.inset ?? 0.03))
    // Desks and filing cabinets standing on the floor are searchable (src/game/search).
    if ((name === "office_desk" || name === "filing_cabinet") && !p.tilt && Math.abs(p.position[1] - FLOOR_Y) < 0.05)
      addSearchSpot({ id: `${name}@${b.storey}:${p.position[0].toFixed(2)},${p.position[2].toFixed(2)}`, kind: name === "office_desk" ? "desk" : "cabinet", storey: b.storey, at: [p.position[0], world.position[1] + (name === "office_desk" ? 0.55 : 0.9), p.position[2]] })
    // Square-on models are depth obstacles: procedural details placed against them are kept 4.5 mm clear.
    const yq = ((p.yaw ?? 0) / (Math.PI / 2)) % 1
    if (!p.tilt && (Math.abs(yq) < 1e-3 || Math.abs(Math.abs(yq) - 1) < 1e-3)) b.depthObstacles.push(modelCollider(name, world, 0))
    const blob = p.blob ?? (p.position[1] <= FLOOR_Y + 0.01 && !p.tilt ? 1.25 : 0)
    if (blob > 0) {
      const s = typeof p.scale === "number" ? p.scale : 1
      b.quad(blobMat, T(p.position[0], p.position[1] + 0.002, p.position[2], p.yaw ?? 0, -Math.PI / 2), w * s * blob, d * s * blob, { cast: false })
    }
    te.set(p.tilt?.x ?? 0, p.yaw ?? 0, p.tilt?.z ?? 0, "YXZ")
    const s = typeof p.scale === "number" ? p.scale : 1
    matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(...world.position), tq.setFromEuler(te), new THREE.Vector3(s, s, s)))
  }
  const small = SMALL.has(name)
  const nearOnly = small || NEAR_ONLY.has(name)
  let q = queues.get(b)
  if (!q) queues.set(b, (q = []))
  const cast = opts.cast !== false && !small
  q.push({ name, lod: 0, layer: nearOnly ? b.small : b.props, cast, matrices, bounds })
  if ((MODELS[name] as ModelInfo).lod1) q.push({ name, lod: 1, layer: nearOnly ? b.smallLod : b.propsLod, cast: false, matrices, bounds })
}

type Placed = { name: ModelName; lod: 0 | 1; layer: THREE.Group; cast: boolean; matrices: THREE.Matrix4[]; bounds: { x0: number; x1: number; z0: number; z1: number } }
const queues = new Map<Builder, Placed[]>()

/** Raw access to an attribute: array, stride, offset and the normalisation factor (null for exotic layouts). */
function reader(A: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) {
  const il = (A as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
  const a = (il ? (A as THREE.InterleavedBufferAttribute).data.array : (A as THREE.BufferAttribute).array) as ArrayLike<number>
  const st = il ? (A as THREE.InterleavedBufferAttribute).data.stride : A.itemSize
  const of = il ? (A as THREE.InterleavedBufferAttribute).offset : 0
  let k = 1
  if (A.normalized) {
    if (a instanceof Int8Array) k = 1 / 127
    else if (a instanceof Uint8Array) k = 1 / 255
    else if (a instanceof Int16Array) k = 1 / 32767
    else if (a instanceof Uint16Array) k = 1 / 65535
    else return null
    // three clamps signed normalised values at −1; only −128 / −32768 fall below, by 1/32767 of a step at most.
  }
  return { a, st, of, k }
}
const pause = () => new Promise<void>((r) => setTimeout(r))
const tmpV3 = new THREE.Vector3()
const nrm = new THREE.Matrix3()

/**
 * Bakes every model placed on this builder into plain merged meshes: one per (layer, 22.5 m stretch, shadow flag,
 * material). The models share a handful of atlas materials, so a whole storey's furniture is a few draws and no
 * per-group shader builds (an InstancedMesh with a small count compiles its own shader). Runs after the models load,
 * yielding between buckets.
 */
export async function bakeModels(b: Builder) {
  const list = queues.get(b) ?? []
  queues.delete(b)
  if (!list.length) return
  const templates = new Map<string, THREE.Group>()
  await Promise.all(
    [...new Set(list.map((p) => `${p.name}|${p.lod}`))].map(async (k) => {
      const [name, lod] = k.split("|") as [ModelName, string]
      try {
        const g = await loadModel(name, { lod: Number(lod) as 0 | 1 })
        g.updateMatrixWorld(true)
        templates.set(k, g)
      } catch (e) {
        console.error(`interior: model ${name} failed: ${e}`)
      }
    }),
  )
  type Part = { geo: THREE.BufferGeometry; local: THREE.Matrix4; m: THREE.Matrix4 }
  type Bucket = { layer: THREE.Group; cast: boolean; mat: THREE.Material; parts: Part[]; bounds: Placed["bounds"] }
  const buckets = new Map<string, Bucket>()
  for (const p of list) {
    const t = templates.get(`${p.name}|${p.lod}`)
    if (!t) continue
    const chunk = Math.floor(((p.bounds.x0 + p.bounds.x1) / 2 + 55) / 22.5)
    t.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || Array.isArray(mesh.material)) return
      const cast = p.cast && mesh.castShadow
      const key = `${p.layer.uuid}|${chunk}|${cast}|${mesh.material.uuid}`
      let bk = buckets.get(key)
      if (!bk) buckets.set(key, (bk = { layer: p.layer, cast, mat: mesh.material, parts: [], bounds: { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity } }))
      bk.bounds.x0 = Math.min(bk.bounds.x0, p.bounds.x0)
      bk.bounds.x1 = Math.max(bk.bounds.x1, p.bounds.x1)
      bk.bounds.z0 = Math.min(bk.bounds.z0, p.bounds.z0)
      bk.bounds.z1 = Math.max(bk.bounds.z1, p.bounds.z1)
      for (const m of p.matrices) bk.parts.push({ geo: mesh.geometry, local: mesh.matrixWorld, m })
    })
  }
  const full = new THREE.Matrix4()
  const prof = (globalThis as { __interiorProfile?: Record<string, number> }).__interiorProfile
  let t0 = performance.now()
  for (const bk of buckets.values()) {
    if (prof) prof.bake = (prof.bake ?? 0) + performance.now() - t0
    await pause()
    t0 = performance.now()
    // Attribute layout from the first part; parts missing an attribute get zeros.
    const first = bk.parts[0]!.geo
    const names = Object.keys(first.attributes).filter((n) => n !== "position")
    let nv = 0
    let ni = 0
    for (const { geo } of bk.parts) {
      nv += geo.getAttribute("position").count
      ni += geo.index ? geo.index.count : geo.getAttribute("position").count
    }
    const pos = new Float32Array(nv * 3)
    const extra = names.map((n) => ({ n, size: first.getAttribute(n).itemSize, data: new Float32Array(nv * first.getAttribute(n).itemSize) }))
    const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni)
    let vo = 0
    let io = 0
    for (const { geo, local, m } of bk.parts) {
      full.multiplyMatrices(m, local)
      nrm.getNormalMatrix(full)
      const P = geo.getAttribute("position")
      const n = P.count
      // Feet, glides and base plates thinner than 3.5 mm would z-fight with the floor they stand on: thicken to 4.5 mm.
      const base = m.elements[13]!
      // Hot loops on the raw arrays (plain, non-normalized attributes; others take the accessor path below).
      const e = full.elements
      const PR = reader(P)
      if (PR) {
        const { a, st, of, k } = PR
        for (let i = 0, o = vo * 3; i < n; i++, o += 3) {
          const j = i * st + of
          const x = a[j]! * k, y = a[j + 1]! * k, z = a[j + 2]! * k
          const w = 1 / (e[3]! * x + e[7]! * y + e[11]! * z + e[15]!)
          let wy = (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) * w
          const dy = wy - base
          if (dy > 1e-4 && dy < 0.0035) wy = base + 0.0045
          pos[o] = (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) * w
          pos[o + 1] = wy
          pos[o + 2] = (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) * w
        }
      } else
        for (let i = 0; i < n; i++) {
          tmpV3.fromBufferAttribute(P, i).applyMatrix4(full)
          const dy = tmpV3.y - base
          if (dy > 1e-4 && dy < 0.0035) tmpV3.y = base + 0.0045
          pos[(vo + i) * 3] = tmpV3.x
          pos[(vo + i) * 3 + 1] = tmpV3.y
          pos[(vo + i) * 3 + 2] = tmpV3.z
        }
      const ne = nrm.elements
      for (const ex of extra) {
        const A = geo.getAttribute(ex.n) as THREE.BufferAttribute | undefined
        if (!A) continue
        const dir = ex.n === "normal" || ex.n === "tangent"
        const AR = A.itemSize === ex.size ? reader(A) : null
        if (AR) {
          const { a, st, of, k } = AR
          const sz = ex.size
          const out = ex.data
          if (!dir) {
            if (st === sz && of === 0 && k === 1 && a instanceof Float32Array) out.set(a.length === n * sz ? a : a.subarray(0, n * sz), vo * sz)
            else for (let i = 0; i < n; i++) for (let c = 0; c < sz; c++) out[(vo + i) * sz + c] = a[i * st + of + c]! * k
          } else
            for (let i = 0; i < n; i++) {
              const ii = i * st + of
              const o = (vo + i) * sz
              const x = a[ii]! * k, y = a[ii + 1]! * k, z = a[ii + 2]! * k
              let rx: number, ry: number, rz: number
              if (ex.n === "normal") {
                rx = ne[0]! * x + ne[3]! * y + ne[6]! * z
                ry = ne[1]! * x + ne[4]! * y + ne[7]! * z
                rz = ne[2]! * x + ne[5]! * y + ne[8]! * z
              } else {
                rx = e[0]! * x + e[4]! * y + e[8]! * z
                ry = e[1]! * x + e[5]! * y + e[9]! * z
                rz = e[2]! * x + e[6]! * y + e[10]! * z
              }
              const L = Math.hypot(rx, ry, rz) || 1
              out[o] = rx / L
              out[o + 1] = ry / L
              out[o + 2] = rz / L
              if (sz === 4) out[o + 3] = a[ii + 3]! * k
            }
          continue
        }
        for (let i = 0; i < n; i++) {
          const o = (vo + i) * ex.size
          if (dir) {
            tmpV3.set(A.getX(i), A.getY(i), A.getZ(i))
            if (ex.n === "normal") tmpV3.applyMatrix3(nrm).normalize()
            else tmpV3.transformDirection(full)
            ex.data[o] = tmpV3.x
            ex.data[o + 1] = tmpV3.y
            ex.data[o + 2] = tmpV3.z
            if (ex.size === 4) ex.data[o + 3] = A.getW(i)
          } else {
            ex.data[o] = A.getX(i)
            if (ex.size > 1) ex.data[o + 1] = A.getY(i)
            if (ex.size > 2) ex.data[o + 2] = A.getZ(i)
            if (ex.size > 3) ex.data[o + 3] = A.getW(i)
          }
        }
      }
      if (geo.index) {
        const ia = geo.index.array
        for (let k = 0, c = geo.index.count; k < c; k++) index[io++] = ia[k]! + vo
      }
      else for (let k = 0; k < n; k++) index[io++] = k + vo
      vo += n
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
    for (const ex of extra) g.setAttribute(ex.n, new THREE.BufferAttribute(ex.data, ex.size))
    g.setIndex(new THREE.BufferAttribute(index, 1))
    // Bounds from one pass (the sphere is the box's: it only has to enclose for culling).
    g.computeBoundingBox()
    g.boundingSphere = g.boundingBox!.getBoundingSphere(new THREE.Sphere())
    const mesh = new THREE.Mesh(g, bk.mat)
    mesh.castShadow = bk.cast
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    mesh.userData.bounds = bk.bounds
    bk.layer.add(mesh)
  }
  if (prof) {
    prof.bake = (prof.bake ?? 0) + performance.now() - t0
    prof.bakeDoneAt = Math.max(prof.bakeDoneAt ?? 0, performance.now())
  }
}

const place = (b: Builder, name: ModelName, props: Prop[]) => placeModels(b, name, props)
