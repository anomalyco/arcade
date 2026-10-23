export { Particles, Emitter, PARTICLE_CAPACITY, type ParticleSpec, type ParticleKind } from "./particles"
export {
  ParticleRenderer,
  ParticleFrameStruct,
  particleShader,
  makeParticleShader,
  blackbodyFireWgsl,
  strontiumFlameWgsl,
  type ParticleFrameInput,
  type ParticleLightInput,
  type ParticleRendererOptions,
} from "./particle-renderer"
export { SmokeTrail, type SmokeSource } from "./smoke-trail"
export { SmokeRenderer as TyreRenderer, tyreShader } from "./tyre-renderer"
export { SmokeVolumes, GRID, VOLUMES, type Wall } from "./volume"
export { VolumeRenderer, VolumeFrameStruct, type VolumeFrameInput } from "./volume-renderer"
export { volumeShader } from "./volume-shader"
export {
  explosionDefaults,
  explosionRanges,
  explosionSettings,
  EXPLOSION_PRESET_IDS,
  EXPLOSION_PRESETS,
  explosionPresetOptions,
  isExplosionPresetId,
  resolveExplosionSettings,
  computeExplosionLod,
  applyExplosionSmokeLive,
  spawnExplosion,
  explosionFlashLight,
  type ExplosionSettings,
  type ExplosionNumericKey,
  type ExplosionPresetId,
  type ExplosionParams,
  type ExplosionSpawnOptions,
  type ExplosionLodInfo,
} from "./explosion"
export {
  FlareFx,
  FLARE_DEFAULTS,
  FLARE_RANGES,
  FLARE_STRIKE,
  flareSettings,
  flareControls,
  flareColor,
  flareFlicker,
  flareEnvelope,
  flareSceneLight,
  flareFogLamp,
  blackbody,
  type FlareSettings,
  type FlareLight,
  type FlareEnvelope,
  type FlarePhase,
} from "./flare"
