import { Camera } from "@arcade/kit/client/camera"
import { keyLabelSetting } from "@arcade/kit/client/controls"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { LabPanel } from "@arcade/kit/lab-panel"
import { OUTBREAK_LAB_TABS } from "./lab-tabs"
import { attachCameraFilter } from "@arcade/kit/gpu/post/camcorder"
import { createLookControls } from "@arcade/kit/look"
import {
  AdaptiveQualityController,
  loadSavedQualityMode,
  resolveQualityMode,
} from "@arcade/kit/quality"
import { DRIVING_FX_DEFAULTS, drivingFxControls } from "@arcade/kit/vehicle/driving-fx"
import { wrapHour } from "../shared/day-cycle"
import { LocalSession } from "../shared/session"
import { OutbreakAudio } from "./audio"
import { BotsLabController } from "./bots-lab"
import { muteOnM, type ControlSettings } from "./controls/settings"
import { CoopView } from "./coop-view"
import type { DiscoveryHost } from "./discovery/stage"
import { outbreakClientFeatures } from "./features"
import { registerOutbreakGameCommands } from "./game-commands"
import { createOutbreakHarness } from "./harness"
import { OutbreakFrameUi } from "./hud/frame-ui"
import { OutbreakInputController } from "./input/controller"
import { DEFAULT_INTERIOR_SETTINGS, interiorControls } from "./interiors"
import { buildOutbreakLabControls, handleOutbreakSettingChanged, type OutbreakLabControlHost } from "./lab-controls"
import { OutbreakFramePacer } from "./loop/frame-pacer"
import type { NetSession } from "./net-session"
import { type ProgressionLabHost } from "./progression/lab"
import { OutbreakFrameRenderer } from "./scene/frame-renderer"
import {
  bindOutbreakLabControls,
  createOutbreakSettings,
  migrateOutbreakLocalStorage,
  resolveWorldMode,
} from "./settings"
import { OUTBREAK_QUALITY_PROFILES } from "./quality"
import { shaders } from "./shaders"
import { LAMP_FOG_DEFAULTS, lampFog, lampFogControls } from "./air/lamp-fog"
import "./style.css"
import { OutbreakVehicleAudio } from "./vehicle-audio"
import { type VehicleLabHost } from "./vehicle-lab"

