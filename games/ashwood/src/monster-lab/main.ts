import * as THREE from "three/webgpu"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { loadMaterials } from "../render/materials"
import { MONSTERS, soundUrl, type BehaviourStep, type Monster, type MonsterSound } from "./monsters"
import { loadRig, type Rig } from "./rig"
import { buildCorridor, buildForest, buildStudio, type LabScene, type SceneId } from "./scenes"
import { createLabPost } from "./post"

// Monster Lab (dev only): look at each monster in the three places it will be met, at the game's look, and judge how it
// moves: pick clips or run its scripted behaviour, orbit it, or stand in front of it in first person with a flashlight
// while it walks toward you from 25 m. Missing models show a grey-clay STAND-IN (see monsters.ts).
//
// Automation (query, read once): monster=<id> scene=studio|forest|corridor cam=orbit|fps|approach behaviour=1|0
// skip=<seconds to advance the simulation before the first frame> orbitYaw=<degrees>. `__monsterLab` reports ready/frames/errors.

type CamMode = "orbit" | "fps" | "approach"
const params = new URLSearchParams(location.search)
const status = { ready: false, frames: 0, errors: [] as string[], info: "" }
;(globalThis as { __monsterLab?: typeof status }).__monsterLab = status
window.addEventListener("error", (e) => status.errors.push(String(e.message)))
window.addEventListener("unhandledrejection", (e) => status.errors.push(String(e.reason)))

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const canvas = $<HTMLCanvasElement>("#view")
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false })
await renderer.init()
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight, false)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
$("#loading").textContent = "Loading materials…"
await loadMaterials(renderer)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 400)
scene.add(camera)
const post = createLabPost(renderer, scene, camera)
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true

// Flashlight: a two-D-cell beam from just below and right of the eye, on F.
const torch = new THREE.SpotLight(0xfff0d8, 20, 45, 0.45, 0.9, 2)
torch.position.set(0.18, -0.25, 0.1)
torch.target.position.set(0, -0.1, -10)
torch.castShadow = true
torch.shadow.mapSize.set(1024, 1024)
torch.shadow.camera.near = 0.2
torch.shadow.bias = -0.0002
torch.shadow.normalBias = 0.02
camera.add(torch, torch.target)

const listener = new THREE.AudioListener()
camera.add(listener)
const resumeAudio = () => void listener.context.resume()
window.addEventListener("pointerdown", resumeAudio)
window.addEventListener("keydown", resumeAudio)

// ------------------------------------------------------------------------------------------------- state
const state = {
  monster: MONSTERS.find((m) => m.id === params.get("monster")) ?? MONSTERS[0]!,
  sceneId: (params.get("scene") as SceneId) || "corridor",
  cam: (params.get("cam") as CamMode) || "orbit",
  behaviour: params.get("behaviour") !== "0",
  clip: "idle",
  speed: 1,
  scale: 1,
  rootMotion: false,
  autoSounds: true,
  flashlight: true,
}

const builders: Record<SceneId, () => LabScene> = { studio: buildStudio, forest: buildForest, corridor: buildCorridor }
const scenes = new Map<SceneId, LabScene>()
let current: LabScene | null = null
function showScene(id: SceneId) {
  let s = scenes.get(id)
  if (!s) {
    s = builders[id]()
    scenes.set(id, s)
    scene.add(s.group)
  }
  for (const o of scenes.values()) o.group.visible = o === s
  current = s
  state.sceneId = id
  scene.fog = s.fog
  scene.background = s.background
  post.setExposure(s.exposure)
  setFlashlight(s.flashlight)
  mark("#scenes", id)
  resetPlacement()
  setCam(state.cam)
}

function setFlashlight(on: boolean) {
  state.flashlight = on
  torch.visible = on
  mark("#flash", on ? "on" : "off")
}

// ------------------------------------------------------------------------------------------------- monster
const rigs = new Map<string, Rig>()
let rig: Rig | null = null
let action: THREE.AnimationAction | null = null
const place = { s: 0, yaw: 0, hover: 0, bend: 0, jaw: 0, headPitch: 0 }
const behaviour = { step: 0, t: 0 }
const baseRate = new WeakMap<THREE.AnimationAction, number>()

