import * as THREE from "three/webgpu"
import { FBXLoader } from "three/addons/loaders/FBXLoader.js"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js"
import ROSTER from "../../src/playerb/roster.json"

// Raw-vs-converted check for the roster pipeline (dev only, served by the dev server; reads gitignored mixamo-src/):
// left = the raw Mixamo character FBX with the raw clip FBX (FBXLoader, names matched by stripping the mixamorigN
// prefix: exact for Remy, a naive same-name copy for the others), right = the converted glb with anims.glb the way
// the game plays it (rotations + Hips position × hipRatio). Raw is scaled so its hips match the converted hips.
//   /scripts/playerb/compare.html?char=remy&clip=walking&frame=10&view=side|front|3q&mode=pair|bind
// window.__cmp.set(char, clip, frame, view) re-poses; ready flag for automation.

type Meta = { characters: Record<string, { name: string; hips: number; hipRatio: number }>; anims: { clips: Record<string, { duration: number }> } }
const META = ROSTER as unknown as Meta
const params = new URLSearchParams(location.search)
const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const label = document.querySelector<HTMLDivElement>("#label")!
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
await renderer.init()
renderer.setSize(innerWidth, innerHeight, false)
renderer.toneMapping = THREE.AgXToneMapping
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1d2226)
scene.add(new THREE.HemisphereLight(0xdfe6ec, 0x4a4440, 2.4))
const sun = new THREE.DirectionalLight(0xfff1e0, 2.5)
sun.position.set(2, 4, 3)
scene.add(sun)
const grid = new THREE.GridHelper(10, 40, 0x666a70, 0x33383d)
scene.add(grid)
const stairsGroup = new THREE.Group()
scene.add(stairsGroup)
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.05, 100)

const fbx = new FBXLoader()
const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
const SRC = "/mixamo-src"
const BASE = `${import.meta.env.BASE_URL}models/characters/`
const animsGlb = await gltf.loadAsync(`${BASE}anims.glb`)
const strip = (n: string) => n.replace(/^mixamorig\d*:?/, "")

const rawChars = new Map<string, THREE.Group>()
const rawClips = new Map<string, THREE.AnimationClip>()
const glbChars = new Map<string, THREE.Object3D>()
let raw: THREE.Object3D | null = null
let refRemy: THREE.Object3D | null = null
let stairsFoot: number | null = null
let conv: THREE.Object3D | null = null

async function loadRaw(id: string) {
  let g = rawChars.get(id)
  if (!g) {
    g = await fbx.loadAsync(`${SRC}/characters/${META.characters[id]!.name}.fbx`)
    g.traverse((o) => {
      o.name = strip(o.name)
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false
    })
    rawChars.set(id, g)
  }
  return g
}
async function loadRawClip(clip: string) {
  let c = rawClips.get(clip)
  if (!c) {
    const g = await fbx.loadAsync(`${SRC}/anims/${clip}.fbx`)
    c = g.animations[0]!
    for (const t of c.tracks) t.name = strip(t.name)
    rawClips.set(clip, c)
  }
  return c
}
async function loadConv(id: string) {
  let g = glbChars.get(id)
  if (!g) {
    g = (await gltf.loadAsync(`${BASE}${id}.glb`)).scene
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false
    })
    glbChars.set(id, g)
  }
  return g
}

function hipsY(root: THREE.Object3D) {
  root.updateMatrixWorld(true)
  return root.getObjectByName("Hips")!.getWorldPosition(new THREE.Vector3()).y
}

