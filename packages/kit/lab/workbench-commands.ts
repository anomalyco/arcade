import {
  coerceControlValue,
  findControlRow,
  formatControlValue,
} from "../dev-control"
import {
  BUSH_PRESET_IDS,
  FOLIAGE_CROWN_SHAPES,
  FOLIAGE_PARAM_SPECS,
  GRASS_PRESET_IDS,
  TREE_PRESET_IDS,
  applyFoliagePreset,
  exportFoliagePreset,
  foliagePresetIdsFor,
  foliageSettings,
  foliageTextureUrls,
  importFoliagePreset,
  randomizeFoliageParams,
  setFoliageTextureUrls,
  type FoliageKind,
  type FoliageLabTool,
  type FoliageLighting,
} from "../gpu/foliage"
import { LOOK_PRESETS, LOOK_PRESET_IDS, resolveLookPresetId, type LookGroup } from "../gpu/look"
import type { LabPanel, LabValue } from "../lab-panel"
import { getTwoFingerScrollMode, setTwoFingerScrollMode } from "../orbit-gestures"
import type { LabCommandContext, LabCommandRegistry } from "./commands"
import type { createEffects } from "./effects"
import { FOLIAGE_LIGHTINGS, FOLIAGE_LOOKS } from "./foliage"
import { isLibraryAsset, isPlaceable, LIBRARY_CATEGORIES, type createLibrary } from "./library"
import type { LookLabController } from "./looks"
import { OUTLINER_GROUPS, type createOutliner } from "./outliner"
import type { createPalette } from "./palette"
import type { createSpawn } from "./spawn"
import type { Stage } from "./stage"
import type { TransformMode } from "./transform"
import type { LabContext, LabLibraryCategory, LabSection, LabWorldObject } from "./types"
import { summarizeTileSettings, type VariationGridConfig, type VariationTileConfig } from "./variation-grid"
import { watchPinId, type WatchPin } from "./watch"
import { LIGHTING_LOOKS, type CatalogEntry, type FullSnapshot, type HistoryEntry, type LabPresetSchema } from "./workbench-types"
import { yardGround } from "./yard"

export interface WorkbenchCommandsHost {
  root: HTMLElement
  canvas: HTMLCanvasElement
  panel: LabPanel
  context: LabContext
  stage: Stage
  sections: readonly LabSection[]
  globalSettings: { section: string; debug: number }
  spawn?: ReturnType<typeof createSpawn>
  looks?: LookLabController
  effects?: ReturnType<typeof createEffects>
  playPauseBtn: HTMLButtonElement
  stepBtn: HTMLButtonElement
  speedSelect: HTMLSelectElement
  detailsSearch: HTMLInputElement
  activeSection: () => LabSection
  resolveEnvOwner: () => LabSection
  selectSection: (id: string) => void
  getMode: () => "edit" | "play"
  setPlayMode: (next: "edit" | "play", restoreCheckpoint?: boolean) => void
  getEjected: () => boolean
  toggleEject: () => void
  getSimSpeed: () => number
  setSimSpeed: (speed: number) => void
  getElapsed: () => number
  getFrames: () => number
  resetClock: () => void
  setActiveCatalogId: (id: string) => void
  setFocusZone: (zone: "canvas" | "library" | "inspector" | "palette" | "modal" | "outliner") => void
  activeTargetObject: (ctx?: LabCommandContext) => LabWorldObject | null
  resolveObjectOwner: (objId: string) => LabSection
  allSceneObjects: () => LabWorldObject[]
  currentSelectedIds: () => string[]
  currentSelectedObjects: () => LabWorldObject[]
  selectWorldObject: (obj: LabWorldObject | null, shiftKey?: boolean) => void
  setSelectionIds: (ids: readonly string[]) => void
  setSelectingFromOutliner: (val: boolean) => void
  startTransformSelection: (tMode: TransformMode, primaryObj?: LabWorldObject, viaHandle?: boolean) => void
  frameActiveTarget: () => void
  captureSnapshot: () => FullSnapshot
  recordHistory: (label: string, before: FullSnapshot) => void
  undoStack: readonly HistoryEntry[]
  redoStack: readonly HistoryEntry[]
  undo: () => boolean
  redo: () => boolean
  buildPresetPayload: () => LabPresetSchema
  applyPresetJson: (raw: string) => { ok: true } | { ok: false; error: string }
  openPresetModal: (mode: "export" | "import") => void
  openRecipeModal: () => void
  pinBaselineSlotA: () => void
  flipCompareSlot: () => void
  toggleCompareWipe: () => void
  getVariationGrid: () => VariationGridConfig | null
  getFocusedGridTile: () => number | null
  getVariationGridCostMs: () => number | null
  openVariationGrid: (rawArgs?: Record<string, unknown>) => VariationGridConfig
  focusVariationTile: (tileNumber: number | null) => { focusedTile: number | null; tile: VariationTileConfig | null }
  closeVariationGrid: () => void
  resimulateFrozenFrame: (control?: { key: string; unit?: string }) => boolean
  buildCatalog: () => CatalogEntry[]
  groundFnFor: (sec: LabSection) => (x: number, z: number) => number
  placeLibraryEntry: (entry: CatalogEntry, at: { x: number; y: number; z: number } | null, yawDeg?: number) => unknown
  lockedIds: Set<string>
  getOutliner: () => ReturnType<typeof createOutliner>
  getLibraryDrawer: () => ReturnType<typeof createLibrary<CatalogEntry>>
  getPalette: () => ReturnType<typeof createPalette>
  getWatchPins: () => WatchPin[]
  setWatchPins: (next: WatchPin[]) => void
  pinSetting: (sectionId: string, key: string, pinned?: boolean) => boolean
  getDetailsFilterState: () => { query: string; modifiedOnly: boolean; showAll: boolean }
  setDetailsFilterState: (patch: { query?: string; modifiedOnly?: boolean; showAll?: boolean }) => void
  applyDetailsView: (force?: boolean) => void
  syncDetails: () => void
  revealSetting: (sectionId: string, key: string) => boolean
  syncTransportAndHints: () => void
  syncChrome: () => void
  renderNow: () => Promise<unknown>
  showToast: (message: string, isError?: boolean) => void
}