async function showMonster(m: Monster) {
  state.monster = m
  mark("#monsters", m.id)
  let r = rigs.get(m.id)
  if (!r) {
    $("#loading").textContent = `Loading ${m.name}…`
    r = await loadRig(m)
    rigs.set(m.id, r)
  }
  $("#loading").textContent = ""
  if (rig) scene.remove(rig.root)
  rig = r
  scene.add(r.root)
  action = null
  r.mixer.stopAllAction()
  r.scaler.scale.setScalar(r.baseScale * state.scale)
  const badge = $("#badge")
  badge.textContent = r.standIn ? `STAND-IN · ${m.name} · ${m.height} m (no ${m.glb})` : `${m.name} · ${m.height} m`
  badge.classList.toggle("stand", r.standIn)
  $<HTMLImageElement>("#concept").src = `${import.meta.env.BASE_URL}${m.concept}`
  buildClipButtons()
  buildSoundButtons()
  $("#bname").textContent = m.behaviour.name
  ambientIn = nextAmbient()
  resetPlacement()
  if (state.behaviour) startBehaviour()
  else play(state.clip)
}

function play(id: string, fade = 0.25, timeScale = 1) {
  if (!rig) return
  const c = rig.clips.get(id) ?? rig.clips.get("idle") ?? [...rig.clips.values()][0]
  if (!c) return
  if (!rig.clips.has(id)) id = [...rig.clips.entries()].find(([, v]) => v === c)![0]
  const next = rig.mixer.clipAction(c.clip)
  next.enabled = true
  next.setEffectiveWeight(1)
  next.setEffectiveTimeScale(timeScale * state.speed)
  if (next !== action) {
    next.reset().play()
    if (action) action.crossFadeTo(next, fade, false)
  }
  action = next
  state.clip = id
  baseRate.set(next, timeScale)
  mark("#clips", state.behaviour ? "▶ behaviour" : id)
}

function startBehaviour() {
  state.behaviour = true
  behaviour.step = -1
  behaviour.t = 0
  mark("#clips", "▶ behaviour")
  nextStep()
}

function nextStep() {
  if (!rig) return
  const steps = rig.monster.behaviour.steps
  behaviour.step++
  if (behaviour.step >= steps.length) {
    if (!rig.monster.behaviour.loop) {
      behaviour.step = steps.length - 1
      return
    }
    behaviour.step = 0
    // Back to the start of the path once it has reached you.
    if (current && place.s >= pathLength(current.path) - 0.5) resetPlacement()
  }
  const st = steps[behaviour.step]!
  behaviour.t = 0
  play(st.clip, st.fade ?? 0.3, st.timeScale ?? 1)
  if (state.autoSounds) for (const id of st.sounds ?? []) playSound(id)
}

const step = (): BehaviourStep | null => (state.behaviour && rig ? (rig.monster.behaviour.steps[behaviour.step] ?? null) : null)

// ------------------------------------------------------------------------------------------------- path
function pathLength(path: THREE.Vector3[]) {
  let L = 0
  for (let i = 1; i < path.length; i++) L += path[i]!.distanceTo(path[i - 1]!)
  return L
}
const _a = new THREE.Vector3()
function pathAt(path: THREE.Vector3[], s: number, out: THREE.Vector3, dir: THREE.Vector3) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const L = a.distanceTo(b)
    if (s <= L || i === path.length - 1) {
      dir.subVectors(b, a).normalize()
      return out.copy(a).addScaledVector(dir, Math.min(s, L))
    }
    s -= L
  }
  return out.copy(path[0]!)
}

/** On a path (approach preset, root motion or behaviour) or standing at the scene's spot facing the viewer. */
const onPath = () => state.cam === "approach" || state.rootMotion || state.behaviour

function resetPlacement() {
  place.s = 0
  if (!rig || !current) return
  if (onPath()) {
    const d = new THREE.Vector3()
    pathAt(current.path, 0, rig.root.position, d)
    place.yaw = Math.atan2(d.x, d.z)
  } else {
    rig.root.position.copy(current.spot)
    place.yaw = Math.atan2(current.viewer.x - current.spot.x, current.viewer.z - current.spot.z)
  }
}

/** Ground speed for the current clip or step, metres per second of game time. */
function travelSpeed() {
  if (!rig) return 0
  const st = step()
  const ts = (st ? (st.timeScale ?? 1) : 1) * state.speed
  if (st?.speed !== undefined) return st.speed * state.speed * state.scale
  const c = rig.clips.get(state.clip)
  const def = rig.monster.clips.find((x) => x.id === state.clip)
  const scale = rig.baseScale * state.scale
  // The clip's own root motion if it has any, else the registry's stride speed scaled by leg length.
  const own = c && c.rootSpeed > 0.05 ? c.rootSpeed * scale : (def?.speed ?? 0) * rig.gait * state.scale
  return own * ts
}

