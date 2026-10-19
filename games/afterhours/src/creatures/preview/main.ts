import * as THREE from "three/webgpu"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { loadMaterials } from "../../render/materials"
import { buildForest, buildStudio, type LabScene } from "../../monster-lab/scenes"
import { createLabPost } from "../../monster-lab/post"
import { createWendigo, type WendigoMode, type WendigoStance } from "../wendigo"
import { BIPED, STOOP } from "../wendigo/animate"

// Creature Forge preview (dev only): orbit the procedural Wendigo in a studio or the night forest with a flashlight,
// switch modes, or run the stalk → freeze → rear → lunge sequence.
//
// Automation (query): scene=studio|forest  mode=idle|stalk|freeze|lunge|rear|stalk-upright|rise|drop|seq|gaits
//   stance=quad|biped  cam=front|side|back|q34|close|skull|far|hero|pov|track (track: follows from the side)
//   skip=<s to simulate first>  clean=1 (hide UI)  flash=0|1  dist=<m> (start distance for seq)  yaw=<deg> (creature)
// `__creature` reports { ready, frames, mode, t }.

const params = new URLSearchParams(location.search)
const status = { ready: false, frames: 0, mode: "", stance: "", t: 0, top: 0, meas: {} as Record<string, number[]>, errors: [] as string[] }
;(globalThis as { __creature?: typeof status }).__creature = status
window.addEventListener("error", (e) => status.errors.push(String(e.message)))
if (params.get("clean") === "1") document.body.classList.add("clean")

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!
const canvas = $<HTMLCanvasElement>("#view")
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false })
await renderer.init()
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight, false)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
await loadMaterials(renderer)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 400)
scene.add(camera)
const post = createLabPost(renderer, scene, camera)
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true

const torch = new THREE.SpotLight(0xfff0d8, 24, 45, 0.42, 0.85, 2)
torch.position.set(0.25, -0.3, 0.1)
torch.target.position.set(0, -0.2, -10)
torch.castShadow = true
torch.shadow.mapSize.set(1024, 1024)
torch.shadow.camera.near = 0.2
torch.shadow.bias = -0.0002
torch.shadow.normalBias = 0.02
camera.add(torch, torch.target)

const scenes: Record<string, () => LabScene> = { studio: buildStudio, forest: buildForest }
let current: LabScene
const built = new Map<string, LabScene>()
function showScene(id: string) {
  let s = built.get(id)
  if (!s) {
    s = scenes[id]!()
    built.set(id, s)
    scene.add(s.group)
  }
  for (const o of built.values()) o.group.visible = o === s
  current = s
  scene.fog = s.fog
  scene.background = s.background
  post.setExposure(s.exposure)
  setFlash(params.has("flash") ? params.get("flash") === "1" : s.flashlight)
  mark("#scenes", id)
}
function setFlash(on: boolean) {
  torch.visible = on
  mark("#flash", on ? "on" : "off")
}

// Automation only: ?biped={"pitch":1.1} overrides the upright-stance numbers for tuning.
if (params.get("biped")) Object.assign(BIPED, JSON.parse(params.get("biped")!))
if (params.get("stoopk")) Object.assign(STOOP, JSON.parse(params.get("stoopk")!))
const w = createWendigo()
scene.add(w.root)
await w.ready
w.root.traverse((o) => (o.castShadow = true))
if (w.animator && params.has("stoop")) w.animator.stoop = Number(params.get("stoop"))

type Seq = "seq" | "gaits"
let mode: WendigoMode | Seq = (params.get("mode") as WendigoMode | Seq) ?? "idle"
const stanceParam = (params.get("stance") as WendigoStance | null) ?? undefined
const seqStart = new THREE.Vector3()
const sequences: Record<Seq, [WendigoMode, number][]> = {
  // The full showreel: both gaits, both transitions, the freeze, the scare and the lunge.
  seq: [
    ["stalk", 5.5],
    ["freeze", 1.6],
    ["rise", 2.4],
    ["stalk-upright", 6.5],
    ["freeze", 1.4],
    ["drop", 2.2],
    ["stalk", 2.4],
    ["rear", 3.0],
    ["idle", 0.5],
    ["lunge", 2.5],
  ],
  // Side-on gait study: quad stalk, rise, upright stalk, drop, quad stalk.
  gaits: [
    ["stalk", 5],
    ["rise", 2.4],
    ["stalk-upright", 7],
    ["drop", 2.2],
    ["stalk", 4],
  ],
}
const isSeq = () => mode === "seq" || mode === "gaits"
let seqT = 0
function seqMode(): WendigoMode {
  let t = seqT
  for (const [m, d] of sequences[mode as Seq]) {
    if (t < d) return m
    t -= d
  }
  return "freeze"
}

