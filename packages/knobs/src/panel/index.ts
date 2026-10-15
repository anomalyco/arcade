export { attach } from "./attach.js"
export {
  getGpuOverlayManager,
  resolveRendererMode,
  type KnobsGpuDiagnostics,
} from "./gpu/renderer.js"
export {
  computeHintPrefixes,
  type HintBadgeState,
  type HintCandidate,
  type HintResolution,
} from "./hints.js"
export { Spring, VelocityTracker } from "./motion.js"
export { createPanel, mountPage, mountPanel, type Panel } from "./panel.js"
export {
  balancedRuns,
  type MountPageOptions,
  type Page,
  type PageAction,
  type PageCard,
  type PageCardOptions,
  type PageControl,
} from "./page.js"
export {
  createPresetStrip,
  nextPresetIndex,
  resolveActivePresetEntry,
  type ActivePresetState,
  type PresetEntry,
  type PresetStrip,
} from "./presets.js"
export { injectStyles } from "./styles.js"
export {
  attachVariantSwitcher,
  getSwitcherOptions,
  type ChoiceKey,
  type SwitcherOptions,
} from "./switcher.js"
