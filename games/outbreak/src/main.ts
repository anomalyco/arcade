import { Camera } from "@arcade/kit/client/camera"
import { keyLabel, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { Input } from "@arcade/kit/client/input"
import { registerGameCommands } from "@arcade/kit/dev-control"
import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import {
  LOOK_PRESETS,
  LOOK_PRESET_IDS,
  applyLookPreset,
  createLookControls,
  createLookSettings,
  resolveLookPresetId,
  type LookCompareMode,
  type LookPresetId,
  type LookSettings,
} from "@arcade/kit/look"
import { Renderer, SPRITE_FLOATS, type Batch, type FrameInput } from "@arcade/kit/gpu/renderer"
import { FRAME_FLOATS } from "@arcade/kit/gpu/shaders"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS } from "@arcade/kit/gpu/limits"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { aiControls, DEFAULT_AI_CONFIG, type AIState } from "../shared/ai"
import { LocalSession, type Command } from "../shared/session"
import { DEFAULT_FLASHLIGHT_TUNING, flashlightColor, flashlightControls } from "../shared/flashlight"
import { HOTBAR_SIZE } from "../shared/inventory"
import { holdProgress, vaultLift, type PeekInfo } from "../shared/interact"
import { DEFAULT_STAMINA_TUNING, staminaControls } from "../shared/stamina"
import { FrameClock, TICK_DT } from "../shared/clock"
import { sightRects, propShape, SIZE } from "../shared/map"
import { dayCycle, clockText, wrapHour } from "../shared/day-cycle"
import { Vision, FOG_SIZE } from "../shared/vision"
import { supportHeight } from "../shared/terrain"
import { SceneryMemory } from "../shared/scenery-memory"
import { OutbreakAmbientMotion } from "./ambient-motion"
import { OutbreakCombatFX } from "./combat-fx"
import { ExteriorClutterRenderer } from "./clutter"
import { DEFAULT_GROUND_SETTINGS, GroundWearRenderer, groundControls, packGroundCfgBits, randomizeGroundSettings } from "./ground"
import { buildLevel, hex } from "./level"
import { Survivor } from "./survivor"
import { ZombieCrowdRenderer } from "./zombies"
import { zombieControls, zombieProfile, zombieTuning } from "./zombie-profile"
import { shaders } from "./shaders"
import "./style.css"

