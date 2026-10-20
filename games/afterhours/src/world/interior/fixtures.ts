import { addSearchSpot } from "./search-spots"
import * as THREE from "three/webgpu"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"
import { float, floor, fract, hash, mix, positionWorld, step, time, vec3 } from "three/tsl"
import { materialFor } from "../../render/materials"
import { type DoorState, SHELL } from "./plan"
import { doorway } from "./doorway"
import { MODELS, type ModelName, yawToward } from "../../render/models"
import { type Builder, type Mat, CEIL_Y, FLOOR_Y, LAYER, M, T, aaFade, aaWindow, addDocuments, glow, paint } from "./kit"
import { type DocumentId, documentsByTag } from "../../render/documents"
import { placeModels, wastebasket } from "./props"
import { STAIN, PUDDLE, POLY, blindMats, plasticMat } from "./finishes"

// Furniture and fixtures for storey files. FRAME CONVENTION (same as the model library): a fixture stands at (x, z) on
// the floor, its FRONT faces local −Z, so `yaw = yawToward(dx, dz)` turns its front towards (dx, dz); things that
// stand against a wall have their BACK at local +Z (place them so x, z is the footprint centre, back on the wall).
// Everything adds its own colliders. Positions are ground-floor coordinates.

export { wastebasket }
/** Decay pieces (storey 4) and shared decals/materials. */
export { STAIN, PUDDLE, POLY, blindMats, plasticMat }

const frame = (x: number, z: number, yaw: number, y = FLOOR_Y) => T(x, y, z, yaw)
/** Yaw that turns a seat at (cx, cz) to face (tx, tz) (seat fronts face local −Z, like the models). */
export const chairYaw = (cx: number, cz: number, tx: number, tz: number) => yawToward(tx - cx, tz - cz)
/** World AABB collider for a local box in a fixture frame. */
const coll = (b: Builder, m: THREE.Matrix4, w: number, h: number, d: number, ox = 0, oz = 0) => b.collideLocal(m, [ox - w / 2, 0, oz - d / 2], [ox + w / 2, h, oz + d / 2])

const SAFETY_GREEN = paint(0x2a6a38, 0.5)
const HOOD = paint(0xa7aca4, 0.45, 0.15)
const LOCKER = paint(0x56604f, 0.5, 0.45)
const FABRIC = paint(0x5a5448, 0.95)
const FABRIC_TRIM = paint(0x3a3630, 0.5, 0.3)
const TASK_TUBE = glow(0x202418, 0xe8f0c8, 1.6, "task_tube")

// ------------------------------------------------------------------------------------------------ lab safety

/** Wall-mounted eyewash: bowl with twin heads on a bracket, push paddle, green sign above. Back on the wall. */
export function eyewashStation(b: Builder, x: number, z: number, yaw: number) {
  const m = frame(x, z, yaw)
  b.rbox(M.steel, m, 0.12, 0.08, 0.12, 0.01, 0, 0.98, 0.1)
  const bowl = new THREE.CylinderGeometry(0.17, 0.11, 0.1, 24, 1, true)
  bowl.applyMatrix4(m.clone().multiply(T(0, 1.02, -0.06)))
  b.add(M.steel, bowl)
  b.cyl(M.darkSteel, m.clone().multiply(T(0, 0.975, -0.06)), 0.11, 0.11, 0.005, 20)
  for (const dx of [-0.06, 0.06]) b.cyl(M.safety, m.clone().multiply(T(dx, 1.06, -0.06)), 0.025, 0.02, 0.04, 12)
  b.rbox(M.safety, m, 0.26, 0.03, 0.06, 0.01, 0, 0.92, -0.17)
  b.boxM(SAFETY_GREEN, m, 0.36, 0.26, 0.006, 0, 1.75, 0.142, { cast: false })
  signDoc(b, m, "sign_eyewash", 0, 1.75, 0.139, [0.34, 0.24])
  b.rod("metal_galvanized", ptIn(m, 0, 0.98, 0.14), ptIn(m, 0, 0.0, 0.14), 0.014, 8)
  coll(b, m, 0.36, 1.1, 0.3, 0, 0.0)
}

/** Freestanding drench shower: floor flange, pipe to the head under the ceiling, pull rod and ring, green sign. */
export function drenchShower(b: Builder, x: number, z: number, yaw: number) {
  const m = frame(x, z, yaw)
  const top = CEIL_Y - FLOOR_Y - 0.2
  b.cyl(M.safety, m.clone().multiply(T(0, 0.02, 0.2)), 0.08, 0.1, 0.04, 16)
  b.rod(M.safety, ptIn(m, 0, 0, 0.2), ptIn(m, 0, top, 0.2), 0.02, 10)
  b.rod(M.safety, ptIn(m, 0, top, 0.2), ptIn(m, 0, top, -0.3), 0.02, 10)
  b.cyl(M.steel, m.clone().multiply(T(0, top - 0.12, -0.32)), 0.04, 0.14, 0.14, 20, { open: true })
  b.rod(M.steel, ptIn(m, 0, top - 0.05, -0.1), ptIn(m, 0, 1.75, -0.1), 0.003, 4)
  const ring = new THREE.TorusGeometry(0.05, 0.007, 6, 16)
  ring.applyMatrix4(m.clone().multiply(T(0, 1.7, -0.1)))
  b.add(M.safety, ring)
  b.boxM(SAFETY_GREEN, m, 0.3, 0.3, 0.006, 0, top - 0.3, 0.215, { cast: false })
  signDoc(b, m, "sign_drench", 0, top - 0.3, 0.212, [0.28, 0.28])
  b.collideLocal(m, [-0.06, 0, 0.14], [0.06, top, 0.26])
}

// ------------------------------------------------------------------------------------------------ lab furniture

/** Peninsula/island lab bench (length along local x): base cabinets both sides, epoxy top, service spine with gas
 *  taps and outlets; optional end sink. */
export function peninsula(b: Builder, x: number, z: number, yaw: number, length = 3.0, opts: { sink?: boolean } = {}) {
  const m = frame(x, z, yaw)
  const d = 1.5
  b.rbox(M.cabinet, m, length - 0.04, 0.8, d - 0.16, 0.01, 0, 0.5, 0)
  b.boxM(M.rubber, m, length - 0.1, 0.1, d - 0.3, 0, 0.05, 0)
  b.rbox(M.epoxy, m, length, 0.035, d, 0.006, 0, 0.917, 0)
  for (let k = 0; k < Math.floor(length / 0.6); k++)
    for (const s of [-1, 1]) {
      const u = -length / 2 + 0.3 + k * 0.6
      b.boxM(M.darkSteel, m, 0.004, 0.76, 0.004, u + 0.3, 0.5, s * (d / 2 - 0.08) + s * 0.001, { cast: false })
      b.boxM(M.steel, m, 0.14, 0.016, 0.02, u, 0.82, s * (d / 2 - 0.07))
    }
  b.rbox(M.cabinet, m, length - 0.3, 0.32, 0.14, 0.02, 0, 1.1, 0)
  for (let k = 0; k < 4; k++) for (const s of [-1, 1]) b.cyl(M.steel, m.clone().multiply(T(-length / 2 + 0.5 + k * ((length - 1) / 3), 1.05, s * 0.08, 0, Math.PI / 2)), 0.008, 0.008, 0.05, 8)
  if (opts.sink) {
    b.boxM(M.darkSteel, m, 0.45, 0.004, 0.4, length / 2 - 0.35, 0.936, 0, { cast: false })
    b.rod(M.steel, ptIn(m, length / 2 - 0.35, 0.94, 0.25), ptIn(m, length / 2 - 0.35, 1.3, 0.25), 0.012)
    b.rod(M.steel, ptIn(m, length / 2 - 0.35, 1.3, 0.25), ptIn(m, length / 2 - 0.35, 1.25, 0.05), 0.012)
  }
  coll(b, m, length, 1.26, d)
}

