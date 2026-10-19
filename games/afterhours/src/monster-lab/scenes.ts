import * as THREE from "three/webgpu"
import { material } from "../render/materials"
import { buildTree, type Kind } from "../world/forest/species"
import { foliageAtlas, mipChain, type Level } from "../world/forest/paint"
import { InstLayer, band, foliageMaterial, forestUniforms, solidMaterial } from "../world/forest/render"

// The three places a monster is judged in: a neutral studio turntable, a foggy forest clearing at night (the game's
// own trees, bark and forest-floor scans) and a dark tiled corridor (the game's tile, linoleum and ceiling materials)
// lit only by emergency lights. Each has a path that starts 25 m from the viewer, for the "walks toward you" preset.

export type SceneId = "studio" | "forest" | "corridor"

export type LabScene = {
  id: SceneId
  label: string
  group: THREE.Group
  fog: THREE.FogExp2 | null
  background: THREE.Color
  /** Exposure offset in EV for this scene. */
  exposure: number
  /** Flashlight on when the scene opens. */
  flashlight: boolean
  /** Where the monster stands by default. */
  spot: THREE.Vector3
  /** The approach path: starts 25 m from the viewer, ends just in front of them. */
  path: THREE.Vector3[]
  /** Viewer position (feet) and the point they face, for first person and the approach preset. */
  viewer: THREE.Vector3
  look: THREE.Vector3
  update?: (dt: number, time: number, camera: THREE.Camera) => void
}

/** A plane with UVs in metres (1 UV = 1 m), as the game's materials expect. */
function plane(w: number, h: number, mat: THREE.Material) {
  const g = new THREE.PlaneGeometry(w, h)
  const uv = g.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h)
  const m = new THREE.Mesh(g, mat)
  m.receiveShadow = true
  return m
}

export function buildStudio(): LabScene {
  const group = new THREE.Group()
  const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 96).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: 0x45474a, roughness: 0.85 }))
  floor.receiveShadow = true
  group.add(floor)
  const grid = new THREE.GridHelper(80, 80, 0x6a6e74, 0x3a3d41)
  grid.position.y = 0.003
  group.add(grid)
  // Turntable disc under the monster's default spot.
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.65, 0.04, 96), new THREE.MeshStandardNodeMaterial({ color: 0x2c2e31, roughness: 0.9 }))
  disc.position.y = -0.018
  disc.receiveShadow = true
  group.add(disc)
  group.add(new THREE.HemisphereLight(0xdfe6ec, 0x3a3632, 1.6))
  const key = new THREE.DirectionalLight(0xfff1e0, 3.2)
  key.position.set(4, 7, 5)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.left = key.shadow.camera.bottom = -6
  key.shadow.camera.right = key.shadow.camera.top = 6
  key.shadow.camera.far = 30
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.02
  group.add(key, key.target)
  const rim = new THREE.DirectionalLight(0xbcd2ff, 2.2)
  rim.position.set(-5, 4, -6)
  group.add(rim)
  return {
    id: "studio",
    label: "Studio turntable",
    group,
    fog: new THREE.FogExp2(0x1e2124, 0.03),
    background: new THREE.Color(0x1e2124),
    exposure: -1,
    flashlight: false,
    spot: new THREE.Vector3(0, 0, 0),
    path: [new THREE.Vector3(0, 0, -21), new THREE.Vector3(0, 0, 2.2)],
    viewer: new THREE.Vector3(0, 0, 4),
    look: new THREE.Vector3(0, 1.4, -10),
  }
}

