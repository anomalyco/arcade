import type { Camera } from "@arcade/kit/client/camera"
import type { FrameInput, Renderer } from "@arcade/kit/gpu/renderer"
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
import { sightRects } from "../shared/map"
import type { Command, LocalSession } from "../shared/session"
import { supportHeight } from "../shared/terrain"
import type { Vision } from "../shared/vision"
import { districtAtChunk, worldToChunk } from "../shared/world"
import type { OutbreakAudio } from "./audio"
import type { OutbreakCombatFX } from "./combat-fx"
import type { CoopView } from "./coop-view"
import { applyOutbreakDayNight } from "./day-night"
import { outbreakClientFeatures } from "./feature-registry"
import type { OutbreakFeelTracker } from "./feel-events"
import type { OutbreakHud } from "./hud"
import { OUTBREAK_LOOK_LIGHTING_PRESETS } from "./lighting"
import type { OutbreakMap } from "./map"
import "./melee/index"
import type { NetSession } from "./net-session"
import { type ProgressionLabHost } from "./progression-lab"
import {
  applyOutbreakPreset,
  exportOutbreakPreset,
  resolveOutbreakSettingTarget,
  resolveWorldMode,
  setOutbreakSetting,
  type OutbreakSettings,
} from "./settings"
import type { Survivor } from "./survivor"
import { evaluateUnseenFrame } from "./unseen"
import type { OutbreakVehicleAudio } from "./vehicle-audio"
import { type VehicleLabHost } from "./vehicles/index"
import type { OutbreakWeatherController } from "./weather"
import type { InteriorPresenter } from "./interiors"
import type { WorldClientStreamer } from "./world-streamer"

export interface OutbreakHarnessHost {
  readonly adapter: GPUAdapter
  readonly device: GPUDevice
  readonly renderer: Renderer
  readonly render: FrameInput
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
  readonly map?: OutbreakMap
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
  /** Rugs and themed interiors, and the level rebuild a structural interior change needs. */
  readonly interiors: InteriorPresenter
  readonly rebuildLevel: () => void
}

export function createOutbreakHarness(host: OutbreakHarnessHost) {
  const {
    adapter,
    device,
    renderer,
    render,
    cam,
    settings,
    lookSettings,
    lookCompare,
    controls,
    lab,
    feelTracker,
    combatFx,
    worldStreamer,
    hud,
    coop,
    audio,
    vehicleAudio,
    promptEl,
  } = host

  const harness = {
    ready: true,
    adapterInfo: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
    renderer,
    render,
    lab,
    session: () => host.session(),
    vision: () => host.vision(),
    measureCpuMask(iterations = 200) {
      const session = host.session()
      const vision = host.vision()
      const p = session.view.player
      const blockers = sightRects(session.view.town)
      const dc = dayCycle(session.view.hour)
      const t0 = performance.now()
      for (let i = 0; i < iterations; i++) {
        const angle = p.aim + (i % 16) * 0.02
        vision.update(
          p.x,
          p.y,
          angle,
          blockers,
          settings.vision,
          null,
          {
            active: p.flashlightOutput > 0.01,
            range: settings.flashlight.flashlightRange,
            cone: settings.flashlight.flashlightCone,
            aim: angle,
          },
        )
        evaluateUnseenFrame(settings.unseen, dc.darkness, p.health, p.maxHealth)
      }
      const elapsed = performance.now() - t0
      return Number((elapsed / Math.max(1, iterations)).toFixed(4))
    },
    human: () => {
      const avatar = host.avatar()
      return {
        profile: avatar.profile,
        bones: avatar.bones,
        gun: avatar.gun,
        mag: avatar.mag,
        meleeWeaponFrame: avatar.meleeWeaponFrame,
        meleeTip: avatar.meleeTip,
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
        unseen: {
          ...settings.unseen,
          ...evaluateUnseenFrame(settings.unseen, dc.darkness, session.view.player.health, session.view.player.maxHealth),
        },
        vertices: host.getVertices(),
        splatter: combatFx.splatter?.inspect() ?? null,
        ground: { ...settings.ground },
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
          viewRect: cam.groundRect(5.5),
          windowBuildings: (winState.isStream ? worldStreamer.windowBuildings : session.view.town.buildings)
            .filter((b) => b.id !== "")
            .map((b) => ({ id: b.id, kind: b.kind, archetype: b.archetype ?? b.kind, rect: b.rect })),
          activeChunks: [...session.sim.worldStream.activeChunks.keys()],
          cachedRenderChunks: worldStreamer.cachedChunkCount,
          pendingBakes: worldStreamer.pendingBakeCount,
          bakeStepsCompleted: worldStreamer.bakeStepsCompleted,
          lastBakeMs: worldStreamer.lastBakeMs,
          deltasCount: session.sim.worldStream.deltas.size,
        },
        ...outbreakClientFeatures.collectHarnessState(host),
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
    /** Rugs and themed interiors: pool readiness and memory, and a setter for their Lab keys. */
    interiors: () => ({ ...host.interiors.pool.stats, settled: host.interiors.pool.settled, bytes: host.interiors.pool.bytes, settings: { ...host.interiors.settings } }),
    setInterior(key: string, value: number) {
      if (!(key in host.interiors.settings)) throw new Error(`Invalid interior key: ${key}`)
      ;(host.interiors.settings as Record<string, number>)[key] = value
      if (host.interiors.apply(key) === "structural") host.rebuildLevel()
    },
    setLab(rawKey: string, value: number | boolean | string) {
      if (rawKey in host.interiors.settings) return harness.setInterior(rawKey, Number(value))
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
  Object.assign(harness, outbreakClientFeatures.collectHarnessMethods(host, harness))
  return harness
}

export type OutbreakHarness = ReturnType<typeof createOutbreakHarness>