/** Enclosed fume hood, back at local +Z (against a wall), sash front; `light` turns on the hood's own tube. */
export function fumeHood(b: Builder, x: number, z: number, yaw: number, light = false) {
  const m = frame(x, z, yaw)
  b.rbox(HOOD, m, 1.5, 0.9, 0.82, 0.02, 0, 0.45, 0)
  b.rbox(M.epoxy, m, 1.52, 0.04, 0.84, 0.01, 0, 0.92, 0)
  b.rbox(HOOD, m, 1.5, 0.22, 0.82, 0.03, 0, 2.2, 0)
  b.rbox(HOOD, m, 0.1, 1.2, 0.82, 0.02, -0.7, 1.54, 0)
  b.rbox(HOOD, m, 0.1, 1.2, 0.82, 0.02, 0.7, 1.54, 0)
  b.boxM(M.darkSteel, m, 1.3, 1.2, 0.02, 0, 1.54, 0.38)
  b.boxM(M.frame, m, 1.32, 0.04, 0.04, 0, 1.45, -0.4)
  b.quad(M.glass, m.clone().multiply(T(0, 1.62, -0.41, Math.PI)), 1.3, 0.34, { cast: false })
  b.quad(M.glass, m.clone().multiply(T(0, 1.14, -0.37, Math.PI)), 1.3, 0.56, { cast: false })
  const duct = ptIn(m, 0, 2.31, 0.1)
  b.cyl("metal_galvanized", T(duct[0], (duct[1] + CEIL_Y) / 2, duct[2]), 0.13, 0.13, CEIL_Y - duct[1], 14)
  if (light) {
    b.boxM(glow(0x202418, 0xe8f0d8, 1.8, "hood_tube"), m, 1.2, 0.02, 0.06, 0, 2.08, 0.1, { cast: false })
    const p = ptIn(m, 0, 2.0, 0)
    b.lamp({ kind: "fluorescent", position: p, direction: [0, -1, 0], color: [0.86, 0.95, 0.75], intensity: 16, range: 5, angle: 1.3, penumbra: 0.8, size: 0.5 })
  }
  coll(b, m, 1.52, 2.3, 0.84)
}

/** Sink counter against a wall (length along local x, back at +Z): base cabinets, top, 1–2 sinks with taps. */
export function sinkCounter(b: Builder, x: number, z: number, yaw: number, length = 1.8, sinks = 1, top: "epoxy" | "laminate" = "laminate") {
  const m = frame(x, z, yaw)
  const d = 0.62
  b.rbox(M.cabinet, m, length - 0.02, 0.8, d - 0.04, 0.01, 0, 0.5, 0.02)
  b.boxM(M.rubber, m, length - 0.04, 0.1, d - 0.12, 0, 0.05, 0.06)
  b.rbox(top === "epoxy" ? M.epoxy : M.laminateTop, m, length, 0.035, d, 0.006, 0, 0.917, 0)
  for (let k = 0; k < sinks; k++) {
    const u = -length / 2 + (length * (k + 0.5)) / sinks
    b.boxM(M.darkSteel, m, 0.45, 0.004, 0.38, u, 0.936, -0.02, { cast: false })
    b.rod(M.steel, ptIn(m, u, 0.94, d / 2 - 0.06), ptIn(m, u, 1.25, d / 2 - 0.06), 0.012)
    b.rod(M.steel, ptIn(m, u, 1.25, d / 2 - 0.06), ptIn(m, u, 1.2, 0.02), 0.012)
  }
  coll(b, m, length, 0.94, d)
}

// ------------------------------------------------------------------------------------------------ offices

/** Cubicle pod: 2 × 2 workstations (fabric panels 1.55 m, L worksurface, overhead bin, chair, phone; every 3rd a
 *  terminal). `tubes` lists cell indices (0..3) whose under-bin task tube is on. */
export function cubiclePod(b: Builder, x: number, z: number, yaw: number, opts: { tubes?: number[]; terminalEvery?: number; seed?: number; /** Seats: task chairs (default), lighter stacking chairs, or none. */ chairs?: "office" | "stack" | "none" } = {}) {
  const m = frame(x, z, yaw)
  const c = 1.8
  const ph = 1.55
  const pt = 0.06
  // Spine panels: one along local x, one along local z, plus outer returns.
  b.rbox(FABRIC, m, 2 * c, ph, pt, 0.01, 0, ph / 2, 0)
  b.rbox(FABRIC, m, pt, ph, 2 * c, 0.01, 0, ph / 2, 0)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.rbox(FABRIC, m, pt, ph, c - 0.9, 0.01, sx * c, ph / 2, sz * (0.45 + (c - 0.9) / 2))
  b.boxM(FABRIC_TRIM, m, 2 * c + 0.02, 0.02, pt + 0.02, 0, ph + 0.01, 0)
  b.boxM(FABRIC_TRIM, m, pt + 0.02, 0.02, 2 * c + 0.02, 0, ph + 0.01, 0)
  b.collideLocal(m, [-c, 0, -pt / 2], [c, ph, pt / 2])
  b.collideLocal(m, [-pt / 2, 0, -c], [pt / 2, ph, c])
  let s = (opts.seed ?? 7) * 7919 + 1
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  let idx = 0
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const cell = idx++
      // L worksurface: long run against the spine panel, return against the centre panel.
      b.rbox(M.laminateTop, m, c - 0.12, 0.03, 0.75, 0.005, sx * (c / 2), 0.72, sz * (pt / 2 + 0.375))
      b.rbox(M.laminateTop, m, 0.6, 0.03, c - 0.9, 0.005, sx * (pt / 2 + 0.3), 0.72, sz * (0.75 + (c - 0.9) / 2 + 0.05))
      b.rbox(M.cabinet, m, 0.42, 0.68, 0.6, 0.01, sx * (c - 0.3), 0.34, sz * (pt / 2 + 0.33))
      // Overhead bin with its task tube.
      b.rbox(FABRIC_TRIM, m, c - 0.3, 0.36, 0.38, 0.01, sx * (c / 2 + 0.1), 1.3, sz * (pt / 2 + 0.19))
      const on = !!opts.tubes?.includes(cell)
      b.boxM(M.housing, m, c - 0.4, 0.03, 0.08, sx * (c / 2 + 0.1), 1.105, sz * (pt / 2 + 0.3), { cast: false })
      b.boxM(on ? TASK_TUBE : M.diffuserOff, m, c - 0.44, 0.003, 0.06, sx * (c / 2 + 0.1), 1.089, sz * (pt / 2 + 0.3), { cast: false })
      if (on) {
        const p = ptIn(m, sx * (c / 2 + 0.1), 1.06, sz * (pt / 2 + 0.3))
        b.lamp({ kind: "fluorescent", position: p, direction: [0, -1, 0], color: [0.86, 0.95, 0.62], intensity: 3, range: 2.5, angle: 1.4, penumbra: 0.8, size: 0.4 })
      }
      const deskTop = FLOOR_Y + 0.735
      const dp = ptIn(m, sx * (c / 2), 0, sz * (pt / 2 + 0.3))
      if (cell % (opts.terminalEvery ?? 3) === 0) placeModels(b, "crt_terminal", [{ position: [dp[0], deskTop, dp[2]], yaw: yaw + (sz > 0 ? Math.PI : 0), collide: false, blob: 0 }])
      else placeModels(b, "telephone", [{ position: [dp[0] + 0.3, deskTop, dp[2]], yaw: yaw + (sz > 0 ? Math.PI : 0) + 0.3, collide: false, blob: 0 }])
      const cp = ptIn(m, sx * (c / 2 - 0.1 + (rnd() - 0.5) * 0.4), 0, sz * (pt / 2 + 1.05))
      const cy = yaw + (sz > 0 ? 0 : Math.PI) + (rnd() - 0.5) * 1.2
      if ((opts.chairs ?? "office") !== "none") placeModels(b, opts.chairs === "stack" ? "stack_chair" : "office_chair", [{ position: [cp[0], FLOOR_Y, cp[2]], yaw: cy, inset: 0.15 }])
    }
}

/**
 * Private office set. CHAIR CONVENTION (all kit fixtures): a seat's front faces local −Z like every library model, so
 * `chairYaw(cx, cz, tx, tz)` turns a chair at (cx, cz) to face (tx, tz). The steel desk's front (drawer side, where
 * the occupant sits) is its local −Z; `yaw` turns the desk. The task chair stands on the front side facing the desk,
 * visitors on the back side facing it; phone and lamp turn towards the occupant. (x, z) is the desk centre.
 */
