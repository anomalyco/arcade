import type { Camera } from "@arcade/kit/client/camera"
import type { LevelData } from "@arcade/kit/gpu/level"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import type { Batch, Renderer } from "@arcade/kit/gpu/renderer"
import { MAX_OCCLUDERS, OCC_FLOATS } from "@arcade/kit/limits"
import type { PeekInfo } from "../../shared/interact"
import { dayCycle } from "../../shared/day-cycle"
import { sightRects, type Building, type Town } from "../../shared/map"
import { SceneryMemory } from "../../shared/scenery-memory"
import type { LocalSession } from "../../shared/session"
import type { OutbreakVehicle } from "../../shared/vehicles"
import { FOG_SIZE, Vision } from "../../shared/vision"
import type { WorldMode } from "../../shared/world"
import { archSettings } from "../architecture"
import type { OutbreakCombatFX } from "../combat-fx"
import type { BeamLook } from "../discovery/flashlight"
import { CombinedFogMemory } from "../fog-of-war"
import { collectSconces } from "../interiors"
import { buildLevel, hex } from "../level"
import { easeNightSight, nightSightRange, nightSightTarget } from "../look/night-sight"
import { packLightOccluders, windowStateKey } from "../light-occluders"
import type { NetSession } from "../net-session"
import { resolveWorldMode, type OutbreakSettings } from "../settings"
import { syncVegetationBuild } from "../vegetation/settings"
import { useOriginBuild, WorldClientStreamer } from "../world-streamer"

export interface OutbreakSceneLevelHost {
  readonly renderer: Renderer
  readonly combatFx: OutbreakCombatFX
  readonly settings: OutbreakSettings
  readonly cam: Camera
  readonly session: () => LocalSession | NetSession
}

export interface OutbreakSceneLevelFrameInput {
  readonly drawn: { x: number; y: number }
  readonly activePeek: PeekInfo | null
  /** The peek sight looks through this frame (eased by `PeekView`), or null; defaults to the session's peek. */
  readonly visionPeek?: PeekInfo | null
  readonly view: readonly [number, number, number, number]
  readonly watch: { x: number; y: number } | null
  readonly localVehicle: OutbreakVehicle | undefined
  readonly drivingHeadlights: boolean
  readonly effectiveVisionAim: number
  readonly lowBeam: BeamLook
}

export interface OutbreakSceneLevelFrameResult {
  readonly mode: WorldMode
  readonly windowMoved: boolean
  readonly visChanged: boolean
}

function createDoorMesh(): Mesh {
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
    for (const [y0, y1] of [
      [0.38, 0.98],
      [1.08, 1.66],
      [1.76, 2.14],
    ] as const) {
      doorMesh.box(x, y0, 0.091, x + 0.5, y1, 0.112, hex(0x422e1e), MAT.timber)
      doorMesh.box(x + 0.04, y0 + 0.04, 0.113, x + 0.46, y1 - 0.04, 0.122, hex(0x23170e), MAT.timber)
    }
  }
  return doorMesh
}

function createSashMesh(): Mesh {
  const sashMesh = new Mesh()
  sashMesh.box(-1.0, 1.48, -0.06, 1.0, 2.12, 0.06, hex(0xa8a99c), MAT.wall)
  sashMesh.box(-0.92, 1.54, -0.02, 0.92, 2.06, 0.02, hex(0x809c9e), MAT.glass)
  return sashMesh
}

/**
 * Owns Outbreak's static level geometry, origin-build vs. streamed-window switching (`WorldClientStreamer`),
 * fog-of-war (`Vision` + `SceneryMemory` + `CombinedFogMemory`), cached light occluders/walls, and instanced
 * door/window sash batches.
 */
export class OutbreakSceneLevel {
  vision = new Vision()
  scenery = new SceneryMemory()
  readonly combinedFog = new CombinedFogMemory()
  readonly worldStreamer = new WorldClientStreamer()
  readonly occluders = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  currentWindowOrigin: [number, number] = [0, 0]
  currentIsStreamWindow = false
  originSconces: Float32Array[] = []
  vertices = 0
  /** Automation only: pin the origin build or the streamed window regardless of the camera (switch comparisons). */
  forcedLevel: "origin" | "streamed" | undefined
  blockers: readonly (readonly [number, number, number, number])[]
  revision = -1
  lightOccluders = 0
  /** Night sight's eased weight this frame (0 none, 1 full; `look/night-sight.ts`), for the lighting uniforms. */
  nightSightWeight = 0
  private nightSightTime = 0
  /** The vision settings the drawn sight uses this frame (headlights widen it). */
  visionSettings: { range: number; cone: number; awareness: number }
  private lightWindowKey = 0
  // Walls, closed doors and closed windows: what stops light (sight passes windows, light only open ones).
  lightWalls: readonly (readonly [number, number, number, number])[]
  private readonly doorData = new Float32Array(64 * 12)
  readonly doorBatch: Batch
  private readonly sashData = new Float32Array(64 * 12)
  readonly sashBatch: Batch

