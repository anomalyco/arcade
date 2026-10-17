import * as THREE from "three/webgpu"
import { float, smoothstep, uv } from "three/tsl"
import { MODELS, type ModelInfo, type ModelName, type Placement, loadModel, modelCollider, yawToward } from "../../render/models"
import { type Builder, FLOOR_Y, M, T } from "./kit"
import { CORRIDOR } from "./corridor"
import { CLOSET, LAB } from "./rooms"

// Real models for the interior's furniture and props (render/models.ts). Colliders and contact shadows are placed
// synchronously; the models stream in afterwards and join the interior group, so nothing here blocks the first frame.

export type Prop = Placement & { collide?: boolean; inset?: number; blob?: number; /** Extra local tilt (tipped-over props). */ tilt?: THREE.Euler }

/** Soft dark ellipse on the floor under a prop: the ambient-occlusion contact the light rig can't give small props. */
export const blobMat = (() => {
  const m = new THREE.MeshBasicNodeMaterial({ color: 0x000000, transparent: true, depthWrite: false })
  const d = uv().sub(0.5).length().mul(2)
  m.opacityNode = float(1).sub(smoothstep(0.35, 1, d)).mul(0.55)
  m.polygonOffset = true
  m.polygonOffsetFactor = -2
  m.polygonOffsetUnits = -2
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
const SMALL = new Set<ModelName>(["crt_terminal", "telephone", "glassware", "microscope", "chemistry_set", "cardboard_box", "television", "wet_floor_sign"])
/** Dense models that only read from close up (chairs: ~5–9k triangles each): same visibility as the small props, but
 *  they keep their shadows in open rooms. */
const NEAR_ONLY = new Set<ModelName>(["office_chair", "stack_chair"])

export function placeModels(b: Builder, name: ModelName, props: Prop[], opts: { cast?: boolean } = {}) {
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
  for (const bk of buckets.values()) {
    await pause()
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
      for (let i = 0; i < n; i++) {
        tmpV3.fromBufferAttribute(P, i).applyMatrix4(full)
        pos[(vo + i) * 3] = tmpV3.x
        pos[(vo + i) * 3 + 1] = tmpV3.y
        pos[(vo + i) * 3 + 2] = tmpV3.z
      }
      for (const ex of extra) {
        const A = geo.getAttribute(ex.n) as THREE.BufferAttribute | undefined
        if (!A) continue
        const dir = ex.n === "normal" || ex.n === "tangent"
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
      if (geo.index) for (let k = 0; k < geo.index.count; k++) index[io++] = geo.index.getX(k) + vo
      else for (let k = 0; k < n; k++) index[io++] = k + vo
      vo += n
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
    for (const ex of extra) g.setAttribute(ex.n, new THREE.BufferAttribute(ex.data, ex.size))
    g.setIndex(new THREE.BufferAttribute(index, 1))
    g.computeBoundingSphere()
    const mesh = new THREE.Mesh(g, bk.mat)
    mesh.castShadow = bk.cast
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    mesh.userData.bounds = bk.bounds
    bk.layer.add(mesh)
  }
}

const place = (b: Builder, name: ModelName, props: Prop[]) => placeModels(b, name, props)


export function placeProps(b: Builder) {
  const y = FLOOR_Y

  // ---- Lobby security desk (behind the reception counter). The guard sits on the north side facing the entrance,
  // so desk, terminal and phone fronts face north (yaw 0) and the chair faces south.
  const desk = { x: 5.5, z: 13.95 }
  const top = y + MODELS.office_desk.size[1]
  place(b, "office_desk", [{ position: [desk.x, y, desk.z], yaw: 0 }])
  place(b, "crt_terminal", [{ position: [desk.x - 0.3, top, desk.z + 0.05], yaw: 0.12, collide: false }])
  place(b, "telephone", [{ position: [desk.x + 0.55, top, desk.z + 0.1], yaw: -0.4, collide: false }])
  place(b, "office_chair", [{ position: [desk.x - 0.2, y, desk.z - 0.85], yaw: Math.PI + 0.35, inset: 0.12 }])
  // Filing cabinets against the west wall behind the desk, fronts facing east.
  place(b, "filing_cabinet", [
    { position: [8.72, y, 13.4], yaw: yawToward(-1, 0) },
    { position: [8.72, y, 13.86], yaw: yawToward(-1, 0) },
  ])

  // ---- Corridor: wet-floor sign by the closet, CCTV camera high on the south wall looking west.
  place(b, "wet_floor_sign", [{ position: [-33.2, y, 0.55], yaw: 0.5, inset: 0.05 }])
  place(b, "security_camera", [{ position: [-12.5, 2.62, CORRIDOR.zs - MODELS.security_camera.size[2] / 2], yaw: 0.55, collide: false }])

  // ---- Lab: chemistry set on the north bench, glassware and a microscope on the island, an open filing cabinet
  // and a TV on an AV cart.
  const bench = y + 0.935
  place(b, "chemistry_set", [{ position: [-21.95, bench, LAB.z0 + 0.34], yaw: Math.PI, collide: false }])
  place(b, "glassware", [{ position: [LAB.x0 + 0.36, bench, -7.3], yaw: yawToward(1, 0) + 0.2, collide: false, blob: 0 }])
  place(b, "microscope", [{ position: [-23.1, y + 0.92, -5.75], yaw: 0.6, collide: false, blob: 0 }])
  place(b, "filing_cabinet_open", [{ position: [LAB.x1 - 0.55, y, LAB.z0 + 0.6], yaw: yawToward(-1, 0), inset: 0.05 }])
  avCart(b, LAB.x1 - 0.45, -2.5)

  // ---- Janitor closet: two worn steel racks along the east wall, boxes on the floor.
  const rackX = CLOSET.x1 - MODELS.metal_rack.size[2] / 2 - 0.02
  place(b, "metal_rack", [
    { position: [rackX, y, 3.3], yaw: yawToward(-1, 0) },
    { position: [rackX, y, 4.3], yaw: yawToward(-1, 0) },
  ])
  place(b, "cardboard_box", [
    { position: [CLOSET.x0 + 1.2, y, CLOSET.z1 - 0.3], yaw: 0.2 },
    { position: [CLOSET.x0 + 1.25, y + MODELS.cardboard_box.size[1], CLOSET.z1 - 0.28], yaw: -0.3, collide: false },
  ])

}

/** Steel AV cart (two shelves on round posts, casters) with the television on top. */
function avCart(b: Builder, x: number, z: number) {
  const y = FLOOR_Y
  const hw = 0.3
  const hd = 0.24
  for (const sy of [0.2, 0.92]) {
    b.box("metal_dark", x - hw, y + sy, z - hd, x + hw, y + sy + 0.025, z + hd)
    b.box("metal_dark", x - hw, y + sy + 0.025, z - hd, x + hw, y + sy + 0.05, z - hd + 0.012)
    b.box("metal_dark", x - hw, y + sy + 0.025, z + hd - 0.012, x + hw, y + sy + 0.05, z + hd)
  }
  for (const dx of [-hw + 0.02, hw - 0.02])
    for (const dz of [-hd + 0.02, hd - 0.02]) {
      b.cyl("metal_dark", T(x + dx, y + 0.52, z + dz), 0.012, 0.012, 0.86, 10)
      b.cyl("rubber", T(x + dx, y + 0.04, z + dz, 0, 0, Math.PI / 2), 0.04, 0.04, 0.03, 14)
      b.box("metal_dark", x + dx - 0.015, y + 0.07, z + dz - 0.02, x + dx + 0.015, y + 0.1, z + dz + 0.02)
    }
  b.box(M.cardboard, x - 0.2, y + 0.225, z - 0.15, x + 0.12, y + 0.36, z + 0.17)
  b.quad(blobMat, T(x, y + 0.002, z, 0, -Math.PI / 2), hw * 2.6, hd * 2.6, { cast: false })
  b.collide(x - hw, y, z - hd, x + hw, y + 0.97, z + hd)
  place(b, "television", [{ position: [x, y + 0.97, z], yaw: yawToward(-1, 0), collide: false }])
}
