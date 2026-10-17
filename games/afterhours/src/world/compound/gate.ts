import * as THREE from "three/webgpu"
import type { Box, WorldContext } from "../context"
import type { DoorHandle } from "../doors"
import { heightAt } from "../height"
import { BOOTH, FENCE } from "../layout"
import { material } from "../../render/materials"
import { Batch, box, cyl, lathe, matrix, rod } from "./geo"
import { boomRed, boomWhite, flat, glow } from "./mats"
import { PED_GATE, darkWire, fenceMesh, fenceSteel } from "./fence"

// The gate area as a 1984 secure site would have it:
//  - a motorised cantilever SLIDING gate across the vehicle opening: one chain-link leaf with a barbed top and a
//    counterbalance tail, riding on roller trucks on two posts inside the fence and driven by an operator on a pad.
//    It slides parallel to the fence (behind it, inside), so it never sweeps through anything;
//  - a narrow pedestrian swing gate in its own opening east of it;
//  - a boom barrier outside the gate line at the booth lane that pivots UP, in a plane clear of its cabinet;
//  - a push-button control station on the booth's south-west corner column: GATE (green) and BARRIER (yellow).
// The player never grabs the vehicle gate (its leaf is locked: E rattles); the buttons run the motors.

/** Sliding leaf: chain-link panel covering the opening plus a counterbalance tail (m). */
const PANEL = 11.1
const TAIL = 5.0
const LEN = PANEL + TAIL
const LEAF_TOP = 2.3
const BARB = 0.42
const TRACK_Y = 0.15
const MID_Y = 1.2
/** The leaf runs this far inside the fence line. */
const LEAF_Z = FENCE.max[1] - 0.35
/** Closed position of the leaf's latch end (it stops in a receiver on the east gate post). */
const LATCH_X = FENCE.gate.x1 - 0.05
/** Roller-truck posts (inside the fence, west of the opening; always under the leaf, open or closed). */
const ROLLERS = [-6.2, -10.0]
const POST_Z = LEAF_Z - 0.25

/** Motor travel time for a full open or close (s). */
const GATE_S = 7
const BOOM_S = 4

export function buildGate(ctx: WorldContext, root: THREE.Object3D) {
  const gate = slidingGate(ctx, root)
  pedestrianGate(ctx, root)
  const boom = boomBarrier(ctx, root)
  const [gateBtn, boomBtn] = controlStation(ctx, root)

  let boomPos = 0
  return (dt: number) => {
    // The GATE button's state is the motor command; the door system runs the slow travel and its sound.
    if (gateBtn.isOpen !== gate.door.isOpen) gateBtn.isOpen ? gate.door.open() : gate.door.close()
    gate.beacon.visible = Math.abs(gate.door.amount - (gate.door.isOpen ? 1 : 0)) > 1e-3
    boomPos = approach(boomPos, boomBtn.isOpen ? 1 : 0, dt / BOOM_S)
    boom.set(ease(boomPos))
  }
}

const approach = (v: number, goal: number, step: number) => (goal > v ? Math.min(goal, v + step) : Math.max(goal, v - step))
const ease = (t: number) => t * t * (3 - 2 * t)