export function officeSet(b: Builder, x: number, z: number, yaw: number, opts: { lamp?: boolean; visitors?: number; coat?: boolean; seed?: number } = {}) {
  const m = frame(x, z, yaw)
  const top = FLOOR_Y + MODELS.office_desk.size[1]
  placeModels(b, "office_desk", [{ position: [x, FLOOR_Y, z], yaw }])
  const seat = ptIn(m, 0.1, 0, -0.85)
  placeModels(b, "office_chair", [{ position: [seat[0], FLOOR_Y, seat[2]], yaw: chairYaw(seat[0], seat[2], x, z) + 0.2, inset: 0.15 }])
  const v = opts.visitors ?? 2
  for (let k = 0; k < v; k++) {
    const p = ptIn(m, (k - (v - 1) / 2) * 0.7, 0, 0.95)
    placeModels(b, "stack_chair", [{ position: [p[0], FLOOR_Y, p[2]], yaw: chairYaw(p[0], p[2], x, z) + (k - 0.5) * 0.3 }])
  }
  const ph = ptIn(m, 0.6, 0, 0.1)
  placeModels(b, "telephone", [{ position: [ph[0], top, ph[2]], yaw: yaw - 0.3, collide: false, blob: 0 }])
  if (opts.lamp !== undefined) {
    const lp = ptIn(m, -0.7, 0, 0.15)
    // deskLamp lives in lights.ts; placed here directly to keep fixtures free of lamp policy.
    placeModels(b, "desk_lamp", [{ position: [lp[0], top, lp[2]], yaw, collide: false, blob: 0 }])
    if (opts.lamp) {
      const f = ptIn(m, -0.7, 0.4, -0.15)
      b.lamp({ kind: "incandescent", position: [f[0], top + 0.4, f[2]], direction: dirIn(yaw, 0.53, -0.85), color: [1, 0.68, 0.38], intensity: 60, range: 5, angle: 1.0, penumbra: 0.8, size: 0.08 })
    }
  }
}

/** Conference table (length along local x) with chairs round it. */
export function conferenceTable(b: Builder, x: number, z: number, yaw: number, seats = 12, opts: { chair?: ModelName; length?: number } = {}) {
  const m = frame(x, z, yaw)
  const len = opts.length ?? Math.max(2.4, Math.ceil(seats / 2) * 0.75)
  const w = 1.2
  b.rbox(M.wood, m, len, 0.045, w, 0.02, 0, 0.74, 0)
  b.rbox(M.veneerDark, m, len - 0.2, 0.08, w - 0.25, 0.01, 0, 0.68, 0)
  for (const u of [-len / 2 + 0.6, len / 2 - 0.6]) b.rbox(M.veneerDark, m, 0.12, 0.68, w - 0.5, 0.01, u, 0.34, 0)
  coll(b, m, len, 0.76, w)
  const per = Math.floor(seats / 2)
  const chair = opts.chair ?? "stack_chair"
  for (let k = 0; k < per; k++)
    for (const s of [-1, 1]) {
      const p = ptIn(m, -len / 2 + (len * (k + 0.5)) / per, 0, s * (w / 2 + 0.38))
      placeModels(b, chair, [{ position: [p[0], FLOOR_Y, p[2]], yaw: yaw + (s > 0 ? 0 : Math.PI), inset: 0.1 }])
    }
}

/** Rows of shelving units filling a rect, aisles along `axis`. */
export function shelvingRows(b: Builder, r: { x0: number; x1: number; z0: number; z1: number }, opts: { axis?: "x" | "z"; aisle?: number; model?: ModelName } = {}) {
  const model = opts.model ?? "steel_shelves"
  const [w, , d] = MODELS[model].size
  const axis = opts.axis ?? "z"
  const aisle = opts.aisle ?? 1.1
  const pitch = d + aisle
  const props = []
  if (axis === "z") {
    for (let x = r.x0 + d / 2 + 0.1; x <= r.x1 - d / 2; x += pitch)
      for (let z = r.z0 + w / 2 + 0.1; z <= r.z1 - w / 2; z += w + 0.02) props.push({ position: [x, FLOOR_Y, z] as const, yaw: Math.PI / 2, inset: 0.03 })
  } else {
    for (let z = r.z0 + d / 2 + 0.1; z <= r.z1 - d / 2; z += pitch)
      for (let x = r.x0 + w / 2 + 0.1; x <= r.x1 - w / 2; x += w + 0.02) props.push({ position: [x, FLOOR_Y, z] as const, yaw: 0, inset: 0.03 })
  }
  placeModels(b, model, props)
}

/** Bank of steel lockers (n doors along local x), back at +Z: louvred doors, handles, number plates (blank). */
/** A bank of `n` lockers; `first` numbers their doors (searchable, src/game/search) from that number. */
export function lockers(b: Builder, x: number, z: number, yaw: number, n = 6, first = 1) {
  const m = frame(x, z, yaw)
  const w = 0.38
  const len = n * w
  b.rbox(LOCKER, m, len, 1.82, 0.45, 0.01, 0, 0.91 + 0.1, 0)
  b.boxM(M.rubber, m, len, 0.1, 0.4, 0, 0.05, 0.02)
  for (let k = 0; k < n; k++) {
    const u = -len / 2 + w * (k + 0.5)
    b.boxM(M.darkSteel, m, 0.004, 1.76, 0.004, u + w / 2, 1.01, -0.226, { cast: false })
    for (let s = 0; s < 5; s++) b.boxM(M.frame, m, w - 0.12, 0.008, 0.008, u, 1.6 + s * 0.035, -0.228)
    b.boxM(M.steel, m, 0.025, 0.12, 0.03, u + w / 2 - 0.06, 1.1, -0.235)
    b.boxM(M.plate, m, 0.06, 0.03, 0.004, u, 1.85, -0.227, { cast: false })
    const hp = new THREE.Vector3(u, 1.1, -0.26).applyMatrix4(m)
    addSearchSpot({ id: `locker@${b.storey}:${hp.x.toFixed(2)},${hp.z.toFixed(2)}`, kind: "locker", storey: b.storey, at: [hp.x, hp.y + b.oy, hp.z], number: first + k })
    const pp = new THREE.Vector3(u, 1.85, -0.229).applyMatrix4(m)
    const nn = new THREE.Vector3(0, 0, -1).transformDirection(m)
    addDocuments(b, [{ id: `locker_${String((k % 12) + 1).padStart(2, "0")}` as DocumentId, position: [pp.x, pp.y, pp.z], normal: [nn.x, 0, nn.z], pin: "none", curl: 0, size: [0.06, 0.03] }])
  }
  coll(b, m, len, 1.92, 0.45)
}

/** Kitchenette run against a wall (length along local x): base units, sink, wall cabinets, fridge, coffee maker. */
export function kitchenette(b: Builder, x: number, z: number, yaw: number, length = 2.4, opts: { fridge?: boolean; coffeeOn?: boolean } = {}) {
  sinkCounter(b, x, z, yaw, length, 1)
  const m = frame(x, z, yaw)
  b.rbox(M.cabinet, m, length, 0.7, 0.34, 0.01, 0, 1.85, 0.14)
  for (let k = 0; k < Math.floor(length / 0.6); k++) b.boxM(M.darkSteel, m, 0.004, 0.66, 0.004, -length / 2 + 0.6 * (k + 1), 1.85, -0.031, { cast: false })
  // Coffee maker with its red pilot.
  b.rbox(M.rubber, m, 0.22, 0.34, 0.24, 0.02, -length / 2 + 0.35, 1.1, 0.12)
  b.cyl(M.glass, m.clone().multiply(T(-length / 2 + 0.35, 1.02, 0.02)), 0.07, 0.07, 0.14, 14)
  b.boxM(opts.coffeeOn ? glow(0x200404, 0xff2010, 2.5, "pilot") : M.hazardOff, m, 0.012, 0.012, 0.004, -length / 2 + 0.42, 1.2, -0.002, { cast: false })
  if (opts.fridge ?? true) {
    const fx = length / 2 + 0.36
    b.rbox(M.jugWhite, m, 0.68, 1.6, 0.66, 0.04, fx, 0.8, 0)
    b.boxM(M.darkSteel, m, 0.64, 0.004, 0.004, fx, 1.15, -0.332, { cast: false })
    b.boxM(M.steel, m, 0.03, 0.3, 0.03, fx - 0.28, 1.35, -0.345)
    coll(b, m, 0.68, 1.6, 0.66, fx)
  }
}

