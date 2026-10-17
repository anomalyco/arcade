import * as THREE from "three/webgpu"
import { float, floor, fract, hash, mix, positionWorld, step, time, vec3 } from "three/tsl"
import { MODELS, type ModelName, yawToward } from "../../render/models"
import { materialFor } from "../../render/materials"
import { type Builder, FLOOR_Y, M, T, aaFade, aaWindow, paint } from "./kit"
import { type Prop, placeModels, wastebasket } from "./props"
import { benchRun, stool } from "./rooms"
import type { Room, Theme } from "./storeys"
import { DEPTH, rz } from "./storeys"

// Room contents for the upper storeys. Real models (instanced per storey) for the furniture the library has; bevelled
// procedural pieces for period kit it lacks (tape drives, mainframe cabinets, fume hoods, lab benches). Closed rooms get
// the few pieces the facade glass shows, with no shadow casting; open rooms are furnished properly.

const CORE_Z = 16.05
const buckets = new Map<Builder, Map<string, { name: ModelName; cast: boolean; props: Prop[] }>>()

function put(b: Builder, name: ModelName, p: Prop, cast: boolean) {
  let m = buckets.get(b)
  if (!m) buckets.set(b, (m = new Map()))
  // Instanced per 22.5 m stretch of the block, so the view culling in interior.ts can drop far stretches.
  const key = `${name}:${cast}:${Math.floor((p.position[0] + 55) / 22.5)}`
  let e = m.get(key)
  if (!e) m.set(key, (e = { name, cast, props: [] }))
  e.props.push(p)
}

export function flushModels(b: Builder) {
  for (const e of buckets.get(b)?.values() ?? []) placeModels(b, e.name, e.props, { cast: e.cast })
  buckets.delete(b)
}

