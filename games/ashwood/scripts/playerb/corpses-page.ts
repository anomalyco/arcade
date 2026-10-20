import * as THREE from "three/webgpu"
import { spawnCorpse, corpseInfo, type CorpseCharacter, type CorpsePose } from "../../src/world/npc/corpse"

// Dev sheet: every NPC (columns) in every corpse pose (rows) on a floor, with a wall behind the slumps and a chair
// and desk for slump-chair. ?pose=<name> shows one row large; ?cam=side|top|3q. window.__corpses.ready for automation.
const params = new URLSearchParams(location.search)
const CHARS: CorpseCharacter[] = params.get("chars") ? (params.get("chars")!.split(",") as CorpseCharacter[]) : ["joe", "brian", "lewis", "martha", "roth", "elizabeth"]
const ALL: CorpsePose[] = ["collapse-back", "knocked-out-back", "face-down", "electrocuted", "fall-forward-side", "lying-still", "slump-wall", "slump-wall-idle", "slump-chair"]
const POSES = params.get("pose") ? (params.get("pose")!.split(",") as CorpsePose[]) : ALL
const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
await renderer.init()
renderer.setSize(innerWidth, innerHeight, false)
renderer.toneMapping = THREE.AgXToneMapping
renderer.shadowMap.enabled = true
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1d2226)
scene.add(new THREE.HemisphereLight(0xdfe6ec, 0x4a4440, 2.2))
const sun = new THREE.DirectionalLight(0xfff1e0, 2.6)
sun.position.set(-6, 14, 8)
sun.castShadow = true
sun.shadow.mapSize.set(4096, 4096)
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, far: 40 })
scene.add(sun)
const floorMat = new THREE.MeshStandardNodeMaterial({ color: 0x5f625c, roughness: 0.9 })
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), floorMat)
floor.receiveShadow = true
scene.add(floor)
const grid = new THREE.GridHelper(60, 120, 0x777a72, 0x4d504a)
grid.position.y = 0.001
scene.add(grid)
const prop = new THREE.MeshStandardNodeMaterial({ color: 0x8d8a82, roughness: 0.8 })
const box = (w: number, h: number, d: number, x: number, y: number, z: number, parent: THREE.Object3D) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), prop)
  m.position.set(x, y, z)
  m.castShadow = m.receiveShadow = true
  parent.add(m)
}
const DX = 2.4
const DZ = 2.6
for (let r = 0; r < POSES.length; r++) {
  for (let c = 0; c < CHARS.length; c++) {
    const pose = POSES[r]!
    const ch = CHARS[c]!
    const x = (c - (CHARS.length - 1) / 2) * DX
    const z = (r - (POSES.length - 1) / 2) * DZ
    const g = await spawnCorpse(ch, pose, { x, y: 0, z, yaw: 0 })
    scene.add(g)
    const info = await corpseInfo(ch, pose)
    const holder = new THREE.Group()
    holder.position.set(x, 0, z)
    scene.add(holder)
    if (info.kind === "slump") box(1.4, 1.2, 0.1, 0, 0.6, -(info.wallBehind ?? 0.33) - 0.05, holder)
    if (info.kind === "chair" && info.seat) {
      box(0.45, 0.04, 0.45, 0, info.seat - 0.02, -0.05, holder)
      box(0.45, 0.5, 0.04, 0, info.seat + 0.25, -0.29, holder)
      const desk = (info as { desk?: number }).desk ?? 0.75
      box(1.2, 0.04, 0.7, 0, desk - 0.02, 0.62, holder)
    }
  }
}
const cam = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 200)
const view = params.get("cam") ?? "3q"
const span = Math.max(POSES.length * DZ, CHARS.length * DX)
if (view === "top") cam.position.set(0, span * 1.7, 0.01)
else if (view === "low") cam.position.set(span * 0.15, 0.9, span * 0.75 + 1.6)
else if (view === "lowside") cam.position.set(span * 0.75 + 2.2, 0.8, 0.2)
else if (view === "side") cam.position.set(span * 1.2, 1.2, 0)
else cam.position.set(span * 0.55, span * 0.95, span * 1.05)
cam.lookAt(0, view.startsWith("low") ? 0.4 : 0, 0)
renderer.render(scene, cam)
;(globalThis as { __corpses?: unknown }).__corpses = { ready: true }
renderer.setAnimationLoop(() => renderer.render(scene, cam))