/** Floor-mounted slop sink (janitor), back at +Z, wall faucet. */
export function slopSink(b: Builder, x: number, z: number, yaw: number) {
  const m = frame(x, z, yaw)
  const s = 0.75
  const h = 0.28
  b.boxM(M.concreteSink, m, s - 0.1, 0.04, s - 0.12, 0, 0.02, -0.01)
  b.boxM(M.concreteSink, m, s, h, 0.07, 0, h / 2, -s / 2 + 0.035)
  b.boxM(M.concreteSink, m, s, h, 0.05, 0, h / 2, s / 2 - 0.025)
  for (const sx of [-1, 1]) b.boxM(M.concreteSink, m, 0.05, h, s - 0.12, sx * (s / 2 - 0.025), h / 2, -0.01)
  b.rod(M.steel, ptIn(m, -0.15, 0.95, s / 2), ptIn(m, 0.15, 0.95, s / 2), 0.015)
  b.rod(M.steel, ptIn(m, 0, 0.95, s / 2), ptIn(m, 0, 0.88, s / 2 - 0.2), 0.012)
  coll(b, m, s, h, s)
}

// ------------------------------------------------------------------------------------------------ computing

/** A row of mainframe/disk cabinets along local x (front −Z), every `diskEvery`th a disk drive. */
export function rackRow(b: Builder, x: number, z: number, yaw: number, count = 4, diskEvery = 3) {
  for (let k = 0; k < count; k++) {
    const p = ptIn(frame(x, z, yaw), (k - (count - 1) / 2) * 0.82, 0, 0)
    cabinet(b, p[0], p[2], yaw, k % diskEvery === diskEvery - 1)
  }
}
/** Tape drive (reels behind smoked glass), front −Z. */
export const tapeDrive = (b: Builder, x: number, z: number, yaw: number, rnd: () => number) => tapeDriveModel(b, x, z, yaw, rnd)
/** Band printer on its stand with a fanfold sheet into the catch basket, front −Z. */
export const linePrinter = (b: Builder, x: number, z: number, yaw: number, rnd: () => number) => lineprinter(b, x, z, yaw, rnd)

// ------------------------------------------------------------------------------------------------ rest & walls

/** Folding cot with a blanket, length along local x. */
export function cot(b: Builder, x: number, z: number, yaw: number) {
  const m = frame(x, z, yaw)
  for (const s of [-1, 1]) b.boxM("metal_galvanized", m, 1.9, 0.03, 0.03, 0, 0.4, s * 0.34)
  for (const u of [-0.9, 0.9]) for (const s of [-1, 1]) b.rod("metal_galvanized", ptIn(m, u, 0, s * 0.3), ptIn(m, u * 0.85, 0.4, s * 0.34), 0.012, 6)
  b.boxM(paint(0x3a4a32, 0.95), m, 1.86, 0.03, 0.66, 0, 0.42, 0)
  b.rbox(paint(0x5a4a3a, 0.98), m, 1.2, 0.06, 0.7, 0.03, 0.25, 0.46, 0.02)
  coll(b, m, 1.95, 0.5, 0.75)
}

/** Chalkboard (or whiteboard) on a wall, back at +Z, width w, chalk ledge, wiped smears. */
export function chalkboard(b: Builder, x: number, z: number, yaw: number, w = 2.4, kind: "chalk" | "white" = "chalk", doc?: DocumentId) {
  const m = frame(x, z, yaw)
  b.rbox(M.wood, m, w + 0.1, 1.2, 0.03, 0.008, 0, 1.6, 0.015)
  b.boxM(kind === "chalk" ? M.chalkboard : paint(0xd8d8d0, 0.2), m, w, 1.1, 0.006, 0, 1.6, -0.003, { cast: false })
  if (doc) {
    // The board's writing as a readable document over its face (front is local −Z).
    const p = new THREE.Vector3(0, 1.6, -0.006).applyMatrix4(m)
    const nrm = new THREE.Vector3(0, 0, -1).transformDirection(m)
    addDocuments(b, [{ id: doc, position: [p.x, p.y, p.z], normal: [nrm.x, 0, nrm.z], pin: "none", curl: 0, size: [w, 1.1] }])
  } else if (kind === "chalk") for (const [u, v, sw] of [[-0.4, 1.8, 0.9], [0.5, 1.5, 1.1], [0, 1.3, 0.6]]) b.boxM(M.chalkSmear, m, sw!, 0.25, 0.004, u!, v!, -0.008, { cast: false })
  b.boxM("metal_galvanized", m, w, 0.02, 0.07, 0, 1.03, -0.035)
}

/** Papers pinned to a wall in a w × h area centred at (x, y, z), back at +Z. */
export function wallPapers(b: Builder, x: number, y: number, z: number, yaw: number, w: number, h: number, rnd: () => number, n = 8, docs?: readonly DocumentId[]) {
  // Sheets face the room (local +Z) on the FINISHED wall surface behind (x, z), found at flush; overlapping sheets are
  // kept 3.5 mm apart by the depth pass. Randoms are drawn now so the storey's sequence doesn't depend on flush order.
  const sheets = Array.from({ length: n }, () => [(rnd() - 0.5) * (w - 0.2), (rnd() - 0.5) * (h - 0.25), (rnd() - 0.5) * 0.1] as const)
  b.defer(() => {
    const nx = Math.round(Math.sin(yaw))
    const nz = Math.round(Math.cos(yaw))
    const sx = x - nx * 0.05
    const sz = z - nz * 0.05
    const f = b.face(sx, y, sz, nx, nz)
    const found = nx !== 0 ? f !== sx : f !== sz
    const d0 = found ? (nx !== 0 ? (f - x) * nx : (f - z) * nz) : 0
    const m = T(x, y, z, yaw)
    const save = b.depthGap
    b.depthGap = 0.0035
    // Real pinned papers (board-tagged documents, picked from the sheet's own random position).
    const ids = docs ?? documentsByTag("board")
    const nrm: [number, number, number] = [Math.sin(yaw), 0, Math.cos(yaw)]
    addDocuments(
      b,
      sheets.map(([u, v, roll], k) => {
        const p = new THREE.Vector3(u, v, d0).applyMatrix4(m)
        return { id: ids[(k * 7 + Math.floor(Math.abs(u) * 97)) % ids.length]!, position: [p.x, p.y, p.z] as const, normal: nrm, rotation: roll, pin: "pin" as const }
      }),
    )
    b.depthGap = save
  })
}

// ------------------------------------------------------------------------------------------------ helpers

/** A printed sign (render/documents) on a plate whose face at local z looks along local −Z of frame `m`. */
function signDoc(b: Builder, m: THREE.Matrix4, id: DocumentId, u: number, v: number, z: number, size: readonly [number, number]) {
  const p = new THREE.Vector3(u, v, z).applyMatrix4(m)
  const n = new THREE.Vector3(0, 0, -1).transformDirection(m)
  addDocuments(b, [{ id, position: [p.x, p.y, p.z], normal: [n.x, 0, n.z], pin: "none", curl: 0, size }])
}

function ptIn(m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m)
  return [v.x, v.y, v.z]
}
const dirIn = (yaw: number, fwd: number, down: number): [number, number, number] => [-Math.sin(yaw) * fwd, down, -Math.cos(yaw) * fwd]

export { yawToward }


// ------------------------------------------------------------------------------------------------ moved from the retired storey template

