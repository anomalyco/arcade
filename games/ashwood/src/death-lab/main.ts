import * as THREE from "three/webgpu"
import { bootWorld } from "../boot/world"
import { createWendigo } from "../creatures/wendigo"
import { createDeathScreen } from "../game/death"
import { DEATHS, DEATHS_NEW, DEATHS_OLD, clearDeath, deathVariant, pickDeathVariant, playDeath, prepareDeathLights, type DeathMeasure, type DeathName } from "../game/death/variants"

// Death Lab (dev only): the three death jump scares (src/game/death/variants.ts) replayed on demand in the real game
// world (interior and terrain), with the game's creature, post and death screen, from a storey-3 corridor or a lift
// lobby. "Use in game" makes the pick the hunter catch's variant (localStorage, dev).
//
// Automation: ?auto=A|B|C &place=corridor|lobby &clean=1 &measure=1 (exact whole-mesh checks: nearest vertex to the
// eye, and whether the eye is inside the mesh). `__deathLab` = { ready, playing, done, frames: DeathMeasure[] , play() }.

const params = new URLSearchParams(location.search)
if (params.get("clean") === "1") document.body.classList.add("clean")
const worldParams = new URLSearchParams({ only: "terrain,interior", shot: "1" })
const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const info = document.querySelector<HTMLDivElement>("#info")!
type Frame = DeathMeasure & { minAll?: number; inside?: boolean }
const lab = { ready: false, playing: false, done: false, frames: [] as Frame[], play: (_v?: DeathName) => {} }
;(globalThis as { __deathLab?: typeof lab }).__deathLab = lab

const world = await bootWorld(canvas, worldParams, {})
const { renderer, camera, scene } = world
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

const hooks = new Set<(dt: number) => void>()
let last = performance.now()
let time = 0
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  time += dt
  for (const h of [...hooks]) h(dt)
  world.render(dt, time)
})
await world.stream({})

// Places: [eye x, y, z, yaw (0 = −Z), where it comes from (x, z)].
const S = (s: number) => 0.16 + s * 3.8
const PLACES = {
  corridor: { eye: new THREE.Vector3(-14, S(3) + 1.65, 0), yaw: -Math.PI / 2, from: new THREE.Vector3(-11.3, S(3), 0.4), ground: S(3) },
  lobby: { eye: new THREE.Vector3(-37.9, S(2) + 1.65, 16.7), yaw: Math.PI, from: new THREE.Vector3(-36.9, S(2), 18.9), ground: S(2) },
}
type Place = keyof typeof PLACES
/** Free horizontal distance from a point along a direction, against the world's colliders at body height. */
function free(from: THREE.Vector3, dir: THREE.Vector3) {
  let best = 40
  const y0 = from.y - 1.3
  const y1 = from.y - 0.2
  for (const b of world.ctx.colliders) {
    if (b.max[1] < y0 || b.min[1] > y1) continue
    let t0 = 0
    let t1 = best
    let hit = true
    for (const [o, d, lo, hi] of [
      [from.x, dir.x, b.min[0], b.max[0]],
      [from.z, dir.z, b.min[2], b.max[2]],
    ] as const) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) hit = false
        continue
      }
      let a = (lo - o) / d
      let c = (hi - o) / d
      if (a > c) [a, c] = [c, a]
      t0 = Math.max(t0, a)
      t1 = Math.min(t1, c)
    }
    if (hit && t0 <= t1 && t0 > 0.05) best = Math.min(best, t0)
  }
  return best
}
// The lobby is small: face whichever way has the most room (the spine corridor out of it).
{
  const p = PLACES.lobby
  let bestYaw = p.yaw
  let bestFree = 0
  for (let k = 0; k < 16; k++) {
    const yaw = (k / 16) * Math.PI * 2
    const f = free(p.eye, new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)))
    if (f > bestFree) {
      bestFree = f
      bestYaw = yaw
    }
  }
  p.yaw = bestYaw
  console.info(`death lab: lobby faces ${((bestYaw * 180) / Math.PI).toFixed(0)}°, ${bestFree.toFixed(1)} m free`)
}
let place: Place = (params.get("place") as Place) in PLACES ? (params.get("place") as Place) : "corridor"
let variant: DeathName = (params.get("auto") as DeathName) || deathVariant()

let ground = PLACES[place].ground
const w = createWendigo({ ground: () => ground })
w.root.visible = false
scene.add(w.root)
await w.ready
if (!w.rig) throw new Error("death lab: no creature bake")
w.root.traverse((o) => (o.frustumCulled = false))
const meshes: THREE.Object3D[] = []
w.root.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o))
await world.warmup.warmObjects(meshes).catch(() => {})
const lights = prepareDeathLights(scene)
const death = createDeathScreen()

// Scream: decoded on first input (a context needs a gesture).
let actx: AudioContext | null = null
let scream: AudioBuffer | null = null
let chatter: AudioBuffer | null = null
const unlock = async () => {
  if (actx) return
  actx = new AudioContext()
  try {
    scream = await actx.decodeAudioData(await (await fetch(new URL("sfx/monsters/wen2-huge-scream.mp3", document.baseURI))).arrayBuffer())
  } catch {}
  try {
    chatter = await actx.decodeAudioData(await (await fetch(new URL("sfx/monsters/wen2-chatter.mp3", document.baseURI))).arrayBuffer())
  } catch {}
}
addEventListener("pointerdown", () => void unlock())
addEventListener("keydown", () => void unlock())
const playScream = () => {
  if (!actx || !scream) return
  const s = actx.createBufferSource()
  s.buffer = scream
  s.connect(actx.destination)
  s.start()
}

