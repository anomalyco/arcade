import { registerOutbreakClientFeature } from "../feature-registry"
import { DEFAULT_VEGETATION_SETTINGS, vegetationBuild, vegetationControls } from "./settings"

/**
 * Trees, hedges, shrubs and grass (Lab › Vegetation). `scene/frame-lighting.ts` packs the wind field each frame;
 * `world/scene-level.ts` syncs the build options every frame and rebuilds the level when they change; `plant()`
 * (`architecture.ts`) reads them.
 */
export const outbreakVegetationFeature = registerOutbreakClientFeature({
  id: "vegetation",
  order: 48,
  settingsGroup: { subsystem: "vegetation", defaults: DEFAULT_VEGETATION_SETTINGS },
  labControls: () => vegetationControls,
  harnessState: () => ({ vegetation: { ...vegetationBuild } }),
})
