import { formatLabValue, inferControlUnit, LabPanel, type LabControl, type LabSettings, type LabValue } from "../lab-panel"
import {
  coerceControlValue,
  findControlRow,
  formatControlValue,
  readStageCameraState,
  registerDevControl,
  registerPanelLabCommands,
  registerStageCameraCommands,
} from "../dev-control"
import { LabCommandRegistry, type LabCommandContext, type LabSceneState } from "./commands"
import { computeSnapshotDiffs, createCompareWipeDOM } from "./compare-ab"
import { effectOptions, type createEffects } from "./effects"
import {
  computeVariationGridLayout,
  createVariationGridDOM,
  pickVariationGridTileAt,
  resolveVariationGridConfig,
  summarizeTileSettings,
  VARIATION_GRID_PRESETS,
  type VariationGridConfig,
  type VariationTileConfig,
} from "./variation-grid"
import {
  FOLIAGE_CROWN_SHAPES,
  FOLIAGE_PARAM_SPECS,
  FOLIAGE_PRESETS,
  FOLIAGE_PRESET_IDS,
  exportFoliagePreset,
  foliageSettings,
  foliageTextureUrls,
  importFoliagePreset,
  isFoliagePresetId,
  randomizeFoliageParams,
  resetFoliageParams,
  setFoliageTextureUrls,
  type FoliageCameraMode,
  type FoliageCompareMode,
} from "../gpu/foliage"
import { FOLIAGE_LIGHTING_PRESETS } from "./foliage"
import { lightingDefaults } from "./lighting"
import type { LookLabController } from "./looks"
import { applyLookPreset, LOOK_PRESETS, LOOK_PRESET_IDS, resolveLookPresetId, type LookGroup, type LookSettings } from "../gpu/look"
import { applyWeatherPreset, resolveWeatherPresetId, type WeatherSettings } from "../weather"
import { createRadialMenuDOM, RadialMenuStateMachine, type RadialReleaseResult } from "./radial"
import { applyGameRecipe, buildGameRecipe, type GameRecipePayload } from "./recipe"
import {
  applyClickSelection,
  applyMarqueeSelection,
  computeSelectionCentroid,
  normalizeMarqueeRect,
  pickObjectsInMarquee,
} from "./selection"
import type { createSpawn, SpawnSceneSnapshot } from "./spawn"
import type { StageMarker } from "./stage"
import {
  applyNumericTransformKey,
  computePointerYawRad,
  createTransformGizmoDOM,
  createTransformState,
  createViewportCursorDOM,
  projectGroundRotateRing,
  sampleGroundNormal,
  snapGroundCoord,
  type ActiveTransformState,
  type GroundSurfaceSample,
  type NumericAxis,
  type TransformMode,
} from "./transform"
import type { LabContext, LabLibraryCategory, LabSection, LabWorldObject } from "./types"
import { createLibrary, isLibraryAsset, isPlaceable, LIBRARY_CATEGORIES, libraryCategoryOf, sectionLibraryCategory } from "./library"
import { createOutliner, OUTLINER_GROUPS, outlinerGroupOf } from "./outliner"
import { createPalette, type PaletteItem } from "./palette"
import { createWatchList, loadWatchPins, saveWatchPins, watchPinId, type WatchPin } from "./watch"
import {
  applyArrowCameraKey,
  bindOrbitGestures,
  getTwoFingerScrollMode,
  setTwoFingerScrollMode,
} from "../orbit-gestures"
import { moveClusterLabel, observeKeyLayout, onKeyLayoutChange } from "../client/controls"
import { yardGround } from "./yard"

export type CatalogCategory = LabLibraryCategory
export type CatalogCollection = "all" | "fixtures" | "blackout" | "getaway" | "shared"

export type CatalogEntry = {
  id: string
  label: string
  group: string
  category: CatalogCategory
  collection: Exclude<CatalogCollection, "all">
  tag: string
  sectionId: string
  run: (fromUser: boolean) => void
  isActive?: () => boolean
}

export type LabPresetSchema = {
  version: 1
  section: string
  settings: Record<string, LabValue>
  lighting?: Record<string, LabValue>
  spawn?: {
    characterId?: string | null
    props?: { kind: string; x: number; y: number; z: number; yaw: number }[]
  }
}

type FullSnapshot = {
  sectionId: string
  sections: Record<string, Record<string, LabValue>>
  lighting: Record<string, LabValue>
  spawn: SpawnSceneSnapshot | null
}

type HistoryEntry = {
  label: string
  before: FullSnapshot
  after: FullSnapshot
}

const LIGHTING_LOOKS: Record<string, { label: string; values: Partial<ReturnType<typeof lightingDefaults>> }> = {
  neutral: {
    label: "Neutral Stage",
    values: { lamps: true, lampPower: 2, lampRadius: 10, lampHeight: 3, spot: true, spotPower: 4, spotAngle: 38, spotYaw: -120, spotPitch: 40, shadows: true, moon: true, moonPower: 0.35, moonAzimuth: -45, moonElevation: 55, count: 2, exposure: 0, tone: 0, temperature: 0, saturation: 1 },
  },
  night_street: {
    label: "Night Street",
    values: { lamps: true, lampPower: 3.2, lampRadius: 14, lampHeight: 3.8, spot: true, spotPower: 6, spotAngle: 32, spotYaw: -95, spotPitch: 45, shadows: true, moon: true, moonPower: 0.18, moonAzimuth: -60, moonElevation: 42, count: 4, exposure: -0.15, tone: 1, temperature: -0.2, saturation: 1.05 },
  },
  fluorescent_office: {
    label: "Fluorescent Office",
    values: { lamps: true, lampPower: 2.8, lampRadius: 12, lampHeight: 2.9, spot: false, spotPower: 2, shadows: true, moon: true, moonPower: 0.45, moonAzimuth: -30, moonElevation: 60, count: 4, exposure: 0.2, tone: 0, temperature: 0.12, saturation: 0.95 },
  },
  sodium_alley: {
    label: "Sodium Alley",
    values: { lamps: true, lampPower: 3.6, lampRadius: 11, lampHeight: 3.2, spot: true, spotPower: 5, spotAngle: 28, spotYaw: -140, spotPitch: 36, shadows: true, moon: true, moonPower: 0.1, moonAzimuth: -20, moonElevation: 35, count: 3, exposure: -0.1, tone: 1, temperature: 0.45, saturation: 1.1 },
  },
  cold_moon: {
    label: "Cold Moon",
    values: { lamps: false, lampPower: 0.8, spot: true, spotPower: 3.5, spotAngle: 44, shadows: true, moon: true, moonPower: 0.85, moonAzimuth: -50, moonElevation: 62, count: 1, exposure: 0.05, tone: 1, temperature: -0.45, saturation: 0.88 },
  },
}

export type WorkbenchOptions = {
  root: HTMLElement
  canvas: HTMLCanvasElement
  ViewportHost: HTMLElement
  panel: LabPanel
  context: LabContext
  sections: readonly LabSection[]
  globalSettings: { section: string; debug: number }
  selectSection: (id: string) => void
  renderNow: () => Promise<unknown>
  advanceSim: (dt: number) => void
  spawn?: ReturnType<typeof createSpawn>
  looks?: LookLabController
  effects?: ReturnType<typeof createEffects>
}

