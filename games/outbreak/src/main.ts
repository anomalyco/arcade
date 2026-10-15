import { Camera } from "@arcade/kit/client/camera"
import { keyLabel, keyLabelSetting, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
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
import { FOLIAGE_WIND_FLOATS, foliageSettings, nearestFoliageActors, packFoliageActors, packFoliageUniforms } from "@arcade/kit/gpu/foliage"
import { aiControls, DEFAULT_AI_CONFIG, type AIState } from "../shared/ai"
import { LocalSession, type Command } from "../shared/session"
import { DEFAULT_FLASHLIGHT_TUNING, flashlightColor, flashlightControls } from "../shared/flashlight"
import { HOLD_DURATION, vaultLift, type PeekInfo } from "../shared/interact"
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
import {
  CombinedFogMemory,
  DEFAULT_FOG_OF_WAR,
  collectFogSoundSprites,
  fogOfWarControls,
} from "./fog-of-war"
import { applyOutbreakDayNight } from "./day-night"
import { DEFAULT_GROUND_SETTINGS, GroundWearRenderer, groundControls, packGroundCfgBits, randomizeGroundSettings } from "./ground"
import { buildLevel, hex } from "./level"
import { archSettings } from "./architecture"
import {
  DEFAULT_OUTBREAK_LIGHTING,
  OUTBREAK_FOLIAGE_UNIFORM_OFFSET,
  OUTBREAK_LIGHTING_UNIFORM_FLOATS,
  OUTBREAK_LOOK_LIGHTING_PRESETS,
  outbreakLightingControls,
  packOutbreakLightingUniforms,
  resolveLampLight,
  STREET_LAMP_POSTS,
  streetLampHead,
} from "./lighting"
import { humanProfiles } from "@arcade/kit/human-profile"
import { Survivor, survivorAimControls, survivorAimTuning } from "./survivor"
import { DEFAULT_HUD_SETTINGS, hudControls, OutbreakHud } from "./hud"
import { InventoryHud } from "./inventory-hud"
import { SURVIVOR_COLOURS } from "./net-session"
import { WEATHER_PRESETS } from "@arcade/kit/weather"
import {
  DEFAULT_OUTBREAK_WEATHER,
  OutbreakWeatherController,
  applyOutbreakWeatherPreset,
  outbreakWeatherControls,
  randomizeOutbreakWeather,
  toSharedWeatherSettings,
} from "./weather"
import { CoopView } from "./coop-view"
import type { NetSession } from "./net-session"
import { ZombieCrowdRenderer } from "./zombies"
import { zombieControls, zombieProfile, zombieTuning } from "./zombie-profile"
import { shaders } from "./shaders"
import "./style.css"

/** Player first, then the nearest living zombies: grass and bushes bend away from them (presentation only). */
function foliageActors(p: { x: number; y: number }, zombies: readonly { x: number; y: number; state: string }[]) {
  return nearestFoliageActors(p.x, p.y, zombies.filter((z) => z.state !== "dead").map((z) => ({ x: z.x, z: z.y })))
}

const params = new URLSearchParams(location.search)
const lookSettings = createLookSettings("noir")
const lookCompare: { mode: LookCompareMode; wipeSplit: number } = { mode: 1, wipeSplit: 0.5 }
const peaceful = params.has("peaceful")
const settings = {
  hour: 18,
  timeScale: 120,
  dayNightLook: 1,
  cone: 110,
  awareness: 2.5,
  range: 27,
  shroud: 0.32,
  zoom: 46,
  houseSeed: 7,
  terrain: 0.22,
  foliageDensity: 1,
  houseDecay: 0,
  weathering: 1,
  weather: 0,
  diagnostic: 0,
  textures: 1,
  rugStyle: 0,
  wallStyle: 0,
  floorStyle: 0,
  texScale: 1.0,
  texContrast: 1.0,
  texRoughness: 0.0,
  humanProfile: 0,
  lookPreset: "noir",
  ...DEFAULT_OUTBREAK_LIGHTING,
  ...OUTBREAK_LOOK_LIGHTING_PRESETS.noir,
  ...DEFAULT_FOG_OF_WAR,
  ...DEFAULT_AI_CONFIG,
  aiWalkSpeed: DEFAULT_AI_CONFIG.walkSpeed,
  ...DEFAULT_STAMINA_TUNING,
  ...DEFAULT_FLASHLIGHT_TUNING,
  ...DEFAULT_GROUND_SETTINGS,
  ...DEFAULT_OUTBREAK_WEATHER,
  ...zombieTuning,
  ...survivorAimTuning,
  ...DEFAULT_HUD_SETTINGS,
  ...(peaceful ? { zombieCount: 0 } : {}),
  infiniteAmmo: params.has("infiniteAmmo") ? 1 : 0,
}

const streetHeads = STREET_LAMP_POSTS.map(streetLampHead)
function nearestStreetHead(x: number, y: number): readonly [number, number, number] {
  let best = streetHeads[0]!
  for (const head of streetHeads) if (Math.hypot(head[0] - x, head[2] - y) < Math.hypot(best[0] - x, best[2] - y)) best = head
  return best
}

const zombieSlots: [number, number, number, number] = [-999, -999, -999, -999]
/** Two nearest living zombies within 12 m for analytic lamp shadows; unused slots stay far away. */
function nearestZombies(zombies: readonly { x: number; y: number; state: string }[], px: number, py: number) {
  let d0 = 144
  let d1 = 144
  zombieSlots.fill(-999)
  for (const z of zombies) {
    if (z.state === "dead") continue
    const d = (z.x - px) ** 2 + (z.y - py) ** 2
    if (d < d0) {
      d1 = d0
      zombieSlots[2] = zombieSlots[0]
      zombieSlots[3] = zombieSlots[1]
      d0 = d
      zombieSlots[0] = z.x
      zombieSlots[1] = z.y
    } else if (d < d1) {
      d1 = d
      zombieSlots[2] = z.x
      zombieSlots[3] = z.y
    }
  }
  return zombieSlots
}

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#game")!
  const status = document.querySelector<HTMLElement>("#status")!
  const promptEl = document.querySelector<HTMLElement>("#prompt")
  const staminaEl = document.querySelector<HTMLElement>("#stamina")
  const staminaFill = document.querySelector<HTMLElement>("#stamina-fill")
  const batteryEl = document.querySelector<HTMLElement>("#battery")
  const batteryFill = document.querySelector<HTMLElement>("#battery-fill")
  const hud = new OutbreakHud(document.body, settings)
  hud.avoid(promptEl)
  const inventoryHud = new InventoryHud(
    {
      prompt: promptEl,
      hotbar: document.querySelector<HTMLElement>("#hotbar"),
      belt: document.querySelector<HTMLElement>("#belt"),
      pack: document.querySelector<HTMLElement>("#pack"),
      craft: document.querySelector<HTMLElement>("#craft"),
      markers: document.querySelector<HTMLElement>("#markers"),
    },
    (index) => SURVIVOR_COLOURS[index % SURVIVOR_COLOURS.length]!.css,
    () => session.sim.slots.map((s) => s.survivor),
  )
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
  // `?room=<code>` joins a co-op room; otherwise the offline LocalSession, exactly as before.
  const coop = CoopView.fromUrl(renderer, params)
  const makeSession = (s: number) => coop.net ?? new LocalSession(s, settings.houseSeed, settings.terrain, settings)
  let session: LocalSession | NetSession = makeSession(seed)
  coop.companions = () => {
    const s = session
    return s instanceof LocalSession ? s.sim.slots.filter((slot) => slot !== s.slot) : []
  }
  let vision = new Vision()
  let scenery = new SceneryMemory()
  const combinedFog = new CombinedFogMemory()
  const input = new Input(canvas, ["KeyE"])
  input.enabled = true
  input.mouse.y = innerHeight / 2 - 150
  let pendingHotbarSlot: number | undefined
  let pendingHotbarDelta = 0
  let pendingFlashlightToggle = false
  let pendingBarricade = false
  let pendingVerbs: Partial<Command> = {}
  // KeyG and KeyQ are tap-or-hold: the tap fires on release, the hold once it has lasted HOLD_DURATION.
  const holds = new Map<string, { at: number; fired: boolean }>()
  input.onKey = (code) => {
    const digit = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"].indexOf(code)
    if (digit >= 0) {
      const meant = inventoryHud.digit(digit, session.view)
      if (meant.hotbarSlot !== undefined) {
        if (meant.hotbarSlot === 0 && session.view.inventory.selectedSlot === 0) pendingFlashlightToggle = true
        pendingHotbarSlot = meant.hotbarSlot
      } else if (meant.pick) pendingVerbs.pick = meant.pick
    }
    if (code === "KeyB") pendingBarricade = true
    if (code === "Tab") inventoryHud.togglePack()
    if (code === "Escape") inventoryHud.close()
    if (code === "KeyG" || code === "KeyQ") holds.set(code, { at: performance.now(), fired: false })
  }
  const pollHolds = (now: number) => {
    for (const [code, h] of holds) {
      const down = input.held(code)
      if (down && !h.fired && now - h.at >= HOLD_DURATION * 1000) {
        h.fired = true
        if (code === "KeyG") pendingVerbs.bundle = true
        else if (!inventoryHud.craftOpen) inventoryHud.toggleCraft()
      } else if (!down) {
        if (!h.fired) {
          if (code === "KeyG") pendingVerbs.drop = true
          else if (inventoryHud.craftOpen) inventoryHud.close()
          else pendingVerbs.ping = true
        }
        holds.delete(code)
      }
    }
  }
  input.onWheel = (delta) => {
    if (delta !== 0) pendingHotbarDelta += Math.sign(delta)
  }
  const cam = new Camera()
  let avatar = new Survivor(renderer)
  let avatarPalette: object | null = null
  const zombieCrowd = new ZombieCrowdRenderer(renderer)
  const combatFx = new OutbreakCombatFX(renderer)
  const groundWear = new GroundWearRenderer(renderer)
  const exteriorClutter = new ExteriorClutterRenderer(renderer)
  const ambientMotion = new OutbreakAmbientMotion(renderer)
  const weatherController = new OutbreakWeatherController()
  const updateProfile = () => {
    avatar.profile =
      settings.humanProfile === 1
        ? zombieProfile(settings)
        : settings.humanProfile === 2
          ? { ...humanProfiles.soldier, runPosture: 0.34, crouchDepth: 0.095 }
          : undefined
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
        { label: "Crouch-run", value: 2 },
      ],
    },
    ...zombieControls,
    ...survivorAimControls,
    ...hudControls,
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
    {
      key: "dayNightLook",
      label: "Look & threat by hour",
      group: "Day cycle",
      options: [
        { label: "Dynamic (Day → Dusk → Noir)", value: 1 },
        { label: "Fixed preset", value: 0 },
      ],
    },
    {
      key: "infiniteAmmo",
      label: "Infinite ammo",
      group: "Combat",
      options: [
        { label: "Off", value: 0 },
        { label: "On", value: 1 },
      ],
    },
    { key: "cone", label: "Vision cone", group: "Vision", min: 60, max: 180, step: 1 },
    { key: "awareness", label: "Close awareness", group: "Vision", min: 0, max: 5, step: 0.1 },
    { key: "range", label: "Sight range", group: "Vision", min: 8, max: 40, step: 1 },
    { key: "shroud", label: "Explored shroud", group: "Vision", min: 0.02, max: 0.4, step: 0.01 },
    ...fogOfWarControls,
    { key: "lookPreset", label: "Style preset", group: "Look", options: LOOK_PRESET_IDS.map(id => ({ label: LOOK_PRESETS[id].label, value: id })) },
    ...outbreakLightingControls,
    { key: "zoom", label: "Camera distance", group: "View", min: 24, max: 65, step: 1 },
    { key: "houseSeed", label: "House seed", group: "Generation", min: 1, max: 32, step: 1 },
    { key: "terrain", label: "Terrain relief", group: "Generation", min: 0, max: 0.4, step: 0.02 },
    { key: "foliageDensity", label: "Foliage density", group: "Generation", min: 0.5, max: 1.5, step: 0.05 },
    {
      key: "houseDecay",
      label: "House decay",
      group: "Generation",
      options: [
        { label: "Auto (by seed)", value: 0 },
        { label: "Tidy", value: 1 },
        { label: "Abandoned", value: 2 },
        { label: "Ransacked", value: 3 },
        { label: "Barricaded", value: 4 },
      ],
    },
    { key: "weathering", label: "Weathering amount", group: "Generation", min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "weather", label: "Overcast", group: "Day cycle", min: 0, max: 1, step: 0.05 },
    ...outbreakWeatherControls,
    {
      key: "triggerWeatherLightning",
      label: "Trigger lightning strike",
      group: "Weather",
      type: "action",
      run: () => {
        weatherController.strikeNow()
      },
    },
    {
      key: "randomizeWeatherTuning",
      label: "Randomize weather",
      group: "Weather",
      type: "action",
      run: () => {
        randomizeOutbreakWeather(settings, settings.weatherTuningSeed)
        lab.refresh()
      },
    },
  ]
  const doorMesh = new Mesh()
  // Deep weathered walnut stiles & rails, 6 recessed craft panels, tarnished brass kickplate, and antique lockset
  doorMesh.box(0, 0.13, -0.09, 1.4, 2.3, 0.09, hex(0x322216), MAT.timber)
  doorMesh.box(0.07, 0.15, 0.09, 1.33, 0.32, 0.102, hex(0x6e5834), MAT.shiny)
  doorMesh.box(0.08, 0.35, -0.10, 1.32, 2.12, -0.092, hex(0x3e2b1c), MAT.timber)
  // Escutcheon backplate, brass knob & deadbolt cylinder
  doorMesh.box(1.13, 0.98, 0.09, 1.24, 1.28, 0.115, hex(0x4a3c24), MAT.shiny)
  doorMesh.box(1.15, 1.05, 0.115, 1.22, 1.13, 0.165, hex(0xc29e58), MAT.shiny)
  doorMesh.box(1.155, 1.19, 0.115, 1.215, 1.24, 0.14, hex(0xb89450), MAT.shiny)
  for (const x of [0.14, 0.74]) {
    for (const [y0, y1] of [[0.38, 0.98], [1.08, 1.66], [1.76, 2.14]] as const) {
      doorMesh.box(x, y0, 0.091, x + 0.50, y1, 0.112, hex(0x422e1e), MAT.timber)
      doorMesh.box(x + 0.04, y0 + 0.04, 0.113, x + 0.46, y1 - 0.04, 0.122, hex(0x23170e), MAT.timber)
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
  const lightingUniforms = new Float32Array(OUTBREAK_LIGHTING_UNIFORM_FLOATS)
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
    pollHolds(wallNow)
    const verbs = pendingVerbs
    pendingVerbs = {}
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
          ...(idx === 0 ? verbs : {}),
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
      if (key in DEFAULT_HUD_SETTINGS) hud.applySettings()
      if (key === "zombieCount") {
        session.ai.config.zombieCount = settings.zombieCount
        session.ai.syncPopulation(session.view.town, session.view.player.x, session.view.player.y)
      }
      if (key === "hour") {
        session.view.hour = wrapHour(settings.hour)
        if (settings.dayNightLook === 1 && settings.lookPreset === "noir") {
          lastDayNightHour = session.view.hour
          applyOutbreakDayNight(session.view.hour, lookSettings, settings)
          lab.refresh()
        }
      }
      if (key === "dayNightLook") {
        if (settings.dayNightLook === 1 && settings.lookPreset === "noir") {
          lastDayNightHour = session.view.hour
          applyOutbreakDayNight(session.view.hour, lookSettings, settings)
        } else {
          const pid = resolveLookPresetId(settings.lookPreset) ?? "noir"
          applyLookPreset(lookSettings, pid)
          Object.assign(settings, OUTBREAK_LOOK_LIGHTING_PRESETS[pid])
        }
        lab.refresh()
      }
      if (
        key === "houseSeed" ||
        key === "terrain" ||
        key === "foliageDensity" ||
        key === "houseDecay" ||
        key === "clutterDensity" ||
        key === "weathering" ||
        key === "clutterSeed"
      )
        regenerate()
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
        Object.assign(settings, OUTBREAK_LOOK_LIGHTING_PRESETS[pid])
        if (settings.dayNightLook === 1 && pid === "noir") {
          lastDayNightHour = session.view.hour
          applyOutbreakDayNight(session.view.hour, lookSettings, settings)
        }
        lab.refresh()
      }
      if (key === "weatherPreset") {
        applyOutbreakWeatherPreset(settings, settings.weatherPreset)
        lab.refresh()
      }
      if (key === "weatherEnabled") {
        if (settings.weatherEnabled && settings.weatherPreset === "clear" && settings.weatherIntensity <= 0.001) {
          applyOutbreakWeatherPreset(settings, "rain")
        } else if (!settings.weatherEnabled) {
          settings.weather = 0
        }
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
          if (args?.openDoor) {
            for (const d of session.view.town.doors) {
              if (d.id.startsWith("0-")) d.open = true
            }
            const bRects = sightRects(session.view.town)
            for (const [vx, vy, va] of [
              [30, 41, -1.57],
              [20, 35, -1.57],
              [20, 26, 0],
              [30, 21, 1.57],
              [38, 32, 3.14],
            ] as const) {
              vision.update(vx, vy, va, bRects, settings, null)
              scenery.update(session.view.town, vision)
            }
            renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
            session.view.revision++
          }
          peekBlend = 0
          lastPeek = null
          session.rebuildCollision()
          avatar.reset()
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
      {
        id: "hud.demo",
        label: "Show Character HUD Sample",
        shortLabel: "HUD Sample",
        category: "Scene",
        undoable: false,
        enabled: () => true,
        run: () => hud.demo(session.view.player),
      },
      {
        id: "weather.preset",
        label: "Set Outbreak Weather Preset",
        shortLabel: "Weather Preset",
        category: "Scene",
        undoable: false,
        args: {
          preset: {
            type: "string",
            required: true,
            description: "Weather preset ID (clear, drizzle, rain, storm, fog, snow)",
          },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const applied = applyOutbreakWeatherPreset(settings, String(args?.preset ?? "rain"))
          lab.refresh()
          draw(1 / 60)
          await device.queue.onSubmittedWorkDone()
          return { preset: settings.weatherPreset, enabled: settings.weatherEnabled, settings: applied }
        },
      },
      {
        id: "weather.strike",
        label: "Trigger Outbreak Lightning Strike",
        shortLabel: "Lightning Strike",
        category: "Scene",
        undoable: false,
        enabled: () => true,
        run: async () => {
          const strike = weatherController.strikeNow()
          draw(1 / 60)
          await device.queue.onSubmittedWorkDone()
          return { triggered: true, strike }
        },
      },
    ])
  })

  const keyLabels = keyLabelSetting("HUD")
  lab.addControls(keyLabels.settings, [keyLabels.control], keyLabels.defaults)
  lab.addControls(
    lookSettings as unknown as Record<string, string | number | boolean>,
    createLookControls(lookSettings, { includePresetPicker: false }).map(c => ({ ...c, folded: true })),
  )
  let vertices = 0
  function level() {
    session.view.town.foliageDensity = settings.foliageDensity
    archSettings.houseDecay = settings.houseDecay
    archSettings.clutterDensity = settings.clutterDensity
    archSettings.weathering = settings.weathering
    archSettings.clutterSeed = settings.clutterSeed
    const data = buildLevel(session.view.town)
    vertices = [...data.chunks, ...data.glass].reduce((n, c) => n + c.data.byteLength / 24, 0)
    renderer.setLevel(data)
    combatFx.setLevel(data)
  }
  function regenerate() {
    // A co-op room's neighbourhood is fixed by the room: only presentation settings rebuild the level.
    if (coop.net) return level()
    const previous = session.view
    session = new LocalSession(previous.town.seed, settings.houseSeed, settings.terrain, settings)
    Object.assign(session.view.player, previous.player)
    session.view.hour = previous.hour
    session.view.time = previous.time
    session.view.revision = previous.revision + 1
    session.view.town.doors.forEach((d, i) => {
      const prev = previous.town.doors[i]!
      d.open = prev.open
      if (prev.locked !== undefined) d.locked = prev.locked
      else delete d.locked
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
    if (session !== coop.net) session.close()
    session = makeSession(nextSeed)
    vision = new Vision()
    revision = -1
    peekBlend = 0
    lastPeek = null
    avatar.reset()
    zombieCrowd.reset()
    combatFx.reset()
    ambientMotion.reset()
    hud.reset()
    weatherController.reset(nextSeed)
    level()
    scenery = new SceneryMemory()
    combinedFog.reset()
    combinedFog.update(vision, scenery, true)
    renderer.setVisibility(combinedFog.filtered, FOG_SIZE, FOG_SIZE)
    cam.snap(session.view.player.x, session.view.player.y)
    cam.dist = settings.zoom
    pendingDrawDt = 0
    clock.reset(performance.now(), liveMove())
  }
  reset()
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  let lastNotice: { text: string; until: number } | null = null
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
    const notice = session.view.notices.splice(0).at(-1)
    if (notice) lastNotice = { text: notice.text, until: time + 3 }
    const lootText = p.lootMessage && time < p.lootMessageUntil ? ` · ${p.lootMessage}` : lastNotice && time < lastNotice.until ? ` · ${lastNotice.text}` : ""
    const weatherText =
      settings.weatherEnabled && settings.weatherPreset !== "clear"
        ? ` · ${WEATHER_PRESETS[settings.weatherPreset]?.label ?? settings.weatherPreset}`
        : ""
    return `${clockText(hour)}${weatherText}${weaponText}${plankText}${p.exhausted ? " · Exhausted" : ""}${alertText}${promptText}${lootText}`
  }
  const syncStatus = () => {
    if (hud.logMode) status.textContent = formatStatus()
    else {
      const weather =
        settings.weatherEnabled && settings.weatherPreset !== "clear"
          ? (WEATHER_PRESETS[settings.weatherPreset]?.label ?? settings.weatherPreset)
          : ""
      const summary = hud.summary(session.view, weather)
      if (summary !== null) status.textContent = summary
    }
  }
  onKeyLayoutChange(() => {
    syncStatus()
    inventoryHud.sync(session.view, cam, innerWidth, innerHeight)
  })
  await renderer.texturesReady
  syncTextures()
  let lastDayNightHour = -1
  function draw(dt: number) {
    if (settings.textures === 2) syncTextures()
    coop.net?.sync(dt)
    if (coop.localPalette !== avatarPalette) {
      avatarPalette = coop.localPalette
      avatar = avatarPalette ? new Survivor(renderer, coop.localPalette!) : avatar
      updateProfile()
    }
    const { player: p, town, hour, time, peek, zombies, noises, shots } = session.view
    settings.hour = Math.round(hour * 20) / 20
    if (settings.dayNightLook === 1 && settings.lookPreset === "noir" && Math.abs(hour - lastDayNightHour) > 1e-4) {
      lastDayNightHour = hour
      applyOutbreakDayNight(hour, lookSettings, settings)
    }
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
    const drawn = coop.pose(p)
    const camX = drawn.x + (activePeek ? activePeek.camOffsetX * peekBlend : 0)
    const camY = drawn.y + (activePeek ? activePeek.camOffsetY * peekBlend : 0)
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
    if (scenery.update(town, vision)) {
      combinedFog.markDirty()
      combinedFog.update(vision, scenery, true)
      renderer.setVisibility(combinedFog.filtered, FOG_SIZE, FOG_SIZE)
    }
    const frameLightOccluders = lightOccluders
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
    let flashlightSlot = -1
    const playerGroundY = supportHeight(town, p.x, p.y)
    const flashRgb = flashlightColor(settings.flashlightWarmth)
    if (p.flashlightOutput > 0.001 && settings.flashlightIntensity > 0.001) {
      const inBld = town.buildings.some(
        (b) => p.x > b.rect[0] - 0.1 && p.x < b.rect[2] + 0.1 && p.y > b.rect[1] - 0.1 && p.y < b.rect[3] + 0.1,
      )
      const fx = p.x + Math.cos(p.aim) * 0.25
      const fy = p.y + Math.sin(p.aim) * 0.25
      const fh = 1.34 + playerGroundY
      const cosHalf = Math.cos((settings.flashlightCone * Math.PI) / 360)
      const directScale = settings.practicalWarmth > 0.6 ? 0.28 : 1.35
      const power = p.flashlightOutput * settings.flashlightIntensity * directScale
      const effFlashRange = Math.min(settings.flashlightRange, inBld ? 5.2 : 6.4)
      flashlightSlot = count
      lights.set(
        [fx, fh, fy, effFlashRange, flashRgb[0], flashRgb[1], flashRgb[2], power, Math.cos(p.aim), Math.sin(p.aim), cosHalf, 1, 0, frameLightOccluders, 0.06, -1],
        count++ * LIGHT_FLOATS,
      )
    }
    count = coop.flashlights(lights, count, town, settings, lightOccluders)

    const lift = vaultLift(p)
    const survivorBatches = avatar.draw(drawn, dt, time, (x, z) => supportHeight(town, x, z) + lift, settings)
    const coopBatches = coop.bodies(dt, time, town, vision, settings)
    const zombieBatches = zombieCrowd.draw(
      zombies,
      dt,
      (x, z) => supportHeight(town, x, z),
      vision,
      view,
      settings,
      Boolean(settings.aiDebugOverlay),
      time,
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
    const inInteriorView = town.buildings.some(
      (b) => cutX > b.rect[0] - 0.1 && cutX < b.rect[2] + 0.1 && cutY > b.rect[1] - 0.1 && cutY < b.rect[3] + 0.1,
    )
    const unshadowedLamps: number[][] = []
    for (const [i, lamp] of town.lamps.entries()) {
      const resolved = resolveLampLight(lamp, town.buildings, day.lamps, settings, inInteriorView)
      lampPower[i] = resolved.fixtureBrightness
      if (resolved.power <= 0.001) continue
      const { lx, lh, ly, r, rEff, color, power, cone, softness, castShadows } = resolved
      const dCam = Math.hypot(lx - camX, ly - camY)
      if (dCam > (lamp.kind === "street" ? 15.5 : 16.5)) continue
      if (inInteriorView && !castShadows) continue
      if (lx + rEff < vx0 || lx - rEff > vx1 || ly + rEff < vy0 || ly - rEff > vy1 || !inLightFrustum(lx, ly, rEff)) continue
      if (lamp.kind === "room") {
        const b = town.buildings.find(
          (bld) => lamp.x >= bld.rect[0] && lamp.x <= bld.rect[2] && lamp.y >= bld.rect[1] && lamp.y <= bld.rect[3],
        )
        if (b) {
          const roofOpen =
            cutX > b.rect[0] - 0.1 && cutX < b.rect[2] + 0.1 && cutY > b.rect[1] - 0.1 && cutY < b.rect[3] + 0.1
          if (!roofOpen) continue
        }
      }
      const usePolarShadow = castShadows && lamp.kind === "room"
      const packed = [lx, lh, ly, r, ...color, power, ...cone, 0, usePolarShadow ? lightOccluders : 0, softness, i]
      if (usePolarShadow) {
        lights.set(packed, count++ * LIGHT_FLOATS)
      } else {
        unshadowedLamps.push(packed)
      }
    }
    const shadowLightCount = count
    for (const packed of unshadowedLamps) {
      if (count >= MAX_LIGHTS) break
      lights.set(packed, count++ * LIGHT_FLOATS)
    }
    const ambLum = (day.ambient[0] + day.ambient[1] + day.ambient[2]) * settings.skyFill * 0.333
    const weatherOut = weatherController.stepAndPrepare({
      dt,
      town,
      settings,
      viewProj: cam.viewProj,
      eye: cam.eye,
      playerX: p.x,
      playerY: p.y,
      playerGroundY,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      zoom: settings.zoom,
      lights,
      lightCount: count,
      ambientLum: ambLum,
    })
    const activeWeather = weatherOut.prepareInput
      ? {
          wetness: weatherOut.state.wetness,
          puddleCoverage: weatherOut.state.puddleCoverage,
          rippleIntensity: weatherOut.state.rippleIntensity,
          snowAmount: weatherOut.state.snowAmount,
        }
      : undefined
    packOutbreakLightingUniforms(
      {
        settings,
        playerX: p.x,
        playerY: p.y,
        playerH: playerGroundY,
        playerAim: p.aim,
        flashlightOutput: p.flashlightOutput,
        flashlightSlot,
        inInteriorView,
        streetHead: nearestStreetHead(camX, camY),
        zombies: nearestZombies(zombies, p.x, p.y),
        weather: activeWeather,
      },
      flashRgb,
      lightingUniforms,
    )
    packFoliageUniforms(foliageSettings, lightingUniforms, OUTBREAK_FOLIAGE_UNIFORM_OFFSET)
    packFoliageActors(foliageActors(p, zombies), lightingUniforms, OUTBREAK_FOLIAGE_UNIFORM_OFFSET + FOLIAGE_WIND_FLOATS)
    renderer.setCustomUniforms(lightingUniforms)
    frame.set(cam.viewProj, 0)
    frame.set([...cam.eye, time], 16)
    const texCfgBits =
      ((settings.textures & 3) >>> 0) |
      (((settings.rugStyle & 3) << 2) >>> 0) |
      (((settings.wallStyle & 3) << 4) >>> 0) |
      (((settings.floorStyle & 3) << 6) >>> 0) |
      ((Math.round((settings.texScale - 0.5) / 0.05) & 63) << 8) |
      ((Math.round(settings.texContrast / 0.05) & 63) << 14) |
      ((Math.round(settings.weathering * 5) & 15) << 20)
    frame.set([canvas.width, canvas.height, count, texCfgBits], 20)
    frame.set([cutX, cutY, cutFlag, cutRadius], 24)
    const lightningFlash = weatherOut.prepareInput ? weatherOut.state.flash : 0
    frame.set(
      [
        ...day.ambient.map((v) => v * settings.skyFill * (1 - settings.weather * 0.3) + lightningFlash * 0.16),
        day.strength * settings.moonFill * (1 - settings.weather * 0.85) + lightningFlash * 0.65,
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
    const fogSoundAlphaCount = collectFogSoundSprites(
      zombies,
      noises,
      p,
      vision,
      time,
      (x, z) => supportHeight(town, x, z),
      settings,
      alphaSprites,
      debugAlphaCount,
    )
    const tightView = cam.groundRect(0.8)
    const groundWearBatches = groundWear.collectBatches(town, tightView, settings)
    const clutterBatches = exteriorClutter.collectBatches(town, tightView, settings)
    const motionOut = ambientMotion.stepAndCollect(
      dt,
      time,
      town,
      p,
      tightView,
      settings,
      alphaSprites,
      fogSoundAlphaCount,
    )
    render.alphaCount = motionOut.alphaCount
    render.addCount = addCount
    render.splatter = combatFx.hasEmitted ? (combatFx.splatter ?? undefined) : undefined
    render.weather = weatherOut.prepareInput
    render.batches = [
      ...groundWearBatches,
      ...clutterBatches,
      ...motionOut.batches,
      ...survivorBatches,
      ...coopBatches,
      ...fxOut.batches,
      ...zombieBatches,
      doorBatch,
      ...(openWindows ? [sashBatch] : []),
    ]
    render.lightCount = count
    render.shadowLightCount = shadowLightCount
    render.occluderCount = frameLightOccluders
    render.lampCount = town.lamps.length
    render.view = view
    render.grade = [time, settings.diagnostic, lightningFlash * 0.35, settings.exposure]
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
    hud.update(dt, session.view, cam, w, h, settings.flashlightFlicker, coop.net?.id || "player", coop.hudRemotes(town, vision))
    syncStatus()
    coop.overlay(cam, w, h, town, vision)
    inventoryHud.sync(session.view, cam, w, h)
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
      if (renderer.inflight === 0 && rem <= 1.8) {
        channelPending = true
        paceChannel.port2.postMessage(null)
      } else {
        const waitMs = Math.max(1, Math.floor(rem - 1.6))
        pacerTimer = window.setTimeout(() => {
          pacerTimer = 0
          if (!frozen && !document.hidden && !channelPending) {
            channelPending = true
            paceChannel.port2.postMessage(null)
          }
        }, waitMs)
      }
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
    human: () => ({
      profile: avatar.profile,
      bones: avatar.bones,
      gun: avatar.gun,
      mag: avatar.mag,
      aimWeight: avatar.aimWeight,
      holdRemaining: avatar.holdRemaining,
    }),
    setLegacyPistol: (legacy: boolean) => {
      avatar.legacyUnarmedPistol = legacy
      avatar.reset()
    },
    setZoomRaw: (zoom: number) => {
      settings.zoom = zoom
      cam.dist = zoom
    },
    state: () => {
      const dc = dayCycle(session.view.hour)
      return {
        ...session.view,
        peekBlend,
        threat: dc.threat,
        darkness: dc.darkness,
        dayCycle: {
          hour: session.view.hour,
          phase: dc.phase,
          darkness: dc.darkness,
          threat: dc.threat,
          sun: dc.sun,
          twilight: dc.twilight,
          lamps: dc.lamps,
        },
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
      ground: {
        wearAmount: settings.wearAmount,
        curbDirt: settings.curbDirt,
        puddleWetness: settings.puddleWetness,
        clutterDensity: settings.clutterDensity,
        rubbleAmount: settings.rubbleAmount,
        motionStrength: settings.motionStrength,
        windGustiness: settings.windGustiness,
        clutterSeed: settings.clutterSeed,
        groundTuningSeed: settings.groundTuningSeed,
      },
      weather: {
        enabled: settings.weatherEnabled,
        preset: settings.weatherPreset,
        settings: toSharedWeatherSettings(settings),
        state: { ...weatherController.sim.state },
      },
      }
    },
    fog: (x: number, y: number) => vision.state(x, y),
    callouts: () =>
      hud.layer.model.items.map((c) => ({ actor: c.actorId, text: c.text, kind: c.kind, slot: c.slot, progress: c.progress })),
    coop: () => coop.inspect(),
    hudState: () => hud.inspect(),
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
      if (key in DEFAULT_HUD_SETTINGS) hud.applySettings()
      if (key === "zombieCount") {
        session.ai.config.zombieCount = Number(settings.zombieCount)
        session.ai.syncPopulation(session.view.town, session.view.player.x, session.view.player.y)
      }
      if (key === "hour" && typeof value === "number") {
        session.view.hour = wrapHour(value)
        if (settings.dayNightLook === 1 && settings.lookPreset === "noir") {
          lastDayNightHour = session.view.hour
          applyOutbreakDayNight(session.view.hour, lookSettings, settings)
          lab.refresh()
        }
      }
      if (key === "dayNightLook") {
        if (settings.dayNightLook === 1 && settings.lookPreset === "noir") {
          lastDayNightHour = session.view.hour
          applyOutbreakDayNight(session.view.hour, lookSettings, settings)
        } else {
          const pid = resolveLookPresetId(settings.lookPreset) ?? "noir"
          applyLookPreset(lookSettings, pid)
          Object.assign(settings, OUTBREAK_LOOK_LIGHTING_PRESETS[pid])
        }
        lab.refresh()
      }
      if (
        key === "houseSeed" ||
        key === "terrain" ||
        key === "foliageDensity" ||
        key === "houseDecay" ||
        key === "clutterDensity" ||
        key === "weathering" ||
        key === "clutterSeed"
      )
        regenerate()
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
        Object.assign(settings, OUTBREAK_LOOK_LIGHTING_PRESETS[pid])
        if (settings.dayNightLook === 1 && pid === "noir") {
          lastDayNightHour = session.view.hour
          applyOutbreakDayNight(session.view.hour, lookSettings, settings)
        }
        lab.refresh()
      }
      if (key === "weatherPreset") {
        applyOutbreakWeatherPreset(settings, String(value))
        lab.refresh()
      }
      if (key === "weatherEnabled") {
        if (settings.weatherEnabled && settings.weatherPreset === "clear" && settings.weatherIntensity <= 0.001) {
          applyOutbreakWeatherPreset(settings, "rain")
        } else if (!settings.weatherEnabled) {
          settings.weather = 0
        }
        lab.refresh()
      }
    },
    setWeatherPreset(preset: string) {
      const applied = applyOutbreakWeatherPreset(settings, preset)
      lab.refresh()
      return applied
    },
    strikeLightning(seed?: number) {
      return weatherController.strikeNow(seed)
    },
    setLookPreset(preset: LookPresetId | string) {
      const pid = resolveLookPresetId(preset)
      if (!pid) throw new Error(`Unknown look preset: ${preset}`)
      settings.lookPreset = pid
      applyLookPreset(lookSettings, pid)
      Object.assign(settings, OUTBREAK_LOOK_LIGHTING_PRESETS[pid])
      if (settings.dayNightLook === 1 && pid === "noir") {
        lastDayNightHour = session.view.hour
        applyOutbreakDayNight(session.view.hour, lookSettings, settings)
      }
      lab.refresh()
      return { ...lookSettings }
    },
    setLook(patch: Partial<LookSettings>) {
      Object.assign(lookSettings, patch)
      if (patch.preset) settings.lookPreset = patch.preset
      lastDayNightHour = session.view.hour
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
      avatar.reset()
      cam.snap(x, y)
      cam.dist = settings.zoom
    },
    /** Sets loaded rounds and, optionally, belt counts (`{ ammo: 4, plank: 3 }`) through the progression ledger. */
    stock(loaded?: number, belt: Record<string, number> = {}) {
      const { progression, actorId } = session.view
      const ledger = progression.ledger
      if (loaded !== undefined) ledger.apply({ kind: "setCharge", actor: actorId, item: "pistol", charge: loaded })
      for (const [item, n] of Object.entries(belt)) {
        const have = ledger.count(`${actorId}/belt`, item)
        if (have) ledger.apply({ kind: "drain", store: `${actorId}/belt`, item, count: have })
        if (n) ledger.apply({ kind: "grant", actor: actorId, item, count: n })
      }
      const slot = session.sim.slot(actorId)
      if (slot) progression.project(slot)
    },
    /** Gives the local survivor an item, routed to belt, hand or pack. */
    give(item: string, count = 1) {
      return session.view.progression.ledger.apply({ kind: "grant", actor: session.view.actorId, item, count }).ok
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
      while (renderer.inflight > 0 || renderer.hasPending) {
        await Promise.resolve()
        await device.queue.onSubmittedWorkDone()
      }
      session.update(
        dt,
        { mx: 0, my: 0, aim: session.view.player.aim, interact: false, ...command },
        settings.timeScale,
        settings,
      )
      frames++
      draw(dt)
      await Promise.resolve()
      while (renderer.inflight > 0 || renderer.hasPending) {
        await device.queue.onSubmittedWorkDone()
        await Promise.resolve()
      }
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
