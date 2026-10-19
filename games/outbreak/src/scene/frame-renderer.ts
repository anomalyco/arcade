import type { Camera } from "@arcade/kit/client/camera"
import { Renderer, SPRITE_FLOATS, type Batch, type FrameInput } from "@arcade/kit/gpu/renderer"
import { humanProfiles } from "@arcade/kit/human-profile"
import { createLookSettings, type LookCompareMode } from "@arcade/kit/look"
import type { AdaptiveQualityController } from "@arcade/kit/quality"
import { dayCycle } from "../../shared/day-cycle"
import { vaultLift, type PeekInfo } from "../../shared/interact"
import { SIZE } from "../../shared/map"
import type { LocalSession } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import { DustPass } from "../air/dust"
import { OutbreakAmbientMotion } from "../ambient-motion"
import { OutbreakAudio, pursuers, soundWorld } from "../audio"
import type { BotsLabController } from "../bots-lab"
import { ExteriorClutterRenderer } from "../clutter"
import { OutbreakCombatFX } from "../combat-fx"
import type { CoopView } from "../coop-view"
import { applyOutbreakDayNight } from "../day-night"
import { BloodStains, setCurrentBloodStains } from "../blood/stains"
import { DetailsPresenter, setCurrentDetails } from "../details/presenter"
import { ClosetView } from "../discovery/closet"
import { lowBatteryBeam, type BeamLook } from "../discovery/flashlight"
import { PageGlance } from "../discovery/glance"
import { BenchLean } from "../discovery/lean"
import { DiscoveryProps } from "../discovery/props"
import { outbreakClientFeatures } from "../features"
import { OutbreakFeelTracker } from "../feel-events"
import { charOf, fireAddSprites, type FireFrame } from "../fire/fx"
import { FirePresenter, setCurrentFire } from "../fire/presenter"
import { onFootLead } from "../feel-tuning"
import { collectFogSoundSprites } from "../fog-of-war"
import { GroundWearRenderer } from "../ground"
import { renderFlowOverlay } from "../hordes/flow-overlay"
import { SOUND_CUES_TODAY } from "../sound-cues/settings"
import { hordeWatchPoint } from "../hordes/stage"
import type { OutbreakFrameUi } from "../hud/frame-ui"
import { InteriorPresenter, SCONCE_LAMP_SLOT } from "../interiors"
import { hex } from "../level"
import { TABLE_LAMP_SLOT } from "../lightbake"
import { trimLook } from "../look/world"
import { SURVIVOR_COLOURS, type NetSession } from "../net-session"
import { NightLightsPresenter, setCurrentNightLights } from "../night-lights/presenter"
import { PropDressing } from "../props/dressing"
import type { OutbreakSettings } from "../settings"
import { shaders } from "../shaders"
import { Survivor } from "../survivor"
import { evaluateUnseenFrame } from "../unseen"
import type { OutbreakVehicleAudio } from "../vehicle-audio"
import { OutbreakVehicleRenderer } from "../vehicles"
import { OutbreakWeatherController } from "../weather/controller"
import { OutbreakSceneLevel } from "../world/scene-level"
import { zombieProfile } from "../zombie-profile"
import { ZombieCrowdRenderer } from "../zombies"
import { OutbreakFrameLighting } from "./frame-lighting"

const seatTint = (seat: number) => {
  const c = hex(SURVIVOR_COLOURS[seat % SURVIVOR_COLOURS.length]!.torso)
  return [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2] as const
}

export interface OutbreakFrameRendererHost {
  readonly device: GPUDevice
  readonly renderer: Renderer
  readonly canvas: HTMLCanvasElement
  readonly cam: Camera
  readonly settings: OutbreakSettings
  readonly qualityController: AdaptiveQualityController
  readonly coop: CoopView
  readonly audio: OutbreakAudio
  readonly vehicleAudio: OutbreakVehicleAudio
  readonly frameUi: OutbreakFrameUi
  readonly botsLab: BotsLabController
  readonly session: () => LocalSession | NetSession
}

