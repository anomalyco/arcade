import { Camera } from "@arcade/kit/client/camera"
import { keyLabel, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { Input } from "@arcade/kit/client/input"
import { registerGameCommands } from "@arcade/kit/dev-control"
import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import { Renderer, SPRITE_FLOATS, type Batch, type FrameInput } from "@arcade/kit/gpu/renderer"
import { FRAME_FLOATS } from "@arcade/kit/gpu/shaders"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS } from "@arcade/kit/gpu/limits"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { aiControls, DEFAULT_AI_CONFIG, type AIState } from "../shared/ai"
import { LocalSession, type Command } from "../shared/session"
import { vaultLift, type PeekInfo } from "../shared/interact"
import { DEFAULT_STAMINA_TUNING, staminaControls } from "../shared/stamina"
import { FrameClock, TICK_DT } from "../shared/clock"
import { sightRects, propShape, SIZE } from "../shared/map"
import { dayCycle, clockText, wrapHour } from "../shared/day-cycle"
import { Vision, FOG_SIZE } from "../shared/vision"
import { supportHeight } from "../shared/terrain"
import { SceneryMemory } from "../shared/scenery-memory"
import { buildLevel, hex } from "./level"
import { Survivor } from "./survivor"
import { ZombieCrowdRenderer } from "./zombies"
import { zombieControls, zombieProfile, zombieTuning } from "./zombie-profile"
import { shaders } from "./shaders"
import "./style.css"