  constructor(private readonly host: OutbreakSceneLevelHost) {
    const { renderer, session } = host
    this.doorBatch = { model: renderer.addModel(createDoorMesh()), data: this.doorData, count: 0 }
    this.sashBatch = { model: renderer.addModel(createSashMesh()), data: this.sashData, count: 0 }
    this.blockers = sightRects(session().view.town)
    this.lightWalls = this.blockers
    this.visionSettings = host.settings.vision
  }

  private applyLevelData(data: LevelData): void {
    this.vertices = [...data.chunks, ...data.glass].reduce(
      (n, c) => n + ((c as { byteLength?: number }).byteLength ?? c.data.byteLength) / 24,
      0,
    )
    this.host.renderer.setLevel(data)
    this.host.combatFx.setLevel(data)
  }

  /** Draws the origin block with the authored origin build; its window origin matches the streamed (1,1) window. */
  showOriginBuild(): void {
    const town = this.host.session().view.town
    this.currentWindowOrigin = [0, 0]
    this.currentIsStreamWindow = false
    this.worldStreamer.center = { cx: 1, cy: 1 }
    this.worldStreamer.windowOrigin = [0, 0]
    this.worldStreamer.lastWindowKey = ""
    const data = buildLevel(town)
    this.originSconces = [collectSconces(town)]
    this.applyLevelData(data)
  }

  rebuildLevel(): void {
    const { settings, cam } = this.host
    const session = this.host.session()
    session.view.town.foliageDensity = settings.world.foliageDensity
    archSettings.houseDecay = settings.world.houseDecay
    archSettings.clutterDensity = settings.ground.clutterDensity
    archSettings.weathering = settings.world.weathering
    archSettings.clutterSeed = settings.ground.clutterSeed
    syncVegetationBuild(settings.vegetation)
    const mode = resolveWorldMode(settings.world.worldMode)
    session.sim.worldStream.mode = mode
    const p = session.view.player
    const inOriginBox = p.x >= 14 && p.x <= 82 && p.y >= 14 && p.y <= 82 && settings.view.zoom <= 50
    if (mode !== "procedural" && inOriginBox && session.sim.worldStream.isOriginNineOnly()) {
      this.showOriginBuild()
      return
    }
    this.worldStreamer.lastWindowKey = ""
    const streamed = this.worldStreamer.updateWindow(
      p.x,
      p.y,
      session.view.town,
      mode,
      cam.groundRect(5.5),
      p.vx,
      p.vy,
      session.view.time,
    )
    this.currentWindowOrigin = streamed.origin
    this.currentIsStreamWindow = true
    if (streamed.level) {
      this.applyLevelData(streamed.level)
    }
  }

  markTopologyDirty(): void {
    this.revision = -1
  }

  resetForSession(): void {
    this.vision = new Vision()
    this.worldStreamer.reset()
    this.currentWindowOrigin = [0, 0]
    this.currentIsStreamWindow = false
    this.revision = -1
    this.rebuildLevel()
    this.scenery = new SceneryMemory()
    this.combinedFog.reset()
    this.combinedFog.update(this.vision, this.scenery, true)
    this.host.renderer.setVisibility(this.combinedFog.filtered, FOG_SIZE, FOG_SIZE)
    this.host.renderer.clearVisibilityField()
  }