/**
 * Owns Outbreak's scene presenters (Survivor, ZombieCrowd, CombatFX, SceneLevel, DiscoveryProps/BenchLean/PageGlance/ClosetView,
 * FeelTracker, GroundWear, ExteriorClutter, PropDressing, AmbientMotion, Weather, Vehicles, Interiors, DustPass, FrameLighting)
 * and executes the full per-frame camera/peek/lighting/batch/post-process render pass.
 */
export class OutbreakFrameRenderer {
  readonly renderer: Renderer
  readonly interiors: InteriorPresenter
  readonly dust: DustPass
  avatar: Survivor
  private avatarPalette: object | null = null
  readonly zombieCrowd: ZombieCrowdRenderer
  readonly combatFx: OutbreakCombatFX
  readonly sceneLevel: OutbreakSceneLevel
  readonly discoveryProps: DiscoveryProps
  readonly benchLean = new BenchLean()
  readonly pageGlance = new PageGlance()
  readonly closetView = new ClosetView()
  readonly feelTracker: OutbreakFeelTracker
  readonly groundWear: GroundWearRenderer
  readonly exteriorClutter: ExteriorClutterRenderer
  readonly propDressing: PropDressing
  readonly blood: BloodStains
  readonly nightLights: NightLightsPresenter
  readonly fire: FirePresenter
  readonly details: DetailsPresenter
  readonly ambientMotion: OutbreakAmbientMotion
  readonly weatherController = new OutbreakWeatherController()
  readonly vehicleRenderer: OutbreakVehicleRenderer
  readonly frameLighting = new OutbreakFrameLighting()
  readonly lookSettings = createLookSettings("noir")
  private readonly gradedLook = createLookSettings("noir")
  readonly lookCompare: { mode: LookCompareMode; wipeSplit: number } = { mode: 1, wipeSplit: 0.5 }
  private readonly beamLookScratch: BeamLook = { low: 0, cone: 0, range: 0, warmth: 0, color: [1, 1, 1] }
  private readonly alphaSprites = new Float32Array(1024 * SPRITE_FLOATS)
  private readonly addSprites = new Float32Array(1536 * SPRITE_FLOATS)
  readonly render: FrameInput
  peekBlend = 0
  private lastPeek: PeekInfo | null = null
  lastDayNightHour = -1
  private readonly footfall: (x: number, y: number, speed: number) => void