function slidingGate(ctx: WorldContext, root: THREE.Object3D) {
  const steel = fenceSteel()
  const wire = darkWire()
  const dark = material("metal_dark")
  const leaf = new THREE.Group()
  leaf.name = "vehicle-gate"
  const b = new Batch()
  const mesh = new Batch()
  const v = (x: number, y: number) => new THREE.Vector3(x, y, 0)
  // Box-section track along the bottom (rides the roller trucks) and a lighter guide track at mid height.
  b.at(steel, box(LEN, 0.1, 0.08), -LEN / 2, TRACK_Y, 0)
  b.at(steel, box(LEN, 0.06, 0.06), -LEN / 2, MID_Y, 0)
  // Panel: top rail, heavy end uprights, intermediate uprights, chain-link fabric.
  b.add(steel, rod(v(0, LEAF_TOP), v(-PANEL, LEAF_TOP), 0.03, 8))
  b.at(steel, box(0.08, LEAF_TOP - 0.1, 0.08), -0.04, (LEAF_TOP + 0.1) / 2, 0)
  b.at(steel, box(0.08, LEAF_TOP - 0.1, 0.08), -PANEL, (LEAF_TOP + 0.1) / 2, 0)
  const uprights: number[] = [-0.04, -PANEL]
  for (let k = 1; k < 5; k++) {
    const x = -(PANEL * k) / 5
    uprights.push(x)
    b.add(steel, rod(v(x, 0.2), v(x, LEAF_TOP), 0.024, 8))
  }
  const panel = new THREE.PlaneGeometry(PANEL - 0.12, LEAF_TOP - 0.24)
  const uv = panel.attributes.uv!
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (PANEL - 0.12), uv.getY(i) * (LEAF_TOP - 0.24))
  mesh.at(fenceMesh(), panel, -PANEL / 2, (LEAF_TOP + 0.2) / 2, 0)
  // Barbed top: vertical extension arms on every upright, three strands.
  for (const x of uprights) b.add(steel, rod(v(x, LEAF_TOP), v(x, LEAF_TOP + BARB), 0.014, 6))
  for (const y of [0.14, 0.28, 0.42]) b.add(wire, rod(v(0, LEAF_TOP + y), v(-PANEL, LEAF_TOP + y), 0.006, 4))
  // Counterbalance tail: a truss whose top chord drops from the panel to the mid track at the end.
  const tEnd = -LEN + 0.04
  b.add(steel, rod(v(-PANEL, LEAF_TOP), v(tEnd, MID_Y + 0.03), 0.03, 8))
  b.at(steel, box(0.08, MID_Y - 0.1, 0.08), tEnd, (MID_Y + 0.1) / 2, 0)
  const tMid = -PANEL - TAIL / 2
  const midTop = LEAF_TOP + (MID_Y + 0.03 - LEAF_TOP) * 0.5
  b.add(steel, rod(v(tMid, 0.2), v(tMid, midTop), 0.024, 8))
  b.add(steel, rod(v(-PANEL, 0.2), v(tMid, midTop), 0.02, 6))
  b.add(steel, rod(v(tMid, 0.2), v(tEnd, MID_Y), 0.02, 6))
  b.add(steel, rod(v(-PANEL, MID_Y), v(tMid, 0.2), 0.02, 6))
  // Gear rack along the inside of the bottom track (the operator's pinion meshes with it).
  b.at(dark, box(LEN - 0.4, 0.03, 0.015), -LEN / 2, TRACK_Y + 0.02, -0.048)
  // Latch end: striker plate and a rubber safety edge.
  b.at(dark, box(0.02, 0.3, 0.1), 0.01, 1.0, 0)
  b.at(material("rubber"), box(0.03, LEAF_TOP - 0.3, 0.05), 0.015, LEAF_TOP / 2 + 0.05, 0)
  b.build(leaf, { castShadow: (m) => m === steel, name: "vehicle-gate" })
  for (const m of mesh.build(leaf, { name: "vehicle-gate-mesh", receiveShadow: false })) m.renderOrder = 1
  root.add(leaf)

  const door = ctx.doors.add({
    id: "vehicle-gate",
    leaf,
    hinge: [LATCH_X, heightAt(LATCH_X, LEAF_Z), LEAF_Z],
    width: -LEN,
    height: LEAF_TOP + BARB,
    thickness: 0.08,
    openAngle: 0,
    slide: { axis: [-1, 0, 0], distance: PANEL },
    startOpen: 0,
    // Motorised: it can't be pushed by hand (E on the leaf rattles); the control station runs it, slowly.
    locked: true,
    duration: GATE_S,
    sound: "gate",
  })

  // Static hardware: roller-truck posts, receiver on the east post, operator on its pad.
  const s = new Batch()
  for (const px of ROLLERS) {
    const y = heightAt(px, POST_Z)
    s.at(material("concrete_dark"), cyl(0.2, 0.22, 0.14, 14), px, y + 0.03, POST_Z)
    s.at(steel, cyl(0.055, 0.055, 1.45, 14), px, y + 0.72, POST_Z)
    s.at(steel, new THREE.SphereGeometry(0.06, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), px, y + 1.45, POST_Z)
    // Bottom truck: back plate off the post, two wheels under the track.
    s.at(dark, box(0.36, 0.1, 0.012), px, y + 0.05, LEAF_Z - 0.1)
    s.at(dark, box(0.04, 0.06, 0.06), px, y + 0.05, (POST_Z + LEAF_Z - 0.1) / 2 + 0.02)
    for (const dx of [-0.12, 0.12]) {
      s.at(dark, cyl(0.008, 0.008, 0.11, 8), px + dx, y + 0.05, LEAF_Z - 0.05, 0, Math.PI / 2)
      s.at(material("rubber"), cyl(0.045, 0.045, 0.05, 16), px + dx, y + 0.05, LEAF_Z, 0, Math.PI / 2)
    }
    // Mid guide: a bracket and two vertical-axis rollers against the inside face of the mid track.
    s.at(dark, box(0.3, 0.05, 0.012), px, y + MID_Y, POST_Z + 0.06)
    s.at(dark, box(0.24, 0.04, 0.12), px, y + MID_Y, POST_Z + 0.06 + 0.06)
    for (const dx of [-0.1, 0.1]) s.at(material("rubber"), cyl(0.028, 0.028, 0.05, 14), px + dx, y + MID_Y, LEAF_Z - 0.03 - 0.03)
    ctx.colliders.push({ min: [px - 0.1, y, POST_Z - 0.1], max: [px + 0.1, y + 1.5, POST_Z + 0.1] })
  }
  // Receiver: a U-channel on a bracket off the east gate post that the latch end runs into.
  const rx = FENCE.gate.x1
  s.at(dark, box(0.1, 0.08, FENCE.max[1] - LEAF_Z - 0.06), rx - 0.02, 1.0, (FENCE.max[1] + LEAF_Z + 0.06) / 2)
  s.at(dark, box(0.12, 0.6, 0.012), rx + 0.02, 1.0, LEAF_Z + 0.06)
  s.at(dark, box(0.12, 0.6, 0.012), rx + 0.02, 1.0, LEAF_Z - 0.06)
  s.at(dark, box(0.012, 0.6, 0.13), rx + 0.08, 1.0, LEAF_Z)
  // Operator: pad, cabinet, pinion bracket to the rack, amber beacon (lit while running).
  const ox = -8.1
  const oz = LEAF_Z - 0.6
  const oy = heightAt(ox, oz)
  s.at(material("concrete_floor"), box(0.9, 0.12, 0.62), ox, oy + 0.06, oz)
  const cabinet = flat(0x4a4e3e, 0.55, 0.35)
  s.at(cabinet, box(0.46, 0.66, 0.36), ox, oy + 0.12 + 0.33, oz - 0.04)
  s.at(cabinet, box(0.5, 0.03, 0.4), ox, oy + 0.8, oz - 0.04)
  s.at(dark, box(0.3, 0.012, 0.002), ox, oy + 0.6, oz + 0.141)
  for (const yy of [0.3, 0.36, 0.42]) s.at(dark, box(0.3, 0.008, 0.004), ox, oy + yy, oz + 0.142)
  s.at(dark, box(0.08, 0.05, LEAF_Z - 0.06 - (oz + 0.14)), ox, oy + TRACK_Y, (LEAF_Z - 0.06 + oz + 0.14) / 2)
  s.at(dark, cyl(0.04, 0.04, 0.05, 16), ox, oy + TRACK_Y + 0.02, LEAF_Z - 0.06 - 0.04)
  s.at(dark, lathe([[0, 0], [0.05, 0], [0.05, 0.02], [0, 0.02]], 14), ox + 0.12, oy + 0.815, oz - 0.04)
  s.build(root, { castShadow: true, name: "gate-hardware" })
  const beacon = new THREE.Mesh(lathe([[0, 0], [0.04, 0], [0.042, 0.05], [0.03, 0.09], [0, 0.1]], 14), glow(1, 0.45, 0.05, 6))
  beacon.position.set(ox + 0.12, oy + 0.835, oz - 0.04)
  beacon.visible = false
  root.add(beacon)
  ctx.colliders.push({ min: [ox - 0.45, oy, oz - 0.31], max: [ox + 0.45, oy + 0.85, oz + 0.31] })
  return { door, beacon }
}