/** Run of steel base cabinets with an epoxy top along a wall; c0 is the wall side, c1 the front (either sign). */
export function benchRun(b: Builder, axis: "x" | "z", a0: number, a1: number, c0: number, c1: number) {
  const y = FLOOR_Y
  const f = Math.sign(c1 - c0) || 1
  const box = (p0: number, p1: number, q0: number, q1: number, y0: number, y1: number, mat: Mat, cast = true) =>
    axis === "x" ? b.box(mat, p0, y0, q0, p1, y1, q1, { cast }) : b.box(mat, q0, y0, p0, q1, y1, p1, { cast })
  // Cabinet body (front face at c1), toe kick, top.
  box(a0, a1, c0, c1 - f * 0.02, y + 0.1, y + 0.9, M.cabinet)
  box(a0, a1, c0, c1 - f * 0.08, y, y + 0.1, M.rubber, false)
  box(a0, a1, c0, c1 + f * 0.02, y + 0.9, y + 0.935, M.epoxy)
  // Drawer and door fronts with handles.
  const unit = 0.6
  const n = Math.floor((a1 - a0) / unit)
  for (let i = 0; i < n; i++) {
    const p0 = a0 + i * unit + 0.015
    const p1 = p0 + unit - 0.03
    const drawers = i % 3 === 1
    const rows = drawers ? [[0.12, 0.3], [0.32, 0.5], [0.52, 0.7], [0.72, 0.88]] : [[0.12, 0.88]]
    for (const [r0, r1] of rows) {
      box(p0, p1, c1 - f * 0.02, c1 - f * 0.005, y + r0!, y + r1!, M.cabinet)
      const hy = drawers ? y + (r0! + r1!) / 2 + 0.03 : y + 0.78
      box((p0 + p1) / 2 - 0.07, (p0 + p1) / 2 + 0.07, c1 - f * 0.005, c1 + f * 0.015, hy - 0.008, hy + 0.008, M.steel)
    }
  }
  if (axis === "x") b.collide(a0, y, c0, a1, y + 0.935, c1 + f * 0.02)
  else b.collide(c0, y, a0, c1 + f * 0.02, y + 0.935, a1)
}

/** Ring of points around a rounded rectangle (half extents hw × hd, corner radius r) at height y, counter-clockwise
 *  seen from above. */
export function roundedRing(hw: number, hd: number, r: number, y: number, n: number, out: number[]) {
  const corners: [number, number, number][] = [
    [hw - r, hd - r, 0],
    [-(hw - r), hd - r, Math.PI / 2],
    [-(hw - r), -(hd - r), Math.PI],
    [hw - r, -(hd - r), Math.PI * 1.5],
  ]
  for (const [cx, cz, a0] of corners)
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / (n - 1)) * (Math.PI / 2)
      out.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r)
    }
}

/** Surface swept through a list of rounded-rectangle rings [hw, hd, r, y] (a moulded tub, rim and inner wall). */
export function sweptTub(rings: readonly (readonly [number, number, number, number])[], n = 6, capBottom = true) {
  const pos: number[] = []
  for (const [hw, hd, r, y] of rings) roundedRing(hw, hd, r, y, n, pos)
  const per = n * 4
  const idx: number[] = []
  for (let k = 0; k < rings.length - 1; k++)
    for (let i = 0; i < per; i++) {
      const a = k * per + i
      const b2 = k * per + ((i + 1) % per)
      const c = a + per
      const d = b2 + per
      idx.push(a, c, b2, b2, c, d)
    }
  if (capBottom) {
    const centre = pos.length / 3
    pos.push(0, rings[0]![3], 0)
    for (let i = 0; i < per; i++) idx.push(centre, i, (i + 1) % per)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Rounded-rectangle cap (water surface, lids) at height y. */
export function roundedCap(hw: number, hd: number, r: number, y: number, n = 6) {
  const pos: number[] = [0, y, 0]
  roundedRing(hw, hd, r, y, n, pos)
  const per = n * 4
  const idx: number[] = []
  for (let i = 0; i < per; i++) idx.push(0, 1 + ((i + 1) % per), 1 + i)
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Commercial mop bucket: tapered moulded tub with a rolled rim, grey water, side-press wringer, casters, mop. */
export function bucket(b: Builder, x: number, z: number) {
  const y = FLOOR_Y
  const at = (g: THREE.BufferGeometry, yaw = 0) => g.applyMatrix4(T(x, y, z, yaw))
  // Tub (long axis along Z), wall leaning out towards the rim.
  const tub = sweptTub([
    [0.15, 0.2, 0.05, 0.075],
    [0.165, 0.215, 0.06, 0.1],
    [0.19, 0.245, 0.075, 0.36],
    [0.2, 0.255, 0.08, 0.375],
    [0.197, 0.252, 0.078, 0.392],
    [0.184, 0.239, 0.07, 0.385],
    [0.17, 0.225, 0.062, 0.2],
  ])
  b.add(M.yellow, at(tub))
  b.add(water, at(roundedCap(0.172, 0.227, 0.062, 0.215)), { cast: false })
  // Caster forks and wheels under the corners.
  for (const dx of [-0.13, 0.13])
    for (const dz of [-0.18, 0.18]) {
      b.box("metal_dark", x + dx - 0.015, y + 0.045, z + dz - 0.02, x + dx + 0.015, y + 0.075, z + dz + 0.02)
      b.cyl("rubber", T(x + dx, y + 0.028, z + dz, 0, 0, Math.PI / 2), 0.028, 0.028, 0.022, 14)
    }
  // Wringer sitting across the rear of the tub: rounded box with a press plate, lever and grip.
  const W = T(x, y + 0.39, z + 0.13)
  const body = new RoundedBoxGeometry(0.3, 0.2, 0.17, 3, 0.025)
  body.applyMatrix4(W.clone().multiply(T(0, 0.1, 0)))
  b.add(M.yellow, body)
  const plate = new RoundedBoxGeometry(0.24, 0.16, 0.025, 2, 0.008)
  plate.applyMatrix4(W.clone().multiply(T(0, 0.11, -0.04)))
  b.add("metal_dark", plate)
  b.rod("metal_galvanized", [x + 0.155, y + 0.52, z + 0.13], [x + 0.17, y + 0.95, z + 0.2], 0.011)
  b.rod("metal_galvanized", [x + 0.17, y + 0.95, z + 0.2], [x - 0.02, y + 0.98, z + 0.21], 0.011)
  b.rod("rubber", [x + 0.02, y + 0.98, z + 0.21], [x - 0.1, y + 0.985, z + 0.215], 0.017, 10)
  // Mop standing in the water: wooden handle, clamp and a hank of grey strands.
  const mx = x - 0.04
  const mz = z - 0.09
  b.rod(M.wood, [mx, y + 0.24, mz], [mx - 0.1, y + 1.45, mz - 0.2], 0.013)
  b.cyl("metal_dark", T(mx, y + 0.27, mz), 0.03, 0.03, 0.05, 10)
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2
    b.rod(mopStrand, [mx + Math.cos(a) * 0.02, y + 0.26, mz + Math.sin(a) * 0.02], [mx + Math.cos(a) * 0.075, y + 0.2, mz + Math.sin(a) * 0.07], 0.012, 5)
  }
  b.collide(x - 0.22, y, z - 0.27, x + 0.22, y + 0.6, z + 0.27)
}

export const water = paint(0x1d2019, 0.05)

export const mopStrand = paint(0x6a665a, 1)

/** Blinking indicator lamps on computer cabinets: each lamp its own rate and colour. */
export const panelLights = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x050505, roughness: 0.4 })
  // A strip of lamps on a 2.2 cm pitch drawn on one flat panel: round-ish dots, each its own rate and colour.
  const q = positionWorld.mul(45)
  const c = floor(q)
  // Dots as filtered windows; sub-pixel they average to their area instead of sparkling.
  const qa = q.x.add(q.z)
  const dot = aaWindow(fract(qa), 0.22, 0.78).mul(aaWindow(fract(q.y), 0.22, 0.78)).mul(aaFade(qa)).add(float(0.31).mul(float(1).sub(aaFade(qa))))
  const h = hash(c.x.add(c.y.mul(31)).add(c.z.mul(17)))
  const blink = step(0.45, fract(time.mul(h.mul(1.8).add(0.15)).add(h.mul(10))))
  const colour = mix(vec3(1, 0.42, 0.08), vec3(0.35, 1, 0.4), step(0.62, h))
  m.emissiveNode = colour.mul(blink).mul(step(0.25, h)).mul(dot).mul(2.2)
  m.name = "interior_panel_lights"
  return m
})()

