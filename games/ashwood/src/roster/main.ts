import * as THREE from "three/webgpu"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"

// A quick roster preview: each Mixamo character playing any of the shared clips.

const CHARACTERS = ["remy", "louise", "james", "megan", "kate"]
const base = `${import.meta.env.BASE_URL}models/characters/`

const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
await renderer.init()
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight, false)
renderer.toneMapping = THREE.AgXToneMapping
renderer.shadowMap.enabled = true

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x15181c)
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100)
camera.position.set(2.2, 1.5, 3.6)
const controls = new OrbitControls(camera, canvas)
controls.target.set(0, 0.95, 0)
controls.update()

scene.add(new THREE.HemisphereLight(0xdfe6ec, 0x4a4440, 2.6))
const key = new THREE.DirectionalLight(0xfff1e0, 3.2)
key.position.set(2.5, 4, 3)
key.castShadow = true
key.shadow.mapSize.set(2048, 2048)
key.shadow.camera.near = 0.5
key.shadow.camera.far = 12
scene.add(key)
const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 64), new THREE.MeshStandardNodeMaterial({ color: 0x3a3d40, roughness: 0.9 }))
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.add(floor)
const grid = new THREE.GridHelper(12, 24, 0x555a60, 0x2c3034)
grid.position.y = 0.002
scene.add(grid)

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
const anims = await loader.loadAsync(`${base}anims.glb`)
const clips = new Map(anims.animations.map((a) => [a.name, a]))

let model: THREE.Object3D | null = null
let mixer: THREE.AnimationMixer | null = null
let action: THREE.AnimationAction | null = null
let clipName = clips.has("walking-standard") ? "walking-standard" : anims.animations[0]!.name
let speed = 1
const cache = new Map<string, THREE.Group>()

async function show(name: string) {
  const gltf = cache.get(name) ?? (await loader.loadAsync(`${base}${name}.glb`)).scene
  cache.set(name, gltf)
  if (model) scene.remove(model)
  model = gltf
  if (model.userData.hips === undefined) model.userData.hips = await hipsHeight(model)
  action = null
  model.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) {
      m.castShadow = true
      m.frustumCulled = false
    }
  })
  scene.add(model)
  mixer = new THREE.AnimationMixer(model)
  play(clipName)
  mark("#chars", name)
}

// Clips were exported on Remy's skeleton and carry his bone lengths. For another character keep rotations only,
// plus the hips' position scaled by the ratio of hip heights. All files are in metres with a Y-up, unscaled armature
// (scripts/playerb/mixamo.py), so the world hip heights compare directly.
const remyHips = await hipsHeight((await loader.loadAsync(`${base}remy.glb`)).scene)
const retargeted = new Map<string, THREE.AnimationClip>()

async function hipsHeight(root: THREE.Object3D) {
  root.updateMatrixWorld(true)
  const p = new THREE.Vector3()
  root.getObjectByName("Hips")?.getWorldPosition(p)
  return Math.max(p.y, 1e-3)
}

function clipFor(name: string) {
  const clip = clips.get(name)
  if (!clip || !model) return clip
  const key = `${model.uuid}:${name}`
  const hit = retargeted.get(key)
  if (hit) return hit
  const ratio = (model.userData.hips as number) / remyHips
  const tracks = clip.tracks
    .filter((t) => t.name.endsWith(".quaternion") || t.name === "Hips.position")
    .map((t) => {
      if (t.name !== "Hips.position") return t
      const c = t.clone()
      for (let i = 0; i < c.values.length; i++) c.values[i] = c.values[i]! * ratio
      return c
    })
  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks)
  retargeted.set(key, out)
  return out
}

function play(name: string) {
  clipName = name
  const clip = clipFor(name)
  if (!mixer || !clip) return
  const next = mixer.clipAction(clip)
  next.reset().setEffectiveTimeScale(speed).play()
  if (action && action !== next) action.crossFadeTo(next, 0.25, false)
  action = next
  mark("#clips", name)
}

function mark(sel: string, name: string) {
  document.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle("on", b.textContent === name))
}

function buttons(sel: string, names: string[], onClick: (n: string) => void) {
  const row = document.querySelector(sel)!
  for (const n of names) {
    const b = document.createElement("button")
    b.textContent = n
    b.onclick = () => onClick(n)
    row.append(b)
  }
}

buttons("#chars", CHARACTERS, (n) => void show(n))
buttons("#clips", [...clips.keys()].sort(), play)
buttons("#speeds", ["0.25", "0.5", "1"], (n) => {
  speed = Number(n)
  action?.setEffectiveTimeScale(speed)
  mark("#speeds", n)
})
mark("#speeds", "1")
await show("remy")

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

const timer = new THREE.Timer()
renderer.setAnimationLoop(() => {
  timer.update()
  mixer?.update(timer.getDelta())
  controls.update()
  renderer.render(scene, camera)
})
