import * as THREE from "three/webgpu"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import type { WorldContext } from "../context"
import { BOOTH } from "../layout"
import { MODELS, loadModel, modelCollider, yawToward, type ModelName, type Placement } from "../../render/models"
import { Batch, matrix } from "./geo"
import { shadowLayer } from "./mats"
import { LOT_Y, stall } from "./lot"
import { WAGON_APRON } from "./booth"
import { FACILITY_WALK_Y } from "./props"
import { FY, HEAD, WALL } from "./booth"

// Real modelled vehicles and props from the shared library (src/render/models.ts). Colliders and contact-shadow
// decals are built at once from the known sizes; the .glb files stream in afterwards in parallel, so the first frame
// never waits for them. Props that repeat are instanced.

type Item = Placement & {
  name: ModelName
  /** Collider inset per side (m); omit for no collider. */
  inset?: number
  /** Contact shadow under the footprint: "car" adds a dark patch at each tyre. */
  shadow?: "car" | "blob" | false
  /** Extra transform for models that are not standing upright (a tyre lying flat). */
  tilt?: (o: THREE.Object3D) => void
}

const SOUTH = yawToward(0, 1)
const NORTH = yawToward(0, -1)
const EAST = yawToward(1, 0)
const WEST = yawToward(-1, 0)

/** A car in stall `i` of `row`, nose in (towards the stall head), nudged and skewed a little so the lot isn't regimented. */
function parked(name: ModelName, row: number, side: -1 | 1, i: number, dx = 0, dz = 0, skew = 0): Item {
  const s = stall(row, side, i)
  const facing = s.heading < 0 ? NORTH : SOUTH
  return { name, position: [s.x + dx, LOT_Y, s.z + dz], yaw: facing + skew, inset: 0.08, shadow: "car" }
}

function items(): Item[] {
  const bx = BOOTH.x
  const bz = BOOTH.z
  const deskX = bx - BOOTH.w / 2 + WALL + 0.31
  const desk = FY + 0.78
  return [
    // Lot: the hero wagon in a stall near the gate, a few cars spread through the rows, one long-parked under a cover.
    // Hero wagon outside the fence on the gravel-edged apron west of the gate, broadside to the road (r3-01, r5-01).
    { name: "car_wagon", position: [WAGON_APRON.x, WAGON_APRON.y, WAGON_APRON.z], yaw: EAST - 0.04, inset: 0.08, shadow: "car" },
    parked("car_sedan", 1, 1, 1, -0.1, 0, -0.02),
    parked("car_sedan_b", 3, -1, 2, 0.15, 0.2, 0.025),
    parked("car_pickup", 0, -1, 1, 0, 0.3, 0),
    parked("van", 2, 1, 4, 0.05, -0.2, 0.015),
    parked("covered_car", 4, 1, 7, 0, 0, -0.04),

    // Dumpsters against the lot's west curb, fronts facing into the lot, with bags and old tyres dumped beside them.
    { name: "dumpster", position: [-40.6, LOT_Y, 42.1], yaw: EAST, inset: 0.05, shadow: "blob" },
    { name: "dumpster", position: [-40.55, LOT_Y, 44.3], yaw: EAST + 0.05, inset: 0.05, shadow: "blob" },
    { name: "trashbag", position: [-39.3, LOT_Y, 45.6], yaw: 0.7 },
    { name: "trashbag", position: [-39.8, LOT_Y, 46.2], yaw: 2.4 },
    { name: "trashbag", position: [-38.9, LOT_Y, 41.1], yaw: 4.1 },
    { name: "tyre", position: [-41.55, LOT_Y, 46.1], yaw: 0.3 },
    {
      name: "tyre",
      position: [-40.2, LOT_Y, 46.9],
      yaw: 1.1,
      tilt: (o) => {
        // Lying flat: rotate the upright tyre onto its side about its centre.
        o.rotation.x = Math.PI / 2
        o.position.y += MODELS.tyre.size[2] / 2
        o.position.z -= MODELS.tyre.size[1] / 2
      },
    },

    // By the entrance and the building.
    { name: "fire_hydrant", position: [-7.4, 0, 27.4], yaw: SOUTH + 0.3, inset: 0, shadow: "blob" },
    { name: "bench", position: [12.5, FACILITY_WALK_Y, 23.6], yaw: SOUTH, inset: 0.05, shadow: "blob" },
    { name: "trash_can", position: [14.1, FACILITY_WALK_Y, 23.5], yaw: SOUTH - 0.4, inset: 0.08, shadow: "blob" },
    { name: "utility_box_b", position: [-38.5, LOT_Y, 37.35], yaw: SOUTH, inset: 0.02, shadow: "blob" },

    // Gate and booth: cones by the boom, a cabinet behind the booth, a trash can on the island, a flood light on the
    // booth roof aimed at the gate, and inside the guard's terminal, phone and chair.
    { name: "traffic_cone", position: [-6.2, 0, 125.1], yaw: 0.4 },
    { name: "traffic_cone", position: [-6.6, 0, 126.9], yaw: 1.9 },
    { name: "traffic_cone", position: [-4.6, 0, 119.4], yaw: 3.0 },
    { name: "utility_box", position: [bx + 1.1, 0.12, bz - BOOTH.d / 2 - 0.45], yaw: NORTH, inset: 0, shadow: "blob" },
    { name: "trash_can", position: [bx + BOOTH.w / 2 + 0.55, 0.12, bz + 0.9], yaw: EAST, inset: 0.08, shadow: "blob" },
    { name: "security_light", position: [bx - BOOTH.w / 2 + 0.05, 2.875, bz - BOOTH.d / 2 + 0.3], yaw: WEST - 0.35 },
    { name: "crt_terminal", position: [deskX, desk, bz - 0.5], yaw: EAST },
    { name: "telephone", position: [deskX + 0.05, desk, bz + 0.2], yaw: EAST + 0.35 },
    { name: "office_chair", position: [bx - 0.35, FY, bz + 0.05], yaw: WEST + 0.5, inset: 0.15 },
    // Institutional clock over the north window (facing into the booth) and an extinguisher on the south knee wall
    // west of the door, clear of the leaf's inward sweep.
    { name: "wall_clock", position: [bx + 0.6, HEAD + 0.04, bz - BOOTH.d / 2 + WALL + 0.036], yaw: SOUTH },
    { name: "fire_extinguisher", position: [bx, FY + 0.22, bz + BOOTH.d / 2 - WALL - 0.1], yaw: NORTH },

    // A wet-floor sign left out on the walk beside the entrance doors (the janitor's been through).
    { name: "wet_floor_sign", position: [-2.9, FACILITY_WALK_Y, 23.4], yaw: SOUTH + 0.5 },
  ]
}

