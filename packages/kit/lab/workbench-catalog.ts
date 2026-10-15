import { LOOK_PRESETS, LOOK_PRESET_IDS } from "../gpu/look"
import type { LabPanel } from "../lab-panel"
import { effectOptions } from "./effects"
import { sectionLibraryCategory } from "./library"
import type { LookLabController } from "./looks"
import type { createSpawn } from "./spawn"
import type { Stage } from "./stage"
import type { LabSection } from "./types"
import { LIGHTING_LOOKS, type CatalogEntry, type FullSnapshot } from "./workbench-types"
import { yardGround } from "./yard"

export interface WorkbenchCatalogContext {
  sections: readonly LabSection[]
  globalSettings: { section: string; debug: number }
  activeSection: () => LabSection
  selectSection: (id: string) => void
  stage: Stage
  panel: LabPanel
  spawn?: ReturnType<typeof createSpawn>
  looks?: LookLabController
  isBench: boolean
  getActiveCatalogId: () => string
  setActiveCatalogId: (id: string) => void
  frameActiveTarget: () => void
  captureSnapshot: () => FullSnapshot
  recordHistory: (label: string, before: FullSnapshot) => void
  renderNow: () => Promise<unknown>
  showToast: (message: string, isError?: boolean) => void
}

export function buildWorkbenchCatalog(ctx: WorkbenchCatalogContext): CatalogEntry[] {
  const {
    sections,
    globalSettings,
    activeSection,
    selectSection,
    stage,
    panel,
    spawn,
    looks,
    isBench,
    getActiveCatalogId,
    setActiveCatalogId,
    frameActiveTarget,
    captureSnapshot,
    recordHistory,
    renderNow,
    showToast,
  } = ctx
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
      isActive: () => getActiveCatalogId() === "fixture:smoke-room",
      run: () => {
        setActiveCatalogId("fixture:smoke-room")
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
      isActive: () => getActiveCatalogId() === "fixture:glass-pane",
      run: () => {
        setActiveCatalogId("fixture:glass-pane")
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
      isActive: () => getActiveCatalogId() === "fixture:paper-desk",
      run: () => {
        setActiveCatalogId("fixture:paper-desk")
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
      isActive: () => getActiveCatalogId() === "fixture:car-cones",
      run: () => {
        setActiveCatalogId("fixture:car-cones")
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
      isActive: () => getActiveCatalogId() === "fixture:flame-hydrant",
      run: () => {
        setActiveCatalogId("fixture:flame-hydrant")
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
      isActive: () => getActiveCatalogId() === "fixture:audio-audition",
      run: fromUser => {
        setActiveCatalogId("fixture:audio-audition")
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
        setActiveCatalogId("fixture:outbreak-vignette")
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
            setActiveCatalogId(id)
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
        setActiveCatalogId(id)
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
          setActiveCatalogId(id)
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
          setActiveCatalogId(id)
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
          setActiveCatalogId(id)
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
          setActiveCatalogId(id)
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
            setActiveCatalogId(id)
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

  const rugsSec = sections.find(s => s.id === "rugs")
  if (rugsSec) {
    const styleCtrl = rugsSec.controls.find(c => c.key === "style" && "options" in c)
    if (styleCtrl && "options" in styleCtrl) {
      for (const opt of styleCtrl.options) {
        const id = `rug-style:${opt.value}`
        entries.push({
          id,
          label: `${opt.label} rug`,
          group: "Rugs",
          category: "materials",
          collection: "shared",
          tag: "Rug",
          sectionId: "rugs",
          isActive: () => globalSettings.section === "rugs" && rugsSec.settings.view === "single" && rugsSec.settings.style === opt.value,
          run: () => {
            setActiveCatalogId(id)
            if (globalSettings.section !== "rugs") selectSection("rugs")
            const view = rugsSec.controls.find(ctrl => ctrl.key === "view")
            if (view) panel.navigation.set(view, "single")
            panel.navigation.set(styleCtrl, opt.value)
            frameActiveTarget()
          },
        })
      }
    }
    entries.push({
      id: "section:rugs",
      label: "Rug Inspector",
      group: "Rugs",
      category: "materials",
      collection: "shared",
      tag: "Rug",
      sectionId: "rugs",
      isActive: () => globalSettings.section === "rugs",
      run: () => selectSection("rugs"),
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
          setActiveCatalogId(id)
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
      // Not the active section: a Foliage, Looks or Materials section id would move these into that drawer tab.
      sectionId: "lighting",
      isActive: () => getActiveCatalogId() === id,
      run: () => {
        const before = captureSnapshot()
        setActiveCatalogId(id)
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
            setActiveCatalogId(id)
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
            setActiveCatalogId(id)
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
          setActiveCatalogId(id)
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
