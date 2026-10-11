// World rendering — owned by the World agent.
// ISLANDERS-style low-poly diorama: flat-shaded terrain clusters (one palette colour per face,
// generated in a Web Worker), banded stylised sea, gradient sky with soft fog, chunky instanced
// trees, merged airbases and safe-zone domes. Installs the scene's sun + hemisphere lights and fog.
import {
  Color, DirectionalLight, Fog, Group, HemisphereLight, MeshLambertMaterial, type Object3D, type Scene, type Vector3,
  type WebGLRenderer,
} from "three"
import type { Quality } from "../sim/types"
import { createAirbases } from "./world/airbase"
import { createBoundary } from "./world/boundary"
import { PALETTE } from "./world/palette"
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
  dispose(): void
}

/** Extra diagnostics for dev tools / preview pages. */
export interface WorldViewDebug extends WorldView {
  stats(): StreamerStats & { shoreProgress: number }
  streamer: TerrainStreamer
}

// Tuned so an upward-facing lit facet shows roughly its palette colour, with a soft 2:1 lit/shade ratio.
const SUN_INTENSITY = 2.2
const HEMI_INTENSITY = 2.2

export function createWorldView(renderer: WebGLRenderer, scene: Scene, quality: Quality): WorldView {
  void renderer
  let settings = WORLD_QUALITY[quality]
  const root = new Group()
  root.name = "World"

  // Warm sun + cool sky fill; aircraft and all world props share these.
  const hemi = new HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, HEMI_INTENSITY)
  const sun = new DirectionalLight(PALETTE.sunLight, SUN_INTENSITY)
  sun.position.copy(SUN_DIRECTION).multiplyScalar(1000)
  sun.target.position.set(0, 0, 0)
  root.add(hemi, sun, sun.target)

  const fog = new Fog(new Color(PALETTE.horizon), settings.fogNear, settings.fogFar)
  const previousFog = scene.fog, previousBackground = scene.background
  scene.fog = fog
  scene.background = new Color(PALETTE.horizon)

  const terrainMaterial = new MeshLambertMaterial({ vertexColors: true, flatShading: true, toneMapped: false })
  terrainMaterial.name = "World · terrain"
  const trees = createTreeResources()
  const water = createWater()
  const sky = createSky()
  const boundary = createBoundary()
  const bases = createAirbases()
  let clouds = createClouds(settings.clouds)
  const streamer = new TerrainStreamer(settings, terrainMaterial, trees, (z0, _z1, rows) => water.writeRows(z0, rows))

  root.add(sky.mesh, water.mesh, streamer.terrainRoot, streamer.treeRoot, bases.root, clouds.mesh, boundary.mesh)
  bases.setHighlight(null)

  const view: WorldViewDebug = {
    root,
    far: settings.far,
    update(cameraPosition, dt, time) {
      // Thin the haze when high up so the archipelago stays readable from altitude.
      fog.near = Math.min(settings.fogNear + Math.max(0, cameraPosition.y) * 1.5, settings.fogFar * 0.7)
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
      clouds = createClouds(settings.clouds)
      root.add(clouds.mesh)
    },
    setHighlightTeam(team) { bases.setHighlight(team) },
    ready: () => streamer.ready(),
    stats: () => ({ ...streamer.stats, shoreProgress: streamer.shoreProgress }),
    streamer,
    dispose() {
      streamer.dispose()
      water.dispose(); sky.dispose(); boundary.dispose(); bases.dispose(); clouds.dispose()
      trees.dispose(); terrainMaterial.dispose()
      root.removeFromParent()
      if (scene.fog === fog) scene.fog = previousFog
      scene.background = previousBackground
    },
  }
  return view
}