  constructor(private readonly host: OutbreakFrameRendererHost) {
    const { device, renderer, cam, settings, coop, audio, vehicleAudio, session } = host
    this.renderer = renderer
    this.interiors = new InteriorPresenter(device, (view) => this.renderer.setDetailTextureArray(view))
    this.dust = new DustPass(this.renderer.passContext)
    this.renderer.addPass("alpha", this.dust)
    this.footfall = (x: number, y: number, speed: number) =>
      audio.footstep(x, y, speed, { local: true, crouching: Boolean(session().view.player.crouching) })
    coop.onFootfall = (x: number, y: number, speed: number) => audio.footstep(x, y, speed, { local: false })
    coop.hidden = (id) => {
      const s = session()
      if (s.view.progression.verbs.hiddenIn(id)) return true
      const slot = s.sim.slot(id)
      return Boolean(slot && outbreakClientFeatures.hidesSurvivor(s.sim, slot))
    }
    this.avatar = new Survivor(this.renderer)
    this.avatar.onFootfall = this.footfall
    this.zombieCrowd = new ZombieCrowdRenderer(this.renderer)
    this.zombieCrowd.onFootfall = (id, x, y, speed, drag, variant) =>
      audio.zombieFootstep(id, x, y, speed, drag, variant)
    this.combatFx = new OutbreakCombatFX(this.renderer)
    this.sceneLevel = new OutbreakSceneLevel({
      renderer: this.renderer,
      combatFx: this.combatFx,
      settings,
      cam,
      session,
    })
    this.discoveryProps = new DiscoveryProps(this.renderer)
    this.feelTracker = new OutbreakFeelTracker(cam, settings, session().view.player, outbreakClientFeatures)
    this.groundWear = new GroundWearRenderer(this.renderer)
    this.exteriorClutter = new ExteriorClutterRenderer(this.renderer)
    this.propDressing = new PropDressing(this.renderer, TABLE_LAMP_SLOT)
    this.blood = new BloodStains(this.renderer)
    setCurrentBloodStains(this.blood)
    this.nightLights = new NightLightsPresenter(this.renderer)
    setCurrentNightLights(this.nightLights)
    this.fire = new FirePresenter(this.renderer)
    setCurrentFire(this.fire)
    this.details = new DetailsPresenter(this.renderer)
    setCurrentDetails(this.details)
    this.details.crows.onScatter = (x, z, birds) => {
      audio.play({ id: "creature.crow.caw", x, y: z, delay: 0.02, gain: 0.75, source: "crow" })
      for (let i = 0; i < Math.min(3, birds); i++) audio.play({ id: "wings.flap", x, y: z, delay: i * 0.07, gain: 0.75, rate: 1.08 + i * 0.06, source: "crow" })
    }
    this.ambientMotion = new OutbreakAmbientMotion(this.renderer)
    this.vehicleRenderer = new OutbreakVehicleRenderer(this.renderer, document.body)
    this.vehicleRenderer.onPop = (v) => vehicleAudio.pop(v.id)
    this.vehicleRenderer.onCrash = (_v, impact) => {
      cam.impact(impact)
    }
    this.vehicleRenderer.onBang = () => {
      cam.bump(0.32)
    }
    this.render = {
      frame: this.frameLighting.frame,
      lights: this.frameLighting.lights,
      lightCount: 0,
      shadowLightCount: 0,
      occluders: this.sceneLevel.occluders,
      occluderCount: 0,
      lampPower: this.frameLighting.lampPower,
      lampCount: 0,
      view: [0, 0, SIZE, SIZE],
      batches: [],
      alphaSprites: this.alphaSprites,
      alphaCount: 0,
      addSprites: this.addSprites,
      addCount: 0,
      grade: [0, 0, 0, 1],
      lampGrid: this.frameLighting.lampGrid,
    }
  }

  updateProfile(): void {
    const { settings } = this.host
    this.avatar.profile =
      settings.zombies.humanProfile === 1
        ? zombieProfile(settings.zombies)
        : settings.zombies.humanProfile === 2
          ? { ...humanProfiles.soldier, runPosture: 0.34, crouchDepth: 0.095 }
          : undefined
  }

  syncTextures(): void {
    const { settings, session } = this.host
    this.renderer.setSurfaceTexUniforms({
      enabled: settings.materials.textures,
      globalScale: settings.materials.texScale,
      globalContrast: settings.materials.texContrast,
      globalRoughness: settings.materials.texRoughness,
      rugStyle: settings.materials.rugStyle,
      wallStyle: settings.materials.wallStyle,
      floorStyle: settings.materials.floorStyle,
      splitX: session().view.player.x,
    })
  }

  resetPeek(): void {
    this.peekBlend = 0
    this.lastPeek = null
  }

  resetForRegenerate(): void {
    this.sceneLevel.markTopologyDirty()
    this.sceneLevel.rebuildLevel()
    this.avatar.reset()
    this.zombieCrowd.reset()
    this.combatFx.reset()
    this.blood.reset()
    this.details.reset()
    this.ambientMotion.reset()
    this.vehicleRenderer.reset()
  }

  resetForSession(nextSeed: number): void {
    const { cam, settings, frameUi, session } = this.host
    this.resetPeek()
    this.avatar.reset()
    this.zombieCrowd.reset()
    this.combatFx.reset()
    this.vehicleRenderer.reset()
    // A restart after a run ends starts clean: no stains from the last run's fights and falls.
    this.blood.reset()
    this.feelTracker.reset(session().view.player)
    this.ambientMotion.reset()
    frameUi.reset()
    this.weatherController.reset(nextSeed)
    this.sceneLevel.resetForSession()
    this.frameLighting.resetForSession()
    cam.snap(session().view.player.x, session().view.player.y)
    cam.dist = settings.view.zoom
  }