export const CAB_GREY = paint(0x858c8e, 0.5, 0.2)

export const CAB_BLUE = paint(0x3d4f63, 0.45, 0.25)

export const SMOKED = paint(0x0b0e0f, 0.06)

export const TAPE = paint(0x1a130d, 0.35)

function tapeDriveModel(b: Builder, x: number, z: number, yaw: number, rnd: () => number) {
  const m = T(x, FLOOR_Y, z, yaw)
  b.rbox(CAB_GREY, m, 0.72, 1.78, 0.7, 0.03, 0, 0.89, 0)
  b.rbox(CAB_BLUE, m, 0.74, 0.16, 0.72, 0.03, 0, 1.72, 0)
  b.boxM(SMOKED, m, 0.6, 0.78, 0.02, 0, 1.22, -0.351)
  for (const dy of [0.2, -0.17]) {
    const reel = m.clone().multiply(T(0, 1.22 + dy, -0.37, 0, Math.PI / 2))
    b.cyl(TAPE, reel, 0.135 - rnd() * 0.04, 0.135 - rnd() * 0.04, 0.025, 28)
    b.cyl(M.steel, reel.clone().multiply(T(0, -0.014, 0)), 0.15, 0.15, 0.004, 28, { cast: false })
    b.cyl(M.steel, reel, 0.04, 0.04, 0.03, 14)
  }
  b.quad(M.glass, m.clone().multiply(T(0, 1.22, -0.39, Math.PI)), 0.6, 0.78, { cast: false })
  b.boxM(M.darkSteel, m, 0.56, 0.12, 0.012, 0, 0.72, -0.352)
  b.boxM(panelLights, m, 0.5, 0.022, 0.006, 0, 0.74, -0.36, { cast: false })
  for (let k = 0; k < 4; k++) b.rbox(M.beige, m, 0.05, 0.035, 0.02, 0.006, -0.18 + k * 0.12, 0.68, -0.36)
  // Lower door: seam round it, a recessed handle, and a louvred vent of raised slats.
  doorRelief(b, m, 0.62, 0.55, 0.36, -0.351)
  b.collideLocal(m, [-0.37, 0, -0.36], [0.37, 1.8, 0.36])
}

function cabinet(b: Builder, x: number, z: number, yaw: number, disk: boolean) {
  const m = T(x, FLOOR_Y, z, yaw)
  b.rbox(disk ? CAB_BLUE : CAB_GREY, m, 0.8, 1.6, 0.76, 0.03, 0, 0.8, 0)
  b.boxM(M.darkSteel, m, 0.004, 1.5, 0.004, 0, 0.8, -0.381, { cast: false })
  if (disk) {
    b.rbox(M.beige, m, 0.7, 0.3, 0.6, 0.04, 0, 1.75, 0.02)
    b.boxM(SMOKED, m, 0.5, 0.12, 0.004, 0, 1.78, -0.29)
  } else
    b.boxM(panelLights, m, 0.64, 0.28, 0.005, 0, 1.33, -0.382, { cast: false })
  doorRelief(b, m, 0.7, 0.9, 0.5, -0.381)
  b.collideLocal(m, [-0.4, 0, -0.38], [0.4, disk ? 1.9 : 1.6, 0.38])
}

/** Band printer on its stand: rounded chassis, sloped acoustic hood with a smoked window, platen and tractor-feed
 *  slot, control panel with lamps, fanfold paper fed from a box behind and draped down into the catch basket in front. */
function lineprinter(b: Builder, x: number, z: number, yaw: number, rnd: () => number) {
  const m = T(x, FLOOR_Y, z, yaw)
  // Stand: frame and four legs on levelling feet.
  for (const dx of [-0.55, 0.55])
    for (const dz of [-0.3, 0.3]) {
      b.boxM(M.darkSteel, m, 0.04, 0.42, 0.04, dx, 0.21, dz)
      b.boxM(M.rubber, m, 0.06, 0.015, 0.06, dx, 0.008, dz)
    }
  b.boxM(M.darkSteel, m, 1.14, 0.04, 0.64, 0, 0.42, 0)
  // Chassis with panel seams and recessed vent slots on the sides.
  b.rbox(M.beige, m, 1.2, 0.55, 0.72, 0.04, 0, 0.715, 0)
  b.boxM(M.darkSteel, m, 0.004, 0.45, 0.004, 0, 0.7, -0.362, { cast: false })
  for (let k = 0; k < 7; k++) for (const sx of [-1, 1]) b.boxM(M.darkSteel, m, 0.006, 0.012, 0.4, sx * 0.602, 0.56 + k * 0.035, 0, { cast: false })
  // Platen bar and tractor slot across the top.
  b.rbox(CAB_GREY, m, 1.16, 0.06, 0.2, 0.02, 0, 1.02, -0.2)
  b.boxM(M.rubber, m, 1.0, 0.035, 0.06, 0, 1.02, -0.06)
  for (const dx of [-0.42, 0.42]) b.boxM(M.darkSteel, m, 0.05, 0.05, 0.16, dx, 1.03, -0.06)
  // Sloped acoustic hood with a smoked window, hinged at the back.
  const hood = m.clone().multiply(T(0, 1.1, 0.12, 0, -0.32))
  b.rbox(CAB_GREY, hood, 1.18, 0.05, 0.5, 0.03, 0, 0, 0)
  b.boxM(SMOKED, hood, 0.76, 0.012, 0.28, 0, 0.026, -0.02, { cast: false })
  // Control panel on the front right: lamps and buttons.
  const pm = m.clone().multiply(T(0.38, 0.92, -0.36, 0, -0.5))
  b.rbox(M.darkSteel, pm, 0.32, 0.12, 0.03, 0.01)
  b.boxM(panelLights, pm, 0.24, 0.02, 0.006, 0, 0.03, -0.017, { cast: false })
  for (let k = 0; k < 4; k++) b.rbox(k === 3 ? M.red : M.beige, pm, 0.035, 0.03, 0.02, 0.006, -0.1 + k * 0.065, -0.025, -0.018)
  // Fanfold stock in a box behind the stand.
  b.boxM(M.cardboard, m, 0.44, 0.32, 0.32, 0, 0.16, 0.55)
  for (let k = 0; k < 10; k++) b.boxM(M.paper, m, 0.38, 0.004, 0.28, 0, 0.33 + k * 0.004, 0.55 + (rnd() - 0.5) * 0.01, { cast: false })
  // Printed sheet: up out of the slot, over the front edge and down in folds into a wire basket.
  const pts: [number, number][] = [
    [-0.06, 1.05], [-0.2, 1.12], [-0.36, 1.08], [-0.42, 0.95], [-0.44, 0.75], [-0.47, 0.55], [-0.53, 0.38], [-0.62, 0.3],
  ]
  const seg = pts.length - 1
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= seg; i++) for (const u of [-0.19, 0.19]) pos.push(u, pts[i]![1], pts[i]![0])
  for (let i = 0; i < seg; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
  const sheet = new THREE.BufferGeometry()
  sheet.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  sheet.setIndex(idx)
  sheet.computeVertexNormals()
  sheet.applyMatrix4(m)
  b.add(paperTwoSided, sheet, { cast: false })
  // Catch basket: wire frame with a fold pile in it.
  for (const dz of [-0.5, -0.85]) b.rod(M.darkSteel, [-0.25, 0.3, dz], [0.25, 0.3, dz], 0.006, 5)
  for (const dx of [-0.25, 0.25]) {
    b.rod(M.darkSteel, [dx, 0.3, -0.5], [dx, 0.3, -0.85], 0.006, 5)
    b.rod(M.darkSteel, [dx, 0.3, -0.85], [dx, 0.02, -0.85], 0.006, 5)
  }
  for (let k = 0; k < 6; k++) b.boxM(M.paper, m, 0.38, 0.006, 0.28, (rnd() - 0.5) * 0.02, 0.06 + k * 0.007, -0.68, { cast: false })
  b.collideLocal(m, [-0.6, 0, -0.9], [0.6, 1.2, 0.72])
}

