import { Camera } from "@arcade/kit/client/camera"
import { keyLabel, keyLabelSetting, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { Input } from "@arcade/kit/client/input"
import { LabPanel } from "@arcade/kit/lab-panel"
import {
  createLookControls,
  createLookSettings,
  type LookCompareMode,
} from "@arcade/kit/look"
import { Renderer, SPRITE_FLOATS, type Batch, type FrameInput } from "@arcade/kit/gpu/renderer"
import { FRAME_FLOATS } from "@arcade/kit/gpu/shaders"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS } from "@arcade/kit/gpu/limits"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { raycast } from "@arcade/kit/sim/geom"
import { mat4 } from "wgpu-matrix"
import { FOLIAGE_WIND_FLOATS, foliageSettings, nearestFoliageActors, packFoliageActors, packFoliageUniforms } from "@arcade/kit/gpu/foliage"
import { LocalSession, type Command } from "../shared/session"
import { MELEE_WEAPONS } from "../shared/combat"
import { flashlightColor } from "../shared/flashlight"
import { HOLD_DURATION, vaultLift, type PeekInfo } from "../shared/interact"
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
  collectFogSoundSprites,
} from "./fog-of-war"
import { applyOutbreakDayNight } from "./day-night"
import { GroundWearRenderer, packGroundCfgBits } from "./ground"
import { buildLevel, hex } from "./level"
import { archSettings } from "./architecture"
import { WorldClientStreamer } from "./world-streamer"
import {
  BEAM_QUALITY_TIERS,
  OUTBREAK_FOLIAGE_UNIFORM_OFFSET,
  OUTBREAK_LIGHTING_UNIFORM_FLOATS,
  packOutbreakLightingUniforms,
  resolveLampLight,
  STREET_LAMP_POSTS,
  streetLampHead,
} from "./lighting"
import { humanProfiles } from "@arcade/kit/human-profile"
import { Survivor } from "./survivor"
import { OutbreakHud } from "./hud"
import { OutbreakAudio, pursuers, soundWorld } from "./audio"
import { InventoryHud } from "./inventory-hud"
import { type ProgressionLabHost } from "./progression-lab"
import { type VehicleLabHost } from "./vehicle-lab"
import { OutbreakVehicleAudio } from "./vehicle-audio"
import { OutbreakVehicleRenderer } from "./vehicles"
import { SURVIVOR_COLOURS } from "./net-session"
import { WEATHER_PRESETS } from "@arcade/kit/weather"
import { OutbreakWeatherController } from "./weather"
import { CoopView } from "./coop-view"
import type { NetSession } from "./net-session"
import { ZombieCrowdRenderer } from "./zombies"
import { beamPose, beamScreenRect, beamWeatherAir } from "./flashlight-beam"
import { zombieProfile } from "./zombie-profile"
import {
  bindOutbreakLabControls,
  createOutbreakSettings,
  migrateOutbreakLocalStorage,
  resolveWorldMode,
} from "./settings"
import { OutbreakFeelTracker } from "./feel-events"
import { registerOutbreakGameCommands } from "./game-commands"
import { createOutbreakHarness } from "./harness"
import { buildOutbreakLabControls, handleOutbreakSettingChanged, type OutbreakLabControlHost } from "./lab-controls"
import { shaders } from "./shaders"
import "./style.css"

/** Player first, then the nearest living zombies: grass and bushes bend away from them (presentation only). */
function foliageActors(p: { x: number; y: number }, zombies: readonly { x: number; y: number; state: string }[]) {
  return nearestFoliageActors(p.x, p.y, zombies.filter((z) => z.state !== "dead").map((z) => ({ x: z.x, z: z.y })))
}

const params = new URLSearchParams(location.search)
const lookSettings = createLookSettings("noir")
const lookCompare: { mode: LookCompareMode; wipeSplit: number } = { mode: 1, wipeSplit: 0.5 }
try {
  migrateOutbreakLocalStorage(localStorage)
} catch {}
const settings = createOutbreakSettings(params)

