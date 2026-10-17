import * as THREE from "three/webgpu"
import { float, smoothstep, uv } from "three/tsl"
import { MODELS, type ModelName, type Placement, instanceModel, loadModel, modelCollider, yawToward } from "../../render/models"
import { type Builder, FLOOR_Y, M, T } from "./kit"
import { CORRIDOR } from "./corridor"
import { CLOSET, LAB } from "./rooms"

// Real models for the interior's furniture and props (render/models.ts). Colliders and contact shadows are placed
// synchronously; the models stream in afterwards and join the interior group, so nothing here blocks the first frame.

type Prop = Placement & { collide?: boolean; inset?: number; blob?: number }

/** Soft dark ellipse on the floor under a prop: the ambient-occlusion contact the light rig can't give small props. */
const blobMat = (() => {
  const m = new THREE.MeshBasicNodeMaterial({ color: 0x000000, transparent: true, depthWrite: false })
  const d = uv().sub(0.5).length().mul(2)
  m.opacityNode = float(1).sub(smoothstep(0.35, 1, d)).mul(0.55)
  m.polygonOffset = true
  m.polygonOffsetFactor = -2
  m.polygonOffsetUnits = -2
  m.name = "interior_contact_blob"
  return m
})()

const pending: Promise<unknown>[] = []

function place(b: Builder, name: ModelName, props: Prop[]) {
  const [w, , d] = MODELS[name].size
  for (const p of props) {
    if (p.collide ?? true) b.ctx.colliders.push(modelCollider(name, p, p.inset ?? 0.03))
    const blob = p.blob ?? (p.position[1] <= FLOOR_Y + 0.01 ? 1.25 : 0)
    if (blob > 0) {
      const s = typeof p.scale === "number" ? p.scale : 1
      b.quad(blobMat, T(p.position[0], p.position[1] + 0.002, p.position[2], p.yaw ?? 0, -Math.PI / 2), w * s * blob, d * s * blob, { cast: false })
    }
  }
  const load =
    props.length > 1
      ? instanceModel(name, props)
      : loadModel(name).then((g) => {
          const p = props[0]!
          g.position.set(...p.position)
          g.rotation.y = p.yaw ?? 0
          if (p.scale !== undefined) typeof p.scale === "number" ? g.scale.setScalar(p.scale) : g.scale.set(...p.scale)
          return g
        })
  pending.push(
    load
      .then((g) => {
        g.traverse((o) => {
          o.matrixAutoUpdate = false
          o.updateMatrix()
        })
        g.updateMatrixWorld(true)
        b.group.add(g)
      })
      .catch((e) => console.error(`interior: model ${name} failed: ${e}`)),
  )
}

export function placeProps(b: Builder) {
  const y = FLOOR_Y

  // ---- Lobby security desk (behind the reception counter). The guard sits on the north side facing the entrance,
  // so desk, terminal and phone fronts face north (yaw 0) and the chair faces south.
  const desk = { x: -5.5, z: 13.95 }
  const top = y + MODELS.office_desk.size[1]
  place(b, "office_desk", [{ position: [desk.x, y, desk.z], yaw: 0 }])
  place(b, "crt_terminal", [{ position: [desk.x - 0.3, top, desk.z + 0.05], yaw: 0.12, collide: false }])
  place(b, "telephone", [{ position: [desk.x + 0.55, top, desk.z + 0.1], yaw: -0.4, collide: false }])
  place(b, "office_chair", [{ position: [desk.x - 0.2, y, desk.z - 0.85], yaw: Math.PI + 0.35, inset: 0.12 }])
  // Filing cabinets against the west wall behind the desk, fronts facing east.
  place(b, "filing_cabinet", [
    { position: [-8.72, y, 11.2], yaw: yawToward(1, 0) },
    { position: [-8.72, y, 11.66], yaw: yawToward(1, 0) },
  ])

  // ---- Corridor: wet-floor sign by the closet, CCTV camera high on the south wall looking west.
  place(b, "wet_floor_sign", [{ position: [-33.2, y, 0.55], yaw: 0.5, inset: 0.05 }])
  place(b, "security_camera", [{ position: [-12.5, 2.62, CORRIDOR.zs - MODELS.security_camera.size[2] / 2], yaw: 0.55, collide: false }])

  // ---- Lab: chemistry set on the north bench, glassware and a microscope on the island, an open filing cabinet
  // and a TV on an AV cart.
  const bench = y + 0.935
  place(b, "chemistry_set", [{ position: [-24.1, bench, LAB.z0 + 0.34], yaw: Math.PI, collide: false }])
  place(b, "glassware", [{ position: [-19.6, y + 0.92, -5.5], yaw: Math.PI + 0.2, collide: false }])
  place(b, "microscope", [{ position: [-21.15, y + 0.92, -5.85], yaw: 0.4, collide: false }])
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

  return Promise.all(pending)
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