async function set(id: string, clip: string, frame: number, view: string, mode = "pair", zoom = "") {
  // Left: the raw FBX of this character (bind), or for a clip: raw Remy FBX + raw clip when id is remy, otherwise
  // the converted Remy playing the same converted clip (the clips only exist on Remy's skeleton).
  const leftRaw = mode === "bind" || id === "remy"
  const [r, c] = await Promise.all([leftRaw ? loadRaw(id) : loadConv("remy").then((g) => (refRemy ??= cloneSkinned(g))), loadConv(id)])
  if (raw) scene.remove(raw)
  if (conv) scene.remove(conv)
  raw = r
  conv = c
  scene.add(r, c)
  // Bind pose first (for scale and the bind comparison): every node back to its loaded transform.
  for (const o of [r, c]) {
    o.traverse((x) => {
      const b = (x.userData.bind ??= [x.position.clone(), x.quaternion.clone(), x.scale.clone()]) as THREE.Vector3[] & THREE.Quaternion[]
      if (x === o) return
      x.position.copy(b[0] as unknown as THREE.Vector3)
      x.quaternion.copy(b[1] as unknown as THREE.Quaternion)
      x.scale.copy(b[2] as unknown as THREE.Vector3)
    })
  }
  r.scale.setScalar(1)
  r.position.set(0, 0, 0)
  const s = META.characters[id]!.hips / hipsY(r)
  r.scale.setScalar(leftRaw ? s : 1)
  const gap = zoom === "2" ? 0.22 : 0.55
  r.position.x = -gap
  c.position.x = gap
  let info = `${id}  bind pose`
  if (mode !== "bind" && !leftRaw) {
    const src = animsGlb.animations.find((a) => a.name === clip)!
    for (const [o, who] of [[r, "remy"], [c, id]] as const) {
      const ratio = META.characters[who]!.hipRatio
      const tracks = src.tracks.filter((t) => t.name.endsWith(".quaternion") || t.name === "Hips.position").map((t) => {
        if (t.name !== "Hips.position") return t
        const k = t.clone()
        for (let i = 0; i < k.values.length; i++) k.values[i]! *= ratio
        return k
      })
      const m = new THREE.AnimationMixer(o)
      const a = m.clipAction(new THREE.AnimationClip(clip, src.duration, tracks))
      a.play()
      a.time = frame / 30
      m.update(0)
    }
    info = `${id} vs converted remy  ${clip}  frame ${frame}`
  } else if (mode !== "bind") {
    const rc = await loadRawClip(clip)
    const t0 = rc.tracks[0]!.times[0]!
    const mr = new THREE.AnimationMixer(r)
    const ar = mr.clipAction(rc)
    ar.play()
    ar.time = t0 + frame / 30
    mr.update(0)
    const src = animsGlb.animations.find((a) => a.name === clip)!
    const ratio = META.characters[id]!.hipRatio
    const tracks = src.tracks
      .filter((t) => t.name.endsWith(".quaternion") || t.name === "Hips.position")
      .map((t) => {
        if (t.name !== "Hips.position") return t
        const k = t.clone()
        for (let i = 0; i < k.values.length; i++) k.values[i]! *= ratio
        return k
      })
    const mc = new THREE.AnimationMixer(c)
    const ac = mc.clipAction(new THREE.AnimationClip(clip, src.duration, tracks))
    ac.play()
    ac.time = frame / 30
    mc.update(0)
    info = `${id}  ${clip}  frame ${frame}  raw t ${(t0 + frame / 30).toFixed(3)} (clip ${rc.duration.toFixed(3)})  glb t ${(frame / 30).toFixed(3)} (clip ${src.duration.toFixed(3)})`
  }
  if (params.get("stairs") === "1" && mode !== "bind") {
    // Put the converted body back on the staircase its clip implies: travel speed·t forward and rise·t up (the root
    // motion the runtime supplies), steps of rise·T/2 by speed·T/2, the frame-0 supporting foot on a step.
    const m = (META.anims.clips as Record<string, { duration: number; speed?: number; rise?: number }>)[clip]!
    const k = META.characters[id]!.hips / 0.98
    const T = m.duration
    const sp = (m.speed ?? 0) * k
    const ri = (m.rise ?? 0) * k
    const t = frame / 30
    const footY = () => {
      c.updateMatrixWorld(true)
      return Math.min(...["LeftFoot", "RightFoot"].map((n) => c.getObjectByName(n)!.getWorldPosition(new THREE.Vector3()).y))
    }
    c.position.set(0, 0, 0)
    const f0 = stairsFoot ?? footY()
    if (frame === 0) stairsFoot = f0
    c.position.set(0, ri * t, sp * t)
    stairsGroup.clear()
    const sh = Math.abs(ri) * T / 2
    const sr = sp * T / 2
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0x8d8a82, roughness: 0.9 })
    for (let i = -4; i <= 8; i++) {
      const top = Math.sign(ri) * i * sh - (f0 - 0.1 * k)
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 3, sr), mat)
      box.position.set(0, top - 1.5, (i + 0.5) * sr - sr * 0.5)
      stairsGroup.add(box)
    }
    r.visible = false
    info += `  stairs ${(sh * 100).toFixed(0)} cm × ${(sr * 100).toFixed(0)} cm`
  } else r.visible = true
  if (params.get("travel") === "1") {
    // Show the raw clip's own root travel (the raw stairs descend); the converted body stays in place.
    r.updateMatrixWorld(true)
    status.rawHips = r.getObjectByName("Hips")!.getWorldPosition(new THREE.Vector3()).toArray()
  }
  // Raw clips may travel (stairs, door): keep the raw body framed by its hips.
  r.updateMatrixWorld(true)
  const hr = r.getObjectByName("Hips")!.getWorldPosition(new THREE.Vector3())
  r.position.x += -gap - hr.x
  r.position.z += -hr.z
  const at = new THREE.Vector3(0, zoom === "2" ? 1.58 : zoom ? 1.4 : 0.9, 0)
  const d = zoom === "2" ? 1.1 : zoom ? 2.5 : 4.6
  const dir = { side: new THREE.Vector3(1, 0.05, 0), front: new THREE.Vector3(0, 0.05, 1), "3q": new THREE.Vector3(0.7, 0.1, 0.7) }[view] ?? new THREE.Vector3(0, 0.05, 1)
  if (params.get("stairs") === "1") {
    // (positioned above)
  } else if (view === "side") {
    // Side by side along the view axis doesn't work from the side: stack them in depth instead.
    r.position.x += 0.55
    r.position.z += -0.6
    c.position.set(0, 0, 0.6)
    at.set(0, 0.9, 0)
  } else {
    c.position.z = 0
  }
  if (params.get("stairs") === "1") at.set(0, c.position.y + 0.9, c.position.z)
  camera.position.copy(at).addScaledVector(dir.normalize(), d)
  camera.lookAt(at)
  label.textContent = `left/back: ${leftRaw ? "RAW FBX" : "converted remy"}   right/front: CONVERTED glb\n${info}`
  renderer.render(scene, camera)
  status.ready = true
}

const status = { ready: false, set, rawHips: [0, 0, 0] as number[] }
;(globalThis as { __cmp?: unknown }).__cmp = status
await set(params.get("char") ?? "remy", params.get("clip") ?? "walking", Number(params.get("frame") ?? 0), params.get("view") ?? "front", params.get("mode") ?? "pair", params.get("zoom") ?? "")
renderer.setAnimationLoop(() => renderer.render(scene, camera))
