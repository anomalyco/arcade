import { formatLabValue, inferControlUnit, LabPanel, type LabControl, type LabSettings, type LabValue } from "../lab-panel"
import { LabToolbar } from "../lab-knobs"
import {
  findControlRow,
  formatControlValue,
  registerDevControl,
  registerStageCameraCommands,
} from "../dev-control"
import { LabCommandRegistry, type LabCommandContext, type LabSceneState } from "./commands"
import { computeSnapshotDiffs, createCompareWipeDOM } from "./compare-ab"
import {
  computeVariationGridLayout,
  createVariationGridDOM,
  pickVariationGridTileAt,
  resolveVariationGridConfig,
  summarizeTileSettings,
  type VariationGridConfig,
  type VariationTileConfig,
} from "./variation-grid"
import { LOOK_PRESETS, resolveLookPresetId } from "../gpu/look"
import { createRadialMenuDOM, RadialMenuStateMachine, type RadialReleaseResult } from "./radial"
import { applyGameRecipe, buildGameRecipe, type GameRecipePayload } from "./recipe"
import {
  applyClickSelection,
  applyMarqueeSelection,
  computeSelectionCentroid,
  normalizeMarqueeRect,
  pickObjectsInMarquee,
} from "./selection"
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
import type { LabSection, LabWorldObject } from "./types"
import { createLibrary, isLibraryAsset, isPlaceable, LIBRARY_CATEGORIES, libraryCategoryOf, sectionLibraryCategory, type LibraryView } from "./library"
import { captureThumb, createThumbCache, thumbStats } from "./library-thumbs"
import { createPanels, PANEL_IDS, PANELS_CHANGE_EVENT, type PanelId, type Panels } from "./panels"
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
import { buildWorkbenchCatalog } from "./workbench-catalog"
import { registerWorkbenchCommands } from "./workbench-commands"
import { applyTileSettingsToSection as applyGridTileToSection, drawVariationGridOverlayToCanvas as drawGridOverlayToCanvas, renderVariationGridPass } from "./workbench-grid"
import { applyWorkbenchPresetJson, buildWorkbenchPresetPayload } from "./workbench-presets"
import type {
  CatalogCategory,
  CatalogCollection,
  CatalogEntry,
  FullSnapshot,
  HistoryEntry,
  LabPresetSchema,
  WorkbenchOptions,
} from "./workbench-types"
import { yardGround } from "./yard"

