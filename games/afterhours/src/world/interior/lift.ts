import * as THREE from "three/webgpu"
import { float, floor, fract, hash, mix, positionWorld, smoothstep, vec2, vec3 } from "three/tsl"
import type { Box, Floor, Lamp, WorldContext } from "../context"
import { ROOF_Y } from "../layout"
import { materialFor } from "../../render/materials"
import { Builder, FLOOR_Y, TUBE, fluorescentPanel, glow, M, STOREY_H, T, type Band, corridorBands, flicker, wall } from "./kit"
import { LOBBY, STOREYS } from "./core"
import { STYLES } from "./styles"

// A working lift in the core: walk in, press E at the car panel (next storey up, wrapping to the ground floor) or at a
// landing's call button. The scissor gate and landing doors close, the car lurches, grinds up or down the shaft past
// the other landings, sometimes stalls between floors with the light dying, then levels and opens. The car floor is a
// live ctx.floors entry and the landing doors are colliders that open only where the car stands.

const SHAFT = { x0: -39.5, x1: -36.32, z0: 19.6, z1: 24.81 }
const CAR = { x0: -38.95, x1: -36.75, z0: 19.68, z1: 22.28, h: 2.32 }
const DOOR = { c: -37.85, w: 1.1, h: 2.1 }
const DX0 = DOOR.c - DOOR.w / 2
const DX1 = DOOR.c + DOOR.w / 2
const CALL = { x: -36.82, y: 1.15, z: LOBBY.z1 }
const TOP = ROOF_Y - 0.15
const LEVELS = STOREYS // storeys served: 0..STOREYS-1
const carFloorY = (s: number) => FLOOR_Y + s * STOREY_H

const shaftBands: Band[] = [[0, 99, M.concrete]]

/** Brushed, scratched stainless: fine vertical grain, random scratches, smudged lower panels. */
function scratchedSteel() {
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0.92 })
  const p = positionWorld
  const grain = hash(floor(p.x.add(p.z).mul(900)).add(floor(p.y.mul(6)).mul(131)))
  const scratchCell = floor(vec2(p.x.add(p.z).mul(14), p.y.mul(14)))
  const sc = hash(scratchCell.x.add(scratchCell.y.mul(57)))
  const local = fract(vec2(p.x.add(p.z).mul(14), p.y.mul(14)))
  const line = float(1).sub(smoothstep(0.0, 0.03, local.x.sub(local.y.mul(sc.sub(0.5).mul(1.6))).sub(0.5).abs()))
  const scratch = line.mul(smoothstep(0.82, 0.9, sc))
  const smudge = hash(floor(p.mul(3)).dot(vec3(1, 17, 41))).mul(0.15)
  m.colorNode = mix(vec3(0.42, 0.43, 0.42), vec3(0.62, 0.62, 0.6), grain.mul(0.4).add(scratch.mul(0.6)))
  m.roughnessNode = float(0.32).add(grain.mul(0.1)).add(smudge).sub(scratch.mul(0.15))
  m.name = "interior_scratched_steel"
  return m
}

type Phase = "idle" | "closing" | "depart" | "moving" | "stall" | "level" | "opening"

