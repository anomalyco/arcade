import * as THREE from "three/webgpu"
import type { Box, WorldContext } from "../../world/context"
import type { DoorHandle } from "../../world/doors"
import { material } from "../../render/materials"
import { Batch, box, cyl, matrix } from "../../world/compound/geo"
import { flat, glow } from "../../world/compound/mats"
import { rollupLeaf, steelLeaf } from "../../world/facility/doors"
import { PlayerCar } from "../intro/car"
import { TRUCK } from "./truck-spec"

// The motor-pool shed in the loading-dock court, west of the dock: a prefab corrugated-steel single-bay garage on a
// concrete slab (the dock itself is 1.25 m up, no vehicle gets in or out of the building through it), its roll-up door
// facing north up the court towards the north gate, a steel man door in the east wall, one caged bulb, a push-button
// station inside beside the roll-up. Truck 2 is parked inside, nose to the door. The escape (src/game/escape) drives it.
//
// Built at boot by the `motorPool` world module (src/world/motor-pool.ts) so it is warmed with the world; the game side
// finds it through `motorPool`.

import { SHED, TRUCK_PARK } from "./places"
export { SHED, TRUCK_PARK }
/** The roll-up opening in the north (front) wall. */
const DOOR = { u0: -51.35, u1: -48.15, h: 2.7 }
const MAN = { z0: -33.3, z1: -32.35, h: 2.05 }
const WALL_T = 0.06
/** Motor travel time of the roll-up (s). */
const ROLLUP_S = 6

export type MotorPool = {
  truck: PlayerCar
  rollup: DoorHandle
  button: DoorHandle
  /** World position of the button (the player's reach). */
  buttonAt: THREE.Vector3
  /** Ground under (x, z) inside the shed (the slab), else null. */
  slab(x: number, z: number): number | null
  /** Per frame: the button drives the motor; the closed curtain is solid for vehicles. */
  update(dt: number): void
  /** A box the truck must not pass while the curtain is down (null when it is up). */
  readonly doorBox: Box | null
}

export let motorPool: MotorPool | null = null