export const paperTwoSided = materialFor("flat", { color: 0xcfcbbb, roughness: 0.9, side: THREE.DoubleSide, name: "interior_paper_2s" })

/** Cabinet door detail on a front face at local z: perimeter seam, handle, raised vent louvres. */
export function doorRelief(b: Builder, m: THREE.Matrix4, w: number, h: number, yc: number, z: number) {
  const seam = 0.006
  b.boxM(M.darkSteel, m, w, seam, 0.004, 0, yc + h / 2, z - 0.001, { cast: false })
  b.boxM(M.darkSteel, m, w, seam, 0.004, 0, yc - h / 2, z - 0.001, { cast: false })
  b.boxM(M.darkSteel, m, seam, h, 0.004, -w / 2, yc, z - 0.001, { cast: false })
  b.boxM(M.darkSteel, m, seam, h, 0.004, w / 2, yc, z - 0.001, { cast: false })
  b.boxM(M.darkSteel, m, 0.004, h, 0.004, 0, yc, z - 0.001, { cast: false })
  for (const sx of [-1, 1]) b.rbox(M.steel, m, 0.018, 0.12, 0.025, 0.006, sx * 0.04, yc + 0.05, z - 0.014)
  const n = Math.floor((h * 0.35) / 0.03)
  for (let k = 0; k < n; k++) for (const sx of [-1, 1]) b.boxM(M.frame, m, w / 2 - 0.08, 0.012, 0.014, sx * (w / 4), yc - h / 2 + 0.06 + k * 0.03, z - 0.006)
}

/** A ceiling tile on the floor: whole and skewed, or snapped in two. */
export function fallenTile(b: Builder, x: number, z: number, rnd: () => number) {
  const y = FLOOR_Y
  const yaw = rnd() * Math.PI
  if (rnd() < 0.5) b.boxM("ceiling_tile", T(x + (rnd() - 0.5) * 0.6, y + 0.03, z + (rnd() - 0.5) * 0.6, yaw, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.25), 0.6, 0.02, 1.2)
  else
    for (const s of [-1, 1]) b.boxM("ceiling_tile", T(x + s * 0.35 * Math.cos(yaw), y + 0.015, z + s * 0.35 * Math.sin(yaw), yaw + (rnd() - 0.5) * 0.6, 0, (rnd() - 0.5) * 0.1), 0.55, 0.02, 0.6)
  for (let k = 0; k < 5; k++) b.box(M.debris, x + (rnd() - 0.5) * 1.2, y, z + (rnd() - 0.5) * 1.2, x + (rnd() - 0.5) * 1.2 + 0.04, y + 0.012, z + (rnd() - 0.5) * 1.2 + 0.03, { cast: false })
}

/** Hanging plastic sheet across z0..z1 at x, wrinkled, stopping `gap` short of the floor. */
export function plastic(b: Builder, x: number, z0: number, z1: number, rnd: () => number, gap = 0.04) {
  const w = z1 - z0
  const h = CEIL_Y - FLOOR_Y - gap
  const g = new THREE.PlaneGeometry(w, h, 12, 10)
  const pos = g.getAttribute("position")
  const ph = rnd() * 6
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i)
    const v = pos.getY(i)
    const sag = (v / h + 0.5) * 0
    pos.setZ(i, Math.sin(u * 5.3 + ph) * 0.05 + Math.sin(u * 13 + v * 3 + ph) * 0.015 + sag + (0.5 - v / h) * 0.06)
  }
  g.computeVertexNormals()
  g.applyMatrix4(T(x, CEIL_Y - h / 2, (z0 + z1) / 2, Math.PI / 2))
  b.add(plasticMat, g, { worldUV: false, cast: false })
}

/** Patches of old linoleum and adhesive left on the stripped slab. */
export function slabRemnants(b: Builder, rnd: () => number) {
  for (let k = 0; k < 9; k++) {
    const x = SHELL.x0 + 4 + rnd() * 80
    const w = 0.6 + rnd() * 2.2
    const z0 = -1.6 + rnd() * 1.2
    // Each patch its own layer, so overlapping patches don't fight.
    b.box("linoleum", x, FLOOR_Y, z0, x + w, FLOOR_Y + LAYER * (1 + k * 0.5), z0 + 0.5 + rnd() * 1.4, { cast: false })
  }
}

/** A fitting hanging out of the grid on two wires, a T-bar sagging beside it. */
export function hangingTroffer(b: Builder, x: number, rnd: () => number) {
  const tilt = 0.5 + rnd() * 0.4
  const m = T(x, CEIL_Y - 0.5, 0.15, rnd() * 0.4, 0.1, tilt)
  b.boxM(M.housing, m, 0.6, 0.08, 1.2)
  b.quad(M.diffuserOff, m.clone().multiply(T(0, -0.041, 0, 0, Math.PI / 2)), 0.56, 1.16, { cast: false })
  b.rod(M.rubber, [x - 0.25, CEIL_Y, 0.2], [x - 0.25, CEIL_Y - 0.3, 0.25], 0.004, 4)
  b.rod(M.rubber, [x + 0.25, CEIL_Y, 0.2], [x + 0.2, CEIL_Y - 0.72, 0.0], 0.004, 4)
  b.rod(M.tbar, [x - 1.2, CEIL_Y - 0.01, 0.6], [x + 0.8, CEIL_Y - 0.45 - rnd() * 0.3, 0.55], 0.008, 4)
}

/** Blue tarp hung from the grid over a doorway, sagging and creased. */
export function tarpHung(b: Builder, x: number, zWall: number, rnd: () => number) {
  const w = 2.2
  const h = CEIL_Y - FLOOR_Y - 0.5
  const g = new THREE.PlaneGeometry(w, h, 10, 8)
  const pos = g.getAttribute("position")
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i)
    const v = pos.getY(i)
    pos.setZ(i, Math.sin(u * 4 + rnd() * 0.3) * 0.06 + (0.5 - v / h) * 0.12 + Math.sin(v * 7) * 0.02)
  }
  g.computeVertexNormals()
  g.applyMatrix4(T(x, CEIL_Y - h / 2, zWall + 0.2, 0))
  b.add(M.tarp, g, { worldUV: false, cast: false })
  b.box(M.wood, x - w / 2, CEIL_Y - 0.04, zWall + 0.15, x + w / 2, CEIL_Y - 0.01, zWall + 0.22)
}

/** Tarp spread on the floor under a leak, edges folded, a bucket of brown water on it. */
export function tarpFloor(b: Builder, x: number, z: number, rnd: () => number) {
  const g = new THREE.PlaneGeometry(1.8, 1.4, 8, 6)
  const pos = g.getAttribute("position")
  for (let i = 0; i < pos.count; i++) {
    const e = Math.max(Math.abs(pos.getX(i)) / 0.9, Math.abs(pos.getY(i)) / 0.7)
    pos.setZ(i, e > 0.85 ? 0.03 + rnd() * 0.04 : rnd() * 0.01)
  }
  g.computeVertexNormals()
  g.applyMatrix4(T(x, FLOOR_Y + 0.004, z, 0.3, -Math.PI / 2))
  b.add(M.tarp, g, { worldUV: false, cast: false })
  b.quad(PUDDLE, T(x + 0.2, FLOOR_Y + 0.02, z - 0.1, 0, -Math.PI / 2), 0.9, 0.6, { cast: false })
  b.cyl(M.darkSteel, T(x - 0.4, FLOOR_Y + 0.16, z + 0.3), 0.15, 0.13, 0.3, 16, { open: true })
}