export function buildLift(ctx: WorldContext, parent: THREE.Object3D) {
  const steel = scratchedSteel()
  const shaft = new Builder(ctx, "lift-shaft")
  const doorColliders: Box[] = []
  const OPEN_BOX: Box = { min: [0, -100, 0], max: [0, -100, 0] }

  for (let s = 0; s < LEVELS; s++) {
    shaft.storey = s
    const ext = { y0: FLOOR_Y - 0.26, y1: FLOOR_Y + STOREY_H - 0.26 }
    const opening = [{ a0: DX0 - 0.06, a1: DX1 + 0.06, top: DOOR.h + 0.06 }]
    // Shaft north wall: tiled lobby face, bare concrete on the shaft side, cut for the landing doors.
    wall(shaft, "x", SHAFT.x0, -36.15, LOBBY.z1, 19.53, STYLES[s]!.bands, opening)
    wall(shaft, "x", SHAFT.x0, -36.15, 19.53, SHAFT.z0, shaftBands, opening, { ...ext, collide: false })
    wall(shaft, "z", LOBBY.z1, SHAFT.z1 + 0.14, SHAFT.x1, -36.15, shaftBands, [], ext)
    wall(shaft, "x", SHAFT.x0, -36.15, SHAFT.z1, SHAFT.z1 + 0.14, shaftBands, [{ a0: SHAFT.x0, a1: -39.13, bottom: 0.84, top: 2.66 }], { ...ext, collide: false })
    shaft.box(M.concrete, SHAFT.x0, ext.y0, SHAFT.z0, SHAFT.x0 + 0.02, ext.y1, SHAFT.z1, { cast: false })
    const y = FLOOR_Y
    // Door frame, sill, call button and the floor dial over the doors.
    const F = T(DOOR.c, y, LOBBY.z1 - 0.01)
    shaft.rbox(steel, F, 0.08, DOOR.h + 0.08, 0.06, 0.01, -DOOR.w / 2 - 0.04, (DOOR.h + 0.08) / 2, 0)
    shaft.rbox(steel, F, 0.08, DOOR.h + 0.08, 0.06, 0.01, DOOR.w / 2 + 0.04, (DOOR.h + 0.08) / 2, 0)
    shaft.rbox(steel, F, DOOR.w + 0.16, 0.08, 0.06, 0.01, 0, DOOR.h + 0.04, 0)
    shaft.box(M.steel, DX0, y - 0.01, LOBBY.z1 - 0.04, DX1, y + 0.004, CAR.z0, { cast: false })
    for (let k = 0; k < 12; k++) shaft.box(M.darkSteel, DX0 + 0.04 + k * 0.088, y + 0.004, LOBBY.z1, DX0 + 0.06 + k * 0.088, y + 0.008, CAR.z0 - 0.02, { cast: false })
    shaft.walk(DX0, LOBBY.z1 - 0.05, DX1, CAR.z0 + 0.01, y + 0.004)
    shaft.rbox(steel, T(CALL.x, y + CALL.y, CALL.z - 0.006), 0.12, 0.26, 0.012, 0.004)
    shaft.cyl(M.darkSteel, T(CALL.x, y + CALL.y + 0.04, CALL.z - 0.014, 0, Math.PI / 2), 0.026, 0.026, 0.012, 16)
    shaft.cyl(M.beige, T(CALL.x, y + CALL.y + 0.04, CALL.z - 0.022, 0, Math.PI / 2), 0.018, 0.018, 0.008, 16)
    const dial = T(DOOR.c, y + DOOR.h + 0.32, LOBBY.z1 - 0.02, 0, Math.PI / 2)
    const plate = new THREE.CylinderGeometry(0.2, 0.2, 0.02, 24, 1, false, -Math.PI / 2, Math.PI)
    plate.applyMatrix4(dial)
    shaft.add(steel, plate)
    shaft.box(M.felt, DOOR.c - 0.17, y + DOOR.h + 0.33, LOBBY.z1 - 0.032, DOOR.c + 0.17, y + DOOR.h + 0.5, LOBBY.z1 - 0.031, { cast: false })
    for (let k = 0; k < LEVELS; k++) {
      const a = needleAngle(k)
      shaft.box(M.stencil, DOOR.c + Math.sin(a) * 0.15 - 0.006, y + DOOR.h + 0.32 + Math.cos(a) * 0.15, LOBBY.z1 - 0.034, DOOR.c + Math.sin(a) * 0.15 + 0.006, y + DOOR.h + 0.32 + Math.cos(a) * 0.15 + 0.02, LOBBY.z1 - 0.033, { cast: false })
    }
    // Storey marks painted inside the shaft beside each landing, seen through the gate on the way past.
    for (let k = 0; k <= s; k++) shaft.box(M.stencil, DX1 + 0.25 + k * 0.1, y + 1.2, SHAFT.z0, DX1 + 0.31 + k * 0.1, y + 1.7, SHAFT.z0 + 0.003, { cast: false })
    shaft.box(M.safety, DX0 - 0.3, y + 2.4, SHAFT.z0, DX1 + 0.3, y + 2.5, SHAFT.z0 + 0.003, { cast: false })
    // Landing door collider: open only while the car stands here with its doors open.
    const box: Box = { min: [DX0, carFloorY(s), LOBBY.z1 - 0.02], max: [DX1, carFloorY(s) + DOOR.h, SHAFT.z0 + 0.08] }
    ctx.colliders.push(box)
    doorColliders.push(box)
  }
  shaft.storey = 0
  // Guide rails, counterweight rails, the beam and sheave at the top of the shaft, trailing cable.
  const rail = (x: number, z: number) => shaft.box(M.darkSteel, x - 0.03, 0, z - 0.05, x + 0.03, TOP, z + 0.05)
  rail(SHAFT.x0 + 0.06, 20.98)
  rail(SHAFT.x1 - 0.06, 20.98)
  rail(-38.75, 24.4)
  rail(-36.95, 24.4)
  shaft.box(M.darkSteel, SHAFT.x0, TOP - 0.3, 20.8, SHAFT.x1, TOP, 21.15)
  shaft.cyl(M.darkSteel, T(DOOR.c, TOP - 0.55, 22.6, 0, 0, Math.PI / 2), 0.5, 0.5, 0.16, 28)
  shaft.cyl(M.steel, T(DOOR.c, TOP - 0.55, 22.6, 0, 0, Math.PI / 2), 0.08, 0.08, 0.3, 12)
  shaft.box(M.darkSteel, -36.6, 0, 22.9, -36.56, TOP, 22.94)
  shaft.flush(parent)
  for (const m of shaft.group.children) m.castShadow = false

  // ---------------------------------------------------------------- car
  const carRoot = new THREE.Group()
  carRoot.name = "interior:lift-car"
  const car = new Builder(ctx, "lift-car-body")
  const { x0, x1, z0, z1, h } = CAR
  car.box(M.rubber, x0, -0.1, z0, x1, 0, z1)
  for (let k = 0; k < 26; k++) car.box(M.darkSteel, x0 + 0.04, 0, z0 + 0.06 + k * 0.1, x1 - 0.04, 0.004, z0 + 0.08 + k * 0.1, { cast: false })
  car.box(steel, x0 - 0.04, 0, z0, x0, h, z1)
  car.box(steel, x1, 0, z0, x1 + 0.04, h, z1)
  car.box(steel, x0 - 0.04, 0, z1, x1 + 0.04, h, z1 + 0.04)
  car.box(steel, x0, 0, z0 - 0.04, DX0, h, z0)
  car.box(steel, DX1, 0, z0 - 0.04, x1, h, z0)
  car.box(steel, DX0, DOOR.h, z0 - 0.04, DX1, h, z0)
  car.box(M.darkSteel, x0 - 0.04, h, z0 - 0.04, x1 + 0.04, h + 0.06, z1 + 0.04)
  // Panelled walls: seams and a dark kick band.
  for (const z of [z0 + 0.86, z0 + 1.73]) {
    car.box(M.darkSteel, x0, 0.12, z - 0.006, x0 + 0.004, h - 0.05, z + 0.006, { cast: false })
    car.box(M.darkSteel, x1 - 0.004, 0.12, z - 0.006, x1, h - 0.05, z + 0.006, { cast: false })
  }
  car.box(M.darkSteel, x0, 0, z0, x0 + 0.006, 0.12, z1, { cast: false })
  car.box(M.darkSteel, x1 - 0.006, 0, z0, x1, 0.12, z1, { cast: false })
  car.box(M.darkSteel, x0, 0, z1 - 0.006, x1, 0.12, z1, { cast: false })
  // Handrails on standoffs.
  for (const [p0, p1] of [
    [[x0 + 0.06, 0.92, z0 + 0.4], [x0 + 0.06, 0.92, z1 - 0.15]],
    [[x1 - 0.06, 0.92, z0 + 0.6], [x1 - 0.06, 0.92, z1 - 0.15]],
    [[x0 + 0.15, 0.92, z1 - 0.06], [x1 - 0.15, 0.92, z1 - 0.06]],
  ] as const) {
    car.rod(M.steel, p0, p1, 0.019, 12)
    for (const t of [0.1, 0.9]) {
      const q = [p0[0] + (p1[0] - p0[0]) * t, 0.92, p0[2] + (p1[2] - p0[2]) * t]
      car.rod(M.steel, q, [q[0]! + (q[0]! < -37.85 ? -0.05 : q[0]! > -37.85 && Math.abs(p0[2] - p1[2]) > 0.1 ? 0.05 : 0), 0.92, q[2]! + (Math.abs(p0[2] - p1[2]) < 0.1 ? 0.05 : 0)], 0.01, 8)
    }
  }
  // Suspended ceiling: egg-crate grille under the light, black reveal round it.
  car.box(M.darkSteel, x0, h - 0.02, z0, x1, h, z1, { cast: false })
  for (let k = 1; k < 11; k++) car.box(M.darkSteel, x0 + 0.3 + k * 0.145, h - 0.12, z0 + 0.35, x0 + 0.305 + k * 0.145, h - 0.02, z1 - 0.35, { cast: false })
  for (let k = 1; k < 13; k++) car.box(M.darkSteel, x0 + 0.3, h - 0.12, z0 + 0.35 + k * 0.145, x1 - 0.3, h - 0.02, z0 + 0.355 + k * 0.145, { cast: false })
  // Car operating panel on the front return, right of the door: floor buttons, alarm, key switch.
  const panelX = (DX1 + x1) / 2
  const P = T(panelX, 1.05, z0 + 0.008)
  car.rbox(steel, P, 0.24, 0.62, 0.016, 0.006)
  for (let k = 0; k < LEVELS; k++) {
    const by = buttonY(k)
    car.cyl(M.darkSteel, P.clone().multiply(T(0, by, 0.012, 0, Math.PI / 2)), 0.026, 0.026, 0.01, 16)
    car.cyl(M.beige, P.clone().multiply(T(0, by, 0.018, 0, Math.PI / 2)), 0.019, 0.019, 0.006, 16)
    for (let n = 0; n <= k; n++) car.box(M.stencil, panelX - 0.075 - n * 0.012, 1.05 + by - 0.012, z0 + 0.017, panelX - 0.068 - n * 0.012, 1.05 + by + 0.012, z0 + 0.018, { cast: false })
  }
  car.cyl(M.red, P.clone().multiply(T(0, -0.24, 0.016, 0, Math.PI / 2)), 0.024, 0.024, 0.012, 16)
  car.cyl(M.darkSteel, P.clone().multiply(T(0, 0.25, 0.014, 0, Math.PI / 2)), 0.018, 0.018, 0.01, 12)
  car.box(M.steel, panelX - 0.003, 1.3 - 0.012, z0 + 0.02, panelX + 0.003, 1.3 + 0.012, z0 + 0.026)
  // Position indicator: a row of lamps over the door (the lit one is a separate mesh).
  for (let k = 0; k < LEVELS; k++) car.cyl(M.diffuserOff, T(indicatorX(k), DOOR.h + 0.12, z0 + 0.005, 0, Math.PI / 2), 0.022, 0.022, 0.01, 14, { cast: false })
  // Inspection certificate frame (blank) and scuffs.
  car.rbox(M.frame, T(x0 + 0.008, 1.55, z1 - 0.5, Math.PI / 2), 0.24, 0.3, 0.012, 0.004)
  car.quad(M.paper, T(x0 + 0.016, 1.55, z1 - 0.5, Math.PI / 2), 0.2, 0.26, { cast: false })
  // Sling, crosshead and the rope hitch above the car roof.
  car.box(M.darkSteel, x0 - 0.1, -0.2, 20.9, x0 - 0.04, h + 0.5, 21.06)
  car.box(M.darkSteel, x1 + 0.04, -0.2, 20.9, x1 + 0.1, h + 0.5, 21.06)
  car.box(M.darkSteel, x0 - 0.1, h + 0.4, 20.9, x1 + 0.1, h + 0.55, 21.06)
  car.box(M.darkSteel, x0 - 0.1, -0.25, z0, x1 + 0.1, -0.1, z1)
  car.box(M.steel, DOOR.c - 0.12, h + 0.55, 20.92, DOOR.c + 0.12, h + 0.65, 21.04)
  car.flush(carRoot)

  // Fluorescent panel in the ceiling, flickering.
  const { material: panelMat, level: carLevel } = fluorescentPanel(1)
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 - 0.62, z1 - z0 - 0.72), panelMat)
  panel.rotation.x = Math.PI / 2
  panel.position.set((x0 + x1) / 2, h - 0.13, (z0 + z1) / 2)
  carRoot.add(panel)

  // Scissor gate: diagonal lattice spanning the doorway, scaled along x as it folds against the right jamb.
  const gate = new Builder(ctx, "lift-gate")
  const gw = DOOR.w
  const n = 7
  for (let k = 0; k < n; k++) {
    const xa = -gw + (k / n) * gw
    const xb = -gw + ((k + 1) / n) * gw
    for (const [ya, yb] of [
      [0.08, DOOR.h * 0.5],
      [DOOR.h * 0.5, DOOR.h - 0.08],
    ] as const) {
      gate.rod(M.darkSteel, [xa, ya, 0], [xb, yb, 0], 0.008, 5)
      gate.rod(M.darkSteel, [xa, yb, 0.012], [xb, ya, 0.012], 0.008, 5)
    }
  }
  for (let k = 0; k <= n; k++) gate.box(M.darkSteel, -gw + (k / n) * gw - 0.012, 0.03, -0.012, -gw + (k / n) * gw + 0.012, DOOR.h - 0.03, 0.024)
  const gateRoot = new THREE.Group()
  gateRoot.position.set(DX1, 0, z0 + 0.04)
  gate.flush(gateRoot)
  carRoot.add(gateRoot)

  // Lit button and lit position lamp (one of each, moved to the active one).
  const litMat = glow(0x221100, 0xff8c26, 3, "lift_lit")
  const litButton = new THREE.Mesh(new THREE.CylinderGeometry(0.0195, 0.0195, 0.007, 16).rotateX(Math.PI / 2), litMat)
  litButton.position.set(panelX, 0, z0 + 0.0185)
  litButton.visible = false
  const litLamp = new THREE.Mesh(new THREE.CylinderGeometry(0.0225, 0.0225, 0.011, 14).rotateX(Math.PI / 2), litMat)
  litLamp.position.set(0, DOOR.h + 0.12, z0 + 0.006)
  carRoot.add(litButton, litLamp)
  const litCall = new THREE.Mesh(new THREE.CylinderGeometry(0.0185, 0.0185, 0.009, 16).rotateX(Math.PI / 2), litMat)
  litCall.visible = false
  parent.add(litCall)
  parent.add(carRoot)

  // Landing door panels (two per storey, sliding behind the shaft wall) and dial needles, instanced.
  const panelW = DOOR.w / 2 + 0.02
  const doorGeo = new THREE.BoxGeometry(panelW, DOOR.h, 0.035)
  const doors = new THREE.InstancedMesh(doorGeo, steel, LEVELS * 2)
  doors.name = "interior:lift-landing-doors"
  const vision = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.12, 0.34), M.wireGlass, LEVELS * 2)
  const needleMat = materialFor("flat", { color: 0x0a0a0a, roughness: 0.5, name: "interior_lift_needle" })
  const needles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.008, 0.15, 0.004).translate(0, 0.075, 0), needleMat, LEVELS)
  for (const m of [doors, vision, needles]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    m.frustumCulled = false
    parent.add(m)
  }

  // Ropes: four on the car, four on the counterweight, scaled to length each frame.
  const ropeMat = materialFor("flat", { color: 0x2a2a28, roughness: 0.6, metalness: 0.7, name: "interior_lift_rope" })
  const ropes = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 6).translate(0, 0.5, 0), ropeMat, 8)
  ropes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  ropes.frustumCulled = false
  parent.add(ropes)
  const cw = new Builder(ctx, "lift-counterweight")
  cw.box(M.darkSteel, -38.7, 0, 24.25, -37.0, 0.12, 24.55)
  cw.box(M.darkSteel, -38.7, 1.5, 24.25, -37.0, 1.62, 24.55)
  cw.box(M.darkSteel, -38.7, 0, 24.25, -38.62, 1.62, 24.55)
  cw.box(M.darkSteel, -37.08, 0, 24.25, -37.0, 1.62, 24.55)
  for (let k = 0; k < 9; k++) cw.box(M.concrete, -38.6, 0.13 + k * 0.152, 24.28, -37.1, 0.27 + k * 0.152, 24.52)
  const cwRoot = new THREE.Group()
  cw.flush(cwRoot)
  parent.add(cwRoot)

  // Car floor and walls (walls span the shaft: the car is the only thing in it).
  const carFloor: Floor = { min: [x0, z0], max: [x1, z1], y: carFloorY(0) }
  ctx.floors.push(carFloor)
  ctx.colliders.push(
    { min: [x0 - 0.06, -1, z0], max: [x0, TOP, z1] },
    { min: [x1, -1, z0], max: [x1 + 0.06, TOP, z1] },
    { min: [x0, -1, z1], max: [x1, TOP, z1 + 0.06] },
    { min: [x0, -1, z0 - 0.06], max: [DX0, TOP, z0] },
    { min: [DX1, -1, z0 - 0.06], max: [x1, TOP, z0] },
  )
  const lamp: Lamp = {
    kind: "fluorescent",
    position: [DOOR.c, carFloorY(0) + h - 0.2, (z0 + z1) / 2],
    direction: [0, -1, 0],
    color: TUBE,
    intensity: 3,
    range: 5,
    angle: 1.35,
    penumbra: 0.8,
    size: 0.8,
    flicker: 0,
    zone: "interior:0",
  }
  ctx.lamps.push(lamp)
  const lampPos = lamp.position as unknown as number[]
  const ZONES = Array.from({ length: LEVELS }, (_, i) => `interior:${i}`)

  // ---------------------------------------------------------------- state
  const shot = ctx.params.has("shot")
  let phase: Phase = "idle"
  let cur = 0
  let target = 0
  let pos = 0 // car position in storeys
  let vel = 0
  let doorT = 1 // 1 = open
  let timer = 0
  let stallAt = -1
  let jolt = 0
  let pressed = false
  let trip = 0
  const audio = shot ? null : createAudio()

  addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.code !== "KeyE" || e.repeat || e.target instanceof HTMLInputElement) return
    pressed = true
    audio?.unlock()
  })
  // Automation only: `lift=<storey>` sends the car there on load (headless ride checks).
  const autoTarget = ctx.params.get("lift")

  const prompt = shot ? null : document.createElement("div")
  if (prompt) {
    prompt.style.cssText =
      "position:fixed;left:50%;top:58%;transform:translateX(-50%);font:13px/1.4 ui-monospace,monospace;color:#cfd8d2;letter-spacing:.08em;text-shadow:0 1px 2px #000;pointer-events:none;opacity:0;transition:opacity .2s"
    prompt.innerHTML = `<span style="display:inline-block;border:1px solid #9aa;border-radius:3px;padding:0 6px;margin-right:8px">E</span><span></span>`
    document.body.appendChild(prompt)
  }
  const promptText = prompt?.lastElementChild as HTMLSpanElement | undefined
  let promptShown = ""

  const request = (s: number) => {
    if (phase !== "idle") return
    if (s === cur) return
    target = s
    phase = "closing"
    trip++
    // One trip in three stalls part way (never the first ride).
    const r = Math.abs(Math.sin(trip * 12.9898) * 43758.5453) % 1
    stallAt = trip > 1 && r < 0.38 ? 0.3 + r : -1
    audio?.clunk(0.5)
  }
  if (autoTarget !== null) request(Math.max(0, Math.min(LEVELS - 1, Number(autoTarget))))

  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const v = new THREE.Vector3()
  const sc = new THREE.Vector3(1, 1, 1)
  const zAxis = new THREE.Vector3(0, 0, 1)
  let doorsDirty = true
  let lastDoorStorey = -1

  const setDoors = (s: number, open: number) => {
    for (let k = 0; k < LEVELS; k++) {
      const o = k === s ? open : 0
      const y = carFloorY(k) + DOOR.h / 2
      for (const side of [-1, 1]) {
        const x = DOOR.c + side * (panelW / 2 - 0.01 + o * (panelW - 0.02))
        m4.makeTranslation(x, y, SHAFT.z0 + 0.03)
        doors.setMatrixAt(k * 2 + (side > 0 ? 1 : 0), m4)
        m4.makeTranslation(x + side * -0.08, y + 0.45, SHAFT.z0 + 0.03 - 0.0185)
        m4.multiply(ROT_Y_PI)
        vision.setMatrixAt(k * 2 + (side > 0 ? 1 : 0), m4)
      }
      const box = doorColliders[k]!
      const free = k === s && open > 0.85
      box.min = free ? OPEN_BOX.min : [DX0, carFloorY(k), LOBBY.z1 - 0.02]
      box.max = free ? OPEN_BOX.max : [DX1, carFloorY(k) + DOOR.h, SHAFT.z0 + 0.08]
    }
    doors.instanceMatrix.needsUpdate = true
    vision.instanceMatrix.needsUpdate = true
  }

  return {
    update(dt: number, time: number, camera: THREE.PerspectiveCamera) {
      dt = Math.min(dt, 0.05)
      // ---- interaction
      const feet = camera.position.y - 1.65
      const inCar =
        camera.position.x > x0 && camera.position.x < x1 && camera.position.z > z0 - 0.1 && camera.position.z < z1 && Math.abs(feet - carFloor.y) < 0.6
      let atCall = -1
      for (let s = 0; s < LEVELS; s++) {
        if (Math.abs(feet - carFloorY(s)) > 0.7) continue
        if (Math.hypot(camera.position.x - CALL.x, camera.position.z - (CALL.z - 0.6)) < 1.3) atCall = s
      }
      if (pressed) {
        if (inCar && phase === "idle") request((cur + 1) % LEVELS)
        else if (atCall >= 0) request(atCall)
      }
      pressed = false
      if (prompt && promptText) {
        const want = phase !== "idle" ? "" : inCar ? "Next floor" : atCall >= 0 && atCall !== cur ? "Call lift" : ""
        if (want !== promptShown) {
          promptShown = want
          if (want) promptText.textContent = want
          prompt.style.opacity = want ? "1" : "0"
        }
      }

      // ---- motion
      let shake = 0
      let light = 0.92 * flicker(time, 3, 0.35)
      if (phase === "closing") {
        doorT = Math.max(0, doorT - dt / 2.2)
        if (doorT === 0) {
          phase = "depart"
          timer = 0
          audio?.clunk(1)
        }
      } else if (phase === "depart") {
        timer += dt
        jolt = timer < 0.25 ? -0.045 * Math.sin((timer / 0.25) * Math.PI) : 0
        shake = 0.002
        if (timer > 0.9) {
          phase = "moving"
          vel = 0
        }
      } else if (phase === "moving" || phase === "stall") {
        const dir = Math.sign(target - pos)
        const dist = Math.abs(target - pos) * STOREY_H
        if (phase === "stall") {
          timer += dt
          vel = 0
          light = timer < 0.15 ? 0.2 : timer > 1.1 && timer < 1.25 ? 0.6 : Math.random() < 0.06 ? 0.4 : 0.02
          jolt = timer < 0.2 ? -0.06 * Math.sin((timer / 0.2) * Math.PI) : 0
          if (timer > 1.6) {
            phase = "moving"
            audio?.clunk(1)
          }
        } else {
          const vmax = 0.85
          const acc = 0.7
          const want = Math.min(vmax, Math.sqrt(Math.max(0, 2 * acc * dist)) + 0.02)
          vel = Math.min(want, vel + acc * dt)
          const step = Math.min(dist, vel * dt) / STOREY_H
          const tripFrac = 1 - dist / (Math.abs(target - cur) * STOREY_H)
          pos += dir * step
          shake = 0.0025 + (Math.random() < 0.01 ? 0.01 : 0)
          jolt *= 0.9
          if (stallAt > 0 && tripFrac > stallAt) {
            stallAt = -1
            phase = "stall"
            timer = 0
            audio?.clunk(1.4)
          }
          if (dist < 1e-3) {
            pos = target
            cur = target
            phase = "level"
            timer = 0
            audio?.clunk(0.8)
          }
        }
      } else if (phase === "level") {
        timer += dt
        jolt = 0.03 * Math.exp(-timer * 7) * Math.cos(timer * 30)
        if (timer > 0.7) {
          jolt = 0
          phase = "opening"
        }
      } else if (phase === "opening") {
        doorT = Math.min(1, doorT + dt / 2)
        if (doorT === 1) phase = "idle"
      }

      const carY = carFloorY(pos) + jolt
      carFloor.y = carY
      carRoot.position.set((Math.random() - 0.5) * shake, carY, (Math.random() - 0.5) * shake)
      // Gate folds in the first half of opening, landing doors in the second (reverse on closing).
      const gateOpen = Math.min(1, doorT * 2)
      const landOpen = Math.max(0, doorT * 2 - 1)
      gateRoot.scale.x = 1 - gateOpen * 0.86
      const doorStorey = phase === "idle" || phase === "opening" || phase === "closing" ? cur : -1
      if (doorsDirty || doorStorey !== lastDoorStorey || phase === "opening" || phase === "closing") {
        setDoors(doorStorey, landOpen)
        doorsDirty = false
        lastDoorStorey = doorStorey
      }

      // Light, lamps, indicator, call button.
      carLevel.value = light
      lamp.intensity = 3 * light
      lampPos[1] = carY + h - 0.2
      lamp.zone = ZONES[Math.max(0, Math.min(LEVELS - 1, Math.round(pos)))]!
      const near = Math.round(pos)
      litLamp.position.x = indicatorX(near)
      litLamp.visible = light > 0.1
      litButton.visible = phase !== "idle"
      litButton.position.y = 1.05 + buttonY(target)
      litCall.visible = phase !== "idle"
      litCall.position.set(CALL.x, carFloorY(target) + CALL.y + 0.04, CALL.z - 0.027)

      for (let k = 0; k < LEVELS; k++) {
        q.setFromAxisAngle(zAxis, -needleAngle(pos))
        m4.compose(v.set(DOOR.c, carFloorY(k) + DOOR.h + 0.32, LOBBY.z1 - 0.036), q, sc)
        needles.setMatrixAt(k, m4)
      }
      needles.instanceMatrix.needsUpdate = true

      const top = carY + h + 0.65
      const cwY = carFloorY(LEVELS - 1) - (carY - carFloorY(0)) + 0.6
      cwRoot.position.y = cwY
      for (let k = 0; k < 4; k++) {
        m4.compose(v.set(DOOR.c - 0.06 + (k % 2) * 0.12, top, 20.95 + (k >> 1) * 0.06), q.identity(), sc.set(1, Math.max(0.01, TOP - 0.3 - top), 1))
        ropes.setMatrixAt(k, m4)
        m4.compose(v.set(DOOR.c - 0.06 + (k % 2) * 0.12, cwY + 1.62, 24.37 + (k >> 1) * 0.06), q, sc.set(1, Math.max(0.01, TOP - 0.55 - cwY - 1.62), 1))
        ropes.setMatrixAt(4 + k, m4)
      }
      sc.set(1, 1, 1)
      ropes.instanceMatrix.needsUpdate = true

      audio?.update(phase, vel, light)
    },
    /** Automation/debug: current state. */
    state: () => ({ phase, cur, target, pos }),
  }
}

