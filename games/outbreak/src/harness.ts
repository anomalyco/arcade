import type { Camera } from "@arcade/kit/client/camera"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { LabControl, LabPanel } from "@arcade/kit/lab-panel"
import {
  applyLookPreset,
  resolveLookPresetId,
  type LookCompareMode,
  type LookPresetId,
  type LookSettings,
} from "@arcade/kit/look"
import type { AIState } from "../shared/ai"
import { dayCycle } from "../shared/day-cycle"
import { flashlightColor } from "../shared/flashlight"
import type { Command, LocalSession } from "../shared/session"
import { supportHeight } from "../shared/terrain"
import type { Vision } from "../shared/vision"
import { districtAtChunk, worldToChunk } from "../shared/world"
import type { OutbreakAudio } from "./audio"
import type { OutbreakCombatFX } from "./combat-fx"
import type { CoopView } from "./coop-view"
import { applyOutbreakDayNight } from "./day-night"
import type { OutbreakFeelTracker } from "./feel-events"
import type { OutbreakHud } from "./hud"
import { OUTBREAK_LOOK_LIGHTING_PRESETS } from "./lighting"
import type { NetSession } from "./net-session"
import { stageProgression, type ProgressionLabHost, type ProgressionScene } from "./progression-lab"
import {
  applyOutbreakPreset,
  exportOutbreakPreset,
  resolveOutbreakSettingTarget,
  resolveWorldMode,
  setOutbreakSetting,
  type OutbreakSettings,
} from "./settings"
import type { Survivor } from "./survivor"
import type { OutbreakVehicleAudio } from "./vehicle-audio"
import { stageVehicleScene, type VehicleLabHost, type VehicleScene } from "./vehicle-lab"
import {
  applyOutbreakWeatherPreset,
  toSharedWeatherSettings,
  type OutbreakWeatherController,
} from "./weather"
import type { WorldClientStreamer } from "./world-streamer"

export interface OutbreakHarnessHost {
  readonly adapter: GPUAdapter
  readonly device: GPUDevice
  readonly renderer: Renderer
  readonly session: () => LocalSession | NetSession
  readonly vision: () => Vision
  readonly avatar: () => Survivor
  readonly cam: Camera
  readonly settings: OutbreakSettings
  readonly lookSettings: LookSettings
  readonly lookCompare: { mode: LookCompareMode; wipeSplit: number }
  readonly controls: readonly LabControl[]
  readonly lab: LabPanel
  readonly feelTracker: OutbreakFeelTracker
  readonly combatFx: OutbreakCombatFX
  readonly weatherController: OutbreakWeatherController
  readonly worldStreamer: WorldClientStreamer
  readonly hud: OutbreakHud
  readonly coop: CoopView
  readonly audio: OutbreakAudio
  readonly vehicleAudio: OutbreakVehicleAudio
  readonly progressionHost: ProgressionLabHost
  readonly vehicleHost: VehicleLabHost
  readonly promptEl: HTMLElement | null
  readonly getPeekBlend: () => number
  readonly resetPeek: () => void
  readonly getVertices: () => number
  readonly getWindowState: () => { origin: [number, number]; isStream: boolean }
  readonly reset: (nextSeed?: number) => void
  readonly setFrozen: (value: boolean) => void
  readonly onSettingChanged: (rawKey: string, value?: number | boolean | string) => void
  readonly setLastDayNightHour: (hour: number) => void
  readonly incrementFrames: () => void
  readonly draw: (dt: number) => void
}

