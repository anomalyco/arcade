import * as THREE from "three/webgpu"
import { MODELS, type ModelName, yawToward } from "../../render/models"
import { type Builder, CEIL_Y, FLOOR_Y, M, T, glow, paint } from "./kit"
import { placeModels, wastebasket } from "./props"
import { benchRun, bucket } from "./rooms"
import { cabinet as rackCabinet, doorRelief, lineprinter as linePrinterSide, tapeDrive as tapeDriveRaw } from "./furnish"
import { STAIN, PUDDLE, blindMats, fallenTile, hangingTroffer, hoarding, plastic, plasticMat, slabRemnants, tarpFloor, tarpHung } from "./storeys"

// Furniture and fixtures for storey files. FRAME CONVENTION (same as the model library): a fixture stands at (x, z) on
// the floor, its FRONT faces local −Z, so `yaw = yawToward(dx, dz)` turns its front towards (dx, dz); things that
// stand against a wall have their BACK at local +Z (place them so x, z is the footprint centre, back on the wall).
// Everything adds its own colliders. Positions are ground-floor coordinates.

export { benchRun, bucket, doorRelief, wastebasket }
/** Decay pieces (storey 4) and shared decals/materials. */
export { STAIN, PUDDLE, blindMats, plasticMat, fallenTile, hangingTroffer, hoarding, plastic, slabRemnants, tarpFloor, tarpHung }

const frame = (x: number, z: number, yaw: number, y = FLOOR_Y) => T(x, y, z, yaw)
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
  b.boxM(M.stencil, m, 0.16, 0.12, 0.004, 0, 1.75, 0.137, { cast: false })
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
    b.lamp({ kind: "fluorescent", position: p, direction: [0, -1, 0], color: [0.86, 0.95, 0.75], intensity: 6, range: 3, angle: 1.2, penumbra: 0.8, size: 0.5 })
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
export function cubiclePod(b: Builder, x: number, z: number, yaw: number, opts: { tubes?: number[]; terminalEvery?: number; seed?: number } = {}) {
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
      placeModels(b, "office_chair", [{ position: [cp[0], FLOOR_Y, cp[2]], yaw: yaw + (sz > 0 ? 0 : Math.PI) + (rnd() - 0.5) * 1.2, inset: 0.15 }])
    }
}

/** Private office set facing `yaw`: steel desk, task chair behind, two visitor chairs, filing cabinet, coat rack,
 *  phone, optional lit desk lamp. (x, z) is the desk centre. */