const streetHeads = STREET_LAMP_POSTS.map(streetLampHead)
function nearestStreetHead(x: number, y: number, isStream = false): readonly [number, number, number] {
  const bx = isStream ? Math.floor(x / SIZE) * SIZE : 0
  const bz = isStream ? Math.floor(y / SIZE) * SIZE : 0
  let best = streetHeads[0]!
  for (const head of streetHeads) {
    if (Math.hypot(bx + head[0] - x, bz + head[2] - y) < Math.hypot(bx + best[0] - x, bz + best[2] - y)) best = head
  }
  return isStream ? [bx + best[0], best[1], bz + best[2]] : best
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
  const hud = new OutbreakHud(document.body, settings.hud)
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
  const makeSession = (s: number) =>
    coop.net ??
    new LocalSession(
      s,
      settings.world.houseSeed,
      settings.world.terrain,
      settings.ai,
      settings.progression,
      resolveWorldMode(settings.world.worldMode),
    )
  let session: LocalSession | NetSession = makeSession(seed)
  coop.companions = () => {
    const s = session
    return s instanceof LocalSession ? s.sim.slots.filter((slot) => slot !== s.slot) : []
  }
  let vision = new Vision()
  let scenery = new SceneryMemory()
  const combinedFog = new CombinedFogMemory()
  const worldStreamer = new WorldClientStreamer()
  let currentWindowOrigin: [number, number] = [0, 0]
  let currentIsStreamWindow = false
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
  const cam = new Camera(settings.view)
  const audio = new OutbreakAudio(settings.audio, {
    baseUrl: new URL("./audio-assets/", document.baseURI).href,
    storage: (() => { try { return localStorage } catch { return null } })(),
    automated: navigator.webdriver,
  })
  audio.arm()
  const footfall = (x: number, y: number, speed: number) => audio.footstep(x, y, speed)
  coop.onFootfall = footfall
  let avatar = new Survivor(renderer)
  avatar.onFootfall = footfall
  let avatarPalette: object | null = null
  const zombieCrowd = new ZombieCrowdRenderer(renderer)
  zombieCrowd.onFootfall = (id, x, y, speed, drag, variant) => audio.zombieFootstep(id, x, y, speed, drag, variant)
  const combatFx = new OutbreakCombatFX(renderer)
  const feelTracker = new OutbreakFeelTracker(cam, settings, session.view.player)
  const { hitStop, motionBurst } = feelTracker
  const groundWear = new GroundWearRenderer(renderer)
  const exteriorClutter = new ExteriorClutterRenderer(renderer)
  const ambientMotion = new OutbreakAmbientMotion(renderer)
  const weatherController = new OutbreakWeatherController()
  const vehicleRenderer = new OutbreakVehicleRenderer(renderer, document.body)
  const vehicleAudio = new OutbreakVehicleAudio(audio)
  vehicleRenderer.onPop = (v) => vehicleAudio.pop(v.id)
  vehicleRenderer.onCrash = (_v, impact) => {
    cam.impact(impact)
  }
  vehicleRenderer.onBang = () => {
    cam.bump(0.32)
  }
  const updateProfile = () => {
    avatar.profile =
      settings.zombies.humanProfile === 1
        ? zombieProfile(settings.zombies)
        : settings.zombies.humanProfile === 2
          ? { ...humanProfiles.soldier, runPosture: 0.34, crouchDepth: 0.095 }
          : undefined
  }
  const progressionHost: ProgressionLabHost = {
    view: () => session.view,
    pose: (x, y, aim) => harness.pose(x, y, aim),
    setHour: (hour) => {
      settings.dayCycle.hour = hour
      session.view.hour = wrapHour(hour)
    },
    hud: inventoryHud,
    offline: () => !coop.net,
  }
  const vehicleHost: VehicleLabHost = {
    sim: () => session.sim,
    view: () => session.view,
    pose: (x, y, aim) => harness.pose(x, y, aim),
    setHour: (hour) => {
      settings.dayCycle.hour = hour
      session.view.hour = wrapHour(hour)
    },
    offline: () => !coop.net,
  }
  const labControlHost: OutbreakLabControlHost = {
    session: () => session,
    settings,
    lookSettings,
    lab: () => lab,
    feelTracker,
    combatFx,
    weatherController,
    progressionHost,
    vehicleHost,
    hud,
    updateProfile,
    regenerate: () => regenerate(),
    syncTextures: () => syncTextures(),
    setLastDayNightHour: (hour) => {
      lastDayNightHour = hour
    },
  }
  const controls = buildOutbreakLabControls(labControlHost)
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
  const doorData = new Float32Array(64 * 12)
  const doorBatch: Batch = { model: doorModel, data: doorData, count: 0 }
  const sashMesh = new Mesh()
  sashMesh.box(-1.0, 1.48, -0.06, 1.0, 2.12, 0.06, hex(0xa8a99c), MAT.wall)
  sashMesh.box(-0.92, 1.54, -0.02, 0.92, 2.06, 0.02, hex(0x809c9e), MAT.glass)
  const sashModel = renderer.addModel(sashMesh)
  const sashData = new Float32Array(64 * 12)
  const sashBatch: Batch = { model: sashModel, data: sashData, count: 0 }
  let peekBlend = 0
  let lastPeek: PeekInfo | null = null
  const frame = new Float32Array(FRAME_FLOATS)
  const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  const occluders = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  const lampPower = new Float32Array(MAX_LIGHTS)
  const lightingUniforms = new Float32Array(OUTBREAK_LIGHTING_UNIFORM_FLOATS)
  const flashlightBounce: [number, number] = [0, 0]
  const flashlightOrigin: [number, number] = [0, 0]
  const invViewProj = new Float32Array(16)
  let lastSightX = -1e3
  let lastSightY = -1e3
  let fieldWindowX = 0
  let fieldWindowY = 0
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
    const seatEdge = input.takeSeat()
    const hornHeld = input.held("KeyH")
    const spaceHeld = Boolean(session.view.player.vehicleId) && input.held("Space")
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
          sprint: step.sprint || spaceHeld,
          aim: Math.atan2(target.y - p.y, target.x - p.x),
          interact: step.interact,
          flashlight: step.flashlight,
          jump: step.jump,
          interactHeld: step.interactHeld,
          fire: idx === 0 ? fireEdge : false,
          fireHeld: input.firing,
          reload: idx === 0 ? reloadEdge : false,
          melee: idx === 0 ? meleeEdge : false,
          barricade: idx === 0 ? barricadeEdge : false,
          ...(idx === 0 && seatEdge ? { seat: true } : {}),
          ...(hornHeld ? { horn: true } : {}),
          ...(idx === 0 ? verbs : {}),
          ...(idx === 0 && hotbarSlot !== undefined ? { hotbarSlot } : {}),
          ...(idx === 0 && hotbarDelta !== 0 ? { hotbarDelta } : {}),
        },
        settings.dayCycle.timeScale,
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
      enabled: settings.materials.textures,
      globalScale: settings.materials.texScale,
      globalContrast: settings.materials.texContrast,
      globalRoughness: settings.materials.texRoughness,
      rugStyle: settings.materials.rugStyle,
      wallStyle: settings.materials.wallStyle,
      floorStyle: settings.materials.floorStyle,
      splitX: session.view.player.x,
    })
  }
  const onSettingChanged = (rawKey: string, value?: number | boolean | string) =>
    handleOutbreakSettingChanged(labControlHost, rawKey, value)
  const lab = new LabPanel(
    {},
    [],
    params,
    () => {
      input.release()
      clock.pause(performance.now())
    },
    (key, value) => onSettingChanged(key, value),
  )
  bindOutbreakLabControls(lab, settings, controls)

  registerOutbreakGameCommands({
    device,
    renderer,
    session: () => session,
    vision: () => vision,
    scenery: () => scenery,
    avatar: () => avatar,
    cam,
    input,
    settings,
    feelTracker,
    hud,
    coop,
    lab,
    progressionHost,
    vehicleHost,
    weatherController,
    harness: () => harness,
    resetPeek: () => {
      peekBlend = 0
      lastPeek = null
    },
    draw: (dt) => draw(dt),
  })

  const keyLabels = keyLabelSetting("HUD")
  lab.addControls(keyLabels.settings, [keyLabels.control], keyLabels.defaults)
  lab.addControls(
    lookSettings as unknown as Record<string, string | number | boolean>,
    createLookControls(lookSettings, { includePresetPicker: false }).map(c => ({ ...c, folded: true })),
  )
  let vertices = 0
  function level() {
    session.view.town.foliageDensity = settings.world.foliageDensity
    archSettings.houseDecay = settings.world.houseDecay
    archSettings.clutterDensity = settings.ground.clutterDensity
    archSettings.weathering = settings.world.weathering
    archSettings.clutterSeed = settings.ground.clutterSeed
    const mode = resolveWorldMode(settings.world.worldMode)
    session.sim.worldStream.mode = mode
    const p = session.view.player
    const inOriginBox = p.x >= 10 && p.x <= 86 && p.y >= 10 && p.y <= 86
    if (mode !== "procedural" && inOriginBox && session.sim.worldStream.isOriginNineOnly()) {
      currentWindowOrigin = [0, 0]
      currentIsStreamWindow = false
      worldStreamer.center = { cx: 1, cy: 1 }
      worldStreamer.windowOrigin = [0, 0]
      worldStreamer.lastWindowKey = ""
      const data = buildLevel(session.view.town)
      vertices = [...data.chunks, ...data.glass].reduce((n, c) => n + c.data.byteLength / 24, 0)
      renderer.setLevel(data)
      combatFx.setLevel(data)
      return
    }
    worldStreamer.lastWindowKey = ""
    const streamed = worldStreamer.updateWindow(p.x, p.y, session.view.town, mode)
    currentWindowOrigin = streamed.origin
    currentIsStreamWindow = true
    if (streamed.level) {
      vertices = [...streamed.level.chunks, ...streamed.level.glass].reduce((n, c) => n + (c.byteLength ?? c.data.byteLength) / 24, 0)
      renderer.setLevel(streamed.level)
      combatFx.setLevel(streamed.level)
    }
  }
  function regenerate() {
    // A co-op room's neighbourhood is fixed by the room: only presentation settings rebuild the level.
    if (coop.net) return level()
    const previous = session.view
    session = new LocalSession(
      previous.town.seed,
      settings.world.houseSeed,
      settings.world.terrain,
      settings.ai,
      settings.progression,
      resolveWorldMode(settings.world.worldMode),
    )
    Object.assign(session.view.player, previous.player)
    session.view.hour = previous.hour
    session.view.time = previous.time
    session.view.revision = previous.revision + 1
    session.view.town.doors.forEach((d, i) => {
      const prev = previous.town.doors[i]
      if (!prev) return
      d.open = prev.open
      if (prev.locked !== undefined) d.locked = prev.locked
      else delete d.locked
    })
    session.view.town.windows.forEach((w, i) => {
      const prev = previous.town.windows[i]
      if (!prev) return
      w.open = prev.open
      w.openable = prev.openable
    })
    session.rebuildCollision()
    revision = -1
    level()
    avatar.reset()
    zombieCrowd.reset()
    combatFx.reset()
    ambientMotion.reset()
    vehicleRenderer.reset()
  }
  function reset(nextSeed = seed) {
    if (session !== coop.net) session.close()
    session = makeSession(nextSeed)
    vision = new Vision()
    worldStreamer.reset()
    currentWindowOrigin = [0, 0]
    currentIsStreamWindow = false
    revision = -1
    peekBlend = 0
    lastPeek = null
    avatar.reset()
    zombieCrowd.reset()
    combatFx.reset()
    vehicleRenderer.reset()
    feelTracker.reset(session.view.player)
    ambientMotion.reset()
    hud.reset()
    weatherController.reset(nextSeed)
    level()
    scenery = new SceneryMemory()
    combinedFog.reset()
    combinedFog.update(vision, scenery, true)
    renderer.setVisibility(combinedFog.filtered, FOG_SIZE, FOG_SIZE)
    renderer.clearVisibilityField()
    lastSightX = lastSightY = -1e3
    cam.snap(session.view.player.x, session.view.player.y)
    cam.dist = settings.view.zoom
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
          : p.meleeWeapon
            ? ` · ${MELEE_WEAPONS[p.meleeWeapon].shortLabel} ${p.meleeDurability}/${p.meleeMaxDurability}`
            : ""
    const plankText = p.planks > 0 ? ` · ${p.planks}🪵` : ""
    const alerted = zombies.filter((z) => z.state === "chase" || z.state === "alert" || z.state === "bash").length
    const alertText = alerted > 0 ? ` · ${alerted} pursuing` : ""
    const notice = session.view.notices.splice(0).at(-1)
    if (notice) lastNotice = { text: notice.text, until: time + 3 }
    const lootText = p.lootMessage && time < p.lootMessageUntil ? ` · ${p.lootMessage}` : lastNotice && time < lastNotice.until ? ` · ${lastNotice.text}` : ""
    const weatherText =
      settings.weather.weatherEnabled && settings.weather.weatherPreset !== "clear"
        ? ` · ${WEATHER_PRESETS[settings.weather.weatherPreset]?.label ?? settings.weather.weatherPreset}`
        : ""
    return `${clockText(hour)}${weatherText}${weaponText}${plankText}${p.exhausted ? " · Exhausted" : ""}${alertText}${promptText}${lootText}`
  }
  const syncStatus = () => {
    if (hud.logMode) status.textContent = formatStatus()
    else {
      const weather =
        settings.weather.weatherEnabled && settings.weather.weatherPreset !== "clear"
          ? (WEATHER_PRESETS[settings.weather.weatherPreset]?.label ?? settings.weather.weatherPreset)
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
    if (settings.materials.textures === 2) syncTextures()
    coop.net?.sync(dt)
    if (coop.localPalette !== avatarPalette) {
      avatarPalette = coop.localPalette
      avatar = avatarPalette ? new Survivor(renderer, coop.localPalette!) : avatar
      avatar.onFootfall = footfall
      updateProfile()
    }
    const { player: p, town, hour, time, peek, zombies, noises } = session.view
    settings.dayCycle.hour = Math.round(hour * 20) / 20
    if (settings.dayCycle.dayNightLook === 1 && settings.dayCycle.lookPreset === "noir" && Math.abs(hour - lastDayNightHour) > 1e-4) {
      lastDayNightHour = hour
      applyOutbreakDayNight(hour, lookSettings, settings)
    }
    const playerGroundY = supportHeight(town, p.x, p.y)

    let addCount = feelTracker.processFrame(
      session,
      combatFx,
      zombieCrowd,
      addSprites,
      playerGroundY,
      dt,
    )

    const vdt = hitStop.step(dt, !cam.isReducedMotion())
    motionBurst.step(dt, settings.motion.burstDecay)
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
    const localVehicle = session.sim.vehicles.vehicleOf(p)
    const vehSpeed = localVehicle ? Math.hypot(localVehicle.vx, localVehicle.vy) : 0
    const speedPullback = localVehicle
      ? (vehSpeed / Math.max(1, localVehicle.spec.maxSpeed)) * settings.vehicle.cameraSpeedZoom
      : 0
    cam.zoomOffset = settings.view.zoom - 24 + speedPullback
    const drawn = coop.pose(p)
    const camX = drawn.x + (activePeek ? activePeek.camOffsetX * peekBlend : 0)
    const camY = drawn.y + (activePeek ? activePeek.camOffsetY * peekBlend : 0)
    const lookAheadX = localVehicle ? localVehicle.vx * 0.22 : 0
    const lookAheadY = localVehicle ? localVehicle.vy * 0.22 : 0
    cam.follow(camX, camY, lookAheadX, lookAheadY, dt, false, Boolean(localVehicle))
    cam.update(w / h)
    const mode = resolveWorldMode(settings.world.worldMode)
    session.sim.worldStream.mode = mode
    if (mode !== "classic") {
      const inOriginBox = p.x >= 10 && p.x <= 86 && p.y >= 10 && p.y <= 86
      if (mode !== "procedural" && !currentIsStreamWindow && inOriginBox && session.sim.worldStream.isOriginNineOnly()) {
        // Pre-warm upcoming border chunks incrementally while inside the origin block
        worldStreamer.prewarmAround(
          p.x,
          p.y,
          town.seed,
          town.houseSeed,
          town.terrain,
          town.foliageDensity ?? 1,
          mode,
          vehSpeed,
        )
        worldStreamer.stepBakeQueue(1.8)
      } else {
        const streamed = worldStreamer.updateWindow(p.x, p.y, town, mode, vehSpeed)
        currentWindowOrigin = streamed.origin
        currentIsStreamWindow = true
        if (streamed.changed && streamed.level) {
          vertices = [...streamed.level.chunks, ...streamed.level.glass].reduce((n, c) => n + (c.byteLength ?? c.data.byteLength) / 24, 0)
          renderer.setLevel(streamed.level)
          combatFx.setLevel(streamed.level)
          vision.setWindowOrigin(streamed.origin[0], streamed.origin[1])
          scenery.setWindowOrigin(streamed.origin[0], streamed.origin[1], town)
          combinedFog.markDirty()
        }
      }
    }
    if (revision !== session.view.revision) {
      revision = session.view.revision
      blockers = sightRects(town)
      occluders.fill(0)
      const maxOcc = MAX_OCCLUDERS - 4
      let occIdx = 0
      for (let i = 0; i < blockers.length && occIdx < maxOcc; i++) {
        occluders.set([...blockers[i]!, 2.8, 0, 0, 0], occIdx++ * OCC_FLOATS)
      }
      lightOccluders = occIdx
      for (const b of town.barriers) {
        if (b.kind === "window" && lightOccluders < maxOcc) {
          occluders.set([...b.rect, 0.85, 0, 0, 0], lightOccluders++ * OCC_FLOATS)
        }
      }
      for (const pr of town.props) {
        if (pr.kind === "coffee" || pr.kind === "table" || pr.kind === "chair" || pr.kind === "nightstand") continue
        if (lightOccluders >= maxOcc) break
        const s = propShape(pr)
        if (s) occluders.set([...s.rect, s.height, 0, 0, 0], lightOccluders++ * OCC_FLOATS)
      }
    }
    const drivingHeadlights =
      Boolean(localVehicle && (p.seatIndex ?? 0) === 0 && localVehicle.headlights && localVehicle.hasBattery && !localVehicle.wreck)
    const effectiveVisionAim = drivingHeadlights && localVehicle ? localVehicle.h : p.aim
    const effectiveVisionSettings = drivingHeadlights
      ? {
          ...settings.vision,
          range: Math.max(settings.vision.range, settings.vehicle.headlightRange + 4),
          cone: Math.max(settings.vision.cone, 130),
        }
      : settings.vision
    const visChanged = vision.update(p.x, p.y, effectiveVisionAim, blockers, effectiveVisionSettings, peek)
    if (scenery.update(town, vision) || visChanged) {
      combinedFog.markDirty()
      combinedFog.update(vision, scenery, true)
      renderer.setVisibility(combinedFog.filtered, FOG_SIZE, FOG_SIZE)
    }
    // The flashlight also sees actors as round casters, so zombies and other survivors cut its pool and its shaft.
    let frameLightOccluders = lightOccluders
    if (p.flashlightOutput > 0.001) {
      const casters = (x: number, y: number) => {
        if (frameLightOccluders >= MAX_OCCLUDERS - 4 || frameLightOccluders - lightOccluders >= 16) return
        if (Math.hypot(x - p.x, y - p.y) > settings.flashlight.flashlightRange) return
        occluders.set([x, y, 0.27, 0, 1.72, 1, 0, 0], frameLightOccluders++ * OCC_FLOATS)
      }
      for (const z of zombies) if (z.state !== "dead") casters(z.x, z.y)
      for (const o of coop.otherPositions()) casters(o[0], o[1])
    }
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
    const sightAim = peek ? peek.aim : effectiveVisionAim
    const sightCone = activePeek
      ? effectiveVisionSettings.cone + (Math.max(effectiveVisionSettings.cone, activePeek.cone) - effectiveVisionSettings.cone) * peekBlend
      : effectiveVisionSettings.cone
    const sightAwareness = activePeek
      ? effectiveVisionSettings.awareness + (Math.max(effectiveVisionSettings.awareness, activePeek.awareness) - effectiveVisionSettings.awareness) * peekBlend
      : effectiveVisionSettings.awareness
    lights.set([
      sightX,
      1.65 + supportHeight(town, p.x, p.y),
      sightY,
      effectiveVisionSettings.range,
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
    // Pose the bodies first: the flashlight rides the survivor's pistol or hand.
    const lift = vaultLift(p)
    const riderSink = localVehicle ? (localVehicle.spec.seats[p.seatIndex ?? 0]?.sink ?? 0.48) : 0
    const survivorBatches = avatar.draw(
      localVehicle ? { ...drawn, vx: 0, vy: 0 } : drawn,
      vdt,
      time,
      (x, z) => supportHeight(town, x, z) + lift - riderSink,
      settings.survivor,
    )
    const coopBatches = coop.bodies(vdt, time, town, vision, settings.survivor)
    let flashlightHeight = 1.34 + playerGroundY
    let flashlightAirLimit = 0
    let flashlightYaw = p.aim
    let beamReach = 0
    let flashlightPitch: number | undefined
    let flashlightBounceHeight = playerGroundY + 0.3
    const flashRgb = flashlightColor(settings.flashlight.flashlightWarmth)
    const beamAim = drivingHeadlights && localVehicle ? localVehicle.h : p.aim
    const beamRange = drivingHeadlights ? settings.vehicle.headlightRange : settings.flashlight.flashlightRange
    const beamOutput = drivingHeadlights ? 1.0 : p.flashlightOutput
    const beamIntensity = drivingHeadlights
      ? settings.vehicle.headlightPower * 0.85
      : settings.flashlight.flashlightIntensity
    if (beamOutput > 0.001 && beamIntensity > 0.001) {
      // Lens and direction from the posed rig on foot, or the vehicle front fascia when driving with headlights on.
      const beam =
        drivingHeadlights && localVehicle
          ? {
              x: localVehicle.x + Math.cos(beamAim) * (localVehicle.spec.length * 0.48),
              y: localVehicle.y + Math.sin(beamAim) * (localVehicle.spec.length * 0.48),
              h: 0.72 + playerGroundY,
              yaw: beamAim,
              pitch: -0.18,
            }
          : beamPose(avatar.light, p.x, p.y, p.aim, playerGroundY, settings.flashlight.beamPoolDistance, blockers)
      const fx = beam.x
      const fy = beam.y
      const fh = beam.h
      const dx = Math.cos(beam.yaw)
      const dy = Math.sin(beam.yaw)
      const cosHalf = Math.cos(((drivingHeadlights ? 68 : settings.flashlight.flashlightCone) * Math.PI) / 360)
      // cone.w 2: the scene's flashAttenuation shapes the 3D beam; rain and smoke still read the plan cone.
      const power = beamOutput * beamIntensity
      flashlightSlot = count
      flashlightHeight = fh
      flashlightOrigin[0] = fx
      flashlightOrigin[1] = fy
      flashlightYaw = beam.yaw
      flashlightPitch = beam.pitch
      const wall = raycast(fx, fy, dx, dy, blockers, beamRange)
      const reach = Math.max(0.5, (fh - playerGroundY) / Math.max(0.05, Math.tan(-beam.pitch)))
      const hit = Math.min(wall, reach, beamRange)
      flashlightBounce[0] = fx + dx * Math.max(0.3, hit - 0.15)
      flashlightBounce[1] = fy + dy * Math.max(0.3, hit - 0.15)
      flashlightAirLimit = wall
      beamReach = Math.min(beamRange, wall + 1.5, 13)
      flashlightBounceHeight = playerGroundY + (wall < reach ? 0.9 : 0.3)
      lights.set(
        [fx, fh, fy, beamRange, flashRgb[0], flashRgb[1], flashRgb[2], power, dx, dy, cosHalf, 2, 0, frameLightOccluders, 0.06, -1],
        count++ * LIGHT_FLOATS,
      )
    }
    count = coop.flashlights(lights, count, town, settings, lightOccluders, blockers)

    const zombieBatches = zombieCrowd.draw(
      zombies,
      vdt,
      (x, z) => supportHeight(town, x, z),
      vision,
      view,
      settings.zombies,
      Boolean(settings.ai.aiDebugOverlay),
      time,
    )

    const fxOut = combatFx.stepAndCollect(
      vdt,
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
      const resolved = resolveLampLight(lamp, town.buildings, day.lamps, settings.lighting, inInteriorView)
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
    let shadowLightCount = count
    for (const packed of unshadowedLamps) {
      if (count >= MAX_LIGHTS) break
      lights.set(packed, count++ * LIGHT_FLOATS)
    }
    const vehOut = vehicleRenderer.collect(
      vdt,
      time,
      town,
      session.view.vehicles,
      p.vehicleId,
      view,
      cam.eye,
      lights,
      count,
      shadowLightCount,
      frameLightOccluders,
      alphaSprites,
      0,
      addSprites,
      addCount,
      settings.vehicle,
    )
    count = vehOut.lights.lightCount
    shadowLightCount = vehOut.lights.shadowLightCount
    addCount = vehOut.lights.addCount
    const vehAlphaStart = vehOut.lights.alphaCount
    const ambLum = (day.ambient[0] + day.ambient[1] + day.ambient[2]) * settings.lighting.skyFill * 0.333
    const weatherOut = weatherController.stepAndPrepare({
      dt,
      town,
      settings: settings.weather,
      viewProj: cam.viewProj,
      eye: cam.eye,
      playerX: p.x,
      playerY: p.y,
      playerGroundY,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      zoom: settings.view.zoom,
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
    // The visibility field is anchored to the streaming window: a new window origin starts it afresh.
    const fieldSnap = currentWindowOrigin[0] !== fieldWindowX || currentWindowOrigin[1] !== fieldWindowY
    if (fieldSnap) {
      renderer.clearVisibilityField()
      fieldWindowX = currentWindowOrigin[0]
      fieldWindowY = currentWindowOrigin[1]
    }
    packOutbreakLightingUniforms(
      {
        settings,
        playerX: p.x,
        playerY: p.y,
        playerH: playerGroundY,
        playerAim: beamAim,
        flashlightOutput: beamOutput,
        flashlightSlot,
        flashlightHeight,
        flashlightBounce,
        flashlightAirLimit,
        flashlightBounceHeight,
        flashlightOrigin: flashlightSlot >= 0 ? flashlightOrigin : undefined,
        flashlightYaw,
        flashlightPitch,
        invViewProj: mat4.inverse(cam.viewProj, invViewProj),
        beamReach,
        weatherAir: settings.weather.weatherEnabled ? beamWeatherAir({ intensity: settings.weather.weatherIntensity, mist: settings.weather.weatherMist }) : 0,
        frameDt: fieldSnap || Math.hypot(sightX - lastSightX, sightY - lastSightY) > 2.5 ? 0 : dt,
        inInteriorView,
        streetHead: nearestStreetHead(camX, camY, currentIsStreamWindow),
        zombies: nearestZombies(zombies, p.x, p.y),
        weather: activeWeather,
        windowOrigin: currentWindowOrigin,
        isStreamWindow: currentIsStreamWindow,
        windowBuildings: currentIsStreamWindow ? worldStreamer.windowBuildings : town.buildings,
      },
      flashRgb,
      lightingUniforms,
    )
    packFoliageUniforms(foliageSettings, lightingUniforms, OUTBREAK_FOLIAGE_UNIFORM_OFFSET)
    packFoliageActors(foliageActors(p, zombies), lightingUniforms, OUTBREAK_FOLIAGE_UNIFORM_OFFSET + FOLIAGE_WIND_FLOATS)
    renderer.setCustomUniforms(lightingUniforms)
    lastSightX = sightX
    lastSightY = sightY
    frame.set(cam.viewProj, 0)
    frame.set([...cam.eye, time], 16)
    const texCfgBits =
      ((settings.materials.textures & 3) >>> 0) |
      (((settings.materials.rugStyle & 3) << 2) >>> 0) |
      (((settings.materials.wallStyle & 3) << 4) >>> 0) |
      (((settings.materials.floorStyle & 3) << 6) >>> 0) |
      ((Math.round((settings.materials.texScale - 0.5) / 0.05) & 63) << 8) |
      ((Math.round(settings.materials.texContrast / 0.05) & 63) << 14) |
      ((Math.round(settings.world.weathering * 5) & 15) << 20)
    frame.set([canvas.width, canvas.height, count, texCfgBits], 20)
    frame.set([cutX, cutY, cutFlag, cutRadius], 24)
    const lightningFlash = weatherOut.prepareInput ? weatherOut.state.flash : 0
    frame.set(
      [
        ...day.ambient.map((v) => v * settings.lighting.skyFill * (1 - settings.weather.weather * 0.3) + lightningFlash * 0.16),
        day.strength * settings.lighting.moonFill * (1 - settings.weather.weather * 0.85) + lightningFlash * 0.65,
      ],
      28,
    )
    const focusX = activePeek ? p.x + (activePeek.cutX - p.x) * peekBlend : p.x
    const focusY = activePeek ? p.y + (activePeek.cutY - p.y) * peekBlend : p.y
    const focus = cam.project(focusX, 1, focusY, w, h)
    frame.set([(focus.x / w) * 2 - 1, 1 - (focus.y / h) * 2, cutHeight, count], 32)
    frame.set([...day.direction, day.sun], 36)
    frame.set([1 / SIZE, 1 / SIZE, settings.view.diagnostic, packGroundCfgBits(settings.ground)], 40)
    frame.set([sightAim, Math.cos((sightCone * Math.PI) / 360), sightAwareness, settings.vision.shroud], 44)
    let doorCount = 0
    for (let i = 0; i < town.doors.length && doorCount < 64; i++) {
      const door = town.doors[i]!
      doorData.set(
        [door.rect[0], 0, (door.rect[1] + door.rect[3]) / 2, door.open ? -Math.PI / 2 : 0, 1, 1, 1, 1, 0, 0, 1, 0],
        doorCount++ * 12,
      )
    }
    doorBatch.count = doorCount
    let openWindows = 0
    for (const win of town.windows) {
      if (!win.open || openWindows >= 64) continue
      const [wx0, wy0, wx1, wy1] = win.rect
      const horizontal = wx1 - wx0 > wy1 - wy0
      const yaw = horizontal ? 0 : Math.PI / 2
      sashData.set([(wx0 + wx1) / 2, 0.38, (wy0 + wy1) / 2, yaw, 1, 1, 1, 1, 0, 0, 1, 0], openWindows++ * 12)
    }
    sashBatch.count = openWindows
    const debugAlphaCount = zombieCrowd.renderDebugOverlay(
      Boolean(settings.ai.aiDebugOverlay),
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
      vehAlphaStart,
    )
    const fogSoundAlphaCount = collectFogSoundSprites(
      zombies,
      noises,
      p,
      vision,
      time,
      (x, z) => supportHeight(town, x, z),
      settings.fog,
      alphaSprites,
      debugAlphaCount,
    )
    const tightView = cam.groundRect(0.8)
    const groundWearBatches = groundWear.collectBatches(town, tightView, settings.ground)
    const clutterBatches = exteriorClutter.collectBatches(town, tightView, settings.ground)
    const motionOut = ambientMotion.stepAndCollect(
      dt,
      time,
      town,
      p,
      tightView,
      settings.ground,
      alphaSprites,
      fogSoundAlphaCount,
    )
    render.alphaCount = motionOut.alphaCount
    render.addCount = addCount
    render.splatter =
      settings.combat.bloodStyle === 0 ? undefined : combatFx.hasEmitted ? (combatFx.splatter ?? undefined) : undefined
    render.splatterLegacy = settings.combat.bloodStyle === 2
    render.weather = weatherOut.prepareInput
    render.batches = [
      ...groundWearBatches,
      ...clutterBatches,
      ...vehOut.batches,
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
    const beamTier = BEAM_QUALITY_TIERS[Math.round(settings.flashlight.beamQuality)] ?? BEAM_QUALITY_TIERS[2]
    render.volume = flashlightSlot >= 0 && beamTier.downscale && (settings.flashlight.beamVisibility > 0.001 || settings.flashlight.beamGlare > 0.001)
      ? {
          downscale: beamTier.downscale,
          rect: beamScreenRect(
            (x, y, z) => cam.project(x, y, z, 1, 1),
            [flashlightOrigin[0], flashlightHeight, flashlightOrigin[1]],
            flashlightYaw,
            flashlightPitch ?? 0,
            (settings.flashlight.flashlightCone * Math.PI) / 360,
            beamReach,
            playerGroundY,
          ),
        }
      : null
    render.lampCount = town.lamps.length
    render.view = view
    render.grade = [time, settings.view.diagnostic, Math.max(lightningFlash * 0.35, cam.damageFlash), settings.lighting.exposure]
    render.motionBlur = {
      settings: {
        ...settings.motion,
        enabled: Boolean(settings.motion.enabled) && !cam.isReducedMotion(),
      },
      burst: motionBurst,
      dt,
    }
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
      batteryEl.dataset.low = String(p.battery > 0 && p.battery < settings.flashlight.flashlightFlicker)
      batteryEl.dataset.depleted = String(p.batteryDepleted)
      batteryEl.style.opacity =
        p.flashlightOn && p.battery < settings.flashlight.flashlightFlicker ? String(0.45 + 0.5 * p.flashlightOutput) : ""
    }
    hud.update(dt, session.view, cam, w, h, settings.flashlight.flashlightFlicker, coop.net?.id || "player", coop.hudRemotes(town, vision))
    audio.update({ dt, world: soundWorld(session.sim), listener: drawn, hour, revision: session.view.revision, pursuing: pursuers(zombies, drawn.x, drawn.y), packOpen: inventoryHud.packOpen })
    vehicleAudio.update(dt, time, session.view.vehicles, drawn, p.vehicleId)
    vehicleRenderer.syncHud(localVehicle, p.seatIndex ?? 0)
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
  const harness = createOutbreakHarness({
    adapter,
    device,
    renderer,
    session: () => session,
    vision: () => vision,
    avatar: () => avatar,
    cam,
    settings,
    lookSettings,
    lookCompare,
    controls,
    lab,
    feelTracker,
    combatFx,
    weatherController,
    worldStreamer,
    hud,
    coop,
    audio,
    vehicleAudio,
    progressionHost,
    vehicleHost,
    promptEl,
    getPeekBlend: () => peekBlend,
    resetPeek: () => {
      peekBlend = 0
      lastPeek = null
    },
    getVertices: () => vertices,
    getWindowState: () => ({ origin: currentWindowOrigin, isStream: currentIsStreamWindow }),
    reset,
    setFrozen: (value = true) => {
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
    onSettingChanged,
    setLastDayNightHour: (hour) => {
      lastDayNightHour = hour
    },
    incrementFrames: () => {
      frames++
    },
    draw: (dt) => draw(dt),
  })
  Object.assign(window, { __arcadeHarness: harness })
  scheduleFrame()
}

main().catch((error) => {
  console.error(error)
  document.querySelector("#status")!.textContent = `Outbreak could not start: ${error.message}`
})