export function createOutbreakHarness(host: OutbreakHarnessHost) {
  const {
    adapter,
    device,
    renderer,
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
  } = host

  const harness = {
    ready: true,
    adapterInfo: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
    human: () => {
      const avatar = host.avatar()
      return {
        profile: avatar.profile,
        bones: avatar.bones,
        gun: avatar.gun,
        mag: avatar.mag,
        aimWeight: avatar.aimWeight,
        holdRemaining: avatar.holdRemaining,
      }
    },
    setLegacyPistol: (legacy: boolean) => {
      const avatar = host.avatar()
      avatar.legacyUnarmedPistol = legacy
      avatar.reset()
    },
    setZoomRaw: (zoom: number) => {
      settings.view.zoom = zoom
      cam.dist = zoom
    },
    state: () => {
      const session = host.session()
      const vision = host.vision()
      const dc = dayCycle(session.view.hour)
      const winState = host.getWindowState()
      const impulseState = feelTracker.inspect()
      return {
        ...session.view,
        peekBlend: host.getPeekBlend(),
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
        pacing: { ...session.ai.pacing.telemetry },
        flashlight: {
          on: session.view.player.flashlightOn,
          battery: session.view.player.battery,
          depleted: session.view.player.batteryDepleted,
          output: session.view.player.flashlightOutput,
          signature: session.view.player.lightSignature,
          cone: settings.flashlight.flashlightCone,
          range: settings.flashlight.flashlightRange,
          intensity: settings.flashlight.flashlightIntensity,
          color: flashlightColor(settings.flashlight.flashlightWarmth),
        },
        explored: vision.exploredCount,
        vertices: host.getVertices(),
        splatter: combatFx.splatter?.inspect() ?? null,
        ground: { ...settings.ground },
        weather: {
          enabled: settings.weather.weatherEnabled,
          preset: settings.weather.weatherPreset,
          settings: toSharedWeatherSettings(settings.weather),
          state: { ...weatherController.sim.state },
        },
        camera: {
          shakeScale: settings.view.shakeScale,
          kickScale: settings.view.kickScale,
          damageFlashScale: settings.view.damageFlashScale,
          reduceMotion: cam.isReducedMotion(),
          ...impulseState,
        },
        world: {
          mode: resolveWorldMode(settings.world.worldMode),
          chunk: worldToChunk(session.view.player.x, session.view.player.y),
          district: districtAtChunk(
            session.view.town.seed,
            Math.floor(session.view.player.x / 32),
            Math.floor(session.view.player.y / 32),
          ),
          windowOrigin: winState.origin,
          isStreamWindow: winState.isStream,
          activeChunks: [...session.sim.worldStream.activeChunks.keys()],
          cachedRenderChunks: worldStreamer.cachedChunkCount,
          pendingBakes: worldStreamer.pendingBakeCount,
          bakeStepsCompleted: worldStreamer.bakeStepsCompleted,
          lastBakeMs: worldStreamer.lastBakeMs,
          deltasCount: session.sim.worldStream.deltas.size,
        },
        vehicles: session.view.vehicles.map((v) => ({
          id: v.id,
          kind: v.kind,
          label: v.spec.label,
          x: v.x,
          y: v.y,
          h: v.h,
          vx: v.vx,
          vy: v.vy,
          speed: Math.hypot(v.vx, v.vy),
          hp: v.hp,
          maxHp: v.maxHp,
          fuel: v.fuel,
          maxFuel: v.maxFuel,
          hasBattery: v.hasBattery,
          hasKeys: v.hasKeys,
          headlights: v.headlights,
          engineOn: v.engineOn,
          horn: v.horn,
          wreck: v.wreck,
          seats: [...v.seats],
          zombieHits: v.zombieHits,
          zombieKills: v.zombieKills,
          grabbingZombies: v.grabbingZombies,
          bangCount: v.bangCount,
        })),
      }
    },
    triggerImpulse(kind: "shot" | "shove" | "hit-taken" | "explosion", opts?: { power?: number; damage?: number }) {
      const p = host.session().view.player
      return feelTracker.triggerImpulse(kind, p, opts)
    },
    fog: (x: number, y: number) => host.vision().state(x, y),
    callouts: () =>
      hud.layer.model.items.map((c) => ({
        actor: c.actorId,
        text: c.text,
        kind: c.kind,
        slot: c.slot,
        progress: c.progress,
      })),
    coop: () => coop.inspect(),
    audio: () => ({ ...audio.telemetry(), vehicle: { ...vehicleAudio.counts } }),
    hudState: () => hud.inspect(),
    reset: host.reset,
    freeze: (value = true) => host.setFrozen(value),
    setLab(rawKey: string, value: number | boolean | string) {
      const routed = resolveOutbreakSettingTarget(String(rawKey))
      const control = controls.find(
        (c) =>
          c.key === rawKey ||
          c.legacyKeys?.includes(String(rawKey)) ||
          (routed &&
            resolveOutbreakSettingTarget(c.key)?.subsystem === routed.subsystem &&
            resolveOutbreakSettingTarget(c.key)?.field === routed.field),
      )
      if (!control || !routed) throw new Error(`Invalid lab key: ${String(rawKey)}`)
      if (typeof value !== "boolean") {
        if (
          "min" in control
            ? typeof value !== "number" || !Number.isFinite(value) || value < control.min || value > control.max
            : "options" in control && !control.options.some((o) => o.value === value)
        ) {
          throw new Error(`Invalid lab value: ${String(rawKey)}`)
        }
      }
      setOutbreakSetting(settings, control.key, value)
      host.onSettingChanged(control.key, value)
    },
    exportPreset: () => exportOutbreakPreset(settings),
    importPreset: (raw: unknown) => {
      const res = applyOutbreakPreset(settings, raw)
      if (res.ok) lab.refresh()
      return res
    },
    setWeatherPreset(preset: string) {
      const applied = applyOutbreakWeatherPreset(settings.weather, preset)
      lab.refresh()
      return applied
    },
    strikeLightning(seed?: number) {
      return weatherController.strikeNow(seed)
    },
    setLookPreset(preset: LookPresetId | string) {
      const session = host.session()
      const pid = resolveLookPresetId(preset)
      if (!pid) throw new Error(`Unknown look preset: ${preset}`)
      settings.dayCycle.lookPreset = pid
      applyLookPreset(lookSettings, pid)
      Object.assign(settings.lighting, OUTBREAK_LOOK_LIGHTING_PRESETS[pid])
      if (settings.dayCycle.dayNightLook === 1 && pid === "noir") {
        host.setLastDayNightHour(session.view.hour)
        applyOutbreakDayNight(session.view.hour, lookSettings, settings)
      }
      lab.refresh()
      return { ...lookSettings }
    },
    setLook(patch: Partial<LookSettings>) {
      const session = host.session()
      Object.assign(lookSettings, patch)
      if (patch.preset) settings.dayCycle.lookPreset = patch.preset
      host.setLastDayNightHour(session.view.hour)
      lab.refresh()
      return { ...lookSettings }
    },
    setLookCompare(mode: LookCompareMode, wipeSplit = 0.5) {
      lookCompare.mode = mode
      lookCompare.wipeSplit = wipeSplit
    },
    getLook: () => ({ ...lookSettings }),
    pose(x: number, y: number, aim: number) {
      const session = host.session()
      session.sim.vehicles.leaveSeat(session.view.actorId, session.view.player)
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
      host.resetPeek()
      session.rebuildCollision()
      host.avatar().reset()
      cam.snap(x, y)
      cam.dist = settings.view.zoom
    },
    /** Sets loaded rounds and, optionally, belt counts (`{ ammo: 4, plank: 3 }`) through the progression ledger. */
    stock(loaded?: number, belt: Record<string, number> = {}) {
      const session = host.session()
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
    /** Stages a Lab scene (`progression.stage`): search, strip, bench, dark-bench, generator, field-craft, handoff. */
    stageProgression(scene: ProgressionScene) {
      stageProgression(progressionHost, scene)
    },
    /** Stages a vehicle scene (`vehicle.stage`): driveway, night-headlights, need-battery, need-keys, police-cruiser, horde-runover. */
    stageVehicle(scene: VehicleScene) {
      stageVehicleScene(vehicleHost, scene)
    },
    /** Stages a first-night pacing scene (`pacing.stage`). */
    stagePacing(scene: string) {
      const session = host.session()
      session.ai.noiseBus.reset()
      session.view.notices.length = 0
      hud.reset()
      if (scene === "legacy-rush") {
        settings.ai.directorPacing = 0
        settings.ai.safeRadius = 3.5
        settings.ai.initialDensity = 1.0
        settings.ai.startHour = 18.0
        settings.dayCycle.hour = 18.0
        session.view.hour = 18.0
        Object.assign(session.ai.config, settings.ai)
        session.ai.resetOpeningPopulation(session.view.town, session.sim.slots.map((s) => s.survivor))
        harness.pose(27.7, 41, -Math.PI / 2)
      } else if (scene === "safehouse-workbench") {
        settings.ai.directorPacing = 1
        settings.ai.safeRadius = 20
        settings.ai.initialDensity = 0.25
        settings.ai.startHour = 16.0
        settings.dayCycle.hour = 16.8
        session.view.hour = 16.8
        Object.assign(session.ai.config, settings.ai)
        session.ai.resetOpeningPopulation(session.view.town, session.sim.slots.map((s) => s.survivor))
        stageProgression(progressionHost, "bench")
        settings.dayCycle.hour = 16.8
        session.view.hour = 16.8
      } else if (scene === "first-contact") {
        settings.ai.directorPacing = 1
        settings.ai.safeRadius = 20
        settings.ai.initialDensity = 0.25
        settings.dayCycle.hour = 17.85
        session.view.hour = 17.85
        Object.assign(session.ai.config, settings.ai)
        session.ai.resetOpeningPopulation(session.view.town, session.sim.slots.map((s) => s.survivor))
        harness.pose(29.5, 41.2, 0)
        const s1 = session.ai.spawnZombie(session.view.town, 37.8, 41.8, "investigate", Math.PI)
        const s2 = session.ai.spawnZombie(session.view.town, 39.2, 43.4, "investigate", Math.PI - 0.15)
        s1.targetX = 31.0
        s1.targetY = 41.2
        s2.targetX = 31.5
        s2.targetY = 42.0
        session.ai.pacing.firstEncounterStage = "staged"
      } else if (scene === "late-night-horde") {
        settings.ai.directorPacing = 1
        settings.ai.safeRadius = 20
        settings.ai.initialDensity = 0.25
        settings.ai.maxActiveNearPlayer = 4
        settings.dayCycle.hour = 22.5
        session.view.hour = 22.5
        session.view.time = 420
        Object.assign(session.ai.config, settings.ai)
        session.ai.syncPopulation(session.view.town, 44, 44)
        harness.pose(41.5, 43.5, 0)
        session.ai.emitNoise(41.5, 43.5, 34, "gunshot", session.view.time, "player", 2.0)
        for (const [zx, zy] of [
          [48.2, 42.6],
          [49.4, 44.5],
          [47.5, 45.8],
          [51.0, 43.2],
        ] as const) {
          const z = session.ai.spawnZombie(session.view.town, zx, zy, "chase", Math.PI)
          z.targetX = 41.5
          z.targetY = 43.5
        }
      } else {
        settings.ai.directorPacing = 1
        settings.ai.safeRadius = 20
        settings.ai.initialDensity = 0.25
        settings.ai.startHour = 16.0
        settings.dayCycle.hour = 16.0
        session.view.hour = 16.0
        Object.assign(session.ai.config, settings.ai)
        session.ai.resetOpeningPopulation(session.view.town, session.sim.slots.map((s) => s.survivor))
        harness.pose(27.7, 41, -Math.PI / 2)
      }
      if (settings.dayCycle.dayNightLook === 1 && settings.dayCycle.lookPreset === "noir") {
        host.setLastDayNightHour(session.view.hour)
        applyOutbreakDayNight(session.view.hour, lookSettings, settings)
      }
      lab.refresh()
      return { scene, pacing: { ...session.ai.pacing.telemetry }, hour: session.view.hour }
    },
    /** Gives the local survivor an item, routed to belt, hand or pack. */
    give(item: string, count = 1) {
      const session = host.session()
      return session.view.progression.ledger.apply({ kind: "grant", actor: session.view.actorId, item, count }).ok
    },
    spawnZombie(x: number, y: number, state: AIState = "wander", aim?: number) {
      const session = host.session()
      const z = session.ai.spawnZombie(session.view.town, x, y, state, aim)
      settings.ai.zombieCount = session.view.zombies.filter((a) => a.state !== "dead").length
      return z
    },
    setZombieState(state: AIState, id?: number) {
      const session = host.session()
      const p = session.view.player
      return session.ai.setZombieState(state, p.x, p.y, id)
    },
    makeNoise(x: number, y: number, radius = 18, kind = "glass") {
      const session = host.session()
      return session.ai.emitNoise(x, y, radius, kind, session.view.time, "player")
    },
    resolveTargetRect(target: { objectId?: string; world?: [number, number, number]; selector?: string }) {
      const session = host.session()
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
      const session = host.session()
      while (renderer.inflight > 0 || renderer.hasPending) {
        await Promise.resolve()
        await device.queue.onSubmittedWorkDone()
      }
      session.update(
        dt,
        { mx: 0, my: 0, aim: session.view.player.aim, interact: false, ...command },
        settings.dayCycle.timeScale,
        settings,
      )
      host.incrementFrames()
      host.draw(dt)
      await Promise.resolve()
      while (renderer.inflight > 0 || renderer.hasPending) {
        await device.queue.onSubmittedWorkDone()
        await Promise.resolve()
      }
      return harness.state()
    },
  }
  return harness
}

export type OutbreakHarness = ReturnType<typeof createOutbreakHarness>