export type {
  CatalogCategory,
  CatalogCollection,
  CatalogEntry,
  LabPresetSchema,
  WorkbenchOptions,
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
  /** Number keys go here first (stations); the Library categories get them otherwise. */
  let digitHandler: ((n: number, shift: boolean) => boolean) | null = null
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
  // The Details actions are a knobs toolbar; its chips are the canvas keys, and they press it while it has focus.
  const detailsToolbar = new LabToolbar(inspectorEl.querySelector<HTMLElement>("[data-details-actions]")!, "Actions", id => {
    const res = commands.invoke(id, undefined, { source: "ui" })
    if (!res.ok) showToast(res.error, true)
    syncChrome()
  })
  const detailsAllBtn = inspectorEl.querySelector<HTMLButtonElement>('[data-action="details-all"]')!
  /** Approved defaults captured before any fixture or user edit; drive Reset and modified highlighting. */
  const defaultsBySection = new Map(sections.map(s => [s.id, { ...s.settings } as LabSettings]))
  const lockedIds = new Set<string>()
  let watchPins: WatchPin[] = loadWatchPins()
  let detailsShowAll = false
  let detailsViewSig = ""
  let detailsRelevant: Set<string> | null = null
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
    applyGridTileToSection(sec, tile, stage)
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
      try {
        const dtMs = await renderVariationGridPass({
          config: variationGrid,
          sec: activeSection(),
          stage,
          context,
          spawn,
          effects,
          width,
          height,
          debug,
        })
        variationGridCostMs = variationGridCostMs === null ? dtMs : variationGridCostMs * 0.8 + dtMs * 0.2
        syncVariationGridOverlay()
        return variationGridCostMs
      } finally {
        if (variationGrid && focusedGridTile !== null && focusedGridTile >= 1 && focusedGridTile <= variationGrid.tiles.length) {
          applyTileSettingsToSection(activeSection(), variationGrid.tiles[focusedGridTile - 1]!)
        }
        activeGridRender = null
      }
    })()
    activeGridRender = run
    return run
  }

  function drawVariationGridOverlayToCanvas(target: HTMLCanvasElement) {
    drawGridOverlayToCanvas(target, variationGrid, focusedGridTile)
  }

  // Who follows whether Undo and Redo can run (knobs' header buttons); told only when that changes.
  const historyListeners = new Set<() => void>()
  let historyShown = ""
  function notifyHistory() {
    const now = `${undoStack.length > 0}${redoStack.length > 0}`
    if (now === historyShown) return
    historyShown = now
    for (const listener of historyListeners) listener()
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
    notifyHistory()
    return true
  }

  function redo(): boolean {
    const entry = redoStack.pop()
    if (!entry) return false
    undoStack.push(entry)
    restoreSnapshot(entry.after)
    showToast(`Redid ${entry.label}`)
    notifyHistory()
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

  registerWorkbenchCommands(commands, {
    root,
    canvas,
    panel,
    context,
    stage,
    sections,
    globalSettings,
    spawn,
    looks,
    effects,
    playPauseBtn,
    stepBtn,
    speedSelect,
    activeSection,
    resolveEnvOwner,
    selectSection,
    getMode: () => mode,
    setPlayMode,
    getEjected: () => ejected,
    toggleEject,
    getSimSpeed: () => simSpeed,
    setSimSpeed: s => { simSpeed = s },
    getElapsed: () => elapsed,
    getFrames: () => frames,
    resetClock: () => { elapsed = 0; frames = 0 },
    setActiveCatalogId: id => { activeCatalogId = id },
    setFocusZone: z => { focusZone = z },
    activeTargetObject,
    resolveObjectOwner,
    allSceneObjects,
    currentSelectedIds,
    currentSelectedObjects,
    selectWorldObject,
    setSelectionIds,
    setSelectingFromOutliner: v => { selectingFromOutliner = v },
    startTransformSelection,
    frameActiveTarget,
    captureSnapshot,
    recordHistory,
    undoStack,
    redoStack,
    undo,
    redo,
    buildPresetPayload,
    applyPresetJson,
    openPresetModal,
    openRecipeModal,
    pinBaselineSlotA,
    flipCompareSlot,
    toggleCompareWipe,
    getVariationGrid: () => variationGrid,
    getFocusedGridTile: () => focusedGridTile,
    getVariationGridCostMs: () => variationGridCostMs,
    openVariationGrid,
    focusVariationTile,
    closeVariationGrid,
    resimulateFrozenFrame,
    buildCatalog,
    groundFnFor,
    placeLibraryEntry,
    lockedIds,
    getOutliner: () => outliner,
    getLibraryDrawer: () => libraryDrawer,
    getPalette: () => palette,
    getWatchPins: () => watchPins,
    setWatchPins,
    pinSetting,
    getDetailsFilterState: () => ({ query: panel.search.query, modifiedOnly: panel.search.modified, showAll: detailsShowAll }),
    setDetailsFilterState: patch => {
      panel.setSearch({ query: patch.query, modified: patch.modifiedOnly })
      if (patch.showAll !== undefined) detailsShowAll = patch.showAll
    },
    applyDetailsView,
    syncDetails,
    revealSetting,
    syncTransportAndHints,
    syncChrome,
    renderNow,
    showToast,
  })

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
            library: { open: libraryDrawer.open, category: libraryDrawer.category, query: libraryDrawer.query, view: libraryDrawer.view, focused: libraryDrawer.focused, cursor: libraryDrawer.cursor, previews: thumbs.size, readback: { ...thumbStats } },
            panels: panels.state(),
            locked: [...lockedIds],
            details: { query: panel.search.query, modifiedOnly: panel.search.modified, showAll: detailsShowAll, tab: panel.tab ?? null, modified: panel.modifiedControls().map(c => c.key) },
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
    return buildWorkbenchCatalog({
      sections,
      globalSettings,
      activeSection,
      selectSection,
      stage,
      panel,
      spawn,
      looks,
      isBench,
      getActiveCatalogId: () => activeCatalogId,
      setActiveCatalogId: id => { activeCatalogId = id },
      frameActiveTarget,
      captureSnapshot,
      recordHistory,
      renderNow,
      showToast,
    })
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

    notifyHistory()
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
    return buildWorkbenchPresetPayload({ activeSection, stage, spawn })
  }

  function applyPresetJson(rawText: string): { ok: true } | { ok: false; error: string } {
    return applyWorkbenchPresetJson(rawText, {
      sections,
      globalSettings,
      activeSection,
      selectSection,
      stage,
      panel,
      spawn,
      looks,
      captureSnapshot,
      recordHistory,
      syncChrome,
      renderNow,
      showToast,
    })
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
  const thumbs = createThumbCache()
  /** Scene-level items get a viewport preview; single props, lights, characters and sounds keep their icon. */
  const previewable = (entry: CatalogEntry) => !isPlaceable(entry.id) && libraryCategoryOf(entry) !== "audio"
  let pendingThumb: { id: string; due: number } | null = null
  let previewsRunning = false

  /** After an item runs, its first settled frame becomes its preview, once. */
  function scheduleThumb(entry: CatalogEntry) {
    pendingThumb = previewable(entry) && !thumbs.has(entry.id) ? { id: entry.id, due: performance.now() + 900 } : null
  }

  function maybeCaptureThumb() {
    if (!pendingThumb || previewsRunning || performance.now() < pendingThumb.due) return
    const { id } = pendingThumb
    pendingThumb = null
    const active = buildCatalog().find(e => e.id === id)
    // Only when nothing else covers the scene: no Play, grid, wipe, ghost or open radial.
    if (!active?.isActive?.() || mode !== "edit" || variationGrid || compareWipeEnabled || spawn?.getGhost?.() || radialState.phase !== "closed" || root.dataset.closed === "true") return
    void captureThumb(canvas, t => stage.captureToCanvas(t)).then(url => {
      if (url) thumbs.set(id, url)
    })
  }

  const nextFrame = () => new Promise<void>(done => requestAnimationFrame(() => done()))

  /**
   * Renders a preview for each entry offline: the live loop is paused, each item runs from the same starting
   * scene and is simulated for a fixed 40 ticks, and the scene, camera and active item are restored afterwards.
   */
  async function renderLibraryPreviews(list: CatalogEntry[], progress: (done: number, total: number) => void) {
    if (previewsRunning) return
    previewsRunning = true
    if (mode === "play") setPlayMode("edit")
    const base = captureSnapshot()
    const baseCatalog = activeCatalogId
    const cam = { focus: [...stage.focus], target: [...stage.targetFocus], yaw: stage.camYaw, pitch: stage.camPitch, dist: stage.camDist }
    opts.suspend?.(true)
    try {
      for (const [i, entry] of list.entries()) {
        try {
          restoreSnapshot(base)
          entry.run(false)
          panel.sync()
          for (let t = 0; t < 40; t++) advanceSim(1 / 60)
          await renderNow()
          await nextFrame()
          const url = await captureThumb(canvas, t => stage.captureToCanvas(t))
          if (url) thumbs.set(entry.id, url)
        } catch (err) {
          console.warn(`[library] preview for ${entry.id} failed`, err)
        }
        progress(i + 1, list.length)
      }
    } finally {
      restoreSnapshot(base)
      activeCatalogId = baseCatalog
      stage.frameTarget(cam.target[0]!, cam.target[1]!, cam.target[2]!, cam.dist)
      stage.camYaw = cam.yaw
      stage.camPitch = cam.pitch
      stage.focus.splice(0, 3, ...cam.focus)
      stage.updateCamera()
      opts.suspend?.(false)
      previewsRunning = false
      panel.sync()
      syncChrome()
      void renderNow()
    }
  }

  const libraryDrawer = createLibrary<CatalogEntry>(libraryEl, {
    entries: () => buildCatalog(),
    run: entry => {
      if (mode === "play") setPlayMode("edit")
      entry.run(true)
      scheduleThumb(entry)
      panel.sync()
      syncChrome()
      void renderNow()
    },
    thumbnail: entry => thumbs.get(entry.id),
    previewable,
    renderPreviews: (list, progress) => renderLibraryPreviews(list, progress),
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
      root.dispatchEvent(new Event(PANELS_CHANGE_EVENT))
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
  thumbs.onChange(() => libraryDrawer.render())

  const panels: Panels = createPanels({ root, library: libraryDrawer })
  topbar.querySelector<HTMLButtonElement>('[data-action="panels-reset"]')?.addEventListener("click", () => {
    panels.reset()
    showToast(`Panel sizes reset for ${panels.layoutKey === "workbench" ? "the workbench" : `station ${panels.layoutKey}`}`)
  })
  commands.registerAll([
    {
      id: "library.view",
      label: "Library View",
      shortLabel: "View",
      category: "Navigation",
      args: {
        view: { type: "string", enum: ["tiles", "list"], description: "Tiles with previews, or a compact list" },
        group: { type: "string", description: "Collection to show (omit for all)" },
        focus: { type: "boolean", description: "Move keyboard focus into the item grid" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        if (args?.view === "tiles" || args?.view === "list") libraryDrawer.setView(args.view as LibraryView)
        if (typeof args?.group === "string") libraryDrawer.setGroup(args.group || null)
        if (args?.focus === true) libraryDrawer.focusGrid()
        return { view: libraryDrawer.view, visible: libraryDrawer.visibleIds, cursor: libraryDrawer.cursor }
      },
    },
    {
      id: "library.previews",
      label: "Render Library Previews",
      shortLabel: "Previews",
      category: "Navigation",
      undoable: false,
      args: {
        ids: { type: "string", description: "Comma list of catalog ids (default: previewable items in the current view without one)" },
        clear: { type: "boolean", description: "Forget the stored previews instead (all, or just ids)" },
      },
      enabled: () => !previewsRunning,
      run: async (_ctx, args) => {
        const ids = typeof args?.ids === "string" && args.ids ? args.ids.split(",").map(s => s.trim()) : null
        if (args?.clear === true) {
          thumbs.clear(ids ?? undefined)
          return { previews: thumbs.size }
        }
        const catalog = buildCatalog().filter(isLibraryAsset)
        const list = ids ? catalog.filter(e => ids.includes(e.id)) : catalog.filter(e => libraryDrawer.visibleIds.includes(e.id) && previewable(e) && !thumbs.has(e.id))
        await renderLibraryPreviews(list, () => {})
        return { rendered: list.filter(e => thumbs.has(e.id)).map(e => e.id), missing: list.filter(e => !thumbs.has(e.id)).map(e => e.id), previews: thumbs.size }
      },
    },
    {
      id: "layout.panels",
      label: "Resize Panels",
      shortLabel: "Panels",
      category: "Navigation",
      args: {
        panel: { type: "string", enum: [...PANEL_IDS], description: "left (Outliner), right (Details), drawer (Library), dock, leftSlot, rightSlot" },
        size: { type: "number", description: "Size in CSS pixels (width for left/right, height otherwise)" },
        collapsed: { type: "boolean", description: "Collapse to a thin bar, or expand" },
        reset: { type: "boolean", description: "Back to the default size (one panel, or all when panel is omitted)" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        const id = typeof args?.panel === "string" && (PANEL_IDS as readonly string[]).includes(args.panel) ? (args.panel as PanelId) : null
        if (args?.reset === true) panels.reset(id ?? undefined)
        if (id && typeof args?.size === "number") panels.setSize(id, args.size)
        if (id && typeof args?.collapsed === "boolean") panels.setCollapsed(id, args.collapsed)
        return panels.state()
      },
    },
  ])

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
    panel.setSearch({ query: "", modified: false })
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
    const sig = JSON.stringify([sec.id, relevant ?? null, only ? [...only] : null, panel.navigation.rows.length])
    detailsAllBtn.hidden = !(relevant && selected.length)
    detailsAllBtn.setAttribute("aria-pressed", String(detailsShowAll))
    detailsRelevant = only
    if (!force && sig === detailsViewSig) return
    detailsViewSig = sig
    // Search and Modified are knobs' (the panel's search field); the selection keeps Details to its groups.
    panel.setView({ order: relevant ?? [], filter: only ? row => only.has(row.group) : undefined })
  }

  /** The Details toolbar's keys by the names knobs reads (the commands show glyphs). */
  const TOOL_KEYS: Record<string, string> = { "⌫": "Backspace" }

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

    const actionIds = selList.length
      ? ["object.trigger", "object.frame", "object.duplicate", "object.delete", "object.move", ...(spawn ? ["object.possess"] : [])]
      : [...(sec.retrigger ? ["ground.trigger-here"] : []), "ground.frame", "ground.reroll", "ground.clear", ...(spawn ? ["object.possess"] : [])]
    const ctx: LabCommandContext = { pickedObject: null, groundHit: null, source: "ui" }
    const states = actionIds.map(id => {
      const cmd = commands.get(id)
      return { id, cmd, enabled: Boolean(cmd && mode !== "play" && cmd.enabled(ctx)) }
    })
    detailsToolbar.set(states.flatMap(({ id, cmd, enabled }) => {
      if (!cmd) return []
      const label = id === "ground.trigger-here" ? "Retrigger" : id === "ground.clear" ? "Clear FX" : id === "object.possess" ? "Play" : cmd.shortLabel ?? cmd.label
      return [{
        id,
        label,
        shortcut: cmd.shortcut ? (TOOL_KEYS[cmd.shortcut] ?? cmd.shortcut) : undefined,
        disabled: !enabled,
        title: enabled ? cmd.label : cmd.disabledReason?.(ctx) ?? "Unavailable",
      }]
    }))
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

  // An open radial belongs to the viewport: a press or focus anywhere else (a panel, a station card) closes it.
  for (const type of ["pointerdown", "focusin"] as const) {
    document.addEventListener(type, event => {
      if (radialState.phase !== "closed" && !viewportEl.contains(event.target as Node | null)) closeRadial()
    }, { capture: true })
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

  /** Whether a screen point is on the viewport itself, not on a panel, menu or the chrome over or beside it. */
  function onViewport(clientX: number, clientY: number): boolean {
    const rect = viewportEl.getBoundingClientRect()
    if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return false
    const hit = document.elementFromPoint(clientX, clientY)
    return hit === canvas || (hit !== null && transformGizmo.root.contains(hit))
  }

  function closeRadial() {
    if (radialState.phase === "closed") return
    radialState.close()
    radialDOM.sync()
    viewportCursor.update({ state: "hidden" })
    syncTransportAndHints()
  }

  /** Opens the radial at an RMB tap or Ctrl-click; only on the viewport, never over the panels. */
  function openRadialAtScreen(clientX: number, clientY: number, viaKeyboard = false) {
    if (!onViewport(clientX, clientY)) return
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
    if (panel.hasFocus()) return

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
      // M is the Lab's mute key (docs/controls.md); the radial opens from RMB tap, Ctrl+click or the menu key, and
      // the key only while the viewport (not a panel button) has focus.
      event.preventDefault()
      if (document.activeElement === canvas || document.activeElement === document.body) openRadialFromKeyboard()
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
    } else if (/^Digit[0-9]$/.test(event.code) && !event.repeat && !variationGrid && focusZone !== "library" && digitHandler?.(Number(event.code.slice(5)), event.shiftKey)) {
      event.preventDefault()
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
    /** Number keys outside text fields, Play, the grid and the radial: return true to take them (stations do). */
    onDigit(handler: (n: number, shift: boolean) => boolean) {
      digitHandler = handler
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
      if (pendingThumb) maybeCaptureThumb()
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
        notifyHistory()
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
      root.dispatchEvent(new Event(PANELS_CHANGE_EVENT))
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
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    /** Calls `listener` when whether Undo or Redo can run changes; returns an unsubscribe. */
    onHistoryChange(listener: () => void) {
      historyListeners.add(listener)
      return () => { historyListeners.delete(listener) }
    },
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