/** Blinking indicator lamps on computer cabinets: each lamp its own rate and colour. */
const panelLights = (() => {
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

const CAB_GREY = paint(0x858c8e, 0.5, 0.2)
const CAB_BLUE = paint(0x3d4f63, 0.45, 0.25)
const SMOKED = paint(0x0b0e0f, 0.06)
const TAPE = paint(0x1a130d, 0.35)
const HOOD = paint(0xa7aca4, 0.45, 0.15)

let chemistryPlaced = new Set<number>()

export function furnish(b: Builder, theme: Theme, r: Room, rnd: () => number) {
  if (theme === "offices") offices(b, r, rnd)
  else if (theme === "labs") labs(b, r, rnd)
  else if (theme === "records") (r.index % 2 === 1 ? computerRoom : recordsRoom)(b, r, rnd)
  else abandoned(b, r, rnd)
}

const fc = (r: Room) => (r.side > 0 ? 0 : Math.PI)
const fw = (r: Room) => fc(r) + Math.PI
const at = (r: Room, x: number, v: number, y = FLOOR_Y) => [x, y, rz(r, v)] as const
/** Depth limit at one side of the room (the core notch stops things short). */
const vMax = (r: Room, xSide: "x0" | "x1") => ((xSide === "x0" ? r.wx0 > r.x0 : r.wx1 < r.x1) ? CORE_Z - 1.75 - 0.15 : DEPTH - 0.4)

function paperStack(b: Builder, x: number, y: number, z: number, yaw: number, rnd: () => number) {
  const n = 2 + Math.floor(rnd() * 5)
  for (let k = 0; k < n; k++) b.boxM(M.paper, T(x, y + 0.004 + k * 0.006, z, yaw + (rnd() - 0.5) * 0.3), 0.22, 0.005, 0.29, 0, 0, 0, { cast: false })
}

// ------------------------------------------------------------------------------------------------ offices
function offices(b: Builder, r: Room, rnd: () => number) {
  const full = r.unlocked
  const cast = r.unlocked
  const cx = (r.wx0 + r.wx1) / 2
  const deskTop = FLOOR_Y + MODELS.office_desk.size[1]
  const rows = full ? [16.4, 10.6] : [16.4]
  for (const [ri, v] of rows.entries()) {
    for (const [k, dx] of [-1.12, 1.12].entries()) {
      if (ri > 0 && k === 1 && !r.unlocked) continue
      const x = cx + dx
      const yaw = fc(r) + (rnd() - 0.5) * 0.06
      put(b, "office_desk", { position: at(r, x, v), yaw }, cast)
      const chairYaw = fw(r) + (rnd() - 0.5) * 0.9
      put(b, "office_chair", { position: at(r, x + (rnd() - 0.5) * 0.4, v - (0.7 + rnd() * 0.3)), yaw: chairYaw, inset: 0.15 }, cast)
      if ((k + ri) % 2 === 0) put(b, "crt_terminal", { position: at(r, x - 0.35, v + 0.1, deskTop), yaw: fc(r) + 0.1, collide: false, blob: 0 }, false)
      else put(b, "telephone", { position: at(r, x + 0.55, v + 0.15, deskTop), yaw: fc(r) - 0.3, collide: false, blob: 0 }, false)
      paperStack(b, x + 0.2, deskTop, rz(r, v - 0.05), rnd() * 0.4, rnd)
      if (rnd() < 0.5) wastebasket(b, x + 0.85, rz(r, v - 0.6))
      if (full && (k + ri) % 2 === 1 && rnd() < 0.5) put(b, "desk_fan", { position: at(r, x - 0.7, v + 0.2, deskTop), yaw: fc(r) + (rnd() - 0.5) * 0.8, collide: false, blob: 0 }, false)
    }
  }
  // Filing cabinets along the side wall.
  const n = full ? 4 : 2
  const fx = r.x0 + MODELS.filing_cabinet.size[2] / 2 + 0.02
  for (let k = 0; k < n; k++) {
    const v = 2.4 + k * 0.48
    if (r.unlocked && k === 2) put(b, "filing_cabinet_open", { position: at(r, r.x0 + MODELS.filing_cabinet_open.size[2] / 2 + 0.02, v + 0.1), yaw: yawToward(1, 0), inset: 0.05 }, cast)
    else put(b, "filing_cabinet", { position: at(r, fx, v), yaw: yawToward(1, 0) }, cast)
  }
  if (r.unlocked) {
    if (rnd() < 0.6) put(b, "coat_rack", { position: at(r, r.x1 - 0.35, 0.5), yaw: rnd() * 6, inset: 0.08 }, cast)
    put(b, "cardboard_box", { position: at(r, r.x1 - 0.4, 3.0), yaw: rnd() }, cast)
    put(b, "cardboard_box", { position: at(r, r.x1 - 0.42, 3.0, FLOOR_Y + MODELS.cardboard_box.size[1]), yaw: rnd(), collide: false, blob: 0 }, cast)
    put(b, "stack_chair", { position: at(r, r.x1 - 0.5, 6.5), yaw: yawToward(-1, 0) }, cast)
  }
}

// ------------------------------------------------------------------------------------------------ labs
function labs(b: Builder, r: Room, rnd: () => number) {
  const full = r.unlocked
  const cast = r.unlocked
  const top = FLOOR_Y + 0.935
  const v0 = 2.6
  const v1 = vMax(r, "x0")
  const za = rz(r, v0)
  const zb = rz(r, v1)
  benchRun(b, "z", Math.min(za, zb), Math.max(za, zb), r.x0, r.x0 + 0.68)
  if (full) for (let v = v0 + 1; v < v1 - 0.6; v += 5.2) put(b, "glassware", { position: at(r, r.x0 + 0.36, v, top), yaw: yawToward(1, 0) + (rnd() - 0.5) * 0.4, collide: false, blob: 0 }, false)
  if (full) {
    const w1 = vMax(r, "x1")
    const hoodV = Math.min(w1 - 1.0, 13.5)
    const zc = rz(r, v0)
    const zd = rz(r, hoodV - 1.0)
    benchRun(b, "z", Math.min(zc, zd), Math.max(zc, zd), r.x1, r.x1 - 0.68)
    fumeHood(b, r.x1, rz(r, hoodV), -1)
    // Island table with stools.
    const cx = (r.x0 + 0.68 + r.x1 - 0.68) / 2
    island(b, cx, rz(r, 8.4), 2.6, 1.3, r.side)
    for (const [dx, dv] of [
      [-0.7, -1.0],
      [0.6, -1.05],
      [-0.5, 1.0],
      [0.75, 0.95],
    ] as const)
      stool(b, cx + dx + (rnd() - 0.5) * 0.15, rz(r, 8.4 + dv))
    if (r.unlocked) {
      put(b, "microscope", { position: at(r, cx - 0.6, 8.3, FLOOR_Y + 0.92), yaw: fw(r) + 0.4, collide: false, blob: 0 }, false)
      put(b, "glassware", { position: at(r, cx + 0.6, 8.5, FLOOR_Y + 0.92), yaw: rnd() * 6, collide: false, blob: 0 }, false)
      if (!chemistryPlaced.has(b.storey)) {
        chemistryPlaced.add(b.storey)
        put(b, "chemistry_set", { position: at(r, r.x1 - 0.36, v0 + 1.6, top), yaw: yawToward(-1, 0), collide: false, blob: 0 }, false)
      }
      put(b, "filing_cabinet", { position: at(r, r.x1 - 0.28, hoodV + 1.2), yaw: yawToward(-1, 0) }, cast)
    }
  }
}

function island(b: Builder, x: number, z: number, w: number, d: number, side: number) {
  const y = FLOOR_Y
  const x0 = x - w / 2
  const x1 = x + w / 2
  const z0 = z - d / 2
  const z1 = z + d / 2
  b.box(M.epoxy, x0, y + 0.88, z0, x1, y + 0.92, z1)
  b.box(M.cabinet, x0 + 0.05, y + 0.8, z0 + 0.05, x1 - 0.05, y + 0.88, z1 - 0.05)
  for (const lx of [x0 + 0.08, x1 - 0.08]) for (const lz of [z0 + 0.08, z1 - 0.08]) b.box(M.cabinet, lx - 0.025, y, lz - 0.025, lx + 0.025, y + 0.8, lz + 0.025)
  // Service spine: gas taps and an outlet strip down the middle.
  b.rbox(M.cabinet, T(x, y + 1.0, z), w - 0.4, 0.16, 0.12, 0.02)
  for (let k = 0; k < 4; k++) b.cyl(M.steel, T(x0 + 0.5 + k * ((w - 1) / 3), y + 1.1, z + 0.07 * side, 0, Math.PI / 2), 0.008, 0.008, 0.08, 8)
  b.collide(x0, y, z0, x1, y + 1.1, z1)
}

/** Enclosed fume hood against a side wall (front facing `facing` along x), with sash glass and its duct. */
function fumeHood(b: Builder, xWall: number, z: number, facing: 1 | -1) {
  const y = FLOOR_Y
  const cx = xWall + facing * 0.42
  const m = T(cx, y, z, facing > 0 ? -Math.PI / 2 : Math.PI / 2)
  b.rbox(HOOD, m, 1.5, 0.9, 0.82, 0.02, 0, 0.45, 0)
  b.rbox(M.epoxy, m, 1.52, 0.04, 0.84, 0.01, 0, 0.92, 0)
  b.rbox(HOOD, m, 1.5, 0.22, 0.82, 0.03, 0, 2.2, 0)
  b.rbox(HOOD, m, 0.1, 1.2, 0.82, 0.02, -0.7, 1.54, 0)
  b.rbox(HOOD, m, 0.1, 1.2, 0.82, 0.02, 0.7, 1.54, 0)
  b.boxM(M.darkSteel, m, 1.3, 1.2, 0.02, 0, 1.54, 0.38)
  b.boxM(M.frame, m, 1.32, 0.04, 0.04, 0, 1.45, -0.4)
  b.quad(M.glass, m.clone().multiply(T(0, 1.62, -0.41, Math.PI)), 1.3, 0.34, { cast: false })
  b.quad(M.glass, m.clone().multiply(T(0, 1.14, -0.37, Math.PI)), 1.3, 0.56, { cast: false })
  b.cyl("metal_galvanized", T(cx, (y + 2.31 + 3.1) / 2, z), 0.13, 0.13, 3.1 - y - 2.31, 14)
  b.collide(cx - 0.42, y, z - 0.75, cx + 0.42, y + 2.3, z + 0.75)
}

// ------------------------------------------------------------------------------------------------ records
function computerRoom(b: Builder, r: Room, rnd: () => number) {
  const full = r.unlocked
  const cast = r.unlocked
  const v1 = vMax(r, "x0")
  // Tape drives in a row along the left wall, reels behind smoked glass.
  const n = full ? Math.floor((v1 - 2.5) / 0.8) : 3
  for (let k = 0; k < n; k++) tapeDrive(b, r.x0 + 0.37, rz(r, v1 - 0.45 - k * 0.8), yawToward(1, 0), rnd)
  // Processor and disk cabinets down the right wall.
  const w1 = vMax(r, "x1")
  const m = full ? Math.floor((w1 - 3) / 0.85) : 2
  for (let k = 0; k < m; k++) cabinet(b, r.x1 - 0.4, rz(r, w1 - 0.5 - k * 0.85), yawToward(-1, 0), k % 3 === 2)
  // Operator's console near the windows.
  const cx = (r.wx0 + r.wx1) / 2
  put(b, "office_desk", { position: at(r, cx, 16.8), yaw: fc(r) }, cast)
  put(b, "crt_terminal", { position: at(r, cx - 0.4, 16.9, FLOOR_Y + MODELS.office_desk.size[1]), yaw: fc(r), collide: false, blob: 0 }, false)
  put(b, "crt_terminal", { position: at(r, cx + 0.45, 16.9, FLOOR_Y + MODELS.office_desk.size[1]), yaw: fc(r) - 0.15, collide: false, blob: 0 }, false)
  put(b, "office_chair", { position: at(r, cx, 15.9), yaw: fw(r) + (rnd() - 0.5) * 0.6, inset: 0.15 }, cast)
  if (full) lineprinter(b, cx + 0.2, rz(r, 6), r.side, rnd)
}

function tapeDrive(b: Builder, x: number, z: number, yaw: number, rnd: () => number) {
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
function lineprinter(b: Builder, x: number, z: number, side: number, rnd: () => number) {
  const m = T(x, FLOOR_Y, z, side > 0 ? 0 : Math.PI)
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

const paperTwoSided = materialFor("flat", { color: 0xcfcbbb, roughness: 0.9, side: THREE.DoubleSide, name: "interior_paper_2s" })

/** Cabinet door detail on a front face at local z: perimeter seam, handle, raised vent louvres. */
function doorRelief(b: Builder, m: THREE.Matrix4, w: number, h: number, yc: number, z: number) {
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

function recordsRoom(b: Builder, r: Room, rnd: () => number) {
  const full = r.unlocked
  const cast = r.unlocked
  const [w, , d] = MODELS.steel_shelves.size
  const rows = full ? 6 : 2
  for (let k = 0; k < rows; k++) {
    const v = 18.2 - k * 2.2
    if (v < 2.5) break
    const x = r.wx0 + 0.15 + w / 2
    if (x + w / 2 > r.wx1) continue
    put(b, "steel_shelves", { position: at(r, x, v), yaw: fc(r), inset: 0.04 }, cast)
    if (full && rnd() < 0.7) put(b, "cardboard_box", { position: at(r, x + w / 2 + 0.35, v - d / 2 + 0.3), yaw: rnd() * 0.5 }, cast)
  }
  const fx = r.x1 - MODELS.filing_cabinet.size[2] / 2 - 0.02
  const n = full ? 10 : 3
  for (let k = 0; k < n; k++) put(b, "filing_cabinet", { position: at(r, fx, 2.4 + k * 0.46), yaw: yawToward(-1, 0) }, cast)
}

// ------------------------------------------------------------------------------------------------ abandoned
function abandoned(b: Builder, r: Room, rnd: () => number) {
  const cast = r.unlocked
  const cx = (r.wx0 + r.wx1) / 2
  // A desk shoved askew, chairs knocked over, cabinets left open; one cabinet face down.
  put(b, "office_desk", { position: at(r, cx + (rnd() - 0.5) * 1.5, 13 + rnd() * 3), yaw: fc(r) + (rnd() - 0.5) * 1.2 }, cast)
  const chairs = r.unlocked ? 5 : 2
  for (let k = 0; k < chairs; k++) {
    const tipped = rnd() < 0.6
    const p = at(r, r.x0 + 0.6 + rnd() * (r.x1 - r.x0 - 1.2), 3 + rnd() * 10, tipped ? FLOOR_Y + 0.3 : FLOOR_Y)
    put(b, "stack_chair", { position: p, yaw: rnd() * 6.28, ...(tipped ? { tilt: new THREE.Euler(rnd() < 0.5 ? Math.PI / 2 : -Math.PI / 2, 0, 0) } : {}) }, cast)
  }
  if (r.unlocked) {
    put(b, "filing_cabinet_open", { position: at(r, r.x0 + 0.55, 3.2), yaw: yawToward(1, 0), inset: 0.05 }, cast)
    put(b, "filing_cabinet", { position: at(r, cx, 8, FLOOR_Y + MODELS.filing_cabinet.size[2] / 2), yaw: fc(r) + 0.3, tilt: new THREE.Euler(-Math.PI / 2, 0, 0) }, cast)
    b.collide(cx - 0.7, FLOOR_Y, rz(r, 8) - 0.7, cx + 0.7, FLOOR_Y + 0.5, rz(r, 8) + 0.7)
    for (let k = 0; k < 3; k++) put(b, "cardboard_box", { position: at(r, r.x1 - 0.4 - rnd() * 0.3, 2.5 + k * 0.6), yaw: rnd() }, cast)
    put(b, "office_chair", { position: at(r, cx + 1.2, 11, FLOOR_Y + 0.38), yaw: rnd() * 6, tilt: new THREE.Euler(0, 0, Math.PI / 2) }, cast)
  }
}

export function resetFurnish() {
  chemistryPlaced = new Set()
}

/** Stacking chairs round the lounge table. */
export function loungeChairs(b: Builder, r: Room, x: number, v: number, rnd: () => number) {
  for (let k = 0; k < 3; k++) {
    const a = k * 2.1 + rnd() * 0.4
    put(b, "stack_chair", { position: at(r, x + Math.cos(a) * 0.75, v + Math.sin(a) * 0.75), yaw: yawToward(-Math.cos(a), -Math.sin(a) * r.side) + (rnd() - 0.5) * 0.4 }, true)
  }
}

/** Storage nook contents: chairs stacked in towers, boxes, a rack. */
export function furnishNook(b: Builder, r: Room, back: number, rnd: () => number) {
  const n = Math.floor((r.x1 - r.x0 - 0.6) / 0.62)
  for (let k = 0; k < n; k++) {
    const x = r.x0 + 0.45 + k * 0.62
    const h = 2 + Math.floor(rnd() * 4)
    for (let j = 0; j < h; j++) put(b, "stack_chair", { position: at(r, x, back - 0.45, FLOOR_Y + j * 0.11), yaw: fw(r), collide: j === 0, blob: j === 0 ? 1.2 : 0 }, false)
  }
  for (let k = 0; k < 4; k++) put(b, "cardboard_box", { position: at(r, r.x0 + 0.4 + rnd() * (r.x1 - r.x0 - 0.8), 1.2 + rnd() * 0.8), yaw: rnd() * 3 }, false)
}