function placeCreature() {
  const yaw = (Number(params.get("yaw") ?? 0) * Math.PI) / 180
  if (mode === "gaits") {
    // Walks across the clearing, left to right, side on.
    w.root.position.set(-6, 0, -2)
    w.root.rotation.set(0, Math.PI / 2, 0)
  } else if (isSeq() || mode === "stalk" || mode === "lunge" || mode === "stalk-upright") {
    const d = Number(params.get("dist") ?? (isSeq() ? 9 : 6))
    w.root.position.set(0.3, 0, viewer.z - d)
    w.root.rotation.set(0, 0, 0)
  } else {
    w.root.position.set(0, 0, 0)
    w.root.rotation.set(0, yaw, 0)
  }
  seqStart.copy(w.root.position)
  seqT = 0
  // Settle the feet.
  if (w.animator) {
    ;(w.animator as unknown as { initialised: boolean }).initialised = false
    w.update(0.016, { mode: "idle", stance: stanceParam ?? "quad" })
  }
}

const viewer = new THREE.Vector3(0, 1.65, 6)
const _hp = new THREE.Vector3()
const _tc = new THREE.Vector3()
let cam = params.get("cam") ?? "front"
const target = new THREE.Vector3()
function setCam(id: string) {
  mark("#cams", id)
  const c = w.root.position
  const at = new THREE.Vector3(c.x, 1.15, c.z)
  const P: Record<string, [number, number, number, number]> = {
    // [x, y, z (relative to the creature), look-at height]
    front: [0, 1.4, 5.2, 1.15],
    side: [5.4, 1.3, 0, 1.15],
    back: [0, 1.6, -5.2, 1.2],
    q34: [3.6, 1.5, 3.9, 1.2],
    close: [0.9, 1.05, 2.4, 0.95],
    skull: [0.35, 0.95, 1.85, 0.95],
    feet: [1.2, 0.5, 1.6, 0.2],
    antler: [1.3, 2.0, 1.9, 1.75],
    far: [1.5, 1.7, 13, 1.2],
    hero: [1.2, 0.7, 3.3, 1.5],
    pov: [0, 1.65, viewer.z - c.z, 1.3],
    track: [0, 1.6, 7.5, 1.4],
  }
  const p = [...(P[id] ?? P.front!)] as [number, number, number, number]
  // Upright it's ~3.5 m tall: pull the wide views back and up so the antlers stay in frame.
  if (w.stance === "biped" && ["front", "side", "back", "q34"].includes(id)) {
    p[0] *= 1.35
    p[2] *= 1.35
    p[1] += 0.35
    p[3] = 1.85
  }
  camera.position.set(c.x + p[0], p[1], c.z + p[2])
  at.y = p[3]
  controls.target.copy(at)
  camera.lookAt(at)
  controls.update()
}

// ------------------------------------------------------------------ UI
function mark(sel: string, v: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`${sel} button`)) b.classList.toggle("on", b.dataset.id === v)
}
function buttons(sel: string, items: string[], on: (id: string) => void) {
  const el = $(sel)
  for (const id of items) {
    const b = document.createElement("button")
    b.textContent = id
    b.dataset.id = id
    b.onclick = () => on(id)
    el.append(b)
  }
}
buttons("#modes", ["idle", "stalk", "stalk-upright", "rise", "drop", "freeze", "lunge", "rear", "seq", "gaits"], (id) => {
  const prev = mode
  mode = id as WendigoMode | Seq
  if (isSeq() || (id === "lunge" && prev !== "stalk") || ((id === "stalk" || id === "stalk-upright") && !["stalk", "stalk-upright", "freeze", "rise", "drop"].includes(prev))) placeCreature()
  if (id === "gaits") cam = "track"
  mark("#modes", id)
})
buttons("#scenes", ["studio", "forest"], showScene)
buttons("#cams", ["front", "side", "back", "q34", "close", "skull", "antler", "feet", "far", "hero", "pov", "track"], (id) => {
  cam = id
  setCam(id)
})
buttons("#flash", ["on", "off"], (id) => setFlash(id === "on"))
window.addEventListener("keydown", (e) => e.code === "KeyF" && setFlash(!torch.visible))
window.addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