  stepFrame(input: OutbreakSceneLevelFrameInput): OutbreakSceneLevelFrameResult {
    const { settings, renderer } = this.host
    if (syncVegetationBuild(settings.vegetation)) this.rebuildLevel()
    const session = this.host.session()
    const { player: p, town, time, peek } = session.view
    const { drawn, activePeek, view, watch, localVehicle, drivingHeadlights, effectiveVisionAim, lowBeam } = input
    const mode = resolveWorldMode(settings.world.worldMode)
    session.sim.worldStream.mode = mode
    let windowMoved = false
    if (mode !== "classic") {
      const moveVx = localVehicle ? localVehicle.vx : p.vx
      const moveVy = localVehicle ? localVehicle.vy : p.vy
      const originBuild =
        this.forcedLevel !== "streamed" &&
        mode !== "procedural" &&
        session.sim.worldStream.isOriginNineOnly() &&
        (this.forcedLevel === "origin" ||
          useOriginBuild(!this.currentIsStreamWindow, drawn.x, drawn.y, view, settings.view.zoom))
      if (originBuild && this.currentIsStreamWindow && this.worldStreamer.center.cx === 1 && this.worldStreamer.center.cy === 1) {
        // Back inside the origin block: return to the authored build (same window origin, so fog and vision carry over).
        this.showOriginBuild()
      }
      if (originBuild && !this.currentIsStreamWindow) {
        // Pre-warm upcoming border chunks incrementally while inside the origin block
        this.worldStreamer.prewarmAround(
          drawn.x,
          drawn.y,
          town.seed,
          town.houseSeed,
          town.terrain,
          town.foliageDensity ?? 1,
          mode,
          moveVx,
          moveVy,
        )
        this.worldStreamer.stepBakeQueue(1.8)
      } else {
        const streamed = this.worldStreamer.updateWindow(
          activePeek ? activePeek.cutX : drawn.x,
          activePeek ? activePeek.cutY : drawn.y,
          town,
          mode,
          view,
          moveVx,
          moveVy,
          time,
        )
        this.currentWindowOrigin = streamed.origin
        this.currentIsStreamWindow = true
        if (streamed.changed && streamed.level) {
          this.applyLevelData(streamed.level)
          if (!streamed.geometryOnly) {
            windowMoved = this.vision.setWindowOrigin(streamed.origin[0], streamed.origin[1])
            this.scenery.setWindowOrigin(streamed.origin[0], streamed.origin[1], town)
            // The combined memory is indexed by window cell and only ever grows, so a moved window would keep the old
            // window's explored cells at their old indices: straight-edged ghost rectangles. Rebuild it from the
            // reloaded vision and scenery instead.
            if (windowMoved) this.combinedFog.reset()
            else this.combinedFog.markDirty()
          }
        }
      }
    }
    const windowKey = windowStateKey(town)
    if (this.revision !== session.view.revision || windowKey !== this.lightWindowKey) {
      this.revision = session.view.revision
      this.lightWindowKey = windowKey
      this.blockers = sightRects(town)
      const packed = packLightOccluders(town, this.blockers, this.occluders, MAX_OCCLUDERS - 4)
      this.lightOccluders = packed.count
      this.lightWalls = packed.walls
    }
    // Night sight: without a light at night, sight fades to dark a few metres out (Look › Night sight).
    const nightLit = drivingHeadlights ? 1 : Math.min(1, p.flashlightOutput * 4) * (settings.flashlight.flashlightIntensity > 0.01 ? 1 : 0)
    const nightTarget = watch ? 0 : nightSightTarget(settings.look, dayCycle(session.view.hour).darkness, nightLit)
    this.nightSightWeight = easeNightSight(this.nightSightWeight, nightTarget, time - this.nightSightTime)
    this.nightSightTime = time
    const effectiveVisionSettings = drivingHeadlights
      ? {
          ...settings.vision,
          range: Math.max(settings.vision.range, settings.vehicle.headlightRange + 4),
          cone: Math.max(settings.vision.cone, 130),
        }
      : settings.vision
    this.visionSettings = effectiveVisionSettings
    // The drawn sight keeps its full range (lit places far off stay in sight; the shader fades the rest), but who
    // and what counts as seen on the client stops where night sight goes dark.
    const actorVisionSettings =
      this.nightSightWeight > 0.001
        ? { ...effectiveVisionSettings, range: nightSightRange(effectiveVisionSettings.range, settings.look, this.nightSightWeight) }
        : effectiveVisionSettings
    const flashVisionActive =
      (drivingHeadlights || p.flashlightOutput > 0.01) &&
      (drivingHeadlights ? settings.vehicle.headlightPower * 0.85 : settings.flashlight.flashlightIntensity) > 0.01
    // Horde watch (Lab): the view travels with the horde, so it is what the camera shows that gets seen.
    const visChanged = this.vision.update(
      watch ? watch.x : p.x,
      watch ? watch.y : p.y,
      effectiveVisionAim,
      this.blockers,
      watch ? { ...effectiveVisionSettings, cone: 360, range: Math.max(effectiveVisionSettings.range, 40) } : actorVisionSettings,
      watch ? null : input.visionPeek !== undefined ? input.visionPeek : peek,
      flashVisionActive && !watch
        ? {
            active: true,
            range: drivingHeadlights ? settings.vehicle.headlightRange : lowBeam.range,
            cone: drivingHeadlights ? 68 : lowBeam.cone,
            aim: effectiveVisionAim,
          }
        : null,
    )
    if (this.scenery.update(town, this.vision) || visChanged || windowMoved) {
      this.combinedFog.markDirty()
      this.combinedFog.update(this.vision, this.scenery, true)
      renderer.setVisibility(this.combinedFog.filtered, FOG_SIZE, FOG_SIZE)
    }
    return { mode, windowMoved, visChanged }
  }