/** Footprint-sized soft shadow decals: a blob under each item, plus a dark patch at each tyre for cars. */
function contactShadows(root: THREE.Object3D, list: Item[]) {
  const batch = new Batch()
  const layer = shadowLayer()
  for (const it of list) {
    if (!it.shadow) continue
    const [w, , d] = MODELS[it.name].size
    const b = batch.child(matrix(it.position[0], it.position[1], it.position[2], it.yaw ?? 0))
    // Nested rounded rectangles at 20 % each: the overlap darkens towards the middle like a soft falloff.
    for (let k = 0; k < 4; k++) {
      const grow = 0.5 - k * 0.18
      b.add(layer, roundRect(w + grow, d + grow, Math.min(w, d) * 0.25 + grow * 0.4), matrix(0, 0.006 + k * 0.001, 0))
    }
    if (it.shadow === "car") {
      for (const zz of [-0.31, 0.3])
        for (const sd of [-1, 1])
          for (let k = 0; k < 2; k++) b.add(layer, ellipse(0.24 - k * 0.07, 0.42 - k * 0.12), matrix(sd * (w / 2 - 0.22), 0.011 + k * 0.001, zz * d))
    }
  }
  for (const m of batch.build(root, { receiveShadow: false, name: "model-shadows" })) m.renderOrder = 2
}

function roundRect(w: number, d: number, r: number) {
  const s = new THREE.Shape()
  const x = w / 2 - r
  const z = d / 2 - r
  s.absarc(x, z, r, 0, Math.PI / 2, false)
  s.absarc(-x, z, r, Math.PI / 2, Math.PI, false)
  s.absarc(-x, -z, r, Math.PI, Math.PI * 1.5, false)
  s.absarc(x, -z, r, Math.PI * 1.5, Math.PI * 2, false)
  const g = new THREE.ShapeGeometry(s, 4)
  g.rotateX(-Math.PI / 2)
  return g
}