showScene(params.get("scene") ?? "forest")
mark("#modes", mode)
placeCreature()
setCam(params.get("cam") ?? "front")

/**
 * Landmark positions in the creature's own frame (x right, y up, z forward; metres), for checking a stance by numbers:
 * hip joints, shoulder joints, the skull's mid-point, middle-finger claw bases, knees, hocks and the balls of the feet.
 */
const _m = new THREE.Vector3()
const _inv = new THREE.Matrix4()
/** The real top of the antlers: every antler vertex through the head bone (they're rigid on it). */
const _av = new THREE.Vector3()
function antlerTop() {
  const rig = w.rig!
  const part = rig.data.parts.find((p) => p.name === "antlers")
  if (!part) return 0
  const hi = rig.bones.findIndex((b) => b.name === "head")
  const head = rig.data.bones[hi]!.head
  const m = rig.bones[hi]!.matrixWorld
  let top = -Infinity
  const pos = rig.data.positions
  for (let k = part.start; k < part.start + part.count; k += 9) {
    const v = rig.data.indices[k]!
    _av.set(pos[v * 3]! - head[0], pos[v * 3 + 1]! - head[1], pos[v * 3 + 2]! - head[2]).applyMatrix4(m)
    if (_av.y > top) top = _av.y
  }
  return top - w.root.position.y
}

function measure(): Record<string, number[]> {
  const rig = w.rig!
  _inv.copy(w.root.matrixWorld).invert()
  const at = (bone: string, along = 0) => {
    const i = rig.bones.findIndex((b) => b.name === bone)
    const b = rig.bones[i]!
    b.getWorldPosition(_m)
    if (along) {
      const q = new THREE.Quaternion()
      b.getWorldQuaternion(q)
      _m.addScaledVector(rig.dir[i]!.clone().applyQuaternion(q), rig.length[i]! * along)
    }
    _m.applyMatrix4(_inv)
    return [+_m.x.toFixed(2), +_m.y.toFixed(2), +_m.z.toFixed(2)]
  }
  return {
    hipL: at("thighL"),
    hipR: at("thighR"),
    kneeL: at("shinL"),
    hockL: at("metaL"),
    footL: at("metaL", 1),
    footR: at("metaR", 1),
    shoulderL: at("uarmL"),
    shoulderR: at("uarmR"),
    elbowL: at("farmL"),
    skull: at("head", 0.5),
    handL: at("f1L3"),
    handR: at("f1R3"),
    toeL0: at("t1L0"),
    toeL2: at("t1L2", 1),
  }
}

/**
 * Jank meter: per-joint angular acceleration from each bone's local rotation, frame to frame (rad/s²), plus the root's
 * linear acceleration (m/s²). Reports spikes over a threshold, the max and the 99th percentile, worst joints first.
 * Exposed as `__creature.jank` (reset with ?jank=reset or by reloading).
 */