const params = new URLSearchParams(location.search)
try {
  migrateOutbreakLocalStorage(localStorage)
} catch {}
const settings = createOutbreakSettings(params)
if (!params.has("quality") && !params.has("view.quality") && !navigator.webdriver) {
  try {
    const savedQuality = loadSavedQualityMode(localStorage)
    if (savedQuality) settings.view.quality = savedQuality
  } catch {}
}
const qualityController = new AdaptiveQualityController({
  mode: resolveQualityMode(settings.view.quality),
  profiles: OUTBREAK_QUALITY_PROFILES,
})

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#game")!
  const frameUi = new OutbreakFrameUi(settings)
  const { statusEl: status, promptEl, hud, map, inventoryHud } = frameUi
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
  performance.mark("outbreak:device")
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
  const coop = CoopView.fromUrl(renderer, params, outbreakClientFeatures)
  const soloSession = (s: number) =>
    coop.applySoloLoadout(
      new LocalSession(
        s,
        settings.world.houseSeed,
        settings.world.terrain,
        settings.ai,
        settings.progression,
        resolveWorldMode(settings.world.worldMode),
      ),
    )
  // A feature may make a local session instead (the lobby's practice space and the training room, AR-89).
  const makeSession = (s: number) =>
    outbreakClientFeatures.startSession({ seed: s, settings, coop, make: soloSession, restart: () => reset() }) ?? coop.net ?? soloSession(s)
  let session: LocalSession | NetSession = makeSession(seed)
  coop.companions = () => {
    const s = session
    return s instanceof LocalSession ? s.sim.slots.filter((slot) => slot !== s.slot) : []
  }
  const cam = new Camera(settings.view)
  const botsLab = new BotsLabController(settings)
  const inputController = new OutbreakInputController({
    canvas,
    session: () => session,
    cam,
    settings,
    inventoryHud,
    map,
    botsLab,
    incrementFrames: (count) => pacer.incrementFrames(count),
  })
  const { input } = inputController
  const audio = new OutbreakAudio(settings.audio, {
    baseUrl: new URL("./audio-assets/", document.baseURI).href,
    storage: (() => {
      try {
        return localStorage
      } catch {
        return null
      }
    })(),
    automated: navigator.webdriver,
  })
  audio.arm(window, () => muteOnM(settings.hud as unknown as ControlSettings))
  const vehicleAudio = new OutbreakVehicleAudio(audio)
  const frameRenderer = new OutbreakFrameRenderer({
    device,
    renderer,
    canvas,
    cam,
    settings,
    qualityController,
    coop,
    audio,
    vehicleAudio,
    frameUi,
    botsLab,
    session: () => session,
  })
  const {
    interiors,
    combatFx,
    sceneLevel,
    discoveryProps,
    pageGlance,
    closetView,
    feelTracker,
    weatherController,
    vehicleRenderer,
    lookSettings,
    lookCompare,
    render,
  } = frameRenderer

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
  const discoveryHost: DiscoveryHost = {
    ...progressionHost,
    props: discoveryProps,
    glance: pageGlance,
    closet: closetView,
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
    features: outbreakClientFeatures,
    session: () => session,
    settings,
    lookSettings,
    lab: () => lab,
    feelTracker,
    combatFx,
    weatherController,
    progressionHost,
    discoveryHost,
    vehicleHost,
    botsLab,
    hud,
    map,
    qualityController,
    updateProfile: () => frameRenderer.updateProfile(),
    regenerate: () => regenerate(),
    reset: (s) => reset(s),
    syncTextures: () => frameRenderer.syncTextures(),
    setLastDayNightHour: (hour) => {
      frameRenderer.lastDayNightHour = hour
    },
  }
  const controls = buildOutbreakLabControls(labControlHost)
  const pacer = new OutbreakFramePacer({
    device,
    renderer,
    qualityController,
    lab: () => lab,
    initialFrozen: params.has("bench"),
    isCoopPaused: () => coop.paused,
    isSampleLoading: () => audio.runtime.sampleBank.loadingInFlight,
    liveMove: () => inputController.liveMove(),
    releaseInput: () => inputController.release(),
    stepSubsteps: (wallNow, clock) => inputController.stepSubsteps(wallNow, clock),
    draw: (dt) => draw(dt),
    hudSummaryContext: () => ({
      hour: session.view.hour,
      seed: session.view.town.seed,
      livingZombies: session.view.zombies.filter((z) => z.state !== "dead").length,
    }),
  })
  audio.runtime.onTick = () => pacer.onAudioTick()
  const onSettingChanged = (rawKey: string, value?: number | boolean | string) =>
    handleOutbreakSettingChanged(labControlHost, rawKey, value)
  const lab = new LabPanel(
    {},
    [],
    params,
    () => {
      inputController.release()
      pacer.clock.pause(performance.now())
    },
    { capture: "focus", openGroups: ["Feel"], onChange: (key, value) => onSettingChanged(key, value) },
  )
  lab.setTabs(OUTBREAK_LAB_TABS)
  input.blocked = () => lab.holdsInput
  bindOutbreakLabControls(lab, settings, controls)

  registerOutbreakGameCommands({
    features: outbreakClientFeatures,
    device,
    renderer,
    session: () => session,
    vision: () => sceneLevel.vision,
    scenery: () => sceneLevel.scenery,
    avatar: () => frameRenderer.avatar,
    cam,
    input,
    settings,
    feelTracker,
    hud,
    inventoryHud,
    map,
    coop,
    lab,
    progressionHost,
    discoveryHost,
    vehicleHost,
    weatherController,
    harness: () => harness,
    resetPeek: () => frameRenderer.resetPeek(),
    draw: (dt) => draw(dt),
  })

  const keyLabels = keyLabelSetting("HUD")
  lab.addControls(keyLabels.settings, [keyLabels.control], keyLabels.defaults)
  attachCameraFilter(renderer, lab, device, format, { params })
  lab.addControls(lampFog.settings as unknown as Record<string, string | number | boolean>, lampFogControls(), { ...LAMP_FOG_DEFAULTS })
  lab.addControls(
    vehicleRenderer.drivingFx.settings as unknown as Record<string, string | number | boolean>,
    drivingFxControls().map((c) => ({ ...c, folded: true })),
    { ...DRIVING_FX_DEFAULTS },
  )
  lab.addControls(
    lookSettings as unknown as Record<string, string | number | boolean>,
    createLookControls(lookSettings, { includePresetPicker: false }).map((c) => ({ ...c, folded: true })),
  )
  lab.addControls(
    interiors.settings as unknown as Record<string, string | number | boolean>,
    interiorControls(
      () => {
        interiors.apply("interiorTheme")
        sceneLevel.rebuildLevel()
      },
      () => interiors.rebuildPool(),
      () => interiors.apply("rugSource"),
    ),
    { ...DEFAULT_INTERIOR_SETTINGS },
  )
  function regenerate() {
    // A co-op room's neighbourhood is fixed by the room: only presentation settings rebuild the level.
    if (coop.net) return sceneLevel.rebuildLevel()
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
    frameRenderer.resetForRegenerate()
  }
  function reset(nextSeed = seed) {
    if (session !== coop.net) session.close()
    session = makeSession(nextSeed)
    frameRenderer.resetForSession(nextSeed)
    pacer.resetForSession()
  }
  coop.onSessionChange = () => reset()
  reset()
  performance.mark("outbreak:level")
  frameUi.installKeyLayoutListener(() => session, cam)
  await renderer.texturesReady
  performance.mark("outbreak:textures")
  frameRenderer.syncTextures()
  function draw(dt: number) {
    pacer.recordFrameStart(performance.now())
    frameRenderer.drawFrame(dt)
    pacer.updateMeter(performance.now())
  }
  pacer.drawInitialFrame()
  performance.mark("outbreak:first-frame")
  const harness = createOutbreakHarness({
    features: outbreakClientFeatures,
    adapter,
    device,
    renderer,
    render,
    session: () => session,
    vision: () => sceneLevel.vision,
    avatar: () => frameRenderer.avatar,
    cam,
    settings,
    lookSettings,
    lookCompare,
    controls,
    lab,
    feelTracker,
    combatFx,
    weatherController,
    worldStreamer: sceneLevel.worldStreamer,
    hud,
    map,
    coop,
    audio,
    vehicleAudio,
    progressionHost,
    discoveryHost,
    vehicleHost,
    vehicleRenderer,
    botsLab,
    qualityController,
    promptEl,
    getPeekBlend: () => frameRenderer.peekBlend,
    resetPeek: () => frameRenderer.resetPeek(),
    getVertices: () => sceneLevel.vertices,
    getWindowState: () => ({ origin: sceneLevel.currentWindowOrigin, isStream: sceneLevel.currentIsStreamWindow }),
    reset,
    setFrozen: (value = true) => pacer.setFrozen(value),
    isFrozen: () => pacer.isFrozen(),
    onSettingChanged,
    setLastDayNightHour: (hour) => {
      frameRenderer.lastDayNightHour = hour
    },
    incrementFrames: () => pacer.incrementFrames(1),
    draw: (dt) => draw(dt),
    interiors,
    rebuildLevel: () => sceneLevel.rebuildLevel(),
    forceLevel: (level?: "origin" | "streamed") => {
      sceneLevel.forcedLevel = level
    },
    holdCasters: (hold) => {
      sceneLevel.holdCasters = hold
    },
  })
  Object.assign(window, { __arcadeHarness: harness })
  pacer.scheduleFrame()
}

main().catch((error) => {
  console.error(error)
  document.querySelector("#status")!.textContent = `Outbreak could not start: ${error.message}`
})
