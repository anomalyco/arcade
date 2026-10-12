// World rendering — owned by the World agent.
// "BRIGHT STYLIZED": smooth-shaded streamed terrain (generated in a Web Worker), stylised ocean,
// clean blue sky with soft cumulus, round-canopy trees, clean airbases and safe-zone domes.
// Installs the scene's sun (with a camera-following soft shadow map) + hemisphere fill and fog.
import {
  Color, DirectionalLight, Fog, Group, HemisphereLight, MeshLambertMaterial, Vector3,
  type Object3D, type Scene, type WebGLRenderer,
} from "three"
import type { Quality } from "../sim/types"
import { createFleet, type TurretHandle } from "./world/ships"
import { createBoundary } from "./world/boundary"
import {
  FOG_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY, HEMI_SKY_COLOR, SHADOW_MAP_SIZE, SHADOW_RADIUS, SUN_COLOR, SUN_INTENSITY,
} from "./world/palette"
import { SUN_DIRECTION, WORLD_QUALITY } from "./world/settings"
import { createClouds, createSky } from "./world/sky"
import { TerrainStreamer, type StreamerStats } from "./world/streamer"
import { createTreeResources } from "./world/trees"
import { createWater } from "./world/water"

export interface WorldView {
  /** Add to the scene once. Contains terrain, water, sky, runways, base props, safe-zone domes, lights. */
  root: Object3D
  /** Stream LODs around the camera. Budgeted (≤ ~2 ms CPU per call). time in seconds. */
  update(cameraPosition: Vector3, dt: number, time: number): void
  setQuality(quality: Quality): void
  /** Show/hide a team's safe-zone dome (e.g. highlight own base). */
  setHighlightTeam(team: number | null): void
  /** True once terrain near the last camera position is generated. */
  ready(): boolean
  /** Camera far plane recommended for this quality. */
  far: number
  /**
   * Centre the sun's shadow map on a point (usually the player's aircraft). If not called for a
   * while, shadows follow the camera.
   */
  setShadowFocus(position: Vector3): void
  /** Aimable pivots of a ship turret (ids from fleet.ts): set yaw.rotation.y / pitch.rotation.x. */
  getShipTurret(shipId: string, turretId: string): TurretHandle | null
  dispose(): void
}

export type { TurretHandle }

/** Extra diagnostics for dev tools / preview pages. */
export interface WorldViewDebug extends WorldView {
  stats(): StreamerStats & { shoreProgress: number }
  streamer: TerrainStreamer
}

let activeView: WorldView | null = null

/** Module-level convenience: centre the active world's shadow map on a point. */
export function setShadowFocus(position: Vector3) {
  activeView?.setShadowFocus(position)
}

/** Module-level convenience: aimable pivots of a ship turret in the active world. */
export function getShipTurret(shipId: string, turretId: string): TurretHandle | null {
  return activeView?.getShipTurret(shipId, turretId) ?? null
}

