import * as THREE from "three/webgpu"
import { decalMaterial } from "./windows"
import { BUILDING } from "../layout"
import type { WorldContext } from "../context"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { MODELS, loadModel, modelCollider, yawToward, type ModelName, type Placement } from "../../render/models"
import { PLATFORM, lightAbove } from "./dock"
import { ANNEX_PLANT } from "./annex"
import { DOCK_DOORS } from "./shell"
import { CORE, ROOF_DOOR, band, facades, normal, point } from "./shell"

// Real models around the facility (src/render/models.ts): the box truck backed onto the dock, the dumpster, pallets
// loaded with boxes and crates, drums, a hand truck, wall-mounted condensers, flood lights over the back doors,
// CCTV cameras on the corners and utility cabinets by the meters. Colliders and contact shadows are registered
// immediately from the known model sizes; the meshes stream in without blocking the first frame.

const MAIN = BUILDING.main
const ANNEX = BUILDING.annex
const WALL_Z = MAIN.min[1]
const P = PLATFORM
const BAY = { x0: -31.3, x1: -24.9, z0: WALL_Z + 0.4, z1: WALL_Z + 6.4, y: P.y }

type Item = Placement & { position: [number, number, number]; yaw: number }

const size = (n: ModelName) => MODELS[n].size as readonly [number, number, number]