const params = new URLSearchParams(location.search)
const peaceful = params.has("peaceful")
const settings = {
  hour: 18,
  timeScale: 120,
  cone: 110,
  awareness: 2.5,
  range: 27,
  shroud: 0.32,
  exposure: 1.0,
  zoom: 46,
  houseSeed: 7,
  terrain: 0.22,
  weather: 0,
  lighting: 1,
  diagnostic: 0,
  skyFill: 1,
  humanProfile: 0,
  ...DEFAULT_STAMINA_TUNING,
  ...zombieTuning,
  ...DEFAULT_AI_CONFIG,
  ...(peaceful ? { zombieCount: 0 } : {}),
}

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#game")!
  const status = document.querySelector<HTMLElement>("#status")!
  const staminaEl = document.querySelector<HTMLElement>("#stamina")
  const staminaFill = document.querySelector<HTMLElement>("#stamina-fill")
  if (!navigator.gpu) {
    status.textContent = "Outbreak needs WebGPU."
    return
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) {
    status.textContent = "No WebGPU adapter is available."
    return
  }
  const device = await adapter.requestDevice()
  device.addEventListener("uncapturederror", (e) => console.error(e.error.message))
  void device.lost.then((info) => {
    status.textContent = `GPU lost: ${info.message}. Reload to reconnect.`
  })
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  const renderer = new Renderer(device, context, format, shaders)
  const seed = Number(params.get("seed") ?? 7) >>> 0
  let session = new LocalSession(seed, settings.houseSeed, settings.terrain, settings)
  let vision = new Vision()
  let scenery = new SceneryMemory()
  const input = new Input(canvas)
  input.enabled = true
  input.mouse.y = innerHeight / 2 - 150
  let pendingFlashlightToggle = false
  input.onKey = (code) => {
    if (code === "KeyL") pendingFlashlightToggle = true
  }
  const cam = new Camera()
  const avatar = new Survivor(renderer)
  const zombieCrowd = new ZombieCrowdRenderer(renderer)
  const updateProfile = () => {
    avatar.profile = settings.humanProfile === 1 ? zombieProfile(settings) : undefined
  }
  const controls: LabControl[] = [
    ...aiControls,
    {
      key: "spawnZombieHere",
      label: "Spawn zombie ahead",
      group: "AI",
      type: "action",
      run: () => {
        const p = session.view.player
        session.ai.spawnZombie(
          session.view.town,
          p.x + Math.cos(p.aim) * 4.5,
          p.y + Math.sin(p.aim) * 4.5,
          "wander",
        )
        settings.zombieCount = session.view.zombies.filter((z) => z.state !== "dead").length
      },
    },
    {
      key: "makeNoiseHere",
      label: "Emit test noise",
      group: "AI",
      type: "action",
      run: () => {
        const p = session.view.player
        session.ai.emitNoise(p.x, p.y, 18, "glass", session.view.time, "player", 1.3)
      },
    },
    {
      key: "alertNearbyZombies",
      label: "Alert all to player",
      group: "AI",
      type: "action",
      run: () => {
        const p = session.view.player
        session.ai.setZombieState("chase", p.x, p.y)
      },
    },
    {
      key: "calmAllZombies",
      label: "Reset all to wander",
      group: "AI",
      type: "action",
      run: () => {
        session.ai.setZombieState("wander")
      },
    },
    ...staminaControls,
    {
      key: "humanProfile",
      label: "Pose",
      group: "Zombie",
      options: [
        { label: "Survivor", value: 0 },
        { label: "Zombie", value: 1 },
      ],
    },
    ...zombieControls,
    {
      key: "diagnostic",
      label: "Contribution",
      group: "Diagnostics",
      options: ["Beauty", "Albedo", "Direct", "Ambient + sky", "Specular", "Bloom", "Before memory"].map(
        (label, value) => ({ label, value }),
      ),
    },
    { key: "hour", label: "Time", group: "Day cycle", min: 0, max: 24, step: 0.05 },
    { key: "timeScale", label: "Time scale", group: "Day cycle", min: 0, max: 600, step: 10 },
    { key: "cone", label: "Vision cone", group: "Vision", min: 60, max: 180, step: 1 },
    { key: "awareness", label: "Close awareness", group: "Vision", min: 0, max: 5, step: 0.1 },
    { key: "range", label: "Sight range", group: "Vision", min: 8, max: 40, step: 1 },
    { key: "shroud", label: "Explored shroud", group: "Vision", min: 0.02, max: 0.4, step: 0.01 },
    { key: "exposure", label: "Exposure", group: "Look", min: 0.5, max: 2, step: 0.05 },
    { key: "skyFill", label: "Sky fill", group: "Look", min: 0, max: 1.5, step: 0.05 },
    { key: "zoom", label: "Camera distance", group: "View", min: 24, max: 65, step: 1 },
    { key: "houseSeed", label: "House seed", group: "Generation", min: 1, max: 32, step: 1 },
    { key: "terrain", label: "Terrain relief", group: "Generation", min: 0, max: 0.4, step: 0.02 },
    { key: "weather", label: "Overcast", group: "Day cycle", min: 0, max: 1, step: 0.05 },
    { key: "lighting", label: "Practical lights", group: "Look", min: 0, max: 1.5, step: 0.05 },
  ]
  const doorMesh = new Mesh()
  doorMesh.box(0, 0.13, -0.1, 1.4, 2.3, 0.1, hex(0x796045), MAT.wall)
  doorMesh.box(0.08, 0.35, -0.11, 1.32, 2.1, -0.105, hex(0x8b7253), MAT.wall)
  doorMesh.box(1.15, 1.1, 0.1, 1.24, 1.17, 0.17, hex(0xb9a071))
  for (const x of [0.15, 0.75]) {
    for (const y of [0.42, 1.36]) {
      doorMesh.box(x, y, 0.101, x + 0.48, y + 0.7, 0.125, hex(0x91754e))
      doorMesh.box(x + 0.035, y + 0.04, 0.126, x + 0.445, y + 0.66, 0.132, hex(0x70583d))
    }
  }
  const doorModel = renderer.addModel(doorMesh)
  const doorData = new Float32Array(8 * 12)
  const doorBatch: Batch = { model: doorModel, data: doorData, count: 0 }
  const sashMesh = new Mesh()
  sashMesh.box(-1.0, 1.48, -0.06, 1.0, 2.12, 0.06, hex(0xa8a99c), MAT.wall)
  sashMesh.box(-0.92, 1.54, -0.02, 0.92, 2.06, 0.02, hex(0x809c9e), MAT.glass)
  const sashModel = renderer.addModel(sashMesh)
  const sashData = new Float32Array(12 * 12)
  const sashBatch: Batch = { model: sashModel, data: sashData, count: 0 }
  let peekBlend = 0
  let lastPeek: PeekInfo | null = null
  const frame = new Float32Array(FRAME_FLOATS)
  const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  const occluders = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  const lampPower = new Float32Array(MAX_LIGHTS)
  const alphaSprites = new Float32Array(1024 * SPRITE_FLOATS)
  const addSprites = new Float32Array(256 * SPRITE_FLOATS)
  const render: FrameInput = {
    frame,
    lights,
    lightCount: 0,
    shadowLightCount: 0,
    occluders,
    occluderCount: 0,
    lampPower,
    lampCount: 0,
    view: [0, 0, SIZE, SIZE],
    batches: [],
    alphaSprites,
    alphaCount: 0,
    addSprites,
    addCount: 0,
    grade: [0, 0, 0, 1],
  }
  let blockers = sightRects(session.view.town)
  let revision = -1
  let lightOccluders = 0
  let frozen = params.has("bench")
  let frames = 0
  let meterAt = performance.now()
  let meterSubmits = renderer.submittedFrames
  let pendingDrawDt = 0
  let lastDrawAt = -Infinity
  const clock = new FrameClock()
  const liveMove = () => ({ ...input.move(), sprint: input.sprinting })
  const stepSimulation = (wallNow: number) => {
    if (frozen || document.hidden) {
      clock.pause(wallNow)
      return 0
    }
    const substeps = clock.frame(wallNow, liveMove(), () => input.takeEnter(), () => input.takeCycle())
    if (!substeps.length) return 0
    const target = cam.unproject(input.mouse.x, input.mouse.y, innerWidth, innerHeight)
    let stepped = 0
    for (const [idx, step] of substeps.entries()) {
      const p = session.view.player
      const toggleFl = idx === 0 && pendingFlashlightToggle
      if (toggleFl) pendingFlashlightToggle = false
      session.update(
        step.dt,
        {
          mx: step.mx,
          my: step.my,
          sprint: step.sprint,
          aim: Math.atan2(target.y - p.y, target.x - p.x),
          interact: step.interact,
          cycle: step.cycle,
          toggleFlashlight: toggleFl,
        },
        settings.timeScale,
        settings,
      )
      stepped += step.dt
      frames++
    }
    pendingDrawDt += stepped
    return substeps.length
  }
  window.addEventListener(
    "keydown",
    () => {
      const now = performance.now()
      if (!frozen && !document.hidden) stepSimulation(now)
    },
    true,
  )
  window.addEventListener(
    "keyup",
    () => {
      const now = performance.now()
      if (!frozen && !document.hidden) stepSimulation(now)
    },
    true,
  )
  window.addEventListener("keydown", () => {
    clock.recordMove(performance.now(), liveMove())
    scheduleFrame()
  })
  window.addEventListener("keyup", () => {
    clock.recordMove(performance.now(), liveMove())
    scheduleFrame()
  })
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clock.pause(performance.now())
    else scheduleFrame()
  })
  window.addEventListener("blur", () => clock.pause(performance.now()))
  const lab = new LabPanel(
    settings,
    controls,
    params,
    () => {
      input.release()
      clock.pause(performance.now())
    },
    (key) => {
      if (key === "humanProfile" || key.startsWith("zombie")) updateProfile()
      if (key === "zombieCount") {
        session.ai.config.zombieCount = settings.zombieCount
        session.ai.syncPopulation(session.view.town, session.view.player.x, session.view.player.y)
      }
      if (key === "hour") session.view.hour = wrapHour(settings.hour)
      if (key === "houseSeed" || key === "terrain") regenerate()
    },
  )

  registerGameCommands((commands) => {
    commands.registerAll([
      {
        id: "ai.spawn",
        label: "Spawn Zombie",
        shortLabel: "Spawn Zombie",
        category: "Scene",
        undoable: false,
        args: {
          x: { type: "number", description: "World X (default: ahead of survivor)" },
          y: { type: "number", description: "World Y (default: ahead of survivor)" },
          state: { type: "string", description: "Initial AI state (wander, investigate, alert, chase, search)" },
        },
        enabled: () => true,
        run: (_ctx, args) => {
          const p = session.view.player
          const x = typeof args?.x === "number" ? args.x : p.x + Math.cos(p.aim) * 4.5
          const y = typeof args?.y === "number" ? args.y : p.y + Math.sin(p.aim) * 4.5
          const state = (typeof args?.state === "string" ? args.state : "wander") as AIState
          const z = session.ai.spawnZombie(session.view.town, x, y, state)
          z.targetX = p.x
          z.targetY = p.y
          settings.zombieCount = session.view.zombies.filter((a) => a.state !== "dead").length
          return { spawned: z.id, x: z.x, y: z.y, state: z.state, total: settings.zombieCount }
        },
      },
      {
        id: "ai.set-state",
        label: "Set Zombie AI State",
        shortLabel: "Set AI State",
        category: "Scene",
        undoable: false,
        args: {
          state: { type: "string", required: true, description: "Target AI state (wander, investigate, alert, chase, search)" },
          id: { type: "number", description: "Optional specific zombie ID" },
        },
        enabled: () => true,
        run: (_ctx, args) => {
          const p = session.view.player
          const state = String(args?.state ?? "wander") as AIState
          const id = typeof args?.id === "number" ? args.id : undefined
          const updated = session.ai.setZombieState(state, p.x, p.y, id)
          return { state, updated }
        },
      },
      {
        id: "ai.make-noise",
        label: "Emit AI Noise Event",
        shortLabel: "Make Noise",
        category: "Scene",
        undoable: false,
        args: {
          x: { type: "number", description: "World X (default: survivor X)" },
          y: { type: "number", description: "World Y (default: survivor Y)" },
          radius: { type: "number", description: "Noise radius in metres (default: 18)" },
          kind: { type: "string", description: "Noise kind (gunshot, glass, door, vault, sprint)" },
        },
        enabled: () => true,
        run: (_ctx, args) => {
          const p = session.view.player
          const x = typeof args?.x === "number" ? args.x : p.x
          const y = typeof args?.y === "number" ? args.y : p.y
          const radius = typeof args?.radius === "number" ? args.radius : 18
          const kind = typeof args?.kind === "string" ? args.kind : "glass"
          const ev = session.ai.emitNoise(x, y, radius, kind, session.view.time, "player")
          return { noise: ev }
        },
      },
    ])
  })

  let vertices = 0
  function level() {
    const data = buildLevel(session.view.town)
    vertices = [...data.chunks, ...data.glass].reduce((n, c) => n + c.data.byteLength / 24, 0)
    renderer.setLevel(data)
  }
  function regenerate() {
    const previous = session.view
    session = new LocalSession(previous.town.seed, settings.houseSeed, settings.terrain, settings)
    Object.assign(session.view.player, previous.player)
    session.view.hour = previous.hour
    session.view.time = previous.time
    session.view.revision = previous.revision + 1
    session.view.town.doors.forEach((d, i) => {
      d.open = previous.town.doors[i]!.open
      d.locked = previous.town.doors[i]!.locked
    })
    session.view.town.windows.forEach((w, i) => {
      w.open = previous.town.windows[i]!.open
      w.openable = previous.town.windows[i]!.openable
    })
    session.rebuildCollision()
    revision = -1
    level()
    avatar.reset()
    zombieCrowd.reset()
  }
  function reset(nextSeed = seed) {
    session.close()
    session = new LocalSession(nextSeed, settings.houseSeed, settings.terrain, settings)
    vision = new Vision()
    revision = -1
    peekBlend = 0
    lastPeek = null
    avatar.reset()
    zombieCrowd.reset()
    level()
    scenery = new SceneryMemory()
    renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
    cam.snap(session.view.player.x, session.view.player.y)
    cam.dist = settings.zoom
    pendingDrawDt = 0
    clock.reset(performance.now(), liveMove())
  }
  reset()
  const formatStatus = () => {
    const { player: p, hour, prompt, zombies } = session.view
    const interactKey = keyLabel("KeyE")
    const cycleKey = keyLabel("KeyQ")
    let promptText = ""
    if (prompt) {
      const nextIdx = (prompt.actions.findIndex((a) => a.id === prompt.activeAction.id) + 1) % prompt.actions.length
      const next = prompt.actions.length > 1 ? prompt.actions[nextIdx] : undefined
      promptText = ` · ${interactKey} ${prompt.activeAction.label}${next ? ` (${cycleKey} ${next.label})` : ""}`
    }
    const alerted = zombies.filter((z) => z.state === "chase" || z.state === "alert" || z.state === "bash").length
    const alertText = alerted > 0 ? ` · ${alerted} pursuing` : ""
    const flText = p.flashlightOn ? " · Flashlight ON" : ""
    return `${clockText(hour)}${p.exhausted ? " · Exhausted" : ""}${flText}${alertText}${promptText}`
  }
  onKeyLayoutChange(() => {
    status.textContent = formatStatus()
  })
  function draw(dt: number) {
    const { player: p, town, hour, time, peek, zombies, noises } = session.view
    settings.hour = Math.round(hour * 20) / 20
    if (peek) {
      lastPeek = peek
      peekBlend = Math.min(1, peekBlend + dt * 6.5)
    } else {
      peekBlend = Math.max(0, peekBlend - dt * 5.5)
      if (peekBlend <= 0.001) lastPeek = null
    }
    const activePeek = peek ?? (peekBlend > 0.001 ? lastPeek : null)
    const w = innerWidth
    const h = innerHeight
    const dpr = Math.min(devicePixelRatio, 2)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      renderer.resize(canvas.width, canvas.height)
    }
    cam.zoomOffset = settings.zoom - 24
    const camX = p.x + (activePeek ? activePeek.camOffsetX * peekBlend : 0)
    const camY = p.y + (activePeek ? activePeek.camOffsetY * peekBlend : 0)
    cam.follow(camX, camY, 0, 0, dt, false)
    cam.update(w / h)
    if (revision !== session.view.revision) {
      revision = session.view.revision
      blockers = sightRects(town)
      occluders.fill(0)
      blockers.forEach((r, i) => occluders.set([...r, 2.8, 0, 0, 0], i * OCC_FLOATS))
      lightOccluders = blockers.length
      for (const b of town.barriers)
        if (b.kind === "window") occluders.set([...b.rect, 0.85, 0, 0, 0], lightOccluders++ * OCC_FLOATS)
      for (const p of town.props) {
        const s = propShape(p)
        if (s) occluders.set([...s.rect, s.height, 0, 0, 0], lightOccluders++ * OCC_FLOATS)
      }
    }
    vision.update(p.x, p.y, p.aim, blockers, settings, peek)
    if (scenery.update(town, vision)) renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
    const view = cam.groundRect(5.5)
    const [vx0, vy0, vx1, vy1] = view
    const day = dayCycle(hour)
    lights.fill(0)
    const sightX = activePeek ? p.x + (activePeek.eyeX - p.x) * peekBlend : p.x
    const sightY = activePeek ? p.y + (activePeek.eyeY - p.y) * peekBlend : p.y
    const sightAim = peek ? peek.aim : p.aim
    const sightCone = activePeek
      ? settings.cone + (Math.max(settings.cone, activePeek.cone) - settings.cone) * peekBlend
      : settings.cone
    const sightAwareness = activePeek
      ? settings.awareness + (Math.max(settings.awareness, activePeek.awareness) - settings.awareness) * peekBlend
      : settings.awareness
    lights.set([
      sightX,
      1.65 + supportHeight(town, p.x, p.y),
      sightY,
      settings.range,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      blockers.length,
      0.01,
      -1,
    ])
    let count = 1
    if (p.flashlightOn && count < MAX_LIGHTS) {
      const flX = p.x + Math.cos(p.aim) * 0.28
      const flY = p.y + Math.sin(p.aim) * 0.28
      const flH = 1.25 + supportHeight(town, p.x, p.y)
      lights.set(
        [
          flX,
          flH,
          flY,
          15.5,
          1.0,
          0.95,
          0.82,
          0.75,
          Math.cos(p.aim),
          Math.sin(p.aim),
          Math.cos(0.42),
          1,
          0,
          lightOccluders,
          0.08,
          -1,
        ],
        count++ * LIGHT_FLOATS,
      )
    }
    for (const [i, lamp] of town.lamps.entries()) {
      const lampScale = day.lamps * settings.lighting
      lampPower[i] = lampScale
      const power = lampScale * lamp.power
      if (power <= 0.001) continue
      const lx = lamp.x + (lamp.kind === "street" ? 0.55 : 0)
      const ly = lamp.y
      const r = lamp.radius
      if (Math.hypot(lamp.x - p.x, lamp.y - p.y) > 40) continue
      if (lx + r < vx0 || lx - r > vx1 || ly + r < vy0 || ly - r > vy1) continue
      const color =
        lamp.kind === "street" ? [1, 0.76, 0.52] : lamp.kind === "porch" ? [1, 0.6, 0.3] : [1, 0.54, 0.24]
      const cone = lamp.kind === "window" ? [0, 1, -0.3, 1] : [0, 0, 0, lamp.kind === "room" ? -1 : 0]
      lights.set(
        [
          lx,
          lamp.h,
          ly,
          r,
          ...color,
          power,
          ...cone,
          0,
          lightOccluders,
          lamp.kind === "room" ? 0.18 : 0.22,
          i,
        ],
        count++ * LIGHT_FLOATS,
      )
    }
    const cutX = activePeek ? activePeek.cutX : p.x
    const cutY = activePeek ? activePeek.cutY : p.y
    const cutFlag = activePeek ? 1 + peekBlend : 1
    const cutRadius = activePeek ? 0.48 + 0.08 * peekBlend : 0.48
    frame.set(cam.viewProj, 0)
    frame.set([...cam.eye, time], 16)
    frame.set([canvas.width, canvas.height, count, town.lamps.length], 20)
    frame.set([cutX, cutY, cutFlag, cutRadius], 24)
    frame.set(
      [
        ...day.ambient.map((v) => v * settings.skyFill * (1 - settings.weather * 0.3)),
        day.strength * (1 - settings.weather * 0.85),
      ],
      28,
    )
    const focusX = activePeek ? p.x + (activePeek.cutX - p.x) * peekBlend : p.x
    const focusY = activePeek ? p.y + (activePeek.cutY - p.y) * peekBlend : p.y
    const focus = cam.project(focusX, 1, focusY, w, h)
    frame.set([(focus.x / w) * 2 - 1, 1 - (focus.y / h) * 2, 1.0, count], 32)
    frame.set([...day.direction, day.sun], 36)
    frame.set([1 / SIZE, 1 / SIZE, settings.diagnostic, SIZE], 40)
    frame.set([sightAim, Math.cos((sightCone * Math.PI) / 360), sightAwareness, settings.shroud], 44)
    town.doors.forEach((door, i) =>
      doorData.set(
        [door.rect[0], 0, (door.rect[1] + door.rect[3]) / 2, door.open ? -Math.PI / 2 : 0, 1, 1, 1, 1, 0, 0, 1, 0],
        i * 12,
      ),
    )
    doorBatch.count = town.doors.length
    let openWindows = 0
    for (const win of town.windows) {
      if (!win.open) continue
      const [wx0, wy0, wx1, wy1] = win.rect
      const horizontal = wx1 - wx0 > wy1 - wy0
      const yaw = horizontal ? 0 : Math.PI / 2
      sashData.set([(wx0 + wx1) / 2, 0.38, (wy0 + wy1) / 2, yaw, 1, 1, 1, 1, 0, 0, 1, 0], openWindows++ * 12)
    }
    sashBatch.count = openWindows
    const lift = vaultLift(p)
    const zombieBatches = zombieCrowd.draw(
      zombies,
      dt,
      (x, z) => supportHeight(town, x, z),
      vision,
      view,
      settings,
      Boolean(settings.aiDebugOverlay),
    )
    render.alphaCount = zombieCrowd.renderDebugOverlay(
      Boolean(settings.aiDebugOverlay),
      zombies,
      noises,
      p,
      session.ai.config,
      time,
      (x, z) => supportHeight(town, x, z),
      cam,
      w,
      h,
      alphaSprites,
      0,
    )
    render.batches = [
      ...avatar.draw(p, dt, time, (x, z) => supportHeight(town, x, z) + lift),
      ...zombieBatches,
      doorBatch,
      ...(openWindows ? [sashBatch] : []),
    ]
    render.lightCount = render.shadowLightCount = count
    render.occluderCount = lightOccluders
    render.lampCount = town.lamps.length
    render.view = view
    render.grade = [time, settings.diagnostic, 0, settings.exposure]
    renderer.render(render)
    if (staminaEl && staminaFill) {
      const pct = Math.max(0, Math.min(100, p.stamina * 100))
      staminaFill.style.width = `${pct.toFixed(1)}%`
      staminaEl.dataset.active = String(p.sprinting || p.exhausted || p.stamina < 0.999)
      staminaEl.dataset.exhausted = String(p.exhausted)
    }
    status.textContent = formatStatus()
    const meterNow = performance.now()
    const elapsed = (meterNow - meterAt) / 1000
    if (elapsed > 0.25) {
      lab.header.textContent = `${Math.round((renderer.submittedFrames - meterSubmits) / elapsed)} draws/s · ${Math.round(frames / elapsed)} updates/s · ${renderer.drawnChunks} chunks · ${zombies.filter((z) => z.state !== "dead").length} zombies\n${clockText(hour)} · seed ${town.seed}`
      if (lab.visible) lab.refresh()
      frames = 0
      meterAt = meterNow
      meterSubmits = renderer.submittedFrames
    }
  }
  let pacerTimer = 0
  let rafScheduled = false
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
    if (pacerTimer) {
      clearTimeout(pacerTimer)
      pacerTimer = 0
    }
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
    state: () => ({
      ...session.view,
      peekBlend,
      explored: vision.explored.filter((v) => v > 0).length,
      vertices,
    }),
    fog: (x: number, y: number) => vision.state(x, y),
    reset,
    freeze: (value = true) => {
      frozen = value
      if (pacerTimer) {
        clearTimeout(pacerTimer)
        pacerTimer = 0
      }
      pendingDrawDt = 0
      lastDrawAt = -Infinity
      input.release()
      clock.reset(performance.now(), liveMove())
      if (!frozen) scheduleFrame()
    },
    setLab(key: keyof typeof settings, value: number | boolean) {
      const control = controls.find((c) => c.key === key)
      if (!control) throw new Error(`Invalid lab key: ${String(key)}`)
      if (typeof value === "boolean") {
        ;(settings as Record<string, unknown>)[key] = value
      } else {
        if (
          !Number.isFinite(value) ||
          ("min" in control
            ? value < control.min || value > control.max
            : "options" in control && !control.options.some((o) => o.value === value))
        ) {
          throw new Error(`Invalid lab value: ${String(key)}`)
        }
        ;(settings as Record<string, unknown>)[key] = value
      }
      if (key === "humanProfile" || key.startsWith("zombie")) updateProfile()
      if (key === "zombieCount") {
        session.ai.config.zombieCount = Number(settings.zombieCount)
        session.ai.syncPopulation(session.view.town, session.view.player.x, session.view.player.y)
      }
      if (key === "hour") session.view.hour = wrapHour(Number(value))
      if (key === "houseSeed" || key === "terrain") regenerate()
    },
    pose(x: number, y: number, aim: number) {
      Object.assign(session.view.player, {
        x,
        y,
        aim,
        vx: 0,
        vy: 0,
        peekingWindowId: null,
        lastPeekedWindowId: null,
        cycledTargetId: null,
        cycledActionIndex: 0,
        vault: null,
      })
      peekBlend = 0
      lastPeek = null
      session.rebuildCollision()
      cam.snap(x, y)
      cam.dist = settings.zoom
    },
    spawnZombie(x: number, y: number, state: AIState = "wander", aim?: number) {
      const z = session.ai.spawnZombie(session.view.town, x, y, state, aim)
      settings.zombieCount = session.view.zombies.filter((a) => a.state !== "dead").length
      return z
    },
    setZombieState(state: AIState, id?: number) {
      const p = session.view.player
      return session.ai.setZombieState(state, p.x, p.y, id)
    },
    makeNoise(x: number, y: number, radius = 18, kind = "glass") {
      return session.ai.emitNoise(x, y, radius, kind, session.view.time, "player")
    },
    async step(dt = 1 / 60, command?: Partial<Command>) {
      session.update(
        dt,
        { mx: 0, my: 0, aim: session.view.player.aim, interact: false, ...command },
        settings.timeScale,
        settings,
      )
      frames++
      draw(dt)
      await Promise.resolve()
      await device.queue.onSubmittedWorkDone()
      return harness.state()
    },
  }
  Object.assign(window, { __arcadeHarness: harness })
  scheduleFrame()
}

main().catch((error) => {
  console.error(error)
  document.querySelector("#status")!.textContent = `Outbreak could not start: ${error.message}`
})