const ROT_Y_PI = new THREE.Matrix4().makeRotationY(Math.PI)
const buttonY = (k: number) => -0.15 + k * 0.085
const indicatorX = (k: number) => DOOR.c - 0.2 + k * 0.1
const needleAngle = (pos: number) => -1.2 + (pos / (LEVELS - 1)) * 2.4

/** Motor hum, rail grind and clunks from WebAudio noise (only after the player presses E; never in automation). */
function createAudio() {
  let ac: AudioContext | null = null
  let hum: GainNode | null = null
  let grind: GainNode | null = null
  const noise = (a: AudioContext) => {
    const buf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate)
    const d = buf.getChannelData(0)
    let last = 0
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
      d[i] = last * 3.5 + (Math.random() * 2 - 1) * 0.15
    }
    const src = a.createBufferSource()
    src.buffer = buf
    src.loop = true
    return src
  }
  return {
    unlock() {
      if (ac) return
      ac = new AudioContext()
      const a = ac
      const out = a.createGain()
      out.gain.value = 0.5
      out.connect(a.destination)
      hum = a.createGain()
      hum.gain.value = 0
      const hf = a.createBiquadFilter()
      hf.type = "lowpass"
      hf.frequency.value = 140
      const osc = a.createOscillator()
      osc.type = "sawtooth"
      osc.frequency.value = 48
      osc.connect(hf).connect(hum).connect(out)
      osc.start()
      const n1 = noise(a)
      n1.connect(hf)
      n1.start()
      grind = a.createGain()
      grind.gain.value = 0
      const bp = a.createBiquadFilter()
      bp.type = "bandpass"
      bp.frequency.value = 1300
      bp.Q.value = 6
      const n2 = noise(a)
      n2.connect(bp).connect(grind).connect(out)
      n2.start()
    },
    clunk(strength: number) {
      if (!ac) return
      const a = ac
      const src = noise(a)
      const f = a.createBiquadFilter()
      f.type = "lowpass"
      f.frequency.value = 220
      const g = a.createGain()
      g.gain.setValueAtTime(0.9 * strength, a.currentTime)
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.35)
      src.connect(f).connect(g).connect(a.destination)
      src.start()
      src.stop(a.currentTime + 0.4)
    },
    update(phase: Phase, vel: number, light: number) {
      if (!ac || !hum || !grind) return
      const t = ac.currentTime
      const moving = phase === "moving" ? Math.min(1, vel / 0.85) : 0
      hum.gain.setTargetAtTime(phase === "idle" ? 0 : 0.25 + moving * 0.35, t, 0.15)
      grind.gain.setTargetAtTime(moving * (0.05 + 0.08 * Math.max(0, Math.sin(t * 2.3) * Math.sin(t * 0.7))) + (phase === "stall" ? 0.02 : 0), t, 0.08)
      void light
    },
  }
}