export function createWorldView(renderer: WebGLRenderer, scene: Scene, quality: Quality): WorldView {
  let settings = WORLD_QUALITY[quality]
  let currentQuality = quality
  const root = new Group()
  root.name = "World"

  const hemi = new HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY)
  const sun = new DirectionalLight(SUN_COLOR, SUN_INTENSITY)
  sun.position.copy(SUN_DIRECTION).multiplyScalar(1000)
  sun.target.position.set(0, 0, 0)
  root.add(hemi, sun, sun.target)

  // Soft sun shadows around a focus point. The renderer owner enables renderer.shadowMap.
  void renderer
  const shadowFocus = new Vector3()
  let focusSetAt = -Infinity
  let elapsed = 0
  function configureShadows(q: Quality) {
    const size = SHADOW_MAP_SIZE[q], radius = SHADOW_RADIUS[q]
    sun.castShadow = size > 0
    if (!sun.castShadow) return
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.map?.dispose()
      sun.shadow.map = null
      sun.shadow.mapSize.set(size, size)
    }
    const cam = sun.shadow.camera
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius
    cam.near = 10; cam.far = 4000
    cam.updateProjectionMatrix()
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.6
    sun.shadow.radius = 3
  }
  configureShadows(quality)
  const sunOffset = SUN_DIRECTION.clone().multiplyScalar(2000)
  const snap = new Vector3()
  function placeShadow(p: Vector3) {
    // Snap to whole shadow texels (in the light's plane) so shadows don't shimmer while moving.
    const size = SHADOW_MAP_SIZE[currentQuality]
    const texel = size > 0 ? (2 * SHADOW_RADIUS[currentQuality]) / size : 1
    snap.copy(p)
    snap.x = Math.round(snap.x / texel) * texel
    snap.z = Math.round(snap.z / texel) * texel
    snap.y = Math.round(snap.y / texel) * texel
    sun.target.position.copy(snap)
    sun.position.copy(snap).add(sunOffset)
    sun.target.updateMatrixWorld()
    sun.updateMatrixWorld()
  }

  const fog = new Fog(new Color(FOG_COLOR), settings.fogNear, settings.fogFar)
  const previousFog = scene.fog, previousBackground = scene.background
  scene.fog = fog
  scene.background = new Color(FOG_COLOR)

  const terrainMaterial = new MeshLambertMaterial({ vertexColors: true, toneMapped: false })
  terrainMaterial.name = "World · terrain"
  const trees = createTreeResources()
  const water = createWater()
  water.mesh.receiveShadow = false
  const sky = createSky()
  const boundary = createBoundary()
  const fleet = createFleet()
  let clouds = createClouds(settings.clouds)
  const streamer = new TerrainStreamer(settings, terrainMaterial, trees, (z0, _z1, rows) => water.writeRows(z0, rows))

  root.add(sky.mesh, water.mesh, streamer.terrainRoot, streamer.treeRoot, fleet.root, clouds.mesh, boundary.mesh)

  const view: WorldViewDebug = {
    root,
    far: settings.far,
    update(cameraPosition, dt, time) {
      elapsed += Math.max(0, dt)
      fog.near = Math.min(settings.fogNear + Math.max(0, cameraPosition.y) * 1.5, settings.fogFar * 0.6)
      if (elapsed - focusSetAt > 0.5) shadowFocus.copy(cameraPosition)
      if (sun.castShadow) placeShadow(shadowFocus)
      sky.update(cameraPosition, time)
      water.update(time)
      fleet.update()
      boundary.update(time)
      streamer.update(cameraPosition, Math.max(0, Math.min(dt, 0.5)))
    },
    setShadowFocus(position) {
      shadowFocus.copy(position)
      focusSetAt = elapsed
    },
    setQuality(q) {
      if (WORLD_QUALITY[q] === settings) return
      settings = WORLD_QUALITY[q]
      currentQuality = q
      view.far = settings.far
      fog.near = settings.fogNear
      fog.far = settings.fogFar
      configureShadows(q)
      streamer.setSettings(settings)
      root.remove(clouds.mesh)
      clouds.dispose()
      clouds = createClouds(settings.clouds)
      root.add(clouds.mesh)
    },
    // Safe-zone domes were removed with the airbases (strike groups use AA + spawn protection).
    setHighlightTeam(_team) {},
    getShipTurret: (shipId, turretId) => fleet.getShipTurret(shipId, turretId),
    ready: () => streamer.ready(),
    stats: () => ({ ...streamer.stats, shoreProgress: streamer.shoreProgress }),
    streamer,
    dispose() {
      if (activeView === view) activeView = null
      streamer.dispose()
      water.dispose(); sky.dispose(); boundary.dispose(); fleet.dispose(); clouds.dispose()
      trees.dispose(); terrainMaterial.dispose()
      sun.shadow.map?.dispose()
      root.removeFromParent()
      if (scene.fog === fog) scene.fog = previousFog
      scene.background = previousBackground
    },
  }
  activeView = view
  return view
}
