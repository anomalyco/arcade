import * as THREE from "three/webgpu"

// The Body Lab's room: a checker floor (foot sliding is easy to see against it), a staircase, a 15° ramp and a ladder
// against a wall, plus the analytic ground query and ladder volume the lab controller and the body use.

export const STAIRS = { x0: 2, z0: -1, z1: 1, rise: 0.17, run: 0.28, steps: 8, landing: 2 }
export const RAMP = { x0: -1, x1: 1, z0: 3, len: 5, angle: (15 * Math.PI) / 180, top: 2 }
export const LADDER = { x0: -4.4, x1: -3.6, z: -2.9, top: 3 }

const stairTop = STAIRS.x0 + STAIRS.steps * STAIRS.run
const rampH = Math.tan(RAMP.angle) * RAMP.len

/** Highest walkable surface at (x, z) no higher than maxY. */
export function groundAt(x: number, z: number, maxY: number) {
  let g = 0
  const take = (h: number) => {
    if (h <= maxY + 1e-6 && h > g) g = h
  }
  if (z >= STAIRS.z0 && z <= STAIRS.z1 && x >= STAIRS.x0) {
    if (x < stairTop) take(Math.floor((x - STAIRS.x0) / STAIRS.run + 1) * STAIRS.rise)
    else if (x < stairTop + STAIRS.landing) take(STAIRS.steps * STAIRS.rise)
  }
  if (x >= RAMP.x0 && x <= RAMP.x1 && z >= RAMP.z0) {
    if (z < RAMP.z0 + RAMP.len) take((z - RAMP.z0) * Math.tan(RAMP.angle))
    else if (z < RAMP.z0 + RAMP.len + RAMP.top) take(rampH)
  }
  if (x >= LADDER.x0 - 1.2 && x <= LADDER.x1 + 1.2 && z <= LADDER.z - 0.15 && z >= LADDER.z - 1.6) take(LADDER.top)
  return g
}

export function ladderAt(x: number, y: number, z: number) {
  return x >= LADDER.x0 && x <= LADDER.x1 && z >= LADDER.z && z <= LADDER.z + 0.45 && y < LADDER.top
}

function checker() {
  const c = document.createElement("canvas")
  c.width = c.height = 256
  const g = c.getContext("2d")!
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      g.fillStyle = (i + j) % 2 ? "#5d6158" : "#777b70"
      g.fillRect(i * 64, j * 64, 64, 64)
    }
  g.strokeStyle = "#3b3e38"
  g.lineWidth = 2
  for (let i = 0; i <= 4; i++) {
    g.beginPath()
    g.moveTo(i * 64, 0)
    g.lineTo(i * 64, 256)
    g.moveTo(0, i * 64)
    g.lineTo(256, i * 64)
    g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

export function buildStage(scene: THREE.Scene) {
  const tex = checker()
  // 1 checker cell = 0.5 m.
  tex.repeat.set(30, 30)
  const floorMat = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.85 })
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), floorMat)
  floor.receiveShadow = true
  scene.add(floor)
  const concrete = new THREE.MeshStandardNodeMaterial({ color: 0x8d8a82, roughness: 0.9 })
  const nosing = new THREE.MeshStandardNodeMaterial({ color: 0x3a3a36, roughness: 0.6, metalness: 0.4 })
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x, y, z)
    m.castShadow = m.receiveShadow = true
    scene.add(m)
    return m
  }
  const w = STAIRS.z1 - STAIRS.z0
  for (let i = 0; i < STAIRS.steps; i++) {
    const h = (i + 1) * STAIRS.rise
    add(new THREE.BoxGeometry(STAIRS.run, h, w), concrete, STAIRS.x0 + (i + 0.5) * STAIRS.run, h / 2, 0)
    add(new THREE.BoxGeometry(0.03, 0.02, w), nosing, STAIRS.x0 + i * STAIRS.run + 0.015, h - 0.01, 0)
  }
  const H = STAIRS.steps * STAIRS.rise
  add(new THREE.BoxGeometry(STAIRS.landing, H, w), concrete, stairTop + STAIRS.landing / 2, H / 2, 0)
  // Ramp: a wedge.
  const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(RAMP.len, 0), new THREE.Vector2(RAMP.len, rampH), new THREE.Vector2(RAMP.len + RAMP.top, rampH), new THREE.Vector2(RAMP.len + RAMP.top, 0)])
  const wedge = new THREE.ExtrudeGeometry(shape, { depth: RAMP.x1 - RAMP.x0, bevelEnabled: false })
  wedge.rotateY(-Math.PI / 2)
  const ramp = add(wedge, new THREE.MeshStandardNodeMaterial({ map: tex.clone(), roughness: 0.85 }), RAMP.x1, 0, RAMP.z0)
  ramp.position.set(RAMP.x1, 0, RAMP.z0)
  // Wall with a ladder and a platform at the top.
  add(new THREE.BoxGeometry(3.2, LADDER.top, 1.45), concrete, (LADDER.x0 + LADDER.x1) / 2, LADDER.top / 2, LADDER.z - 0.875)
  const steel = new THREE.MeshStandardNodeMaterial({ color: 0x6b6f6a, roughness: 0.45, metalness: 0.8 })
  for (const x of [LADDER.x0, LADDER.x1]) add(new THREE.BoxGeometry(0.05, LADDER.top + 1, 0.05), steel, x, (LADDER.top + 1) / 2, LADDER.z - 0.1)
  for (let y = 0.3; y < LADDER.top + 0.9; y += 0.3) add(new THREE.CylinderGeometry(0.016, 0.016, LADDER.x1 - LADDER.x0, 10).rotateZ(Math.PI / 2), steel, (LADDER.x0 + LADDER.x1) / 2, y, LADDER.z - 0.1)

  scene.add(new THREE.HemisphereLight(0xb8c4d0, 0x2c2a26, 0.9))
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6)
  sun.position.set(6, 9, -5)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = sun.shadow.camera.bottom = -10
  sun.shadow.camera.right = sun.shadow.camera.top = 10
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.02
  scene.add(sun)
  // A warm lamp up in the corner, well clear of the head on the stair landing (at 3.2 m it sat half a metre from the
  // shoulder at the top of the flight and blew the shirt out in a hard orange patch).
  const lamp = new THREE.PointLight(0xffa860, 30, 16, 2)
  lamp.position.set(-2, 5, -5)
  scene.add(lamp)
  scene.background = new THREE.Color(0x1d2226)
  return { sun }
}