export function buildProps(ctx: WorldContext, root: THREE.Object3D) {
  const lists = new Map<ModelName, Item[]>()
  const blobs: { x: number; z: number; y: number; w: number; d: number; yaw: number; a: number }[] = []
  const put = (name: ModelName, x: number, y: number, z: number, yaw = 0, opts: { collide?: number; blob?: number } = {}) => {
    const item: Item = { position: [x, y, z], yaw }
    let l = lists.get(name)
    if (!l) lists.set(name, (l = []))
    l.push(item)
    if (opts.collide !== undefined) ctx.colliders.push(modelCollider(name, item, opts.collide))
    if (opts.blob) {
      const [w, , d] = size(name)
      blobs.push({ x, z, y, w: w * 1.15 + 0.25, d: d * 1.15 + 0.25, yaw, a: opts.blob })
    }
    return item
  }
  /** Stacks `name` on top of a pallet or another prop whose top is at `y`. Returns the new top. */
  const stack = (name: ModelName, x: number, y: number, z: number, yaw = 0) => {
    put(name, x, y, z, yaw)
    return y + size(name)[1]
  }

  // Box truck backed onto the shut roll-up door (front faces -Z, i.e. away from the dock).
  const truckLen = size("box_truck")[2]
  put("box_truck", -33.9, 0, P.z0 - 0.15 - truckLen / 2, 0, { collide: 0.08, blob: 0.85 })

  // Dumpster against the wall east of the dock steps, a bag beside it.
  const dz = WALL_Z - 0.12 - size("dumpster")[2] / 2
  put("dumpster", P.x1 + 2.3, 0, dz, 0.03, { collide: 0.02, blob: 0.8 })
  put("trashbag", P.x1 + 3.55, 0, dz + 0.2, 1.1, { blob: 0.5 })
  put("trashbag", P.x1 + 3.4, 0, dz - 0.45, 2.6, { blob: 0.5 })

  // On the dock: a loaded pallet of boxes at the west end, an empty pallet stack, milk crates and the hand truck.
  const ph = size("pallet")[1]
  {
    const x = P.x0 + 0.68
    const z = P.z1 - 1.2
    put("pallet", x, P.y, z, 0.04, { collide: 0.05, blob: 0.6 })
    const top = P.y + ph
    const [bw, bh, bd] = size("cardboard_box")
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 2; j++) {
        const bx = x - 0.4 + i * (bw + 0.01)
        const bz = z - 0.27 + j * (bd + 0.01)
        let t = stack("cardboard_box", bx, top, bz, 0.04 + (i * 0.03 - j * 0.02))
        if ((i + j) % 3 !== 2) t = stack("cardboard_box", bx + 0.01, t, bz - 0.01, 0.06 + i * 0.05)
        if (i === 1 && j === 0) stack("cardboard_box", bx, t, bz, -0.12)
      }
    ctx.colliders.push({ min: [x - 0.6, P.y, z - 0.6], max: [x + 0.6, P.y + ph + bh * 3, z + 0.6] })
  }
  {
    const x = -31.0
    const z = P.z1 - 1.0
    for (let k = 0; k < 4; k++) put("pallet", x + (k % 2) * 0.03, P.y + k * ph, z - (k % 3) * 0.02, -0.03 + k * 0.025, k ? {} : { collide: 0.05, blob: 0.6 })
    ctx.colliders.push({ min: [x - 0.6, P.y, z - 0.6], max: [x + 0.6, P.y + ph * 4, z + 0.6] })
  }
  {
    const x = -25.8
    const z = P.z1 - 0.5
    const [, mh] = size("milk_crate")
    put("milk_crate", x, P.y, z, 0.1, { blob: 0.45 })
    put("milk_crate", x + 0.02, P.y + mh, z, 0.16)
    put("milk_crate", x + 0.55, P.y, z + 0.02, -0.08, { blob: 0.45 })
    put("hand_truck", DOCK_DOORS.open.u0 - 1.0, P.y, P.z1 - 0.55, yawToward(0, -1) - 0.35, { collide: 0.1, blob: 0.4 })
    ctx.colliders.push({ min: [x - 0.3, P.y, z - 0.2], max: [x + 0.85, P.y + mh * 2, z + 0.2] })
  }

  // Receiving bay behind the half-open door: crates on pallets and boxes.
  {
    const x = BAY.x0 + 0.9
    const z = BAY.z1 - 0.9
    put("pallet", x, BAY.y, z, 0, { collide: 0.05, blob: 0.6 })
    let t = BAY.y + ph
    t = stack("crate_wood", x, t, z - 0.27, 0)
    stack("crate_wood", x + 0.02, BAY.y + ph, z + 0.28, 0.02)
    stack("crate_wood", x, t, z - 0.25, -0.05)
    put("pallet", BAY.x1 - 1.1, BAY.y, BAY.z1 - 0.8, 0.08, { collide: 0.05, blob: 0.6 })
    const [bw, , bd] = size("cardboard_box")
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        const t2 = stack("cardboard_box", BAY.x1 - 1.35 + i * (bw + 0.02), BAY.y + ph, BAY.z1 - 1.05 + j * (bd + 0.02), 0.08)
        if (i + j < 2) stack("cardboard_box", BAY.x1 - 1.35 + i * (bw + 0.02), t2, BAY.z1 - 1.05 + j * (bd + 0.02), 0.2)
      }
    put("drum_steel", BAY.x1 - 0.5, BAY.y, BAY.z0 + 1.6, 0.4, { collide: 0.05, blob: 0.6 })
  }

  // Drums by the truck court, west of the dock: a cluster of blue steel drums and two red hazard drums.
  {
    const x = P.x0 - 1.6
    const z = WALL_Z - 0.7
    const spots: [ModelName, number, number, number][] = [
      ["drum_steel", 0, 0, 0.2], ["drum_steel", -0.68, 0.05, 1.3], ["drum_steel", -0.3, -0.62, 2.2],
      ["drum_hazard", 0.4, -0.7, 0.7], ["drum_hazard", -1.35, -0.1, 3.0], ["drum_steel", 0.66, -0.05, 4.1],
    ]
    for (const [n, ox, oz, yaw] of spots) put(n, x + ox, 0, z + oz, yaw, { collide: 0.06, blob: 0.7 })
    put("pallet", x - 1.6, 0, z - 1.7, 0.5, { collide: 0.05, blob: 0.55 })
    put("pallet", x - 1.58, ph, z - 1.72, 0.55)
  }

  // Condenser units: two on the west pad, more on brackets along the annex and the north wall.
  {
    const [aw, , ad] = size("ac_unit")
    const west = yawToward(-1, 0)
    for (const z of [3.5, 6.5]) put("ac_unit", MAIN.min[0] - 2.6 + 0.1, 0.15, z, west, { collide: 0.0, blob: 0.6 })
    const annexN = yawToward(0, -1)
    for (const x of [40.5, 54.5, 57.5]) {
      const y = 0.55
      put("ac_unit", x, y, ANNEX.min[1] - ad / 2 - 0.08, annexN, { collide: 0.0 })
      blobs.push({ x, z: ANNEX.min[1] - ad / 2 - 0.08, y: 0, w: aw * 1.3, d: ad * 1.5 + 0.2, yaw: 0, a: 0.4 })
    }
    const annexE = yawToward(1, 0)
    put("ac_unit", ANNEX.max[0] + ad / 2 + 0.08, 0.55, -10.5, annexE, { collide: 0 })
    blobs.push({ x: ANNEX.max[0] + 0.3, z: -10.5, y: 0, w: ad * 1.5 + 0.2, d: aw * 1.3, yaw: 0, a: 0.4 })
  }

  // Flood light heads over every personnel door (the lamps themselves are registered in dock.ts).
  for (const f of facades()) {
    const n = normal(f)
    for (const h of f.holes) {
      if (h.kind !== "door" && h.kind !== "fireDoor") continue
      const d = size("security_light")[2]
      const at = lightAbove(f, h.u0, h.u1, h.y1)
      const c = point(f, at.u, at.y, -d / 2)
      put("security_light", c.x, c.y, c.z, yawToward(n.x, n.z))
    }
  }

  // Flood light over the roof door of the stair house.
  {
    const d = size("security_light")[2]
    put("security_light", (ROOF_DOOR.x0 + ROOF_DOOR.x1) / 2, ROOF_DOOR.y1 + 0.2, CORE.z0 - d / 2, yawToward(0, -1))
  }

  // CCTV cameras high on the building corners, looking out along the walls, and one on the core over the entrance.
  {
    const cy = band(1).y0 - 0.45
    const cd = size("security_camera")[2] / 2
    const cams: [number, number, number, number][] = [
      // x, z, look dx, look dz (the camera hangs off the wall on the outward side of the corner)
      [MAIN.min[0] + 0.6, MAIN.max[1] + cd, -0.6, 1],
      [MAIN.max[0] - 0.6, MAIN.max[1] + cd, 0.6, 1],
      [MAIN.min[0] + 0.6, MAIN.min[1] - cd, -0.5, -1],
      [P.x1 + 0.6, MAIN.min[1] - cd, -0.8, -1],
      [ANNEX.max[0] - 0.6, ANNEX.min[1] - cd, 0.6, -1],
      [ANNEX.max[0] - 0.6, ANNEX.max[1] + cd, 0.6, 1],
      [CORE.x1 + 0.1 + cd, CORE.z1 - 0.6, 1, 0.5],
    ]
    for (const [x, z, lx, lz] of cams) put("security_camera", x, cy, z, yawToward(lx, lz))
  }

  // Utility cabinets by the meters on the annex east wall, and one by the dock steps.
  {
    const e = yawToward(1, 0)
    const [, , ud] = size("utility_box")
    const [, , ud2] = size("utility_box_b")
    put("utility_box", ANNEX.max[0] + ud / 2 + 0.02, 0.4, -22.2, e, { collide: 0 })
    put("utility_box_b", ANNEX.max[0] + ud2 / 2 + 0.02, 0.4, -20.8, e, { collide: 0 })
    put("utility_box", ANNEX.max[0] + ud / 2 + 0.02, 0, -18.9, e, { collide: 0, blob: 0.45 })
    put("utility_box_b", P.x1 + 6.2, 0, WALL_Z - ud2 / 2 - 0.02, yawToward(0, -1), { collide: 0, blob: 0.5 })
  }

  // Annex plant room: electrical cabinets, the janitor's shelves and kit.
  {
    const R = ANNEX_PLANT
    const fy = BUILDING.floorY
    const e = yawToward(1, 0)
    const [, , u2] = size("utility_box_b")
    put("utility_box_b", R.x0 + u2 / 2 + 0.02, fy, -4.0, e, { collide: 0, blob: 0.4 })
    put("utility_box_b", R.x0 + u2 / 2 + 0.02, fy, -5.1, e, { collide: 0, blob: 0.4 })
    const s = yawToward(0, -1)
    const [, , sd] = size("steel_shelves")
    put("steel_shelves", 47.0, fy, R.z1 - sd / 2 - 0.05, s, { collide: 0.02, blob: 0.4 })
    put("metal_rack", 50.0, fy, R.z1 - size("metal_rack")[2] / 2 - 0.05, s, { collide: 0.02, blob: 0.4 })
    put("drum_steel", R.x1 - 0.5, fy, R.z0 + 0.6, 0.7, { collide: 0.05, blob: 0.5 })
    put("trash_can", 52.6, fy, R.z1 - 0.5, 2.1, { collide: 0.05, blob: 0.45 })
    put("wet_floor_sign", 45.6, fy, -8.6, 0.6, { blob: 0.3 })
  }

  contactShadows(root, blobs)

  // Stream the models in and bake every placement into one static mesh per material (the models share an atlas
  // material, so this is a handful of draws and no per-InstancedMesh shader builds). The truck keeps an LOD pair.
  const pending: Promise<void>[] = []
  const props = [...lists].filter(([n]) => n !== "box_truck")
  pending.push(
    bakeModels(props.map(([n, items]) => [n, items] as const)).then((g) => void root.add(g)),
  )
  const truck = lists.get("box_truck")
  if (truck) {
    pending.push(
      Promise.all([bakeModels([["box_truck", truck]]), bakeModels([["box_truck", truck]], 1)]).then(([near, far]) => {
        const lod = new THREE.LOD()
        lod.name = "box_truck_lod"
        lod.addLevel(near, 0)
        lod.addLevel(far, 30)
        root.add(lod)
      }),
    )
  }
  return Promise.all(pending)
}

