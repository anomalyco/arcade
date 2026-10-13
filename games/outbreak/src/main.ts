import { Camera } from "@arcade/kit/client/camera"
import { Input } from "@arcade/kit/client/input"
import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import { Renderer, type Batch, type FrameInput } from "@arcade/kit/gpu/renderer"
import { FRAME_FLOATS } from "@arcade/kit/gpu/shaders"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS } from "@arcade/kit/gpu/limits"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { LocalSession, type Command } from "../shared/session"
import { nearbyDoor, sightRects, SIZE } from "../shared/map"
import { dayCycle, clockText, wrapHour } from "../shared/day-cycle"
import { Vision, FOG_SIZE } from "../shared/vision"
import { supportHeight } from "../shared/terrain"
import { SceneryMemory } from "../shared/scenery-memory"
import { buildLevel, hex } from "./level"
import { Survivor } from "./survivor"
import { shaders } from "./shaders"
import "./style.css"

const params = new URLSearchParams(location.search)
const settings = { hour: 18, timeScale: 120, cone: 110, awareness: 2.5, range: 27, shroud: .32, exposure: 1.15, zoom: 46, houseSeed: 7, terrain: .22, weather: 0, lighting: 1 }
const controls: LabControl[] = [
  { key: "hour", label: "Time", group: "Day cycle", min: 0, max: 24, step: .05 },
  { key: "timeScale", label: "Time scale", group: "Day cycle", min: 0, max: 600, step: 10 },
  { key: "cone", label: "Vision cone", group: "Vision", min: 60, max: 180, step: 1 },
  { key: "awareness", label: "Close awareness", group: "Vision", min: 0, max: 5, step: .1 },
  { key: "range", label: "Sight range", group: "Vision", min: 8, max: 40, step: 1 },
  { key: "shroud", label: "Explored shroud", group: "Vision", min: .02, max: .4, step: .01 },
  { key: "exposure", label: "Exposure", group: "View", min: .5, max: 2, step: .05 },
  { key: "zoom", label: "Camera distance", group: "View", min: 24, max: 65, step: 1 },
  { key: "houseSeed", label: "House seed", group: "Generation", min: 1, max: 32, step: 1 },
  { key: "terrain", label: "Terrain relief", group: "Generation", min: 0, max: .4, step: .02 },
  { key: "weather", label: "Overcast", group: "Day cycle", min: 0, max: 1, step: .05 },
  { key: "lighting", label: "Practical lights", group: "Day cycle", min: .3, max: 1.5, step: .05 },
]

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#game")!
  const status = document.querySelector<HTMLElement>("#status")!
  if (!navigator.gpu) { status.textContent = "Outbreak needs WebGPU."; return }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) { status.textContent = "No WebGPU adapter is available."; return }
  const device = await adapter.requestDevice()
  device.addEventListener("uncapturederror", e => console.error(e.error.message))
  void device.lost.then(info => { status.textContent = `GPU lost: ${info.message}. Reload to reconnect.` })
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  const renderer = new Renderer(device, context, format, shaders)
  const seed = Number(params.get("seed") ?? 7) >>> 0
  let session = new LocalSession(seed), vision = new Vision()
  let scenery = new SceneryMemory()
  const input = new Input(canvas, ["KeyF"])
  input.enabled = true
  input.mouse.y = innerHeight / 2 - 150
  const cam = new Camera()
  const avatar = new Survivor(renderer)
  const doorMesh = new Mesh()
  doorMesh.box(0, .13, -.1, 1.4, 2.3, .1, hex(0x796045), MAT.wall)
  doorMesh.box(.08, .35, -.11, 1.32, 2.1, -.105, hex(0x8b7253), MAT.wall)
  doorMesh.box(1.15, 1.1, .1, 1.24, 1.17, .17, hex(0xb9a071))
  const doorModel = renderer.addModel(doorMesh)
  const doorData = new Float32Array(8 * 12)
  const doorBatch: Batch = { model: doorModel, data: doorData, count: 0 }
  const frame = new Float32Array(FRAME_FLOATS), lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS), occluders = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  const lampPower = new Float32Array(32), empty = new Float32Array(0)
  const render: FrameInput = { frame, lights, lightCount: 0, shadowLightCount: 0, occluders, occluderCount: 0, lampPower, lampCount: 0, view: [0, 0, SIZE, SIZE], batches: [], alphaSprites: empty, alphaCount: 0, addSprites: empty, addCount: 0, grade: [0, 0, 0, 1] }
  let blockers = sightRects(session.view.town), revision = -1
  let frozen = params.has("bench"), last = performance.now(), frames = 0, elapsed = 0
  const lab = new LabPanel(settings, controls, params, () => input.release(), key => {
    if (key === "hour") session.view.hour = wrapHour(settings.hour)
    if (key === "houseSeed" || key === "terrain") regenerate()
  })
  let vertices = 0
  function level() {
    const data=buildLevel(session.view.town)
    vertices=[...data.chunks,...data.glass].reduce((n,c)=>n+c.data.byteLength/24,0)
    renderer.setLevel(data)
  }
  function regenerate() {
    const previous=session.view
    session=new LocalSession(previous.town.seed,settings.houseSeed,settings.terrain)
    Object.assign(session.view.player,previous.player)
    session.view.hour=previous.hour; session.view.time=previous.time
    session.view.revision=previous.revision+1
    session.view.town.doors.forEach((d,i)=>{d.open=previous.town.doors[i]!.open})
    session.rebuildCollision()
    revision=-1; level(); avatar.reset()
  }
  function reset(nextSeed = seed) {
    session.close(); session = new LocalSession(nextSeed,settings.houseSeed,settings.terrain); vision = new Vision(); revision = -1
    avatar.reset()
    level()
    scenery=new SceneryMemory()
    renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
    cam.snap(session.view.player.x, session.view.player.y)
    cam.dist = settings.zoom
  }
  reset()
  function draw(dt: number) {
    const { player: p, town, hour, time } = session.view
    settings.hour = Math.round(hour * 20) / 20
    const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio, 2)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      renderer.resize(canvas.width, canvas.height)
    }
    cam.zoomOffset = settings.zoom - 24
    cam.follow(p.x, p.y, 0, 0, dt, false)
    cam.update(w / h)
    if (revision !== session.view.revision) {
      revision = session.view.revision; blockers = sightRects(town)
      occluders.fill(0)
      blockers.forEach((r, i) => occluders.set([...r, 2.8, 0, 0, 0], i * OCC_FLOATS))
    }
    vision.update(p.x, p.y, p.aim, blockers, settings)
    if (scenery.update(town,vision)) renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
    const day = dayCycle(hour)
    lights.fill(0)
    lights.set([p.x, 1.65+supportHeight(town,p.x,p.y), p.y, settings.range, 0, 0, 0, 0, 0, 0, 0, 0, 0, blockers.length, .01, -1])
    let count = 1
    for (const [i, lamp] of town.lamps.entries()) {
      lampPower[i] = day.lamps * settings.lighting
      if (Math.hypot(lamp.x - p.x, lamp.y - p.y) > 40) continue
      lights.set([lamp.x+(lamp.kind==="street"?.55:0), lamp.h, lamp.y, lamp.radius, 1, .62, .28, day.lamps * lamp.power * settings.lighting, 0, 0, 0, 0, 0, blockers.length, lamp.kind==="room"?.38:.5, i], count++ * LIGHT_FLOATS)
    }
    frame.set(cam.viewProj, 0); frame.set([...cam.eye, time], 16)
    frame.set([canvas.width, canvas.height, count, town.lamps.length], 20)
    frame.set([p.x, p.y, 1, .48], 24); frame.set([...day.ambient.map(v=>v*(1-settings.weather*.3)), day.strength*(1-settings.weather*.85)], 28)
    const focus = cam.project(p.x, 1, p.y, w, h)
    frame.set([focus.x / w * 2 - 1, 1 - focus.y / h * 2, 1.0, count], 32)
    frame.set([...day.direction, day.sun], 36); frame.set([1 / SIZE, 1 / SIZE, SIZE, SIZE], 40)
    frame.set([p.aim, Math.cos(settings.cone * Math.PI / 360), settings.awareness, settings.shroud], 44)
    town.doors.forEach((door, i) => doorData.set([door.rect[0], 0, (door.rect[1] + door.rect[3]) / 2, door.open ? -Math.PI / 2 : 0, 1, 1, 1, 1, 0, 0, 1, 0], i * 12))
    doorBatch.count = town.doors.length
    render.batches = [...avatar.draw(p, dt, time, (x,z)=>supportHeight(town,x,z)), doorBatch]
    render.lightCount = render.shadowLightCount = count; render.occluderCount = blockers.length; render.lampCount = town.lamps.length
    render.view = cam.groundRect(5.5); render.grade = [time, 0, 0, settings.exposure]
    renderer.render(render)
    const door = nearbyDoor(town, p.x, p.y)
    status.textContent = `${clockText(hour)}${door ? ` · F ${door.open ? "Close" : "Open"} door` : ""}`
    frames++; elapsed += dt
    if (elapsed > .25) {
      lab.header.textContent = `${Math.round(frames / elapsed)} FPS · ${renderer.drawnChunks} chunks\n${clockText(hour)} · seed ${town.seed}`
      if (lab.visible) lab.refresh()
      frames = 0; elapsed = 0
    }
  }
  function tick(now: number) {
    const dt = Math.min(.05, Math.max(.001, (now - last) / 1000)); last = now
    if (!frozen && !document.hidden) {
      const target = cam.unproject(input.mouse.x, input.mouse.y, innerWidth, innerHeight)
      const p = session.view.player
      session.update(dt, { ...input.move(), aim: Math.atan2(target.y - p.y, target.x - p.x), interact: input.takeEnter() }, settings.timeScale)
      draw(dt)
    }
    requestAnimationFrame(tick)
  }
  draw(1 / 60)
  const harness = {
    ready: true,
    adapterInfo: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
    state: () => ({ ...session.view, explored: vision.explored.filter(v => v > 0).length, vertices }),
    fog: (x: number, y: number) => vision.state(x, y),
    reset,
    freeze: (value = true) => { frozen = value; input.release() },
    setLab(key: keyof typeof settings, value: number) {
      const control = controls.find(c => c.key === key)
      if (!control || !("min" in control) || !Number.isFinite(value) || value < control.min || value > control.max) throw new Error(`Invalid lab value: ${key}`)
      settings[key] = value
      if (key === "hour") session.view.hour = wrapHour(value)
      if (key === "houseSeed" || key === "terrain") regenerate()
    },
    pose(x: number, y: number, aim: number) { Object.assign(session.view.player, { x, y, aim, vx: 0, vy: 0 }); cam.snap(x, y); cam.dist = settings.zoom },
    async step(dt = 1 / 60, command?: Partial<Command>) {
      session.update(dt, { mx: 0, my: 0, aim: session.view.player.aim, interact: false, ...command }, settings.timeScale)
      draw(dt)
      await Promise.resolve(); await device.queue.onSubmittedWorkDone()
      return harness.state()
    },
  }
  Object.assign(window, { __arcadeHarness: harness })
  requestAnimationFrame(tick)
}

main().catch(error => { console.error(error); document.querySelector("#status")!.textContent = `Outbreak could not start: ${error.message}` })