export function buildMotorPool(ctx: WorldContext, root: THREE.Object3D): MotorPool {
  const S = SHED
  const g = new THREE.Group()
  g.name = "motor-pool"
  root.add(g)
  const b = new Batch()
  const steel = material("metal_galvanized")
  const frame = material("metal_dark")
  const slabMat = material("concrete_floor")
  const yTop = (z: number) => S.eaveBack + ((z - S.z1) / (S.z0 - S.z1)) * (S.eaveFront - S.eaveBack)

  // Slab with a short apron out of the door.
  b.at(slabMat, box(S.x1 - S.x0 + 0.5, 0.16, S.z1 - S.z0 + 0.5), (S.x0 + S.x1) / 2, S.y - 0.08, (S.z0 + S.z1) / 2)
  b.at(slabMat, box(DOOR.u1 - DOOR.u0 + 1.2, 0.1, 1.6), (DOOR.u0 + DOOR.u1) / 2, S.y - 0.06, S.z0 - 0.8)
  ctx.floors.push({ min: [S.x0 - 0.25, S.z0 - 1.6], max: [S.x1 + 0.25, S.z1 + 0.25], y: S.y, surface: "concrete" })

  // Corrugated walls (sheet on girts), cut round the roll-up and the man door.
  const wall = (ax: number, az: number, bx: number, bz: number, y0: number, y1a: number, y1b: number) => {
    const len = Math.hypot(bx - ax, bz - az)
    const geo = corrugated(len, y0, y1a, y1b)
    const yaw = Math.atan2(-(bz - az), bx - ax)
    b.add(steel, geo, matrix(ax, S.y, az, yaw))
  }
  const back = S.z1
  const front = S.z0
  wall(S.x0, back, S.x1, back, 0, S.eaveBack, S.eaveBack)
  wall(S.x0, front, DOOR.u0, front, 0, S.eaveFront, S.eaveFront)
  wall(DOOR.u1, front, S.x1, front, 0, S.eaveFront, S.eaveFront)
  wall(DOOR.u0, front, DOOR.u1, front, DOOR.h + 0.35, S.eaveFront, S.eaveFront)
  // West wall: one run; east wall: either side of the man door and a header over it (z runs back → front: eave rises).
  wall(S.x0, back, S.x0, front, 0, S.eaveBack, S.eaveFront)
  wall(S.x1, back, S.x1, MAN.z1, 0, S.eaveBack, yTop(MAN.z1))
  wall(S.x1, MAN.z0, S.x1, front, 0, yTop(MAN.z0), S.eaveFront)
  wall(S.x1, MAN.z1, S.x1, MAN.z0, MAN.h + 0.1, yTop(MAN.z1), yTop(MAN.z0))
  // Roof: corrugated sheet laid front to back on purlins, a little overhang.
  const roofLen = Math.hypot(S.z1 - S.z0 + 0.6, S.eaveFront - S.eaveBack)
  const roof = corrugated(S.x1 - S.x0 + 0.5, 0, roofLen, roofLen)
  roof.rotateX(-Math.PI / 2)
  const pitch = Math.atan2(S.eaveFront - S.eaveBack, S.z1 - S.z0)
  b.add(steel, roof, matrix(S.x0 - 0.25, S.y + S.eaveBack + 0.02 - 0.3 * Math.tan(pitch), back + 0.3, 0, pitch))
  // Frame: corner and door posts, eave beams, roof purlins, girts.
  for (const [x, z] of [
    [S.x0, back],
    [S.x1, back],
    [S.x0, front],
    [S.x1, front],
    [DOOR.u0 - 0.06, front],
    [DOOR.u1 + 0.06, front],
  ] as const)
    b.at(frame, box(0.1, yTop(z), 0.1), x, S.y + yTop(z) / 2, z)
  b.at(frame, box(DOOR.u1 - DOOR.u0 + 0.24, 0.3, 0.14), (DOOR.u0 + DOOR.u1) / 2, S.y + DOOR.h + 0.2, front + 0.02)
  for (let k = 0; k <= 4; k++) {
    const z = back + ((front - back) * k) / 4
    b.at(frame, box(S.x1 - S.x0, 0.12, 0.06), (S.x0 + S.x1) / 2, S.y + yTop(z) - 0.09, z)
  }
  for (const y of [1.0, 2.1]) {
    b.at(frame, box(0.05, 0.08, S.z1 - S.z0), S.x0 + 0.05, S.y + y, (S.z0 + S.z1) / 2)
    b.at(frame, box(S.x1 - S.x0, 0.08, 0.05), (S.x0 + S.x1) / 2, S.y + y, back - 0.05)
  }
  // Coil box over the roll-up (inside), guides either side.
  b.at(flat(0x55584e, 0.55, 0.3), box(DOOR.u1 - DOOR.u0 + 0.3, 0.42, 0.42), (DOOR.u0 + DOOR.u1) / 2, S.y + DOOR.h + 0.28, front + 0.28)
  for (const x of [DOOR.u0 - 0.04, DOOR.u1 + 0.04]) b.at(frame, box(0.07, DOOR.h, 0.1), x, S.y + DOOR.h / 2, front + 0.06)
  // Shop clutter along the back wall: a workbench, a jerrycan, tyres.
  const bench = flat(0x4a3a28, 0.7)
  b.at(bench, box(1.8, 0.05, 0.6), S.x1 - 1.2, S.y + 0.9, back - 0.4)
  for (const dx of [-0.8, 0.8]) for (const dz of [-0.25, 0.25]) b.at(frame, box(0.05, 0.9, 0.05), S.x1 - 1.2 + dx, S.y + 0.45, back - 0.4 + dz)
  b.at(flat(0x5a1a12, 0.5, 0.2), box(0.17, 0.33, 0.24), S.x1 - 0.5, S.y + 0.165, back - 0.9)
  for (const [x, z] of [
    [S.x0 + 0.45, back - 0.6],
    [S.x0 + 0.45, back - 0.6],
  ] as const)
    b.at(material("rubber"), cyl(0.33, 0.33, 0.2, 20), x, S.y + 0.1, z)
  b.at(material("rubber"), cyl(0.33, 0.33, 0.2, 20), S.x0 + 0.45, S.y + 0.3, back - 0.6)
  // Lamp: caged bulb under the middle purlin (a real lamp below).
  const lampAt = new THREE.Vector3((S.x0 + S.x1) / 2, S.y + yTop(-35.2) - 0.35, -35.2)
  b.at(frame, cyl(0.004, 0.004, 0.25, 6), lampAt.x, lampAt.y + 0.2, lampAt.z)
  b.at(frame, cyl(0.07, 0.07, 0.03, 12), lampAt.x, lampAt.y + 0.08, lampAt.z)
  b.build(g, { castShadow: (m) => m !== slabMat, name: "motor-pool" })
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), glow(1, 0.72, 0.42, 7))
  bulb.position.copy(lampAt)
  g.add(bulb)
  ctx.lamps.push({ kind: "incandescent", position: [lampAt.x, lampAt.y - 0.05, lampAt.z], color: [1, 0.7, 0.45], intensity: 30, range: 9, size: 0.06, flicker: 0.15 })

  // Colliders: walls (with gaps for the doors), and the roof as nothing (nobody climbs it).
  const col = (x0: number, z0: number, x1: number, z1: number, h = 3.3) => ctx.colliders.push({ min: [x0, S.y, z0], max: [x1, S.y + h, z1] })
  col(S.x0 - WALL_T, back, S.x1 + WALL_T, back + WALL_T * 2)
  col(S.x0 - WALL_T * 2, front, S.x0, back)
  col(S.x1, MAN.z1, S.x1 + WALL_T * 2, back)
  col(S.x1, front, S.x1 + WALL_T * 2, MAN.z0)
  col(S.x0 - WALL_T, front - WALL_T * 2, DOOR.u0 - 0.1, front)
  col(DOOR.u1 + 0.1, front - WALL_T * 2, S.x1 + WALL_T, front)
  col(S.x1 - 2.1, back - 0.7, S.x1 - 0.3, back, 0.95)

  // The roll-up: E on the curtain rattles it (motorised, locked); the button runs it.
  const lift = DOOR.h - 0.08
  const curtain = rollupLeaf("motor-pool-rollup", DOOR.u1 - DOOR.u0, DOOR.h)
  g.add(curtain.leaf)
  const rollup = ctx.doors.add({
    id: "motor-pool-rollup",
    leaf: curtain.leaf,
    hinge: [DOOR.u0, S.y, front + 0.02],
    width: DOOR.u1 - DOOR.u0,
    height: DOOR.h,
    thickness: 0.08,
    openAngle: 0,
    slide: { axis: [0, 1, 0], distance: lift },
    onMove: (t) => curtain.coil(Math.max(0, Math.min(1, t)) * lift),
    startOpen: 0,
    locked: true,
    duration: ROLLUP_S,
    sound: "gate",
  })
  // Man door in the east wall, opens outwards.
  const man = steelLeaf("motor-pool-man", MAN.z1 - MAN.z0, MAN.h)
  man.rotation.y = -Math.PI / 2
  g.add(man)
  ctx.doors.add({ id: "motor-pool-man", leaf: man, hinge: [S.x1 + 0.03, S.y, MAN.z0], width: MAN.z1 - MAN.z0, height: MAN.h, thickness: 0.045, openAngle: Math.PI / 2, swing: "auto", startOpen: 0.15, sound: "steel" })

  // Push-button station inside on the east door post's face: green UP mushroom, red STOP below it.
  const bs = new Batch()
  const bx = DOOR.u1 + 0.32
  const bz = front + 0.12
  const by = S.y + 1.3
  bs.at(flat(0x6a6a5e, 0.5, 0.3), box(0.14, 0.26, 0.07), bx, by, bz)
  bs.at(flat(0x8a1a12, 0.45), cyl(0.022, 0.022, 0.03, 16), bx, by - 0.07, bz + 0.045, 0, Math.PI / 2)
  bs.add(material("metal_galvanized"), box(0.024, 1.6, 0.024), matrix(bx, by + 0.93, bz - 0.02))
  bs.build(g, { castShadow: false, name: "motor-pool-buttons" })
  const leaf = new THREE.Group()
  leaf.name = "motor-pool-button"
  const cap = new THREE.Mesh(cyl(0.026, 0.028, 0.03, 16), flat(0x1c6a2a, 0.35))
  cap.rotation.x = Math.PI / 2
  cap.position.set(0.05, 0.05, 0.015)
  leaf.add(cap)
  g.add(leaf)
  const button = ctx.doors.add({
    id: "motor-pool-button",
    leaf,
    hinge: [bx - 0.05, by - 0.02, bz + 0.035],
    width: 0.1,
    height: 0.1,
    thickness: 0.05,
    openAngle: 0,
    slide: { axis: [0, 0, -1], distance: 0.008 },
    sound: "steel",
    duration: 0.15,
  })
  const buttonAt = new THREE.Vector3(bx, by + 0.03, bz + 0.05)

  // Truck 2 on the slab, nose to the door, parked solid.
  const truck = new PlayerCar(ctx, TRUCK)
  truck.place(TRUCK_PARK.x, S.y, TRUCK_PARK.z, TRUCK_PARK.yaw)
  truck.root.name = "truck-2"
  g.add(truck.root)
  truck.lights.head = truck.lights.tail = truck.lights.dash = 1
  void truck
    // The boot warms whatever arrives under the module's root (src/boot/warmup.ts `track`), lights at a level.
    .prepare(() => Promise.resolve())
    .then(() => {
      truck.lights.head = truck.lights.tail = truck.lights.dash = 0
      truck.update(0.016, 0, 0, 0, 0)
      truck.park()
    })
    .catch((e: unknown) => console.error("motor pool truck:", e))

  // The closed curtain is solid for the truck (players meet the leaf through the door system).
  const doorClosed: Box = { min: [DOOR.u0, S.y, front - 0.1], max: [DOOR.u1, S.y + DOOR.h, front + 0.1] }
  let doorBox: Box | null = doorClosed
  const slab = (x: number, z: number) => (x > S.x0 - 0.25 && x < S.x1 + 0.25 && z > S.z0 - 1.6 && z < S.z1 + 0.25 ? S.y : null)
  motorPool = {
    truck,
    rollup,
    button,
    buttonAt,
    slab,
    get doorBox() {
      return doorBox
    },
    update() {
      // The button is the motor command: pressed, the curtain goes up (and stays up: no STOP wired).
      if (button.isOpen && !rollup.isOpen) rollup.open()
      if (button.isOpen && button.amount > 0.9) button.close()
      doorBox = rollup.amount > 0.82 ? null : doorClosed
    },
  }
  return motorPool
}