/** Plywood hoarding across the corridor on its studs, hazard tape on it: the east end is closed off. */
export function hoarding(b: Builder, x: number) {
  b.box(M.plywood, x, FLOOR_Y, -1.6, x + 0.018, CEIL_Y, 1.6)
  for (let z = -1.5; z <= 1.6; z += 0.6) b.box(M.wood, x + 0.018, FLOOR_Y, z - 0.02, x + 0.1, CEIL_Y, z + 0.02)
  b.box(M.wood, x + 0.018, FLOOR_Y, -1.6, x + 0.1, FLOOR_Y + 0.05, 1.6)
  b.box(M.wood, x + 0.018, CEIL_Y - 0.05, -1.6, x + 0.1, CEIL_Y, 1.6)
  for (const y of [1.0, 1.25]) b.box(M.hazard, x - 0.004, FLOOR_Y + y, -1.6, x, FLOOR_Y + y + 0.08, 1.6, { cast: false })
  // Seams between sheets.
  b.box(M.darkSteel, x - 0.002, FLOOR_Y, -0.38, x, CEIL_Y, -0.36, { cast: false })
  b.box(M.darkSteel, x - 0.002, FLOOR_Y + 2.44, -1.6, x, FLOOR_Y + 2.45, 1.6, { cast: false })
  b.collide(x - 0.02, FLOOR_Y, -1.6, x + 0.1, CEIL_Y, 1.6)
}
// ------------------------------------------------------------------------------------------------ decay, any axis

/**
 * Plywood hoarding along x at z = at (`axis` "x") or along z at x = at, floor to ceiling, studs on the `studs` side
 * (+1/−1), hazard tape on the other; optional contractor door (plywood leaf in the door system).
 */
export function hoardingWall(b: Builder, o: { axis: "x" | "z"; at: number; from: number; to: number; studs?: 1 | -1; door?: { at: number; id: string; state: DoorState; width?: number } }) {
  const a0 = Math.min(o.from, o.to)
  const a1 = Math.max(o.from, o.to)
  const s = o.studs ?? 1
  const c = o.at
  const holes = o.door ? [{ a0: o.door.at - (o.door.width ?? 0.92) / 2 - 0.05, a1: o.door.at + (o.door.width ?? 0.92) / 2 + 0.05 }] : []
  const spans: [number, number][] = []
  let cur = a0
  for (const h of holes) {
    spans.push([cur, h.a0])
    cur = h.a1
  }
  spans.push([cur, a1])
  const bx = (u0: number, u1: number, d0: number, d1: number, y0: number, y1: number, mat: Mat, cast = true) => {
    if (u1 - u0 < 1e-3) return
    if (o.axis === "x") b.box(mat, u0, y0, Math.min(c + d0, c + d1), u1, y1, Math.max(c + d0, c + d1), { cast })
    else b.box(mat, Math.min(c + d0, c + d1), y0, u0, Math.max(c + d0, c + d1), y1, u1, { cast })
  }
  const head = FLOOR_Y + 2.17
  for (const [u0, u1] of spans) {
    bx(u0, u1, -0.009, 0.009, FLOOR_Y, CEIL_Y, M.plywood)
    for (let u = u0 + 0.05; u < u1; u += 0.6) bx(u - 0.02, u + 0.02, s * 0.009, s * 0.1, FLOOR_Y, CEIL_Y, M.wood)
    for (const yy of [1.0, 1.25]) bx(u0, u1, -s * 0.013, -s * 0.009, FLOOR_Y + yy, FLOOR_Y + yy + 0.08, M.hazard, false)
    if (o.axis === "x") b.collide(u0, FLOOR_Y, c - 0.02, u1, CEIL_Y, c + 0.02)
    else b.collide(c - 0.02, FLOOR_Y, u0, c + 0.02, CEIL_Y, u1)
  }
  bx(a0, a1, s * 0.009, s * 0.1, FLOOR_Y, FLOOR_Y + 0.05, M.wood)
  bx(a0, a1, s * 0.009, s * 0.1, CEIL_Y - 0.05, CEIL_Y, M.wood)
  for (const h of holes) {
    bx(h.a0, h.a1, -0.009, 0.009, head, CEIL_Y, M.plywood)
    bx(h.a0, h.a0 + 0.05, -0.05, 0.05, FLOOR_Y, head, M.wood)
    bx(h.a1 - 0.05, h.a1, -0.05, 0.05, FLOOR_Y, head, M.wood)
  }
  if (o.door) {
    const rot = o.axis === "x" ? (s > 0 ? Math.PI : 0) : s > 0 ? -Math.PI / 2 : Math.PI / 2
    const [x, z] = o.axis === "x" ? [o.door.at, c] : [c, o.door.at]
    doorway(b, { x, z, rot, id: o.door.id, state: o.door.state, width: o.door.width, leaf: M.plywood, glass: "none", wallT: 0.1 })
  }
}

/** Hanging polythene sheet along x at z = at or along z at x = at, `gap` short of the floor; `milky` for the dusty
 *  contractor's sheet. Batten along the top. */
export function plasticSheet(b: Builder, o: { axis: "x" | "z"; at: number; from: number; to: number; gap?: number; milky?: boolean }, rnd: () => number) {
  const a0 = Math.min(o.from, o.to)
  const a1 = Math.max(o.from, o.to)
  const w = a1 - a0
  const h = CEIL_Y - FLOOR_Y - (o.gap ?? 0.05)
  const g = new THREE.PlaneGeometry(w, h, Math.max(8, Math.round(w * 2.5)), 10)
  const pos = g.getAttribute("position")
  const ph = rnd() * 6
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i)
    const v = pos.getY(i)
    pos.setZ(i, Math.sin(u * 5.3 + ph) * 0.05 + Math.sin(u * 13 + v * 3 + ph) * 0.015 + (0.5 - v / h) * 0.05 * Math.sin(u * 2 + ph))
  }
  g.computeVertexNormals()
  const mid = (a0 + a1) / 2
  g.applyMatrix4(o.axis === "x" ? T(mid, CEIL_Y - h / 2, o.at) : T(o.at, CEIL_Y - h / 2, mid, Math.PI / 2))
  b.add(o.milky ? POLY : plasticMat, g, { worldUV: false, cast: false })
  if (o.axis === "x") b.box("metal_galvanized", a0, CEIL_Y - 0.03, o.at - 0.015, a1, CEIL_Y - 0.006, o.at + 0.015, { cast: false })
  else b.box("metal_galvanized", o.at - 0.015, CEIL_Y - 0.03, a0, o.at + 0.015, CEIL_Y - 0.006, a1, { cast: false })
}

/** Blue tarp hung from a batten on a wall face along x (z = at) or along z (x = at), `side` = the room side (+1/−1). */
export function wallTarp(b: Builder, o: { axis: "x" | "z"; at: number; from: number; to: number; side: 1 | -1; drop?: number }, rnd: () => number) {
  const a0 = Math.min(o.from, o.to)
  const a1 = Math.max(o.from, o.to)
  const w = a1 - a0
  const h = o.drop ?? CEIL_Y - FLOOR_Y - 0.5
  const g = new THREE.PlaneGeometry(w, h, Math.max(6, Math.round(w * 4)), 8)
  const pos = g.getAttribute("position")
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i)
    const v = pos.getY(i)
    pos.setZ(i, Math.abs(Math.sin(u * 4 + rnd() * 0.3)) * 0.06 + (0.5 - v / h) * 0.1 + Math.sin(v * 7) * 0.02)
  }
  g.computeVertexNormals()
  const mid = (a0 + a1) / 2
  const d = o.side * 0.04
  g.applyMatrix4(o.axis === "x" ? T(mid, CEIL_Y - h / 2, o.at + d, o.side > 0 ? 0 : Math.PI) : T(o.at + d, CEIL_Y - h / 2, mid, o.side > 0 ? Math.PI / 2 : -Math.PI / 2))
  b.add(M.tarp, g, { worldUV: false, cast: false })
  if (o.axis === "x") b.box(M.wood, a0, CEIL_Y - 0.04, Math.min(o.at, o.at + o.side * 0.06), a1, CEIL_Y - 0.01, Math.max(o.at, o.at + o.side * 0.06))
  else b.box(M.wood, Math.min(o.at, o.at + o.side * 0.06), CEIL_Y - 0.04, a0, Math.max(o.at, o.at + o.side * 0.06), CEIL_Y - 0.01, a1)
}