const SPIKE = 400
const jank = {
  prevQ: [] as THREE.Quaternion[],
  prevW: [] as THREE.Vector3[],
  prevP: new THREE.Vector3(),
  prevV: new THREE.Vector3(),
  frames: 0,
  samples: [] as number[],
  perBone: new Map<string, { max: number; spikes: number }>(),
  rootAcc: [] as number[],
  events: new Map<string, number>(),
  lastMode: "",
}
const _jq = new THREE.Quaternion()
const _jw = new THREE.Vector3()
function jankSample(dt: number, mode: string) {
  const rig = w.rig
  if (!rig) return
  // Freeze is an intentional dead stop: skip the frames entering and leaving it.
  const skipFrame = mode === "freeze" || jank.lastMode === "freeze"
  jank.lastMode = mode
  const first = jank.prevQ.length === 0
  rig.bones.forEach((b, i) => {
    if (first) {
      jank.prevQ.push(b.quaternion.clone())
      jank.prevW.push(new THREE.Vector3())
      return
    }
    // Angular velocity from the delta rotation (shortest arc).
    _jq.copy(jank.prevQ[i]!).invert().multiply(b.quaternion)
    if (_jq.w < 0) _jq.set(-_jq.x, -_jq.y, -_jq.z, -_jq.w)
    const ang = 2 * Math.acos(Math.min(1, _jq.w))
    const sn = Math.sqrt(Math.max(1e-12, 1 - _jq.w * _jq.w))
    _jw.set(_jq.x / sn, _jq.y / sn, _jq.z / sn).multiplyScalar(ang / dt)
    if (jank.frames > 2 && !skipFrame) {
      const acc = _jw.distanceTo(jank.prevW[i]!) / dt
      if (acc > SPIKE) jank.events.set(`${mode}@${status.t.toFixed(1)}`, (jank.events.get(`${mode}@${status.t.toFixed(1)}`) ?? 0) + 1)
      jank.samples.push(acc)
      const e = jank.perBone.get(b.name) ?? { max: 0, spikes: 0 }
      e.max = Math.max(e.max, acc)
      if (acc > SPIKE) e.spikes++
      jank.perBone.set(b.name, e)
    }
    jank.prevW[i]!.copy(_jw)
    jank.prevQ[i]!.copy(b.quaternion)
  })
  const v = _jw.subVectors(w.root.position, jank.prevP).divideScalar(dt)
  if (jank.frames > 2 && !skipFrame) jank.rootAcc.push(v.distanceTo(jank.prevV) / dt)
  jank.prevV.copy(v)
  jank.prevP.copy(w.root.position)
  jank.frames++
}
function jankReport() {
  const s = [...jank.samples].sort((a, b) => a - b)
  const r = [...jank.rootAcc].sort((a, b) => a - b)
  const pct = (a: number[], p: number) => +(a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0).toFixed(1)
  const worst = [...jank.perBone.entries()].sort((a, b) => b[1].spikes - a[1].spikes || b[1].max - a[1].max).slice(0, 8)
  return {
    frames: jank.frames,
    threshold: SPIKE,
    spikes: s.filter((x) => x > SPIKE).length,
    p99: pct(s, 0.99),
    p999: pct(s, 0.999),
    max: +(s[s.length - 1] ?? 0).toFixed(0),
    rootAccMax: +(r[r.length - 1] ?? 0).toFixed(2),
    rootAccP99: pct(r, 0.99),
    worst: worst.map(([n, e]) => `${n}:${e.spikes}/${e.max.toFixed(0)}`),
    when: [...jank.events.entries()].slice(0, 12).map(([k, n]) => `${k}x${n}`),
  }
}
;(globalThis as { __jank?: () => unknown }).__jank = jankReport

function step(dt: number) {
  seqT += dt
  const m: WendigoMode = isSeq() ? seqMode() : (mode as WendigoMode)
  // The player: the camera's position (or the viewer spot in pov).
  if (mode === "gaits") target.set(60, 1.2, -2)
  else if (params.get("target") === "ahead") target.copy(w.root.position).add(new THREE.Vector3(0, 1, 30))
  else target.copy(camera.position)
  w.update(dt, { mode: m, target, stance: isSeq() ? undefined : stanceParam })
  jankSample(dt, m)
  status.mode = m
  status.stance = w.stance
  // Height of the antler tips (the mesh's highest point is ~1.0 m above the head bone).
  if (w.rig) {
    w.rig.byName.get("head")!.getWorldPosition(_hp)
    status.top = antlerTop()
    status.meas = measure()
  }
  if (cam === "track") {
    const c = w.root.position
    _hp.set(c.x - 0.5, 1.75, c.z)
    camera.position.lerp(_tc.set(c.x - 0.5, 1.9, c.z + 8.5), Math.min(1, dt * 3))
    controls.target.copy(_hp)
    camera.lookAt(_hp)
  }
  status.t = seqT
  current.update?.(dt, seqT, camera)
}

const skip = Number(params.get("skip") ?? 0)
for (let t = 0; t < skip; t += 1 / 30) step(1 / 30)
if (params.get("cam") && params.get("follow") !== "0" && skip > 0 && !isSeq() && cam !== "track") setCam(params.get("cam")!)

const clock = new THREE.Clock()
const info = $("#info")
const fixed = params.get("fixed") === "1"
renderer.setAnimationLoop(() => {
  const dt = fixed ? 1 / 30 : Math.min(clock.getDelta(), 0.05)
  step(dt)
  controls.update()
  post.render()
  status.frames++
  if (status.frames === 3) status.ready = true
  if (status.frames % 15 === 0) info.textContent = `${status.mode} · ${status.stance} · top ${status.top.toFixed(2)} m · t ${status.t.toFixed(1)} s · ${(w.rig?.data.indices.length ?? 0) / 3} tris`
})