// ------------------------------------------------------------------------------------------------- sounds
const buffers = new Map<string, Promise<AudioBuffer>>()
const audioLoader = new THREE.AudioLoader()
const sounds = new Set<THREE.PositionalAudio>()
let muted = false
function playSound(id: string) {
  if (!rig || muted) return
  const def = rig.monster.sounds.find((s) => s.id === id) ?? MONSTERS.flatMap((m) => m.sounds).find((s) => s.id === id)
  if (!def) return console.warn(`monster lab: unknown sound ${id}`)
  const v = def.variants[Math.floor(Math.random() * def.variants.length)]!
  const url = soundUrl(def.id, v)
  let buf = buffers.get(url)
  if (!buf) {
    buf = audioLoader.loadAsync(url)
    buffers.set(url, buf)
  }
  const head = rig.head
  void buf.then((b) => {
    const a = new THREE.PositionalAudio(listener)
    a.setBuffer(b)
    a.setRefDistance(def.ref ?? 4)
    a.setRolloffFactor(1)
    a.setDistanceModel("inverse")
    a.setVolume(def.gain ?? 1)
    head.add(a)
    sounds.add(a)
    a.onEnded = () => {
      ;(a as { isPlaying: boolean }).isPlaying = false
      head.remove(a)
      sounds.delete(a)
      a.disconnect()
    }
    a.play()
    flashSound(def)
  })
}
function stopSounds() {
  for (const a of sounds) a.stop()
}
function flashSound(def: MonsterSound) {
  const b = document.querySelector<HTMLButtonElement>(`#sounds button[data-id="${def.id}"]`)
  if (!b) return
  b.classList.add("on")
  setTimeout(() => b.classList.remove("on"), 900)
}
let ambientIn = 0
function nextAmbient() {
  const e = rig?.monster.ambient?.every ?? [10, 20]
  return e[0] + Math.random() * (e[1] - e[0])
}

// ------------------------------------------------------------------------------------------------- camera
const keys = new Set<string>()
const fps = { yaw: 0, pitch: 0, pos: new THREE.Vector3() }
const EYE = 1.65
function setCam(mode: CamMode) {
  state.cam = mode
  mark("#cams", mode)
  if (!current) return
  controls.enabled = mode === "orbit"
  if (mode === "orbit") {
    if (document.pointerLockElement) document.exitPointerLock()
    const h = state.monster.height * state.scale
    const at = rig ? rig.root.position : current.spot
    controls.target.set(at.x, h * 0.55, at.z)
    const az = (Number(params.get("orbitYaw") ?? 28) * Math.PI) / 180
    camera.position.set(at.x + Math.sin(az) * h * 1.9, h * 0.7, at.z + Math.cos(az) * h * 1.9)
    controls.update()
  } else {
    fps.pos.copy(current.viewer)
    const d = new THREE.Vector3().subVectors(current.look, current.viewer.clone().setY(EYE))
    fps.yaw = Math.atan2(-d.x, -d.z)
    fps.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  }
  if (mode === "approach") {
    if (!state.behaviour) state.rootMotion = true
    syncMotionButtons()
  }
  resetPlacement()
  if (state.behaviour) startBehaviour()
}
canvas.addEventListener("click", () => {
  if (state.cam !== "orbit" && !document.pointerLockElement) void canvas.requestPointerLock()
})
window.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return
  fps.yaw -= e.movementX * 0.0022
  fps.pitch = Math.max(-1.45, Math.min(1.45, fps.pitch - e.movementY * 0.0022))
})
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT") return
  keys.add(e.code)
  if (e.code === "KeyF") setFlashlight(!state.flashlight)
})
window.addEventListener("keyup", (e) => keys.delete(e.code))

