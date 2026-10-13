import { LabPanel, type LabSettings, type LabValue } from "../lab-panel"
import { effectOptions } from "./effects"
import { lightingDefaults } from "./lighting"
import type { createSpawn, SpawnSceneSnapshot } from "./spawn"
import type { StageMarker } from "./stage"
import type { LabContext, LabSection, LabWorldObject } from "./types"
import { yardGround } from "./yard"

export type CatalogCategory = "effects" | "objects" | "lighting" | "audio"
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
}

export function createWorkbench(opts: WorkbenchOptions) {
  const { root, canvas, panel, context, sections, globalSettings, selectSection, renderNow, advanceSim, spawn } = opts
  const { stage, input } = context
  const isBench = new URLSearchParams(location.search).has("bench")

  let mode: "edit" | "play" = "edit"
  let activeCategory: CatalogCategory = "effects"
  let activeCollection: CatalogCollection = "all"
  let searchQuery = ""
  let selectedCatalogIndex = 0
  let activeCatalogId = "fixture:smoke-room"
  let simSpeed = 1
  let elapsed = 0
  let frames = 0
  let hoveredObjectId: string | null = null
  let movingObject: { id: string; origX: number; origZ: number; origYaw?: number; before: FullSnapshot } | null = null
  let focusZone: "canvas" | "library" | "inspector" | "palette" | "modal" = "canvas"
  let toastTimer = 0

  const undoStack: HistoryEntry[] = []
  const redoStack: HistoryEntry[] = []

  // Top bar elements
  const topbar = root.querySelector<HTMLElement>(".lab-topbar")!
  const libraryEl = root.querySelector<HTMLElement>(".lab-library")!
  const viewportEl = root.querySelector<HTMLElement>(".lab-viewport")!
  const inspectorEl = root.querySelector<HTMLElement>(".lab-inspector")!
  const bottombar = root.querySelector<HTMLElement>(".lab-bottombar")!

  const editModeBtn = topbar.querySelector<HTMLButtonElement>('[data-action="mode-edit"]')!
  const playModeBtn = topbar.querySelector<HTMLButtonElement>('[data-action="mode-play"]')!
  const sectionSelect = topbar.querySelector<HTMLSelectElement>('[data-control="section"]')!
  const envSelect = topbar.querySelector<HTMLSelectElement>('[data-control="environment"]')!
  const seedBadge = topbar.querySelector<HTMLElement>('[data-readout="seed"]')!
  const rerollBtn = topbar.querySelector<HTMLButtonElement>('[data-action="reroll"]')!
  const lockEffectBtn = topbar.querySelector<HTMLButtonElement>('[data-action="lock-effect"]')!
  const lockEnvBtn = topbar.querySelector<HTMLButtonElement>('[data-action="lock-env"]')!
  const debugSelect = topbar.querySelector<HTMLSelectElement>('[data-control="debug"]')!
  const frameBtn = topbar.querySelector<HTMLButtonElement>('[data-action="frame"]')!
  const undoBtn = topbar.querySelector<HTMLButtonElement>('[data-action="undo"]')!
  const redoBtn = topbar.querySelector<HTMLButtonElement>('[data-action="redo"]')!
  const exportBtn = topbar.querySelector<HTMLButtonElement>('[data-action="export"]')!
  const importBtn = topbar.querySelector<HTMLButtonElement>('[data-action="import"]')!

  // Library elements
  const searchInput = libraryEl.querySelector<HTMLInputElement>('[data-control="library-search"]')!
  const catTabs = [...libraryEl.querySelectorAll<HTMLButtonElement>("[data-cat]")]
  const filterPills = [...libraryEl.querySelectorAll<HTMLButtonElement>("[data-collection]")]
  const catalogListEl = libraryEl.querySelector<HTMLElement>(".lab-catalog-list")!

  // Viewport HUD elements
  const hudBadge = viewportEl.querySelector<HTMLElement>("[data-hud-badge]")!
  const hudToast = viewportEl.querySelector<HTMLElement>("[data-hud-toast]")!

  // Inspector header elements
  const inspectorTitle = inspectorEl.querySelector<HTMLElement>(".lab-inspector-title")!
  const inspectorSub = inspectorEl.querySelector<HTMLElement>(".lab-inspector-sub")!

  // Bottom transport elements
  const playPauseBtn = bottombar.querySelector<HTMLButtonElement>('[data-action="transport-play"]')!
  const retriggerBtn = bottombar.querySelector<HTMLButtonElement>('[data-action="transport-retrigger"]')!
  const stepBtn = bottombar.querySelector<HTMLButtonElement>('[data-action="transport-step"]')!
  const loopBtn = bottombar.querySelector<HTMLButtonElement>('[data-action="transport-loop"]')!
  const speedSelect = bottombar.querySelector<HTMLSelectElement>('[data-control="transport-speed"]')!
  const timeReadout = bottombar.querySelector<HTMLElement>('[data-readout="elapsed"]')!
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

  function showToast(message: string, isError = false) {
    hudToast.textContent = message
    hudToast.dataset.error = String(isError)
    hudToast.hidden = false
    if (toastTimer) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      hudToast.hidden = true
    }, 2800)
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

  function restoreSnapshot(snap: FullSnapshot) {
    if (snap.sectionId !== globalSettings.section) {
      selectSection(snap.sectionId)
    }
    for (const s of sections) {
      const saved = snap.sections[s.id]
      if (!saved) continue
      for (const [k, v] of Object.entries(saved)) {
        if (k in s.settings) s.settings[k] = v
      }
    }
    Object.assign(stage.lighting, snap.lighting)
    if (spawn && snap.spawn) {
      spawn.restore(snap.spawn)
    }
    const sec = activeSection()
    if (sec.id === "blackout-effects" || sec.id === "getaway-effects") {
      sec.enter?.()
      sec.retrigger?.()
    } else if (sec.id === "effects" || sec.id === "fire-water" || sec.id === "splatter") {
      sec.retrigger?.()
    }
    panel.sync()
    syncChrome()
    void renderNow()
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

  function setPlayMode(next: "edit" | "play") {
    if (next === "play") {
      if (globalSettings.section !== "spawn") selectSection("spawn")
      if (spawn && !spawn.hasCharacter()) {
        spawn.spawnCharacterAt()
      }
      if (!spawn?.hasCharacter()) {
        showToast("Spawn a character first to enter Play mode", true)
        return
      }
      spawn.setGhost(null)
      movingObject = null
      mode = "play"
      input.enabled = true
      focusZone = "canvas"
      canvas.focus({ preventScroll: true })
      showToast(`Playing ${spawn.characterLabel() ?? "Character"} · Esc to return to Edit`)
    } else {
      const wasPlay = mode === "play"
      mode = "edit"
      input.enabled = false
      input.release()
      if (wasPlay) showToast("Edit mode")
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
    if (sections.some(s => s.id === "materials")) {
      entries.push({
        id: "section:materials",
        label: "Material Catalog (25)",
        group: "Calibration & Solvers",
        category: "objects",
        collection: "shared",
        tag: "Stub",
        sectionId: "materials",
        isActive: () => globalSettings.section === "materials",
        run: () => selectSection("materials"),
      })
    }

    // 8. Lighting Category
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

    return entries
  }

  function filteredCatalog(): CatalogEntry[] {
    const all = buildCatalog()
    const q = searchQuery.trim().toLowerCase()
    return all.filter(item => {
      if (!q && item.category !== activeCategory) return false
      if (activeCollection !== "all" && item.collection !== activeCollection) return false
      if (q) {
        const hay = `${item.label} ${item.group} ${item.tag} ${item.collection}`.toLowerCase()
        return hay.includes(q)
      }
      return true
    })
  }

  function renderCatalog() {
    const items = filteredCatalog()
    selectedCatalogIndex = Math.max(0, Math.min(selectedCatalogIndex, items.length - 1))
    catalogListEl.replaceChildren()
    let lastGroup = ""
    items.forEach((item, idx) => {
      if (item.group !== lastGroup) {
        lastGroup = item.group
        const g = document.createElement("div")
        g.className = "lab-catalog-group"
        g.textContent = item.group
        catalogListEl.append(g)
      }
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "lab-catalog-item"
      btn.dataset.catalogId = item.id
      const active = Boolean(item.isActive?.()) || (focusZone === "library" && idx === selectedCatalogIndex)
      btn.setAttribute("aria-selected", String(active))
      const nameSpan = document.createElement("span")
      nameSpan.textContent = item.label
      const tagSpan = document.createElement("span")
      tagSpan.className = "lab-catalog-tag"
      tagSpan.textContent = item.tag
      btn.append(nameSpan, tagSpan)
      btn.onclick = () => {
        selectedCatalogIndex = idx
        item.run(true)
        panel.sync()
        syncChrome()
        void renderNow()
      }
      catalogListEl.append(btn)
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
    playPauseBtn.textContent = playing ? "Pause" : "Play"
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
      focusPill.textContent = `Play · ${charName}`
      hintText.textContent = "WASD/Arrows Move · Space Brake · Shift Boost/Sprint · Esc Exit Play"
    } else if (ghost) {
      focusPill.textContent = `Place · ${ghost.kind}`
      hintText.textContent = "Click/Enter Place · ⇧Click Repeat · [ ] Rotate · Arrows Nudge · Esc Cancel"
    } else if (movingObject) {
      focusPill.textContent = `Move · ${movingObject.id}`
      hintText.textContent = "Click/Enter Commit · Arrows Nudge · Esc Cancel"
    } else if (focusZone === "inspector") {
      const activeCtrl = panel.navigation.active?.control
      focusPill.textContent = `Inspector · ${activeCtrl?.label ?? panel.navigation.active?.group ?? "Controls"}`
      hintText.textContent = "↑↓ Row · ←→ Adjust (⇧×10 ⌥×0.1) · Enter Exact · 0 Reset · R Randomize · Esc Canvas"
    } else if (focusZone === "library") {
      focusPill.textContent = "Edit · Library"
      hintText.textContent = "↑↓ Browse · Enter Select · / Search · Tab Inspector · Esc Canvas"
    } else {
      focusPill.textContent = "Edit · Canvas"
      if (sec.id === "spawn") {
        hintText.textContent = "Click Select · A Place · G Move · ⌫ Delete · P Play · F Frame · ⌘Z Undo"
      } else {
        hintText.textContent = "Space Retrigger · F Frame · R Reroll Room · Q/E Cycle · Tab Inspector · ⌘K Search"
      }
    }
  }

  function syncStageMarkers() {
    stage.markers.length = 0
    stage.showMarkers = root.dataset.closed !== "true"
    const sec = activeSection()
    const objects = sec.objects?.() ?? []
    const selId = sec.selectedObjectId
    const showSelectionRing = Boolean(selId) || activeCategory === "objects" || Boolean(movingObject)
    const selObj = selId ? objects.find(o => o.id === selId) : showSelectionRing ? objects[0] : null
    if (selObj && mode === "edit" && showSelectionRing) {
      stage.markers.push({
        x: selObj.x,
        y: selObj.y,
        z: selObj.z,
        yaw: selObj.yaw ?? 0,
        radius: selObj.radius ?? 0.75,
        kind: "select",
      })
    }
    if (hoveredObjectId && hoveredObjectId !== selObj?.id && mode === "edit") {
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
      stage.markers.push({
        x: ghost.x,
        y: ghost.y,
        z: ghost.z,
        yaw: ghost.yaw,
        radius: 0.8,
        kind: ghost.valid ? "ghost" : "invalid",
      })
    }
  }

  function syncChrome() {
    const sec = activeSection()
    sectionSelect.value = sec.id
    debugSelect.value = String(globalSettings.debug)
    editModeBtn.setAttribute("aria-pressed", String(mode === "edit"))
    playModeBtn.setAttribute("aria-pressed", String(mode === "play"))
    playModeBtn.dataset.playActive = String(mode === "play")

    undoBtn.disabled = undoStack.length === 0
    undoBtn.title = undoStack.length ? `Undo ${undoStack.at(-1)!.label} (⌘Z)` : "Undo (⌘Z)"
    redoBtn.disabled = redoStack.length === 0
    redoBtn.title = redoStack.length ? `Redo ${redoStack.at(-1)!.label} (⇧⌘Z)` : "Redo (⇧⌘Z)"

    for (const tab of catTabs) {
      tab.setAttribute("aria-pressed", String(tab.dataset.cat === activeCategory))
    }
    for (const pill of filterPills) {
      pill.setAttribute("aria-pressed", String(pill.dataset.collection === activeCollection))
    }

    // Inspector header title
    const objs = sec.objects?.() ?? []
    const selObj = sec.selectedObjectId ? objs.find(o => o.id === sec.selectedObjectId) : null
    if (selObj && sec.id === "spawn") {
      inspectorTitle.textContent = selObj.label
      inspectorSub.textContent = `${sec.label} · (${selObj.x.toFixed(1)}, ${selObj.z.toFixed(1)})`
    } else if ("effect" in sec.settings) {
      const effCtrl = sec.controls.find(c => c.key === "effect" && "options" in c)
      const effLabel = effCtrl && "options" in effCtrl ? effCtrl.options.find(o => o.value === sec.settings.effect)?.label : String(sec.settings.effect)
      inspectorTitle.textContent = effLabel || sec.label
      inspectorSub.textContent = sec.label
    } else {
      inspectorTitle.textContent = sec.label
      inspectorSub.textContent = "Inspector"
    }

    // Viewport HUD badge
    hudBadge.hidden = sec.id === "audio"
    if (mode === "play") {
      hudBadge.textContent = `PLAY · ${spawn?.characterLabel() ?? "Character"} (Esc to exit)`
    } else if (spawn?.getGhost()) {
      const g = spawn.getGhost()!
      hudBadge.textContent = `Place ${g.kind} · (${g.x.toFixed(1)}, ${g.z.toFixed(1)}) · ${Math.round((g.yaw * 180) / Math.PI)}°`
    } else if (movingObject) {
      hudBadge.textContent = `Move ${movingObject.id} · Click/Enter to commit`
    } else if (hoveredObjectId) {
      const hov = objs.find(o => o.id === hoveredObjectId)
      hudBadge.textContent = hov ? `${hov.label} · Click to select` : `${sec.label}`
    } else {
      hudBadge.textContent = `${sec.label}${selObj ? ` · ${selObj.label}` : ""}`
    }

    syncEnvironmentSelector()
    syncTransportAndHints()
    syncStageMarkers()
    renderCatalog()
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
  editModeBtn.onclick = () => setPlayMode("edit")
  playModeBtn.onclick = () => setPlayMode(mode === "play" ? "edit" : "play")

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

  // Wire library events
  searchInput.onfocus = () => {
    if (mode === "play") setPlayMode("edit")
    focusZone = "library"
    syncTransportAndHints()
  }
  searchInput.oninput = () => {
    searchQuery = searchInput.value
    selectedCatalogIndex = 0
    renderCatalog()
  }
  searchInput.onkeydown = event => {
    const items = filteredCatalog()
    if (event.key === "ArrowDown") {
      event.preventDefault()
      selectedCatalogIndex = items.length ? (selectedCatalogIndex + 1) % items.length : 0
      renderCatalog()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      selectedCatalogIndex = items.length ? (selectedCatalogIndex - 1 + items.length) % items.length : 0
      renderCatalog()
    } else if (event.key === "Enter") {
      event.preventDefault()
      const chosen = items[selectedCatalogIndex]
      if (chosen) {
        chosen.run(true)
        panel.sync()
        syncChrome()
        void renderNow()
      }
      canvas.focus({ preventScroll: true })
    } else if (event.key === "Escape") {
      event.preventDefault()
      if (searchInput.value) {
        searchInput.value = ""
        searchQuery = ""
        renderCatalog()
      } else {
        focusZone = "canvas"
        canvas.focus({ preventScroll: true })
        syncTransportAndHints()
      }
    }
  }

  for (const tab of catTabs) {
    tab.onclick = () => {
      if (mode === "play") setPlayMode("edit")
      activeCategory = tab.dataset.cat as CatalogCategory
      selectedCatalogIndex = 0
      syncChrome()
    }
  }

  for (const pill of filterPills) {
    pill.onclick = () => {
      if (mode === "play") setPlayMode("edit")
      activeCollection = pill.dataset.collection as CatalogCollection
      selectedCatalogIndex = 0
      syncChrome()
    }
  }

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

  // Exiting Play mode automatically whenever user focuses UI outside canvas
  for (const zone of [topbar, libraryEl, inspectorEl, bottombar]) {
    zone.addEventListener("pointerdown", () => {
      if (mode === "play") setPlayMode("edit")
    })
    zone.addEventListener("focusin", () => {
      if (mode === "play") setPlayMode("edit")
    })
  }

  // Canvas pointer & camera & world picking
  let dragState: { button: number; shift: boolean; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null = null

  function canvasUV(event: { clientX: number; clientY: number }): [number, number] {
    const rect = canvas.getBoundingClientRect()
    const u = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
    const v = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
    return [u, v]
  }

  function pickObjectAt(u: number, v: number): LabWorldObject | null {
    const sec = activeSection()
    const objects = [...(sec.objects?.() ?? [])]
    if (spawn && sec.id !== "spawn" && ["effects", "lighting", "physics"].includes(sec.id)) {
      for (const spObj of spawn.section.objects?.() ?? []) {
        if (!objects.some(o => o.id === spObj.id)) objects.push(spObj)
      }
    }
    if (!objects.length) return null
    const groundFn = sec.groundHeight ?? (spawn && ["effects", "lighting", "physics"].includes(sec.id) ? spawn.section.groundHeight : undefined) ?? (() => 0)
    const hit = stage.pickGround(u, v, groundFn)
    if (!hit) return null
    let best: LabWorldObject | null = null
    let bestDist = Infinity
    for (const obj of objects) {
      const r = Math.max(0.85, (obj.radius ?? 0.85) * 1.25)
      const d = Math.hypot(hit.x - obj.x, hit.z - obj.z)
      if (d <= r && d < bestDist) {
        best = obj
        bestDist = d
      }
    }
    return best
  }

  canvas.addEventListener("focus", () => {
    focusZone = "canvas"
    syncTransportAndHints()
  })

  canvas.addEventListener("pointerdown", event => {
    canvas.focus({ preventScroll: true })
    focusZone = "canvas"
    if (mode === "play") return
    dragState = {
      button: event.button,
      shift: event.shiftKey,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    }
    canvas.setPointerCapture(event.pointerId)
  })

  canvas.addEventListener("pointermove", event => {
    if (mode === "play") return
    const [u, v] = canvasUV(event)
    const sec = activeSection()
    const groundFn = sec.groundHeight ?? (() => 0)

    if (dragState) {
      const dx = event.clientX - dragState.lastX
      const dy = event.clientY - dragState.lastY
      if (Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) > 4) {
        dragState.moved = true
      }
      dragState.lastX = event.clientX
      dragState.lastY = event.clientY
      if (dragState.moved) {
        if (dragState.button === 2 || dragState.button === 1 || dragState.shift) {
          stage.pan(-dx, -dy)
        } else {
          stage.orbit(-dx * 0.0065, dy * 0.0055)
        }
        void renderNow()
        return
      }
    }

    const ghost = spawn?.getGhost()
    if (ghost && globalSettings.section === "spawn") {
      const hit = stage.pickGround(u, v, groundFn)
      if (hit) {
        const snap = event.altKey ? 0.05 : 0.25
        const gx = Math.round(hit.x / snap) * snap
        const gz = Math.round(hit.z / snap) * snap
        spawn!.setGhost({
          ...ghost,
          x: gx,
          y: groundFn(gx, gz),
          z: gz,
          valid: spawn!.isValidYardPoint(gx, gz),
        })
        syncChrome()
        void renderNow()
      }
      return
    }

    if (movingObject) {
      const hit = stage.pickGround(u, v, groundFn)
      if (hit) {
        const snap = event.altKey ? 0.05 : 0.25
        const gx = Math.round(hit.x / snap) * snap
        const gz = Math.round(hit.z / snap) * snap
        sec.moveObject?.(movingObject.id, gx, gz, movingObject.origYaw)
        syncChrome()
        void renderNow()
      }
      return
    }

    const picked = pickObjectAt(u, v)
    const nextHover = picked?.id ?? null
    if (nextHover !== hoveredObjectId) {
      hoveredObjectId = nextHover
      canvas.style.cursor = hoveredObjectId ? "pointer" : "grab"
      syncChrome()
      void renderNow()
    }
  })

  canvas.addEventListener("pointerup", event => {
    if (!dragState) return
    const wasMoved = dragState.moved
    dragState = null
    if (mode === "play" || wasMoved || event.button !== 0) return

    const [u, v] = canvasUV(event)
    const sec = activeSection()
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

    if (movingObject) {
      recordHistory(`Move ${movingObject.id}`, movingObject.before)
      movingObject = null
      panel.sync()
      syncChrome()
      void renderNow()
      return
    }

    const picked = pickObjectAt(u, v)
    if (picked) {
      const isSpawnObj = Boolean(spawn?.section.objects?.()?.some(o => o.id === picked.id))
      if (isSpawnObj && globalSettings.section !== "spawn") {
        selectSection("spawn")
      }
      const targetSec = activeSection()
      targetSec.selectObject?.(picked.id)
      if (targetSec.id === "blackout-effects" && picked.id.startsWith("specimen:")) {
        targetSec.retrigger?.()
      }
      panel.sync()
      syncChrome()
      void renderNow()
    }
  })

  canvas.addEventListener("contextmenu", event => event.preventDefault())

  canvas.addEventListener("wheel", event => {
    event.preventDefault()
    stage.zoomBy(Math.exp(event.deltaY * 0.0012))
    void renderNow()
  }, { passive: false })

  // Global Workbench Keyboard Controller
  window.addEventListener("keydown", event => {
    const target = event.composedPath()[0]
    const inText =
      target instanceof HTMLInputElement && (target.type === "text" || target.type === "search" || target.type === "number") ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)

    const key = event.key.toLowerCase()
    const cmd = event.metaKey || event.ctrlKey

    // Modal Escape
    if (!modalBackdrop.hidden) {
      if (event.key === "Escape") {
        event.preventDefault()
        closePresetModal()
      }
      return
    }

    // Cmd/Ctrl-K opens library search palette from anywhere outside text editing
    if (cmd && key === "k") {
      event.preventDefault()
      if (mode === "play") setPlayMode("edit")
      if (root.dataset.closed === "true") panel.toggle()
      searchInput.focus()
      searchInput.select()
      return
    }

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

    // Play Mode: Only Escape exits Play and releases held input; all other keys belong to gameplay
    if (mode === "play") {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopImmediatePropagation()
        setPlayMode("edit")
      }
      return
    }

    // If focus is inside the Inspector (LabPanel), let LabPanel's own capture handler own the keys
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

    if (movingObject) {
      const sec = activeSection()
      const step = event.shiftKey ? 2 : event.altKey ? 0.1 : 0.5
      if (event.key === "Escape") {
        event.preventDefault()
        sec.moveObject?.(movingObject.id, movingObject.origX, movingObject.origZ, movingObject.origYaw)
        movingObject = null
        panel.sync()
        syncChrome()
        void renderNow()
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        recordHistory(`Move ${movingObject.id}`, movingObject.before)
        movingObject = null
        panel.sync()
        syncChrome()
        void renderNow()
        return
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault()
        const obj = sec.objects?.().find(o => o.id === movingObject!.id)
        if (obj) {
          const nx = obj.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0)
          const nz = obj.z + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0)
          sec.moveObject?.(obj.id, nx, nz, obj.yaw)
          panel.sync()
          syncChrome()
          void renderNow()
        }
        return
      }
    }

    // Edit Mode Canvas / Library Shortcuts
    const sec = activeSection()
    if (event.key === "/") {
      event.preventDefault()
      searchInput.focus()
      searchInput.select()
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
      panel.sync()
      syncChrome()
      void renderNow()
    } else if (key === "p" && !event.repeat) {
      event.preventDefault()
      setPlayMode("play")
    } else if (key === "f" && !event.repeat) {
      event.preventDefault()
      frameActiveTarget()
    } else if (key === "r" && !event.repeat) {
      event.preventDefault()
      if (sec.reroll) {
        const before = captureSnapshot()
        sec.reroll()
        recordHistory("Reroll room seed", before)
        panel.sync()
        syncChrome()
        void renderNow()
      }
    } else if ((key === "q" || key === "e") && !event.repeat) {
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
      activeCategory = "objects"
      if (globalSettings.section !== "spawn" && spawn) selectSection("spawn")
      if (spawn) {
        const item = String(spawn.section.settings.item || "cone")
        spawn.setGhost({ category: "prop", kind: item, x: 0, y: yardGround(0, 2), z: 2, yaw: 0, shape: "one", valid: true })
      }
      syncChrome()
      void renderNow()
    } else if (key === "g" && !event.repeat) {
      const objs = sec.objects?.() ?? []
      const sel = (sec.selectedObjectId ? objs.find(o => o.id === sec.selectedObjectId) : objs[0])
      if (sel && sel.movable) {
        event.preventDefault()
        movingObject = { id: sel.id, origX: sel.x, origZ: sel.z, origYaw: sel.yaw, before: captureSnapshot() }
        syncChrome()
      }
    } else if ((event.key === "Delete" || event.key === "Backspace") && !event.repeat) {
      const selId = sec.selectedObjectId
      const sel = selId ? sec.objects?.().find(o => o.id === selId) : null
      if (sel && sel.deletable && sec.deleteObject) {
        event.preventDefault()
        const before = captureSnapshot()
        if (sec.deleteObject(sel.id)) {
          recordHistory(`Delete ${sel.label}`, before)
          panel.sync()
          syncChrome()
          void renderNow()
        }
      }
    } else if (cmd && key === "d" && !event.repeat) {
      const selId = sec.selectedObjectId
      if (selId && sec.duplicateObject) {
        event.preventDefault()
        const before = captureSnapshot()
        const dupId = sec.duplicateObject(selId)
        if (dupId) {
          recordHistory("Duplicate object", before)
          panel.sync()
          syncChrome()
          void renderNow()
        }
      }
    } else if (["1", "2", "3", "4"].includes(event.key) && !event.repeat) {
      event.preventDefault()
      const map: Record<string, CatalogCategory> = { "1": "effects", "2": "objects", "3": "lighting", "4": "audio" }
      activeCategory = map[event.key]!
      syncChrome()
    }
  })

  return {
    get mode() {
      return mode
    },
    get speed() {
      return simSpeed
    },
    onTick(dt: number) {
      const sec = activeSection()
      const playing = "playing" in sec.settings ? Boolean(sec.settings.playing) : true
      if (playing) {
        elapsed += dt * simSpeed
        frames += 1
        timeReadout.textContent = `${elapsed.toFixed(2)}s · f${frames}`
      }
      syncStageMarkers()
    },
    onSectionChanged() {
      elapsed = 0
      frames = 0
      hoveredObjectId = null
      movingObject = null
      if (mode === "play" && globalSettings.section !== "spawn") {
        setPlayMode("edit")
      }
      panel.setReturnFocus(canvas)
      syncChrome()
    },
    onPanelTransaction(label: string, beforeSettings: LabSettings) {
      const beforeSnap = captureSnapshot()
      const secId = globalSettings.section
      if (secId === "lighting") {
        for (const [k, v] of Object.entries(beforeSettings)) {
          if (k in beforeSnap.lighting) beforeSnap.lighting[k] = v
        }
      } else if (beforeSnap.sections[secId]) {
        for (const [k, v] of Object.entries(beforeSettings)) {
          if (k in beforeSnap.sections[secId]!) beforeSnap.sections[secId]![k] = v
        }
      }
      const afterSnap = captureSnapshot()
      if (JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap)) {
        undoStack.push({ label, before: beforeSnap, after: afterSnap })
        if (undoStack.length > 50) undoStack.shift()
        redoStack.length = 0
      }
      const sec = activeSection()
      if (!isBench && (sec.id === "blackout-effects" || sec.id === "getaway-effects")) {
        sec.retrigger?.()
      }
      syncChrome()
      void renderNow()
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
    recordHistory,
    captureSnapshot,
    undo,
    redo,
    applyPresetJson,
    exportPresetJson: () => JSON.stringify(buildPresetPayload(), null, 2),
    setPlayMode,
    frameActiveTarget,
    syncChrome,
  }
}