export function officeSet(b: Builder, x: number, z: number, yaw: number, opts: { lamp?: boolean; visitors?: number; coat?: boolean; seed?: number } = {}) {
  const m = frame(x, z, yaw)
  const top = FLOOR_Y + MODELS.office_desk.size[1]
  placeModels(b, "office_desk", [{ position: [x, FLOOR_Y, z], yaw }])
  const behind = ptIn(m, 0.1, 0, 0.85)
  placeModels(b, "office_chair", [{ position: [behind[0], FLOOR_Y, behind[2]], yaw: yaw + Math.PI + 0.2, inset: 0.15 }])
  const v = opts.visitors ?? 2
  for (let k = 0; k < v; k++) {
    const p = ptIn(m, (k - (v - 1) / 2) * 0.7, 0, -0.95)
    placeModels(b, "stack_chair", [{ position: [p[0], FLOOR_Y, p[2]], yaw: yaw + (k - 0.5) * 0.3 }])
  }
  const ph = ptIn(m, 0.6, 0, 0.1)
  placeModels(b, "telephone", [{ position: [ph[0], top, ph[2]], yaw: yaw + Math.PI - 0.3, collide: false, blob: 0 }])
  if (opts.lamp !== undefined) {
    const lp = ptIn(m, -0.7, 0, 0.15)
    // deskLamp lives in lights.ts; placed here directly to keep fixtures free of lamp policy.
    placeModels(b, "desk_lamp", [{ position: [lp[0], top, lp[2]], yaw: yaw + Math.PI, collide: false, blob: 0 }])
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
export function lockers(b: Builder, x: number, z: number, yaw: number, n = 6) {
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
  b.boxM(M.concreteSink, m, s, 0.04, s, 0, 0.02, 0)
  b.boxM(M.concreteSink, m, s, h, 0.07, 0, h / 2, -s / 2 + 0.035)
  b.boxM(M.concreteSink, m, s, h, 0.05, 0, h / 2, s / 2 - 0.025)
  for (const sx of [-1, 1]) b.boxM(M.concreteSink, m, 0.05, h, s, sx * (s / 2 - 0.025), h / 2, 0)
  b.rod(M.steel, ptIn(m, -0.15, 0.95, s / 2), ptIn(m, 0.15, 0.95, s / 2), 0.015)
  b.rod(M.steel, ptIn(m, 0, 0.95, s / 2), ptIn(m, 0, 0.88, s / 2 - 0.2), 0.012)
  coll(b, m, s, h, s)
}

// ------------------------------------------------------------------------------------------------ computing

/** A row of mainframe/disk cabinets along local x (front −Z), every `diskEvery`th a disk drive. */
export function rackRow(b: Builder, x: number, z: number, yaw: number, count = 4, diskEvery = 3) {
  for (let k = 0; k < count; k++) {
    const p = ptIn(frame(x, z, yaw), (k - (count - 1) / 2) * 0.82, 0, 0)
    rackCabinet(b, p[0], p[2], yaw, k % diskEvery === diskEvery - 1)
  }
}
/** Tape drive (reels behind smoked glass), front −Z. */
export const tapeDrive = (b: Builder, x: number, z: number, yaw: number, rnd: () => number) => tapeDriveRaw(b, x, z, yaw, rnd)
/** Band printer on its stand with a fanfold sheet into the catch basket, front −Z. */
export const linePrinter = (b: Builder, x: number, z: number, yaw: number, rnd: () => number) => linePrinterSide(b, x, z, yaw, rnd)

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
export function chalkboard(b: Builder, x: number, z: number, yaw: number, w = 2.4, kind: "chalk" | "white" = "chalk") {
  const m = frame(x, z, yaw)
  b.rbox(M.wood, m, w + 0.1, 1.2, 0.03, 0.008, 0, 1.6, 0.015)
  b.boxM(kind === "chalk" ? M.chalkboard : paint(0xd8d8d0, 0.2), m, w, 1.1, 0.006, 0, 1.6, -0.003, { cast: false })
  if (kind === "chalk") for (const [u, v, sw] of [[-0.4, 1.8, 0.9], [0.5, 1.5, 1.1], [0, 1.3, 0.6]]) b.boxM(M.chalkSmear, m, sw!, 0.25, 0.004, u!, v!, -0.008, { cast: false })
  b.boxM("metal_galvanized", m, w, 0.02, 0.07, 0, 1.03, -0.035)
}

/** Papers pinned to a wall in a w × h area centred at (x, y, z), back at +Z. */
export function wallPapers(b: Builder, x: number, y: number, z: number, yaw: number, w: number, h: number, rnd: () => number, n = 8) {
  const m = T(x, y, z, yaw)
  for (let k = 0; k < n; k++) b.quad(M.paper, m.clone().multiply(T((rnd() - 0.5) * (w - 0.2), (rnd() - 0.5) * (h - 0.25), -0.003 - k * 0.0006, Math.PI, 0, (rnd() - 0.5) * 0.1)), 0.21, 0.28, { cast: false })
}

// ------------------------------------------------------------------------------------------------ helpers

function ptIn(m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m)
  return [v.x, v.y, v.z]
}
const dirIn = (yaw: number, fwd: number, down: number): [number, number, number] => [-Math.sin(yaw) * fwd, down, -Math.cos(yaw) * fwd]

export { yawToward }