// ------------------------------------------------------------------------------------------------- UI
function mark(sel: string, value: string) {
  document.querySelectorAll<HTMLButtonElement>(`${sel} button`).forEach((b) => b.classList.toggle("on", (b.dataset.id ?? b.textContent) === value))
}
function buttons(sel: string, items: [string, string][], onClick: (id: string) => void) {
  const row = $(sel)
  row.replaceChildren()
  for (const [id, label] of items) {
    const b = document.createElement("button")
    b.dataset.id = id
    b.textContent = label
    b.onclick = () => onClick(id)
    row.append(b)
  }
}
function buildClipButtons() {
  if (!rig) return
  const r = rig
  const items: [string, string][] = [["▶ behaviour", "▶ behaviour"]]
  for (const c of r.monster.clips) {
    const p = r.clips.get(c.id)
    items.push([c.id, p ? `${c.id}${p.source === "stand-in" ? ` (${c.standIn})` : ""}` : `${c.id} (missing)`])
  }
  buttons("#clips", items, (id) => {
    if (id === "▶ behaviour") {
      resetPlacement()
      startBehaviour()
      return
    }
    state.behaviour = false
    play(id)
  })
  mark("#clips", state.behaviour ? "▶ behaviour" : state.clip)
}
function buildSoundButtons() {
  if (!rig) return
  buttons(
    "#sounds",
    rig.monster.sounds.map((s) => [s.id, s.label]),
    (id) => playSound(id),
  )
}
function syncMotionButtons() {
  mark("#motion", state.rootMotion ? "root" : "place")
}

buttons(
  "#monsters",
  MONSTERS.map((m) => [m.id, m.name]),
  (id) => void showMonster(MONSTERS.find((m) => m.id === id)!),
)
buttons(
  "#scenes",
  [
    ["studio", "Studio"],
    ["forest", "Forest"],
    ["corridor", "Corridor"],
  ],
  (id) => showScene(id as SceneId),
)
buttons(
  "#cams",
  [
    ["orbit", "Orbit"],
    ["fps", "First person"],
    ["approach", "Walks toward you"],
  ],
  (id) => setCam(id as CamMode),
)
buttons(
  "#speeds",
  [
    ["0.25", "0.25×"],
    ["0.5", "0.5×"],
    ["1", "1×"],
  ],
  (id) => {
    state.speed = Number(id)
    if (action) action.setEffectiveTimeScale((baseRate.get(action) ?? 1) * state.speed)
    mark("#speeds", id)
  },
)
buttons(
  "#motion",
  [
    ["place", "In place"],
    ["root", "Root motion (walk the path)"],
  ],
  (id) => {
    state.rootMotion = id === "root"
    syncMotionButtons()
    resetPlacement()
  },
)
buttons(
  "#flash",
  [
    ["on", "on"],
    ["off", "off"],
  ],
  (id) => setFlashlight(id === "on"),
)
buttons(
  "#auto",
  [
    ["on", "on"],
    ["off", "off"],
  ],
  (id) => {
    state.autoSounds = id === "on"
    if (!state.autoSounds) stopSounds()
    mark("#auto", id)
  },
)
mark("#speeds", "1")
mark("#auto", "on")
syncMotionButtons()
const scaleInput = $<HTMLInputElement>("#scale")
scaleInput.oninput = () => {
  state.scale = Number(scaleInput.value)
  $("#scaleOut").textContent = `${state.scale.toFixed(2)}× · ${(state.monster.height * state.scale).toFixed(2)} m`
  if (rig) rig.scaler.scale.setScalar(rig.baseScale * state.scale)
}
scaleInput.dispatchEvent(new Event("input"))
$("#concept").onclick = () => $("#concept").classList.toggle("big")

window.addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

// ------------------------------------------------------------------------------------------------- frame
const _p = new THREE.Vector3()
const _d = new THREE.Vector3()
const _q = new THREE.Quaternion()
const X = new THREE.Vector3(1, 0, 0)
const restJaw = new WeakMap<THREE.Bone, THREE.Quaternion>()
let time = 0