/** A 0.8 m chain-link swing gate in its own opening east of the vehicle gate, on the fence's end posts. */
function pedestrianGate(ctx: WorldContext, root: THREE.Object3D) {
  const steel = fenceSteel()
  const wire = darkWire()
  const z = FENCE.max[1]
  const hx = PED_GATE.x0 + 0.1
  const w = PED_GATE.x1 - 0.1 - hx
  const h = 2.05
  const leaf = new THREE.Group()
  leaf.name = "ped-gate"
  const b = new Batch()
  const mesh = new Batch()
  const v = (x: number, y: number) => new THREE.Vector3(x, y, 0)
  for (const [a, c] of [
    [v(0.03, 0.08), v(w - 0.03, 0.08)],
    [v(0.03, h), v(w - 0.03, h)],
    [v(0.03, 0.08), v(0.03, h)],
    [v(w - 0.03, 0.08), v(w - 0.03, h)],
    [v(0.03, 1.05), v(w - 0.03, 1.05)],
  ] as const)
    b.add(steel, rod(a, c, 0.021, 8))
  for (const x of [0.03, w - 0.03]) b.add(steel, rod(v(x, h), v(x, h + 0.38), 0.012, 6))
  for (const y of [0.13, 0.26, 0.38]) b.add(wire, rod(v(0.03, h + y), v(w - 0.03, h + y), 0.005, 4))
  // Hinge collars on the hinge stile; a fork latch and a gravity drop bar at the latch stile.
  const dark = material("metal_dark")
  for (const y of [0.35, h - 0.3]) b.at(dark, cyl(0.03, 0.03, 0.08, 12), 0.0, y, 0)
  b.at(dark, box(0.06, 0.12, 0.05), w - 0.02, 1.05, 0)
  const panel = new THREE.PlaneGeometry(w - 0.08, h - 0.12)
  const uv = panel.attributes.uv!
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w - 0.08), uv.getY(i) * (h - 0.12))
  mesh.at(fenceMesh(), panel, w / 2, (h + 0.08) / 2, 0)
  b.build(leaf, { castShadow: (m) => m === steel, name: "ped-gate" })
  for (const m of mesh.build(leaf, { name: "ped-gate-mesh", receiveShadow: false })) m.renderOrder = 1
  root.add(leaf)
  ctx.doors.add({
    id: "ped-gate",
    leaf,
    hinge: [hx, heightAt(hx, z), z],
    width: w,
    height: h + 0.38,
    thickness: 0.05,
    openAngle: Math.PI / 2,
    swing: "auto",
    startOpen: 0,
    sound: "gate",
  })
}

