// Dev-only world preview: http://localhost:5173/labs/wings/src/render/world/preview.html
// Query: ?view=base|canyon|volcano|water|spires|overview|edge  &q=low|balanced|high  &markers=1
import { ACESFilmicToneMapping, BoxGeometry, Mesh, PerspectiveCamera, Scene, Vector3 } from "three"
import { MeshStandardNodeMaterial, RenderPipeline, WebGPURenderer } from "three/webgpu"
import { float, pass, screenUV, smoothstep, length, vec3 } from "three/tsl"
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js"
import { createWorldView, type WorldViewDebug } from "../world-view"
import { AIRBASES, baseToWorld, groundHeight, setFleetState, spawnPoint, terrainMeshHeight } from "../../sim/geography"
import { FLEET, SHIP_SPECS } from "../../sim/fleet"
import type { ShipState } from "../../sim/protocol"
import type { Quality, TeamId } from "../../sim/types"

const params = new URLSearchParams(location.search)
const quality = (params.get("q") ?? "balanced") as Quality
let fleetT = Number(params.get("t") ?? 0)
const fleetSpeed = Number(params.get("ts") ?? 0)
const teams = Number(params.get("teams") ?? 4)
setFleetState(fleetT, teams)
const renderer = new WebGPURenderer({ antialias: true, logarithmicDepthBuffer: true, forceWebGL: params.get("gl") === "1", powerPreference: "high-performance" })
renderer.setPixelRatio(Math.min(devicePixelRatio, Number(params.get("pr") ?? 1.5)))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = ACESFilmicToneMapping
await renderer.init()
document.body.appendChild(renderer.domElement)

const scene = new Scene()
const camera = new PerspectiveCamera(65, innerWidth / innerHeight, 0.5, 20000)
const world = createWorldView(renderer, scene, quality) as WorldViewDebug
scene.add(world.root)
camera.far = world.far
camera.updateProjectionMatrix()
// Preview post: bloom + light vignette (the game's scene.ts owns the real pipeline).
const post = new RenderPipeline(renderer)
const scenePass = pass(scene, camera)
const color = scenePass.getTextureNode("output")
const bloomPass = bloom(color, 0.55, 0.45, 0.82)
const vignette = smoothstep(float(1.05), float(0.35), length(screenUV.sub(0.5).mul(vec3(1.25, 1, 1).xy)))
post.outputNode = color.add(bloomPass).mul(vignette.mul(0.3).add(0.7))
const backendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl2"
world.setHighlightTeam(params.has("team") ? Number(params.get("team")) : null)