function simulate(dt: number) {
  time += dt
  if (!rig || !current) return
  const r = rig
  const st = step()
  if (st) {
    behaviour.t += dt * state.speed
    if (behaviour.t >= st.duration) nextStep()
  }
  const cur = step()
  const k = 1 - Math.exp(-dt * 4)
  place.hover += ((cur?.hover ?? 0) - place.hover) * k
  place.bend += ((cur?.bend ?? 0) - place.bend) * k
  place.jaw += ((cur?.jaw ?? 0) - place.jaw) * (1 - Math.exp(-dt * 10))
  place.headPitch += ((cur?.headPitch ?? 0) - place.headPitch) * k

  // Placement.
  const viewerX = state.cam === "orbit" ? current.viewer.x : camera.position.x
  const viewerZ = state.cam === "orbit" ? current.viewer.z : camera.position.z
  if (onPath()) {
    const L = pathLength(current.path)
    place.s += travelSpeed() * dt
    if (place.s > L) place.s = state.behaviour ? L : 0
    pathAt(current.path, place.s, _p, _d)
    r.root.position.copy(_p)
    const moving = travelSpeed() > 0.05 && place.s < L
    const want = moving ? Math.atan2(_d.x, _d.z) : Math.atan2(viewerX - _p.x, viewerZ - _p.z)
    let dy = want - place.yaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    place.yaw += dy * (1 - Math.exp(-dt * 5))
  }
  const bob = place.hover > 0.05 ? Math.sin(time * 1.3) * 0.05 * Math.min(1, place.hover * 4) : 0
  r.root.position.y = (onPath() ? _p.y : current.spot.y) + place.hover * state.scale + bob
  r.root.rotation.y = place.yaw

  r.mixer.update(dt)
  // Procedural layers on top of the clip: spine bend, head pitch (counter to the bend so it looks ahead), jaw.
  if (Math.abs(place.bend) > 1e-3 && r.spine.length) {
    _q.setFromAxisAngle(X, place.bend / r.spine.length)
    for (const b of r.spine) b.quaternion.multiply(_q)
  }
  const hp = place.headPitch - place.bend * 0.7
  if (Math.abs(hp) > 1e-3) {
    _q.setFromAxisAngle(X, hp * 0.5)
    r.neck?.quaternion.multiply(_q)
    r.head.quaternion.multiply(_q)
  }
  if (r.jaw) {
    if (!restJaw.has(r.jaw)) restJaw.set(r.jaw, r.jaw.quaternion.clone())
    r.jaw.quaternion.copy(restJaw.get(r.jaw)!).multiply(_q.setFromAxisAngle(X, place.jaw * 0.55))
  }

  if (state.autoSounds && r.monster.ambient && (onPath() ? travelSpeed() > 0.05 : true)) {
    ambientIn -= dt
    if (ambientIn <= 0) {
      const list = r.monster.ambient.sounds
      playSound(list[Math.floor(Math.random() * list.length)]!)
      ambientIn = nextAmbient()
    }
  }
}

let orbitPrev = new THREE.Vector3()
function updateCamera(dt: number) {
  if (!current) return
  if (state.cam === "orbit") {
    if (rig) {
      // Follow the monster: move target and camera by its travel.
      _p.copy(rig.root.position).setY(0)
      const delta = _p.clone().sub(orbitPrev)
      if (delta.lengthSq() < 4) {
        controls.target.add(delta)
        camera.position.add(delta)
      }
      orbitPrev = _p.clone()
    }
    controls.update()
    return
  }
  const run = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 4 : 1.6
  const f = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0)
  const s = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0)
  if (f || s) {
    const sin = Math.sin(fps.yaw)
    const cos = Math.cos(fps.yaw)
    const n = Math.hypot(f, s)
    fps.pos.x += ((-sin * f + cos * s) / n) * run * dt
    fps.pos.z += ((-cos * f - sin * s) / n) * run * dt
  }
  camera.position.set(fps.pos.x, fps.pos.y + EYE + Math.sin(time * 1.1) * 0.004, fps.pos.z)
  camera.rotation.set(fps.pitch, fps.yaw, 0, "YXZ")
}

function info() {
  if (!rig || !current) return ""
  const st = step()
  const d = Math.hypot(rig.root.position.x - camera.position.x, rig.root.position.z - camera.position.z)
  const clip = rig.clips.get(state.clip)
  return [
    st ? `step: ${st.label}` : `clip: ${state.clip}`,
    clip ? `${clip.source === "stand-in" ? "Mixamo " : ""}${clip.clip.name}` : "",
    `${d.toFixed(1)} m away`,
    rig.jaw ? "jaw ✓" : "no jaw bone",
    rig.missing.length ? `missing: ${rig.missing.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

// ------------------------------------------------------------------------------------------------- boot
showScene(state.sceneId)
await showMonster(state.monster)
setCam(state.cam)
const skip = Number(params.get("skip") ?? 0)
muted = true
for (let t = 0; t < skip; t += 1 / 30) {
  simulate(1 / 30)
  updateCamera(1 / 30)
}
muted = false
$("#loading").textContent = ""
const timer = new THREE.Timer()
const infoEl = $("#info")
renderer.setAnimationLoop(() => {
  timer.update()
  const dt = Math.min(timer.getDelta(), 0.1)
  simulate(dt)
  updateCamera(dt)
  current?.update?.(dt, time, camera)
  post.render()
  status.frames++
  if (status.frames % 10 === 0) infoEl.textContent = status.info = info()
  if (status.frames === 5) status.ready = true
})
