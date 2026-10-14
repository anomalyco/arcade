import { Camera } from "@arcade/kit/client/camera"
import { keyLabel } from "@arcade/kit/client/controls"
import { Input } from "@arcade/kit/client/input"
import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import { Renderer, type Batch, type FrameInput } from "@arcade/kit/gpu/renderer"
import { FRAME_FLOATS } from "@arcade/kit/gpu/shaders"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS } from "@arcade/kit/gpu/limits"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { LocalSession, type Command } from "../shared/session"
import { FrameClock, TICK_DT } from "../shared/clock"
import { nearbyDoor, sightRects, propShape, SIZE } from "../shared/map"
import { dayCycle, clockText, wrapHour } from "../shared/day-cycle"
import { Vision, FOG_SIZE } from "../shared/vision"
import { supportHeight } from "../shared/terrain"
import { SceneryMemory } from "../shared/scenery-memory"
import { buildLevel, hex } from "./level"
import { Survivor } from "./survivor"
import { zombieControls, zombieProfile, zombieTuning } from "./zombie-profile"
import { shaders } from "./shaders"
import "./style.css"

const params = new URLSearchParams(location.search)
const settings = { hour: 18, timeScale: 120, cone: 110, awareness: 2.5, range: 27, shroud: .32, exposure: 1.0, zoom: 46, houseSeed: 7, terrain: .22, weather: 0, lighting: 1, diagnostic: 0, skyFill: 1, humanProfile: 0, ...zombieTuning }
const controls: LabControl[] = [
  { key: "humanProfile", label: "Pose", group: "Zombie", options: [{ label: "Survivor", value: 0 }, { label: "Zombie", value: 1 }] },
  ...zombieControls,
  { key: "diagnostic", label: "Contribution", group: "Diagnostics", options: ["Beauty", "Albedo", "Direct", "Ambient + sky", "Specular", "Bloom", "Before memory"].map((label,value)=>({label,value})) },
  { key: "hour", label: "Time", group: "Day cycle", min: 0, max: 24, step: .05 },
  { key: "timeScale", label: "Time scale", group: "Day cycle", min: 0, max: 600, step: 10 },
  { key: "cone", label: "Vision cone", group: "Vision", min: 60, max: 180, step: 1 },
  { key: "awareness", label: "Close awareness", group: "Vision", min: 0, max: 5, step: .1 },
  { key: "range", label: "Sight range", group: "Vision", min: 8, max: 40, step: 1 },
  { key: "shroud", label: "Explored shroud", group: "Vision", min: .02, max: .4, step: .01 },
  { key: "exposure", label: "Exposure", group: "Look", min: .5, max: 2, step: .05 },
  { key: "skyFill", label: "Sky fill", group: "Look", min: 0, max: 1.5, step: .05 },
  { key: "zoom", label: "Camera distance", group: "View", min: 24, max: 65, step: 1 },
  { key: "houseSeed", label: "House seed", group: "Generation", min: 1, max: 32, step: 1 },
  { key: "terrain", label: "Terrain relief", group: "Generation", min: 0, max: .4, step: .02 },
  { key: "weather", label: "Overcast", group: "Day cycle", min: 0, max: 1, step: .05 },
  { key: "lighting", label: "Practical lights", group: "Look", min: 0, max: 1.5, step: .05 },
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
  const input = new Input(canvas)
  input.enabled = true
  input.mouse.y = innerHeight / 2 - 150
  const cam = new Camera()
  const avatar = new Survivor(renderer)
  const updateProfile = () => { avatar.profile = settings.humanProfile === 1 ? zombieProfile(settings) : undefined }
  const doorMesh = new Mesh()
  doorMesh.box(0, .13, -.1, 1.4, 2.3, .1, hex(0x796045), MAT.wall)
  doorMesh.box(.08, .35, -.11, 1.32, 2.1, -.105, hex(0x8b7253), MAT.wall)
  doorMesh.box(1.15, 1.1, .1, 1.24, 1.17, .17, hex(0xb9a071))
  for(const x of [.15,.75])for(const y of [.42,1.36]){
    doorMesh.box(x,y,.101,x+.48,y+.70,.125,hex(0x91754e))
    doorMesh.box(x+.035,y+.04,.126,x+.445,y+.66,.132,hex(0x70583d))
  }
  const doorModel = renderer.addModel(doorMesh)
  const doorData = new Float32Array(8 * 12)
  const doorBatch: Batch = { model: doorModel, data: doorData, count: 0 }
  const frame = new Float32Array(FRAME_FLOATS), lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS), occluders = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  const lampPower = new Float32Array(MAX_LIGHTS), empty = new Float32Array(0)
  const render: FrameInput = { frame, lights, lightCount: 0, shadowLightCount: 0, occluders, occluderCount: 0, lampPower, lampCount: 0, view: [0, 0, SIZE, SIZE], batches: [], alphaSprites: empty, alphaCount: 0, addSprites: empty, addCount: 0, grade: [0, 0, 0, 1] }
  let blockers = sightRects(session.view.town), revision = -1, lightOccluders=0
  let frozen = params.has("bench"), frames = 0, meterAt = performance.now(), meterSubmits = renderer.submittedFrames, pendingDrawDt = 0, lastDrawAt = -Infinity
  const clock = new FrameClock()
  const stepSimulation = (wallNow: number) => {
    if (frozen || document.hidden) {
      clock.pause(wallNow)
      return 0
    }
    const substeps = clock.frame(wallNow, input.move(), () => input.takeEnter())
    if (!substeps.length) return 0
    const target = cam.unproject(input.mouse.x, input.mouse.y, innerWidth, innerHeight)
    let stepped = 0
    for (const step of substeps) {
      const p = session.view.player
      session.update(step.dt, { mx: step.mx, my: step.my, aim: Math.atan2(target.y - p.y, target.x - p.x), interact: step.interact }, settings.timeScale)
      stepped += step.dt
      frames++
    }
    pendingDrawDt += stepped
    return substeps.length
  }
  window.addEventListener("keydown", () => {
    const now = performance.now()
    if (!frozen && !document.hidden) stepSimulation(now)
  }, true)
  window.addEventListener("keyup", () => {
    const now = performance.now()
    if (!frozen && !document.hidden) stepSimulation(now)
  }, true)
  window.addEventListener("keydown", () => { clock.recordMove(performance.now(), input.move()); scheduleFrame() })
  window.addEventListener("keyup", () => { clock.recordMove(performance.now(), input.move()); scheduleFrame() })
  document.addEventListener("visibilitychange", () => { if (document.hidden) clock.pause(performance.now()); else scheduleFrame() })
  window.addEventListener("blur", () => clock.pause(performance.now()))
  const lab = new LabPanel(settings, controls, params, () => { input.release(); clock.pause(performance.now()) }, key => {
    if (key === "humanProfile" || key.startsWith("zombie")) updateProfile()
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
    pendingDrawDt = 0
    clock.reset(performance.now(), input.move())
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
      lightOccluders=blockers.length
      for(const b of town.barriers)if(b.kind==="window")occluders.set([...b.rect,.85,0,0,0],lightOccluders++*OCC_FLOATS)
      for(const p of town.props){const s=propShape(p);if(s)occluders.set([...s.rect,s.height,0,0,0],lightOccluders++*OCC_FLOATS)}
    }
    vision.update(p.x, p.y, p.aim, blockers, settings)
    if (scenery.update(town,vision)) renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
    const view = cam.groundRect(5.5)
    const [vx0, vy0, vx1, vy1] = view
    const day = dayCycle(hour)
    lights.fill(0)
    lights.set([p.x, 1.65+supportHeight(town,p.x,p.y), p.y, settings.range, 0, 0, 0, 0, 0, 0, 0, 0, 0, blockers.length, .01, -1])
    let count = 1
    for (const [i, lamp] of town.lamps.entries()) {
      const lampScale = day.lamps * settings.lighting
      lampPower[i] = lampScale
      const power = lampScale * lamp.power
      if (power <= .001) continue
      const lx = lamp.x + (lamp.kind === "street" ? .55 : 0), ly = lamp.y, r = lamp.radius
      if (Math.hypot(lamp.x - p.x, lamp.y - p.y) > 40) continue
      if (lx + r < vx0 || lx - r > vx1 || ly + r < vy0 || ly - r > vy1) continue
      const color=lamp.kind==="street"?[1,.76,.52]:lamp.kind==="porch"?[1,.60,.30]:[1,.54,.24]
      const cone=lamp.kind==="window"?[0,1,-.3,1]:[0,0,0,lamp.kind==="room"?-1:0]
      lights.set([lx, lamp.h, ly, r, ...color, power, ...cone, 0, lightOccluders, lamp.kind==="room"?.18:.22, i], count++ * LIGHT_FLOATS)
    }
    frame.set(cam.viewProj, 0); frame.set([...cam.eye, time], 16)
    frame.set([canvas.width, canvas.height, count, town.lamps.length], 20)
    frame.set([p.x, p.y, 1, .48], 24); frame.set([...day.ambient.map(v=>v*settings.skyFill*(1-settings.weather*.3)), day.strength*(1-settings.weather*.85)], 28)
    const focus = cam.project(p.x, 1, p.y, w, h)
    frame.set([focus.x / w * 2 - 1, 1 - focus.y / h * 2, 1.0, count], 32)
    frame.set([...day.direction, day.sun], 36); frame.set([1 / SIZE, 1 / SIZE, settings.diagnostic, SIZE], 40)
    frame.set([p.aim, Math.cos(settings.cone * Math.PI / 360), settings.awareness, settings.shroud], 44)
    town.doors.forEach((door, i) => doorData.set([door.rect[0], 0, (door.rect[1] + door.rect[3]) / 2, door.open ? -Math.PI / 2 : 0, 1, 1, 1, 1, 0, 0, 1, 0], i * 12))
    doorBatch.count = town.doors.length
    render.batches = [...avatar.draw(p, dt, time, (x,z)=>supportHeight(town,x,z)), doorBatch]
    render.lightCount = render.shadowLightCount = count; render.occluderCount = lightOccluders; render.lampCount = town.lamps.length
    render.view = view; render.grade = [time, settings.diagnostic, 0, settings.exposure]
    renderer.render(render)
    const door = nearbyDoor(town, p.x, p.y)
    status.textContent = `${clockText(hour)}${door ? ` · ${keyLabel("KeyE")} ${door.open ? "Close" : "Open"} door` : ""}`
    const meterNow = performance.now(), elapsed = (meterNow - meterAt) / 1000
    if (elapsed > .25) {
      lab.header.textContent = `${Math.round((renderer.submittedFrames - meterSubmits) / elapsed)} draws/s · ${Math.round(frames / elapsed)} updates/s · ${renderer.drawnChunks} chunks\n${clockText(hour)} · seed ${town.seed}`
      if (lab.visible) lab.refresh()
      frames = 0; meterAt = meterNow; meterSubmits = renderer.submittedFrames
    }
  }
  let pacerTimer = 0, rafScheduled = false
  const canDrawNow = (nowMs: number) =>
    renderer.inflight === 0 &&
    nowMs - lastDrawAt >= TICK_DT * 1000 - 2.2 &&
    (pendingDrawDt > 0 || clock.readyForStep(nowMs))
  const msUntilNextDraw = (nowMs: number) => {
    const stepWait = pendingDrawDt > 0 ? 0 : clock.msUntilNextStep(nowMs)
    const paceWait = Math.max(0, TICK_DT * 1000 - 2.0 - (nowMs - lastDrawAt))
    return Math.max(stepWait, paceWait)
  }
  const scheduleFrame = () => {
    if (frozen || document.hidden) return
    if (!rafScheduled) {
      rafScheduled = true
      requestAnimationFrame(rafLoop)
    }
    if (!pacerTimer) {
      const waitMs = Math.max(1, Math.ceil(msUntilNextDraw(performance.now())))
      pacerTimer = window.setTimeout(() => {
        pacerTimer = 0
        const now = performance.now()
        if (!frozen && !document.hidden && canDrawNow(now)) {
          tick(now)
        } else if (!frozen && !document.hidden) {
          scheduleFrame()
        }
      }, waitMs)
    }
  }
  const rafLoop = (now: number) => {
    rafScheduled = false
    const wallNow = performance.now()
    if (frozen) {
      clock.pause(wallNow)
      return
    }
    if (document.hidden) {
      clock.pause(wallNow)
      rafScheduled = true
      requestAnimationFrame(rafLoop)
      return
    }
    if (canDrawNow(wallNow)) {
      tick(now)
    } else {
      scheduleFrame()
    }
  }
  function tick(now: number) {
    void now
    if (pacerTimer) { clearTimeout(pacerTimer); pacerTimer = 0 }
    const wallNow = performance.now()
    if (frozen || document.hidden) {
      clock.pause(wallNow)
    } else {
      stepSimulation(wallNow)
      if (pendingDrawDt > 0 && renderer.inflight === 0) {
        const dt = pendingDrawDt
        pendingDrawDt = 0
        lastDrawAt = wallNow
        draw(dt)
      }
    }
    scheduleFrame()
  }
  renderer.onIdle = () => {
    const now = performance.now()
    if (!frozen && !document.hidden && renderer.inflight === 0) {
      if (canDrawNow(now)) tick(now)
      else scheduleFrame()
    }
  }
  draw(TICK_DT)
  const harness = {
    ready: true,
    adapterInfo: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
    human: () => ({ profile: avatar.profile, bones: avatar.bones }),
    state: () => ({ ...session.view, explored: vision.explored.filter(v => v > 0).length, vertices }),
    fog: (x: number, y: number) => vision.state(x, y),
    reset,
    freeze: (value = true) => {
      frozen = value
      if (pacerTimer) { clearTimeout(pacerTimer); pacerTimer = 0 }
      pendingDrawDt = 0
      lastDrawAt = -Infinity
      input.release()
      clock.reset(performance.now(), input.move())
      if (!frozen) scheduleFrame()
    },
    setLab(key: keyof typeof settings, value: number) {
      const control = controls.find(c => c.key === key)
      if (!control || !Number.isFinite(value) || ("min" in control ? value < control.min || value > control.max : !("options" in control) || !control.options.some(o=>o.value===value))) throw new Error(`Invalid lab value: ${key}`)
      settings[key] = value
      if (key === "humanProfile" || key.startsWith("zombie")) updateProfile()
      if (key === "hour") session.view.hour = wrapHour(value)
      if (key === "houseSeed" || key === "terrain") regenerate()
    },
    pose(x: number, y: number, aim: number) { Object.assign(session.view.player, { x, y, aim, vx: 0, vy: 0 }); cam.snap(x, y); cam.dist = settings.zoom },
    async step(dt = 1 / 60, command?: Partial<Command>) {
      session.update(dt, { mx: 0, my: 0, aim: session.view.player.aim, interact: false, ...command }, settings.timeScale)
      frames++
      draw(dt)
      await Promise.resolve(); await device.queue.onSubmittedWorkDone()
      return harness.state()
    },
  }
  Object.assign(window, { __arcadeHarness: harness })
  scheduleFrame()
}

main().catch(error => { console.error(error); document.querySelector("#status")!.textContent = `Outbreak could not start: ${error.message}` })