function ellipse(rx: number, rz: number) {
  const g = new THREE.CircleGeometry(1, 16)
  g.scale(rx, rz, 1)
  g.rotateX(-Math.PI / 2)
  return g
}

export function buildModels(ctx: WorldContext, root: THREE.Object3D) {
  const list = items()
  for (const it of list) if (it.inset !== undefined) ctx.colliders.push(modelCollider(it.name, it, it.inset))
  contactShadows(root, list)

  // Group by model: repeated, upright props are merged into plain meshes (one per sub-mesh, sharing the model's atlas
  // material; small InstancedMeshes would each compile their own shader); singles and tilted ones are plain clones.
  const byName = new Map<ModelName, Item[]>()
  for (const it of list) {
    const arr = byName.get(it.name) ?? []
    arr.push(it)
    byName.set(it.name, arr)
  }
  const loads: Promise<void>[] = []
  for (const [name, group] of byName) {
    const upright = group.filter((it) => !it.tilt)
    const tilted = group.filter((it) => it.tilt)
    if (upright.length > 1) {
      loads.push(mergeModel(name, upright).then((g) => void root.add(g)))
    } else {
      for (const it of upright) loads.push(place(root, it))
    }
    for (const it of tilted) loads.push(place(root, it))
  }
  void Promise.allSettled(loads).then((results) => {
    for (const r of results) if (r.status === "rejected") console.error(`compound/models: ${r.reason}`)
  })
}

const CARS = new Set<ModelName>(["car_wagon", "car_sedan", "car_sedan_b", "car_pickup", "van", "covered_car"])
/** Cars switch to their simplified LOD1 copy beyond this distance from the camera (m). */
const CAR_LOD_DISTANCE = 25

async function place(root: THREE.Object3D, it: Item) {
  let model: THREE.Object3D
  if (CARS.has(it.name)) {
    const [near, far] = await Promise.all([loadModel(it.name), loadModel(it.name, { lod: 1 })])
    const lod = new THREE.LOD()
    lod.addLevel(near, 0)
    lod.addLevel(far, CAR_LOD_DISTANCE)
    model = lod
  } else model = await loadModel(it.name)
  const outer = new THREE.Group()
  outer.position.set(it.position[0], it.position[1], it.position[2])
  outer.rotation.y = it.yaw ?? 0
  if (it.tilt) {
    const pivot = new THREE.Group()
    pivot.add(model)
    it.tilt(pivot)
    outer.add(pivot)
  } else outer.add(model)
  root.add(outer)
}

/** Every placement of a model baked into one plain Mesh per sub-mesh (static props; geometry converted to float). */
async function mergeModel(name: ModelName, placements: Item[]) {
  const template = await loadModel(name)
  template.updateMatrixWorld(true)
  const group = new THREE.Group()
  group.name = `${name}×${placements.length}`
  const m = new THREE.Matrix4()
  template.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const base = toFloat(mesh.geometry)
    const parts = placements.map((p) => {
      m.compose(new THREE.Vector3(...p.position), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw ?? 0), new THREE.Vector3(1, 1, 1))
      return base.clone().applyMatrix4(m.multiply(mesh.matrixWorld))
    })
    const geo = mergeGeometries(parts, false)
    base.dispose()
    for (const g of parts) g.dispose()
    if (!geo) return
    const merged = new THREE.Mesh(geo, mesh.material)
    merged.name = mesh.name
    merged.castShadow = mesh.castShadow
    merged.receiveShadow = mesh.receiveShadow
    merged.matrixAutoUpdate = false
    group.add(merged)
  })
  return group
}

/** Copy of a geometry with plain Float32 attributes (glTF attributes may be quantised or interleaved). */
function toFloat(src: THREE.BufferGeometry) {
  const g = new THREE.BufferGeometry()
  for (const [key, a] of Object.entries(src.attributes)) {
    const n = a.count
    const k = a.itemSize
    const out = new Float32Array(n * k)
    for (let i = 0; i < n; i++) {
      out[i * k] = a.getX(i)
      if (k > 1) out[i * k + 1] = a.getY(i)
      if (k > 2) out[i * k + 2] = a.getZ(i)
      if (k > 3) out[i * k + 3] = a.getW(i)
    }
    g.setAttribute(key, new THREE.BufferAttribute(out, k))
  }
  if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>))
  return g
}