/** Boom barrier on a cabinet at the booth island; the arm is in a plane just south of the cabinet and pivots up. */
function boomBarrier(ctx: WorldContext, root: THREE.Object3D) {
  const s = new Batch()
  const px = BOOTH.x - BOOTH.w / 2 - 1.3
  const pz = FENCE.max[1] + 3.2
  const y = heightAt(px, pz)
  const cab = flat(0x4f5344, 0.65, 0.3)
  const dark = material("metal_dark")
  const armY = y + 1.0
  const armZ = pz + 0.18 + 0.1
  // Tip and its rest post just past the road's west edge (x ≈ -3.2), out of the lane.
  const tipX = -3.75
  s.at(material("concrete_dark"), box(0.75, 0.14, 0.65), px, y + 0.07, pz)
  s.at(cab, box(0.42, 1.05, 0.36), px, y + 0.14 + 0.525, pz)
  s.at(dark, box(0.46, 0.04, 0.4), px, y + 1.21, pz)
  // Drive shaft from the cabinet face to the arm's hub.
  s.at(dark, cyl(0.035, 0.035, armZ - pz - 0.18, 12), px, armY, (pz + 0.18 + armZ) / 2, 0, Math.PI / 2)
  // Fork rest post where the lowered arm's tip sits.
  const rx = tipX + 0.3
  s.at(cab, cyl(0.04, 0.04, armY - y - 0.05, 10), rx, y + (armY - y - 0.05) / 2, armZ)
  s.at(cab, box(0.04, 0.05, 0.16), rx, armY - 0.07, armZ)
  for (const dz of [-0.07, 0.07]) s.at(cab, box(0.04, 0.12, 0.02), rx, armY - 0.01, armZ + dz)
  s.at(material("concrete_dark"), cyl(0.18, 0.2, 0.1, 12), rx, y + 0.03, armZ)
  s.build(root, { castShadow: true, name: "boom" })

  const arm = new THREE.Group()
  arm.name = "boom-arm"
  arm.position.set(px, armY, armZ)
  const a = new Batch()
  const armLen = px - 0.22 - tipX
  for (let d = 0, k = 0; d < armLen - 0.01; d += 0.5, k++) {
    const segLen = Math.min(0.5, armLen - d)
    a.at(k % 2 ? boomWhite() : boomRed(), box(segLen, 0.085, 0.06), -0.22 - d - segLen / 2, 0, 0)
  }
  a.at(dark, cyl(0.07, 0.07, 0.1, 16), 0, 0, 0, 0, Math.PI / 2)
  a.at(dark, box(0.3, 0.1, 0.08), -0.12, 0, 0)
  a.at(dark, box(0.35, 0.16, 0.12), 0.225, 0, 0)
  for (let d = 1; d < armLen; d += 2) a.at(flat(0x5a0a06, 0.3, 0), box(0.06, 0.05, 0.065), -0.22 - d, 0, 0)
  a.build(arm, { castShadow: true, name: "boom-arm" })
  root.add(arm)

  const down: Box = { min: [tipX, armY - 0.1, armZ - 0.06], max: [px - 0.22, armY + 0.1, armZ + 0.06] }
  const away: Box = { min: [0, -100, 0], max: [0, -99, 0] }
  const col: Box = { min: down.min, max: down.max }
  ctx.colliders.push(col)
  ctx.colliders.push({ min: [px - 0.3, y, pz - 0.3], max: [px + 0.3, y + 1.3, pz + 0.3] })
  ctx.colliders.push({ min: [rx - 0.1, y, armZ - 0.1], max: [rx + 0.1, armY - 0.05, armZ + 0.1] })
  return {
    set(t: number) {
      arm.rotation.z = (-Math.PI / 2) * t
      arm.updateMatrixWorld()
      const src = t < 0.3 ? down : away
      col.min = src.min
      col.max = src.max
    },
  }
}