/** Soft dark ellipses under grounded props: the ambient occlusion contact a night scene relies on. */
function contactShadows(root: THREE.Object3D, blobs: { x: number; z: number; y: number; w: number; d: number; yaw: number; a: number }[]) {
  if (!blobs.length) return
  const pos: number[] = []
  const uvs: number[] = []
  const decal: number[] = []
  const idx: number[] = []
  for (const b of blobs) {
    const c = Math.cos(b.yaw)
    const s = Math.sin(b.yaw)
    const base = pos.length / 3
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const lx = (u * b.w) / 2
      const lz = (v * b.d) / 2
      pos.push(b.x + lx * c + lz * s, b.y + 0.012, b.z - lx * s + lz * c)
      uvs.push(u, v)
      decal.push(0, 0, 0, b.a + 2)
    }
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  g.setAttribute("decal", new THREE.Float32BufferAttribute(decal, 4))
  g.setIndex(idx)
  g.computeBoundingSphere()
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array<number>(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  const mesh = new THREE.Mesh(g, decalMaterial())
  mesh.renderOrder = 1
  mesh.matrixAutoUpdate = false
  root.add(mesh)
}

/** Loads each model (failures skip that model) and merges all placements into one mesh per material + layout. */
async function bakeModels(entries: readonly (readonly [ModelName, readonly Item[]])[], lod: 0 | 1 = 0) {
  const group = new THREE.Group()
  group.name = lod ? "facility-props-lod1" : "facility-props"
  const buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean }>()
  const loaded = await Promise.all(
    entries.map(([n]) => loadModel(n, { lod }).catch((e) => (console.warn(`facility: model ${n} failed`, e), null))),
  )
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  entries.forEach(([, items], k) => {
    const template = loaded[k]
    if (!template) return
    template.updateMatrixWorld(true)
    template.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || Array.isArray(mesh.material)) return
      const mat = mesh.material
      const keep = ["position", "normal", "uv", ...((mat as THREE.MeshStandardMaterial).vertexColors ? ["color"] : [])].filter((a) => mesh.geometry.attributes[a])
      const key = `${mat.uuid}|${keep.join(",")}`
      let b = buckets.get(key)
      if (!b) buckets.set(key, (b = { material: mat, geos: [], cast: false }))
      b.cast ||= mesh.castShadow
      const base = floatCopy(mesh.geometry, keep)
      for (const it of items) {
        m.compose(new THREE.Vector3(...it.position), q.setFromAxisAngle(up, it.yaw), new THREE.Vector3(1, 1, 1)).multiply(mesh.matrixWorld)
        b.geos.push(base.clone().applyMatrix4(m))
      }
      base.dispose()
    })
  })
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false)
    for (const g of b.geos) g.dispose()
    if (!merged) continue
    merged.computeBoundingSphere()
    const mesh = new THREE.Mesh(merged, b.material)
    mesh.castShadow = b.cast
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    group.add(mesh)
  }
  return group
}

/** Indexed float copy of the attributes merging needs (meshopt-quantised inputs come in mixed array types). */
function floatCopy(src: THREE.BufferGeometry, names: string[]) {
  const g = new THREE.BufferGeometry()
  for (const n of names) {
    const a = src.attributes[n] as THREE.BufferAttribute
    const out = new Float32Array(a.count * a.itemSize)
    for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c)
    g.setAttribute(n, new THREE.BufferAttribute(out, a.itemSize))
  }
  if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>))
  else g.setIndex(Array.from({ length: src.attributes.position!.count }, (_, i) => i))
  return g
}