function setView() {
  const p = PLACES[place]
  ground = p.ground
  camera.position.copy(p.eye)
  camera.rotation.set(0, p.yaw, 0, "YXZ")
  camera.updateMatrixWorld(true)
}

// ---- exact checks (measure=1): nearest vertex of the whole skinned mesh, and the eye-inside test (ray parity).
const measure = params.get("measure") === "1"
const mesh = meshes.find((o) => (o as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh
const _p = new THREE.Vector3()
function minAll(eye: THREE.Vector3) {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
  let best = Infinity
  for (let i = 0; i < pos.count; i += 2) {
    mesh.getVertexPosition(i, _p)
    _p.applyMatrix4(mesh.matrixWorld)
    const d = _p.distanceTo(eye)
    if (d < best) best = d
  }
  return best
}
const ray = new THREE.Raycaster()
function inside(eye: THREE.Vector3) {
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[]
  const sides = mats.map((m) => m.side)
  for (const m of mats) m.side = THREE.DoubleSide
  let votes = 0
  const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)]
  try {
    for (const d of dirs) {
      ray.set(eye, d)
      ray.far = 6
      const hit = ray.intersectObject(mesh, false)[0]
      if (hit?.face && hit.face.normal.clone().transformDirection(mesh.matrixWorld).dot(d) > 0) votes++
    }
  } finally {
    mats.forEach((m, i) => (m.side = sides[i]!))
  }
  return votes >= 3
}

async function play(v = variant) {
  if (lab.playing) return
  variant = v
  mark()
  lab.playing = true
  lab.done = false
  lab.frames = []
  death.hide()
  clearDeath(w, lights)
  setView()
  await new Promise((r) => setTimeout(r, 450))
  let n = 0
  const p = PLACES[place]
  await playDeath(v, {
    camera,
    wendigo: w,
    ground: p.ground,
    from: p.from.clone(),
    tick: (fn) => {
      hooks.add(fn)
      return () => void hooks.delete(fn)
    },
    scream: playScream,
    chatter: () => {
      if (!actx || !chatter) return
      const src = actx.createBufferSource()
      src.buffer = chatter
      const g = actx.createGain()
      g.gain.value = 0.9
      src.connect(g).connect(actx.destination)
      // A short bite out of the take, at a random point.
      src.start(0, Math.random() * Math.max(0, chatter.duration - 0.4), 0.35)
    },
    flood: () => death.flood(),
    lights,
    ceiling: p.ground + 2.94,
    free,
    canvas,
    onMeasure: (m) => {
      const f: Frame = { ...m }
      if (measure && n++ % 2 === 0) {
        camera.getWorldPosition(_p)
        const eye = _p.clone()
        f.minAll = +minAll(eye).toFixed(3)
        f.inside = inside(eye)
      }
      lab.frames.push(f)
    },
  })
  death.show({ canRestart: true, restart: () => void play(), startOver: () => void play() })
  lab.playing = false
  lab.done = true
  report()
}
lab.play = (v) => void play(v)

function report() {
  const f = lab.frames
  const min = Math.min(...f.map((x) => x.nearest))
  const pre = f.filter((x) => x.phase !== "strike")
  const whole = pre.filter((x) => x.body >= 0.99).length / Math.max(1, pre.length)
  const peak = f.reduce((a, b) => (b.fill > a.fill ? b : a), f[0]!)
  const all = f.filter((x) => x.minAll !== undefined)
  info.textContent = `${variant} ${DEATHS[variant]} · ${place}\nwhole creature in frame ${(whole * 100).toFixed(0)} % of the time before the strike\nface nearest min ${min.toFixed(2)} m · peak fill ${(peak.fill * 100).toFixed(0)} % at ${peak.t.toFixed(2)} s (centre ${peak.cx}, ${peak.cy})${all.length ? `\nwhole mesh nearest ${Math.min(...all.map((x) => x.minAll!)).toFixed(2)} m · eye inside: ${all.some((x) => x.inside) ? "YES" : "never"}` : ""}\ngame uses: ${deathVariant()}`
}

// ---- UI
const mark = () => document.querySelectorAll<HTMLButtonElement>("#ui button[data-k]").forEach((b) => b.classList.toggle("on", b.dataset.v === variant || b.dataset.v === place))
const btn = (host: string, k: string, v: string, label: string, fn: () => void) => {
  const b = document.createElement("button")
  b.textContent = label
  b.dataset.k = k
  b.dataset.v = v
  b.onclick = fn
  document.querySelector(host)!.append(b)
}
for (const v of Object.keys(DEATHS_NEW) as DeathName[]) btn("#variants", "v", v, DEATHS[v], () => void play(v))
const oldRow = document.querySelector<HTMLSpanElement>("#old")!
oldRow.style.display = "none"
for (const v of Object.keys(DEATHS_OLD) as DeathName[]) btn("#old", "v", v, `old ${v} · ${DEATHS[v]}`, () => void play(v))
document.querySelector<HTMLButtonElement>("#showOld")!.onclick = () => (oldRow.style.display = oldRow.style.display === "none" ? "" : "none")
for (const p of Object.keys(PLACES) as Place[])
  btn("#places", "p", p, p, () => {
    place = p
    mark()
    death.hide()
    clearDeath(w, lights)
    setView()
  })
document.querySelector<HTMLButtonElement>("#play")!.onclick = () => void play()
document.querySelector<HTMLButtonElement>("#pick")!.onclick = () => {
  pickDeathVariant(variant)
  report()
}
addEventListener("keydown", (e: KeyboardEvent) => e.code === "Space" && !lab.playing && void play())
setView()
mark()
info.textContent = "ready · pick a variant (the scream plays after your first click)"
lab.ready = true
if (params.get("auto")) setTimeout(() => void play(variant), 1500)