/**
 * Weatherproof push-button station on the west face of the booth's south-west corner column, facing the lane: a
 * green GATE mushroom above a yellow BARRIER one, a keyswitch between. Each button is a tiny sliding "door" so it gets
 * the shared E prompt and sound; its open state is the motor command.
 */
function controlStation(ctx: WorldContext, root: THREE.Object3D): [DoorHandle, DoorHandle] {
  const face = BOOTH.x - BOOTH.w / 2 - 0.07
  const cz = BOOTH.z + BOOTH.d / 2 - 0.1
  const y0 = heightAt(BOOTH.x, BOOTH.z)
  const s = new Batch()
  const housing = flat(0x6a6a5e, 0.5, 0.3)
  s.at(housing, box(0.07, 0.36, 0.16), face + 0.035, y0 + 1.25, cz)
  s.at(material("metal_dark"), box(0.006, 0.38, 0.17), face + 0.067, y0 + 1.25, cz)
  // Keyswitch between the buttons.
  s.at(material("chrome"), cyl(0.014, 0.014, 0.012, 14), face - 0.006, y0 + 1.25, cz, 0, 0, Math.PI / 2)
  s.at(material("metal_dark"), box(0.004, 0.012, 0.003), face - 0.013, y0 + 1.25, cz)
  // Conduit up to the roof.
  s.add(material("metal_galvanized"), rod({ x: face + 0.03, y: y0 + 1.43, z: cz }, { x: face + 0.03, y: y0 + 2.5, z: cz }, 0.012, 8))
  s.build(root, { castShadow: false, name: "control-station" })

  const button = (id: string, color: number, y: number) => {
    const leaf = new THREE.Group()
    leaf.name = id
    leaf.rotation.y = -Math.PI / 2
    const b = new Batch()
    const cap = lathe([[0, 0], [0.02, 0], [0.02, 0.012], [0.03, 0.016], [0.032, 0.026], [0.026, 0.034], [0, 0.036]], 20)
    cap.rotateX(Math.PI / 2)
    b.add(flat(color, 0.35), cap, matrix(0.05, 0.05, -0.025))
    const ring = lathe([[0.024, 0], [0.034, 0], [0.034, 0.006], [0.024, 0.006]], 20)
    ring.rotateX(Math.PI / 2)
    b.add(material("chrome"), ring, matrix(0.05, 0.05, -0.025))
    b.build(leaf, { castShadow: false, name: id })
    root.add(leaf)
    return ctx.doors.add({
      id,
      leaf,
      hinge: [face - 0.025, y0 + y, cz - 0.05],
      width: 0.1,
      height: 0.1,
      thickness: 0.05,
      openAngle: 0,
      slide: { axis: [1, 0, 0], distance: 0.006 },
      // A short clunk; the gate and boom make their own motor sounds.
      sound: "steel",
      duration: 0.15,
    })
  }
  return [button("ctl-gate", 0x1c6a2a, 1.3), button("ctl-boom", 0xb8901c, 1.1)]
}