  /** The flashlight also sees actors as round casters, so zombies and other survivors cut its pool and its shaft. */
  packFlashlightActorCasters(
    px: number,
    py: number,
    flashlightOutput: number,
    zombies: readonly { x: number; y: number; state: string }[],
    otherPositions: Iterable<readonly [number, number]>,
  ): number {
    let frameLightOccluders = this.lightOccluders
    if (flashlightOutput > 0.001) {
      const range = this.host.settings.flashlight.flashlightRange
      const casters = (x: number, y: number) => {
        if (frameLightOccluders >= MAX_OCCLUDERS - 4 || frameLightOccluders - this.lightOccluders >= 16) return
        if (Math.hypot(x - px, y - py) > range) return
        this.occluders.set([x, y, 0.27, 0, 1.72, 1, 0, 0], frameLightOccluders++ * OCC_FLOATS)
      }
      for (const z of zombies) if (z.state !== "dead") casters(z.x, z.y)
      for (const o of otherPositions) casters(o[0], o[1])
    }
    return frameLightOccluders
  }

  inInteriorView(town: Town, cutX: number, cutY: number): boolean {
    for (let i = 0; i < town.buildings.length; i++) {
      const b = town.buildings[i]!
      if (cutX > b.rect[0] - 0.1 && cutX < b.rect[2] + 0.1 && cutY > b.rect[1] - 0.1 && cutY < b.rect[3] + 0.1) {
        return true
      }
    }
    if (this.currentIsStreamWindow) {
      const wb = this.worldStreamer.windowBuildings
      for (let i = 0; i < wb.length; i++) {
        const b = wb[i]!
        if (cutX > b.rect[0] - 0.1 && cutX < b.rect[2] + 0.1 && cutY > b.rect[1] - 0.1 && cutY < b.rect[3] + 0.1) {
          return true
        }
      }
    }
    return false
  }

  activeBuildings(town: Town): readonly Building[] {
    return this.currentIsStreamWindow ? this.worldStreamer.windowBuildings : town.buildings
  }

  activeSconces(): readonly Float32Array[] {
    return this.currentIsStreamWindow ? this.worldStreamer.windowSconces : this.originSconces
  }

  updateOpeningBatches(town: Town): { doorBatch: Batch; sashBatch: Batch; openWindows: number } {
    let doorCount = 0
    for (let i = 0; i < town.doors.length && doorCount < 64; i++) {
      const door = town.doors[i]!
      const o = doorCount++ * 12
      this.doorData[o] = door.rect[0]
      this.doorData[o + 1] = 0
      this.doorData[o + 2] = (door.rect[1] + door.rect[3]) / 2
      this.doorData[o + 3] = (door as { angle?: number }).angle ?? (door.open ? -Math.PI / 2 : 0)
      this.doorData[o + 4] = 1
      this.doorData[o + 5] = 1
      this.doorData[o + 6] = 1
      this.doorData[o + 7] = 1
      this.doorData[o + 8] = 0
      this.doorData[o + 9] = 0
      this.doorData[o + 10] = 1
      this.doorData[o + 11] = 0
    }
    this.doorBatch.count = doorCount
    let openWindows = 0
    for (let i = 0; i < town.windows.length; i++) {
      const win = town.windows[i]!
      if (!win.open || openWindows >= 64) continue
      const [wx0, wy0, wx1, wy1] = win.rect
      const horizontal = wx1 - wx0 > wy1 - wy0
      const yaw = horizontal ? 0 : Math.PI / 2
      const o = openWindows++ * 12
      this.sashData[o] = (wx0 + wx1) / 2
      this.sashData[o + 1] = 0.38
      this.sashData[o + 2] = (wy0 + wy1) / 2
      this.sashData[o + 3] = yaw
      this.sashData[o + 4] = 1
      this.sashData[o + 5] = 1
      this.sashData[o + 6] = 1
      this.sashData[o + 7] = 1
      this.sashData[o + 8] = 0
      this.sashData[o + 9] = 0
      this.sashData[o + 10] = 1
      this.sashData[o + 11] = 0
    }
    this.sashBatch.count = openWindows
    return { doorBatch: this.doorBatch, sashBatch: this.sashBatch, openWindows }
  }
}