export function createWorkbench(opts: WorkbenchOptions) {
  const { root, canvas, panel, context, sections, globalSettings, selectSection, renderNow, advanceSim, spawn, looks, effects } = opts
  const { stage, input } = context
  const isBench = new URLSearchParams(location.search).has("bench")

  let mode: "edit" | "play" = "edit"
  let ejected = false
  let activeCatalogId = "fixture:smoke-room"
  let simSpeed = 1
  let elapsed = 0
  let frames = 0
  let hoveredObjectId: string | null = null
  let hoveredGroundSample: GroundSurfaceSample | null = null
  let hoveredGizmoHandle: TransformMode | null = null
  let activeTransform: (ActiveTransformState & { before: FullSnapshot }) | null = null
  let boxSelectMode = false
  let lastPointerViewport: { x: number; y: number } | null = null
  let prePlayCheckpoint: FullSnapshot | null = null
  let lastPlayAftermath: FullSnapshot | null = null
  let slotA: { snapshot: FullSnapshot; frames: number; elapsed: number } | null = null
  let slotB: { snapshot: FullSnapshot; frames: number; elapsed: number } | null = null
  let activeSlot: "A" | "B" = "B"
  let compareWipeEnabled = false
  let compareWipeSplit = 0.5
  let isCapturingWipe = false
  let variationGrid: VariationGridConfig | null = null
  let focusedGridTile: number | null = null
  let hoveredGridTile: number | null = null
  let variationGridCostMs: number | null = null
  let focusZone: "canvas" | "library" | "inspector" | "palette" | "modal" | "outliner" = "canvas"
  let toastTimer = 0

  const undoStack: HistoryEntry[] = []
  const redoStack: HistoryEntry[] = []
  const commands = new LabCommandRegistry()
  const radialState = new RadialMenuStateMachine(commands)

  // Top bar elements
  const topbar = root.querySelector<HTMLElement>(".lab-topbar")!
  const libraryEl = root.querySelector<HTMLElement>(".lab-library")!
  const viewportEl = root.querySelector<HTMLElement>(".lab-viewport")!
  const inspectorEl = root.querySelector<HTMLElement>(".lab-inspector")!
  const bottombar = root.querySelector<HTMLElement>(".lab-bottombar")!

  const editModeBtn = topbar.querySelector<HTMLButtonElement>('[data-action="mode-edit"]')!
  const playModeBtn = topbar.querySelector<HTMLButtonElement>('[data-action="mode-play"]')!
  const boxModeBtn = document.createElement("button")
  boxModeBtn.type = "button"
  boxModeBtn.className = "lab-btn"
  boxModeBtn.dataset.action = "mode-box"
  boxModeBtn.setAttribute("aria-label", "Box select mode")
  boxModeBtn.setAttribute("aria-pressed", "false")
  boxModeBtn.title = "Force Marquee Box Select mode (LMB drag on empty already box-selects when objects exist)"
  boxModeBtn.textContent = "Box"
  editModeBtn.parentElement?.append(boxModeBtn)

  const scrollModeBtn = document.createElement("button")
  scrollModeBtn.type = "button"
  scrollModeBtn.className = "lab-btn"
  scrollModeBtn.dataset.action = "toggle-trackpad-scroll"
  scrollModeBtn.setAttribute("aria-label", "Trackpad two-finger scroll mode")
  scrollModeBtn.setAttribute("aria-pressed", String(getTwoFingerScrollMode() === "pan"))
  scrollModeBtn.title = "Two-finger trackpad scroll action: Orbit (default) or Pan (Shift+2F always pans, Pinch/Wheel zooms)"
  scrollModeBtn.textContent = getTwoFingerScrollMode() === "pan" ? "2F: Pan" : "2F: Orbit"
  editModeBtn.parentElement?.append(scrollModeBtn)

  const viewportHud = viewportEl.querySelector<HTMLElement>(".lab-viewport-hud")!
  const marqueeEl = document.createElement("div")
  marqueeEl.className = "lab-marquee"
  marqueeEl.dataset.labMarquee = ""
  marqueeEl.hidden = true
  viewportHud.append(marqueeEl)
  const sectionSelect = root.querySelector<HTMLSelectElement>('[data-control="section"]')!
  const envSelect = root.querySelector<HTMLSelectElement>('[data-control="environment"]')!
  const seedBadge = root.querySelector<HTMLElement>('[data-readout="seed"]')!
  const rerollBtn = root.querySelector<HTMLButtonElement>('[data-action="reroll"]')!
  const lockEffectBtn = root.querySelector<HTMLButtonElement>('[data-action="lock-effect"]')!
  const lockEnvBtn = root.querySelector<HTMLButtonElement>('[data-action="lock-env"]')!
  const debugSelect = topbar.querySelector<HTMLSelectElement>('[data-control="debug"]')!
  const frameBtn = topbar.querySelector<HTMLButtonElement>('[data-action="frame"]')!
  const undoBtn = topbar.querySelector<HTMLButtonElement>('[data-action="undo"]')!
  const redoBtn = topbar.querySelector<HTMLButtonElement>('[data-action="redo"]')!
  const exportBtn = topbar.querySelector<HTMLButtonElement>('[data-action="export"]')!
  const importBtn = topbar.querySelector<HTMLButtonElement>('[data-action="import"]')!

  // Top-bar A/B Compare cluster and Copy Game Recipe button
  const topbarRight = topbar.querySelector<HTMLElement>(".lab-topbar-right")!
  const compareGroup = document.createElement("div")
  compareGroup.className = "lab-mode-seg"
  compareGroup.setAttribute("role", "group")
  compareGroup.setAttribute("aria-label", "A/B Comparison")
  const pinABtn = document.createElement("button")
  pinABtn.type = "button"
  pinABtn.className = "lab-btn"
  pinABtn.dataset.action = "compare-pin-a"
  pinABtn.title = "Pin Baseline Slot A (B)"
  pinABtn.textContent = "A"
  const flipBtn = document.createElement("button")
  flipBtn.type = "button"
  flipBtn.className = "lab-btn"
  flipBtn.dataset.action = "compare-flip"
  flipBtn.title = "Flip Slot A / Slot B (V)"
  flipBtn.textContent = "V"
  const wipeBtn = document.createElement("button")
  wipeBtn.type = "button"
  wipeBtn.className = "lab-btn"
  wipeBtn.dataset.action = "compare-wipe"
  wipeBtn.title = "Toggle Split-Screen A/B Wipe (⇧V)"
  wipeBtn.textContent = "Wipe"
  const gridBtn = document.createElement("button")
  gridBtn.type = "button"
  gridBtn.className = "lab-btn"
  gridBtn.dataset.action = "compare-grid"
  gridBtn.setAttribute("aria-pressed", "false")
  gridBtn.title = "Toggle Multi-Tile Variation Grid (1–9 focus tile, Esc/G back)"
  gridBtn.textContent = "⊞ Grid"
  compareGroup.append(pinABtn, flipBtn, wipeBtn, gridBtn)
  const compareDivider = document.createElement("div")
  compareDivider.className = "lab-divider"
  topbar.querySelector<HTMLElement>(".lab-transport")!.after(compareDivider, compareGroup)

  const recipeBtn = document.createElement("button")
  recipeBtn.type = "button"
  recipeBtn.className = "lab-menu-item"
  recipeBtn.setAttribute("role", "menuitem")
  recipeBtn.dataset.action = "copy-recipe"
  recipeBtn.setAttribute("aria-label", "Copy recipe for game")
  recipeBtn.title = "Copy typed settings recipe for game source (no URL params)"
  recipeBtn.textContent = "Copy recipe for game"
  exportBtn.before(recipeBtn)
  void topbarRight

  const wipeDOM = createCompareWipeDOM(viewportEl, split => {
    compareWipeSplit = split
    syncCompareWipeOverlay()
  })

  const gridDOM = createVariationGridDOM(viewportHud, {
    onFocusTile: tileNum => focusVariationTile(tileNum),
    onHoverTile: tileNum => {
      hoveredGridTile = tileNum
      syncVariationGridOverlay()
    },
    onCloseGrid: () => closeVariationGrid(),
  })

  const outlinerEl = root.querySelector<HTMLElement>(".lab-outliner")!
  const moreBtn = topbar.querySelector<HTMLButtonElement>('[data-action="more"]')!
  const moreMenu = topbar.querySelector<HTMLElement>("[data-more-menu]")!
  const paletteBtn = topbar.querySelector<HTMLButtonElement>('[data-action="palette"]')!
  const statsReadout = bottombar.querySelector<HTMLElement>('[data-readout="stats"]')!
  const detailsIcon = inspectorEl.querySelector<HTMLElement>("[data-details-icon]")!
  const detailsMeta = inspectorEl.querySelector<HTMLElement>("[data-details-meta]")!
  const detailsActions = inspectorEl.querySelector<HTMLElement>("[data-details-actions]")!
  const detailsSearch = inspectorEl.querySelector<HTMLInputElement>('[data-control="details-search"]')!
  const detailsModifiedBtn = inspectorEl.querySelector<HTMLButtonElement>('[data-action="details-modified"]')!
  const detailsModifiedCount = inspectorEl.querySelector<HTMLElement>("[data-modified-count]")!
  const detailsAllBtn = inspectorEl.querySelector<HTMLButtonElement>('[data-action="details-all"]')!
  /** Approved defaults captured before any fixture or user edit; drive Reset and modified highlighting. */
  const defaultsBySection = new Map(sections.map(s => [s.id, { ...s.settings } as LabSettings]))
  const lockedIds = new Set<string>()
  let watchPins: WatchPin[] = loadWatchPins()
  let detailsQuery = ""
  let detailsModifiedOnly = false
  let detailsShowAll = false
  let detailsViewSig = ""
  let detailsRelevant: Set<string> | null = null
  let detailsActionsSig = ""
  let lastSelectionSig = ""
  let selectingFromOutliner = false
  let telemetryText = ""
  let chromeReady = false

  // Viewport HUD elements
  const hudBadge = viewportEl.querySelector<HTMLElement>("[data-hud-badge]")!
  const hudToast = viewportEl.querySelector<HTMLElement>("[data-hud-toast]")!

  // Inspector header elements
  const inspectorTitle = inspectorEl.querySelector<HTMLElement>(".lab-inspector-title")!
  const inspectorSub = inspectorEl.querySelector<HTMLElement>(".lab-inspector-sub")!

  // Transport elements (top bar)
  const playPauseBtn = root.querySelector<HTMLButtonElement>('[data-action="transport-play"]')!
  const retriggerBtn = root.querySelector<HTMLButtonElement>('[data-action="transport-retrigger"]')!
  const stepBtn = root.querySelector<HTMLButtonElement>('[data-action="transport-step"]')!
  const loopBtn = root.querySelector<HTMLButtonElement>('[data-action="transport-loop"]')!
  const speedSelect = root.querySelector<HTMLSelectElement>('[data-control="transport-speed"]')!
  const timeReadout = root.querySelector<HTMLElement>('[data-readout="elapsed"]')!
  const focusPill = bottombar.querySelector<HTMLElement>("[data-focus-pill]")!
  const hintText = bottombar.querySelector<HTMLElement>("[data-hint-text]")!

  // Preset Modal
  const modalBackdrop = root.querySelector<HTMLElement>("[data-preset-modal]")!
  const modalTitle = modalBackdrop.querySelector<HTMLElement>("[data-modal-title]")!
  const modalTextarea = modalBackdrop.querySelector<HTMLTextAreaElement>("textarea")!
  const modalError = modalBackdrop.querySelector<HTMLElement>("[data-preset-error]")!
  const modalApplyBtn = modalBackdrop.querySelector<HTMLButtonElement>('[data-action="modal-apply"]')!
  const modalCopyBtn = modalBackdrop.querySelector<HTMLButtonElement>('[data-action="modal-copy"]')!
  const modalCloseBtn = modalBackdrop.querySelector<HTMLButtonElement>('[data-action="modal-close"]')!

  function activeSection(): LabSection {
    return sections.find(s => s.id === globalSettings.section) ?? sections[0]!
  }

  function showToast(message: string, isError = false, action?: { label: string; run: () => void }) {
    hudToast.replaceChildren()
    const span = document.createElement("span")
    span.textContent = message
    hudToast.append(span)
    if (action) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "lab-toast-btn"
      btn.dataset.action = "toast-action"
      btn.textContent = action.label
      btn.onclick = () => {
        hudToast.hidden = true
        action.run()
      }
      hudToast.append(btn)
    }
    hudToast.dataset.error = String(isError)
    hudToast.hidden = false
    if (toastTimer) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      hudToast.hidden = true
    }, action ? 5000 : 2800)
  }

  function captureSnapshot(): FullSnapshot {
    const secMap: Record<string, Record<string, LabValue>> = {}
    for (const s of sections) {
      const copy: Record<string, LabValue> = {}
      for (const k of Object.keys(s.settings)) copy[k] = s.settings[k]!
      secMap[s.id] = copy
    }
    return {
      sectionId: globalSettings.section,
      sections: secMap,
      lighting: { ...stage.lighting },
      spawn: spawn ? spawn.snapshot() : null,
    }
  }

  function restoreSnapshot(snap: FullSnapshot, preserveTransport = false) {
    const prevFrames = frames
    const prevElapsed = elapsed
    const secBefore = activeSection()
    const prevPlaying = "playing" in secBefore.settings ? Boolean(secBefore.settings.playing) : true
    if (snap.sectionId !== globalSettings.section) {
      selectSection(snap.sectionId)
    }
    for (const s of sections) {
      const saved = snap.sections[s.id]
      if (!saved) continue
      for (const [k, v] of Object.entries(saved)) {
        if (preserveTransport && k === "playing") continue
        if (k in s.settings) s.settings[k] = v
      }
    }
    Object.assign(stage.lighting, snap.lighting)
    if (spawn && snap.spawn) {
      spawn.restore(snap.spawn)
    }
    const sec = activeSection()
    if (preserveTransport && "playing" in sec.settings) {
      sec.settings.playing = prevPlaying
      frames = prevFrames
      elapsed = prevElapsed
    }
    if (sec.id === "blackout-effects" || sec.id === "getaway-effects" || sec.id === "outbreak-vignette") {
      sec.enter?.()
      sec.retrigger?.()
    } else if (sec.id === "effects" || sec.id === "fire-water" || sec.id === "splatter") {
      sec.retrigger?.()
    }
    if (preserveTransport && !prevPlaying && frames > 0) {
      stepSimulationDeterministic(frames)
    }
    if (mode === "edit") {
      input.enabled = false
      input.release()
    }
    panel.sync()
    syncChrome()
    void renderNow()
  }

  function stepSimulationDeterministic(targetFrames: number) {
    const sec = activeSection()
    const capped = Math.max(0, Math.min(360, Math.round(targetFrames)))
    const wasPlaying = "playing" in sec.settings ? sec.settings.playing : true
    if ("playing" in sec.settings) sec.settings.playing = true
    for (let i = 0; i < capped; i++) {
      advanceSim(1 / 60)
    }
    if ("playing" in sec.settings) sec.settings.playing = wasPlaying
    frames = capped
    elapsed = capped / 60
    timeReadout.textContent = `${elapsed.toFixed(2)}s · f${frames}`
  }

  function resimulateFrozenFrame(control?: { key: string; unit?: string }) {
    const sec = activeSection()
    const playing = "playing" in sec.settings ? Boolean(sec.settings.playing) : true
    if (playing || frames <= 0) return false
    if (!["effects", "blackout-effects", "getaway-effects", "fire-water", "splatter"].includes(sec.id)) return false
    if (
      sec.id === "effects" &&
      sec.settings.effect === "smoke" &&
      control &&
      !control.unit?.includes("retrigger") &&
      !["effect", "targetX", "targetZ", "seed"].includes(control.key)
    ) {
      return false
    }
    const targetFrames = frames
    sec.retrigger?.()
    if (variationGrid && sec.id === "effects" && effects) {
      effects.resetVariantSlots(variationGrid.tiles)
    }
    stepSimulationDeterministic(targetFrames)
    return true
  }

  function syncCompareWipeOverlay() {
    if (!compareWipeEnabled || !slotA) {
      wipeDOM.sync({ enabled: false, split: compareWipeSplit, frames, diffs: [] })
      return
    }
    const snapB = slotB?.snapshot ?? captureSnapshot()
    const diffs = computeSnapshotDiffs(slotA.snapshot, snapB)
    wipeDOM.sync({
      enabled: true,
      split: compareWipeSplit,
      frames,
      diffs,
    })
  }

  async function captureSlotAToWipeCanvas() {
    if (!slotA || isCapturingWipe) return
    isCapturingWipe = true
    try {
      const currentLive = captureSnapshot()
      const currentFrames = frames
      const currentElapsed = elapsed
      const sec = activeSection()
      const wasPlaying = "playing" in sec.settings ? Boolean(sec.settings.playing) : true

      // 1. Evaluate Slot A at current frame and copy rendered WebGPU canvas to wipe overlay
      for (const s of sections) {
        const saved = slotA.snapshot.sections[s.id]
        if (!saved) continue
        for (const [k, v] of Object.entries(saved)) {
          if (k === "playing") continue
          if (k in s.settings) s.settings[k] = v
        }
      }
      Object.assign(stage.lighting, slotA.snapshot.lighting)
      sec.retrigger?.()
      if (currentFrames > 0) stepSimulationDeterministic(currentFrames)

      await renderNow()
      await stage.captureToCanvas(wipeDOM.offscreenCanvas)
      wipeDOM.imageA.src = wipeDOM.offscreenCanvas.toDataURL("image/png")

      // 2. Restore live Candidate B at the exact same frame
      for (const s of sections) {
        const saved = currentLive.sections[s.id]
        if (!saved) continue
        for (const [k, v] of Object.entries(saved)) {
          if (k in s.settings) s.settings[k] = v
        }
      }
      if ("playing" in sec.settings) sec.settings.playing = wasPlaying
      Object.assign(stage.lighting, currentLive.lighting)
      sec.retrigger?.()
      if (currentFrames > 0) stepSimulationDeterministic(currentFrames)
      frames = currentFrames
      elapsed = currentElapsed
      await renderNow()
      syncCompareWipeOverlay()
    } finally {
      isCapturingWipe = false
    }
  }

  function pinBaselineSlotA() {
    const snap = captureSnapshot()
    slotA = { snapshot: snap, frames, elapsed }
    slotB = { snapshot: captureSnapshot(), frames, elapsed }
    activeSlot = "B"
    syncChrome()
    if (compareWipeEnabled) void captureSlotAToWipeCanvas()
    showToast(`Pinned Baseline Slot A at f${frames}`)
  }

  function flipCompareSlot() {
    if (!slotA) {
      pinBaselineSlotA()
      return
    }
    if (activeSlot === "B") {
      slotB = { snapshot: captureSnapshot(), frames, elapsed }
      activeSlot = "A"
      restoreSnapshot(slotA.snapshot, true)
      showToast(`Viewing Slot A (Baseline) at f${frames}`)
    } else {
      activeSlot = "B"
      if (slotB) restoreSnapshot(slotB.snapshot, true)
      showToast(`Viewing Slot B (Candidate) at f${frames}`)
    }
    syncCompareWipeOverlay()
  }

  function toggleCompareWipe() {
    if (variationGrid) closeVariationGrid()
    if (!slotA) {
      pinBaselineSlotA()
    }
    compareWipeEnabled = !compareWipeEnabled
    if (compareWipeEnabled && activeSlot === "A" && slotB) {
      activeSlot = "B"
      restoreSnapshot(slotB.snapshot, true)
    }
    syncChrome()
    if (compareWipeEnabled) {
      void captureSlotAToWipeCanvas()
      showToast("Split-screen A/B wipe enabled · Drag divider to compare")
    } else {
      syncCompareWipeOverlay()
      showToast("Split-screen A/B wipe off")
    }
  }

  function syncVariationGridOverlay() {
    gridDOM.sync({
      enabled: Boolean(variationGrid),
      config: variationGrid,
      focusedTile: focusedGridTile,
      hoveredTile: hoveredGridTile,
      frameCostMs: variationGridCostMs,
    })
  }

  function applyTileSettingsToSection(sec: LabSection, tile: VariationTileConfig) {
    if (sec.id === "weather") {
      if (tile.preset) {
        const pid = resolveWeatherPresetId(tile.preset)
        if (pid) applyWeatherPreset(sec.settings as unknown as WeatherSettings, pid)
      }
      if (tile.settings) {
        for (const [k, v] of Object.entries(tile.settings)) {
          if (k === "preset") {
            const pid = resolveWeatherPresetId(v)
            if (pid) applyWeatherPreset(sec.settings as unknown as WeatherSettings, pid)
          } else {
            sec.settings[k] = v
          }
        }
      }
      return
    }
    if (sec.id === "looks") {
      if (tile.preset) {
        const pid = resolveLookPresetId(tile.preset)
        if (pid) applyLookPreset(sec.settings as unknown as LookSettings, pid)
      }
      if (tile.settings) {
        for (const [k, v] of Object.entries(tile.settings)) {
          if (k === "preset") {
            const pid = resolveLookPresetId(v)
            if (pid) applyLookPreset(sec.settings as unknown as LookSettings, pid)
          } else {
            sec.settings[k] = v
          }
        }
      }
      return
    }
    if (tile.settings) {
      for (const [k, v] of Object.entries(tile.settings)) {
        sec.settings[k] = v
      }
    }
    if (tile.lighting) {
      Object.assign(stage.lighting, tile.lighting)
    }
  }

  function openVariationGrid(rawArgs?: Record<string, unknown>): VariationGridConfig {
    if (mode === "play") setPlayMode("edit")
    if (compareWipeEnabled) {
      compareWipeEnabled = false
      syncCompareWipeOverlay()
    }
    const secBefore = activeSection()
    const config = resolveVariationGridConfig(rawArgs, secBefore.id, String(secBefore.settings.effect ?? ""))
    if (config.section && sections.some(s => s.id === config.section) && globalSettings.section !== config.section) {
      selectSection(config.section)
    }
    variationGrid = config
    focusedGridTile = null
    hoveredGridTile = null
    variationGridCostMs = null
    if (config.section === "effects" && effects) {
      const firstEff = config.tiles[0]?.settings?.effect
      if (typeof firstEff === "string" && firstEff) {
        effects.params.effect = firstEff
      }
      elapsed = 0
      frames = 0
      effects.reset(String(effects.params.effect))
      effects.resetVariantSlots(config.tiles)
    } else {
      activeSection().retrigger?.()
    }
    panel.sync()
    syncChrome()
    void renderNow()
    showToast(`Variation Grid · ${config.title} (${config.tiles.length} tiles · Click or 1–${config.tiles.length} to focus)`)
    return config
  }

  function focusVariationTile(tileNumber: number | null) {
    if (!variationGrid) {
      throw new Error("Variation grid is not currently open.")
    }
    if (tileNumber === null || tileNumber === 0) {
      focusedGridTile = null
      syncChrome()
      void renderNow()
      showToast(`Variation Grid (${variationGrid.cols}×${variationGrid.rows}) · Click or press 1–${variationGrid.tiles.length} to focus a tile`)
      return { focusedTile: null, tile: null }
    }
    const idx = Math.round(tileNumber) - 1
    if (idx < 0 || idx >= variationGrid.tiles.length) {
      throw new Error(`Tile ${tileNumber} is out of range (1..${variationGrid.tiles.length}).`)
    }
    focusedGridTile = idx + 1
    const tile = variationGrid.tiles[idx]!
    const sec = activeSection()
    applyTileSettingsToSection(sec, tile)
    if (sec.id === "effects") {
      sec.retrigger?.()
      if ("playing" in sec.settings && !sec.settings.playing && frames > 0) {
        stepSimulationDeterministic(frames)
      }
    }
    panel.sync()
    syncChrome()
    void renderNow()
    showToast(`Tile ${focusedGridTile}/${variationGrid.tiles.length} · ${tile.label} (Press Esc or G to return to Grid)`)
    return { focusedTile: focusedGridTile, tile }
  }

  function closeVariationGrid() {
    if (!variationGrid) return
    variationGrid = null
    focusedGridTile = null
    hoveredGridTile = null
    variationGridCostMs = null
    syncChrome()
    void renderNow()
    showToast("Closed Variation Grid")
  }

  function advanceVariationGridSim(dt: number) {
    if (!variationGrid || focusedGridTile !== null) return
    const sec = activeSection()
    const playing = "playing" in sec.settings ? Boolean(sec.settings.playing) : true
    if (!playing) return
    if (sec.id === "effects" && effects) {
      effects.advanceVariantSlots(variationGrid.tiles, dt)
    }
  }

  let activeGridRender: Promise<number | null> | null = null

  async function renderVariationGrid(width: number, height: number, debug: number): Promise<number | null> {
    if (!variationGrid || focusedGridTile !== null) return null
    if (activeGridRender) return activeGridRender
    const run = (async () => {
    const sec = activeSection()
    const config = variationGrid
    const layout = computeVariationGridLayout(config.tiles.length, width, height, config.cols)
    const t0 = performance.now()

    const savedSecSettings: Record<string, LabValue> = {}
    for (const k of Object.keys(sec.settings)) savedSecSettings[k] = sec.settings[k]!
    const savedLighting = { ...stage.lighting }

    try {
      for (let i = 0; i < config.tiles.length; i++) {
        const tile = config.tiles[i]!
        const rect = layout.rects[i]!
        stage.resize(width, height, rect.width, rect.height)
        stage.updateCamera()
        stage.meshes.reset()
        stage.transients.reset()

        for (const [k, v] of Object.entries(savedSecSettings)) sec.settings[k] = v
        Object.assign(stage.lighting, savedLighting)

        applyTileSettingsToSection(sec, tile)

        const tileVp = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          clear: i === 0,
          present: i === config.tiles.length - 1,
        }

        if (sec.id === "effects" && effects) {
          const sharePlayground = Boolean(spawn?.hasActiveScene())
          if (sharePlayground) {
            stage.sceneMode = spawn!.section.settings.environment === "yard" ? 3 : 4
            spawn!.section.prepare?.()
          }
          const slot = effects.prepareVariantSlot(i, tile.settings ?? {})
          const drawPass = sharePlayground
            ? (pass: GPURenderPassEncoder) => {
                spawn!.section.draw?.(pass)
                sec.draw?.(pass)
              }
            : sec.draw
          await stage.render(slot.particles, slot.volume, slot.trail, debug, false, drawPass, tileVp)
        } else {
          const sharePlayground = Boolean(spawn?.hasActiveScene() && sec.id === "lighting")
          if (sharePlayground) {
            stage.sceneMode = spawn!.section.settings.environment === "yard" ? 3 : 4
            spawn!.section.prepare?.()
            stage.dynamicLights = null
          }
          sec.prepare?.()
          const drawPass = sharePlayground
            ? (pass: GPURenderPassEncoder) => {
                spawn!.section.draw?.(pass)
                sec.draw?.(pass)
              }
            : sec.draw
          await stage.render(context.particles, context.volume, context.trail, debug, false, drawPass, tileVp)
        }
      }
    } finally {
      for (const [k, v] of Object.entries(savedSecSettings)) sec.settings[k] = v
      Object.assign(stage.lighting, savedLighting)
      activeGridRender = null
    }

    const dtMs = performance.now() - t0
    variationGridCostMs = variationGridCostMs === null ? dtMs : variationGridCostMs * 0.8 + dtMs * 0.2
    syncVariationGridOverlay()
    return variationGridCostMs
    })()
    activeGridRender = run
    return run
  }

  function drawVariationGridOverlayToCanvas(target: HTMLCanvasElement) {
    if (!variationGrid || focusedGridTile !== null) return
    const ctx = target.getContext("2d")
    if (!ctx) return
    const cw = target.width
    const ch = target.height
    const layout = computeVariationGridLayout(variationGrid.tiles.length, cw, ch, variationGrid.cols)
    ctx.save()
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)"
    ctx.lineWidth = 1
    for (let c = 1; c < layout.cols; c++) {
      const x = c * layout.tileWidth + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, ch)
      ctx.stroke()
    }
    for (let r = 1; r < layout.rows; r++) {
      const y = r * layout.tileHeight + 0.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(cw, y)
      ctx.stroke()
    }

    for (let i = 0; i < variationGrid.tiles.length; i++) {
      const tile = variationGrid.tiles[i]!
      const rect = layout.rects[i]!
      const num = String(i + 1)
      const label = tile.label
      const summary = summarizeTileSettings(tile)

      ctx.font = "600 11px system-ui, -apple-system, sans-serif"
      const lw = ctx.measureText(label).width
      const pw = lw + 32
      const ph = 22
      const px = rect.x + 8
      const py = rect.y + 8

      ctx.fillStyle = "rgba(11, 14, 18, 0.88)"
      ctx.fillRect(px, py, pw, ph)
      ctx.strokeStyle = "rgba(255, 255, 255, 0.2)"
      ctx.strokeRect(px, py, pw, ph)

      ctx.fillStyle = "rgba(77, 141, 255, 0.26)"
      ctx.fillRect(px + 4, py + 4, 15, 14)
      ctx.font = "700 10px ui-monospace, SFMono-Regular, Menlo, monospace"
      ctx.fillStyle = "#8cc0ff"
      ctx.textBaseline = "middle"
      ctx.fillText(num, px + 8, py + 11)

      ctx.font = "600 11px system-ui, -apple-system, sans-serif"
      ctx.fillStyle = "#eef3f7"
      ctx.fillText(label, px + 24, py + 11.5)

      if (summary) {
        ctx.font = "500 9.5px ui-monospace, SFMono-Regular, Menlo, monospace"
        const sw = Math.min(rect.width - 16, ctx.measureText(summary).width + 12)
        const sy = rect.y + rect.height - 24
        ctx.fillStyle = "rgba(10, 13, 17, 0.82)"
        ctx.fillRect(px, sy, sw, 18)
        ctx.fillStyle = "#a5b5c2"
        ctx.fillText(summary, px + 6, sy + 9.5, sw - 12)
      }
    }
    ctx.restore()
  }

  function recordHistory(label: string, before: FullSnapshot) {
    const after = captureSnapshot()
    if (JSON.stringify(before) === JSON.stringify(after)) return
    undoStack.push({ label, before, after })
    if (undoStack.length > 50) undoStack.shift()
    redoStack.length = 0
    syncChrome()
  }

  function undo(): boolean {
    const entry = undoStack.pop()
    if (!entry) return false
    redoStack.push(entry)
    restoreSnapshot(entry.before)
    showToast(`Undid ${entry.label}`)
    return true
  }

  function redo(): boolean {
    const entry = redoStack.pop()
    if (!entry) return false
    undoStack.push(entry)
    restoreSnapshot(entry.after)
    showToast(`Redid ${entry.label}`)
    return true
  }

  function setPlayMode(next: "edit" | "play", restoreCheckpoint = true) {
    if (next === "play") {
      if (!spawn || !spawn.adapters.characters.length) {
        showToast("No controllable character or vehicle in this Lab", true)
        return
      }
      if (globalSettings.section !== "spawn") selectSection("spawn")
      if (!spawn.hasCharacter()) {
        const hostGame = location.pathname.match(/\/arcade\/([^/]+)\//)?.[1] ?? ""
        const preferred =
          String(spawn.section.settings.character || "") ||
          (hostGame === "blackout" && spawn.adapters.characters.some(c => c.id === "blackout:soldier") ? "blackout:soldier" : "") ||
          spawn.adapters.characters[0]?.id
        spawn.spawnCharacterAt(preferred)
      }
      if (!spawn.hasCharacter()) {
        showToast("No controllable character or vehicle in this Lab", true)
        return
      }
      if (!currentSelectedIds().includes("character:active")) {
        spawn.section.selectObject?.("character:active")
      }
      spawn.setGhost(null)
      activeTransform = null
      prePlayCheckpoint = captureSnapshot()
      if ("playing" in spawn.section.settings) {
        spawn.section.settings.playing = true
      }
      stage.hasDampedTarget = false
      mode = "play"
      ejected = false
      input.enabled = true
      focusZone = "canvas"
      viewportCursor.update({ state: "hidden" })
      canvas.focus({ preventScroll: true })
      showToast(`Playing ${spawn.characterLabel() ?? "Character"} · F8 eject · Esc to return & restore checkpoint`)
    } else {
      const wasPlay = mode === "play"
      mode = "edit"
      ejected = false
      input.enabled = false
      input.release()
      if (wasPlay) {
        if (restoreCheckpoint && prePlayCheckpoint) {
          lastPlayAftermath = captureSnapshot()
          restoreSnapshot(prePlayCheckpoint)
          const aftermath = lastPlayAftermath
          const checkpoint = prePlayCheckpoint
          showToast("Restored pre-Play checkpoint", false, {
            label: "Keep Play State",
            run: () => {
              if (aftermath && checkpoint) {
                restoreSnapshot(aftermath)
                recordHistory("Play session state", checkpoint)
                showToast("Kept Play state")
              }
            },
          })
        } else {
          showToast("Edit mode")
        }
      }
    }
    syncChrome()
  }

  function toggleEject() {
    if (!spawn || !spawn.adapters.characters.length) {
      showToast("No controllable character or vehicle in this Lab", true)
      return
    }
    if (mode !== "play") {
      setPlayMode("play")
      if ((mode as string) !== "play") return
    }
    ejected = !ejected
    if (ejected) {
      input.enabled = false
      input.release()
      stage.camCustom = true
      viewportCursor.update({ state: "default" })
      showToast("Ejected to Edit camera (sim running) · F8 or P to re-possess · Esc to stop")
    } else {
      if ("playing" in spawn.section.settings) spawn.section.settings.playing = true
      stage.hasDampedTarget = false
      input.enabled = true
      focusZone = "canvas"
      viewportCursor.update({ state: "hidden" })
      canvas.focus({ preventScroll: true })
      showToast(`Playing ${spawn.characterLabel() ?? "Character"} · F8 eject · Esc to stop`)
    }
    syncChrome()
  }

  function frameActiveTarget() {
    const sec = activeSection()
    const ft = sec.frameTarget?.()
    if (ft) {
      stage.frameTarget(ft.x, ft.y, ft.z, ft.dist ?? 15)
    } else {
      stage.frameTarget(0, 0.5, 0, 16)
    }
    void renderNow()
  }

  function allSceneObjects(): LabWorldObject[] {
    const sec = activeSection()
    const objects = [...(sec.objects?.() ?? [])]
    if (spawn && sec.id !== "spawn" && ["effects", "lighting", "physics"].includes(sec.id)) {
      for (const spObj of spawn.section.objects?.() ?? []) {
        if (!objects.some(o => o.id === spObj.id)) objects.push(spObj)
      }
    }
    return objects
  }

  function resolveObjectOwner(objId: string): LabSection {
    const sec = activeSection()
    if (sec.objects?.().some(o => o.id === objId)) return sec
    if (spawn && spawn.section.objects?.().some(o => o.id === objId)) return spawn.section
    return sec
  }

  function activeTargetObject(ctx?: LabCommandContext): LabWorldObject | null {
    if (ctx?.pickedObject) return ctx.pickedObject
    const objs = allSceneObjects()
    const sec = activeSection()
    const selId = sec.selectedObjectId ?? spawn?.section.selectedObjectId
    if (selId) {
      const found = objs.find(o => o.id === selId)
      if (found) return found
    }
    if (hoveredObjectId) {
      const hov = objs.find(o => o.id === hoveredObjectId)
      if (hov) return hov
    }
    return objs[0] ?? null
  }

  function currentSelectedIds(): string[] {
    const sec = activeSection()
    if (sec.selectedObjectIds?.length) return [...sec.selectedObjectIds]
    if (sec.selectedObjectId) return [sec.selectedObjectId]
    if (spawn && ["effects", "lighting", "physics"].includes(sec.id)) {
      if (spawn.section.selectedObjectIds?.length) return [...spawn.section.selectedObjectIds]
      if (spawn.section.selectedObjectId) return [spawn.section.selectedObjectId]
    }
    return []
  }

  function currentSelectedObjects(): LabWorldObject[] {
    const objs = allSceneObjects()
    const ids = currentSelectedIds()
    return ids.map(id => objs.find(o => o.id === id)).filter((o): o is LabWorldObject => Boolean(o))
  }

  function selectWorldObject(obj: LabWorldObject | null, shiftKey = false) {
    if (!obj) {
      if (!shiftKey) {
        applySectionSelection(activeSection(), [])
        if (spawn) spawn.section.selectObjects?.([])
      }
      panel.sync()
      syncChrome()
      void renderNow()
      return
    }
    const isSpawnObj = Boolean(spawn?.section.objects?.()?.some(o => o.id === obj.id))
    if (isSpawnObj && globalSettings.section !== "spawn") {
      selectSection("spawn")
    }
    const targetSec = activeSection()
    if (targetSec.selectObjects) {
      const next = applyClickSelection(targetSec.selectedObjectIds ?? (targetSec.selectedObjectId ? [targetSec.selectedObjectId] : []), obj.id, shiftKey)
      targetSec.selectObjects(next.ids)
    } else {
      applySectionSelection(targetSec, [obj.id])
    }
    if (targetSec.id === "blackout-effects" && obj.id.startsWith("specimen:")) {
      targetSec.retrigger?.()
    }
    panel.sync()
    syncChrome()
    void renderNow()
  }

  /** Sections without selection hooks still get a workbench-tracked single selection. */
  function applySectionSelection(sec: LabSection, ids: readonly string[]) {
    if (sec.selectObjects) sec.selectObjects(ids)
    else if (sec.selectObject) sec.selectObject(ids.at(-1) ?? null)
    else {
      sec.selectedObjectId = ids.at(-1)
      sec.selectedObjectIds = ids.length ? [ids.at(-1)!] : []
    }
  }

  /** Replace the selection with explicit ids (Outliner, ⌘K, CLI). Ids owned by another section than the primary are dropped. */
  function setSelectionIds(ids: readonly string[]) {
    const objs = allSceneObjects()
    const valid = ids.filter(id => objs.some(o => o.id === id))
    if (!valid.length) {
      selectWorldObject(null, false)
      return []
    }
    const primary = valid.at(-1)!
    const spawnOwned = (id: string) => Boolean(spawn?.section.objects?.().some(o => o.id === id))
    const useSpawn = spawnOwned(primary)
    const owned = valid.filter(id => spawnOwned(id) === useSpawn)
    if (useSpawn && globalSettings.section !== "spawn") selectSection("spawn")
    const sec = activeSection()
    applySectionSelection(sec, owned)
    if (sec.id === "blackout-effects" && primary.startsWith("specimen:")) sec.retrigger?.()
    panel.sync()
    syncChrome()
    void renderNow()
    return currentSelectedIds()
  }

  function applyActiveTransformToWorld(st: ActiveTransformState) {
    const owner = resolveObjectOwner(st.primaryId)
    const dyaw = st.currentYaw - st.origYaw
    for (const off of st.offsets) {
      owner.moveObject?.(off.id, st.currentX + off.dx, st.currentZ + off.dz, off.origYaw + dyaw)
    }
  }

  function restoreTransformToOrig(st: ActiveTransformState) {
    const owner = resolveObjectOwner(st.primaryId)
    for (const off of st.offsets) {
      owner.moveObject?.(off.id, off.origX, off.origZ, off.origYaw)
    }
  }

  function startTransformSelection(tMode: TransformMode, primaryObj?: LabWorldObject, viaHandle = false) {
    const selList = currentSelectedObjects().filter(o => o.movable)
    const primary = primaryObj ?? selList.at(-1) ?? activeTargetObject()
    if (!primary || !primary.movable) return
    const st = createTransformState(tMode, primary, selList, viaHandle)
    activeTransform = { ...st, before: captureSnapshot() }
    syncChrome()
  }

  function commitActiveTransform() {
    if (!activeTransform) return
    const count = activeTransform.offsets.length
    const verb = activeTransform.mode === "rotate" ? "Rotate" : "Move"
    recordHistory(count > 1 ? `${verb} ${count} objects` : `${verb} ${activeTransform.primaryId}`, activeTransform.before)
    activeTransform = null
    panel.sync()
    syncChrome()
    void renderNow()
  }

  const viewportCursor = createViewportCursorDOM(viewportHud, { canvas, hoverDelayMs: 180 })
  const transformGizmo = createTransformGizmoDOM(viewportHud, {
    onHoverHandle: (tMode, clientX, clientY) => {
      if (mode === "play" || radialState.phase !== "closed" || activeTransform) return
      hoveredGizmoHandle = tMode
      const vRect = viewportEl.getBoundingClientRect()
      const lx = clientX - vRect.left
      const ly = clientY - vRect.top
      if (tMode) {
        viewportCursor.update({ state: tMode, x: lx, y: ly })
      } else {
        viewportCursor.update({ state: "default", x: lx, y: ly })
      }
    },
    onStartHandleDrag: (tMode, pointerId, clientX, clientY) => {
      if (mode === "play") return
      startTransformSelection(tMode, undefined, true)
      const vRect = viewportEl.getBoundingClientRect()
      viewportCursor.update({ state: tMode, x: clientX - vRect.left, y: clientY - vRect.top })
      canvas.focus({ preventScroll: true })
      try {
        canvas.setPointerCapture(pointerId)
      } catch {
        // Synthetic pointer events in tests may not have an active pointerId
      }
    },
    onCommitNumeric: (axis: NumericAxis, value: number) => {
      const selList = currentSelectedObjects().filter(o => o.movable)
      const primary = selList.at(-1) ?? activeTargetObject()
      if (!primary || !primary.movable) return
      const owner = resolveObjectOwner(primary.id)
      const before = captureSnapshot()
      const targets = selList.length > 0 ? selList : [primary]
      if (axis === "x") {
        const cx = targets.reduce((a, o) => a + o.x, 0) / targets.length
        const dx = value - cx
        for (const o of targets) owner.moveObject?.(o.id, o.x + dx, o.z, o.yaw)
        recordHistory(`Set X = ${value}m`, before)
      } else if (axis === "z") {
        const cz = targets.reduce((a, o) => a + o.z, 0) / targets.length
        const dz = value - cz
        for (const o of targets) owner.moveObject?.(o.id, o.x, o.z + dz, o.yaw)
        recordHistory(`Set Z = ${value}m`, before)
      } else if (axis === "yaw") {
        const nextRad = (value * Math.PI) / 180
        const dyaw = nextRad - (primary.yaw ?? 0)
        for (const o of targets) owner.moveObject?.(o.id, o.x, o.z, (o.yaw ?? 0) + dyaw)
        recordHistory(`Set Yaw = ${value}°`, before)
      }
      panel.sync()
      syncChrome()
      void renderNow()
    },
  })

  transformGizmo.root.addEventListener("contextmenu", event => event.preventDefault())
  transformGizmo.root.addEventListener("pointerdown", event => {
    if (mode === "play") return
    if (event.button === 2 || (event.button === 0 && event.ctrlKey && !event.metaKey)) {
      event.preventDefault()
      event.stopPropagation()
      hoveredGizmoHandle = null
      openRadialAtScreen(event.clientX, event.clientY, true)
    }
  })

  const radialDOM = createRadialMenuDOM(viewportEl, radialState, handleRadialResult)
  const origNavSet = panel.navigation.set.bind(panel.navigation)
  panel.navigation.set = (control, value) => {
    origNavSet(control, value)
    if (isCapturingWipe) return
    const didResim = resimulateFrozenFrame(control)
    if (slotA && activeSlot === "B") {
      slotB = { snapshot: captureSnapshot(), frames, elapsed }
    }
    if (compareWipeEnabled && slotA) {
      syncCompareWipeOverlay()
    }
    if (didResim || ("playing" in activeSection().settings && !activeSection().settings.playing)) {
      void renderNow()
    }
  }

  function handleRadialResult(res: RadialReleaseResult) {
    if (res.outcome === "execute") {
      res.sector.command.run(radialState.commandContext)
      canvas.focus({ preventScroll: true })
    } else if (res.outcome === "disabled") {
      showToast(res.sector.disabledReason ?? "Unavailable in this context", true)
      canvas.focus({ preventScroll: true })
    } else if (res.outcome === "cancel") {
      canvas.focus({ preventScroll: true })
    }
    syncChrome()
  }

  commands.registerAll([
    // Object Ring (Slots 0..7: N, NE, E, SE, S, SW, W, NW)
    {
      id: "object.trigger",
      label: "Trigger / Wake Object",
      shortLabel: "Trigger",
      category: "Object",
      shortcut: "Space",
      accelerators: ["space"],
      icon: "zap",
      radial: { context: "object", slot: 0 },
      enabled: ctx => Boolean(activeTargetObject(ctx)),
      disabledReason: () => "No target object",
      run: ctx => {
        const obj = activeTargetObject(ctx)
        if (!obj) return
        selectWorldObject(obj)
        const owner = resolveObjectOwner(obj.id)
        if (obj.category === "prop" && spawn) {
          spawn.physics.wakeAll?.()
          showToast(`Woke ${obj.label}`)
        } else {
          elapsed = 0
          frames = 0
          owner.retrigger?.()
          showToast(`Triggered ${obj.label}`)
        }
        panel.sync()
        syncChrome()
        void renderNow()
      },
    },
    {
      id: "object.possess",
      label: "Possess Character",
      shortLabel: "Possess",
      category: "Mode",
      shortcut: "P",
      accelerators: ["p"],
      icon: "gamepad",
      radial: { context: "object", slot: 1 },
      enabled: ctx => (ctx?.pickedObject ? ctx.pickedObject.category === "character" : Boolean(spawn?.adapters.characters.length)),
      disabledReason: ctx =>
        ctx?.pickedObject && ctx.pickedObject.category !== "character"
          ? "Only characters can be possessed"
          : "No controllable character or vehicle in this Lab",
      run: ctx => {
        const obj = ctx?.pickedObject ?? activeTargetObject(ctx)
        if (obj?.category === "character") selectWorldObject(obj)
        setPlayMode("play")
      },
    },
    {
      id: "object.duplicate",
      label: "Duplicate Object",
      shortLabel: "Duplicate",
      category: "Object",
      shortcut: "D",
      accelerators: ["d"],
      icon: "copy",
      radial: { context: "object", slot: 2 },
      enabled: ctx => {
        const obj = activeTargetObject(ctx)
        return Boolean(obj?.deletable && resolveObjectOwner(obj.id).duplicateObject)
      },
      disabledReason: () => "Fixed scene object cannot be duplicated",
      run: ctx => {
        const obj = activeTargetObject(ctx)
        if (!obj) return
        const owner = resolveObjectOwner(obj.id)
        if (!owner.duplicateObject) return
        const before = captureSnapshot()
        if (owner.id === "spawn" && globalSettings.section !== "spawn") selectSection("spawn")
        const selIds = owner.selectedObjectIds?.length ? [...owner.selectedObjectIds] : [obj.id]
        const targetIds = selIds.includes(obj.id) ? selIds : [obj.id]
        if (targetIds.length > 1 && owner.duplicateObjects) {
          const created = owner.duplicateObjects(targetIds)
          if (created.length > 0) {
            recordHistory(`Duplicate ${created.length} objects`, before)
            panel.sync()
            syncChrome()
            void renderNow()
            showToast(`Duplicated ${created.length} objects`)
          }
          return
        }
        const dupId = owner.duplicateObject(obj.id)
        if (dupId) {
          recordHistory(`Duplicate ${obj.label}`, before)
          panel.sync()
          syncChrome()
          void renderNow()
          showToast(`Duplicated ${obj.label}`)
        }
      },
    },
    {
      id: "object.inspect",
      label: "Inspect Object",
      shortLabel: "Inspect",
      category: "Inspector",
      shortcut: "I",
      accelerators: ["i"],
      icon: "search",
      radial: { context: "object", slot: 3 },
      enabled: ctx => Boolean(activeTargetObject(ctx)),
      disabledReason: () => "No object to inspect",
      run: ctx => {
        const obj = activeTargetObject(ctx)
        if (obj && !currentSelectedIds().includes(obj.id)) selectWorldObject(obj)
        if (root.dataset.closed === "true") panel.toggle()
        panel.setReturnFocus(canvas)
        focusZone = "inspector"
        panel.focusFirst()
        syncTransportAndHints()
      },
    },
    {
      id: "object.delete",
      label: "Delete Object",
      shortLabel: "Delete",
      category: "Object",
      shortcut: "⌫",
      accelerators: ["backspace", "delete"],
      icon: "trash",
      radial: { context: "object", slot: 4 },
      enabled: ctx => {
        const obj = activeTargetObject(ctx)
        return Boolean(obj?.deletable && resolveObjectOwner(obj.id).deleteObject)
      },
      disabledReason: () => "Fixed scene object cannot be deleted",
      run: ctx => {
        const obj = activeTargetObject(ctx)
        if (!obj || !obj.deletable) return
        const owner = resolveObjectOwner(obj.id)
        if (!owner.deleteObject) return
        const before = captureSnapshot()
        const selIds = owner.selectedObjectIds?.length ? [...owner.selectedObjectIds] : [obj.id]
        const targetIds = selIds.includes(obj.id) ? selIds : [obj.id]
        if (targetIds.length > 1 && owner.deleteObjects) {
          const removed = owner.deleteObjects(targetIds)
          if (removed > 0) {
            recordHistory(`Delete ${removed} objects`, before)
            panel.sync()
            syncChrome()
            void renderNow()
            showToast(`Deleted ${removed} objects`)
          }
          return
        }
        if (owner.deleteObject(obj.id)) {
          recordHistory(`Delete ${obj.label}`, before)
          panel.sync()
          syncChrome()
          void renderNow()
          showToast(`Deleted ${obj.label}`)
        }
      },
    },
    {
      id: "object.reset",
      label: "Reset Object Transform",
      shortLabel: "Reset",
      category: "Object",
      shortcut: "0",
      accelerators: ["0"],
      icon: "reset",
      radial: { context: "object", slot: 5 },
      enabled: ctx => Boolean(activeTargetObject(ctx)?.movable),
      disabledReason: () => "Fixed room specimen",
      run: ctx => {
        const obj = activeTargetObject(ctx)
        if (!obj || !obj.movable) return
        const owner = resolveObjectOwner(obj.id)
        const before = captureSnapshot()
        if (obj.category === "emitter") {
          owner.moveObject?.(obj.id, 0, 0, 0)
        } else {
          for (const target of currentSelectedObjects().filter(o => o.movable)) {
            owner.moveObject?.(target.id, target.x, target.z, 0)
          }
          if (!currentSelectedIds().includes(obj.id)) {
            owner.moveObject?.(obj.id, obj.x, obj.z, 0)
          }
        }
        recordHistory(`Reset ${obj.label}`, before)
        panel.sync()
        syncChrome()
        void renderNow()
      },
    },
    {
      id: "object.move",
      label: "Move Object",
      shortLabel: "Move",
      category: "Object",
      shortcut: "G",
      accelerators: ["g"],
      icon: "move",
      radial: { context: "object", slot: 6 },
      enabled: ctx => Boolean(activeTargetObject(ctx)?.movable),
      disabledReason: () => "Fixed room specimen",
      run: ctx => {
        const obj = activeTargetObject(ctx)
        if (!obj || !obj.movable) return
        if (!currentSelectedIds().includes(obj.id)) selectWorldObject(obj)
        startTransformSelection("move", obj, false)
        showToast(`Moving ${obj.label} · Click/Enter commit, R rotate, type number, Esc cancel`)
      },
    },
    {
      id: "object.rotate",
      label: "Rotate Object",
      shortLabel: "Rotate",
      category: "Object",
      shortcut: "⇧R",
      enabled: ctx => Boolean(activeTargetObject(ctx)?.movable),
      disabledReason: () => "Fixed room specimen",
      run: ctx => {
        const obj = activeTargetObject(ctx)
        if (!obj || !obj.movable) return
        if (!currentSelectedIds().includes(obj.id)) selectWorldObject(obj)
        startTransformSelection("rotate", obj, false)
        showToast(`Rotating ${obj.label} · Move mouse or type degrees, Enter commit, Esc cancel`)
      },
    },
    {
      id: "object.frame",
      label: "Frame Object",
      shortLabel: "Frame",
      category: "Scene",
      shortcut: "F",
      accelerators: ["f"],
      icon: "frame",
      radial: { context: "object", slot: 7 },
      enabled: () => true,
      run: ctx => {
        const obj = activeTargetObject(ctx)
        if (obj) {
          selectWorldObject(obj)
          stage.frameTarget(obj.x, obj.y, obj.z, 14)
          void renderNow()
        } else {
          frameActiveTarget()
        }
      },
    },

    // Empty-Ground Ring (Slots 0..7: N, NE, E, SE, S, SW, W, NW)
    {
      id: "ground.trigger-here",
      label: "Trigger FX Here",
      shortLabel: "Trigger",
      category: "Scene",
      shortcut: "Space",
      accelerators: ["space"],
      icon: "zap",
      radial: { context: "ground", slot: 0 },
      enabled: () => true,
      run: ctx => {
        const sec = activeSection()
        const hit = ctx?.groundHit
        const before = captureSnapshot()
        if (hit) {
          if (sec.id === "spawn" && spawn) {
            spawn.effectAt({ x: hit.x, y: hit.y, z: hit.z, yaw: 0 })
          } else {
            const emitter = sec.objects?.().find(o => o.category === "emitter")
            if (emitter && sec.moveObject) {
              sec.moveObject(emitter.id, hit.x, hit.z, emitter.yaw)
            }
            elapsed = 0
            frames = 0
            sec.retrigger?.()
          }
          recordHistory("Trigger FX at cursor", before)
        } else {
          elapsed = 0
          frames = 0
          sec.retrigger?.()
          if (variationGrid && sec.id === "effects" && effects) {
            effects.resetVariantSlots(variationGrid.tiles)
          }
        }
        panel.sync()
        syncChrome()
        void renderNow()
      },
    },
    {
      id: "ground.spawn-char",
      label: "Spawn Character Here",
      shortLabel: "Possess",
      category: "Scene",
      shortcut: "P",
      accelerators: ["p"],
      icon: "user-plus",
      radial: { context: "ground", slot: 1 },
      enabled: () => Boolean(spawn),
      disabledReason: () => "No character adapter available",
      run: ctx => {
        if (!spawn) return
        const before = captureSnapshot()
        if (globalSettings.section !== "spawn") selectSection("spawn")
        const hit = ctx?.groundHit
        const chId = String(spawn.section.settings.character || spawn.adapters.characters[0]?.id || "getaway:muscle")
        if (hit) {
          spawn.spawnCharacterAt(chId, { x: hit.x, y: hit.y, z: hit.z, yaw: Math.PI })
        } else {
          spawn.spawnCharacterAt(chId)
        }
        recordHistory("Spawn character", before)
        panel.sync()
        syncChrome()
        void renderNow()
      },
    },
    {
      id: "ground.spawn-here",
      label: "Spawn Prop Here",
      shortLabel: "Spawn Here",
      category: "Scene",
      shortcut: "A",
      accelerators: ["a", "e"],
      icon: "pin-plus",
      radial: { context: "ground", slot: 2 },
      args: {
        asset: { type: "string", description: "Prop kind, character ID, or light kind" },
        at: { type: "string", description: "Coordinates 'x,z' or named spot (center, ahead, ramp, pad, alcove, lane)" },
        yaw: { type: "number", description: "Yaw in degrees" },
        shape: { type: "string", enum: ["one", "row", "grid"] },
        count: { type: "number", min: 1, max: 24 },
        seed: { type: "number", description: "Optional seed" },
      },
      enabled: ctx => Boolean(spawn) && (ctx?.source !== "cli" || mode !== "play"),
      disabledReason: () => (mode === "play" ? "Unavailable in Play mode (character is possessed). Run 'arcade release' first." : "No prop adapter available"),
      run: (ctx, args) => {
        if (!spawn) return
        const hasExplicitSpawn = Boolean(args?.asset || args?.at)
        if (!hasExplicitSpawn) {
          const before = captureSnapshot()
          if (globalSettings.section !== "spawn") selectSection("spawn")
          const hit = ctx?.groundHit
          if (hit) {
            spawn.spawnItems("one", { x: hit.x, y: hit.y, z: hit.z, yaw: 0 })
            recordHistory(`Place ${spawn.section.settings.item}`, before)
            showToast(`Placed ${spawn.section.settings.item} at (${hit.x.toFixed(1)}, ${hit.z.toFixed(1)})`)
          } else {
            const item = String(spawn.section.settings.item || "cone")
            spawn.setGhost({ category: "prop", kind: item, x: 0, y: yardGround(0, 2), z: 2, yaw: 0, shape: "one", valid: true })
          }
          panel.sync()
          syncChrome()
          void renderNow()
          return
        }

        const groundFn = activeSection().groundHeight ?? spawn.section.groundHeight ?? yardGround
        const parseSpot = (rawAt: string | undefined): { x: number; y: number; z: number } => {
          if (!rawAt || !rawAt.trim()) return { x: 0, y: groundFn(0, 2), z: 2 }
          const s = rawAt.trim().toLowerCase()
          const spots: Record<string, [number, number]> = {
            center: [0, 0],
            origin: [0, 0],
            ramp: [18, -6],
            pad: [-18, 0],
            "skid-pad": [-18, 0],
            alcove: [0, -18],
            glass: [0, -18],
            lane: [0, 8],
          }
          if (s === "ahead") {
            const ch = allSceneObjects().find(o => o.category === "character")
            if (ch) {
              const yaw = ch.yaw ?? Math.PI
              const ax = Math.round((ch.x + Math.sin(yaw) * 4) * 100) / 100
              const az = Math.round((ch.z + Math.cos(yaw) * 4) * 100) / 100
              return { x: ax, y: groundFn(ax, az), z: az }
            }
            return { x: 0, y: groundFn(0, 2), z: 2 }
          }
          if (s in spots) {
            const [sx, sz] = spots[s]!
            return { x: sx, y: groundFn(sx, sz), z: sz }
          }
          const parts = s.split(",").map(p => Number(p.trim()))
          if (parts.length === 2 && parts.every(Number.isFinite)) {
            const [px, pz] = parts as [number, number]
            return { x: px, y: groundFn(px, pz), z: pz }
          }
          if (parts.length === 3 && parts.every(Number.isFinite)) {
            const [px, py, pz] = parts as [number, number, number]
            return { x: px, y: py, z: pz }
          }
          throw new Error(`Invalid spawn location "${rawAt}". Expected "x,z", "x,y,z", or named spot (${Object.keys(spots).concat("ahead").join(", ")}).`)
        }

        const rawAsset = String(args?.asset ?? spawn.section.settings.item ?? "cone").trim()
        const spot = ctx?.groundHit ?? parseSpot(typeof args?.at === "string" ? args.at : undefined)
        const yawDeg = typeof args?.yaw === "number" ? args.yaw : 0
        const yawRad = (yawDeg * Math.PI) / 180
        const before = captureSnapshot()

        if (globalSettings.section !== "spawn") selectSection("spawn")
        if (typeof ctx?.seed === "number") {
          spawn.section.settings.seed = ctx.seed
        }

        const q = rawAsset.toLowerCase().replace(/^getaway:prop:/, "")
        const charMatch =
          spawn.adapters.characters.find(c => c.id.toLowerCase() === q) ??
          spawn.adapters.characters.find(c => c.id.toLowerCase().endsWith(`:${q}`)) ??
          spawn.adapters.characters.find(c => c.label.toLowerCase() === q)
        if (charMatch) {
          spawn.section.settings.character = charMatch.id
          spawn.spawnCharacterAt(charMatch.id, { x: spot.x, y: spot.y, z: spot.z, yaw: typeof args?.yaw === "number" ? yawRad : Math.PI })
          spawn.section.selectObject?.("character:active")
          recordHistory(`Spawn ${charMatch.label}`, before)
          panel.sync()
          syncChrome()
          void renderNow()
          const spawnedObj = allSceneObjects().find(o => o.id === "character:active")
          return {
            spawned: "character",
            id: "character:active",
            characterId: charMatch.id,
            label: charMatch.label,
            at: { x: spot.x, y: spot.y, z: spot.z, yaw: yawDeg },
            object: spawnedObj ?? null,
          }
        }

        const lightClean = q.replace(/^light:/, "")
        if (lightClean === "lamp" || lightClean === "spotlight" || lightClean === "torch") {
          spawn.section.settings.light = lightClean
          spawn.lightAt({ x: spot.x, y: spot.y, z: spot.z, yaw: yawRad })
          recordHistory(`Place ${lightClean}`, before)
          panel.sync()
          syncChrome()
          void renderNow()
          return {
            spawned: "light",
            kind: lightClean,
            id: spawn.section.selectedObjectId,
            at: { x: spot.x, y: spot.y, z: spot.z, yaw: yawDeg },
          }
        }

        const propMatch =
          spawn.adapters.items.items.find(i => i.id.toLowerCase() === q) ??
          spawn.adapters.items.items.find(i => i.label.toLowerCase() === q) ??
          spawn.adapters.items.items.find(i => i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
        if (!propMatch) {
          const validProps = spawn.adapters.items.items.map(i => i.id).join(", ")
          const validChars = spawn.adapters.characters.map(c => c.id).join(", ")
          throw new Error(`Unknown spawn asset "${rawAsset}". Valid props: ${validProps}. Valid characters: ${validChars}.`)
        }
        spawn.section.settings.item = propMatch.id
        if (typeof args?.count === "number") {
          spawn.section.settings.count = args.count
        }
        const shape = (typeof args?.shape === "string" ? args.shape : "one") as "one" | "row" | "grid"
        spawn.spawnItems(shape, { x: spot.x, y: spot.y, z: spot.z, yaw: yawRad })
        recordHistory(`Place ${propMatch.label}`, before)
        panel.sync()
        syncChrome()
        void renderNow()
        const selId = spawn.section.selectedObjectId
        const spawnedObj = selId ? allSceneObjects().find(o => o.id === selId) : null
        return {
          spawned: "prop",
          kind: propMatch.id,
          label: propMatch.label,
          id: selId,
          shape,
          at: { x: spot.x, y: spot.y, z: spot.z, yaw: yawDeg },
          object: spawnedObj ?? null,
          totalProps: spawn.adapters.items.entries?.().length ?? 0,
        }
      },
    },
    {
      id: "ground.drop-light",
      label: "Drop Light / Inspect",
      shortLabel: "Inspect",
      category: "Scene",
      shortcut: "L",
      accelerators: ["l", "i"],
      icon: "light",
      radial: { context: "ground", slot: 3 },
      enabled: () => true,
      run: ctx => {
        const hit = ctx?.groundHit
        if (spawn && hit) {
          const before = captureSnapshot()
          if (globalSettings.section !== "spawn") selectSection("spawn")
          spawn.lightAt({ x: hit.x, y: hit.y, z: hit.z, yaw: 0 })
          recordHistory(`Place ${spawn.section.settings.light}`, before)
          panel.sync()
          syncChrome()
          void renderNow()
        } else {
          if (root.dataset.closed === "true") panel.toggle()
          panel.setReturnFocus(canvas)
          focusZone = "inspector"
          panel.focusFirst()
          syncTransportAndHints()
        }
      },
    },
    {
      id: "ground.clear",
      label: "Clear Transients",
      shortLabel: "Delete",
      category: "Scene",
      shortcut: "⌫",
      accelerators: ["backspace", "delete"],
      icon: "eraser",
      radial: { context: "ground", slot: 4 },
      enabled: () => true,
      run: () => {
        context.particles.reset()
        context.trail.reset()
        context.volume.reset(context.activeWalls?.() ?? [])
        spawn?.adapters.items.clearSkids?.()
        showToast("Cleared transient particles, volumes, and skids")
        syncChrome()
        void renderNow()
      },
    },
    {
      id: "ground.reroll",
      label: "Reroll Room Seed",
      shortLabel: "Reroll",
      category: "Scene",
      shortcut: "R",
      accelerators: ["r", "0"],
      icon: "shuffle",
      radial: { context: "ground", slot: 5 },
      enabled: () => Boolean(activeSection().reroll || resolveEnvOwner().reroll),
      disabledReason: () => "Current section has no room seed",
      run: () => {
        const owner = activeSection().reroll ? activeSection() : resolveEnvOwner()
        if (!owner.reroll) return
        const before = captureSnapshot()
        owner.reroll()
        recordHistory("Reroll room seed", before)
        panel.sync()
        syncChrome()
        void renderNow()
      },
    },
    {
      id: "ground.move-here",
      label: "Move Selected Here",
      shortLabel: "Move",
      category: "Object",
      shortcut: "G",
      accelerators: ["g"],
      icon: "move",
      radial: { context: "ground", slot: 6 },
      enabled: () => Boolean(activeTargetObject()?.movable),
      disabledReason: () => "No movable object selected",
      run: ctx => {
        const sel = activeTargetObject()
        if (!sel || !sel.movable) return
        const owner = resolveObjectOwner(sel.id)
        const hit = ctx?.groundHit
        if (hit && owner.moveObject) {
          const before = captureSnapshot()
          owner.moveObject(sel.id, hit.x, hit.z, sel.yaw)
          recordHistory(`Move ${sel.label}`, before)
          panel.sync()
          syncChrome()
          void renderNow()
        } else {
          startTransformSelection("move", sel, false)
        }
      },
    },
    {
      id: "ground.frame",
      label: "Frame Scene",
      shortLabel: "Frame",
      category: "Scene",
      shortcut: "F",
      accelerators: ["f"],
      icon: "frame",
      radial: { context: "ground", slot: 7 },
      enabled: () => true,
      run: () => frameActiveTarget(),
    },

    // Non-radial palette/toolbar commands
    {
      id: "mode.play",
      label: "Enter Play Mode",
      shortLabel: "Play",
      category: "Mode",
      shortcut: "P",
      args: {
        mode: { type: "string", enum: ["edit", "play"], description: "Target mode ('edit' or 'play')" },
        target: { type: "string", description: "Optional character ID/name to possess" },
      },
      enabled: () => Boolean(spawn?.adapters.characters.length),
      disabledReason: () => "No controllable character or vehicle in this Lab",
      run: (_ctx, args) => {
        const nextMode = args?.mode === "edit" || args?.mode === "play" ? args.mode : mode === "play" ? "edit" : "play"
        const rawTarget = typeof args?.target === "string" ? args.target.trim() : ""
        if (nextMode === "play" && rawTarget && spawn && rawTarget !== "character:active" && rawTarget !== "active") {
          const q = rawTarget.toLowerCase()
          const charMatch =
            spawn.adapters.characters.find(c => c.id.toLowerCase() === q) ??
            spawn.adapters.characters.find(c => c.id.toLowerCase().endsWith(`:${q}`)) ??
            spawn.adapters.characters.find(c => c.label.toLowerCase() === q || c.label.toLowerCase().includes(q))
          if (!charMatch) {
            throw new Error(`Unknown character "${rawTarget}". Available: ${spawn.adapters.characters.map(c => c.id).join(", ")}.`)
          }
          if (globalSettings.section !== "spawn") selectSection("spawn")
          if (spawn.section.settings.character !== charMatch.id || !spawn.hasCharacter()) {
            spawn.section.settings.character = charMatch.id
            spawn.spawnCharacterAt(charMatch.id)
          }
        }
        setPlayMode(nextMode)
        void renderNow()
        return {
          mode,
          ejected,
          characterId: spawn?.section.settings.character ?? null,
          characterLabel: spawn?.characterLabel() ?? null,
        }
      },
    },
    {
      id: "mode.eject",
      label: "Toggle Eject Camera in Play Mode",
      shortLabel: "Eject",
      category: "Mode",
      shortcut: "F8",
      enabled: () => Boolean(spawn?.adapters.characters.length),
      disabledReason: () => "No controllable character or vehicle in this Lab",
      run: () => {
        toggleEject()
        void renderNow()
        return {
          mode,
          ejected,
          characterId: spawn?.section.settings.character ?? null,
          characterLabel: spawn?.characterLabel() ?? null,
        }
      },
    },
    {
      id: "edit.undo",
      label: "Undo Last Edit",
      shortLabel: "Undo",
      category: "Preset",
      shortcut: "⌘Z",
      enabled: () => mode !== "play" && undoStack.length > 0,
      disabledReason: () => (mode === "play" ? "Unavailable in Play mode" : "Nothing to undo"),
      run: () => {
        const label = undoStack.at(-1)?.label ?? null
        const ok = undo()
        return { undone: ok, label, undoCount: undoStack.length, redoCount: redoStack.length }
      },
    },
    {
      id: "edit.redo",
      label: "Redo Last Edit",
      shortLabel: "Redo",
      category: "Preset",
      shortcut: "⇧⌘Z",
      enabled: () => mode !== "play" && redoStack.length > 0,
      disabledReason: () => (mode === "play" ? "Unavailable in Play mode" : "Nothing to redo"),
      run: () => {
        const label = redoStack.at(-1)?.label ?? null
        const ok = redo()
        return { redone: ok, label, undoCount: undoStack.length, redoCount: redoStack.length }
      },
    },
    {
      id: "preset.export",
      label: "Export Preset JSON",
      shortLabel: "Export",
      category: "Preset",
      args: {
        name: { type: "string", description: "Optional preset name to save in local library" },
      },
      enabled: () => true,
      run: (ctx, args) => {
        const payload = buildPresetPayload()
        const name = typeof args?.name === "string" && args.name.trim() ? args.name.trim() : null
        if (name) {
          try {
            const existing = JSON.parse(localStorage.getItem("arcade.lab.presets.v1") ?? "{}") as Record<string, LabPresetSchema>
            existing[name] = payload
            localStorage.setItem("arcade.lab.presets.v1", JSON.stringify(existing))
          } catch {}
        }
        if (ctx?.source !== "cli" && !name) {
          openPresetModal("export")
        }
        return {
          name,
          preset: payload,
          json: JSON.stringify(payload, null, 2),
        }
      },
    },
    {
      id: "preset.import",
      label: "Import Preset JSON",
      shortLabel: "Import",
      category: "Preset",
      args: {
        name: { type: "string", description: "Saved preset name" },
        json: { type: "string", description: "Serialized LabPresetSchema JSON" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (ctx, args) => {
        let rawJson = typeof args?.json === "string" ? args.json : ""
        if (!rawJson && typeof args?.name === "string" && args.name.trim()) {
          const name = args.name.trim()
          try {
            const saved = JSON.parse(localStorage.getItem("arcade.lab.presets.v1") ?? "{}") as Record<string, unknown>
            if (saved[name]) rawJson = JSON.stringify(saved[name])
          } catch {}
          if (!rawJson) throw new Error(`No saved preset named "${name}".`)
        }
        if (rawJson) {
          const res = applyPresetJson(rawJson)
          if (!res.ok) throw new Error(res.error)
          void renderNow()
          return { loaded: true, section: globalSettings.section, preset: buildPresetPayload() }
        }
        if (ctx?.source === "cli") {
          throw new Error("preset.import requires either 'name' or 'json'.")
        }
        openPresetModal("import")
      },
    },
    {
      id: "preset.copy-recipe",
      label: "Copy Recipe for Game",
      shortLabel: "Copy Recipe",
      category: "Preset",
      enabled: () => true,
      run: () => openRecipeModal(),
    },
    {
      id: "compare.pin-a",
      label: "Pin Baseline Slot A",
      shortLabel: "Pin A",
      category: "Compare",
      shortcut: "B",
      enabled: () => true,
      run: () => pinBaselineSlotA(),
    },
    {
      id: "compare.flip",
      label: "Flip Compare Slot A / B",
      shortLabel: "Flip A/B",
      category: "Compare",
      shortcut: "V",
      enabled: () => true,
      run: () => flipCompareSlot(),
    },
    {
      id: "compare.wipe",
      label: "Toggle Split-Screen A/B Wipe",
      shortLabel: "Wipe A/B",
      category: "Compare",
      shortcut: "⇧V",
      enabled: () => true,
      run: () => toggleCompareWipe(),
    },
    {
      id: "grid.open",
      aliases: ["grid"],
      label: "Open Multi-Tile Variation Grid",
      shortLabel: "Grid",
      category: "Compare",
      args: {
        preset: {
          type: "string",
          description: "Named variation grid preset ('looks', 'explosions', 'smoke', 'materials', 'foliage', 'lighting')",
        },
        section: { type: "string", description: "Target Lab section ID" },
        title: { type: "string", description: "Grid title" },
        cols: { type: "number", min: 1, max: 4, description: "Columns count (1..4)" },
        tiles: { type: "object", description: "Array of 2..9 tile definitions ({ label, preset?, settings?, lighting?, subtitle? })" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode. Run 'arcade release' first.",
      run: (_ctx, args) => {
        const cfg = openVariationGrid(args as Record<string, unknown> | undefined)
        return {
          active: true,
          id: cfg.id,
          title: cfg.title,
          section: cfg.section,
          cols: cfg.cols,
          rows: cfg.rows,
          tileCount: cfg.tiles.length,
          focusedTile: focusedGridTile,
          frameCostMs: variationGridCostMs !== null ? Number(variationGridCostMs.toFixed(2)) : null,
          tiles: cfg.tiles.map((t, i) => ({
            tile: i + 1,
            label: t.label,
            subtitle: summarizeTileSettings(t),
            preset: t.preset ?? null,
            settings: t.settings ?? null,
          })),
        }
      },
    },
    {
      id: "grid.focus",
      label: "Focus or Unfocus Variation Grid Tile",
      shortLabel: "Focus Tile",
      category: "Compare",
      shortcut: "1–9",
      args: {
        tile: {
          type: "number",
          min: 0,
          max: 9,
          description: "Tile number 1..9 to focus full-size, or 0 to return to multi-tile grid",
        },
      },
      enabled: () => Boolean(variationGrid) && mode !== "play",
      disabledReason: () => (variationGrid ? "Unavailable in Play mode" : "Variation grid is not open. Run 'arcade grid' first."),
      run: (_ctx, args) => {
        const rawTile = typeof args?.tile === "number" ? args.tile : null
        const res = focusVariationTile(rawTile)
        return {
          active: true,
          id: variationGrid?.id ?? null,
          focusedTile: res.focusedTile,
          tile: res.tile
            ? {
                tile: res.focusedTile,
                label: res.tile.label,
                subtitle: summarizeTileSettings(res.tile),
              }
            : null,
        }
      },
    },
    {
      id: "grid.close",
      aliases: ["grid.off"],
      label: "Close Variation Grid",
      shortLabel: "Close Grid",
      category: "Compare",
      shortcut: "Esc",
      enabled: () => Boolean(variationGrid),
      disabledReason: () => "Variation grid is not open",
      run: () => {
        closeVariationGrid()
        return { active: false }
      },
    },
    {
      id: "transport.toggle",
      label: "Pause / Resume Simulation",
      shortLabel: "Pause",
      category: "Transport",
      shortcut: "K",
      args: {
        action: { type: "string", enum: ["play", "pause", "toggle"], description: "Optional explicit transport action" },
      },
      enabled: () => "playing" in activeSection().settings,
      run: (_ctx, args) => {
        const sec = activeSection()
        const act = args?.action
        if (act === "play") {
          if ("playing" in sec.settings) sec.settings.playing = true
          panel.sync()
          syncChrome()
          void renderNow()
        } else if (act === "pause") {
          if ("playing" in sec.settings) sec.settings.playing = false
          panel.sync()
          syncChrome()
          void renderNow()
        } else {
          playPauseBtn.click()
        }
        return { playing: Boolean(sec.settings.playing ?? true), elapsed: Number(elapsed.toFixed(3)), frames, speed: simSpeed }
      },
    },
    {
      id: "transport.step",
      label: "Step Forward 1 Frame (1/60s)",
      shortLabel: "Step",
      category: "Transport",
      shortcut: ".",
      args: {
        frames: { type: "number", required: false, min: 1, max: 120, description: "Number of 1/60s ticks to step" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        const count = typeof args?.frames === "number" ? Math.max(1, Math.min(120, Math.round(args.frames))) : 1
        for (let i = 0; i < count; i++) stepBtn.click()
        return { playing: false, stepped: count, elapsed: Number(elapsed.toFixed(3)), frames, speed: simSpeed }
      },
    },
    {
      id: "transport.speed",
      label: "Set Simulation Speed",
      shortLabel: "Speed",
      category: "Transport",
      args: {
        speed: { type: "number", required: true, min: 0.05, max: 4, description: "Simulation speed multiplier" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        const nextSpeed = Number(args?.speed ?? 1)
        simSpeed = nextSpeed
        speedSelect.value = String(nextSpeed)
        const sec = activeSection()
        if ("slowMotion" in sec.settings) {
          sec.settings.slowMotion = Math.min(1, simSpeed)
        }
        panel.sync()
        syncChrome()
        void renderNow()
        return { speed: simSpeed, playing: Boolean(sec.settings.playing ?? true), elapsed: Number(elapsed.toFixed(3)), frames }
      },
    },
    {
      id: "effect.trigger",
      aliases: ["transport.retrigger", "retrigger"],
      label: "Retrigger Active Effect",
      shortLabel: "Retrigger",
      category: "Transport",
      shortcut: "Space",
      args: {
        effect: { type: "string", description: "Optional effect ID to select before triggering" },
        seed: { type: "number", description: "Optional effect seed" },
      },
      enabled: () => Boolean(activeSection().retrigger),
      run: (ctx, args) => {
        const sec = activeSection()
        if (typeof args?.effect === "string" && args.effect.trim() && "effect" in sec.settings) {
          sec.settings.effect = args.effect.trim()
        }
        const nextSeed = typeof args?.seed === "number" ? args.seed : ctx?.seed
        if (typeof nextSeed === "number") {
          if ("effectSeed" in sec.settings) sec.settings.effectSeed = nextSeed
          else if ("seed" in sec.settings) sec.settings.seed = nextSeed
        }
        elapsed = 0
        frames = 0
        sec.retrigger?.()
        if (variationGrid && sec.id === "effects" && effects) {
          effects.resetVariantSlots(variationGrid.tiles)
        }
        panel.sync()
        syncChrome()
        void renderNow()
        return {
          section: sec.id,
          effect: sec.settings.effect ?? null,
          seed: sec.settings.effectSeed ?? sec.settings.seed ?? null,
          elapsed: 0,
          frames: 0,
        }
      },
    },
    {
      id: "effect.randomize",
      aliases: ["randomize"],
      label: "Randomize Active Effect Parameters & Retrigger",
      shortLabel: "Randomize",
      category: "Inspector",
      shortcut: "R",
      undoable: true,
      args: {
        group: { type: "string", description: "Optional parameter group name to randomize (omit for all active groups)" },
        seed: { type: "number", description: "Optional deterministic tuning seed" },
      },
      enabled: () => mode !== "play",
      run: (ctx, args) => {
        const sec = activeSection()
        const nextSeed = typeof args?.seed === "number" ? args.seed : ctx?.seed
        if (typeof nextSeed === "number" && "tuningSeed" in sec.settings) {
          sec.settings.tuningSeed = nextSeed
        }
        const targetGroup = typeof args?.group === "string" && args.group.trim() ? args.group.trim().toLowerCase() : null
        const customActions = sec.controls.filter(
          c =>
            c.type === "action" &&
            /^Randomize\b/i.test(c.label) &&
            (c.visible ? c.visible(sec.settings) : true) &&
            (!targetGroup || (c.group ?? "").toLowerCase().includes(targetGroup) || c.label.toLowerCase().includes(targetGroup)),
        )
        if (customActions.length > 0) {
          const dummyBtn = document.createElement("button")
          for (const act of customActions) {
            if (act.type === "action") void act.run(dummyBtn)
          }
        } else {
          const groups = new Set(
            panel.navigation.visibleRows
              .filter(r => r.control && r.group !== "Emitter" && r.group !== "Environment" && r.group !== "Origin & Seed")
              .map(r => r.group)
              .filter(g => !targetGroup || g.toLowerCase().includes(targetGroup)),
          )
          for (const g of groups) panel.navigation.randomize(g)
        }
        elapsed = 0
        frames = 0
        sec.retrigger?.()
        panel.sync()
        syncChrome()
        void renderNow()
        return {
          section: sec.id,
          effect: sec.settings.effect ?? null,
          tuningSeed: sec.settings.tuningSeed ?? null,
          settings: { ...sec.settings },
        }
      },
    },
    {
      id: "effect.loop",
      aliases: ["transport.loop"],
      label: "Set Effect Loop & Interval",
      shortLabel: "Loop",
      category: "Transport",
      args: {
        loop: { type: "boolean", description: "Enable or disable looping (omit to toggle)" },
        interval: { type: "number", min: 0.2, max: 15, description: "Loop interval in seconds" },
      },
      enabled: () => "loop" in activeSection().settings,
      run: (_ctx, args) => {
        const sec = activeSection()
        if (typeof args?.loop === "boolean") sec.settings.loop = args.loop
        else sec.settings.loop = !sec.settings.loop
        if (typeof args?.interval === "number" && "interval" in sec.settings) {
          sec.settings.interval = args.interval
        }
        panel.sync()
        syncChrome()
        void renderNow()
        return {
          loop: Boolean(sec.settings.loop),
          interval: "interval" in sec.settings ? Number(sec.settings.interval) : null,
        }
      },
    },
    {
      id: "scene.select-section",
      label: "Switch Lab Section",
      shortLabel: "Section",
      category: "Scene",
      undoable: true,
      args: {
        section: { type: "string", required: true, enum: sections.map(s => s.id), description: "Target section ID" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const secId = String(args?.section ?? "")
        if (sections.some(s => s.id === secId)) {
          selectSection(secId)
          syncChrome()
          void renderNow()
        }
      },
    },
    {
      id: "scene.set-env",
      label: "Set Scene Environment or Lighting Look",
      shortLabel: "Env",
      category: "Scene",
      undoable: true,
      args: {
        name: { type: "string", required: true, description: "Environment ID/label or lighting look" },
        seed: { type: "number", description: "Optional room/world seed" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (ctx, args) => {
        const rawName = String(args?.name ?? "").trim()
        if (!rawName) throw new Error("scene.set-env requires an environment name.")
        const q = rawName.toLowerCase()
        const slug = q.replace(/[^a-z0-9]+/g, "")

        const lookEntry = Object.entries(LIGHTING_LOOKS).find(
          ([k, v]) => k.toLowerCase() === q || v.label.toLowerCase() === q || k.replace(/_/g, "") === slug,
        )
        if (lookEntry) {
          const [lookKey, look] = lookEntry
          activeCatalogId = `lighting-look:${lookKey}`
          Object.assign(stage.lighting, look.values)
          panel.sync()
          syncChrome()
          void renderNow()
          return { kind: "lighting-look", environment: lookKey, label: look.label }
        }

        const owner = resolveEnvOwner()
        const envControl = owner.controls.find(c => (c.key === "environment" || c.key === "room") && "options" in c)
        if (envControl && "options" in envControl) {
          const opt = envControl.options.find(
            o =>
              String(o.value).toLowerCase() === q ||
              o.label.toLowerCase() === q ||
              o.label.toLowerCase().includes(q) ||
              String(o.value).toLowerCase().replace(/[^a-z0-9]+/g, "") === slug,
          )
          if (!opt) {
            const validOpts = envControl.options.map(o => `${String(o.value)} (${o.label})`).join(", ")
            throw new Error(`Unknown environment "${rawName}". Available: ${validOpts}, or looks: ${Object.keys(LIGHTING_LOOKS).join(", ")}.`)
          }
          const nextSeed = typeof args?.seed === "number" ? args.seed : ctx?.seed
          if (typeof nextSeed === "number") {
            if ("seed" in owner.settings) owner.settings.seed = nextSeed
            if ("roomSeed" in owner.settings) owner.settings.roomSeed = nextSeed
          }
          owner.settings[envControl.key] = opt.value
          envControl.change?.(opt.value)
          panel.sync()
          syncChrome()
          void renderNow()
          return {
            kind: "environment",
            environment: opt.value,
            label: opt.label,
            seed: owner.settings.seed ?? owner.settings.roomSeed ?? 7,
          }
        }
        throw new Error(`Active section "${activeSection().id}" has no switchable environment.`)
      },
    },
    {
      id: "scene.set-param",
      label: "Set Inspector Parameter",
      shortLabel: "Set Param",
      category: "Inspector",
      undoable: true,
      args: {
        key: { type: "string", required: true, description: "Parameter key on active section or lighting" },
        value: { type: "value", required: true, description: "Parameter value (number, boolean, or option)" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const key = String(args?.key ?? "").trim()
        const val = args?.value
        if (!key || val === undefined) throw new Error("scene.set-param requires key and value.")
        if (key === "twoFingerScroll") {
          const prev = getTwoFingerScrollMode()
          const next = String(val).toLowerCase()
          if (next !== "orbit" && next !== "pan") {
            throw new Error(`Invalid twoFingerScroll value "${String(val)}". Expected "orbit" or "pan".`)
          }
          setTwoFingerScrollMode(next)
          syncChrome()
          return { key: "twoFingerScroll", label: "Trackpad two-finger scroll", group: "Viewport", before: prev, value: next }
        }
        const found = findControlRow([panel], key)
        if (found) {
          const { control: c, row } = found
          if (c.type === "action") {
            void c.run(document.createElement("button"))
            panel.sync()
            syncChrome()
            void renderNow()
            return { key: c.key, label: c.label, group: row.group, action: "triggered" }
          }
          const prev = panel.navigation.settings[c.key]
          const next = coerceControlValue(c, val)
          panel.navigation.set(c, next)
          panel.sync()
          syncChrome()
          void renderNow()
          return {
            key: c.key,
            label: c.label,
            group: row.group,
            before: prev,
            value: panel.navigation.settings[c.key],
            formatted: formatControlValue(c, panel.navigation.settings[c.key]!),
          }
        }
        const sec = activeSection()
        if (key in sec.settings) {
          const prev = sec.settings[key]
          const ctrl = sec.controls.find(c => c.key === key)
          const next = ctrl ? coerceControlValue(ctrl, val) : val
          sec.settings[key] = next
          resimulateFrozenFrame()
          panel.sync()
          syncChrome()
          void renderNow()
          return { key, label: ctrl?.label ?? key, before: prev, value: next }
        }
        if (key in stage.lighting && (typeof val === "number" || typeof val === "boolean")) {
          const prev = (stage.lighting as Record<string, LabValue>)[key]
          ;(stage.lighting as Record<string, LabValue>)[key] = val
          panel.sync()
          syncChrome()
          void renderNow()
          return { key, label: key, group: "Lighting", before: prev, value: val }
        }
        throw new Error(`Unknown lab setting "${key}".`)
      },
    },
    {
      id: "object.select",
      label: "Select Scene Object",
      shortLabel: "Select",
      category: "Object",
      args: {
        id: { type: "string", required: true, description: "Scene object ID (e.g. prop:0, character:active) or catalog entry" },
        additive: { type: "boolean", required: false, description: "Add/toggle in multi-selection" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const id = String(args?.id ?? "").trim()
        if (!id) throw new Error("object.select requires a non-empty id.")
        const q = id.toLowerCase()
        const objs = allSceneObjects()
        const obj =
          objs.find(o => o.id === id || o.id.toLowerCase() === q) ??
          objs.find(o => o.label.toLowerCase() === q) ??
          objs.find(o => (q === "character" || q === "car" || q === "player") && o.category === "character") ??
          objs.find(o => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)) ??
          null
        if (obj) {
          selectWorldObject(obj, Boolean(args?.additive))
          return { kind: "object", selected: obj }
        }
        const catalog = buildCatalog()
        const entry =
          catalog.find(c => c.id.toLowerCase() === q) ??
          catalog.find(c => c.label.toLowerCase() === q) ??
          catalog.find(c => c.label.toLowerCase().includes(q) || c.id.toLowerCase().endsWith(`:${q}`))
        if (entry) {
          const before = captureSnapshot()
          entry.run(true)
          recordHistory(`Select ${entry.label}`, before)
          panel.sync()
          syncChrome()
          void renderNow()
          return { kind: "catalog", selected: { id: entry.id, label: entry.label, sectionId: entry.sectionId } }
        }
        const secMatch = sections.find(s => s.id.toLowerCase() === q || s.label.toLowerCase() === q)
        if (secMatch) {
          const before = captureSnapshot()
          selectSection(secMatch.id)
          recordHistory(`Section ${secMatch.label}`, before)
          panel.sync()
          syncChrome()
          void renderNow()
          return { kind: "section", selected: { id: secMatch.id, label: secMatch.label } }
        }
        throw new Error(`Unknown selection target "${id}".`)
      },
    },
    {
      id: "foliage.set",
      label: "Set Foliage Parameter(s)",
      shortLabel: "Foliage Set",
      category: "Inspector",
      undoable: true,
      args: {
        key: { type: "string", description: "Foliage parameter key (or pass parameter keys directly)" },
        value: { type: "value", description: "Parameter value when using { key, value }" },
        treePreset: { type: "string", enum: FOLIAGE_PRESET_IDS, description: "Species preset" },
        crownShape: { type: "string", enum: FOLIAGE_CROWN_SHAPES.map(s => s.value), description: "Crown silhouette shape" },
        stageMode: { type: "string", enum: ["lot", "swatch"], description: "Stage environment ('lot' = Outbreak house lot, 'swatch' = Hero tree pad)" },
        cameraMode: { type: "string", enum: ["close", "game"], description: "Camera view mode" },
        lightingPreset: { type: "string", enum: Object.keys(FOLIAGE_LIGHTING_PRESETS), description: "Stage lighting preset" },
        compare: { type: "number", min: 0, max: 2, description: "Comparison mode (0=Before, 1=After, 2=Split)" },
        tuningSeed: { type: "number", min: 1, max: 9999, description: "Parameter randomize seed" },
        ...Object.fromEntries(
          FOLIAGE_PARAM_SPECS.map(s => [
            s.key,
            { type: "number" as const, min: s.min, max: s.max, description: `${s.group} · ${s.label}${s.unit ? ` (${s.unit})` : ""}` },
          ]),
        ),
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const foliageSec = sections.find(s => s.id === "foliage")
        if (!foliageSec) throw new Error("Foliage section is not available on this page.")
        if (globalSettings.section !== "foliage") selectSection("foliage")
        const updates: [string, unknown][] = []
        if (typeof args?.key === "string" && args.key.trim() && args.value !== undefined) {
          updates.push([args.key.trim(), args.value])
        } else if (args && typeof args === "object") {
          for (const [k, v] of Object.entries(args)) {
            if (k !== "key" && k !== "value" && v !== undefined) updates.push([k, v])
          }
        }
        if (updates.length === 0) {
          throw new Error("foliage.set requires { key, value } or parameter key/value pairs.")
        }
        const applied: Record<string, LabValue> = {}
        for (const [k, rawVal] of updates) {
          const ctrl = foliageSec.controls.find(c => c.key === k || c.label.toLowerCase() === k.toLowerCase())
          if (ctrl && ctrl.type !== "action") {
            const coerced = coerceControlValue(ctrl, rawVal)
            panel.navigation.set(ctrl, coerced)
            applied[ctrl.key] = foliageSec.settings[ctrl.key]!
          } else if (k in foliageSec.settings) {
            foliageSec.settings[k] = rawVal as LabValue
            applied[k] = foliageSec.settings[k]!
          } else {
            throw new Error(`Unknown foliage parameter "${k}".`)
          }
        }
        foliageSec.prepare?.()
        panel.sync()
        syncChrome()
        void renderNow()
        return { section: "foliage", applied, settings: { ...foliageSettings } }
      },
    },
    {
      id: "foliage.randomize",
      label: "Randomize Foliage Parameters",
      shortLabel: "Randomize Foliage",
      category: "Inspector",
      undoable: true,
      args: {
        scope: { type: "string", enum: ["all", "tree", "grass"], description: "Scope to randomize ('all', 'tree', or 'grass')" },
        tuningSeed: { type: "number", min: 1, max: 9999, description: "Optional deterministic tuning seed" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const foliageSec = sections.find(s => s.id === "foliage")
        if (!foliageSec) throw new Error("Foliage section is not available on this page.")
        if (globalSettings.section !== "foliage") selectSection("foliage")
        const scope = args?.scope === "tree" || args?.scope === "grass" ? args.scope : "all"
        const tSeed =
          typeof args?.tuningSeed === "number" && Number.isFinite(args.tuningSeed)
            ? Math.max(1, Math.min(9999, Math.round(args.tuningSeed)))
            : Math.max(1, Math.min(9999, Math.round(Number(foliageSec.settings.tuningSeed) || 41)))
        const next = randomizeFoliageParams(foliageSettings, tSeed, scope)
        Object.assign(foliageSettings, next)
        foliageSec.settings.tuningSeed = (tSeed % 9999) + 1
        foliageSec.retrigger?.()
        panel.sync()
        syncChrome()
        void renderNow()
        return {
          scope,
          seed: Number(foliageSec.settings.seed),
          usedTuningSeed: tSeed,
          nextTuningSeed: Number(foliageSec.settings.tuningSeed),
          settings: { ...foliageSettings },
        }
      },
    },
    {
      id: "foliage.preset",
      label: "Load, Reset, or Export Foliage Preset",
      shortLabel: "Foliage Preset",
      category: "Preset",
      undoable: true,
      args: {
        preset: {
          type: "string",
          enum: [...FOLIAGE_PRESET_IDS, "reset"],
          description: "Named tree/foliage preset ('oak', 'maple', 'birch', 'pine', 'hydrangea') or 'reset'",
        },
        lighting: {
          type: "string",
          enum: Object.keys(FOLIAGE_LIGHTING_PRESETS),
          description: "Optional Outbreak lighting preset ('outbreak_dusk', 'outbreak_day', 'outbreak_night', 'cold_moon')",
        },
        stageMode: {
          type: "string",
          enum: ["lot", "swatch"],
          description: "Optional stage mode ('lot' = Outbreak house lot, 'swatch' = Hero tree pad)",
        },
        cameraMode: {
          type: "string",
          enum: ["close", "game"],
          description: "Optional camera mode ('close' or 'game')",
        },
        compare: {
          type: "number",
          min: 0,
          max: 2,
          description: "Optional comparison mode (0=Before, 1=After, 2=Split)",
        },
        json: { type: "string", description: "Optional FoliagePresetV1 JSON payload to import" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const foliageSec = sections.find(s => s.id === "foliage")
        if (!foliageSec) throw new Error("Foliage section is not available on this page.")
        if (globalSettings.section !== "foliage") selectSection("foliage")

        if (typeof args?.json === "string" && args.json.trim()) {
          const imported = importFoliagePreset(args.json)
          if (!imported.ok) throw new Error(imported.error)
          const val = imported.value
          foliageSec.settings.seed = val.seed
          foliageSec.settings.tuningSeed = val.tuningSeed
          foliageSec.settings.cameraMode = val.cameraMode
          foliageSec.settings.compare = val.compare
          foliageSec.settings.lightingPreset = val.lightingPreset
          Object.assign(foliageSettings, val.params)
          foliageSec.enter?.()
          foliageSec.retrigger?.()
          panel.sync()
          syncChrome()
          void renderNow()
          return { action: "imported", preset: val }
        }

        if (typeof args?.preset === "string" && args.preset.trim()) {
          const p = args.preset.trim().toLowerCase()
          if (p === "reset") {
            resetFoliageParams(foliageSettings.treePreset, foliageSettings)
          } else if (isFoliagePresetId(p)) {
            resetFoliageParams(p, foliageSettings)
          } else {
            throw new Error(`Unknown foliage preset "${args.preset}". Valid: ${FOLIAGE_PRESET_IDS.join(", ")}, reset.`)
          }
        }
        if (typeof args?.lighting === "string" && args.lighting in FOLIAGE_LIGHTING_PRESETS) {
          foliageSec.settings.lightingPreset = args.lighting
          const lp = FOLIAGE_LIGHTING_PRESETS[args.lighting]
          if (lp && Object.keys(lp.values).length > 0) Object.assign(stage.lighting, lp.values)
        }
        if (args?.stageMode === "lot" || args?.stageMode === "swatch") {
          const stgCtrl = foliageSec.controls.find(c => c.key === "stageMode")
          if (stgCtrl) panel.navigation.set(stgCtrl, args.stageMode)
        }
        if (args?.cameraMode === "close" || args?.cameraMode === "game") {
          const camCtrl = foliageSec.controls.find(c => c.key === "cameraMode")
          if (camCtrl) panel.navigation.set(camCtrl, args.cameraMode)
        }
        if (args?.compare === 0 || args?.compare === 1 || args?.compare === 2) {
          foliageSec.settings.compare = args.compare
        }
        foliageSec.retrigger?.()
        panel.sync()
        syncChrome()
        void renderNow()

        const exported = exportFoliagePreset({
          seed: Number(foliageSec.settings.seed) || 7,
          tuningSeed: Number(foliageSec.settings.tuningSeed) || 41,
          stageMode: foliageSec.settings.stageMode === "swatch" ? "swatch" : "lot",
          cameraMode: (foliageSec.settings.cameraMode === "game" ? "game" : "close") as FoliageCameraMode,
          compare: (Number(foliageSec.settings.compare) === 0 ? 0 : Number(foliageSec.settings.compare) === 2 ? 2 : 1) as FoliageCompareMode,
          lightingPreset: String(foliageSec.settings.lightingPreset || "outbreak_dusk"),
          params: foliageSettings,
        })
        return {
          preset: foliageSettings.treePreset,
          exported,
          json: JSON.stringify(exported, null, 2),
        }
      },
    },
    {
      id: "foliage.textures",
      label: "Bind Foliage & Grass Texture Maps",
      shortLabel: "Foliage Textures",
      category: "Preset",
      undoable: false,
      args: {
        grassAlbedo: { type: "string", description: "URL/path for grass & soil albedo texture" },
        grassNormal: { type: "string", description: "URL/path for grass & soil detail normal map" },
        barkAlbedo: { type: "string", description: "URL/path for bark albedo/normal texture" },
        leafAtlas: { type: "string", description: "URL/path for brushy leaf-cluster RGBA atlas" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        setFoliageTextureUrls({
          grassAlbedo: typeof args?.grassAlbedo === "string" ? args.grassAlbedo : undefined,
          grassNormal: typeof args?.grassNormal === "string" ? args.grassNormal : undefined,
          barkAlbedo: typeof args?.barkAlbedo === "string" ? args.barkAlbedo : undefined,
          leafAtlas: typeof args?.leafAtlas === "string" ? args.leafAtlas : undefined,
        })
        void renderNow()
        return { textures: { ...foliageTextureUrls } }
      },
    },
    {
      id: "look.preset",
      label: "Apply Rendering Look Preset",
      shortLabel: "Look Preset",
      category: "Preset",
      undoable: true,
      args: {
        preset: {
          type: "string",
          required: true,
          description: "Preset ID or name (current, noir, painterly, cinematic_dusk, sodium_70s, cozy_golden_hour)",
        },
      },
      enabled: () => Boolean(looks) && mode !== "play",
      disabledReason: () => (mode === "play" ? "Unavailable in Play mode. Run 'arcade release' first." : "Looks section unavailable."),
      run: (_ctx, args) => {
        if (!looks) throw new Error("Looks controller is not available.")
        const raw = String(args?.preset ?? "").trim()
        const pid = resolveLookPresetId(raw)
        if (!pid) {
          throw new Error(`Unknown look preset "${raw}". Valid presets: ${LOOK_PRESET_IDS.join(", ")}.`)
        }
        if (globalSettings.section !== "looks") selectSection("looks")
        const settings = looks.applyPreset(pid)
        activeCatalogId = `look-preset:${pid}`
        panel.sync()
        syncChrome()
        void renderNow()
        return {
          preset: pid,
          label: LOOK_PRESETS[pid].label,
          settings,
        }
      },
    },
    {
      id: "look.set",
      label: "Set Rendering Look Parameter",
      shortLabel: "Look Set",
      category: "Inspector",
      undoable: true,
      args: {
        key: { type: "string", required: true, description: "Look parameter key (e.g. exposure, contrast, shaftStrength, fogDensity)" },
        value: { type: "value", required: true, description: "Parameter value" },
      },
      enabled: () => Boolean(looks) && mode !== "play",
      disabledReason: () => (mode === "play" ? "Unavailable in Play mode. Run 'arcade release' first." : "Looks section unavailable."),
      run: (_ctx, args) => {
        if (!looks) throw new Error("Looks controller is not available.")
        const key = String(args?.key ?? "").trim()
        const val = args?.value
        if (!key || val === undefined) throw new Error("look.set requires key and value.")
        if (globalSettings.section !== "looks") selectSection("looks")
        const found = findControlRow([panel], key)
        if (found && found.control.type !== "action") {
          const before = panel.navigation.settings[found.control.key]
          const next = coerceControlValue(found.control, val)
          panel.navigation.set(found.control, next)
          panel.sync()
          syncChrome()
          void renderNow()
          return {
            key: found.control.key,
            label: found.control.label,
            group: found.row.group,
            before,
            value: panel.navigation.settings[found.control.key],
            preset: looks.getLookSettings().preset,
          }
        }
        const res = looks.setParam(key, val as string | number | boolean)
        panel.sync()
        syncChrome()
        void renderNow()
        return {
          ...res,
          preset: looks.getLookSettings().preset,
        }
      },
    },
    {
      id: "look.randomize",
      label: "Randomize Rendering Look Parameters",
      shortLabel: "Look Randomize",
      category: "Preset",
      undoable: true,
      args: {
        group: {
          type: "string",
          required: false,
          description: "Group to randomize (all, tone, split_tone, lighting, atmosphere, lens, painterly)",
        },
        seed: {
          type: "number",
          required: false,
          min: 1,
          max: 9999,
          description: "Deterministic tuning seed (leaves roomSeed unchanged)",
        },
      },
      enabled: () => Boolean(looks) && mode !== "play",
      disabledReason: () => (mode === "play" ? "Unavailable in Play mode. Run 'arcade release' first." : "Looks section unavailable."),
      run: (ctx, args) => {
        if (!looks) throw new Error("Looks controller is not available.")
        if (globalSettings.section !== "looks") selectSection("looks")
        const rawGroup = typeof args?.group === "string" ? args.group : "all"
        const explicitSeed = typeof args?.seed === "number" ? args.seed : ctx?.seed
        const out = looks.randomizeGroup(rawGroup as LookGroup | "all", explicitSeed)
        panel.sync()
        syncChrome()
        void renderNow()
        return out
      },
    },
  ])

  function buildSceneState(): Omit<LabSceneState, "commands"> {
    const sec = activeSection()
    const envOwner = resolveEnvOwner()
    const cleanSettings: Record<string, LabValue> = {
      twoFingerScroll: getTwoFingerScrollMode(),
    }
    for (const k of Object.keys(sec.settings)) {
      const v = sec.settings[k]
      if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
        cleanSettings[k] = v
      }
    }
    return {
      mode,
      section: sec.id,
      environment: String(envOwner.settings.environment ?? envOwner.settings.room ?? "default"),
      seed: Number(envOwner.settings.seed ?? envOwner.settings.roomSeed ?? 7),
      effectSeed: "effectSeed" in sec.settings ? Number(sec.settings.effectSeed) : undefined,
      transport: {
        playing: "playing" in sec.settings ? Boolean(sec.settings.playing) : true,
        loop: "loop" in sec.settings ? Boolean(sec.settings.loop) : false,
        speed: simSpeed,
        elapsed: Number(elapsed.toFixed(3)),
        frames,
      },
      camera: {
        focus: [Number(stage.focus[0]!.toFixed(3)), Number(stage.focus[1]!.toFixed(3)), Number(stage.focus[2]!.toFixed(3))],
        yaw: Number(stage.camYaw.toFixed(4)),
        pitch: Number(stage.camPitch.toFixed(4)),
        distance: Number(stage.camDist.toFixed(3)),
      },
      selection: {
        selectedIds: currentSelectedIds(),
        hoveredId: hoveredObjectId,
        boxSelectMode,
      },
      objects: allSceneObjects(),
      settings: cleanSettings,
      lighting: { ...stage.lighting },
      compare: {
        activeSlot,
        hasSlotA: Boolean(slotA),
        wipeEnabled: compareWipeEnabled,
        frames,
        diffs: slotA ? computeSnapshotDiffs(slotA.snapshot, slotB?.snapshot ?? captureSnapshot()) : [],
      },
      grid: variationGrid
        ? {
            active: true,
            id: variationGrid.id,
            title: variationGrid.title,
            section: variationGrid.section,
            cols: variationGrid.cols,
            rows: variationGrid.rows,
            focusedTile: focusedGridTile,
            hoveredTile: hoveredGridTile,
            frameCostMs: variationGridCostMs !== null ? Number(variationGridCostMs.toFixed(2)) : null,
            tiles: variationGrid.tiles.map((t, i) => ({
              tile: i + 1,
              label: t.label,
              subtitle: summarizeTileSettings(t),
            })),
          }
        : null,
      layout: chromeReady
        ? {
            library: { open: libraryDrawer.open, category: libraryDrawer.category, query: libraryDrawer.query },
            locked: [...lockedIds],
            details: { query: detailsQuery, modifiedOnly: detailsModifiedOnly, showAll: detailsShowAll, modified: panel.modifiedControls().map(c => c.key) },
            watch: watchPins.map(p => ({ section: p.sectionId, key: p.key, label: p.label, value: readWatchPin(p)?.text ?? null })),
          }
        : undefined,
      history: {
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        undoLabel: undoStack.at(-1)?.label ?? null,
        redoLabel: redoStack.at(-1)?.label ?? null,
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
      },
    }
  }

  let devControlHandle: { notifyUpdate: () => void; dispose: () => void } | undefined

  commands.configure({
    getState: buildSceneState,
    transact: (label, fn) => {
      const before = captureSnapshot()
      fn()
      recordHistory(label, before)
    },
  })

  registerStageCameraCommands(commands, {
    stage,
    render: () => renderNow(),
    canEdit: () => mode !== "play",
    disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
    resolveFrameTarget: query => {
      if (!query || query === "scene" || query === "active") {
        const ft = activeSection().frameTarget?.()
        return ft ? { x: ft.x, y: ft.y, z: ft.z, dist: ft.dist ?? 15 } : { x: 0, y: 0.5, z: 0, dist: 16 }
      }
      const q = query.trim().toLowerCase()
      const objs = allSceneObjects()
      const obj =
        objs.find(o => o.id === query || o.id.toLowerCase() === q) ??
        objs.find(o => o.label.toLowerCase() === q) ??
        objs.find(o => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)) ??
        null
      if (!obj) return null
      selectWorldObject(obj)
      return { x: obj.x, y: obj.y, z: obj.z, dist: 14, label: obj.label }
    },
  })

  commands.register({
    id: "lab.get",
    label: "Get Lab Parameter Value(s)",
    shortLabel: "Lab Get",
    category: "Inspector",
    undoable: false,
    args: {
      path: { type: "string", description: "Control key, group.key, or label (omit for all controls)" },
    },
    enabled: () => true,
    run: (_ctx, args) => {
      const rawPath = typeof args?.path === "string" ? args.path.trim() : ""
      if (!rawPath || rawPath === "all" || rawPath === "*") {
        const st = buildSceneState()
        return { settings: st.settings, lighting: st.lighting }
      }
      if (rawPath === "twoFingerScroll") {
        const val = getTwoFingerScrollMode()
        return { key: "twoFingerScroll", label: "Trackpad two-finger scroll", group: "Viewport", value: val, formatted: val }
      }
      const found = findControlRow([panel], rawPath)
      if (found) {
        const { control: c, row } = found
        if (c.type === "action") return { key: c.key, label: c.label, group: row.group, type: "action" }
        const val = panel.navigation.settings[c.key]!
        return {
          key: c.key,
          label: c.label,
          group: row.group,
          value: val,
          formatted: formatControlValue(c, val),
        }
      }
      const sec = activeSection()
      if (rawPath in sec.settings) {
        return { key: rawPath, label: rawPath, group: sec.label, value: sec.settings[rawPath] }
      }
      if (rawPath in stage.lighting) {
        return { key: rawPath, label: rawPath, group: "Lighting", value: (stage.lighting as Record<string, LabValue>)[rawPath] }
      }
      throw new Error(`Unknown lab setting "${rawPath}".`)
    },
  })

  const resolveSettingSection = (key: string, section?: string): string => {
    if (section) {
      const q = section.toLowerCase()
      const sec = sections.find(s => s.id.toLowerCase() === q || s.label.toLowerCase() === q)
      if (!sec) throw new Error(`Unknown section "${section}". Available: ${sections.map(s => s.id).join(", ")}.`)
      return sec.id
    }
    const active = activeSection()
    if (active.controls.some(c => c.key === key && c.type !== "action")) return active.id
    const owner = sections.find(s => s.controls.some(c => c.key === key && c.type !== "action"))
    if (!owner) throw new Error(`Unknown setting "${key}".`)
    return owner.id
  }

  commands.registerAll([
    {
      id: "outliner.select",
      label: "Select in Outliner",
      shortLabel: "Select",
      category: "Object",
      args: {
        id: { type: "string", description: "Object id or label (prop:0, character:active, Cone)" },
        ids: { type: "string", description: "Comma-separated object ids to select together" },
        kind: { type: "string", description: "Select every object of a kind (for example cone)" },
        additive: { type: "boolean", description: "Add to the current selection" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const objs = allSceneObjects()
        const want: string[] = []
        const resolve = (raw: string) => {
          const q = raw.trim().toLowerCase()
          const o =
            objs.find(x => x.id.toLowerCase() === q) ??
            objs.find(x => x.label.toLowerCase() === q) ??
            objs.find(x => x.label.toLowerCase().includes(q) || x.id.toLowerCase().includes(q))
          if (!o) throw new Error(`No scene object matches "${raw}". In scene: ${objs.map(x => x.id).join(", ") || "nothing"}.`)
          return o.id
        }
        if (typeof args?.id === "string" && args.id.trim()) want.push(resolve(args.id))
        if (typeof args?.ids === "string") for (const part of args.ids.split(",")) if (part.trim()) want.push(resolve(part))
        if (typeof args?.kind === "string" && args.kind.trim()) {
          const k = args.kind.trim().toLowerCase()
          const matches = objs.filter(o => (o.kind ?? "").toLowerCase() === k || o.label.toLowerCase().startsWith(k))
          if (!matches.length) throw new Error(`No objects of kind "${args.kind}" in the scene.`)
          want.push(...matches.map(o => o.id))
        }
        const next = args?.additive ? [...new Set([...currentSelectedIds(), ...want])] : want
        selectingFromOutliner = true
        try {
          setSelectionIds(next)
        } finally {
          selectingFromOutliner = false
        }
        const primary = currentSelectedIds().at(-1)
        if (primary) outliner.reveal(primary)
        return { selected: currentSelectedIds() }
      },
    },
    {
      id: "outliner.lock",
      label: "Lock / Unlock Object Picking",
      shortLabel: "Lock",
      category: "Object",
      args: {
        id: { type: "string", required: true, description: "Object id" },
        locked: { type: "boolean", description: "Explicit lock state (omit to toggle)" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        const id = String(args?.id ?? "")
        if (!allSceneObjects().some(o => o.id === id)) throw new Error(`Unknown scene object "${id}".`)
        const want = typeof args?.locked === "boolean" ? args.locked : !lockedIds.has(id)
        if (want) lockedIds.add(id)
        else lockedIds.delete(id)
        syncChrome()
        return { id, locked: want, lockedIds: [...lockedIds] }
      },
    },
    {
      id: "outliner.collapse",
      label: "Collapse / Expand Outliner Group",
      shortLabel: "Collapse",
      category: "Navigation",
      args: {
        group: { type: "string", required: true, enum: OUTLINER_GROUPS.map(g => g.id) },
        collapsed: { type: "boolean", description: "Explicit state (omit to toggle)" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        const group = String(args?.group)
        const want = typeof args?.collapsed === "boolean" ? args.collapsed : !outliner.collapsedGroups.includes(group)
        outliner.setGroupCollapsed(group, want)
        return { group, collapsed: want }
      },
    },
    {
      id: "outliner.focus",
      label: "Focus Outliner",
      shortLabel: "Outliner",
      category: "Navigation",
      shortcut: "⇧Tab",
      enabled: () => true,
      run: () => {
        if (mode === "play") setPlayMode("edit")
        outliner.focus()
      },
    },
    {
      id: "library.toggle",
      label: "Toggle Library Drawer",
      shortLabel: "Library",
      category: "Navigation",
      shortcut: "Ctrl Space",
      args: {
        open: { type: "boolean", description: "Explicit open state (omit to toggle)" },
        category: { type: "string", enum: LIBRARY_CATEGORIES.map(c => c.id), description: "Category to show" },
        query: { type: "string", description: "Search text" },
      },
      enabled: () => true,
      run: (ctx, args) => {
        const open = typeof args?.open === "boolean" ? args.open : args?.category || args?.query ? true : !libraryDrawer.open
        if (typeof args?.category === "string") libraryDrawer.setCategory(args.category as LabLibraryCategory)
        libraryDrawer.setOpen(open)
        if (typeof args?.query === "string") libraryDrawer.setQuery(args.query)
        if (open && ctx?.source !== "cli" && !args?.category) libraryDrawer.focusSearch()
        else if (!open && focusZone === "library") canvas.focus({ preventScroll: true })
        return { open: libraryDrawer.open, category: libraryDrawer.category, visible: libraryDrawer.visibleIds }
      },
    },
    {
      id: "library.place",
      label: "Place Library Item",
      shortLabel: "Place",
      category: "Scene",
      undoable: false,
      args: {
        id: { type: "string", required: true, description: "Catalog id or label (spawn-prop:hydrant, effects:smoke, Hydrant)" },
        at: { type: "string", description: "Ground point 'x,z' (omit to arm a placement ghost or just select the item)" },
        yaw: { type: "number", description: "Yaw in degrees" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const raw = String(args?.id ?? "").trim()
        const q = raw.toLowerCase()
        const catalog = buildCatalog().filter(isLibraryAsset)
        const entry =
          catalog.find(e => e.id.toLowerCase() === q) ??
          catalog.find(e => e.label.toLowerCase() === q || e.label.toLowerCase() === `place ${q}`) ??
          catalog.find(e => e.id.toLowerCase().endsWith(`:${q}`)) ??
          catalog.find(e => e.label.toLowerCase().includes(q))
        if (!entry) throw new Error(`Unknown Library item "${raw}".`)
        let at: { x: number; y: number; z: number } | null = null
        if (typeof args?.at === "string" && args.at.trim()) {
          const parts = args.at.split(",").map(p => Number(p.trim()))
          if (parts.length !== 2 || !parts.every(Number.isFinite)) throw new Error(`Invalid point "${args.at}". Expected "x,z".`)
          const groundFn = isPlaceable(entry.id) && spawn ? spawn.section.groundHeight ?? yardGround : groundFnFor(activeSection())
          at = { x: parts[0]!, y: groundFn(parts[0]!, parts[1]!), z: parts[1]! }
        }
        return placeLibraryEntry(entry, at, typeof args?.yaw === "number" ? args.yaw : 0)
      },
    },
    {
      id: "palette.open",
      label: "Search Everything",
      shortLabel: "Search",
      category: "Navigation",
      shortcut: "⌘K",
      args: { query: { type: "string", description: "Initial query (@ scene, # settings, + library, > commands)" } },
      enabled: () => true,
      run: (_ctx, args) => {
        if (mode === "play") setPlayMode("edit")
        palette.open(typeof args?.query === "string" ? args.query : "")
        return { open: palette.isOpen, results: palette.results.map(r => ({ kind: r.kind, label: r.label, meta: r.meta })) }
      },
    },
    {
      id: "watch.pin",
      label: "Pin Setting to Watch",
      shortLabel: "Pin",
      category: "Inspector",
      args: {
        key: { type: "string", required: true, description: "Setting key (skidWidth, radius, exposure)" },
        section: { type: "string", description: "Section id (defaults to the active section, then any section with the key)" },
        pinned: { type: "boolean", description: "Explicit pin state (omit to toggle)" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        const key = String(args?.key ?? "").trim()
        const sectionId = resolveSettingSection(key, typeof args?.section === "string" ? args.section : undefined)
        const pinned = pinSetting(sectionId, key, typeof args?.pinned === "boolean" ? args.pinned : undefined)
        return { section: sectionId, key, pinned, watch: watchPins.map(p => watchPinId(p)) }
      },
    },
    {
      id: "watch.unpin",
      label: "Unpin Setting from Watch",
      shortLabel: "Unpin",
      category: "Inspector",
      args: {
        key: { type: "string", description: "Setting key (omit with all=true to clear)" },
        section: { type: "string", description: "Section id" },
        all: { type: "boolean", description: "Clear every pin" },
      },
      enabled: () => watchPins.length > 0,
      disabledReason: () => "Watch list is empty",
      run: (_ctx, args) => {
        if (args?.all) {
          setWatchPins([])
          return { watch: [] }
        }
        const key = String(args?.key ?? "").trim()
        const pin = watchPins.find(p => p.key === key && (typeof args?.section !== "string" || p.sectionId === args.section))
        if (!pin) throw new Error(`"${key}" is not pinned.`)
        setWatchPins(watchPins.filter(p => p !== pin))
        return { watch: watchPins.map(p => watchPinId(p)) }
      },
    },
    {
      id: "details.filter",
      label: "Filter Details",
      shortLabel: "Filter",
      category: "Inspector",
      args: {
        modified: { type: "boolean", description: "Show only modified settings" },
        query: { type: "string", description: "Search text" },
        all: { type: "boolean", description: "Show section settings unrelated to the selection" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        if (typeof args?.modified === "boolean") detailsModifiedOnly = args.modified
        else if (args?.query === undefined && args?.all === undefined) detailsModifiedOnly = !detailsModifiedOnly
        if (typeof args?.query === "string") {
          detailsQuery = args.query
          detailsSearch.value = args.query
        }
        if (typeof args?.all === "boolean") detailsShowAll = args.all
        applyDetailsView()
        syncDetails()
        return {
          modifiedOnly: detailsModifiedOnly,
          query: detailsQuery,
          showAll: detailsShowAll,
          visible: panel.navigation.visibleRows.filter(r => r.control).map(r => r.control!.key),
        }
      },
    },
    {
      id: "details.reveal",
      label: "Jump to Setting",
      shortLabel: "Jump",
      category: "Inspector",
      args: {
        key: { type: "string", required: true, description: "Setting key" },
        section: { type: "string", description: "Section id (switches section when needed)" },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const key = String(args?.key ?? "").trim()
        const sectionId = resolveSettingSection(key, typeof args?.section === "string" ? args.section : undefined)
        const ok = revealSetting(sectionId, key)
        if (!ok) throw new Error(`Setting "${key}" is not available in the current state.`)
        return { section: sectionId, key }
      },
    },
  ])

  for (const s of sections) {
    s.registerCommands?.(commands)
  }
  devControlHandle = registerDevControl({
    kind: "lab",
    commands,
    getCanvas: () => canvas,
    captureCanvas: async target => {
      await renderNow()
      await stage.captureToCanvas(target)
      drawVariationGridOverlayToCanvas(target)
    },
    getMode: () => mode,
    getSection: () => globalSettings.section,
    onIndicator: (text, isError) => {
      showToast(text, Boolean(isError))
    },
    resolveTargetRect: target => {
      const cRect = canvas.getBoundingClientRect()
      if (target.world && cRect.width > 0 && cRect.height > 0) {
        const [wx, wy, wz] = target.world
        const proj = stage.projectWorld(wx, wy, wz)
        if (proj.visible && proj.u >= 0.01 && proj.u <= 0.99 && proj.v >= 0.01 && proj.v <= 0.99) {
          const size = 76
          return {
            x: cRect.left + proj.u * cRect.width - size * 0.5,
            y: cRect.top + proj.v * cRect.height - size * 0.5,
            width: size,
            height: size,
            shape: "pill",
          }
        }
      }
      if (target.objectId) {
        const q = target.objectId.trim().toLowerCase()
        const objs = allSceneObjects()
        const obj =
          objs.find(o => o.id.toLowerCase() === q) ??
          objs.find(o => o.label.toLowerCase() === q) ??
          objs.find(o => (q === "car" || q === "character" || q === "player") && o.category === "character") ??
          objs.find(o => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)) ??
          null
        if (obj && cRect.width > 0 && cRect.height > 0) {
          const proj = stage.projectWorld(obj.x, obj.y + 0.45, obj.z)
          if (proj.visible && proj.u >= 0.02 && proj.u <= 0.98 && proj.v >= 0.02 && proj.v <= 0.98) {
            const size = Math.max(64, Math.min(116, ((obj.radius ?? 0.9) * 920) / Math.max(6, stage.camDist)))
            return {
              x: cRect.left + proj.u * cRect.width - size * 0.5,
              y: cRect.top + proj.v * cRect.height - size * 0.5,
              width: size,
              height: size,
              shape: "pill",
              label: obj.label,
            }
          }
        }
      }
      return null
    },
    isBusy: () => {
      if (viewportGestures?.isDragging()) return { busy: true, reason: "User is dragging the viewport camera" }
      if (activeTransform) return { busy: true, reason: `User is transforming ${activeTransform.primaryId}` }
      if (panel.isInteracting()) return { busy: true, reason: "User is scrubbing or editing in the Inspector" }
      if (!modalBackdrop.hidden) return { busy: true, reason: "Preset dialog is open" }
      return { busy: false }
    },
    getState: () => commands.state()!,
  })

  function buildCatalog(): CatalogEntry[] {
    const entries: CatalogEntry[] = []

    // 1. Curated Starting Fixtures
    entries.push(
      {
        id: "fixture:smoke-room",
        label: "Grenade smoke in room",
        group: "Starting Fixtures",
        category: "effects",
        collection: "fixtures",
        tag: "Fixture",
        sectionId: "effects",
        isActive: () => activeCatalogId === "fixture:smoke-room",
        run: () => {
          activeCatalogId = "fixture:smoke-room"
          selectSection("effects")
          const sec = activeSection()
          sec.settings.effect = "smoke"
          sec.settings.targetX = -1
          sec.settings.targetZ = 0
          sec.retrigger?.()
          stage.frameTarget(-1, 0.5, 0, 15)
        },
      },
      {
        id: "fixture:glass-pane",
        label: "Glass impact at pane",
        group: "Starting Fixtures",
        category: "effects",
        collection: "fixtures",
        tag: "Fixture",
        sectionId: "blackout-effects",
        isActive: () => activeCatalogId === "fixture:glass-pane",
        run: () => {
          activeCatalogId = "fixture:glass-pane"
          selectSection("blackout-effects")
          const sec = activeSection()
          sec.settings.environment = "meeting"
          sec.settings.effect = "shot"
          sec.settings.surface = "glass"
          sec.enter?.()
          sec.retrigger?.()
          stage.frameTarget(8.5, 0.9, 9.05, 13)
        },
      },
      {
        id: "fixture:paper-desk",
        label: "Paper burst from desk",
        group: "Starting Fixtures",
        category: "effects",
        collection: "fixtures",
        tag: "Fixture",
        sectionId: "blackout-effects",
        isActive: () => activeCatalogId === "fixture:paper-desk",
        run: () => {
          activeCatalogId = "fixture:paper-desk"
          selectSection("blackout-effects")
          const sec = activeSection()
          sec.settings.environment = "office"
          sec.settings.effect = "paper"
          sec.settings.targetX = 12
          sec.settings.targetZ = 8.9
          sec.enter?.()
          sec.retrigger?.()
          stage.frameTarget(12, 0.6, 8.9, 13)
        },
      },
      {
        id: "fixture:car-cones",
        label: "Car into cones",
        group: "Starting Fixtures",
        category: "effects",
        collection: "fixtures",
        tag: "Fixture",
        sectionId: "spawn",
        isActive: () => activeCatalogId === "fixture:car-cones",
        run: () => {
          activeCatalogId = "fixture:car-cones"
          selectSection("spawn")
          if (spawn) {
            spawn.clear()
            spawn.section.settings.character = "getaway:muscle"
            spawn.spawnCharacterAt("getaway:muscle", { x: 0, y: 0, z: 8, yaw: Math.PI })
            spawn.section.settings.item = "cone"
            spawn.section.settings.count = 5
            spawn.section.settings.spacing = 2
            spawn.spawnItems("row", { x: 0, y: 0, z: 2, yaw: Math.PI })
            spawn.section.settings.item = "propane"
            spawn.spawnItems("one", { x: 0, y: 0, z: -10, yaw: Math.PI })
            spawn.section.selectObject?.("character:active")
            stage.frameTarget(0, 0.4, 2, 18)
          }
        },
      },
      {
        id: "fixture:flame-hydrant",
        label: "Flame & hydrant",
        group: "Starting Fixtures",
        category: "effects",
        collection: "fixtures",
        tag: "Fixture",
        sectionId: "fire-water",
        isActive: () => activeCatalogId === "fixture:flame-hydrant",
        run: () => {
          activeCatalogId = "fixture:flame-hydrant"
          selectSection("fire-water")
          const sec = activeSection()
          sec.settings.environment = "alley"
          sec.settings.effect = "water"
          sec.settings.style = 1
          sec.enter?.()
          sec.retrigger?.()
          stage.frameTarget(0, 0.8, 0, 13)
        },
      },
      {
        id: "fixture:audio-audition",
        label: "Audio audition",
        group: "Starting Fixtures",
        category: "effects",
        collection: "fixtures",
        tag: "Fixture",
        sectionId: "audio",
        isActive: () => activeCatalogId === "fixture:audio-audition",
        run: fromUser => {
          activeCatalogId = "fixture:audio-audition"
          selectSection("audio")
          const sec = activeSection()
          sec.settings.source = "impact_crash_layered"
          sec.settings.replay = "manual"
          if (fromUser && !isBench) sec.retrigger?.()
        },
      },
    )

    const outbreakVignetteSec = sections.find(s => s.id === "outbreak-vignette")
    if (outbreakVignetteSec) {
      entries.push({
        id: "fixture:outbreak-vignette",
        label: "Outbreak lot vignette",
        group: "Starting Fixtures",
        category: "effects",
        collection: "fixtures",
        tag: "Vignette",
        sectionId: "outbreak-vignette",
        isActive: () => globalSettings.section === "outbreak-vignette",
        run: () => {
          activeCatalogId = "fixture:outbreak-vignette"
          selectSection("outbreak-vignette")
          frameActiveTarget()
        },
      })
      const dirCtrl = outbreakVignetteSec.controls.find(c => c.key === "directionPreset" && "options" in c)
      if (dirCtrl && "options" in dirCtrl) {
        for (const opt of dirCtrl.options) {
          const id = `outbreak-vignette:dir-${opt.value}`
          entries.push({
            id,
            label: opt.label,
            group: "Outbreak Art Directions",
            category: "lighting",
            collection: "shared",
            tag: "Outbreak",
            sectionId: "outbreak-vignette",
            isActive: () => globalSettings.section === "outbreak-vignette" && outbreakVignetteSec.settings.directionPreset === opt.value,
            run: () => {
              activeCatalogId = id
              if (globalSettings.section !== "outbreak-vignette") selectSection("outbreak-vignette")
              panel.navigation.set(dirCtrl, opt.value)
            },
          })
        }
      }
    }

    // 2. Shared FX presets
    for (const opt of effectOptions) {
      const id = `effects:${opt.value}`
      entries.push({
        id,
        label: opt.label,
        group: "Shared FX",
        category: "effects",
        collection: "shared",
        tag: "Shared",
        sectionId: "effects",
        isActive: () => globalSettings.section === "effects" && activeSection().settings.effect === opt.value,
        run: () => {
          activeCatalogId = id
          if (globalSettings.section !== "effects") selectSection("effects")
          const sec = activeSection()
          sec.settings.effect = opt.value
          sec.retrigger?.()
          frameActiveTarget()
        },
      })
    }

    // 3. Blackout effects
    const blackoutSec = sections.find(s => s.id === "blackout-effects")
    const blackoutEffectControl = blackoutSec?.controls.find(c => c.key === "effect" && "options" in c)
    if (blackoutSec && blackoutEffectControl && "options" in blackoutEffectControl) {
      for (const opt of blackoutEffectControl.options) {
        if (opt.value === "explosion" || opt.value === "scorch") continue
        const id = `blackout-effects:${opt.value}`
        entries.push({
          id,
          label: opt.label,
          group: "Blackout Effects",
          category: "effects",
          collection: "blackout",
          tag: "Blackout",
          sectionId: "blackout-effects",
          isActive: () => globalSettings.section === "blackout-effects" && blackoutSec.settings.effect === opt.value,
          run: fromUser => {
            activeCatalogId = id
            if (globalSettings.section !== "blackout-effects") selectSection("blackout-effects")
            blackoutSec.settings.effect = opt.value
            if (opt.value === "glass") {
              blackoutSec.settings.targetX = 8.5
              blackoutSec.settings.targetZ = 9
            } else if (opt.value === "paper" || opt.value === "monitor") {
              blackoutSec.settings.targetX = 12
              blackoutSec.settings.targetZ = 8.9
            }
            if (fromUser && !isBench) blackoutSec.retrigger?.()
            frameActiveTarget()
          },
        })
      }
    }

    // 4. Getaway effects
    const getawaySec = sections.find(s => s.id === "getaway-effects")
    const getawayEffectControl = getawaySec?.controls.find(c => c.key === "effect" && "options" in c)
    if (getawaySec && getawayEffectControl && "options" in getawayEffectControl) {
      for (const opt of getawayEffectControl.options) {
        if (opt.value === "explosion") continue
        const id = `getaway-effects:${opt.value}`
        entries.push({
          id,
          label: opt.label,
          group: "Getaway Effects",
          category: "effects",
          collection: "getaway",
          tag: "Getaway",
          sectionId: "getaway-effects",
          isActive: () => globalSettings.section === "getaway-effects" && getawaySec.settings.effect === opt.value,
          run: fromUser => {
            activeCatalogId = id
            if (globalSettings.section !== "getaway-effects") selectSection("getaway-effects")
            getawaySec.settings.effect = opt.value
            if (fromUser && !isBench) getawaySec.retrigger?.()
            frameActiveTarget()
          },
        })
      }
    }

    // 5. Fire & Water
    const fwSec = sections.find(s => s.id === "fire-water")
    const fwEffectControl = fwSec?.controls.find(c => c.key === "effect" && "options" in c)
    if (fwSec && fwEffectControl && "options" in fwEffectControl) {
      for (const opt of fwEffectControl.options) {
        if (opt.value === "explosion" || opt.value === "fireball") continue
        const id = `fire-water:${opt.value}`
        entries.push({
          id,
          label: `${opt.label} (Study)`,
          group: "Fire & Water",
          category: "effects",
          collection: "shared",
          tag: "Shader",
          sectionId: "fire-water",
          isActive: () => globalSettings.section === "fire-water" && fwSec.settings.effect === opt.value,
          run: () => {
            activeCatalogId = id
            if (globalSettings.section !== "fire-water") selectSection("fire-water")
            fwSec.settings.effect = opt.value
            fwSec.retrigger?.()
            frameActiveTarget()
          },
        })
      }
    }

    // 6. Surface Splatter
    const splatSec = sections.find(s => s.id === "splatter")
    const splatPresetControl = splatSec?.controls.find(c => c.key === "preset" && "options" in c)
    if (splatSec && splatPresetControl && "options" in splatPresetControl) {
      for (const opt of splatPresetControl.options) {
        const id = `splatter:${opt.value}`
        entries.push({
          id,
          label: `${opt.label} splatter`,
          group: "Surface Splatter",
          category: "effects",
          collection: "blackout",
          tag: "Decal",
          sectionId: "splatter",
          isActive: () => globalSettings.section === "splatter" && splatSec.settings.preset === opt.value,
          run: () => {
            activeCatalogId = id
            if (globalSettings.section !== "splatter") selectSection("splatter")
            const c = splatSec.controls.find(ctrl => ctrl.key === "preset")
            if (c) panel.navigation.set(c, opt.value)
            frameActiveTarget()
          },
        })
      }
    }

    // 7. Objects Category: In-Scene Objects + Spawn Catalog + Calibration
    const currentObjects = [...(activeSection().objects?.() ?? [])]
    if (spawn && globalSettings.section !== "spawn" && ["effects", "lighting", "physics"].includes(globalSettings.section)) {
      for (const spObj of spawn.section.objects?.() ?? []) {
        if (!currentObjects.some(o => o.id === spObj.id)) currentObjects.push(spObj)
      }
    }
    for (const obj of currentObjects) {
      const id = `scene-obj:${obj.id}`
      const isSpawnObj = Boolean(spawn?.section.objects?.()?.some(o => o.id === obj.id))
      entries.push({
        id,
        label: obj.label,
        group: "In Current Scene",
        category: "objects",
        collection: "shared",
        tag: obj.category,
        sectionId: isSpawnObj ? "spawn" : globalSettings.section,
        isActive: () => (isSpawnObj ? spawn?.section.selectedObjectId === obj.id && globalSettings.section === "spawn" : activeSection().selectedObjectId === obj.id),
        run: () => {
          if (isSpawnObj && globalSettings.section !== "spawn") {
            selectSection("spawn")
          }
          const sec = activeSection()
          sec.selectObject?.(obj.id)
          if (sec.id === "blackout-effects" && obj.id.startsWith("specimen:")) {
            sec.retrigger?.()
          }
          stage.frameTarget(obj.x, obj.y, obj.z, 14)
        },
      })
    }

    if (spawn) {
      for (const ch of spawn.adapters.characters) {
        const id = `spawn-char:${ch.id}`
        const isBlackout = ch.id.startsWith("blackout:")
        entries.push({
          id,
          label: ch.label,
          group: "Characters (Spawn)",
          category: "objects",
          collection: isBlackout ? "blackout" : "getaway",
          tag: "Character",
          sectionId: "spawn",
          isActive: () => globalSettings.section === "spawn" && spawn.section.settings.character === ch.id && spawn.hasCharacter(),
          run: () => {
            const before = captureSnapshot()
            if (globalSettings.section !== "spawn") selectSection("spawn")
            spawn.section.settings.character = ch.id
            spawn.spawnCharacterAt(ch.id)
            recordHistory(`Spawn ${ch.label}`, before)
            frameActiveTarget()
          },
        })
      }
      for (const item of spawn.adapters.items.items) {
        const id = `spawn-prop:${item.id}`
        entries.push({
          id,
          label: `Place ${item.label}`,
          group: "Street Props (Click to Place)",
          category: "objects",
          collection: "getaway",
          tag: "Prop",
          sectionId: "spawn",
          isActive: () => spawn.getGhost()?.category === "prop" && spawn.getGhost()?.kind === item.id,
          run: () => {
            if (globalSettings.section !== "spawn") selectSection("spawn")
            spawn.section.settings.item = item.id
            const cur = spawn.getGhost()
            spawn.setGhost({
              category: "prop",
              kind: item.id,
              x: cur?.x ?? 0,
              y: yardGround(cur?.x ?? 0, cur?.z ?? 2),
              z: cur?.z ?? 2,
              yaw: cur?.yaw ?? 0,
              shape: "one",
              valid: true,
            })
            showToast(`Placing ${item.label} · Click or Enter to place, [ ] to rotate, Esc to cancel`)
          },
        })
      }
      for (const kind of ["lamp", "spotlight", "torch"] as const) {
        const label = kind[0]!.toUpperCase() + kind.slice(1)
        const id = `spawn-light:${kind}`
        entries.push({
          id,
          label: `Place ${label}`,
          group: "Placed Lights",
          category: "objects",
          collection: "shared",
          tag: "Light",
          sectionId: "spawn",
          isActive: () => spawn.getGhost()?.category === "light" && spawn.getGhost()?.kind === kind,
          run: () => {
            if (globalSettings.section !== "spawn") selectSection("spawn")
            spawn.section.settings.light = kind
            spawn.setGhost({
              category: "light",
              kind,
              x: 0,
              y: yardGround(0, 2),
              z: 2,
              yaw: 0,
              shape: "one",
              valid: true,
            })
            showToast(`Placing ${label} · Click or Enter to place, Esc to cancel`)
          },
        })
      }
    }

    if (sections.some(s => s.id === "physics")) {
      entries.push({
        id: "section:physics",
        label: "Physics Colliders",
        group: "Calibration & Solvers",
        category: "objects",
        collection: "shared",
        tag: "Solver",
        sectionId: "physics",
        isActive: () => globalSettings.section === "physics",
        run: () => selectSection("physics"),
      })
    }
    const materialsSec = sections.find(s => s.id === "materials")
    if (materialsSec) {
      const recipeCtrl = materialsSec.controls.find(c => c.key === "recipe" && "options" in c)
      if (recipeCtrl && "options" in recipeCtrl) {
        for (const opt of recipeCtrl.options) {
          const id = `material-recipe:${opt.value}`
          entries.push({
            id,
            label: opt.label,
            group: "Material Recipes",
            category: "objects",
            collection: "shared",
            tag: "Material",
            sectionId: "materials",
            isActive: () => globalSettings.section === "materials" && materialsSec.settings.recipe === opt.value,
            run: () => {
              activeCatalogId = id
              if (globalSettings.section !== "materials") selectSection("materials")
              const c = materialsSec.controls.find(ctrl => ctrl.key === "recipe")
              if (c) panel.navigation.set(c, opt.value)
              frameActiveTarget()
            },
          })
        }
      }
      entries.push({
        id: "section:materials",
        label: "Material Swatch Stage",
        group: "Calibration & Solvers",
        category: "objects",
        collection: "shared",
        tag: "Swatch",
        sectionId: "materials",
        isActive: () => globalSettings.section === "materials",
        run: () => selectSection("materials"),
      })
    }

    const foliageSec = sections.find(s => s.id === "foliage")
    if (foliageSec) {
      for (const id of FOLIAGE_PRESET_IDS) {
        const def = FOLIAGE_PRESETS[id]
        const catId = `foliage-preset:${id}`
        entries.push({
          id: catId,
          label: def.label,
          group: "Foliage & Trees (Outbreak)",
          category: "objects",
          collection: "shared",
          tag: "Foliage",
          sectionId: "foliage",
          isActive: () => globalSettings.section === "foliage" && foliageSec.settings.treePreset === id,
          run: () => {
            activeCatalogId = catId
            if (globalSettings.section !== "foliage") selectSection("foliage")
            const c = foliageSec.controls.find(ctrl => ctrl.key === "treePreset")
            if (c) panel.navigation.set(c, id)
            frameActiveTarget()
          },
        })
      }
      entries.push({
        id: "section:foliage",
        label: "Foliage Workbench Stage",
        group: "Calibration & Solvers",
        category: "objects",
        collection: "shared",
        tag: "Foliage",
        sectionId: "foliage",
        isActive: () => globalSettings.section === "foliage",
        run: () => selectSection("foliage"),
      })
    }

    // 8. Lighting & Looks Categories
    const looksSec = sections.find(s => s.id === "looks")
    if (looksSec && looks) {
      entries.push({
        id: "section:looks",
        label: "Looks Debug Room",
        group: "Rendering Styles (Looks)",
        category: "lighting",
        collection: "shared",
        tag: "Room",
        sectionId: "looks",
        isActive: () => globalSettings.section === "looks",
        run: () => selectSection("looks"),
      })
      for (const pid of LOOK_PRESET_IDS) {
        const def = LOOK_PRESETS[pid]
        const id = `look-preset:${pid}`
        entries.push({
          id,
          label: def.label,
          group: "Rendering Styles (Looks)",
          category: "lighting",
          collection: "shared",
          tag: "Look",
          sectionId: "looks",
          isActive: () => globalSettings.section === "looks" && looksSec.settings.preset === pid,
          run: () => {
            const before = captureSnapshot()
            activeCatalogId = id
            if (globalSettings.section !== "looks") selectSection("looks")
            looks.applyPreset(pid)
            recordHistory(`Look preset: ${def.label}`, before)
            panel.sync()
            void renderNow()
          },
        })
      }
    }
    entries.push({
      id: "section:lighting",
      label: "Stage Lighting & Grade",
      group: "Lighting Inspector",
      category: "lighting",
      collection: "shared",
      tag: "Stage",
      sectionId: "lighting",
      isActive: () => globalSettings.section === "lighting",
      run: () => selectSection("lighting"),
    })
    for (const [lookKey, look] of Object.entries(LIGHTING_LOOKS)) {
      const id = `lighting-look:${lookKey}`
      entries.push({
        id,
        label: look.label,
        group: "Named Lighting Looks",
        category: "lighting",
        collection: "shared",
        tag: "Preset",
        sectionId: globalSettings.section,
        isActive: () => activeCatalogId === id,
        run: () => {
          const before = captureSnapshot()
          activeCatalogId = id
          Object.assign(stage.lighting, look.values)
          recordHistory(`Look: ${look.label}`, before)
          panel.sync()
          void renderNow()
        },
      })
    }

    // 9. Audio Category
    const audioSec = sections.find(s => s.id === "audio")
    if (audioSec) {
      const srcCtrl = audioSec.controls.find(c => c.key === "source" && "options" in c)
      if (srcCtrl && "options" in srcCtrl) {
        for (const opt of srcCtrl.options) {
          const id = `audio-source:${opt.value}`
          entries.push({
            id,
            label: opt.label,
            group: "Audio Sources & Emitters",
            category: "audio",
            collection: "shared",
            tag: String(opt.value).startsWith("emitter_") ? "Emitter" : "Cue",
            sectionId: "audio",
            isActive: () => globalSettings.section === "audio" && audioSec.settings.source === opt.value,
            run: fromUser => {
              activeCatalogId = id
              if (globalSettings.section !== "audio") selectSection("audio")
              const c = audioSec.controls.find(ctrl => ctrl.key === "source")
              if (c) panel.navigation.set(c, opt.value)
              if (fromUser && !isBench) audioSec.retrigger?.()
            },
          })
        }
      }
      const repCtrl = audioSec.controls.find(c => c.key === "replay" && "options" in c)
      if (repCtrl && "options" in repCtrl) {
        for (const opt of repCtrl.options) {
          const id = `audio-replay:${opt.value}`
          entries.push({
            id,
            label: opt.label,
            group: "World Replay Scenarios",
            category: "audio",
            collection: "shared",
            tag: "Replay",
            sectionId: "audio",
            isActive: () => globalSettings.section === "audio" && audioSec.settings.replay === opt.value,
            run: fromUser => {
              activeCatalogId = id
              if (globalSettings.section !== "audio") selectSection("audio")
              const c = audioSec.controls.find(ctrl => ctrl.key === "replay")
              if (c) panel.navigation.set(c, opt.value)
              if (fromUser && !isBench) audioSec.retrigger?.()
            },
          })
        }
      }
    }

    // 10. Section registrations: every section is reachable from the Library, with optional items of its own.
    for (const sec of sections) {
      const category = sec.library?.category ?? sectionLibraryCategory(sec.id)
      for (const item of sec.library?.items?.() ?? []) {
        const id = `${sec.id}:${item.id}`
        if (entries.some(e => e.id === id)) continue
        entries.push({
          id,
          label: item.label,
          group: item.group ?? sec.label,
          category,
          collection: "shared",
          tag: item.tag ?? sec.library?.tag ?? sec.label,
          sectionId: sec.id,
          isActive: () => globalSettings.section === sec.id && Boolean(item.active?.()),
          run: () => {
            activeCatalogId = id
            if (globalSettings.section !== sec.id) selectSection(sec.id)
            item.select()
            frameActiveTarget()
          },
        })
      }
      if (!entries.some(e => e.id === `section:${sec.id}`)) {
        entries.push({
          id: `section:${sec.id}`,
          label: sec.library?.label ?? sec.label,
          group: "Sections",
          category,
          collection: "shared",
          tag: sec.library?.tag ?? "Section",
          sectionId: sec.id,
          isActive: () => globalSettings.section === sec.id,
          run: () => selectSection(sec.id),
        })
      }
    }

    // Fixtures for a game whose adapters this Lab did not load (the Lab's game picker) would select a missing section.
    return entries.filter(entry => !entry.sectionId || sections.some(sec => sec.id === entry.sectionId))
  }

  function resolveEnvOwner(): LabSection {
    const sec = activeSection()
    if (sec.controls.some(c => (c.key === "environment" || c.key === "room") && "options" in c)) return sec
    if (spawn && ["effects", "lighting", "physics"].includes(sec.id)) return spawn.section
    return sec
  }

  function syncEnvironmentSelector() {
    const sec = resolveEnvOwner()
    const envControl = sec.controls.find(c => (c.key === "environment" || c.key === "room") && "options" in c)
    envSelect.replaceChildren()
    if (envControl && "options" in envControl) {
      envSelect.disabled = false
      for (const opt of envControl.options) {
        envSelect.add(new Option(opt.label, String(opt.value)))
      }
      envSelect.value = String(sec.settings[envControl.key] ?? "")
    } else {
      envSelect.disabled = true
      envSelect.add(new Option(sec.id === "spawn" || sec.id === "physics" ? "Proving Yard" : "Fixture Stage", "default"))
    }
    const seedVal = sec.settings.seed ?? sec.settings.roomSeed ?? 7
    seedBadge.textContent = `Seed ${seedVal}`
    rerollBtn.disabled = !activeSection().reroll && !sec.reroll
    const hasLocks = "lockEffect" in sec.settings && "lockEnvironment" in sec.settings
    lockEffectBtn.hidden = !hasLocks
    lockEnvBtn.hidden = !hasLocks
    if (hasLocks) {
      lockEffectBtn.setAttribute("aria-pressed", String(Boolean(sec.settings.lockEffect)))
      lockEnvBtn.setAttribute("aria-pressed", String(Boolean(sec.settings.lockEnvironment)))
    }
  }

  function syncTransportAndHints() {
    const sec = activeSection()
    const playing = "playing" in sec.settings ? Boolean(sec.settings.playing) : true
    playPauseBtn.textContent = playing ? "❚❚" : "▶"
    playPauseBtn.title = playing ? "Pause (K)" : "Play (K)"
    playPauseBtn.setAttribute("aria-pressed", String(playing))
    const hasLoop = "loop" in sec.settings
    loopBtn.disabled = !hasLoop
    loopBtn.setAttribute("aria-pressed", String(hasLoop && Boolean(sec.settings.loop)))
    retriggerBtn.disabled = !sec.retrigger
    timeReadout.textContent = `${elapsed.toFixed(2)}s · f${frames}`

    // Contextual short hint strip
    const ghost = spawn?.getGhost()
    focusPill.dataset.mode = mode
    if (mode === "play") {
      const charName = spawn?.characterLabel() ?? "Character"
      focusPill.textContent = ejected ? `Play (Ejected) · ${charName}` : `Play · ${charName}`
      hintText.textContent = ejected
        ? "2F/RMB Orbit · ⇧Pan · Pinch/Wheel Zoom · F8/P Re-possess · Esc Exit Play"
        : `${moveClusterLabel()}/Arrows Move · Space Brake · Shift Boost/Sprint · F8 Eject · Esc Exit Play`
    } else if (variationGrid) {
      const n = variationGrid.tiles.length
      focusPill.textContent =
        focusedGridTile !== null
          ? `Grid Tile ${focusedGridTile}/${n}`
          : `Grid (${variationGrid.cols}×${variationGrid.rows})`
      hintText.textContent =
        focusedGridTile !== null
          ? `1–${n} Switch Tile · Esc/G Back to Grid · 2F/RMB Orbit · Space Retrigger · K Pause`
          : `Click or 1–${n} Focus Tile · 2F/RMB Orbit Shared Camera · Space Retrigger · K Pause · Esc/G Close Grid`
    } else if (ghost) {
      focusPill.textContent = `Place · ${ghost.kind}`
      hintText.textContent = "Click/Enter Place · ⇧Click Repeat · [ ] Rotate · Arrows Nudge · Esc Cancel"
    } else if (activeTransform) {
      const verb = activeTransform.mode === "rotate" ? "Rotate" : "Move"
      focusPill.textContent = `${verb} · ${activeTransform.primaryId}`
      hintText.textContent = "Click/Enter Commit · R/G Mode · [ ] Rotate · Type Number (Tab X/Z) · Esc Cancel"
    } else if (focusZone === "inspector") {
      const activeCtrl = panel.navigation.active?.control
      focusPill.textContent = `Inspector · ${activeCtrl?.label ?? panel.navigation.active?.group ?? "Controls"}`
      hintText.textContent = "↑↓ Row · ←→ Adjust (⇧×10 ⌥×0.1) · Enter Exact · 0 Reset · R Randomize · Esc Canvas"
    } else if (focusZone === "library") {
      focusPill.textContent = "Edit · Library"
      hintText.textContent = "Type to filter · ↑↓ Browse · Enter Select · Drag a tile into the viewport to place · Ctrl+Space Close · Esc Canvas"
    } else if (focusZone === "outliner") {
      focusPill.textContent = "Edit · Outliner"
      hintText.textContent = "↑↓ Select · ⇧↑↓ Extend · ←→ Collapse/Expand · Space Toggle · ⌘Click Toggle · ⇧Click Range · Enter Frame · ⌫ Delete · Esc Canvas"
    } else if (focusZone === "palette") {
      focusPill.textContent = "Search"
      hintText.textContent = "@ Scene · # Settings · + Library · > Commands · ↑↓ Move · Enter Run · Esc Close"
    } else {
      focusPill.textContent = "Edit · Canvas"
      if (sec.id === "spawn") {
        hintText.textContent = "Click Select · ⇧Click Add · Drag Box · 2F/RMB Orbit · RMB Tap Radial · G Move · P Play · F Frame · ⇧Tab Outliner · Ctrl+Space Library · ⌘K Search"
      } else {
        hintText.textContent = "2F/RMB Orbit · ⇧Pan · Pinch/Wheel Zoom · RMB Tap Radial · Space Retrigger · F Frame · R Reroll · Ctrl+Space Library · ⌘K Search"
      }
    }
  }

  function syncStageMarkers() {
    stage.markers.length = 0
    stage.showMarkers = root.dataset.closed !== "true"
    const objects = allSceneObjects()
    const selIds = currentSelectedIds()
    const showSelectionRing = selIds.length > 0 || Boolean(activeTransform)
    const selectedList = selIds.length > 0
      ? objects.filter(o => selIds.includes(o.id))
      : showSelectionRing && objects[0]
        ? [objects[0]]
        : []
    if (mode === "edit" && showSelectionRing) {
      for (const selObj of selectedList) {
        stage.markers.push({
          x: selObj.x,
          y: selObj.y,
          z: selObj.z,
          yaw: selObj.yaw ?? 0,
          radius: selObj.radius ?? 0.75,
          kind: "select",
        })
      }
    }
    if (hoveredObjectId && !selIds.includes(hoveredObjectId) && mode === "edit") {
      const hov = objects.find(o => o.id === hoveredObjectId)
      if (hov) {
        stage.markers.push({
          x: hov.x,
          y: hov.y,
          z: hov.z,
          yaw: hov.yaw ?? 0,
          radius: hov.radius ?? 0.75,
          kind: "hover",
        })
      }
    }
    const ghost = spawn?.getGhost()
    if (ghost && globalSettings.section === "spawn") {
      const groundFn = activeSection().groundHeight ?? (() => 0)
      const gs = sampleGroundNormal(ghost.x, ghost.z, groundFn)
      stage.markers.push({
        x: ghost.x,
        y: ghost.y,
        z: ghost.z,
        yaw: ghost.yaw,
        pitch: gs.pitch,
        roll: gs.roll,
        radius: 0.8,
        kind: ghost.valid ? "ghost" : "invalid",
      })
    } else if (
      mode === "edit" &&
      hoveredGroundSample &&
      !hoveredObjectId &&
      !activeTransform &&
      radialState.phase === "closed" &&
      marqueeEl.hidden &&
      !compareWipeEnabled
    ) {
      stage.markers.push({
        x: hoveredGroundSample.x,
        y: hoveredGroundSample.y,
        z: hoveredGroundSample.z,
        yaw: 0,
        pitch: hoveredGroundSample.pitch,
        roll: hoveredGroundSample.roll,
        radius: 0.42,
        kind: "reticle",
      })
    }

    // Sync in-viewport Transform Gizmo position
    const movableSelected = selectedList.filter(o => o.movable)
    const showGizmo =
      mode === "edit" &&
      globalSettings.section === "spawn" &&
      root.dataset.closed !== "true" &&
      !ghost &&
      !compareWipeEnabled &&
      marqueeEl.hidden &&
      radialState.phase === "closed" &&
      movableSelected.length > 0 &&
      (selIds.length > 0 || Boolean(activeTransform))
    if (showGizmo) {
      stage.updateCamera()
      const c = computeSelectionCentroid(movableSelected)
      const primaryObj = movableSelected.at(-1)
      const ringRadius = primaryObj?.radius ?? 0.75
      const ringY = c.y + 0.02 + 0.03 * ringRadius
      const rect = viewportEl.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        const projected = projectGroundRotateRing(
          c.x,
          ringY,
          c.z,
          ringRadius,
          c.yaw,
          rect.width,
          rect.height,
          (x, y, z) => stage.projectWorld(x, y, z),
        )
        if (projected.visible) {
          transformGizmo.sync({
            visible: true,
            screenX: projected.screenX,
            screenY: projected.screenY,
            x: c.x,
            z: c.z,
            yawRad: c.yaw,
            activeMode: activeTransform?.mode ?? null,
            ringPoints: projected.ringPoints,
            handleOffset: projected.handleOffset,
          })
        } else {
          transformGizmo.sync({ visible: false, screenX: 0, screenY: 0, x: 0, z: 0, yawRad: 0, activeMode: null })
        }
      } else {
        transformGizmo.sync({ visible: false, screenX: 0, screenY: 0, x: 0, z: 0, yawRad: 0, activeMode: null })
      }
    } else {
      transformGizmo.sync({ visible: false, screenX: 0, screenY: 0, x: 0, z: 0, yawRad: 0, activeMode: null })
    }
  }

  function syncChrome() {
    const sec = activeSection()
    sectionSelect.value = sec.id
    debugSelect.value = String(globalSettings.debug)
    editModeBtn.setAttribute("aria-pressed", String(mode === "edit" && !boxSelectMode))
    playModeBtn.setAttribute("aria-pressed", String(mode === "play"))
    playModeBtn.dataset.playActive = String(mode === "play")
    playModeBtn.textContent = mode === "play" ? "■ Stop" : "▶ Play"
    playModeBtn.title =
      mode === "play"
        ? "Stop Play mode and restore pre-Play checkpoint (Esc · F8 eject)"
        : "Enter Play mode and possess character (P · Alt+P · F8 eject)"
    boxModeBtn.setAttribute("aria-pressed", String(mode === "edit" && boxSelectMode))
    const twoFingerMode = getTwoFingerScrollMode()
    scrollModeBtn.setAttribute("aria-pressed", String(twoFingerMode === "pan"))
    scrollModeBtn.textContent = twoFingerMode === "pan" ? "2F: Pan" : "2F: Orbit"
    pinABtn.setAttribute("aria-pressed", String(Boolean(slotA && activeSlot === "A")))
    pinABtn.textContent = slotA ? `A·f${slotA.frames}` : "A"
    flipBtn.setAttribute("aria-pressed", String(Boolean(slotA && activeSlot === "A")))
    flipBtn.textContent = slotA ? `${activeSlot}·V` : "V"
    wipeBtn.setAttribute("aria-pressed", String(compareWipeEnabled))
    gridBtn.setAttribute("aria-pressed", String(Boolean(variationGrid)))
    syncCompareWipeOverlay()
    syncVariationGridOverlay()

    undoBtn.disabled = undoStack.length === 0
    undoBtn.title = undoStack.length ? `Undo ${undoStack.at(-1)!.label} (⌘Z)` : "Undo (⌘Z)"
    redoBtn.disabled = redoStack.length === 0
    redoBtn.title = redoStack.length ? `Redo ${redoStack.at(-1)!.label} (⇧⌘Z)` : "Redo (⇧⌘Z)"

    const objs = allSceneObjects()
    const selList = currentSelectedObjects()
    const selObj = selList.at(-1) ?? null

    // Viewport HUD badge
    hudBadge.hidden = sec.id === "audio" || Boolean(variationGrid && focusedGridTile === null)
    if (mode === "play") {
      hudBadge.textContent = ejected
        ? `PLAY (EJECTED) · ${spawn?.characterLabel() ?? "Character"} (F8 possess · Esc stop)`
        : `PLAY · ${spawn?.characterLabel() ?? "Character"} (F8 eject · Esc to exit)`
    } else if (spawn?.getGhost()) {
      const g = spawn.getGhost()!
      hudBadge.textContent = `Place ${g.kind} · (${g.x.toFixed(1)}, ${g.z.toFixed(1)}) · ${Math.round((g.yaw * 180) / Math.PI)}°`
    } else if (activeTransform) {
      const count = activeTransform.offsets.length
      const verb = activeTransform.mode === "rotate" ? "Rotate" : "Move"
      const targetName = count > 1 ? `${count} objects` : activeTransform.primaryId
      const numText = activeTransform.numericBuffer
        ? ` · ${activeTransform.numericAxis.toUpperCase()}=${activeTransform.numericBuffer}`
        : ` · (${activeTransform.currentX.toFixed(2)}, ${activeTransform.currentZ.toFixed(2)}) ${Math.round((activeTransform.currentYaw * 180) / Math.PI)}°`
      hudBadge.textContent = `${verb} ${targetName}${numText} · Click/Enter commit`
    } else if (hoveredObjectId) {
      const hov = objs.find(o => o.id === hoveredObjectId)
      hudBadge.textContent = hov ? `${hov.label} · Click to select (⇧+Click add)` : `${sec.label}`
    } else if (selList.length > 1) {
      hudBadge.textContent = `${sec.label} · ${selList.length} selected`
    } else {
      hudBadge.textContent = `${sec.label}${selObj ? ` · ${selObj.label}` : ""}`
    }

    syncEnvironmentSelector()
    syncTransportAndHints()
    syncStageMarkers()
    if (chromeReady) {
      const selSig = currentSelectedIds().join("|")
      if (selSig !== lastSelectionSig) {
        lastSelectionSig = selSig
        detailsShowAll = false
        if (!selectingFromOutliner && selList.length === 1) outliner.reveal(selList[0]!.id)
      }
      applyDetailsView()
      syncDetails()
      outliner.render()
      libraryDrawer.render()
      watchList.render(watchPins)
    }
    devControlHandle?.notifyUpdate()
  }

  // Preset Export / Import with schema validation
  function buildPresetPayload(): LabPresetSchema {
    const sec = activeSection()
    const cleanSettings: Record<string, LabValue> = {}
    for (const k of Object.keys(sec.settings)) {
      const v = sec.settings[k]
      if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
        cleanSettings[k] = v
      }
    }
    return {
      version: 1,
      section: sec.id,
      settings: cleanSettings,
      lighting: { ...stage.lighting },
      spawn: spawn
        ? {
            characterId: spawn.snapshot().characterId,
            props: [...spawn.snapshot().props],
          }
        : undefined,
    }
  }

  function applyPresetJson(rawText: string): { ok: true } | { ok: false; error: string } {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch {
      return { ok: false, error: "Invalid JSON syntax." }
    }
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "Preset must be a JSON object." }
    }
    const obj = parsed as Record<string, unknown>
    if (obj.version !== 1) {
      return { ok: false, error: `Unsupported preset schema version: ${String(obj.version)} (expected 1).` }
    }
    if (obj.section === undefined && looks && ("preset" in obj || (obj.settings && typeof obj.settings === "object" && "exposure" in (obj.settings as Record<string, unknown>)))) {
      const before = captureSnapshot()
      if (globalSettings.section !== "looks") selectSection("looks")
      const res = looks.importPresetJson(obj)
      if (!res.ok) return res
      recordHistory("Import look preset", before)
      panel.sync()
      syncChrome()
      void renderNow()
      showToast("Imported look preset")
      return { ok: true }
    }
    if (typeof obj.section !== "string" || !sections.some(s => s.id === obj.section)) {
      return { ok: false, error: `Unknown Lab section: "${String(obj.section)}".` }
    }
    const targetSec = sections.find(s => s.id === obj.section)!
    if (!obj.settings || typeof obj.settings !== "object" || Array.isArray(obj.settings)) {
      return { ok: false, error: "Preset is missing a valid settings object." }
    }
    const incomingSettings = obj.settings as Record<string, unknown>
    // Validate select options (such as effect or environment) before mutating scene
    for (const ctrl of targetSec.controls) {
      if ("options" in ctrl && ctrl.key in incomingSettings) {
        const val = incomingSettings[ctrl.key]
        if (!ctrl.options.some(o => o.value === val || String(o.value) === String(val))) {
          return { ok: false, error: `Unknown ${ctrl.label} value: "${String(val)}".` }
        }
      }
    }
    if (obj.spawn && typeof obj.spawn === "object" && spawn) {
      const sp = obj.spawn as { characterId?: unknown; props?: unknown }
      if (sp.characterId && typeof sp.characterId === "string" && !spawn.adapters.characters.some(c => c.id === sp.characterId)) {
        return { ok: false, error: `Unknown character ID: "${sp.characterId}".` }
      }
      if (sp.props !== undefined) {
        if (!Array.isArray(sp.props)) return { ok: false, error: "spawn.props must be an array." }
        for (const p of sp.props) {
          if (!p || typeof p !== "object" || !spawn.adapters.items.items.some(i => i.id === (p as any).kind)) {
            return { ok: false, error: `Unknown prop kind in spawn.props: "${String((p as any)?.kind)}".` }
          }
        }
      }
    }

    const before = captureSnapshot()
    if (globalSettings.section !== targetSec.id) selectSection(targetSec.id)
    for (const [k, v] of Object.entries(incomingSettings)) {
      if (!(k in targetSec.settings)) continue
      if (typeof v === "number" && Number.isFinite(v)) {
        const ctrl = targetSec.controls.find(c => c.key === k)
        if (ctrl && "min" in ctrl) {
          targetSec.settings[k] = Math.max(ctrl.min, Math.min(ctrl.max, v))
        } else {
          targetSec.settings[k] = v
        }
      } else if (typeof v === "boolean" || typeof v === "string") {
        targetSec.settings[k] = v
      }
    }
    if (obj.lighting && typeof obj.lighting === "object") {
      for (const [k, v] of Object.entries(obj.lighting as Record<string, unknown>)) {
        if (k in stage.lighting && (typeof v === "number" || typeof v === "boolean")) {
          ;(stage.lighting as Record<string, unknown>)[k] = v
        }
      }
    }
    if (obj.spawn && typeof obj.spawn === "object" && spawn) {
      const sp = obj.spawn as { characterId?: string | null; props?: { kind: string; x: number; y: number; z: number; yaw: number }[] }
      const curSnap = spawn.snapshot()
      spawn.restore({
        environment: curSnap.environment,
        seed: curSnap.seed,
        characterId: sp.characterId ?? curSnap.characterId,
        characterAt: curSnap.characterAt ?? { x: 0, y: 0, z: 8, yaw: Math.PI },
        props: sp.props ?? curSnap.props,
        lights: curSnap.lights,
      })
    }
    targetSec.enter?.()
    targetSec.retrigger?.()
    recordHistory("Import preset", before)
    panel.sync()
    syncChrome()
    void renderNow()
    showToast("Imported preset")
    return { ok: true }
  }

  function buildCurrentGameRecipe(): GameRecipePayload {
    const sec = activeSection()
    return buildGameRecipe({
      sectionId: sec.id,
      settings: sec.settings,
      lighting: stage.lighting,
    })
  }

  function openRecipeModal() {
    const recipe = buildCurrentGameRecipe()
    const payload = JSON.stringify(recipe, null, 2)
    focusZone = "modal"
    modalBackdrop.hidden = false
    modalError.hidden = true
    modalTitle.textContent = `Game Recipe · ${recipe.modulePath}`
    modalTextarea.value = `${recipe.codeSnippet}\n\n${payload}`
    modalTextarea.focus()
    modalTextarea.select()
    void navigator.clipboard?.writeText(payload).catch(() => {})
    showToast(`Copied game recipe for ${recipe.modulePath}`)
  }

  function openPresetModal(mode: "export" | "import") {
    focusZone = "modal"
    modalBackdrop.hidden = false
    modalError.hidden = true
    modalTitle.textContent = mode === "export" ? "Export / Copy Preset JSON" : "Import Preset JSON"
    modalTextarea.value = mode === "export" ? JSON.stringify(buildPresetPayload(), null, 2) : ""
    modalTextarea.placeholder = '{"version": 1, "section": "blackout-effects", "settings": {...}}'
    modalTextarea.focus()
    if (mode === "export") modalTextarea.select()
  }

  function closePresetModal() {
    modalBackdrop.hidden = true
    modalError.hidden = true
    focusZone = "canvas"
    canvas.focus({ preventScroll: true })
    syncChrome()
  }

  // Wire topbar events
  editModeBtn.onclick = () => {
    boxSelectMode = false
    setPlayMode("edit")
  }
  playModeBtn.onclick = () => setPlayMode(mode === "play" ? "edit" : "play")
  boxModeBtn.onclick = () => {
    if (mode === "play") setPlayMode("edit")
    boxSelectMode = !boxSelectMode
    syncChrome()
    showToast(boxSelectMode ? "Box Select mode · Drag on canvas to marquee select" : "Standard Edit mode · Drag on empty space box-selects when objects exist; RMB/2F orbits")
  }
  scrollModeBtn.onclick = () => {
    const next = getTwoFingerScrollMode() === "orbit" ? "pan" : "orbit"
    setTwoFingerScrollMode(next)
    syncChrome()
    showToast(`Trackpad two-finger scroll: ${next === "pan" ? "Pan" : "Orbit"} (Shift+2F pans, Pinch/Wheel zooms)`)
  }

  sectionSelect.onchange = () => {
    const before = captureSnapshot()
    selectSection(sectionSelect.value)
    recordHistory(`Section ${sectionSelect.value}`, before)
    syncChrome()
    void renderNow()
  }

  envSelect.onchange = () => {
    const owner = resolveEnvOwner()
    const envControl = owner.controls.find(c => (c.key === "environment" || c.key === "room") && "options" in c)
    if (envControl) {
      const before = captureSnapshot()
      owner.settings[envControl.key] = envSelect.value
      envControl.change?.(envSelect.value)
      recordHistory(`Environment ${envSelect.value}`, before)
      panel.sync()
      syncChrome()
      void renderNow()
    }
  }

  rerollBtn.onclick = () => {
    const sec = activeSection()
    if (!sec.reroll) return
    const before = captureSnapshot()
    sec.reroll()
    recordHistory("Reroll room seed", before)
    panel.sync()
    syncChrome()
    void renderNow()
  }

  lockEffectBtn.onclick = () => {
    const sec = activeSection()
    if ("lockEffect" in sec.settings) {
      sec.settings.lockEffect = !sec.settings.lockEffect
      panel.sync()
      syncChrome()
    }
  }

  lockEnvBtn.onclick = () => {
    const sec = activeSection()
    if ("lockEnvironment" in sec.settings) {
      sec.settings.lockEnvironment = !sec.settings.lockEnvironment
      panel.sync()
      syncChrome()
    }
  }

  debugSelect.onchange = () => {
    globalSettings.debug = Number(debugSelect.value)
    panel.sync()
    syncChrome()
    void renderNow()
  }

  frameBtn.onclick = () => frameActiveTarget()
  pinABtn.onclick = () => pinBaselineSlotA()
  flipBtn.onclick = () => flipCompareSlot()
  wipeBtn.onclick = () => toggleCompareWipe()
  gridBtn.onclick = () => {
    if (variationGrid) closeVariationGrid()
    else openVariationGrid()
  }
  recipeBtn.onclick = () => openRecipeModal()
  undoBtn.onclick = () => undo()
  redoBtn.onclick = () => redo()
  exportBtn.onclick = () => openPresetModal("export")
  importBtn.onclick = () => openPresetModal("import")

  modalCloseBtn.onclick = closePresetModal
  modalCopyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(modalTextarea.value)
      modalCopyBtn.textContent = "Copied"
      setTimeout(() => { modalCopyBtn.textContent = "Copy" }, 1200)
    } catch {
      modalCopyBtn.textContent = "Failed"
    }
  }
  modalApplyBtn.onclick = () => {
    const res = applyPresetJson(modalTextarea.value)
    if (!res.ok) {
      modalError.textContent = res.error
      modalError.hidden = false
    } else {
      closePresetModal()
    }
  }

  // Library drawer, Outliner, ⌘K palette, Watch list and Details
  function groundFnFor(sec: LabSection): (x: number, z: number) => number {
    return sec.groundHeight ?? (spawn && ["effects", "lighting", "physics"].includes(sec.id) ? spawn.section.groundHeight : undefined) ?? (() => 0)
  }

  function groundHitAtClient(clientX: number, clientY: number, groundFn = groundFnFor(activeSection())) {
    const rect = canvas.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
    const [u, v] = canvasUV({ clientX, clientY })
    return stage.pickGround(u, v, groundFn)
  }

  function catalogKindOf(id: string) {
    return id.slice(id.indexOf(":") + 1)
  }

  /** Place a Library entry at a ground point (drag-drop, CLI), or arm its placement ghost / run it when no point is given. */
  function placeLibraryEntry(entry: CatalogEntry, at: { x: number; y: number; z: number } | null, yawDeg = 0) {
    const yaw = (yawDeg * Math.PI) / 180
    if (!at || !spawn || !isPlaceable(entry.id)) {
      const before = captureSnapshot()
      entry.run(true)
      let movedEmitter: string | null = null
      if (at) {
        const sec = activeSection()
        const emitter = sec.objects?.().find(o => o.category === "emitter")
        if (emitter && sec.moveObject?.(emitter.id, at.x, at.z, emitter.yaw) !== false && sec.moveObject) {
          movedEmitter = emitter.id
          elapsed = 0
          frames = 0
          sec.retrigger?.()
        }
      }
      recordHistory(`Library ${entry.label}`, before)
      panel.sync()
      syncChrome()
      void renderNow()
      return { id: entry.id, placed: false, armed: !at && isPlaceable(entry.id), movedEmitter, section: globalSettings.section }
    }
    const before = captureSnapshot()
    if (globalSettings.section !== "spawn") selectSection("spawn")
    spawn.setGhost(null)
    const kind = catalogKindOf(entry.id)
    const point = { x: at.x, y: at.y, z: at.z, yaw }
    if (entry.id.startsWith("spawn-prop:")) {
      spawn.section.settings.item = kind
      spawn.spawnItems("one", point)
    } else if (entry.id.startsWith("spawn-light:")) {
      spawn.section.settings.light = kind
      spawn.lightAt(point)
    } else {
      spawn.section.settings.character = kind
      spawn.spawnCharacterAt(kind, { ...point, yaw: yawDeg ? yaw : Math.PI })
      spawn.section.selectObject?.("character:active")
    }
    recordHistory(`Place ${entry.label.replace(/^Place /, "")}`, before)
    panel.sync()
    syncChrome()
    void renderNow()
    return { id: entry.id, placed: true, at: { x: at.x, y: at.y, z: at.z, yaw: yawDeg }, selected: currentSelectedIds() }
  }

  let dragGhostActive = false
  const libraryDrawer = createLibrary<CatalogEntry>(libraryEl, {
    entries: () => buildCatalog(),
    run: entry => {
      if (mode === "play") setPlayMode("edit")
      entry.run(true)
      panel.sync()
      syncChrome()
      void renderNow()
    },
    dragOver: (entry, clientX, clientY) => {
      const vRect = viewportEl.getBoundingClientRect()
      const placeable = Boolean(spawn) && isPlaceable(entry.id)
      const groundFn = placeable ? spawn!.section.groundHeight ?? yardGround : groundFnFor(activeSection())
      const hit = groundHitAtClient(clientX, clientY, groundFn)
      viewportEl.dataset.drop = String(Boolean(hit))
      if (!hit) {
        if (dragGhostActive) {
          spawn?.setGhost(null)
          dragGhostActive = false
          syncChrome()
          void renderNow()
        }
        viewportCursor.update({ state: "hidden" })
        return false
      }
      viewportCursor.update({ state: "place", x: clientX - vRect.left, y: clientY - vRect.top })
      if (placeable && spawn) {
        if (globalSettings.section !== "spawn") selectSection("spawn")
        const valid = spawn.isValidYardPoint(hit.x, hit.z)
        const kind = catalogKindOf(entry.id)
        spawn.setGhost({ category: entry.id.startsWith("spawn-light:") ? "light" : "prop", kind, x: hit.x, y: hit.y, z: hit.z, yaw: 0, shape: "one", valid })
        dragGhostActive = !entry.id.startsWith("spawn-char:")
        if (!dragGhostActive) spawn.setGhost(null)
        syncChrome()
        void renderNow()
        return valid
      }
      return true
    },
    drop: (entry, clientX, clientY) => {
      viewportEl.dataset.drop = "false"
      const placeable = Boolean(spawn) && isPlaceable(entry.id)
      const hit = groundHitAtClient(clientX, clientY, placeable ? spawn!.section.groundHeight ?? yardGround : groundFnFor(activeSection()))
      dragGhostActive = false
      placeLibraryEntry(entry, hit)
      canvas.focus({ preventScroll: true })
      showToast(hit ? `Placed ${entry.label.replace(/^Place /, "")} at (${hit.x.toFixed(1)}, ${hit.z.toFixed(1)})` : entry.label)
    },
    dragCancel: () => {
      viewportEl.dataset.drop = "false"
      if (dragGhostActive) spawn?.setGhost(null)
      dragGhostActive = false
      syncChrome()
      void renderNow()
    },
    onOpenChange: isOpen => {
      try {
        localStorage.setItem("arcade.lab.library-open", String(isOpen))
      } catch {}
      root.dataset.drawer = String(isOpen)
      void renderNow()
    },
    onFocusChange: focused => {
      if (focused) {
        if (mode === "play") setPlayMode("edit")
        focusZone = "library"
      } else if (focusZone === "library") focusZone = "canvas"
      syncTransportAndHints()
    },
    onExitToCanvas: () => {
      focusZone = "canvas"
      canvas.focus({ preventScroll: true })
      syncTransportAndHints()
    },
  }, (() => {
    try {
      return localStorage.getItem("arcade.lab.library-open") !== "false"
    } catch {
      return true
    }
  })())
  root.dataset.drawer = String(libraryDrawer.open)

  const outliner = createOutliner(root.querySelector<HTMLElement>("[data-outliner-mount]")!, {
    objects: () => allSceneObjects(),
    selectedIds: () => currentSelectedIds(),
    isLocked: id => lockedIds.has(id),
    select: ids => {
      if (mode === "play") setPlayMode("edit")
      selectingFromOutliner = true
      try {
        setSelectionIds(ids)
      } finally {
        selectingFromOutliner = false
      }
    },
    toggleLock: id => {
      if (lockedIds.has(id)) lockedIds.delete(id)
      else lockedIds.add(id)
      if (hoveredObjectId === id) hoveredObjectId = null
      syncChrome()
    },
    frame: id => {
      const obj = allSceneObjects().find(o => o.id === id)
      if (!obj) return
      stage.frameTarget(obj.x, obj.y, obj.z, 14)
      void renderNow()
    },
    onFocusChange: focused => {
      if (focused) {
        if (mode === "play") setPlayMode("edit")
        focusZone = "outliner"
      } else if (focusZone === "outliner") focusZone = "canvas"
      syncTransportAndHints()
    },
    onExitToCanvas: () => {
      focusZone = "canvas"
      canvas.focus({ preventScroll: true })
      syncTransportAndHints()
    },
  })
  outliner.addButton.onclick = () => libraryDrawer.focusSearch()

  function sectionLabel(id: string) {
    return sections.find(s => s.id === id)?.label ?? id
  }

  function objectGroupLabel(obj: LabWorldObject) {
    return OUTLINER_GROUPS.find(g => g.id === outlinerGroupOf(obj))!.label
  }

  function paletteItems(): PaletteItem[] {
    const items: PaletteItem[] = []
    for (const obj of allSceneObjects()) {
      items.push({
        id: `object:${obj.id}`,
        kind: "object",
        label: obj.label,
        meta: `${objectGroupLabel(obj)} · ${obj.id}`,
        run: () => {
          setSelectionIds([obj.id])
          stage.frameTarget(obj.x, obj.y, obj.z, 14)
          outliner.reveal(obj.id)
          canvas.focus({ preventScroll: true })
          void renderNow()
        },
      })
    }
    for (const entry of buildCatalog()) {
      if (!isLibraryAsset(entry)) continue
      const cat = LIBRARY_CATEGORIES.find(c => c.id === libraryCategoryOf(entry))!
      items.push({
        id: `library:${entry.id}`,
        kind: "library",
        label: entry.label,
        meta: `${cat.label} · ${entry.group}`,
        hint: entry.tag,
        run: () => {
          if (mode === "play") setPlayMode("edit")
          libraryDrawer.setCategory(cat.id)
          entry.run(true)
          panel.sync()
          syncChrome()
          void renderNow()
        },
      })
    }
    for (const cmd of commands.all()) {
      if (cmd.id.startsWith("palette.")) continue
      if (Object.values(cmd.args ?? {}).some(a => a.required)) continue
      const enabled = cmd.enabled({ pickedObject: null, groundHit: null, source: "ui" })
      items.push({
        id: `command:${cmd.id}`,
        kind: "command",
        label: cmd.label,
        meta: `${cmd.category} · ${cmd.id}`,
        hint: cmd.shortcut,
        disabled: !enabled,
        run: () => {
          const res = commands.invoke(cmd.id, undefined, { source: "ui" })
          if (!res.ok) showToast(res.error, true)
          syncChrome()
        },
      })
    }
    for (const sec of sections) {
      for (const c of sec.controls) {
        if (c.type === "action") continue
        items.push({
          id: `setting:${sec.id}:${c.key}`,
          kind: "setting",
          label: c.label,
          meta: `${sec.label} · ${c.group ?? "Controls"}`,
          run: () => {
            revealSetting(sec.id, c.key)
          },
        })
      }
    }
    return items
  }

  const palette = createPalette(root, {
    items: paletteItems,
    onOpenChange: open => {
      if (open) {
        if (mode === "play") setPlayMode("edit")
        focusZone = "palette"
      } else if (focusZone === "palette") focusZone = "canvas"
      syncTransportAndHints()
    },
  })
  paletteBtn.onclick = () => palette.open()

  function clearDetailsFilters() {
    detailsQuery = ""
    detailsSearch.value = ""
    detailsModifiedOnly = false
    detailsShowAll = true
    detailsViewSig = ""
    applyDetailsView()
  }

  /** Jump to a setting: switch section if needed, clear filters hiding it, then scroll, focus and flash the row. */
  function revealSetting(sectionId: string, key: string): boolean {
    if (!sections.some(s => s.id === sectionId)) return false
    if (mode === "play") setPlayMode("edit")
    if (globalSettings.section !== sectionId) {
      const before = captureSnapshot()
      selectSection(sectionId)
      recordHistory(`Section ${sectionLabel(sectionId)}`, before)
    }
    applyDetailsView()
    let ok = panel.reveal(key)
    if (!ok) {
      clearDetailsFilters()
      ok = panel.reveal(key)
    }
    const control = sections.find(s => s.id === sectionId)?.controls.find(c => c.key === key)
    if (ok) {
      panel.setReturnFocus(canvas)
      focusZone = "inspector"
    } else {
      showToast(`${control?.label ?? key} is not available in the current state`, true)
    }
    syncChrome()
    void renderNow()
    return ok
  }

  function readWatchPin(pin: WatchPin) {
    const sec = sections.find(s => s.id === pin.sectionId)
    const c = sec?.controls.find(ctrl => ctrl.key === pin.key)
    if (!sec || !c || c.type === "action" || !(pin.key in sec.settings)) return null
    const v = sec.settings[pin.key]!
    const text =
      "options" in c
        ? c.options.find(o => o.value === v)?.label ?? String(v)
        : "min" in c
          ? formatLabValue(v, c.step, inferControlUnit(c.key, c.label, c.unit))
          : v === (c.on ?? true)
            ? "On"
            : "Off"
    const d = defaultsBySection.get(sec.id)?.[pin.key]
    const modified =
      !c.derived && d !== undefined && (typeof v === "number" && typeof d === "number" ? Math.abs(v - d) > ("min" in c ? (c.step ?? 0.01) * 1e-3 : 1e-9) : v !== d)
    return { text, modified, sectionLabel: sec.label }
  }

  function setWatchPins(next: WatchPin[]) {
    watchPins = next
    saveWatchPins(watchPins)
    watchList.render(watchPins)
    panel.sync()
    devControlHandle?.notifyUpdate()
  }

  function pinSetting(sectionId: string, key: string, pinned?: boolean) {
    const sec = sections.find(s => s.id === sectionId)
    const c = sec?.controls.find(ctrl => ctrl.key === key)
    if (!sec || !c || c.type === "action") throw new Error(`Unknown setting "${key}" in section "${sectionId}".`)
    const id = watchPinId({ sectionId, key })
    const exists = watchPins.some(p => watchPinId(p) === id)
    const want = pinned ?? !exists
    if (want && !exists) setWatchPins([...watchPins, { sectionId, key, label: c.label, group: c.group ?? "Controls" }])
    else if (!want && exists) setWatchPins(watchPins.filter(p => watchPinId(p) !== id))
    return want
  }

  const watchList = createWatchList(viewportEl.querySelector<HTMLElement>(".lab-viewport-hud")!, {
    read: readWatchPin,
    reveal: pin => revealSetting(pin.sectionId, pin.key),
    unpin: pin => setWatchPins(watchPins.filter(p => watchPinId(p) !== watchPinId(pin))),
  })
  watchList.render(watchPins)

  function applyDetailsView(force = false) {
    const sec = activeSection()
    const selected = detailsSelection()
    const relevant = sec.detailsGroups?.(selected)
    const only = relevant && selected.length && !detailsShowAll ? new Set(relevant) : null
    const q = detailsQuery.trim().toLowerCase()
    const sig = JSON.stringify([sec.id, relevant ?? null, only ? [...only] : null, q, detailsModifiedOnly, panel.navigation.rows.length])
    detailsAllBtn.hidden = !(relevant && selected.length)
    detailsAllBtn.setAttribute("aria-pressed", String(detailsShowAll))
    detailsModifiedBtn.setAttribute("aria-pressed", String(detailsModifiedOnly))
    detailsRelevant = only
    if (!force && sig === detailsViewSig) return
    detailsViewSig = sig
    panel.setView({
      order: relevant ?? [],
      filter:
        only || q || detailsModifiedOnly
          ? (row, modified) => {
              if (only && !only.has(row.group)) return false
              if (detailsModifiedOnly && !modified) return false
              if (q && !`${row.control?.label ?? ""} ${row.control?.key ?? ""} ${row.group}`.toLowerCase().includes(q)) return false
              return true
            }
          : undefined,
    })
  }

  const CATEGORY_ICON: Record<string, string> = { character: "♟", prop: "▣", emitter: "✺", light: "✦", specimen: "◇" }

  /** Selected objects owned by the active section; a Spawn selection kept while tuning an effect does not drive Details. */
  function detailsSelection(): LabWorldObject[] {
    const sec = activeSection()
    return currentSelectedObjects().filter(o => resolveObjectOwner(o.id) === sec)
  }

  function syncDetails() {
    const sec = activeSection()
    const selList = detailsSelection()
    const selObj = selList.at(-1) ?? null
    inspectorSub.textContent = sec.label
    if (selList.length > 1) {
      const c = computeSelectionCentroid(selList)
      const counts = new Map<string, number>()
      for (const o of selList) {
        const k = o.label.replace(/\s*(#\d+|\(\d+\)|\d+)$/, "")
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      inspectorTitle.textContent = `${selList.length} objects`
      detailsMeta.textContent = `${[...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(" · ")} · centroid (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`
      detailsIcon.textContent = "▦"
    } else if (selObj) {
      inspectorTitle.textContent = selObj.label
      detailsMeta.textContent = `${objectGroupLabel(selObj)} · ${selObj.kind ?? selObj.category} · (${selObj.x.toFixed(1)}, ${selObj.z.toFixed(1)})`
      detailsIcon.textContent = selObj.vehicle ? "◧" : CATEGORY_ICON[selObj.category] ?? "◇"
    } else {
      const envOwner = resolveEnvOwner()
      const envCtrl = envOwner.controls.find(c => (c.key === "environment" || c.key === "room") && "options" in c)
      const envLabel = envCtrl && "options" in envCtrl ? envCtrl.options.find(o => o.value === envOwner.settings[envCtrl.key])?.label : null
      const seed = envOwner.settings.seed ?? envOwner.settings.roomSeed
      let title = sec.detailsGroups ? "Scene" : sec.label
      const primary = sec.controls.find(c => (c.key === "effect" || c.key === "recipe" || c.key === "treePreset" || c.key === "preset") && "options" in c)
      if (!sec.detailsGroups && primary && "options" in primary) title = primary.options.find(o => o.value === sec.settings[primary.key])?.label ?? sec.label
      if (sec.id === "looks" && "preset" in sec.settings) {
        const pid = resolveLookPresetId(sec.settings.preset) ?? "current"
        title = LOOK_PRESETS[pid].label
        inspectorSub.textContent = `Looks · ${LOOK_PRESETS[pid].directionRef}`
      }
      inspectorTitle.textContent = title
      detailsMeta.textContent = ["Nothing selected · scene settings", envLabel, seed !== undefined ? `seed ${seed}` : null].filter(Boolean).join(" · ")
      detailsIcon.textContent = LIBRARY_CATEGORIES.find(c => c.id === (sec.library?.category ?? sectionLibraryCategory(sec.id)))?.icon ?? "◇"
    }
    const relevantRows = new Set(panel.navigation.rows.filter(r => r.control && (!detailsRelevant || detailsRelevant.has(r.group))).map(r => r.control!))
    const n = panel.modifiedControls().filter(c => relevantRows.has(c)).length
    detailsModifiedCount.textContent = n ? String(n) : ""

    const actionIds = selList.length
      ? ["object.trigger", "object.frame", "object.duplicate", "object.delete", "object.move", ...(spawn ? ["object.possess"] : [])]
      : [...(sec.retrigger ? ["ground.trigger-here"] : []), "ground.frame", "ground.reroll", "ground.clear", ...(spawn ? ["object.possess"] : [])]
    const ctx: LabCommandContext = { pickedObject: null, groundHit: null, source: "ui" }
    const states = actionIds.map(id => {
      const cmd = commands.get(id)
      return { id, cmd, enabled: Boolean(cmd && mode !== "play" && cmd.enabled(ctx)) }
    })
    const sig = JSON.stringify(states.map(s => [s.id, s.enabled]))
    if (sig !== detailsActionsSig) {
      detailsActionsSig = sig
      detailsActions.replaceChildren()
      for (const { id, cmd, enabled } of states) {
        if (!cmd) continue
        const b = document.createElement("button")
        b.type = "button"
        b.className = "lab-act"
        b.dataset.command = id
        b.disabled = !enabled
        b.title = enabled ? cmd.label : cmd.disabledReason?.(ctx) ?? "Unavailable"
        const label = id === "ground.trigger-here" ? "Retrigger" : id === "ground.clear" ? "Clear FX" : id === "object.possess" ? "Play" : cmd.shortLabel
        b.append(label)
        if (cmd.shortcut) {
          const k = document.createElement("kbd")
          k.textContent = cmd.shortcut
          b.append(k)
        }
        b.onclick = () => {
          const res = commands.invoke(id, undefined, { source: "ui" })
          if (!res.ok) showToast(res.error, true)
          syncChrome()
        }
        detailsActions.append(b)
      }
    }
  }

  detailsSearch.addEventListener("input", () => {
    detailsQuery = detailsSearch.value
    applyDetailsView()
    syncDetails()
  })
  detailsSearch.addEventListener("focus", () => {
    if (mode === "play") setPlayMode("edit")
  })
  detailsSearch.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault()
      if (detailsSearch.value) {
        detailsSearch.value = ""
        detailsQuery = ""
        applyDetailsView()
      } else canvas.focus({ preventScroll: true })
    } else if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault()
      panel.setReturnFocus(canvas)
      focusZone = "inspector"
      panel.focusFirst()
      syncTransportAndHints()
    }
  })
  detailsModifiedBtn.onclick = () => {
    detailsModifiedOnly = !detailsModifiedOnly
    applyDetailsView()
    syncDetails()
  }
  detailsAllBtn.onclick = () => {
    detailsShowAll = !detailsShowAll
    applyDetailsView()
  }

  moreBtn.onclick = () => {
    moreMenu.hidden = !moreMenu.hidden
    moreBtn.setAttribute("aria-expanded", String(!moreMenu.hidden))
  }
  moreMenu.addEventListener("click", () => {
    moreMenu.hidden = true
    moreBtn.setAttribute("aria-expanded", "false")
  })
  document.addEventListener("pointerdown", event => {
    if (!moreMenu.hidden && !moreMenu.contains(event.target as Node) && !moreBtn.contains(event.target as Node)) {
      moreMenu.hidden = true
      moreBtn.setAttribute("aria-expanded", "false")
    }
  })
  chromeReady = true

  // Wire transport bar events
  playPauseBtn.onclick = () => {
    const sec = activeSection()
    if ("playing" in sec.settings) {
      sec.settings.playing = !sec.settings.playing
      panel.sync()
      syncChrome()
    }
  }

  retriggerBtn.onclick = () => {
    const sec = activeSection()
    elapsed = 0
    frames = 0
    sec.retrigger?.()
    if (variationGrid && sec.id === "effects" && effects) {
      effects.resetVariantSlots(variationGrid.tiles)
    }
    panel.sync()
    syncChrome()
    void renderNow()
  }

  stepBtn.onclick = () => {
    const sec = activeSection()
    if ("playing" in sec.settings) sec.settings.playing = false
    const wasPlaying = sec.settings.playing
    sec.settings.playing = true
    advanceSim(1 / 60)
    sec.settings.playing = wasPlaying ?? false
    elapsed += 1 / 60
    frames += 1
    panel.sync()
    syncChrome()
    void renderNow()
  }

  loopBtn.onclick = () => {
    const sec = activeSection()
    if ("loop" in sec.settings) {
      sec.settings.loop = !sec.settings.loop
      panel.sync()
      syncChrome()
    }
  }

  speedSelect.onchange = () => {
    simSpeed = Number(speedSelect.value) || 1
    const sec = activeSection()
    if ("slowMotion" in sec.settings) {
      sec.settings.slowMotion = Math.min(1, simSpeed)
      panel.sync()
    }
  }

  // Exiting Play mode and hiding custom viewport cursor whenever user interacts with UI panels outside canvas
  for (const zone of [topbar, outlinerEl, libraryEl, inspectorEl, bottombar, modalBackdrop]) {
    zone.addEventListener("pointerenter", () => {
      hoveredGroundSample = null
      viewportCursor.update({ state: "hidden" })
    })
    zone.addEventListener("pointerdown", event => {
      const t = event.target as HTMLElement | null
      if (t?.closest('[data-action="mode-play"], [data-action="mode-edit"], [data-command="object.possess"], [data-command="mode.play"], [data-command="mode.eject"]')) {
        return
      }
      if (mode === "play") setPlayMode("edit")
      hoveredGroundSample = null
      viewportCursor.update({ state: "hidden" })
    })
    zone.addEventListener("focusin", event => {
      const t = event.target as HTMLElement | null
      if (t?.closest('[data-action="mode-play"], [data-action="mode-edit"], [data-command="object.possess"], [data-command="mode.play"], [data-command="mode.eject"]')) {
        return
      }
      if (mode === "play") setPlayMode("edit")
      hoveredGroundSample = null
      viewportCursor.update({ state: "hidden" })
    })
  }

  // Canvas pointer & camera & world picking
  let viewportGestures: ReturnType<typeof bindOrbitGestures> | undefined

  function hasBoxSelectableObjects(): boolean {
    const sec = activeSection()
    if (!sec.selectObjects && !(spawn && ["effects", "lighting", "physics"].includes(sec.id) && spawn.section.selectObjects)) {
      return false
    }
    return allSceneObjects().length > 0
  }

  function canvasUV(event: { clientX: number; clientY: number }): [number, number] {
    const rect = canvas.getBoundingClientRect()
    const u = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
    const v = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
    return [u, v]
  }

  function pickObjectAt(u: number, v: number): LabWorldObject | null {
    const sec = activeSection()
    const objects = allSceneObjects().filter(o => !lockedIds.has(o.id))
    if (!objects.length) return null
    const groundFn = sec.groundHeight ?? (spawn && ["effects", "lighting", "physics"].includes(sec.id) ? spawn.section.groundHeight : undefined) ?? (() => 0)
    const hit = stage.pickGround(u, v, groundFn)
    let best: LabWorldObject | null = null
    let bestScore = Infinity
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, rect.width)
    const h = Math.max(1, rect.height)
    for (const obj of objects) {
      const r = Math.max(0.85, (obj.radius ?? 0.85) * 1.25)
      if (hit) {
        const d = Math.hypot(hit.x - obj.x, hit.z - obj.z)
        if (d <= r && d < bestScore) {
          best = obj
          bestScore = d
        }
      }
      const proj = stage.projectWorld(obj.x, obj.y + 0.35, obj.z)
      if (proj.visible) {
        const pxDist = Math.hypot((proj.u - u) * w, (proj.v - v) * h)
        if (pxDist <= 34) {
          const equivDist = (pxDist / 34) * r
          if (equivDist < bestScore) {
            best = obj
            bestScore = equivDist
          }
        }
      }
    }
    return best
  }

  function openRadialAtScreen(clientX: number, clientY: number, viaKeyboard = false) {
    const rect = viewportEl.getBoundingClientRect()
    const [u, v] = canvasUV({ clientX, clientY })
    const sec = activeSection()
    const groundFn = sec.groundHeight ?? (spawn && ["effects", "lighting", "physics"].includes(sec.id) ? spawn.section.groundHeight : undefined) ?? (() => 0)
    const pickedObject = pickObjectAt(u, v)
    const groundHit = stage.pickGround(u, v, groundFn)
    const localX = clientX - rect.left
    const localY = clientY - rect.top
    const ctx: LabCommandContext = { pickedObject, groundHit, screenX: localX, screenY: localY }
    if (viaKeyboard) {
      radialState.openKeyboard(localX, localY, rect.width, rect.height, performance.now(), ctx)
    } else {
      radialState.openPointer(localX, localY, rect.width, rect.height, performance.now(), ctx)
    }
    radialDOM.sync()
    viewportCursor.update({ state: "radial", native: true })
    syncTransportAndHints()
  }

  function openRadialFromKeyboard(targetObj?: LabWorldObject | null) {
    const rect = viewportEl.getBoundingClientRect()
    const obj = targetObj !== undefined ? targetObj : activeTargetObject()
    if (obj) {
      const proj = stage.projectWorld(obj.x, obj.y + 0.3, obj.z)
      const localX = proj.visible ? proj.u * rect.width : rect.width * 0.5
      const localY = proj.visible ? proj.v * rect.height : rect.height * 0.5
      radialState.openKeyboard(localX, localY, rect.width, rect.height, performance.now(), {
        pickedObject: obj,
        groundHit: { x: obj.x, y: obj.y, z: obj.z },
        screenX: localX,
        screenY: localY,
      })
    } else {
      const sec = activeSection()
      const groundFn = sec.groundHeight ?? (() => 0)
      const groundHit = stage.pickGround(0.5, 0.5, groundFn) ?? { x: 0, y: 0, z: 0 }
      radialState.openKeyboard(rect.width * 0.5, rect.height * 0.5, rect.width, rect.height, performance.now(), {
        pickedObject: null,
        groundHit,
        screenX: rect.width * 0.5,
        screenY: rect.height * 0.5,
      })
    }
    radialDOM.sync()
    viewportCursor.update({ state: "radial", native: true })
    syncTransportAndHints()
  }

  canvas.addEventListener("focus", () => {
    focusZone = "canvas"
    syncTransportAndHints()
  })

  // While the radial menu is open the OS cursor stays visible (no drawn-glyph lag); the menu draws the direction.
  function trackRadialPointer(localX: number, localY: number) {
    radialState.movePointer(localX, localY)
    radialDOM.sync()
    const activeSector = radialState.zone === "ring" && radialState.activeSlot !== null ? radialState.sectors[radialState.activeSlot] : null
    viewportCursor.update({ state: activeSector && !activeSector.enabled ? "disabled" : "radial", native: true })
  }

  viewportEl.addEventListener("pointermove", event => {
    if (radialState.phase === "closed" || event.target === canvas) return
    const vRect = viewportEl.getBoundingClientRect()
    trackRadialPointer(event.clientX - vRect.left, event.clientY - vRect.top)
  })

  viewportEl.addEventListener("pointerup", event => {
    if (radialState.phase !== "holding" || event.target === canvas) return
    const vRect = viewportEl.getBoundingClientRect()
    const res = radialState.releasePointer(event.clientX - vRect.left, event.clientY - vRect.top, performance.now())
    radialDOM.sync()
    handleRadialResult(res)
  })

  viewportEl.addEventListener("pointerleave", () => {
    hoveredGroundSample = null
    hoveredGizmoHandle = null
    viewportCursor.update({ state: "hidden" })
    syncStageMarkers()
    void renderNow()
  })

  canvas.addEventListener("pointerup", event => {
    if (radialState.phase === "holding") {
      const rect = viewportEl.getBoundingClientRect()
      const res = radialState.releasePointer(event.clientX - rect.left, event.clientY - rect.top, performance.now())
      radialDOM.sync()
      handleRadialResult(res)
      return
    }
    if (activeTransform?.viaHandle) {
      viewportGestures?.cancelDrag()
      commitActiveTransform()
    }
  })

  viewportGestures = bindOrbitGestures(canvas, {
    target: stage,
    smooth: true,
    isEnabled: () => mode === "edit" || (mode === "play" && ejected),
    canPrimaryOrbit: () => !spawn?.getGhost() && !activeTransform,
    onPointerDownIntercept: event => {
      focusZone = "canvas"
      if (radialState.phase === "latched") {
        const rect = viewportEl.getBoundingClientRect()
        const res = radialState.releasePointer(event.clientX - rect.left, event.clientY - rect.top, performance.now())
        radialDOM.sync()
        handleRadialResult(res)
        return true
      }
      return false
    },
    onCameraDragMove: (dragKind, event) => {
      hoveredGroundSample = null
      const vRect = viewportEl.getBoundingClientRect()
      viewportCursor.update({
        state: dragKind,
        x: event.clientX - vRect.left,
        y: event.clientY - vRect.top,
      })
    },
    onHoverMove: event => {
      if (mode === "play" && !ejected) {
        hoveredGroundSample = null
        viewportCursor.update({ state: "hidden" })
        return
      }
      const vRect = viewportEl.getBoundingClientRect()
      const localX = event.clientX - vRect.left
      const localY = event.clientY - vRect.top
      lastPointerViewport = { x: localX, y: localY }

      if (radialState.phase !== "closed") {
        trackRadialPointer(localX, localY)
        return
      }
      if (variationGrid && focusedGridTile === null) {
        hoveredGroundSample = null
        hoveredObjectId = null
        const layout = computeVariationGridLayout(variationGrid.tiles.length, vRect.width, vRect.height, variationGrid.cols)
        const hit = pickVariationGridTileAt(layout, localX, localY)
        const nextTile = hit?.tileNumber ?? null
        if (nextTile !== hoveredGridTile) {
          hoveredGridTile = nextTile
          syncVariationGridOverlay()
        }
        const tile = nextTile ? variationGrid.tiles[nextTile - 1] : null
        viewportCursor.update({
          state: tile ? "hover" : "default",
          x: localX,
          y: localY,
          label: tile ? `${nextTile} · ${tile.label}` : undefined,
        })
        return
      }
      const [u, v] = canvasUV(event)
      const sec = activeSection()
      const groundFn = sec.groundHeight ?? (spawn && ["effects", "lighting", "physics"].includes(sec.id) ? spawn.section.groundHeight : undefined) ?? (() => 0)

      if (activeTransform) {
        hoveredGroundSample = null
        if (activeTransform.mode === "move") {
          const hit = stage.pickGround(u, v, groundFn)
          if (hit) {
            activeTransform.currentX = snapGroundCoord(hit.x, event.altKey)
            activeTransform.currentZ = snapGroundCoord(hit.z, event.altKey)
            applyActiveTransformToWorld(activeTransform)
            viewportCursor.update({
              state: "move",
              x: localX,
              y: localY,
            })
            panel.sync()
            syncChrome()
            void renderNow()
          }
        } else {
          const pivotY = groundFn(activeTransform.currentX, activeTransform.currentZ) + 0.03
          const hit = stage.pickPlaneY(u, v, pivotY) ?? stage.pickGround(u, v, groundFn)
          if (hit) {
            activeTransform.currentYaw = computePointerYawRad(
              activeTransform.currentX,
              activeTransform.currentZ,
              hit.x,
              hit.z,
              event.shiftKey,
              event.altKey,
            )
            applyActiveTransformToWorld(activeTransform)
            viewportCursor.update({
              state: "rotate",
              x: localX,
              y: localY,
            })
            panel.sync()
            syncChrome()
            void renderNow()
          }
        }
        return
      }

      const ghost = spawn?.getGhost()
      if (ghost && globalSettings.section === "spawn") {
        hoveredGroundSample = null
        const hit = stage.pickGround(u, v, groundFn)
        if (hit) {
          const gx = snapGroundCoord(hit.x, event.altKey)
          const gz = snapGroundCoord(hit.z, event.altKey)
          const isValid = spawn!.isValidYardPoint(gx, gz)
          const gs = sampleGroundNormal(gx, gz, groundFn)
          spawn!.setGhost({
            ...ghost,
            x: gx,
            y: gs.y,
            z: gz,
            valid: isValid,
          })
          viewportCursor.update({
            state: isValid ? "place" : "disabled",
            x: localX,
            y: localY,
            normal: { nx: gs.nx, ny: gs.ny, nz: gs.nz },
          })
          syncChrome()
          void renderNow()
        } else {
          viewportCursor.update({ state: "disabled", x: localX, y: localY })
        }
        return
      }

      if (hoveredGizmoHandle) {
        viewportCursor.update({ state: hoveredGizmoHandle, x: localX, y: localY })
        return
      }

      const picked = pickObjectAt(u, v)
      const nextHover = picked?.id ?? null
      if (picked) {
        hoveredGroundSample = null
        viewportCursor.update({ state: "hover", x: localX, y: localY, label: picked.label })
      } else {
        const hit = stage.pickGround(u, v, groundFn)
        if (!hit || (sec.id === "spawn" && spawn && !spawn.isValidYardPoint(hit.x, hit.z))) {
          hoveredGroundSample = null
          viewportCursor.update({ state: "disabled", x: localX, y: localY })
        } else {
          hoveredGroundSample = sampleGroundNormal(hit.x, hit.z, groundFn)
          viewportCursor.update({
            state: boxSelectMode ? "marquee" : "default",
            x: localX,
            y: localY,
            normal: {
              nx: hoveredGroundSample.nx,
              ny: hoveredGroundSample.ny,
              nz: hoveredGroundSample.nz,
            },
          })
        }
      }
      if (nextHover !== hoveredObjectId) {
        hoveredObjectId = nextHover
        syncChrome()
        void renderNow()
      } else if (hoveredGroundSample) {
        syncStageMarkers()
        void renderNow()
      }
    },
    marquee: {
      shouldMarquee: event => {
        if (spawn?.getGhost() || activeTransform || (variationGrid && focusedGridTile === null)) return false
        if (event.shiftKey && !event.altKey && !boxSelectMode) return false
        if (event.altKey || boxSelectMode) return true
        if (!hasBoxSelectableObjects()) return false
        const [u, v] = canvasUV(event)
        return pickObjectAt(u, v) === null
      },
      onMove: (startX, startY, currentX, currentY) => {
        hoveredGroundSample = null
        const rect = canvas.getBoundingClientRect()
        const vRect = viewportEl.getBoundingClientRect()
        const mRect = normalizeMarqueeRect(
          startX - rect.left,
          startY - rect.top,
          currentX - rect.left,
          currentY - rect.top,
          rect.width,
          rect.height,
        )
        marqueeEl.hidden = false
        marqueeEl.style.left = `${mRect.left}px`
        marqueeEl.style.top = `${mRect.top}px`
        marqueeEl.style.width = `${mRect.width}px`
        marqueeEl.style.height = `${mRect.height}px`
        const hits = pickObjectsInMarquee(allSceneObjects().filter(o => !lockedIds.has(o.id)), (x, y, z) => stage.projectWorld(x, y, z), mRect)
        marqueeEl.textContent = hits.length ? `${hits.length}` : ""
        viewportCursor.update({ state: "marquee", x: currentX - vRect.left, y: currentY - vRect.top })
        syncStageMarkers()
      },
      onEnd: (startX, startY, endX, endY, event) => {
        marqueeEl.hidden = true
        const rect = canvas.getBoundingClientRect()
        const mRect = normalizeMarqueeRect(
          startX - rect.left,
          startY - rect.top,
          endX - rect.left,
          endY - rect.top,
          rect.width,
          rect.height,
        )
        const hits = pickObjectsInMarquee(allSceneObjects().filter(o => !lockedIds.has(o.id)), (x, y, z) => stage.projectWorld(x, y, z), mRect)
        if (hits.length > 0) {
          const hasSpawnHits = Boolean(spawn && hits.some(h => spawn.section.objects?.().some(o => o.id === h.id)))
          if (hasSpawnHits && globalSettings.section !== "spawn") {
            selectSection("spawn")
          }
          const targetSec = activeSection()
          const next = applyMarqueeSelection(currentSelectedIds(), hits.map(h => h.id), event.shiftKey)
          if (targetSec.selectObjects) {
            targetSec.selectObjects(next.ids)
          } else if (next.primaryId) {
            targetSec.selectObject?.(next.primaryId)
          }
          showToast(`Selected ${next.ids.length} object${next.ids.length === 1 ? "" : "s"}`)
        } else if (!event.shiftKey) {
          selectWorldObject(null, false)
        }
        panel.sync()
        syncChrome()
        void renderNow()
      },
      onCancel: () => {
        marqueeEl.hidden = true
      },
    },
    onPrimaryClick: event => {
      marqueeEl.hidden = true
      if (mode === "play") return
      if (variationGrid && focusedGridTile === null) {
        const vRect = viewportEl.getBoundingClientRect()
        const layout = computeVariationGridLayout(variationGrid.tiles.length, vRect.width, vRect.height, variationGrid.cols)
        const hit = pickVariationGridTileAt(layout, event.clientX - vRect.left, event.clientY - vRect.top)
        if (hit) {
          focusVariationTile(hit.tileNumber)
          return
        }
      }
      const [u, v] = canvasUV(event)
      const ghost = spawn?.getGhost()
      if (ghost && globalSettings.section === "spawn") {
        const before = captureSnapshot()
        if (spawn!.commitGhost()) {
          recordHistory(`Place ${ghost.kind}`, before)
          if (!event.shiftKey) spawn!.setGhost(null)
          panel.sync()
          syncChrome()
          void renderNow()
        }
        return
      }
      if (activeTransform) {
        commitActiveTransform()
        return
      }
      const picked = pickObjectAt(u, v)
      selectWorldObject(picked, event.shiftKey)
    },
    onContextClick: (x, y) => {
      if (mode === "play") return
      openRadialAtScreen(x, y, true)
    },
    wheelOptions: () => ({
      pinchZoom: true,
      twoFingerScroll: getTwoFingerScrollMode(),
    }),
    onChange: () => {
      syncStageMarkers()
      void renderNow()
    },
  })

  onKeyLayoutChange(() => syncTransportAndHints())

  // Global Workbench Keyboard Controller
  window.addEventListener("keydown", event => {
    observeKeyLayout(event)
    const target = event.composedPath()[0]
    const inText =
      (target instanceof HTMLInputElement && (target.type === "text" || target.type === "search" || target.type === "number")) ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    const inSelect = target instanceof HTMLSelectElement

    const key = event.key.toLowerCase()
    const cmd = event.metaKey || event.ctrlKey
    const isPlayShortcut = !cmd && (key === "p" || (event.altKey && (key === "π" || event.code === "KeyP")))

    // Modal Escape
    if (!modalBackdrop.hidden) {
      if (event.key === "Escape") {
        event.preventDefault()
        closePresetModal()
      }
      return
    }

    // Cmd/Ctrl-K opens universal search (scene objects, library, commands, settings) from anywhere
    if (cmd && key === "k") {
      event.preventDefault()
      if (palette.isOpen) palette.close()
      else commands.execute("palette.open", { pickedObject: null, groundHit: null, source: "ui" })
      return
    }

    // Ctrl+Space toggles the Library drawer (layout-independent: physical Space key)
    if (event.ctrlKey && !event.metaKey && event.code === "Space") {
      event.preventDefault()
      if (!event.repeat) commands.execute("library.toggle", { pickedObject: null, groundHit: null, source: "ui" })
      return
    }

    if (palette.isOpen) return

    // Undo / Redo in Edit mode outside text inputs
    if (cmd && key === "z" && !inText && mode === "edit") {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }

    // Never swallow other browser shortcuts (Cmd-R, Cmd-L, Cmd-W, etc.)
    if (cmd && key !== "d") return

    if (inText) return

    // Level 2: Open Radial Menu owns 1-8, accelerators, arrows, Enter, and Escape
    if (radialState.phase !== "closed") {
      const res = radialState.handleKey(event.key)
      if (res) {
        event.preventDefault()
        radialDOM.sync()
        if (res.outcome !== "navigate") {
          handleRadialResult(res)
        }
      }
      return
    }

    // Play Mode: Escape exits Play and restores pre-Play checkpoint; F8 toggles Eject camera
    if (mode === "play") {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopImmediatePropagation()
        setPlayMode("edit")
      } else if (event.key === "F8" && !event.repeat) {
        event.preventDefault()
        event.stopImmediatePropagation()
        toggleEject()
      } else if (ejected && isPlayShortcut && !event.repeat) {
        event.preventDefault()
        event.stopImmediatePropagation()
        toggleEject()
      } else if (ejected && key === "f" && !event.repeat) {
        event.preventDefault()
        frameActiveTarget()
      }
      return
    }

    // Play (P / Alt+P) and Eject (F8) work from anywhere in Edit mode outside text inputs (including Details, Outliner, Library, and <select> dropdowns)
    if (isPlayShortcut && !event.repeat) {
      event.preventDefault()
      if (inSelect) (target as HTMLElement).blur()
      setPlayMode("play")
      return
    }
    if (event.key === "F8" && !event.repeat) {
      event.preventDefault()
      if (inSelect) (target as HTMLElement).blur()
      toggleEject()
      return
    }
    if (inSelect) {
      if (event.key === "Escape") {
        event.preventDefault()
        ;(target as HTMLElement).blur()
        canvas.focus({ preventScroll: true })
      }
      return
    }

    // If focus is inside the Inspector (LabPanel), let LabPanel's own capture handler own the remaining keys
    if (document.activeElement === panel.host) return

    // Active Placement Ghost or Move Ghost modal controls
    const ghost = spawn?.getGhost()
    if (ghost && globalSettings.section === "spawn") {
      const step = event.shiftKey ? 2 : event.altKey ? 0.1 : 0.5
      if (event.key === "Escape") {
        event.preventDefault()
        spawn!.setGhost(null)
        syncChrome()
        void renderNow()
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        const before = captureSnapshot()
        if (spawn!.commitGhost()) {
          recordHistory(`Place ${ghost.kind}`, before)
          if (!event.shiftKey) spawn!.setGhost(null)
          panel.sync()
          syncChrome()
          void renderNow()
        }
        return
      }
      if (event.key === "[" || event.key === "]") {
        event.preventDefault()
        const deg = (event.shiftKey ? 1 : 15) * (event.key === "]" ? 1 : -1)
        spawn!.setGhost({ ...ghost, yaw: ghost.yaw + (deg * Math.PI) / 180 })
        syncChrome()
        void renderNow()
        return
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault()
        const nx = ghost.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0)
        const nz = ghost.z + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0)
        spawn!.setGhost({ ...ghost, x: nx, y: yardGround(nx, nz), z: nz, valid: spawn!.isValidYardPoint(nx, nz) })
        syncChrome()
        void renderNow()
        return
      }
    }

    if (activeTransform) {
      const step = event.shiftKey ? 2 : event.altKey ? 0.1 : 0.5
      if (event.key === "Escape") {
        event.preventDefault()
        restoreTransformToOrig(activeTransform)
        activeTransform = null
        panel.sync()
        syncChrome()
        void renderNow()
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        commitActiveTransform()
        return
      }
      if (key === "r" && activeTransform.mode === "move") {
        event.preventDefault()
        activeTransform.mode = "rotate"
        activeTransform.numericAxis = "yaw"
        activeTransform.numericBuffer = ""
        syncChrome()
        return
      }
      if (key === "g" && activeTransform.mode === "rotate") {
        event.preventDefault()
        activeTransform.mode = "move"
        activeTransform.numericAxis = "x"
        activeTransform.numericBuffer = ""
        syncChrome()
        return
      }
      if (event.key === "[" || event.key === "]") {
        event.preventDefault()
        const deg = (event.shiftKey ? 1 : 15) * (event.key === "]" ? 1 : -1)
        activeTransform.currentYaw += (deg * Math.PI) / 180
        applyActiveTransformToWorld(activeTransform)
        panel.sync()
        syncChrome()
        void renderNow()
        return
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault()
        if (activeTransform.mode === "rotate") {
          const deg = (event.shiftKey ? 15 : event.altKey ? 1 : 5) * (event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1)
          activeTransform.currentYaw += (deg * Math.PI) / 180
        } else {
          const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0
          const dz = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0
          activeTransform.currentX += dx
          activeTransform.currentZ += dz
        }
        applyActiveTransformToWorld(activeTransform)
        panel.sync()
        syncChrome()
        void renderNow()
        return
      }
      const numRes = applyNumericTransformKey(activeTransform, event.key)
      if (numRes.handled) {
        event.preventDefault()
        if (numRes.updated) {
          applyActiveTransformToWorld(activeTransform)
          panel.sync()
          void renderNow()
        }
        syncChrome()
        return
      }
    }

    // Edit Mode Canvas / Library Shortcuts
    const sec = activeSection()
    if (variationGrid && !event.repeat && !cmd && !event.altKey) {
      if (/^[1-9]$/.test(event.key)) {
        const n = Number(event.key)
        if (n >= 1 && n <= variationGrid.tiles.length) {
          event.preventDefault()
          focusVariationTile(focusedGridTile === n ? null : n)
          return
        }
      }
      if (event.key === "Escape" || key === "g") {
        event.preventDefault()
        if (focusedGridTile !== null) {
          focusVariationTile(null)
        } else {
          closeVariationGrid()
        }
        return
      }
    }
    if (event.key === "Escape" && !event.repeat) {
      if (viewportGestures?.hasActivePointer()) {
        event.preventDefault()
        viewportGestures.cancelDrag()
        syncChrome()
        void renderNow()
        return
      }
      if (boxSelectMode) {
        event.preventDefault()
        boxSelectMode = false
        syncChrome()
        return
      }
      if (currentSelectedIds().length > 0) {
        event.preventDefault()
        selectWorldObject(null, false)
        return
      }
    } else if (document.activeElement === canvas && applyArrowCameraKey(stage, event, true)) {
      event.preventDefault()
      syncStageMarkers()
      void renderNow()
      return
    }
    if (event.key === "/") {
      event.preventDefault()
      palette.open()
    } else if (event.key === "Tab" && event.shiftKey && document.activeElement === canvas) {
      event.preventDefault()
      outliner.focus()
    } else if (event.key === "Tab" && document.activeElement === canvas) {
      event.preventDefault()
      panel.setReturnFocus(canvas)
      focusZone = "inspector"
      panel.focusFirst()
      syncTransportAndHints()
    } else if (event.key === " " && !event.repeat && document.activeElement === canvas) {
      event.preventDefault()
      elapsed = 0
      frames = 0
      sec.retrigger?.()
      if (variationGrid && sec.id === "effects" && effects) {
        effects.resetVariantSlots(variationGrid.tiles)
      }
      panel.sync()
      syncChrome()
      void renderNow()
    } else if (key === "k" && !event.repeat) {
      event.preventDefault()
      playPauseBtn.click()
    } else if (event.key === "." && !event.repeat) {
      event.preventDefault()
      const count = event.shiftKey ? 5 : 1
      for (let i = 0; i < count; i++) stepBtn.click()
    } else if (event.key === "," && !event.repeat && sec.id !== "spawn" && "playing" in sec.settings && !sec.settings.playing) {
      event.preventDefault()
      const targetFrames = Math.max(0, frames - (event.shiftKey ? 5 : 1))
      sec.retrigger?.()
      stepSimulationDeterministic(targetFrames)
      panel.sync()
      syncChrome()
      void renderNow()
    } else if (key === "b" && !event.repeat) {
      event.preventDefault()
      pinBaselineSlotA()
    } else if (key === "v" && !event.repeat) {
      event.preventDefault()
      if (event.shiftKey) toggleCompareWipe()
      else flipCompareSlot()
    } else if (key === "p" && !event.repeat) {
      event.preventDefault()
      setPlayMode("play")
    } else if (event.key === "ContextMenu" && !event.repeat) {
      // M is the Lab's mute key (docs/controls.md); the radial opens from RMB tap, Ctrl+click or the menu key.
      event.preventDefault()
      openRadialFromKeyboard()
    } else if (key === "i" && !event.repeat) {
      event.preventDefault()
      commands.execute("object.inspect")
    } else if (key === "f" && !event.repeat) {
      event.preventDefault()
      frameActiveTarget()
    } else if (key === "r" && !event.repeat) {
      if ((event.shiftKey || (sec.id === "spawn" && currentSelectedObjects().some(o => o.movable))) && commands.get("object.rotate")?.enabled()) {
        event.preventDefault()
        commands.execute("object.rotate")
      } else {
        event.preventDefault()
        if (sec.reroll) {
          const before = captureSnapshot()
          sec.reroll()
          recordHistory("Reroll room seed", before)
          panel.sync()
          syncChrome()
          void renderNow()
        }
      }
    } else if ((key === "q" || key === "e") && !event.repeat && !input.enabled) {
      event.preventDefault()
      const primaryCtrl = sec.controls.find(c => (c.key === "effect" || c.key === "preset" || c.key === "material" || c.key === "item" || c.key === "source") && "options" in c)
      if (primaryCtrl && "options" in primaryCtrl && primaryCtrl.options.length > 0) {
        const cur = sec.settings[primaryCtrl.key]
        const idx = primaryCtrl.options.findIndex(o => o.value === cur)
        const dir = key === "e" ? 1 : -1
        const nextOpt = primaryCtrl.options[(idx + dir + primaryCtrl.options.length) % primaryCtrl.options.length]!
        const before = captureSnapshot()
        panel.navigation.set(primaryCtrl, nextOpt.value)
        if (!isBench) sec.retrigger?.()
        recordHistory(`Select ${nextOpt.label}`, before)
        panel.sync()
        syncChrome()
        void renderNow()
      }
    } else if (key === "a" && !event.repeat) {
      event.preventDefault()
      libraryDrawer.setCategory("objects")
      if (globalSettings.section !== "spawn" && spawn) selectSection("spawn")
      if (spawn) {
        const item = String(spawn.section.settings.item || "cone")
        spawn.setGhost({ category: "prop", kind: item, x: 0, y: yardGround(0, 2), z: 2, yaw: 0, shape: "one", valid: true })
      }
      syncChrome()
      void renderNow()
    } else if (key === "g" && !event.repeat) {
      if (commands.get("object.move")?.enabled()) {
        event.preventDefault()
        commands.execute("object.move")
      }
    } else if ((event.key === "Delete" || event.key === "Backspace") && !event.repeat) {
      if (commands.get("object.delete")?.enabled()) {
        event.preventDefault()
        commands.execute("object.delete")
      }
    } else if ((cmd && key === "d" || (!cmd && key === "d")) && !event.repeat) {
      if (commands.get("object.duplicate")?.enabled()) {
        event.preventDefault()
        commands.execute("object.duplicate")
      }
    } else if (/^[1-7]$/.test(event.key) && !event.repeat) {
      event.preventDefault()
      libraryDrawer.setCategory(LIBRARY_CATEGORIES[Number(event.key) - 1]!.id, true)
    }
  })

  return {
    get mode() {
      return mode
    },
    get speed() {
      return simSpeed
    },
    /** Whether the multi-tile variation grid is open (it owns 1–9, G and Esc). */
    get variationGridOpen() {
      return variationGrid !== null
    },
    /** A section the host loaded after start-up (a game's adapters fetched on demand). */
    addSection(section: LabSection) {
      if (!defaultsBySection.has(section.id)) defaultsBySection.set(section.id, { ...section.settings } as LabSettings)
      section.registerCommands?.(commands)
    },
    onTick(dt: number) {
      stage.stepCamera(dt)
      const sec = activeSection()
      const playing = "playing" in sec.settings ? Boolean(sec.settings.playing) : true
      if (playing) {
        elapsed += dt * simSpeed
        frames += 1
        timeReadout.textContent = `${elapsed.toFixed(2)}s · f${frames}`
      }
      syncStageMarkers()
      if (chromeReady) watchList.render(watchPins)
    },
    onSectionChanged() {
      elapsed = 0
      frames = 0
      hoveredObjectId = null
      activeTransform = null
      if (variationGrid && globalSettings.section !== variationGrid.section) {
        variationGrid = null
        focusedGridTile = null
        hoveredGridTile = null
        variationGridCostMs = null
      }
      if (mode === "play" && globalSettings.section !== "spawn") {
        setPlayMode("edit")
      }
      panel.setReturnFocus(canvas)
      detailsViewSig = ""
      syncChrome()
    },
    onPanelTransaction(label: string, beforeSettings: LabSettings) {
      // Capture "before" by briefly writing the old values through the live settings, so settings aliased by
      // several sections (for example Spawn skidWidth and Getaway effects skids.width) snapshot consistently.
      const live = panel.navigation.settings
      const afterValues: LabSettings = {}
      for (const k of Object.keys(beforeSettings)) if (k in live) afterValues[k] = live[k]!
      for (const [k, v] of Object.entries(beforeSettings)) if (k in live) live[k] = v
      const beforeSnap = captureSnapshot()
      for (const [k, v] of Object.entries(afterValues)) live[k] = v
      const afterSnap = captureSnapshot()
      if (JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap)) {
        undoStack.push({ label, before: beforeSnap, after: afterSnap })
        if (undoStack.length > 50) undoStack.shift()
        redoStack.length = 0
      }
      const sec = activeSection()
      const isPaused = "playing" in sec.settings && !sec.settings.playing
      const changedKeys = Object.keys(beforeSettings).filter(k => beforeSettings[k] !== sec.settings[k])
      const nonTransportKeys = changedKeys.filter(k => !["playing", "loop", "interval", "tuningSeed"].includes(k))
      const isRandomizeOrReset = /^Randomize\b|^Reset\b/i.test(label)
      const isOneShotEffect =
        (sec.id === "effects" && ["explosion", "sparks", "debris", "tyre"].includes(String(sec.settings.effect))) ||
        (sec.id === "fire-water" && ["explosion", "fireball"].includes(String(sec.settings.effect))) ||
        sec.id === "splatter"
      const needsRetrigger =
        isOneShotEffect ||
        (isRandomizeOrReset && sec.id === "effects" && (!isPaused || nonTransportKeys.some(k => {
          const ctrl = sec.controls.find(c => c.key === k)
          return Boolean(ctrl?.unit?.includes("retrigger"))
        }))) ||
        sec.id !== "effects" ||
        sec.settings.effect !== "smoke" ||
        nonTransportKeys.some(k => {
          const ctrl = sec.controls.find(c => c.key === k)
          return Boolean(ctrl?.unit?.includes("retrigger") || ["effect", "targetX", "targetZ", "seed"].includes(k))
        })
      if (isPaused && frames > 0 && needsRetrigger && nonTransportKeys.length > 0) {
        resimulateFrozenFrame()
      } else if (
        !isBench &&
        nonTransportKeys.length > 0 &&
        (sec.id === "blackout-effects" ||
          sec.id === "getaway-effects" ||
          isOneShotEffect ||
          (sec.id === "effects" && (isRandomizeOrReset || needsRetrigger)))
      ) {
        elapsed = 0
        frames = 0
        sec.retrigger?.()
      }
      if (slotA && activeSlot === "B") {
        slotB = { snapshot: captureSnapshot(), frames, elapsed }
      }
      if (compareWipeEnabled && slotA) {
        void captureSlotAToWipeCanvas()
      } else {
        syncChrome()
        void renderNow()
      }
    },
    onPanelFocusChange(focused: boolean) {
      if (focused) {
        if (mode === "play") setPlayMode("edit")
        focusZone = "inspector"
      } else if (document.activeElement === canvas) {
        focusZone = "canvas"
      }
      syncTransportAndHints()
    },
    onPanelToggle(visible: boolean) {
      root.dataset.closed = String(!visible)
      syncStageMarkers()
    },
    sectionDefaults: (id: string) => defaultsBySection.get(id),
    togglePin: (control: LabControl, _group: string) => {
      pinSetting(globalSettings.section, control.key)
    },
    isPinned: (key: string) => watchPins.some(p => p.sectionId === globalSettings.section && p.key === key),
    setTelemetry(text: string) {
      if (text === telemetryText) return
      telemetryText = text
      statsReadout.textContent = text.replace(/\n/g, " · ")
    },
    outliner,
    library: libraryDrawer,
    palette,
    watch: {
      get pins() {
        return [...watchPins]
      },
      el: watchList.el,
    },
    revealSetting,
    recordHistory,
    captureSnapshot,
    undo,
    redo,
    applyPresetJson,
    exportPresetJson: () => JSON.stringify(buildPresetPayload(), null, 2),
    exportGameRecipe: buildCurrentGameRecipe,
    applyGameRecipe: (raw: unknown) => {
      const sec = activeSection()
      const res = applyGameRecipe(raw, {
        lighting: stage.lighting,
        sectionSettings: sec.settings,
      })
      if (res.ok) {
        const isPaused = "playing" in sec.settings && !sec.settings.playing
        if (isPaused && frames > 0) resimulateFrozenFrame()
        else sec.retrigger?.()
        panel.sync()
        syncChrome()
        void renderNow()
      }
      return res
    },
    compare: {
      pinA: pinBaselineSlotA,
      flip: flipCompareSlot,
      toggleWipe: toggleCompareWipe,
      get activeSlot() {
        return activeSlot
      },
      get wipeEnabled() {
        return compareWipeEnabled
      },
      get frames() {
        return frames
      },
      get diffs() {
        return slotA ? computeSnapshotDiffs(slotA.snapshot, slotB?.snapshot ?? captureSnapshot()) : []
      },
    },
    setPlayMode,
    toggleEject,
    get ejected() {
      return ejected
    },
    isVariationGridMultiView: () => Boolean(variationGrid && focusedGridTile === null),
    renderVariationGrid,
    advanceVariationGridSim,
    get variationGridCostMs() {
      return variationGridCostMs
    },
    grid: {
      open: openVariationGrid,
      focus: focusVariationTile,
      close: closeVariationGrid,
      get active() {
        return Boolean(variationGrid)
      },
      get focusedTile() {
        return focusedGridTile
      },
      get config() {
        return variationGrid
      },
    },
    frameActiveTarget,
    syncChrome,
    commands,
    state: () => commands.state()!,
    invoke: (id: string, args?: Record<string, unknown>, ctx?: LabCommandContext) => commands.invoke(id, args, ctx),
    getSelectedIds: currentSelectedIds,
    setBoxSelectMode: (enabled: boolean) => {
      boxSelectMode = enabled
      syncChrome()
    },
    transform: {
      get active() {
        return activeTransform
      },
      start: (tMode: TransformMode) => startTransformSelection(tMode),
      commit: commitActiveTransform,
    },
    cursor: {
      get state() {
        return viewportCursor.el.dataset.cursorState ?? "hidden"
      },
      get labelVisible() {
        return viewportCursor.tag.dataset.visible === "true" && !viewportCursor.tag.hidden
      },
      get groundSample() {
        return hoveredGroundSample
      },
      update: viewportCursor.update,
    },
    radial: {
      state: radialState,
      openAtScreen: openRadialAtScreen,
      openForObject: openRadialFromKeyboard,
      close: () => {
        radialState.close()
        radialDOM.sync()
      },
    },
  }
}