const params = new URLSearchParams(location.search)
const lookSettings = createLookSettings("current")
const lookCompare: { mode: LookCompareMode; wipeSplit: number } = { mode: 1, wipeSplit: 0.5 }
const peaceful = params.has("peaceful")
const settings = {
  hour: 18,
  timeScale: 120,
  cone: 110,
  awareness: 2.5,
  range: 27,
  shroud: 0.32,
  exposure: 0.92,
  zoom: 46,
  houseSeed: 7,
  terrain: 0.22,
  foliageDensity: 1,
  weather: 0,
  lighting: 1,
  diagnostic: 0,
  skyFill: 1,
  moonFill: 1,
  textures: 1,
  rugStyle: 0,
  wallStyle: 0,
  floorStyle: 0,
  texScale: 1.0,
  texContrast: 1.0,
  texRoughness: 0.0,
  humanProfile: 0,
  lookPreset: "current",
  ...DEFAULT_AI_CONFIG,
  aiWalkSpeed: DEFAULT_AI_CONFIG.walkSpeed,
  ...DEFAULT_STAMINA_TUNING,
  ...DEFAULT_FLASHLIGHT_TUNING,
  ...DEFAULT_GROUND_SETTINGS,
  ...zombieTuning,
  ...(peaceful ? { zombieCount: 0 } : {}),
}

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#game")!
  const status = document.querySelector<HTMLElement>("#status")!
  const promptEl = document.querySelector<HTMLElement>("#prompt")
  const staminaEl = document.querySelector<HTMLElement>("#stamina")
  const staminaFill = document.querySelector<HTMLElement>("#stamina-fill")
  const batteryEl = document.querySelector<HTMLElement>("#battery")
  const batteryFill = document.querySelector<HTMLElement>("#battery-fill")
  const hotbarEl = document.querySelector<HTMLElement>("#hotbar")
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
  const input = new Input(canvas, ["KeyE"])
  input.enabled = true
  input.mouse.y = innerHeight / 2 - 150
  let pendingHotbarSlot: number | undefined
  let pendingHotbarDelta = 0
  let pendingFlashlightToggle = false
  let pendingBarricade = false
  input.onKey = (code) => {
    const slot = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"].indexOf(code)
    if (slot >= 0) {
      if (slot === 0 && session.view.inventory.selectedSlot === 0) pendingFlashlightToggle = true
      pendingHotbarSlot = slot
    }
    if (code === "KeyB") pendingBarricade = true
  }
  input.onWheel = (delta) => {
    if (delta !== 0) pendingHotbarDelta += Math.sign(delta)
  }
  const cam = new Camera()
  const avatar = new Survivor(renderer)
  const zombieCrowd = new ZombieCrowdRenderer(renderer)
  const combatFx = new OutbreakCombatFX(renderer)
  const groundWear = new GroundWearRenderer(renderer)
  const exteriorClutter = new ExteriorClutterRenderer(renderer)
  const ambientMotion = new OutbreakAmbientMotion(renderer)
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
    ...flashlightControls,
    ...staminaControls,
    ...groundControls,
    {
      key: "randomizeGroundTuning",
      label: "Randomize ground & clutter",
      group: "Ground & Clutter",
      type: "action",
      run: () => {
        Object.assign(settings, randomizeGroundSettings(settings, settings.groundTuningSeed))
        lab.refresh()
      },
    },
    { key: "textures", label: "Material mode", group: "Materials", options: [{ label: "Textured + procedural", value: 1 }, { label: "Procedural fallback", value: 0 }, { label: "A/B split", value: 2 }] },
    { key: "rugStyle", label: "Rug style", group: "Materials", options: [{ label: "Oriental & Persian", value: 0 }, { label: "Swapped Medallion", value: 1 }, { label: "Procedural geometric", value: 2 }] },
    { key: "wallStyle", label: "Wall finish", group: "Materials", options: [{ label: "Damask & plaster", value: 0 }, { label: "Fine linen plaster", value: 1 }, { label: "Procedural plaster", value: 2 }] },
    { key: "floorStyle", label: "Floorboards", group: "Materials", options: [{ label: "Wide honey oak", value: 0 }, { label: "Narrow strip oak", value: 1 }, { label: "Procedural planks", value: 2 }] },
    { key: "texScale", label: "Texture scale", group: "Materials", min: 0.5, max: 2, step: 0.05, unit: "×" },
    { key: "texContrast", label: "Texture contrast", group: "Materials", min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "texRoughness", label: "Roughness trim", group: "Materials", min: -0.3, max: 0.3, step: 0.02, unit: "" },
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
    { key: "lookPreset", label: "Style preset", group: "Look", options: LOOK_PRESET_IDS.map(id => ({ label: LOOK_PRESETS[id].label, value: id })) },
    { key: "exposure", label: "Exposure", group: "Look", min: 0.5, max: 2, step: 0.05 },
    { key: "skyFill", label: "Sky fill", group: "Look", min: 0, max: 1.5, step: 0.05 },
    { key: "moonFill", label: "Moonlight fill", group: "Look", min: 0, max: 2, step: 0.05 },
    { key: "zoom", label: "Camera distance", group: "View", min: 24, max: 65, step: 1 },
    { key: "houseSeed", label: "House seed", group: "Generation", min: 1, max: 32, step: 1 },
    { key: "terrain", label: "Terrain relief", group: "Generation", min: 0, max: 0.4, step: 0.02 },
    { key: "foliageDensity", label: "Foliage density", group: "Generation", min: 0.5, max: 1.5, step: 0.05 },
    { key: "weather", label: "Overcast", group: "Day cycle", min: 0, max: 1, step: 0.05 },
    { key: "lighting", label: "Practical lights", group: "Look", min: 0, max: 1.5, step: 0.05 },
  ]
  const doorMesh = new Mesh()
  doorMesh.box(0, 0.13, -0.1, 1.4, 2.3, 0.1, hex(0x463322), MAT.timber)
  doorMesh.box(0.08, 0.35, -0.11, 1.32, 2.1, -0.105, hex(0x57402b), MAT.timber)
  doorMesh.box(1.14, 1.08, 0.1, 1.25, 1.19, 0.18, hex(0xc9a96a), MAT.shiny)
  for (const x of [0.15, 0.75]) {
    for (const y of [0.42, 1.36]) {
      doorMesh.box(x, y, 0.101, x + 0.48, y + 0.7, 0.125, hex(0x5b432d), MAT.timber)
      doorMesh.box(x + 0.035, y + 0.04, 0.126, x + 0.445, y + 0.66, 0.132, hex(0x3a2a1c), MAT.timber)
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
    const substeps = clock.frame(
      wallNow,
      liveMove(),
      () => input.takeEnter(),
      () => {
        const f = input.takeSecondary() || pendingFlashlightToggle
        pendingFlashlightToggle = false
        return f
      },
      () => input.takeJump(),
      () => input.interactHeld,
    )
    if (!substeps.length) return 0
    const target = cam.unproject(input.mouse.x, input.mouse.y, innerWidth, innerHeight)
    const hotbarSlot = pendingHotbarSlot
    const hotbarDelta = pendingHotbarDelta
    const fireEdge = input.takeFirePress()
    const reloadEdge = input.takeReload()
    const meleeEdge = input.takeMelee()
    const barricadeEdge = pendingBarricade
    pendingHotbarSlot = undefined
    pendingHotbarDelta = 0
    pendingBarricade = false
    let stepped = 0
    for (const [idx, step] of substeps.entries()) {
      const p = session.view.player
      session.update(
        step.dt,
        {
          mx: step.mx,
          my: step.my,
          sprint: step.sprint,
          aim: Math.atan2(target.y - p.y, target.x - p.x),
          interact: step.interact,
          flashlight: step.flashlight,
          jump: step.jump,
          interactHeld: step.interactHeld,
          fire: idx === 0 ? fireEdge : false,
          reload: idx === 0 ? reloadEdge : false,
          melee: idx === 0 ? meleeEdge : false,
          barricade: idx === 0 ? barricadeEdge : false,
          ...(idx === 0 && hotbarSlot !== undefined ? { hotbarSlot } : {}),
          ...(idx === 0 && hotbarDelta !== 0 ? { hotbarDelta } : {}),
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
  const syncTextures = () => {
    renderer.setSurfaceTexUniforms({
      enabled: settings.textures,
      globalScale: settings.texScale,
      globalContrast: settings.texContrast,
      globalRoughness: settings.texRoughness,
      rugStyle: settings.rugStyle,
      wallStyle: settings.wallStyle,
      floorStyle: settings.floorStyle,
      splitX: session.view.player.x,
    })
  }
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
      if (key === "houseSeed" || key === "terrain" || key === "foliageDensity") regenerate()
      if (
        key === "textures" ||
        key === "rugStyle" ||
        key === "wallStyle" ||
        key === "floorStyle" ||
        key === "texScale" ||
        key === "texContrast" ||
        key === "texRoughness" ||
        key === "wearAmount" ||
        key === "curbDirt" ||
        key === "puddleWetness" ||
        key === "clutterDensity" ||
        key === "rubbleAmount" ||
        key === "motionStrength" ||
        key === "windGustiness" ||
        key === "clutterSeed"
      )
        syncTextures()
      if (key === "lookPreset") {
        const pid = resolveLookPresetId(settings.lookPreset) ?? "current"
        applyLookPreset(lookSettings, pid)
        lab.refresh()
      }
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
      {
        id: "player.pose",
        label: "Position Survivor & Aim",
        shortLabel: "Pose",
        category: "Scene",
        undoable: false,
        args: {
          x: { type: "number", required: true, description: "World X coordinate" },
          y: { type: "number", required: true, description: "World Y/Z coordinate" },
          aim: { type: "number", description: "Aim angle in radians" },
          flashlight: { type: "boolean", description: "Flashlight on/off" },
          clearZombiesRadius: { type: "number", description: "Clear nearby zombies within radius" },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const x = Number(args?.x ?? session.view.player.x)
          const y = Number(args?.y ?? session.view.player.y)
          const aim = typeof args?.aim === "number" ? args.aim : session.view.player.aim
          Object.assign(session.view.player, {
            x,
            y,
            aim,
            vx: 0,
            vy: 0,
            peekingWindowId: null,
            holdTargetId: null,
            holdElapsed: 0,
            holdTriggered: false,
            holdPendingPrimary: null,
            vault: null,
            channel: null,
          })
          if (typeof args?.flashlight === "boolean") {
            session.view.player.flashlightOn = args.flashlight
            session.view.player.flashlightOutput = args.flashlight ? 1 : 0
          }
          if (typeof args?.clearZombiesRadius === "number" && args.clearZombiesRadius > 0) {
            const rad = args.clearZombiesRadius
            for (const z of session.view.zombies) {
              if (Math.hypot(z.x - x, z.y - y) < rad) {
                z.x = 6
                z.y = 6
                z.state = "wander"
              }
            }
          }
          peekBlend = 0
          lastPeek = null
          session.rebuildCollision()
          cam.snap(x, y)
          cam.dist = settings.zoom
          cam.update(innerWidth / Math.max(1, innerHeight))
          const ahead = cam.project(x + Math.cos(aim) * 4, 0, y + Math.sin(aim) * 4, innerWidth, innerHeight)
          if (ahead.ok) {
            input.mouse.x = ahead.x
            input.mouse.y = ahead.y
          }
          session.update(
            1 / 60,
            { mx: 0, my: 0, aim, interact: false },
            settings.timeScale,
            settings,
          )
          draw(1 / 60)
          await device.queue.onSubmittedWorkDone()
          return {
            x: session.view.player.x,
            y: session.view.player.y,
            aim: session.view.player.aim,
            flashlightOn: session.view.player.flashlightOn,
            prompt: session.view.prompt
              ? {
                  id: session.view.prompt.id,
                  kind: session.view.prompt.kind,
                  primary: session.view.prompt.primary.label,
                  secondary: session.view.prompt.secondary?.label,
                }
              : null,
          }
        },
      },
    ])
  })

  lab.addControls(
    lookSettings as unknown as Record<string, string | number | boolean>,
    createLookControls(lookSettings, { includePresetPicker: false }).map(c => ({ ...c, folded: true })),
  )
  let vertices = 0
  function level() {
    session.view.town.foliageDensity = settings.foliageDensity
    const data = buildLevel(session.view.town)
    vertices = [...data.chunks, ...data.glass].reduce((n, c) => n + c.data.byteLength / 24, 0)
    renderer.setLevel(data)
    combatFx.setLevel(data)
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
      if (previous.town.doors[i]!.locked !== undefined) d.locked = previous.town.doors[i]!.locked
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
    combatFx.reset()
    ambientMotion.reset()
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
    combatFx.reset()
    ambientMotion.reset()
    level()
    scenery = new SceneryMemory()
    renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
    cam.snap(session.view.player.x, session.view.player.y)
    cam.dist = settings.zoom
    pendingDrawDt = 0
    clock.reset(performance.now(), liveMove())
  }
  reset()
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const formatStatus = () => {
    const { player: p, hour, time, prompt, zombies } = session.view
    const primaryKey = keyLabel("KeyE")
    const reloadKey = keyLabel("KeyR")
    let promptText = ""
    if (p.channel) {
      const pct = Math.min(100, Math.round((p.channel.elapsed / Math.max(0.1, p.channel.duration)) * 100))
      promptText = ` · ${p.channel.label} (${pct}%)`
    } else if (prompt) {
      const second = prompt.secondary ? `  ·  Hold ${primaryKey} ${prompt.secondary.label}` : ""
      promptText = ` · ${primaryKey} ${prompt.primary.label}${second}`
    }
    const weaponText =
      p.reloadRemaining > 0
        ? ` · Reloading…`
        : p.equippedItem === "pistol"
          ? ` · 9mm ${p.magAmmo}/${p.magCapacity} (+${p.reserveAmmo}${p.magAmmo === 0 && p.reserveAmmo > 0 ? ` ${reloadKey}` : ""})`
          : ""
    const plankText = p.planks > 0 ? ` · ${p.planks}🪵` : ""
    const alerted = zombies.filter((z) => z.state === "chase" || z.state === "alert" || z.state === "bash").length
    const alertText = alerted > 0 ? ` · ${alerted} pursuing` : ""
    const lootText = p.lootMessage && time < p.lootMessageUntil ? ` · ${p.lootMessage}` : ""
    return `${clockText(hour)}${weaponText}${plankText}${p.exhausted ? " · Exhausted" : ""}${alertText}${promptText}${lootText}`
  }
  const syncWorldPrompt = (w: number, h: number) => {
    if (!promptEl) return
    const { player: p, town, prompt } = session.view
    if (!prompt) {
      promptEl.hidden = true
      return
    }
    const isPeeking = Boolean(session.view.peek)
    const anchorHeight = (isPeeking ? 0.15 : 1.45) + supportHeight(town, prompt.worldX, prompt.worldY)
    const proj = cam.project(prompt.worldX, anchorHeight, prompt.worldY, w, h)
    if (!proj.ok) {
      promptEl.hidden = true
      return
    }
    const primaryKey = esc(keyLabel("KeyE"))
    const primaryHtml = `<span><kbd>${primaryKey}</kbd>${esc(prompt.primary.label)}</span>`
    const secondaryHtml = prompt.secondary
      ? `<span class="sep">·</span><span><kbd>Hold ${primaryKey}</kbd>${esc(prompt.secondary.label)}</span>`
      : ""
    const hold = holdProgress(p)
    const holdHtml = hold > 0 ? `<i class="hold" style="width:${(hold * 100).toFixed(1)}%"></i>` : ""
    promptEl.innerHTML = `${primaryHtml}${secondaryHtml}${holdHtml}`
    promptEl.hidden = false
    promptEl.style.transform = `translate(${proj.x.toFixed(1)}px, ${proj.y.toFixed(1)}px) translate(-50%, ${isPeeking ? "18px" : "-100%"})`
  }
  let lastHotbarKey = ""
  const syncHotbar = () => {
    if (!hotbarEl) return
    const { inventory, player: p } = session.view
    const fKey = keyLabel("KeyF")
    const key = `${inventory.selectedSlot}|${p.flashlightOn}|${fKey}|${inventory.slots.map((s) => (s ? `${s.id}:${s.shortLabel}:${s.active ? 1 : 0}:${s.count ?? ""}` : "")).join(",")}`
    if (key === lastHotbarKey) return
    lastHotbarKey = key
    hotbarEl.innerHTML = Array.from({ length: HOTBAR_SIZE }, (_, i) => {
      const item = inventory.slots[i]
      const sel = i === inventory.selectedSlot
      const on = (item?.kind === "flashlight" && p.flashlightOn) || (item?.kind === "pistol" && p.equippedItem === "pistol")
      const label = item
        ? `${esc(item.shortLabel)}${item.kind === "flashlight" ? ` (${esc(fKey)})` : item.count && item.count > 1 ? ` ×${item.count}` : ""}`
        : "—"
      return `<div class="slot" data-slot="${i + 1}" data-selected="${sel}" data-on="${Boolean(on)}"><kbd>${i + 1}</kbd><b>${label}</b></div>`
    }).join("")
  }
  onKeyLayoutChange(() => {
    lastHotbarKey = ""
    status.textContent = formatStatus()
    syncWorldPrompt(innerWidth, innerHeight)
    syncHotbar()
  })
  await renderer.texturesReady
  syncTextures()
  function draw(dt: number) {
    if (settings.textures === 2) syncTextures()
    const { player: p, town, hour, time, peek, zombies, noises, shots } = session.view
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
        if (p.kind === "coffee" || p.kind === "table" || p.kind === "chair" || p.kind === "nightstand") continue
        const s = propShape(p)
        if (s) occluders.set([...s.rect, s.height, 0, 0, 0], lightOccluders++ * OCC_FLOATS)
      }
    }
    vision.update(p.x, p.y, p.aim, blockers, settings, peek)
    if (scenery.update(town, vision)) renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
    const view = cam.groundRect(5.5)
    const [vx0, vy0, vx1, vy1] = cam.groundRect(2.8)
    const vp = cam.viewProj
    const inLightFrustum = (lx: number, ly: number, r: number): boolean => {
      for (const [sx, sy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const a = vp[3]! + sx * vp[0]! + sy * vp[1]!
        const b = vp[7]! + sx * vp[4]! + sy * vp[5]!
        const c = vp[11]! + sx * vp[8]! + sy * vp[9]!
        const d = vp[15]! + sx * vp[12]! + sy * vp[13]!
        if (a * lx + c * ly + r * Math.hypot(a, c) + (b > 0 ? 2.8 * b : 0) + d < 0) return false
      }
      return true
    }
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
    if (p.flashlightOutput > 0.001 && settings.flashlightIntensity > 0.001) {
      const [fr, fg, fb] = flashlightColor(settings.flashlightWarmth)
      const fx = p.x + Math.cos(p.aim) * 0.25
      const fy = p.y + Math.sin(p.aim) * 0.25
      const fh = 1.22 + supportHeight(town, p.x, p.y)
      const cosHalf = Math.cos((settings.flashlightCone * Math.PI) / 360)
      const power = p.flashlightOutput * settings.flashlightIntensity
      lights.set(
        [fx, fh, fy, settings.flashlightRange, fr, fg, fb, power, Math.cos(p.aim), Math.sin(p.aim), cosHalf, 1, 0, lightOccluders, 0.08, -1],
        count++ * LIGHT_FLOATS,
      )
    }

    const lift = vaultLift(p)
    const survivorBatches = avatar.draw(p, dt, time, (x, z) => supportHeight(town, x, z) + lift)
    const zombieBatches = zombieCrowd.draw(
      zombies,
      dt,
      (x, z) => supportHeight(town, x, z),
      vision,
      view,
      settings,
      Boolean(settings.aiDebugOverlay),
    )

    let addCount = combatFx.processShots(
      shots,
      time,
      dt,
      session.ai,
      zombieCrowd,
      (x, z) => supportHeight(town, x, z),
      addSprites,
      0,
    )
    const fxOut = combatFx.stepAndCollect(
      dt,
      time,
      town,
      p,
      avatar.bones,
      session.ai,
      zombieCrowd,
      (x, z) => supportHeight(town, x, z),
      addSprites,
      addCount,
    )
    addCount = fxOut.addCount
    if (fxOut.muzzleLight && count < MAX_LIGHTS) {
      const [mx, my, mz, mPower] = fxOut.muzzleLight
      lights.set([mx, my, mz, 9.5, 1.0, 0.78, 0.38, mPower, 0, 0, 0, 0, 0, lightOccluders, 0.14, -1], count++ * LIGHT_FLOATS)
    }

    const cutX = activePeek ? activePeek.cutX : p.x
    const cutY = activePeek ? activePeek.cutY : p.y
    const cutFlag = activePeek ? 1 + peekBlend : 1
    const cutRadius = activePeek ? 0.48 + 0.1 * peekBlend : 0.22
    const cutHeight = activePeek ? 1.0 - 0.12 * peekBlend : 1.0
    for (const [i, lamp] of town.lamps.entries()) {
      const lampScale = day.lamps * settings.lighting
      lampPower[i] = lampScale
      const power = lampScale * lamp.power
      if (power <= 0.001) continue
      const lx = lamp.x + (lamp.kind === "street" ? 0.55 : 0)
      const ly = lamp.y
      const r = lamp.radius
      const rEff = r * (r <= 7.5 ? 0.85 : 0.92)
      if (Math.hypot(lamp.x - p.x, lamp.y - p.y) > 40) continue
      if (lx + rEff < vx0 || lx - rEff > vx1 || ly + rEff < vy0 || ly - rEff > vy1 || !inLightFrustum(lx, ly, rEff)) continue
      if (lamp.kind === "room") {
        const b = town.buildings.find(
          (bld) => lx >= bld.rect[0] && lx <= bld.rect[2] && ly >= bld.rect[1] && ly <= bld.rect[3],
        )
        if (b) {
          const roofOpen =
            cutX > b.rect[0] - 0.1 && cutX < b.rect[2] + 0.1 && cutY > b.rect[1] - 0.1 && cutY < b.rect[3] + 0.1
          if (!roofOpen && (b.kind !== "house" || ly < b.rect[1] + 5.5 || b.rect[3] - r > vy1)) continue
        }
      }
      const color =
        lamp.kind === "street"
          ? [1, 0.72, 0.44]
          : lamp.kind === "porch"
            ? [1, 0.58, 0.18]
            : lamp.kind === "window"
              ? [1, 0.54, 0.16]
              : [1, 0.54, 0.18]
      const cone =
        lamp.kind === "window" ? [0, 1, -0.75, 1] : [0, 0, 0, lamp.kind === "room" || lamp.kind === "porch" ? -1 : 0]
      lights.set(
        [lx, lamp.h, ly, r, ...color, power, ...cone, 0, lightOccluders, lamp.kind === "room" ? 0.16 : 0.22, i],
        count++ * LIGHT_FLOATS,
      )
    }
    frame.set(cam.viewProj, 0)
    frame.set([...cam.eye, time], 16)
    const texCfgBits =
      ((settings.textures & 3) >>> 0) |
      (((settings.rugStyle & 3) << 2) >>> 0) |
      (((settings.wallStyle & 3) << 4) >>> 0) |
      (((settings.floorStyle & 3) << 6) >>> 0) |
      ((Math.round((settings.texScale - 0.5) / 0.05) & 63) << 8) |
      ((Math.round(settings.texContrast / 0.05) & 63) << 14)
    frame.set([canvas.width, canvas.height, count, texCfgBits], 20)
    frame.set([cutX, cutY, cutFlag, cutRadius], 24)
    frame.set(
      [
        ...day.ambient.map((v) => v * settings.skyFill * (1 - settings.weather * 0.3)),
        day.strength * settings.moonFill * (1 - settings.weather * 0.85),
      ],
      28,
    )
    const focusX = activePeek ? p.x + (activePeek.cutX - p.x) * peekBlend : p.x
    const focusY = activePeek ? p.y + (activePeek.cutY - p.y) * peekBlend : p.y
    const focus = cam.project(focusX, 1, focusY, w, h)
    frame.set([(focus.x / w) * 2 - 1, 1 - (focus.y / h) * 2, cutHeight, count], 32)
    frame.set([...day.direction, day.sun], 36)
    frame.set([1 / SIZE, 1 / SIZE, settings.diagnostic, packGroundCfgBits(settings)], 40)
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
    const debugAlphaCount = zombieCrowd.renderDebugOverlay(
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
    const groundWearBatches = groundWear.collectBatches(town, view, settings)
    const clutterBatches = exteriorClutter.collectBatches(town, view, settings)
    const motionOut = ambientMotion.stepAndCollect(
      dt,
      time,
      town,
      p,
      view,
      settings,
      alphaSprites,
      debugAlphaCount,
    )
    render.alphaCount = motionOut.alphaCount
    render.addCount = addCount
    render.splatter = combatFx.hasEmitted ? (combatFx.splatter ?? undefined) : undefined
    render.batches = [
      ...groundWearBatches,
      ...clutterBatches,
      ...motionOut.batches,
      ...survivorBatches,
      ...fxOut.batches,
      ...zombieBatches,
      doorBatch,
      ...(openWindows ? [sashBatch] : []),
    ]
    render.lightCount = render.shadowLightCount = count
    render.occluderCount = lightOccluders
    render.lampCount = town.lamps.length
    render.view = view
    render.grade = [time, settings.diagnostic, 0, settings.exposure]
    render.look = lookSettings
    render.lookCompare = lookCompare
    renderer.render(render)
    if (staminaEl && staminaFill) {
      const pct = Math.max(0, Math.min(100, p.stamina * 100))
      staminaFill.style.width = `${pct.toFixed(1)}%`
      staminaEl.dataset.active = String(p.sprinting || p.exhausted || p.stamina < 0.999)
      staminaEl.dataset.exhausted = String(p.exhausted)
    }
    if (batteryEl && batteryFill) {
      const pct = Math.max(0, Math.min(100, p.battery * 100))
      batteryFill.style.width = `${pct.toFixed(1)}%`
      batteryEl.dataset.active = String(p.flashlightOn || p.batteryDepleted || p.battery < 0.999)
      batteryEl.dataset.low = String(p.battery > 0 && p.battery < settings.flashlightFlicker)
      batteryEl.dataset.depleted = String(p.batteryDepleted)
      batteryEl.style.opacity =
        p.flashlightOn && p.battery < settings.flashlightFlicker ? String(0.45 + 0.5 * p.flashlightOutput) : ""
    }
    status.textContent = formatStatus()
    syncWorldPrompt(w, h)
    syncHotbar()
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
  let pacerTimer = 0,
    rafScheduled = false,
    channelPending = false
  const paceChannel = new MessageChannel()
  const canDrawNow = (nowMs: number) =>
    renderer.inflight === 0 &&
    nowMs - lastDrawAt >= TICK_DT * 1000 - 0.65 &&
    (pendingDrawDt > 0 || clock.readyForStep(nowMs))
  const msUntilNextDraw = (nowMs: number) => {
    const stepWait = pendingDrawDt > 0 ? 0 : clock.msUntilNextStep(nowMs)
    const paceWait = Math.max(0, TICK_DT * 1000 - 0.55 - (nowMs - lastDrawAt))
    return Math.max(stepWait, paceWait)
  }
  paceChannel.port1.onmessage = () => {
    channelPending = false
    if (frozen || document.hidden) return
    const now = performance.now()
    if (canDrawNow(now)) {
      tick(now)
    } else {
      scheduleFrame()
    }
  }
  const scheduleFrame = () => {
    if (frozen || document.hidden) return
    if (!rafScheduled) {
      rafScheduled = true
      requestAnimationFrame(rafLoop)
    }
    if (!pacerTimer && !channelPending) {
      const rem = msUntilNextDraw(performance.now())
      const waitMs = renderer.inflight === 0 && rem <= 3.5 ? 0 : Math.max(1, Math.floor(rem - 1.5))
      pacerTimer = window.setTimeout(() => {
        pacerTimer = 0
        if (!frozen && !document.hidden && !channelPending) {
          channelPending = true
          paceChannel.port2.postMessage(null)
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
      else {
        if (pacerTimer) { clearTimeout(pacerTimer); pacerTimer = 0 }
        scheduleFrame()
      }
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
      flashlight: {
        on: session.view.player.flashlightOn,
        battery: session.view.player.battery,
        depleted: session.view.player.batteryDepleted,
        output: session.view.player.flashlightOutput,
        signature: session.view.player.lightSignature,
        cone: settings.flashlightCone,
        range: settings.flashlightRange,
        intensity: settings.flashlightIntensity,
        color: flashlightColor(settings.flashlightWarmth),
      },
      explored: vision.explored.filter((v) => v > 0).length,
      vertices,
      splatter: combatFx.splatter?.inspect() ?? null,
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
    setLab(key: keyof typeof settings, value: number | boolean | string) {
      const control = controls.find((c) => c.key === key)
      if (!control) throw new Error(`Invalid lab key: ${String(key)}`)
      if (typeof value === "boolean") {
        ;(settings as Record<string, unknown>)[key] = value
      } else {
        if (
          "min" in control
            ? typeof value !== "number" || !Number.isFinite(value) || value < control.min || value > control.max
            : "options" in control && !control.options.some((o) => o.value === value)
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
      if (key === "hour" && typeof value === "number") session.view.hour = wrapHour(value)
      if (key === "houseSeed" || key === "terrain" || key === "foliageDensity") regenerate()
      if (
        key === "textures" ||
        key === "rugStyle" ||
        key === "wallStyle" ||
        key === "floorStyle" ||
        key === "texScale" ||
        key === "texContrast" ||
        key === "texRoughness" ||
        key === "wearAmount" ||
        key === "curbDirt" ||
        key === "puddleWetness" ||
        key === "clutterDensity" ||
        key === "rubbleAmount" ||
        key === "motionStrength" ||
        key === "windGustiness" ||
        key === "clutterSeed"
      )
        syncTextures()
      if (key === "lookPreset") {
        const pid = resolveLookPresetId(value) ?? "current"
        applyLookPreset(lookSettings, pid)
        lab.refresh()
      }
    },
    setLookPreset(preset: LookPresetId | string) {
      const pid = resolveLookPresetId(preset)
      if (!pid) throw new Error(`Unknown look preset: ${preset}`)
      settings.lookPreset = pid
      applyLookPreset(lookSettings, pid)
      lab.refresh()
      return { ...lookSettings }
    },
    setLook(patch: Partial<LookSettings>) {
      Object.assign(lookSettings, patch)
      if (patch.preset) settings.lookPreset = patch.preset
      lab.refresh()
      return { ...lookSettings }
    },
    setLookCompare(mode: LookCompareMode, wipeSplit = 0.5) {
      lookCompare.mode = mode
      lookCompare.wipeSplit = wipeSplit
    },
    getLook: () => ({ ...lookSettings }),
    pose(x: number, y: number, aim: number) {
      Object.assign(session.view.player, {
        x,
        y,
        aim,
        vx: 0,
        vy: 0,
        peekingWindowId: null,
        holdTargetId: null,
        holdElapsed: 0,
        holdTriggered: false,
        holdPendingPrimary: null,
        vault: null,
        channel: null,
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
    resolveTargetRect(target: { objectId?: string; world?: [number, number, number]; selector?: string }) {
      const w = innerWidth
      const h = innerHeight
      if (target.world) {
        const [wx, wy, wz] = target.world
        const proj = cam.project(wx, wy, wz, w, h)
        if (proj.ok) {
          return { x: proj.x - 42, y: proj.y - 42, width: 84, height: 84, shape: "pill" as const }
        }
      }
      if (target.objectId === "prompt" && promptEl && !promptEl.hidden) {
        const r = promptEl.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          return { x: r.left, y: r.top, width: r.width, height: r.height, shape: "rect" as const }
        }
      }
      if (target.objectId === "player" || target.objectId === "survivor") {
        const p = session.view.player
        const gy = supportHeight(session.view.town, p.x, p.y)
        const proj = cam.project(p.x, gy + 0.9, p.y, w, h)
        if (proj.ok) {
          return { x: proj.x - 36, y: proj.y - 44, width: 72, height: 88, shape: "pill" as const }
        }
      }
      return null
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