/**
 * Trapezoidal-ribbed steel sheet in its local XY plane (x 0..len along the wall, y from `y0` to a top that runs
 * `y1a`→`y1b`), ribs every 0.2 m, 2 cm deep, facing ±z (both sides drawn by the material's own side setting; UVs in m).
 */
function corrugated(len: number, y0: number, y1a: number, y1b: number) {
  const pitch = 0.2
  const n = Math.max(2, Math.round(len / pitch) * 4)
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= n; i++) {
    const x = (len * i) / n
    const ph = ((x / pitch) % 1 + 1) % 1
    const z = ph < 0.25 ? 0 : ph < 0.5 ? (ph - 0.25) * 4 * 0.02 : ph < 0.75 ? 0.02 : (1 - ph) * 4 * 0.02
    const top = y1a + ((y1b - y1a) * x) / len
    pos.push(x, y0, z, x, top, z)
    uv.push(x, y0, x, top)
    if (i > 0) {
      const a = (i - 1) * 2
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  // Back faces too (inside and outside of the shed): a mirrored copy.
  const back = g.clone()
  const bi = [...idx]
  for (let i = 0; i < bi.length; i += 3) [bi[i + 1], bi[i + 2]] = [bi[i + 2]!, bi[i + 1]!]
  back.setIndex(bi)
  const merged = new THREE.BufferGeometry()
  const p2 = new Float32Array([...pos, ...pos])
  merged.setAttribute("position", new THREE.BufferAttribute(p2, 3))
  merged.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([...uv, ...uv]), 2))
  const nv = pos.length / 3
  merged.setIndex([...idx, ...bi.map((k) => k + nv)])
  merged.computeVertexNormals()
  return merged
}
