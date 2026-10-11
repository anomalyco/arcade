// World rendering — owned by the World agent.
// Streams terrain LOD tiles (generated in a Web Worker), draws the ocean, sky, clouds, airbases,
// safe-zone domes and the map boundary, and installs the scene's sun + hemisphere lights and fog.
import {
  Color, DirectionalLight, Fog, Group, HemisphereLight, type Object3D, type Scene, type Vector3, type WebGLRenderer,
} from "three"
import type { Quality } from "../sim/types"
import { createAirbases } from "./world/airbase"
import { createBoundary } from "./world/boundary"
import { PALETTE, SUN_DIRECTION, WORLD_QUALITY } from "./world/settings"
import { createClouds, createSky } from "./world/sky"
import { TerrainStreamer, type StreamerStats } from "./world/streamer"
import { createLightingUniforms, createTerrainMaterial } from "./world/terrain-material"
import { createToonRamp, createTreeResources } from "./world/trees"
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
  dispose(): void
}

/** Extra diagnostics for dev tools / preview pages. */
export interface WorldViewDebug extends WorldView {
  stats(): StreamerStats & { shoreProgress: number }
  streamer: TerrainStreamer
}

const SUN_INTENSITY = 2.9
const HEMI_INTENSITY = 1.5

export function createWorldView(renderer: WebGLRenderer, scene: Scene, quality: Quality): WorldView {
  void renderer
  let settings = WORLD_QUALITY[quality]
  const root = new Group()
  root.name = "World"

  // Scene lights used by aircraft and toon props; terrain/water shaders mirror the same values.
  const hemi = new HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, HEMI_INTENSITY)
  const sun = new DirectionalLight(PALETTE.sunLight, SUN_INTENSITY)
  sun.position.copy(SUN_DIRECTION).multiplyScalar(1000)
  sun.target.position.set(0, 0, 0)
  root.add(hemi, sun, sun.target)
  // Custom shaders get a little extra sky fill so cliffs in shadow stay readable.
  const lighting = createLightingUniforms(SUN_INTENSITY, HEMI_INTENSITY * 1.3)

  const fog = new Fog(new Color(PALETTE.horizon), settings.fogNear, settings.fogFar)
  const previousFog = scene.fog, previousBackground = scene.background
  scene.fog = fog
  scene.background = new Color(PALETTE.horizon)

  const ramp = createToonRamp()
  const terrainMaterial = createTerrainMaterial(lighting)
  const trees = createTreeResources(ramp)
  const water = createWater(lighting)
  const sky = createSky()
  const boundary = createBoundary()
  const bases = createAirbases(lighting, ramp)
  let clouds = createClouds(ramp, settings.clouds)
  const streamer = new TerrainStreamer(settings, terrainMaterial, trees, (z0, z1, rows) => water.writeRows(z0, z1, rows))

  root.add(sky.mesh, water.mesh, streamer.terrainRoot, streamer.treeRoot, bases.root, clouds.mesh, boundary.mesh)
  bases.setHighlight(null)

  const view: WorldViewDebug = {
    root,
    far: settings.far,
    update(cameraPosition, dt, time) {
      // Thin the haze when high up so the archipelago stays readable from altitude.
      fog.near = Math.min(settings.fogNear + Math.max(0, cameraPosition.y) * 1.6, settings.fogFar * 0.8)
      sky.update(cameraPosition, time)
      water.update(time)
      bases.update(time)
      boundary.update(time)
      streamer.update(cameraPosition, Math.max(0, Math.min(dt, 0.5)))
    },
    setQuality(q) {
      if (WORLD_QUALITY[q] === settings) return
      settings = WORLD_QUALITY[q]
      view.far = settings.far
      fog.near = settings.fogNear
      fog.far = settings.fogFar
      streamer.setSettings(settings)
      root.remove(clouds.mesh)
      clouds.dispose()
      clouds = createClouds(ramp, settings.clouds)
      root.add(clouds.mesh)
    },
    setHighlightTeam(team) { bases.setHighlight(team) },
    ready: () => streamer.ready(),
    stats: () => ({ ...streamer.stats, shoreProgress: streamer.shoreProgress }),
    streamer,
    dispose() {
      streamer.dispose()
      water.dispose(); sky.dispose(); boundary.dispose(); bases.dispose(); clouds.dispose()
      trees.dispose(); terrainMaterial.dispose(); ramp.dispose()
      root.removeFromParent()
      if (scene.fog === fog) scene.fog = previousFog
      scene.background = previousBackground
    },
  }
  return view
}