if (params.get("markers") === "1") {
  const mat = new MeshStandardNodeMaterial({ color: "#ff3060" })
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

if (params.get("dmg") === "1") {
  const sinkAge = Number(params.get("sink") ?? 6)
  const ships: ShipState[] = FLEET.filter(f => f.team === 0).map(f => {
    const sp = SHIP_SPECS[f.kind]
    const turrets = Object.fromEntries(sp.turrets.map(t => [t.id, { hp: 1, manned: null }]))
    if (f.id === "t0-carrier") {
      turrets.ciws_bow_port.hp = 0
      return { id: f.id, hp: sp.maxHp * 0.3, maxHp: sp.maxHp, sunk: false, sunkAt: 0, turrets,
        damage: [[-20, 20, -90], [15, 20, 30], [-30, 12, 110], [10, 20, -20]] as [number, number, number][] }
    }
    if (f.id === "t0-dd1") return { id: f.id, hp: 0, maxHp: sp.maxHp, sunk: true, sunkAt: 100, turrets, damage: [[0, 9, -30], [4, 12, 20]] as [number, number, number][] }
    return { id: f.id, hp: sp.maxHp, maxHp: sp.maxHp, sunk: false, sunkAt: 0, turrets, damage: [] }
  })
  world.applyShipStates(ships, 100 + sinkAge)
  const craters = []
  for (let i = 0; i < 9; i++) {
    const a = i * 2.1, r = 200 + i * 70
    const x = Math.cos(a) * r, z = Math.sin(a) * r
    craters.push({ position: [x, terrainMeshHeight(x, z), z] as [number, number, number], radius: 18 + (i % 3) * 10 })
  }
  world.addCraters(craters)
}

const views: Record<string, () => [number[], number[]]> = {
  dmgcarrier: () => { const b = AIRBASES[0]; return [[b.center[0] + 420, 140, b.center[2] - 380], [b.center[0], 20, b.center[2]]] },
  dmgfar: () => { const b = AIRBASES[0]; return [[b.center[0] + 1400, 260, b.center[2] - 1100], [b.center[0], 80, b.center[2]]] },
  craters: () => { const a = 4 * 2.1, r = 200 + 4 * 70, x = Math.cos(a) * r, z = Math.sin(a) * r; return [[x + 90, terrainMeshHeight(x, z) + 70, z + 90], [x, terrainMeshHeight(x, z), z]] },
  sinking: () => { const b = AIRBASES[0]; const f = [-Math.sin(b.heading), -Math.cos(b.heading)], r = [Math.cos(b.heading), -Math.sin(b.heading)]; const x = b.center[0] + r[0] * -340 + f[0] * 500, z = b.center[2] + r[1] * -340 + f[1] * 500; return [[x + 260, 70, z + 200], [x, 5, z]] },
  top: () => [[0, 9000, 1], [0, 0, 0]],
  fleet: () => { const b = AIRBASES[0]; return [[b.center[0] + 700, 260, b.center[2] - 650], [b.center[0], 0, b.center[2]]] },
  fleetclose: () => { const b = AIRBASES[0]; return [[b.center[0] + 450, 90, b.center[2] - 250], [b.center[0], 15, b.center[2] + 100]] },
  deck: () => { const b = AIRBASES[0]; const f = [-Math.sin(b.heading), -Math.cos(b.heading)]; return [[b.center[0] - f[0] * 210 + f[1] * 30, 45, b.center[2] - f[1] * 210 - f[0] * 30], [b.center[0] + f[0] * 60, 20, b.center[2] + f[1] * 60]] },
  center: () => [[-2400, 600, 2600], [0, 200, 0]],
  chase: () => [[1800, 70, 1200], [0, 120, 0]],
  chase700: () => [[2600, 700, 3000], [0, 200, 0]],
  water: () => [[2000, 14, -2600], [-800, 60, -3200]],
  breakview: () => [[0, 120, 2000], [550, 160, 2000 - 835]],
  h1500: () => [[2500, 1500, 4000], [0, 300, 0]],
  overview: () => [[0, 4500, 6500], [0, 0, 0]],
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
  if (fleetSpeed) { fleetT += dt * fleetSpeed; setFleetState(fleetT, teams) }
  world.update(camera.position, dt, now / 1000)
  renderer.toneMappingExposure = 1 + world.lightning * 0.5
  post.render()
  frames++
  if (now - fpsTime > 500) { fps = frames * 1000 / (now - fpsTime); frames = 0; fpsTime = now }
  const s = world.stats(), info = renderer.info.render
  hud.textContent = `${backendName}  fps ${fps.toFixed(0)}  calls ${info.drawCalls}  tris ${(info.triangles / 1000).toFixed(0)}k\n` +
    `clusters ${s.visibleClusters}/${s.clusters} pending ${s.pending} trees ${s.trees} shore ${(s.shoreProgress * 100).toFixed(0)}%\n` +
    `work ${s.lastWorkMs.toFixed(2)}ms max ${s.maxWorkMs.toFixed(2)}ms ready ${world.ready()}\n` +
    `pos ${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)}`
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
if (params.has("strike")) setTimeout(() => world.strikeLightning(), Number(params.get("strike")))

Object.assign(window, {
  __preview: {
    world, renderer, camera, strike: () => world.strikeLightning(),
    setCam: (p: number[], l: number[]) => setCam(p, l),
    view: (name: string) => setCam(...views[name]()),
    fly: (s: number) => (flySpeed = s),
    stats: () => {
      const sorted = [...frameTimes].sort((a, b) => a - b)
      return { fps, ...world.stats(), calls: renderer.info.render.drawCalls, backend: backendName, triangles: renderer.info.render.triangles, ready: world.ready(),
        frameMedian: sorted[Math.floor(sorted.length / 2)], frameP95: sorted[Math.floor(sorted.length * 0.95)] }
    },
  },
})