export function registerWorkbenchCommands(commands: LabCommandRegistry, host: WorkbenchCommandsHost): void {
  const {
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
    detailsSearch,
    activeSection,
    resolveEnvOwner,
    selectSection,
    getMode,
    setPlayMode,
    getEjected,
    toggleEject,
    getSimSpeed,
    setSimSpeed,
    getElapsed,
    getFrames,
    resetClock,
    setActiveCatalogId,
    setFocusZone,
    activeTargetObject,
    resolveObjectOwner,
    allSceneObjects,
    currentSelectedIds,
    currentSelectedObjects,
    selectWorldObject,
    setSelectionIds,
    setSelectingFromOutliner,
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
    getVariationGrid,
    getFocusedGridTile,
    getVariationGridCostMs,
    openVariationGrid,
    focusVariationTile,
    closeVariationGrid,
    resimulateFrozenFrame,
    buildCatalog,
    groundFnFor,
    placeLibraryEntry,
    lockedIds,
    getOutliner,
    getLibraryDrawer,
    getPalette,
    getWatchPins,
    setWatchPins,
    pinSetting,
    getDetailsFilterState,
    setDetailsFilterState,
    applyDetailsView,
    syncDetails,
    revealSetting,
    syncTransportAndHints,
    syncChrome,
    renderNow,
    showToast,
  } = host

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
          resetClock()
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
        setFocusZone("inspector")
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
            resetClock()
            sec.retrigger?.()
          }
          recordHistory("Trigger FX at cursor", before)
        } else {
          resetClock()
          sec.retrigger?.()
          const grid = getVariationGrid()
          if (grid && sec.id === "effects" && effects) {
            effects.resetVariantSlots(grid.tiles)
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
      enabled: ctx => Boolean(spawn) && (ctx?.source !== "cli" || getMode() !== "play"),
      disabledReason: () => (getMode() === "play" ? "Unavailable in Play mode (character is possessed). Run 'arcade release' first." : "No prop adapter available"),
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
          setFocusZone("inspector")
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
        const curMode = getMode()
        const nextMode = args?.mode === "edit" || args?.mode === "play" ? args.mode : curMode === "play" ? "edit" : "play"
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
          mode: getMode(),
          ejected: getEjected(),
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
          mode: getMode(),
          ejected: getEjected(),
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
      enabled: () => getMode() !== "play" && undoStack.length > 0,
      disabledReason: () => (getMode() === "play" ? "Unavailable in Play mode" : "Nothing to undo"),
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
      enabled: () => getMode() !== "play" && redoStack.length > 0,
      disabledReason: () => (getMode() === "play" ? "Unavailable in Play mode" : "Nothing to redo"),
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
      enabled: () => getMode() !== "play",
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
      enabled: () => getMode() !== "play",
      disabledReason: () => "Unavailable in Play mode. Run 'arcade release' first.",
      run: (_ctx, args) => {
        const cfg = openVariationGrid(args as Record<string, unknown> | undefined)
        const cost = getVariationGridCostMs()
        return {
          active: true,
          id: cfg.id,
          title: cfg.title,
          section: cfg.section,
          cols: cfg.cols,
          rows: cfg.rows,
          tileCount: cfg.tiles.length,
          focusedTile: getFocusedGridTile(),
          frameCostMs: cost !== null ? Number(cost.toFixed(2)) : null,
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
      enabled: () => Boolean(getVariationGrid()) && getMode() !== "play",
      disabledReason: () => (getVariationGrid() ? "Unavailable in Play mode" : "Variation grid is not open. Run 'arcade grid' first."),
      run: (_ctx, args) => {
        const rawTile = typeof args?.tile === "number" ? args.tile : null
        const res = focusVariationTile(rawTile)
        return {
          active: true,
          id: getVariationGrid()?.id ?? null,
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
      enabled: () => Boolean(getVariationGrid()),
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
        return { playing: Boolean(sec.settings.playing ?? true), elapsed: Number(getElapsed().toFixed(3)), frames: getFrames(), speed: getSimSpeed() }
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
        return { playing: false, stepped: count, elapsed: Number(getElapsed().toFixed(3)), frames: getFrames(), speed: getSimSpeed() }
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
        setSimSpeed(nextSpeed)
        speedSelect.value = String(nextSpeed)
        const sec = activeSection()
        if ("slowMotion" in sec.settings) {
          sec.settings.slowMotion = Math.min(1, nextSpeed)
        }
        panel.sync()
        syncChrome()
        void renderNow()
        return { speed: getSimSpeed(), playing: Boolean(sec.settings.playing ?? true), elapsed: Number(getElapsed().toFixed(3)), frames: getFrames() }
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
        resetClock()
        sec.retrigger?.()
        const grid = getVariationGrid()
        if (grid && sec.id === "effects" && effects) {
          effects.resetVariantSlots(grid.tiles)
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
      enabled: () => getMode() !== "play",
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
        resetClock()
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
      enabled: () => getMode() !== "play",
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
      enabled: () => getMode() !== "play",
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
          setActiveCatalogId(`lighting-look:${lookKey}`)
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
      enabled: () => getMode() !== "play",
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
      enabled: () => getMode() !== "play",
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
        tool: { type: "string", enum: ["tree", "bush", "grass", "lot"], description: "Vegetation tool / test room" },
        treePreset: { type: "string", enum: TREE_PRESET_IDS, description: "Tree preset" },
        bushPreset: { type: "string", enum: BUSH_PRESET_IDS, description: "Bush preset" },
        grassPreset: { type: "string", enum: GRASS_PRESET_IDS, description: "Grass preset" },
        crownShape: { type: "string", enum: FOLIAGE_CROWN_SHAPES.map(s => s.value), description: "Crown silhouette shape" },
        cameraMode: { type: "string", enum: ["close", "game"], description: "Camera view mode" },
        lighting: { type: "string", enum: Object.keys(FOLIAGE_LIGHTINGS), description: "Test-room lighting (night, dusk, day)" },
        look: { type: "string", enum: FOLIAGE_LOOKS, description: "Look post grade" },
        walker: { type: "boolean", description: "Walkers trampling the vegetation" },
        flashlight: { type: "boolean", description: "Lead walker carries a flashlight at night" },
        seed: { type: "number", min: 1, max: 999, description: "Structure seed (rebuilds the room)" },
        tuningSeed: { type: "number", min: 1, max: 9999, description: "Parameter randomize seed" },
        ...Object.fromEntries(
          FOLIAGE_PARAM_SPECS.map(s => [
            s.key,
            { type: "number" as const, min: s.min, max: s.max, description: `${s.group} · ${s.label}${s.unit ? ` (${s.unit})` : ""}` },
          ]),
        ),
      },
      enabled: () => getMode() !== "play",
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
        scope: { type: "string", enum: ["all", "tree", "bush", "grass"], description: "Look to randomize ('tree', 'bush', 'grass' or 'all')" },
        tuningSeed: { type: "number", min: 1, max: 9999, description: "Optional deterministic tuning seed" },
      },
      enabled: () => getMode() !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const foliageSec = sections.find(s => s.id === "foliage")
        if (!foliageSec) throw new Error("Foliage section is not available on this page.")
        if (globalSettings.section !== "foliage") selectSection("foliage")
        const scope = args?.scope === "tree" || args?.scope === "bush" || args?.scope === "grass" ? args.scope : "all"
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
      label: "Load, Reset, or Export Vegetation Preset",
      shortLabel: "Vegetation Preset",
      category: "Preset",
      undoable: true,
      args: {
        kind: { type: "string", enum: ["tree", "bush", "grass"], description: "Which look the preset applies to (default: the active tool)" },
        preset: {
          type: "string",
          enum: [...TREE_PRESET_IDS, ...BUSH_PRESET_IDS, ...GRASS_PRESET_IDS, "reset"],
          description: "Tree (oak, maple, pine, birch), bush (hedge, overgrown, hydrangea) or grass (lawn, overgrown, weeds) preset, or 'reset'",
        },
        tool: { type: "string", enum: ["tree", "bush", "grass", "lot"], description: "Optional test room / tool" },
        lighting: { type: "string", enum: Object.keys(FOLIAGE_LIGHTINGS), description: "Optional lighting (night, dusk, day)" },
        look: { type: "string", enum: FOLIAGE_LOOKS, description: "Optional look post grade" },
        cameraMode: { type: "string", enum: ["close", "game"], description: "Optional camera mode" },
        json: { type: "string", description: "Optional FoliagePresetV2 (or V1) JSON payload to import" },
      },
      enabled: () => getMode() !== "play",
      disabledReason: () => "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const foliageSec = sections.find(s => s.id === "foliage")
        if (!foliageSec) throw new Error("Vegetation section is not available on this page.")
        if (globalSettings.section !== "foliage") selectSection("foliage")
        const setControl = (key: string, value: LabValue) => {
          const c = foliageSec.controls.find(ctrl => ctrl.key === key)
          if (c) panel.navigation.set(c, value)
          else foliageSec.settings[key] = value
        }

        if (typeof args?.json === "string" && args.json.trim()) {
          const imported = importFoliagePreset(args.json)
          if (!imported.ok) throw new Error(imported.error)
          const val = imported.value
          Object.assign(foliageSettings, val.params)
          foliageSec.settings.seed = val.seed
          foliageSec.settings.tuningSeed = val.tuningSeed
          setControl("tool", val.tool)
          setControl("lighting", val.lighting)
          setControl("look", val.look)
          setControl("cameraMode", val.cameraMode)
          foliageSec.retrigger?.()
          panel.sync()
          syncChrome()
          void renderNow()
          return { action: "imported", preset: val }
        }

        if (typeof args?.tool === "string") setControl("tool", args.tool)
        const tool = String(foliageSec.settings.tool) as FoliageLabTool
        if (typeof args?.preset === "string" && args.preset.trim()) {
          const p = args.preset.trim().toLowerCase()
          const explicit = args?.kind === "tree" || args?.kind === "bush" || args?.kind === "grass" ? (args.kind as FoliageKind) : null
          const kinds: FoliageKind[] = explicit ? [explicit] : tool === "lot" ? ["tree", "bush", "grass"] : [tool]
          if (p === "reset") {
            for (const k of kinds) applyFoliagePreset(k, k === "tree" ? foliageSettings.treePreset : k === "bush" ? foliageSettings.bushPreset : foliageSettings.grassPreset)
          } else {
            const kind = kinds.find(k => foliagePresetIdsFor(k).includes(p)) ?? (["tree", "bush", "grass"] as const).find(k => foliagePresetIdsFor(k).includes(p))
            if (!kind) throw new Error(`Unknown vegetation preset "${args.preset}".`)
            applyFoliagePreset(kind, p)
          }
        }
        if (typeof args?.lighting === "string") setControl("lighting", args.lighting)
        if (typeof args?.look === "string") setControl("look", args.look)
        if (typeof args?.cameraMode === "string") setControl("cameraMode", args.cameraMode)
        foliageSec.retrigger?.()
        panel.sync()
        syncChrome()
        void renderNow()

        const exported = exportFoliagePreset({
          seed: Number(foliageSec.settings.seed) || 7,
          tuningSeed: Number(foliageSec.settings.tuningSeed) || 41,
          tool: String(foliageSec.settings.tool) as FoliageLabTool,
          lighting: String(foliageSec.settings.lighting) as FoliageLighting,
          look: String(foliageSec.settings.look),
          cameraMode: foliageSec.settings.cameraMode === "close" ? "close" : "game",
          params: foliageSettings,
        })
        return {
          presets: { tree: foliageSettings.treePreset, bush: foliageSettings.bushPreset, grass: foliageSettings.grassPreset },
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
      enabled: () => Boolean(looks) && getMode() !== "play",
      disabledReason: () => (getMode() === "play" ? "Unavailable in Play mode. Run 'arcade release' first." : "Looks section unavailable."),
      run: (_ctx, args) => {
        if (!looks) throw new Error("Looks controller is not available.")
        const raw = String(args?.preset ?? "").trim()
        const pid = resolveLookPresetId(raw)
        if (!pid) {
          throw new Error(`Unknown look preset "${raw}". Valid presets: ${LOOK_PRESET_IDS.join(", ")}.`)
        }
        if (globalSettings.section !== "looks") selectSection("looks")
        const settings = looks.applyPreset(pid)
        setActiveCatalogId(`look-preset:${pid}`)
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
      enabled: () => Boolean(looks) && getMode() !== "play",
      disabledReason: () => (getMode() === "play" ? "Unavailable in Play mode. Run 'arcade release' first." : "Looks section unavailable."),
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
      enabled: () => Boolean(looks) && getMode() !== "play",
      disabledReason: () => (getMode() === "play" ? "Unavailable in Play mode. Run 'arcade release' first." : "Looks section unavailable."),
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
      enabled: () => getMode() !== "play",
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
        setSelectingFromOutliner(true)
        try {
          setSelectionIds(next)
        } finally {
          setSelectingFromOutliner(false)
        }
        const primary = currentSelectedIds().at(-1)
        if (primary) getOutliner().reveal(primary)
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
        const outliner = getOutliner()
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
        if (getMode() === "play") setPlayMode("edit")
        getOutliner().focus()
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
        const libraryDrawer = getLibraryDrawer()
        const open = typeof args?.open === "boolean" ? args.open : args?.category || args?.query ? true : !libraryDrawer.open
        if (typeof args?.category === "string") libraryDrawer.setCategory(args.category as LabLibraryCategory)
        libraryDrawer.setOpen(open)
        if (typeof args?.query === "string") libraryDrawer.setQuery(args.query)
        if (open && ctx?.source !== "cli" && !args?.category) libraryDrawer.focusSearch()
        else if (!open) canvas.focus({ preventScroll: true })
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
      enabled: () => getMode() !== "play",
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
        const palette = getPalette()
        if (getMode() === "play") setPlayMode("edit")
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
        return { section: sectionId, key, pinned, watch: getWatchPins().map(p => watchPinId(p)) }
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
      enabled: () => getWatchPins().length > 0,
      disabledReason: () => "Watch list is empty",
      run: (_ctx, args) => {
        if (args?.all) {
          setWatchPins([])
          return { watch: [] }
        }
        const watchPins = getWatchPins()
        const key = String(args?.key ?? "").trim()
        const pin = watchPins.find(p => p.key === key && (typeof args?.section !== "string" || p.sectionId === args.section))
        if (!pin) throw new Error(`"${key}" is not pinned.`)
        setWatchPins(watchPins.filter(p => p !== pin))
        return { watch: getWatchPins().map(p => watchPinId(p)) }
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
        const cur = getDetailsFilterState()
        const modifiedOnly =
          typeof args?.modified === "boolean"
            ? args.modified
            : args?.query === undefined && args?.all === undefined
              ? !cur.modifiedOnly
              : cur.modifiedOnly
        const query = typeof args?.query === "string" ? args.query : cur.query
        if (typeof args?.query === "string") detailsSearch.value = args.query
        const showAll = typeof args?.all === "boolean" ? args.all : cur.showAll
        setDetailsFilterState({ modifiedOnly, query, showAll })
        applyDetailsView()
        syncDetails()
        return {
          modifiedOnly,
          query,
          showAll,
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
      enabled: () => getMode() !== "play",
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
}