  drawFrame(dt: number): void {
    const {
      canvas,
      cam,
      settings,
      qualityController,
      coop,
      audio,
      vehicleAudio,
      frameUi,
      botsLab,
    } = this.host
    const session = this.host.session()
    const { hitStop, motionBurst } = this.feelTracker
    const qProfile = qualityController.getProfile()
    this.renderer.setBloomLevels(qProfile.bloomLevels)
    if (settings.materials.textures === 2) this.syncTextures()
    coop.net?.sync(dt)
    if (coop.localPalette !== this.avatarPalette || coop.localVariant !== this.avatar.variantIndex) {
      this.avatarPalette = coop.localPalette
      this.avatar = new Survivor(this.renderer, coop.localPalette ?? undefined, coop.localVariant)
      this.avatar.onFootfall = this.footfall
      this.updateProfile()
    }
    const { player: p, town, hour, time, peek, zombies, noises } = session.view
    settings.dayCycle.hour = Math.round(hour * 20) / 20
    if (
      settings.dayCycle.dayNightLook === 1 &&
      settings.dayCycle.lookPreset === "noir" &&
      Math.abs(hour - this.lastDayNightHour) > 1e-4
    ) {
      this.lastDayNightHour = hour
      applyOutbreakDayNight(hour, this.lookSettings, settings)
    }
    const playerGroundY = supportHeight(town, p.x, p.y)

    let addCount = this.feelTracker.processFrame(
      session,
      this.combatFx,
      this.zombieCrowd,
      this.addSprites,
      playerGroundY,
      dt,
    )

    const vdt = hitStop.step(dt, !cam.isReducedMotion())
    motionBurst.step(dt, settings.motion.burstDecay)
    if (peek) {
      this.lastPeek = peek
      this.peekBlend = Math.min(1, this.peekBlend + dt * 6.5)
    } else {
      this.peekBlend = Math.max(0, this.peekBlend - dt * 5.5)
      if (this.peekBlend <= 0.001) this.lastPeek = null
    }
    const activePeek = peek ?? (this.peekBlend > 0.001 ? this.lastPeek : null)
    const w = innerWidth
    const h = innerHeight
    const { width: targetW, height: targetH } = qualityController.canvasDimensions(w, h, devicePixelRatio)
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
      this.renderer.resize(targetW, targetH)
    }
    const localVehicle = session.sim.vehicles.vehicleOf(p)
    const vehSpeed = localVehicle ? Math.hypot(localVehicle.vx, localVehicle.vy) : 0
    const speedPullback = localVehicle
      ? (vehSpeed / Math.max(1, localVehicle.spec.maxSpeed)) * settings.vehicle.cameraSpeedZoom
      : 0
    const lean = this.benchLean.step(session.view, settings.discovery, dt)
    this.pageGlance.update(session.view, settings.discovery, dt)
    this.closetView.update(session.view, dt)
    cam.zoomOffset =
      settings.view.zoom - 24 + speedPullback + (settings.discovery.discoveryBenchZoom - settings.view.zoom) * lean.blend
    const drawn = coop.pose(p)
    // A feature may look from elsewhere (a dead survivor watching a teammate): camera, sight and hearing follow it.
    const eye = outbreakClientFeatures.viewpoint(session, coop)
    const look = eye ? { ...drawn, x: eye.x, y: eye.y, aim: eye.aim } : drawn
    const watch = settings.hordes.hordeWatch ? hordeWatchPoint(session.sim) : null
    const camX = watch ? watch.x : look.x + (activePeek ? activePeek.camOffsetX * this.peekBlend : 0) + lean.dx
    const camY = watch ? watch.y : look.y + (activePeek ? activePeek.camOffsetY * this.peekBlend : 0) + lean.dy
    const footLead = localVehicle || watch || activePeek || eye ? null : onFootLead(p, settings.view)
    const lookAheadX = localVehicle ? localVehicle.vx * 0.22 : (footLead?.x ?? 0)
    const lookAheadY = localVehicle ? localVehicle.vy * 0.22 : (footLead?.y ?? 0)
    cam.follow(camX, camY, lookAheadX, lookAheadY, dt, false, Boolean(localVehicle))
    cam.update(w / h)
    const view = cam.groundRect(5.5)
    const drivingHeadlights = Boolean(
      localVehicle &&
        (p.seatIndex ?? 0) === 0 &&
        localVehicle.headlights &&
        localVehicle.hasBattery &&
        !localVehicle.wreck,
    )
    const effectiveVisionAim = eye ? eye.aim : drivingHeadlights && localVehicle ? localVehicle.h : p.aim
    const lowBeam = lowBatteryBeam(
      settings.flashlight,
      p.battery,
      p.batteryDepleted,
      settings.discovery,
      this.beamLookScratch,
    )
    const { mode, windowMoved, visChanged } = this.sceneLevel.stepFrame({
      drawn: look,
      activePeek,
      view,
      watch,
      localVehicle,
      drivingHeadlights,
      effectiveVisionAim,
      lowBeam,
    })
    const effectiveVisionSettings = drivingHeadlights
      ? {
          ...settings.vision,
          range: Math.max(settings.vision.range, settings.vehicle.headlightRange + 4),
          cone: Math.max(settings.vision.cone, 130),
        }
      : settings.vision
    const frameLightOccluders = this.sceneLevel.packFlashlightActorCasters(
      p.x,
      p.y,
      p.flashlightOutput,
      zombies,
      coop.otherPositions(),
    )
    const day = dayCycle(hour)
    const unseenEval = evaluateUnseenFrame(settings.unseen, day.darkness, eye ? eye.health : p.health, eye ? eye.maxHealth : p.maxHealth, settings.look)
    // Pose the bodies first: the flashlight rides the survivor's pistol or hand.
    const lift = vaultLift(p)
    const riderSink = localVehicle ? (localVehicle.spec.seats[p.seatIndex ?? 0]?.sink ?? 0.48) : 0
    const survivorBatches = this.avatar.draw(
      localVehicle ? { ...drawn, vx: 0, vy: 0 } : drawn,
      vdt,
      time,
      (x, z) => supportHeight(town, x, z) + lift - riderSink,
      settings.survivor,
    )
    const { vision } = this.sceneLevel
    const coopBatches = coop.bodies(vdt, time, town, vision, settings.survivor)
    const featureFrame = { session, coop, cam, renderer: this.renderer, settings, vision, dt: vdt, w, h }
    const localSlot = "local" in session ? session.local : session.slot
    const hideLocal = outbreakClientFeatures.hidesSurvivor(session.sim, localSlot)
    const beamState = this.frameLighting.beginFrameLights({
      p,
      town,
      peek,
      activePeek,
      peekBlend: this.peekBlend,
      playerGroundY,
      localVehicle,
      drivingHeadlights,
      effectiveVisionAim,
      effectiveVisionSettings,
      lowBeam,
      avatar: this.avatar,
      coop,
      settings,
      sceneLevel: this.sceneLevel,
      frameLightOccluders,
    })
    let { count } = beamState
    const { sightAim, sightCone, sightAwareness } = beamState