function levelsTexture(levels: Level[]) {
  const base = levels[0]!
  const tex = new THREE.DataTexture(base.data, base.width, base.height, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.mipmaps = levels as unknown as THREE.DataTexture["mipmaps"]
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 4
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false
  tex.needsUpdate = true
  return tex
}

/** Deterministic 0..1 sequence. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildForest(): LabScene {
  const group = new THREE.Group()
  const path = [new THREE.Vector3(5, 0, -18.5), new THREE.Vector3(2.5, 0, -11), new THREE.Vector3(0.4, 0, -4), new THREE.Vector3(0, 0, 3.6)]
  const viewer = new THREE.Vector3(0, 0, 6)

  const ground = plane(200, 200, material("forest_floor"))
  ground.rotation.x = -Math.PI / 2
  group.add(ground)

  // The game's conifers (full-detail models, its foliage atlas and bark), ringing a small clearing.
  const atlas = levelsTexture(mipChain(foliageAtlas()))
  const all = band(-1e5, 1e5)
  const bark = solidMaterial(material("bark"))
  const variants: { kind: Kind; seed: number; tint: THREE.Color }[] = [
    { kind: "fir", seed: 101, tint: new THREE.Color(0.95, 1, 0.95) },
    { kind: "fir", seed: 102, tint: new THREE.Color(0.95, 1, 0.95) },
    { kind: "firEdge", seed: 201, tint: new THREE.Color(0.95, 1, 0.95) },
    { kind: "pine", seed: 301, tint: new THREE.Color(1.08, 1.05, 0.85) },
    { kind: "young", seed: 401, tint: new THREE.Color(1, 1.05, 0.95) },
    { kind: "sapling", seed: 501, tint: new THREE.Color(1.05, 1.08, 0.95) },
    { kind: "snag", seed: 601, tint: new THREE.Color(0.9, 0.85, 0.8) },
  ]
  const layers = variants.map((v, i) => {
    const m = buildTree(v.kind, v.seed)
    const layer = new InstLayer(400, [
      { geometry: m.lod0.trunk, material: bark, castShadow: true, name: `tree-${i}-trunk`, band: all },
      { geometry: m.lod0.foliage, material: foliageMaterial(atlas, v.tint, all), castShadow: true, name: `tree-${i}-foliage` },
    ])
    for (const mesh of layer.meshes) group.add(mesh)
    return { layer, n: 0, kind: v.kind }
  })
  const r = rng(1984)
  const nearPath = (x: number, z: number, clear: number) => {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!
      const b = path[i + 1]!
      const abx = b.x - a.x
      const abz = b.z - a.z
      const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz)))
      if (Math.hypot(x - a.x - abx * t, z - a.z - abz * t) < clear) return true
    }
    return false
  }
  const placed: [number, number][] = []
  for (let tries = 0; tries < 6000 && placed.length < 520; tries++) {
    const ang = r() * Math.PI * 2
    const rad = 7.5 + Math.pow(r(), 0.7) * 70
    const x = Math.cos(ang) * rad
    const z = Math.sin(ang) * rad - 4
    if (nearPath(x, z, 1.6) || Math.hypot(x - viewer.x, z - viewer.z) < 2.5) continue
    if (placed.some(([px, pz]) => (px - x) ** 2 + (pz - z) ** 2 < 4.4 * 4.4 * (rad < 20 ? 0.45 : 1))) continue
    placed.push([x, z])
    const pick = r()
    // Fewer big firs right at the clearing edge, more young trees and saplings there.
    const vi = rad < 14 ? (pick < 0.35 ? 4 : pick < 0.6 ? 5 : pick < 0.8 ? 3 : pick < 0.9 ? 6 : 2) : pick < 0.3 ? 0 : pick < 0.55 ? 1 : pick < 0.7 ? 2 : pick < 0.88 ? 3 : pick < 0.95 ? 4 : 6
    const L = layers[vi]!
    const yaw = r() * Math.PI * 2
    L.layer.set(L.n++, x, 0, z, 0.85 + r() * 0.3, Math.cos(yaw), Math.sin(yaw), 0.8 + r() * 0.35, r() * 6.28)
  }
  for (const L of layers) L.layer.commit(L.n)

  // Fallen logs across the floor (bark, cylinders with a sag), so the ground isn't a flat sheet.
  const logMat = material("bark")
  for (let i = 0; i < 9; i++) {
    const len = 2 + r() * 4
    const g = new THREE.CylinderGeometry(0.12 + r() * 0.12, 0.16 + r() * 0.14, len, 12, 1)
    const uv = g.attributes.uv as THREE.BufferAttribute
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 1.2, uv.getY(k) * len)
    const log = new THREE.Mesh(g, logMat)
    let x = 0
    let z = 0
    do {
      x = (r() - 0.5) * 34
      z = (r() - 0.5) * 34 - 4
    } while (nearPath(x, z, 2.2) || Math.hypot(x, z - 6) < 4)
    log.position.set(x, 0.12, z)
    log.rotation.set(Math.PI / 2, 0, r() * Math.PI)
    log.castShadow = log.receiveShadow = true
    group.add(log)
  }

  // Moonlight through the fog: a faint blue-green fill and a dim key, so silhouettes read near-black but present.
  group.add(new THREE.HemisphereLight(0x2c4a46, 0x0a0c0a, 0.12))
  const moon = new THREE.DirectionalLight(0x9fb8c4, 0.12)
  moon.position.set(-20, 40, -30)
  group.add(moon)
  return {
    id: "forest",
    label: "Forest clearing (night)",
    group,
    fog: new THREE.FogExp2(0x0f1d1b, 0.05),
    background: new THREE.Color(0x0f1d1b),
    exposure: 0,
    flashlight: true,
    spot: new THREE.Vector3(0.4, 0, -1.5),
    path,
    viewer,
    look: new THREE.Vector3(3.5, 1.5, -16),
    update: (_dt, _t, camera) => {
      forestUniforms.view.value.copy(camera.position)
    },
  }
}

export function buildCorridor(): LabScene {
  const group = new THREE.Group()
  const W = 2.6
  const H = 2.9
  const Z0 = 7
  const Z1 = -42
  const L = Z0 - Z1
  const zc = (Z0 + Z1) / 2
  const floor = plane(W, L, material("linoleum"))
  floor.rotation.x = -Math.PI / 2
  floor.position.set(0, 0, zc)
  group.add(floor)
  const ceil = plane(W, L, material("ceiling_tile"))
  ceil.rotation.x = Math.PI / 2
  ceil.position.set(0, H, zc)
  group.add(ceil)
  const dado = 1.55
  for (const side of [-1, 1]) {
    const tile = plane(L, dado, material("tile_green"))
    tile.rotation.y = side * -Math.PI / 2
    tile.position.set((side * W) / 2, dado / 2, zc)
    group.add(tile)
    const paint = plane(L, H - dado, material("painted_wall"))
    paint.rotation.y = side * -Math.PI / 2
    paint.position.set((side * W) / 2, dado + (H - dado) / 2, zc)
    group.add(paint)
  }
  for (const [z, ry] of [[Z1, 0], [Z0, Math.PI]] as const) {
    const end = plane(W, H, material("tile_green_dark"))
    end.rotation.y = ry
    end.position.set(0, H / 2, z)
    group.add(end)
  }
  // Steel doors in shallow frames along both walls, and the fluorescent troffers (dead: the power is out).
  const door = material("door_steel")
  const frame = material("metal_dark")
  for (let z = 3, i = 0; z > Z1 + 3; z -= 6.5, i++) {
    const side = i % 2 ? 1 : -1
    const x = (side * W) / 2 - side * 0.02
    const slab = plane(0.92, 2.1, door)
    slab.rotation.y = side * -Math.PI / 2
    slab.position.set(x, 1.05, z)
    group.add(slab)
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.2, 1.1), frame)
    jamb.position.set(x + side * 0.03, 1.1, z)
    group.add(jamb)
    slab.position.x = x - side * 0.02
  }
  const dead = new THREE.MeshStandardNodeMaterial({ color: 0x9a9c96, roughness: 0.35 })
  const troffer = new THREE.BoxGeometry(0.6, 0.05, 1.2)
  for (let z = 4; z > Z1; z -= 3.6) {
    const t = new THREE.Mesh(troffer, dead)
    t.position.set(0, H - 0.025, z)
    group.add(t)
  }
  // Emergency lighting: red beacons high on the walls, a twin-head battery unit over the far door, an exit sign.
  const red = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.08, 0.03).multiplyScalar(2.5) })
  const beacons: THREE.PointLight[] = []
  for (let z = -4, i = 0; z > Z1; z -= 9, i++) {
    const side = i % 2 ? 1 : -1
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), red)
    lamp.position.set(side * (W / 2 - 0.08), 2.45, z)
    group.add(lamp)
    const light = new THREE.PointLight(0xff2a12, 0.6, 7, 2)
    light.position.set(side * (W / 2 - 0.2), 2.4, z)
    group.add(light)
    beacons.push(light)
  }
  const twin = new THREE.SpotLight(0xffe2b0, 14, 30, 0.7, 0.6, 2)
  twin.position.set(0, 2.6, Z1 + 0.3)
  twin.target.position.set(0, 0, Z1 + 12)
  twin.castShadow = true
  twin.shadow.mapSize.set(1024, 1024)
  group.add(twin, twin.target)
  const heads = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.1), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.9, 0.7).multiplyScalar(6) }))
  heads.position.set(0, 2.62, Z1 + 0.05)
  group.add(heads)
  const exit = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.04), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.1, 1, 0.3).multiplyScalar(5) }))
  exit.position.set(0, 2.35, Z1 + 0.04)
  group.add(exit)
  group.add(new THREE.HemisphereLight(0x22302c, 0x080807, 0.05))
  return {
    id: "corridor",
    label: "Tiled corridor (emergency light)",
    group,
    fog: new THREE.FogExp2(0x080a0a, 0.035),
    background: new THREE.Color(0x020303),
    exposure: 0,
    flashlight: true,
    spot: new THREE.Vector3(0, 0, -1),
    path: [new THREE.Vector3(0, 0, -21), new THREE.Vector3(0, 0, 2.2)],
    viewer: new THREE.Vector3(0, 0, 4.2),
    look: new THREE.Vector3(0, 1.5, -20),
    update: (_dt, t) => {
      // Rotating-beacon pulse, each a little out of phase.
      beacons.forEach((b, i) => (b.intensity = 0.6 * (0.35 + 0.65 * Math.max(0, Math.sin(t * 3.2 + i * 1.7)) ** 2)))
    },
  }
}
