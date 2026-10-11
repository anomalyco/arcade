// Dev-only world preview: http://localhost:5173/labs/wings/src/render/world/preview.html
// Query: ?view=base|canyon|volcano|water|spires|overview|edge  &q=low|balanced|high  &markers=1
import { ACESFilmicToneMapping, BoxGeometry, Mesh, MeshToonMaterial, NeutralToneMapping, NoToneMapping, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three"
import { createWorldView, type WorldViewDebug } from "../world-view"
import { AIRBASES, baseToWorld, groundHeight, spawnPoint } from "../../sim/geography"
import type { Quality, TeamId } from "../../sim/types"

const params = new URLSearchParams(location.search)
const quality = (params.get("q") ?? "balanced") as Quality
const renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" })
renderer.setPixelRatio(Math.min(devicePixelRatio, Number(params.get("pr") ?? 1.5)))
renderer.setSize(innerWidth, innerHeight)
const tm = params.get("tm")
renderer.toneMapping = tm === "aces" ? ACESFilmicToneMapping : tm === "none" ? NoToneMapping : NeutralToneMapping
document.body.appendChild(renderer.domElement)

const scene = new Scene()
const camera = new PerspectiveCamera(65, innerWidth / innerHeight, 0.5, 20000)
const world = createWorldView(renderer, scene, quality) as WorldViewDebug
scene.add(world.root)
camera.far = world.far
camera.updateProjectionMatrix()
world.setHighlightTeam(params.has("team") ? Number(params.get("team")) : null)

if (params.get("markers") === "1") {
  const mat = new MeshToonMaterial({ color: "#ff3060" })
  for (const team of [0, 1, 2, 3] as TeamId[]) {
    for (let i = 0; i < 6; i++) {
      const s = spawnPoint(team, "fighter", i)
      const m = new Mesh(new BoxGeometry(12, 3, 16), mat)
      m.position.set(...s.position); m.rotation.y = s.yaw
      scene.add(m)
    }
    for (let i = 0; i < 4; i++) {
      const s = spawnPoint(team, "apache", i)
      const m = new Mesh(new BoxGeometry(4, 3, 14), mat)
      m.position.set(...s.position); m.rotation.y = s.yaw
      scene.add(m)
    }
  }
}

const views: Record<string, () => [number[], number[]]> = {
  base: () => {
    const b = AIRBASES[0]
    const [x, z] = baseToWorld(b, -1500, -260), [lx, lz] = baseToWorld(b, -700, 120)
    return [[x, 90, z], [lx, 20, lz]]
  },
  apron: () => {
    const b = AIRBASES[2]
    const [x, z] = baseToWorld(b, 200, 120), [lx, lz] = baseToWorld(b, 450, 300)
    return [[x, 45, z], [lx, 20, lz]]
  },
  approach: () => {
    const b = AIRBASES[1]
    const [x, z] = baseToWorld(b, -3200, 400), [lx, lz] = baseToWorld(b, 0, 100)
    return [[x, 450, z], [lx, 20, lz]]
  },
  crater: () => [[-2600, 1500, -1400], [-1700, 1050, -800]],
  gorge: () => [[-1350, 40, 2050], [-200, 40, 1500]],
  canyon: () => [[-1900, 90, 2700], [-300, 60, 1500]],
  volcano: () => [[-6500, 1500, 3800], [-1600, 700, -900]],
  water: () => [[-2500, 12, 9500], [500, 60, 6500]],
  spires: () => [[-400, 180, 8600], [2200, 150, 6000]],
  overview: () => [[0, 9000, 16000], [0, 0, 0]],
  edge: () => [[0, 400, -13500], [0, 300, -16000]],
  mesa: () => [[-9800, 300, -3500], [-6600, 250, -1600]],
}
let yaw = 0, pitch = 0
function setCam(p: number[], l: number[]) {
  camera.position.set(p[0], p[1], p[2])
  const d = new Vector3(l[0] - p[0], l[1] - p[1], l[2] - p[2]).normalize()
  yaw = Math.atan2(-d.x, -d.z)
  pitch = Math.asin(d.y)
}
const v = views[params.get("view") ?? "base"] ?? views.base
setCam(...v())

const keys = new Set<string>()
addEventListener("keydown", e => keys.add(e.code))
addEventListener("keyup", e => keys.delete(e.code))
let dragging = false
addEventListener("mousedown", () => (dragging = true))
addEventListener("mouseup", () => (dragging = false))
addEventListener("mousemove", e => {
  if (!dragging) return
  yaw -= e.movementX * 0.003
  pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.003))
})
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

const hud = document.getElementById("hud")!
let last = performance.now(), frames = 0, fpsTime = last, fps = 0
const frameTimes: number[] = []
const fwd = new Vector3(), right = new Vector3()
let flySpeed = Number(params.get("speed") ?? 0)
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000)
  frameTimes.push(now - last)
  if (frameTimes.length > 240) frameTimes.shift()
  last = now
  camera.rotation.set(pitch, yaw, 0, "YXZ")
  camera.getWorldDirection(fwd)
  right.set(-fwd.z, 0, fwd.x).normalize()
  const speed = (keys.has("ShiftLeft") ? 900 : 160) * dt
  if (keys.has("KeyW")) camera.position.addScaledVector(fwd, speed)
  if (keys.has("KeyS")) camera.position.addScaledVector(fwd, -speed)
  if (keys.has("KeyD")) camera.position.addScaledVector(right, speed)
  if (keys.has("KeyA")) camera.position.addScaledVector(right, -speed)
  if (keys.has("KeyE")) camera.position.y += speed
  if (keys.has("KeyQ")) camera.position.y -= speed
  if (flySpeed) camera.position.addScaledVector(fwd, flySpeed * dt)
  camera.position.y = Math.max(camera.position.y, groundHeight(camera.position.x, camera.position.z) + 2)
  world.update(camera.position, dt, now / 1000)
  renderer.render(scene, camera)
  frames++
  if (now - fpsTime > 500) { fps = frames * 1000 / (now - fpsTime); frames = 0; fpsTime = now }
  const s = world.stats(), info = renderer.info.render
  hud.textContent = `fps ${fps.toFixed(0)}  calls ${info.calls}  tris ${(info.triangles / 1000).toFixed(0)}k\n` +
    `clusters ${s.visibleClusters}/${s.clusters} pending ${s.pending} trees ${s.trees} shore ${(s.shoreProgress * 100).toFixed(0)}%\n` +
    `work ${s.lastWorkMs.toFixed(2)}ms max ${s.maxWorkMs.toFixed(2)}ms ready ${world.ready()}\n` +
    `pos ${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)}`
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

Object.assign(window, {
  __preview: {
    world, renderer, camera,
    setCam: (p: number[], l: number[]) => setCam(p, l),
    view: (name: string) => setCam(...views[name]()),
    fly: (s: number) => (flySpeed = s),
    stats: () => {
      const sorted = [...frameTimes].sort((a, b) => a - b)
      return { fps, ...world.stats(), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, ready: world.ready(),
        frameMedian: sorted[Math.floor(sorted.length / 2)], frameP95: sorted[Math.floor(sorted.length * 0.95)] }
    },
  },
})