    const charred = charOf(session.view, settings.fire)
    this.zombieCrowd.charred = charred.size ? charred : null
    const zombieBatches = this.zombieCrowd.draw(
      zombies,
      vdt,
      (x, z) => supportHeight(town, x, z),
      vision,
      view,
      {
        ...settings.zombies,
        fogGhostDuration: settings.fog.fogGhostDuration,
        hideUnseenZombies: unseenEval.hideZombies,
        unseenMode: unseenEval.mode,
        unseenMemory: unseenEval.layers.memory,
      },
      Boolean(settings.ai.aiDebugOverlay),
      time,
    )

    const fxOut = this.combatFx.stepAndCollect(
      vdt,
      time,
      town,
      p,
      this.avatar.bones,
      session.ai,
      this.zombieCrowd,
      (x, z) => supportHeight(town, x, z),
      this.addSprites,
      addCount,
    )
    addCount = fxOut.addCount
    count = this.frameLighting.addMuzzleLight(fxOut.muzzleLight, count, this.sceneLevel.lightOccluders)

    const cutX = activePeek ? activePeek.cutX : look.x
    const cutY = activePeek ? activePeek.cutY : look.y
    const cutFlag = activePeek ? 1 + this.peekBlend : 1
    const cutRadius = activePeek ? 0.48 + 0.1 * this.peekBlend : 0.22
    const cutHeight = activePeek ? 1.0 - 0.12 * this.peekBlend : 1.0
    const inInteriorView = this.sceneLevel.inInteriorView(town, cutX, cutY)
    const vehOut = this.vehicleRenderer.collect(
      vdt,
      time,
      town,
      session.view.vehicles,
      p.vehicleId,
      view,
      cam.eye,
      this.frameLighting.lights,
      count,
      count,
      frameLightOccluders,
      this.alphaSprites,
      0,
      this.addSprites,
      addCount,
      settings.vehicle,
    )
    count = vehOut.lights.lightCount
    let shadowLightCount = vehOut.lights.shadowLightCount
    addCount = vehOut.lights.addCount
    const vehAlphaStart = vehOut.lights.alphaCount
    const fireFrame: FireFrame = {
      view: session.view,
      survivors: [
        { id: session.view.actorId, x: drawn.x, y: drawn.y, aim: p.aim },
        ...coop.others.map((s) => ({ id: s.id, x: s.survivor.x, y: s.survivor.y, aim: s.survivor.aim })),
      ],
      support: (x, z) => supportHeight(town, x, z),
      look: settings.fire,
      bones: (id) => this.zombieCrowd.getAgentBones(id)?.bones,
    }
    addCount = fireAddSprites(fireFrame, this.addSprites, addCount)
    this.fire.gatherLights(fireFrame, camX, camY)
    const fireBatches = this.fire.collect(fireFrame, cam.groundRect(2.8))
    const nightBatches = this.nightLights.collect(session.view, settings.nightLights, cam.groundRect(2.8), camX, camY, day.lamps)
    const mapLights = this.frameLighting.collectMapAndInteriorLights({
      town,
      day,
      settings,
      qProfile,
      cam,
      camX,
      camY,
      cutX,
      cutY,
      inInteriorView,
      mode,
      sceneLevel: this.sceneLevel,
      interiors: this.interiors,
      count,
      shadowLightCount,
      lampTrim: (lamp, resolved) => this.nightLights.trimLamp(town, settings.nightLights, lamp, resolved, time),
      extraLights: (lights, n, max, lampPower) =>
        outbreakClientFeatures.frameLights(
          featureFrame,
          lights,
          this.details.writeLights(lights, this.fire.writeLights(lights, this.nightLights.writeLights(lights, n, max, lampPower, settings.nightLights), max, settings.fire.fireMaxLights), max, lampPower, settings.details, {
            cutX,
            cutY,
            interior: inInteriorView,
            night: day.lamps,
          }),
          max,
        ),
    })
    count = mapLights.count
    shadowLightCount = mapLights.shadowLightCount
    const ambLum = (day.ambient[0] + day.ambient[1] + day.ambient[2]) * settings.lighting.skyFill * 0.333
    const weatherOut = this.weatherController.stepAndPrepare({
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
      lights: this.frameLighting.lights,
      lightCount: count,
      ambientLum: ambLum,
      particleScale: qProfile.weatherParticleScale,
    })
    const activeWeather = weatherOut.prepareInput
      ? {
          wetness: weatherOut.state.wetness,
          puddleCoverage: weatherOut.state.puddleCoverage,
          rippleIntensity: weatherOut.state.rippleIntensity,
          snowAmount: weatherOut.state.snowAmount,
        }
      : undefined
    const volume = this.frameLighting.packUniformsAndVolume({
      dt,
      p,
      town,
      zombies,
      playerGroundY,
      cam,
      camX,
      camY,
      inInteriorView,
      drivingHeadlights,
      lowBeam,
      beamState,
      activeWeather,
      unseenEval,
      settings,
      sceneLevel: this.sceneLevel,
      interiors: this.interiors,
      renderer: this.renderer,
    })
    const lightningFlash = weatherOut.prepareInput ? weatherOut.state.flash : 0
    this.frameLighting.packFrameBuffer({
      cam,
      time,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      w,
      h,
      count,
      settings,
      p,
      activePeek,
      peekBlend: this.peekBlend,
      cutX,
      cutY,
      cutFlag,
      cutRadius,
      cutHeight,
      day,
      lightningFlash,
      sightAim,
      sightCone,
      sightAwareness,
    })
    const { doorBatch, sashBatch, openWindows } = this.sceneLevel.updateOpeningBatches(town)
    const debugAlphaCount = this.zombieCrowd.renderDebugOverlay(
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
      this.alphaSprites,
      vehAlphaStart,
    )
    const flowCentre = settings.hordes.hordeWatch ? (hordeWatchPoint(session.sim) ?? p) : p
    const flowAlphaCount = settings.hordes.hordeFlowOverlay
      ? renderFlowOverlay(
          session.sim,
          flowCentre.x,
          flowCentre.y,
          (x, z) => supportHeight(town, x, z),
          this.alphaSprites,
          debugAlphaCount,
        )
      : debugAlphaCount
    // The Unseen shroud's ground ripples are the sound cues' Today style (AR-67); the HUD layer replaces them.
    const effectiveFogSettings =
      unseenEval.active && unseenEval.hideZombies && settings.hud.soundCueStyle === SOUND_CUES_TODAY
        ? {
            ...settings.fog,
            fogSoundCues: Math.max(settings.fog.fogSoundCues, Math.min(1.0, 0.55 * unseenEval.effectiveStrength)),
          }
        : settings.fog
    const fogSoundAlphaCount = collectFogSoundSprites(
      zombies,
      noises,
      p,
      vision,
      time,
      (x, z) => supportHeight(town, x, z),
      effectiveFogSettings,
      this.alphaSprites,
      flowAlphaCount,
    )
    const tightView = cam.groundRect(0.8)
    const groundWearBatches = this.groundWear.collectBatches(town, tightView, settings.ground)
    this.blood.observe({
      dt: vdt,
      town,
      zombies,
      survivors: session.sim.slots.map((s) => s.survivor),
      player: p,
      settings: settings.blood,
    })
    const bloodBatches = this.blood.collect(town, tightView, settings.blood)
    const clutterBatches = this.exteriorClutter.collectBatches(town, tightView, settings.ground)
    const detailBatches = this.details.collect(town, tightView, settings.details, settings.nightLights, {
      dt: vdt,
      time,
      threats: session.sim.slots.map((s) => s.survivor),
      noises,
    })
    const motionOut = qProfile.ambientMotion
      ? this.ambientMotion.stepAndCollect(
          dt,
          time,
          town,
          p,
          tightView,
          settings.ground,
          this.alphaSprites,
          fogSoundAlphaCount,
        )
      : { alphaCount: fogSoundAlphaCount, batches: [] as readonly Batch[] }
    const { render } = this
    render.alphaCount = this.fire.smoke(fireFrame, this.alphaSprites, motionOut.alphaCount)
    render.addCount = addCount
    render.splatter =
      settings.combat.bloodStyle === 0
        ? undefined
        : this.combatFx.hasEmitted
          ? (this.combatFx.splatter ?? undefined)
          : undefined
    render.splatterLegacy = settings.combat.bloodStyle === 2
    render.skids = this.vehicleRenderer.drivingFx.marks
    render.skidsVisible = Boolean(settings.vehicle.vehicleSmoke) && this.vehicleRenderer.drivingFx.settings.skidMarks
    this.vehicleRenderer.wetness = weatherOut.state.wetness
    render.weather = weatherOut.prepareInput
    const rBatches = render.batches
    rBatches.length = 0
    for (let i = 0; i < groundWearBatches.length; i++) rBatches.push(groundWearBatches[i]!)
    for (let i = 0; i < bloodBatches.length; i++) rBatches.push(bloodBatches[i]!)
    for (let i = 0; i < nightBatches.length; i++) rBatches.push(nightBatches[i]!)
    for (let i = 0; i < fireBatches.length; i++) rBatches.push(fireBatches[i]!)
    for (let i = 0; i < clutterBatches.length; i++) rBatches.push(clutterBatches[i]!)
    for (let i = 0; i < detailBatches.length; i++) rBatches.push(detailBatches[i]!)
    for (const b of this.propDressing.collect(
      town,
      tightView,
      settings.props,
      settings.view.zoom,
      qProfile,
      mode !== "procedural",
      () => this.sceneLevel.rebuildLevel(),
    ))
      rBatches.push(b)
    for (let i = 0; i < vehOut.batches.length; i++) rBatches.push(vehOut.batches[i]!)
    for (let i = 0; i < motionOut.batches.length; i++) rBatches.push(motionOut.batches[i]!)
    if (!this.closetView.hidden && !hideLocal) for (let i = 0; i < survivorBatches.length; i++) rBatches.push(survivorBatches[i]!)
    for (let i = 0; i < coopBatches.length; i++) rBatches.push(coopBatches[i]!)
    outbreakClientFeatures.frameBatches(featureFrame, rBatches)
    for (let i = 0; i < fxOut.batches.length; i++) rBatches.push(fxOut.batches[i]!)
    const discoveryBatches = this.discoveryProps.collect(
      session.view,
      session.ai,
      settings.discovery,
      time,
      (x, z) => supportHeight(town, x, z),
      { seatColour: seatTint },
    )
    for (let i = 0; i < discoveryBatches.length; i++) rBatches.push(discoveryBatches[i]!)
    for (let i = 0; i < zombieBatches.length; i++) rBatches.push(zombieBatches[i]!)
    rBatches.push(doorBatch)
    if (openWindows) rBatches.push(sashBatch)
    render.lightCount = count
    this.dust.frame(count, qProfile.tier, settings.look.dustAmount > 0)
    render.shadowLightCount = shadowLightCount
    render.occluderCount = frameLightOccluders
    render.volume = volume
    render.lampCount = SCONCE_LAMP_SLOT + 1
    render.view = view
    render.grade[0] = time
    render.grade[1] = settings.view.diagnostic
    render.grade[2] = Math.max(lightningFlash * 0.35, cam.damageFlash)
    render.grade[3] = settings.lighting.exposure
    render.motionBlur = {
      settings: {
        ...settings.motion,
        enabled: Boolean(settings.motion.enabled) && !cam.isReducedMotion(),
      },
      burst: motionBurst,
      dt,
    }
    render.look = trimLook(this.lookSettings, settings.look, this.gradedLook, 1 - day.sun)
    render.lookCompare = this.lookCompare
    render.postParams = unseenEval.postParams
    render.postExtra = unseenEval.postExtra
    this.renderer.render(render)
    this.details.stepLife(time, settings.details, day.lamps, drawn, (e) => audio.play(e))
    audio.update({
      dt,
      world: soundWorld(session.sim),
      listener: look,
      hour,
      revision: session.view.revision,
      pursuing: pursuers(zombies, look.x, look.y),
      packOpen: frameUi.inventoryHud.packOpen,
    })
    vehicleAudio.update(dt, time, session.view.vehicles, drawn, p.vehicleId, (id) =>
      this.vehicleRenderer.tyreAudio(id),
    )
    frameUi.updateFrame({
      dt,
      session,
      coop,
      vision,
      cam,
      w,
      h,
      playerGroundY,
      visChanged,
      windowMoved,
      localVehicle,
      vehicleRenderer: this.vehicleRenderer,
      botsLab,
    })
    outbreakClientFeatures.frameOverlay({ ...featureFrame, dt })
  }
}
