import type { LabValue } from "../lab-panel"
import { LOOK_PRESETS } from "../gpu/look"
import { MATERIAL_RECIPES } from "../gpu/surface-materials"
import { FOLIAGE_PRESETS } from "../gpu/foliage"
import { WEATHER_PRESETS } from "../weather"

export type VariationTileConfig = {
  id?: string
  label: string
  subtitle?: string
  preset?: string
  settings?: Record<string, LabValue>
  lighting?: Record<string, LabValue>
}

export type VariationGridConfig = {
  id: string
  title: string
  section: string
  cols: number
  rows: number
  tiles: VariationTileConfig[]
}

export type VariationTileRect = {
  index: number
  tileNumber: number
  col: number
  row: number
  x: number
  y: number
  width: number
  height: number
}

export type VariationGridLayout = {
  cols: number
  rows: number
  canvasWidth: number
  canvasHeight: number
  tileWidth: number
  tileHeight: number
  rects: VariationTileRect[]
}

export function defaultColsForTileCount(count: number): number {
  if (count <= 2) return 2
  if (count === 3) return 3
  if (count === 4) return 2
  return 3
}

export function computeVariationGridLayout(
  tileCount: number,
  canvasWidth: number,
  canvasHeight: number,
  preferredCols?: number,
): VariationGridLayout {
  const n = Math.max(2, Math.min(9, Math.round(tileCount)))
  const cols = preferredCols && preferredCols >= 1 && preferredCols <= 4 ? Math.round(preferredCols) : defaultColsForTileCount(n)
  const rows = Math.max(1, Math.ceil(n / cols))
  const cw = Math.max(64, Math.floor(canvasWidth))
  const ch = Math.max(64, Math.floor(canvasHeight))
  const tileWidth = Math.max(32, Math.floor(cw / cols))
  const tileHeight = Math.max(32, Math.floor(ch / rows))

  const rects: VariationTileRect[] = []
  for (let i = 0; i < n; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = col * tileWidth
    const y = row * tileHeight
    const w = col === cols - 1 ? Math.max(32, cw - x) : tileWidth
    const h = row === rows - 1 ? Math.max(32, ch - y) : tileHeight
    rects.push({
      index: i,
      tileNumber: i + 1,
      col,
      row,
      x,
      y,
      width: w,
      height: h,
    })
  }

  return {
    cols,
    rows,
    canvasWidth: cw,
    canvasHeight: ch,
    tileWidth,
    tileHeight,
    rects,
  }
}

export function pickVariationGridTileAt(
  layout: VariationGridLayout,
  localX: number,
  localY: number,
): VariationTileRect | null {
  for (const r of layout.rects) {
    if (localX >= r.x && localX < r.x + r.width && localY >= r.y && localY < r.y + r.height) {
      return r
    }
  }
  return null
}

export function summarizeTileSettings(tile: VariationTileConfig): string {
  if (tile.subtitle) return tile.subtitle
  const parts: string[] = []
  if (tile.preset) parts.push(`preset: ${tile.preset}`)
  if (tile.settings) {
    for (const [k, v] of Object.entries(tile.settings)) {
      if (k === "playing" || k === "loop" || k === "interval") continue
      parts.push(`${k}: ${typeof v === "number" ? Number(v.toFixed(2)) : String(v)}`)
      if (parts.length >= 4) break
    }
  }
  if (tile.lighting && parts.length < 4) {
    for (const [k, v] of Object.entries(tile.lighting)) {
      parts.push(`${k}: ${typeof v === "number" ? Number(v.toFixed(2)) : String(v)}`)
      if (parts.length >= 4) break
    }
  }
  return parts.join(" · ")
}

export const VARIATION_GRID_PRESETS: Record<string, VariationGridConfig> = {
  looks: {
    id: "looks",
    title: "Looks · 6 Style Directions",
    section: "looks",
    cols: 3,
    rows: 2,
    tiles: [
      {
        id: "current",
        label: LOOK_PRESETS.current.label,
        preset: "current",
        settings: { preset: "current", compare: 1 },
        subtitle: "Neutral baseline · ACES tonemap",
      },
      {
        id: "noir",
        label: LOOK_PRESETS.noir.label,
        preset: "noir",
        settings: { preset: "noir", compare: 1 },
        subtitle: "Deep shadow · wet floor · window shafts",
      },
      {
        id: "painterly",
        label: LOOK_PRESETS.painterly.label,
        preset: "painterly",
        settings: { preset: "painterly", compare: 1 },
        subtitle: "Kuwahara brush · ink outlines · gouache",
      },
      {
        id: "cinematic_dusk",
        label: LOOK_PRESETS.cinematic_dusk.label,
        preset: "cinematic_dusk",
        settings: { preset: "cinematic_dusk", compare: 1 },
        subtitle: "Teal/amber split tone · dusk haze",
      },
      {
        id: "sodium_70s",
        label: LOOK_PRESETS.sodium_70s.label,
        preset: "sodium_70s",
        settings: { preset: "sodium_70s", compare: 1 },
        subtitle: "Amber sodium vapor · halation · grain",
      },
      {
        id: "cozy_golden_hour",
        label: LOOK_PRESETS.cozy_golden_hour.label,
        preset: "cozy_golden_hour",
        settings: { preset: "cozy_golden_hour", compare: 1 },
        subtitle: "Warm golden sun · lifted shadows",
      },
    ],
  },
  explosions: {
    id: "explosions",
    title: "Explosion Variants · 4 Live Recipes",
    section: "effects",
    cols: 2,
    rows: 2,
    tiles: [
      {
        id: "standard",
        label: "Standard Blast",
        settings: {
          effect: "explosion",
          loop: true,
          interval: 2.2,
          size: 1.0,
          density: 1.0,
          fireballCount: 28,
          fireballSize: 1.0,
          coreGlow: 1.0,
          sparkCount: 80,
          debrisCount: 32,
          smokeRadius: 4.5,
          extinction: 1.4,
        },
        subtitle: "fireball 1.0× · 80 sparks · 4.5m smoke",
      },
      {
        id: "heavy-fireball",
        label: "Heavy Fireball",
        settings: {
          effect: "explosion",
          loop: true,
          interval: 2.2,
          size: 1.35,
          density: 1.2,
          fireballCount: 44,
          fireballSize: 1.5,
          coreGlow: 1.85,
          flashPower: 14,
          flashRadius: 22,
          sparkCount: 55,
          debrisCount: 24,
        },
        subtitle: "fireball 1.5× · glow 1.85× · flash 14",
      },
      {
        id: "dense-soot",
        label: "Dense Soot Column",
        settings: {
          effect: "explosion",
          loop: true,
          interval: 2.2,
          size: 0.95,
          density: 1.45,
          fireballCount: 20,
          fireballSize: 0.85,
          smokeRadius: 5.8,
          height: 4.8,
          extinction: 2.6,
          billowScale: 1.4,
          sparkCount: 40,
        },
        subtitle: "5.8m soot column · extinction 2.6 · 1.45× density",
      },
      {
        id: "shrapnel",
        label: "High-Velocity Shrapnel",
        settings: {
          effect: "explosion",
          loop: true,
          interval: 2.2,
          size: 1.1,
          density: 0.9,
          fireballCount: 24,
          sparkCount: 165,
          sparkSpeed: 18,
          debrisCount: 72,
          blastSpeed: 1.6,
          shockRadius: 6.5,
          scorch: true,
        },
        subtitle: "165 sparks · 72 debris · 6.5m shockwave",
      },
    ],
  },
  smoke: {
    id: "smoke",
    title: "Smoke Variants · 4 Live Plumes",
    section: "effects",
    cols: 2,
    rows: 2,
    tiles: [
      {
        id: "standard-smoke",
        label: "Standard Grenade",
        settings: { effect: "smoke", loop: true, radius: 4.5, height: 2.8, extinction: 1.4, wind: 0.6, turbulence: 0.7 },
        subtitle: "4.5m radius · 2.8m height · 1.4 extinction",
      },
      {
        id: "dense-screen",
        label: "Thick Tactical Screen",
        settings: { effect: "smoke", loop: true, radius: 5.6, height: 3.8, extinction: 2.7, wind: 0.4, turbulence: 1.3 },
        subtitle: "5.6m radius · 3.8m height · 2.7 extinction",
      },
      {
        id: "wind-shear",
        label: "Wind-Sheared Drift",
        settings: { effect: "smoke", loop: true, radius: 4.8, height: 2.1, extinction: 1.3, wind: 2.5, rise: 1.8, turbulence: 1.6 },
        subtitle: "2.5 m/s wind · 1.8 rise · fast shear",
      },
      {
        id: "ground-fog",
        label: "Low Ground Blanket",
        settings: { effect: "smoke", loop: true, radius: 6.5, height: 1.2, softness: 1.8, extinction: 0.85, wind: 0.25 },
        subtitle: "6.5m wide · 1.2m low blanket · soft edge",
      },
    ],
  },
  materials: {
    id: "materials",
    title: "Materials · 6 Surface Recipes",
    section: "materials",
    cols: 3,
    rows: 2,
    tiles: [
      {
        id: "wood_planks",
        label: MATERIAL_RECIPES.wood_planks.label,
        settings: { recipe: "wood_planks", swatch: "ball", compare: 1 },
        subtitle: "Hardwood plank seams & warm grain",
      },
      {
        id: "cobblestone",
        label: MATERIAL_RECIPES.cobblestone.label,
        settings: { recipe: "cobblestone", swatch: "ball", compare: 1 },
        subtitle: "Mortar joints & worn stone bevels",
      },
      {
        id: "plaster_wall",
        label: MATERIAL_RECIPES.plaster_wall.label,
        settings: { recipe: "plaster_wall", swatch: "ball", compare: 1 },
        subtitle: "Matte painted plaster micro-relief",
      },
      {
        id: "asphalt_concrete",
        label: MATERIAL_RECIPES.asphalt_concrete.label,
        settings: { recipe: "asphalt_concrete", swatch: "ball", compare: 1 },
        subtitle: "Crushed aggregate & sidewalk slabs",
      },
      {
        id: "grass_soil",
        label: MATERIAL_RECIPES.grass_soil.label,
        settings: { recipe: "grass_soil", swatch: "ball", compare: 1 },
        subtitle: "Clumped turf blades & damp earth",
      },
      {
        id: "foliage_canopy",
        label: MATERIAL_RECIPES.foliage_canopy.label,
        settings: { recipe: "foliage_canopy", swatch: "ball", compare: 1 },
        subtitle: "Clustered leaf-clump normal response",
      },
    ],
  },
  foliage: {
    id: "foliage",
    title: "Vegetation · 4 Tree Presets",
    section: "foliage",
    cols: 2,
    rows: 2,
    tiles: [
      {
        id: "oak",
        label: FOLIAGE_PRESETS.oak.label,
        settings: { treePreset: "oak", tool: "tree", cameraMode: "close" },
        subtitle: "Spreading crown · dense canopy lobes",
      },
      {
        id: "maple",
        label: FOLIAGE_PRESETS.maple.label,
        settings: { treePreset: "maple", tool: "tree", cameraMode: "close" },
        subtitle: "Rounded crown · warm autumn mix",
      },
      {
        id: "birch",
        label: FOLIAGE_PRESETS.birch.label,
        settings: { treePreset: "birch", tool: "tree", cameraMode: "close" },
        subtitle: "Columnar crown · high porosity",
      },
      {
        id: "pine",
        label: FOLIAGE_PRESETS.pine.label,
        settings: { treePreset: "pine", tool: "tree", cameraMode: "close" },
        subtitle: "Conical needle tiers",
      },
    ],
  },
  lighting: {
    id: "lighting",
    title: "Lighting · 4 Stage Looks",
    section: "lighting",
    cols: 2,
    rows: 2,
    tiles: [
      {
        id: "neutral",
        label: "Neutral Stage",
        lighting: { lamps: true, lampPower: 2, spot: true, spotPower: 4, moonPower: 0.35, exposure: 0, tone: 0, temperature: 0, saturation: 1 },
        subtitle: "2 lamps · spot 4 · neutral 0 EV",
      },
      {
        id: "night_street",
        label: "Night Street",
        lighting: { lamps: true, lampPower: 3.2, spot: true, spotPower: 6, moonPower: 0.18, count: 4, exposure: -0.15, tone: 1, temperature: -0.2, saturation: 1.05 },
        subtitle: "4 lamps · ACES · -0.15 EV · cool -0.2",
      },
      {
        id: "sodium_alley",
        label: "Sodium Alley",
        lighting: { lamps: true, lampPower: 3.6, spot: true, spotPower: 5, moonPower: 0.1, count: 3, exposure: -0.1, tone: 1, temperature: 0.45, saturation: 1.1 },
        subtitle: "3 lamps · warm +0.45 temp · tight spot",
      },
      {
        id: "cold_moon",
        label: "Cold Moon",
        lighting: { lamps: false, lampPower: 0.8, spot: true, spotPower: 3.5, moonPower: 0.85, count: 1, exposure: 0.05, tone: 1, temperature: -0.45, saturation: 0.88 },
        subtitle: "Moon 0.85 · no lamps · cool -0.45",
      },
    ],
  },
  fog: {
    id: "fog",
    title: "Fog of War · 3 Variants",
    section: "outbreak-vignette",
    cols: 3,
    rows: 1,
    tiles: [
      {
        id: "noir-memory-echo",
        label: "1 · Noir Memory + Echo (Default)",
        settings: { directionPreset: 3, fogStyle: 1, fogEdgeSoftness: 0.78, fogMemoryDim: 0.42, fogUnknownGrain: 0.48 },
        subtitle: "5-tap feathered LOS · 42% cold-ash memory · sound ripples",
      },
      {
        id: "stark-cone-pulse",
        label: "2 · Stark Cone + Pulse",
        settings: { directionPreset: 3, fogStyle: 2, fogEdgeSoftness: 0.42, fogMemoryDim: 0.22, fogUnknownGrain: 0.75 },
        subtitle: "Darkwood spotlight cone · 22% deep shroud · Odradek pulse",
      },
      {
        id: "soft-shroud-classic",
        label: "3 · Soft Shroud (Classic)",
        settings: { directionPreset: 3, fogStyle: 0, fogEdgeSoftness: 1.15, fogMemoryDim: 0.68, fogUnknownGrain: 0.15 },
        subtitle: "Gentle peripheral dim (68%) · soft transitions",
      },
    ],
  },
  weather: {
    id: "weather",
    title: "Weather · 6 Atmospheric Presets",
    section: "weather",
    cols: 3,
    rows: 2,
    tiles: [
      {
        id: "clear",
        label: WEATHER_PRESETS.clear.label,
        preset: "clear",
        settings: { preset: "clear", compare: 1 },
        subtitle: "Dry street · zero weather draw overhead",
      },
      {
        id: "drizzle",
        label: WEATHER_PRESETS.drizzle.label,
        preset: "drizzle",
        settings: { preset: "drizzle", compare: 1 },
        subtitle: "Fine mist · damp sheen · light ripples",
      },
      {
        id: "rain",
        label: WEATHER_PRESETS.rain.label,
        preset: "rain",
        settings: { preset: "rain", compare: 1 },
        subtitle: "Lit cone streaks · puddles · eave drips",
      },
      {
        id: "storm",
        label: WEATHER_PRESETS.storm.label,
        preset: "storm",
        settings: { preset: "storm", compare: 1 },
        subtitle: "Wind-slanted downpour · gusts · lightning",
      },
      {
        id: "fog",
        label: WEATHER_PRESETS.fog.label,
        preset: "fog",
        settings: { preset: "fog", compare: 1 },
        subtitle: "Thick mist banks · lamp & beam inscatter",
      },
      {
        id: "snow",
        label: WEATHER_PRESETS.snow.label,
        preset: "snow",
        settings: { preset: "snow", compare: 1 },
        subtitle: "Fluttering snowflakes · frost cover",
      },
    ],
  },
}

const PRESET_ALIASES: Record<string, string> = {
  look: "looks",
  "looks-6": "looks",
  explosion: "explosions",
  "effects-explosion": "explosions",
  "explosion-variants": "explosions",
  "smoke-variants": "smoke",
  material: "materials",
  trees: "foliage",
  light: "lighting",
  "fog-of-war": "fog",
  "outbreak-fog": "fog",
  rain: "weather",
  "weather-6": "weather",
}

export function defaultGridPresetForSection(sectionId: string, effectName?: string): string {
  if (sectionId === "weather") return "weather"
  if (sectionId === "looks") return "looks"
  if (sectionId === "outbreak-vignette") return "fog"
  if (sectionId === "materials") return "materials"
  if (sectionId === "foliage") return "foliage"
  if (sectionId === "lighting") return "lighting"
  if (sectionId === "effects") {
    return effectName === "smoke" ? "smoke" : "explosions"
  }
  return "looks"
}

export function resolveVariationGridConfig(
  raw: Record<string, unknown> | undefined,
  activeSectionId: string,
  activeEffectName?: string,
): VariationGridConfig {
  const input = raw ?? {}
  const rawPreset = typeof input.preset === "string" ? input.preset.trim().toLowerCase() : ""
  const presetKey = PRESET_ALIASES[rawPreset] ?? rawPreset

  if (presetKey && presetKey in VARIATION_GRID_PRESETS && !Array.isArray(input.tiles)) {
    const base = VARIATION_GRID_PRESETS[presetKey]!
    return {
      ...base,
      tiles: base.tiles.map(t => ({
        ...t,
        ...(t.settings ? { settings: { ...t.settings } } : {}),
        ...(t.lighting ? { lighting: { ...t.lighting } } : {}),
      })),
    }
  }

  if (Array.isArray(input.tiles) && input.tiles.length > 0) {
    if (input.tiles.length < 2 || input.tiles.length > 9) {
      throw new Error(`Variation grid requires between 2 and 9 tiles (got ${input.tiles.length}).`)
    }
    const section = typeof input.section === "string" && input.section.trim() ? input.section.trim() : activeSectionId
    const tiles: VariationTileConfig[] = input.tiles.map((item, idx) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Grid tile ${idx + 1} must be an object.`)
      }
      const t = item as Record<string, unknown>
      const label =
        typeof t.label === "string" && t.label.trim()
          ? t.label.trim()
          : typeof t.title === "string" && t.title.trim()
            ? t.title.trim()
            : `Variant ${idx + 1}`
      const preset = typeof t.preset === "string" && t.preset.trim() ? t.preset.trim() : undefined
      const subtitle = typeof t.subtitle === "string" && t.subtitle.trim() ? t.subtitle.trim() : undefined
      const settings =
        t.settings && typeof t.settings === "object" && !Array.isArray(t.settings)
          ? ({ ...(t.settings as Record<string, LabValue>) } as Record<string, LabValue>)
          : preset
            ? ({ preset } as Record<string, LabValue>)
            : undefined
      const lighting =
        t.lighting && typeof t.lighting === "object" && !Array.isArray(t.lighting)
          ? ({ ...(t.lighting as Record<string, LabValue>) } as Record<string, LabValue>)
          : undefined
      return {
        id: typeof t.id === "string" ? t.id : `tile-${idx + 1}`,
        label,
        ...(subtitle ? { subtitle } : {}),
        ...(preset ? { preset } : {}),
        ...(settings ? { settings } : {}),
        ...(lighting ? { lighting } : {}),
      }
    })
    const cols =
      typeof input.cols === "number" && input.cols >= 1 && input.cols <= 4
        ? Math.round(input.cols)
        : defaultColsForTileCount(tiles.length)
    const rows = Math.max(1, Math.ceil(tiles.length / cols))
    return {
      id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : "custom",
      title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : `Variation Grid (${tiles.length} tiles)`,
      section,
      cols,
      rows,
      tiles,
    }
  }

  if (rawPreset && !(presetKey in VARIATION_GRID_PRESETS)) {
    throw new Error(
      `Unknown variation grid preset "${String(input.preset)}". Valid presets: ${Object.keys(VARIATION_GRID_PRESETS).join(", ")}.`,
    )
  }

  const defKey = defaultGridPresetForSection(activeSectionId, activeEffectName)
  const fallback = VARIATION_GRID_PRESETS[defKey]!
  return {
    ...fallback,
    tiles: fallback.tiles.map(t => ({
      ...t,
      ...(t.settings ? { settings: { ...t.settings } } : {}),
      ...(t.lighting ? { lighting: { ...t.lighting } } : {}),
    })),
  }
}

export function createVariationGridDOM(
  viewportHud: HTMLElement,
  callbacks: {
    onFocusTile: (tileNumber: number | null) => void
    onHoverTile: (tileNumber: number | null) => void
    onCloseGrid: () => void
  },
) {
  const root = document.createElement("div")
  root.className = "lab-grid-overlay"
  root.dataset.labGridOverlay = ""
  root.hidden = true
  viewportHud.append(root)

  let lastSig = ""

  function sync(state: {
    enabled: boolean
    config: VariationGridConfig | null
    focusedTile: number | null
    hoveredTile: number | null
    frameCostMs: number | null
  }) {
    if (!state.enabled || !state.config) {
      root.hidden = true
      lastSig = ""
      return
    }
    root.hidden = false
    const { config, focusedTile, hoveredTile, frameCostMs } = state
    const costBucket = frameCostMs !== null ? frameCostMs.toFixed(1) : "—"
    const sig = JSON.stringify([
      config.id,
      config.title,
      config.cols,
      config.rows,
      config.tiles.map(t => [t.label, summarizeTileSettings(t)]),
      focusedTile,
      hoveredTile,
      costBucket,
    ])
    if (sig === lastSig) return
    lastSig = sig

    root.replaceChildren()
    const total = config.tiles.length

    if (focusedTile !== null && focusedTile >= 1 && focusedTile <= total) {
      root.dataset.view = "focused"
      const tile = config.tiles[focusedTile - 1]!
      const summary = summarizeTileSettings(tile)

      const focusBar = document.createElement("div")
      focusBar.className = "lab-grid-focus-bar"
      focusBar.dataset.gridFocusBar = ""

      const badge = document.createElement("span")
      badge.className = "lab-grid-focus-badge"
      badge.textContent = `${focusedTile}/${total}`

      const title = document.createElement("strong")
      title.className = "lab-grid-focus-title"
      title.textContent = tile.label

      const meta = document.createElement("span")
      meta.className = "lab-grid-focus-meta"
      meta.textContent = summary

      const pills = document.createElement("div")
      pills.className = "lab-grid-focus-pills"
      config.tiles.forEach((t, idx) => {
        const num = idx + 1
        const b = document.createElement("button")
        b.type = "button"
        b.className = "lab-grid-pill"
        b.dataset.gridTileBtn = String(num)
        b.setAttribute("aria-pressed", String(num === focusedTile))
        b.title = `${num}. ${t.label}`
        b.textContent = String(num)
        b.onclick = e => {
          e.stopPropagation()
          callbacks.onFocusTile(num === focusedTile ? null : num)
        }
        pills.append(b)
      })

      const backBtn = document.createElement("button")
      backBtn.type = "button"
      backBtn.className = "lab-grid-action-btn"
      backBtn.dataset.gridAction = "back"
      backBtn.title = "Return to multi-tile variation grid (G or Esc)"
      backBtn.textContent = `⊞ Grid (${config.cols}×${config.rows})`
      backBtn.onclick = e => {
        e.stopPropagation()
        callbacks.onFocusTile(null)
      }

      const closeBtn = document.createElement("button")
      closeBtn.type = "button"
      closeBtn.className = "lab-grid-action-btn"
      closeBtn.dataset.gridAction = "close"
      closeBtn.title = "Exit variation grid"
      closeBtn.textContent = "×"
      closeBtn.onclick = e => {
        e.stopPropagation()
        callbacks.onCloseGrid()
      }

      focusBar.append(badge, title, meta, pills, backBtn, closeBtn)
      root.append(focusBar)
      return
    }

    root.dataset.view = "grid"
    const cols = config.cols
    const rows = config.rows

    const cellsWrap = document.createElement("div")
    cellsWrap.className = "lab-grid-cells"
    cellsWrap.style.setProperty("--grid-cols", String(cols))
    cellsWrap.style.setProperty("--grid-rows", String(rows))

    config.tiles.forEach((tile, idx) => {
      const num = idx + 1
      const col = idx % cols
      const row = Math.floor(idx / cols)
      const cell = document.createElement("div")
      cell.className = "lab-grid-cell"
      cell.dataset.gridTile = String(num)
      cell.dataset.hovered = String(hoveredTile === num)
      cell.style.left = `${(col / cols) * 100}%`
      cell.style.top = `${(row / rows) * 100}%`
      cell.style.width = `${(1 / cols) * 100}%`
      cell.style.height = `${(1 / rows) * 100}%`

      const pill = document.createElement("button")
      pill.type = "button"
      pill.className = "lab-grid-cell-pill"
      pill.dataset.gridTilePill = String(num)
      pill.title = `Click or press ${num} to focus "${tile.label}" full-size`

      const numSpan = document.createElement("span")
      numSpan.className = "lab-grid-num"
      numSpan.textContent = String(num)

      const labelSpan = document.createElement("span")
      labelSpan.className = "lab-grid-label"
      labelSpan.textContent = tile.label

      pill.append(numSpan, labelSpan)
      pill.onclick = e => {
        e.stopPropagation()
        callbacks.onFocusTile(num)
      }

      const summary = summarizeTileSettings(tile)
      const metaEl = document.createElement("div")
      metaEl.className = "lab-grid-meta"
      metaEl.dataset.gridTileMeta = String(num)
      metaEl.textContent = summary

      cell.append(pill, metaEl)
      cellsWrap.append(cell)
    })

    const headerBar = document.createElement("div")
    headerBar.className = "lab-grid-bar"
    headerBar.dataset.gridBar = ""

    const barTitle = document.createElement("span")
    barTitle.className = "lab-grid-bar-title"
    barTitle.textContent = `⊞ ${config.title}`

    const barMeta = document.createElement("span")
    barMeta.className = "lab-grid-bar-meta"
    barMeta.dataset.gridCost = ""
    barMeta.textContent = `${total} tiles (${cols}×${rows}) · ${costBucket} ms · 1–${total} Focus · Esc Close`

    const barClose = document.createElement("button")
    barClose.type = "button"
    barClose.className = "lab-grid-action-btn"
    barClose.dataset.gridAction = "close"
    barClose.title = "Close variation grid (Esc / G)"
    barClose.textContent = "×"
    barClose.onclick = e => {
      e.stopPropagation()
      callbacks.onCloseGrid()
    }

    headerBar.append(barTitle, barMeta, barClose)
    root.append(cellsWrap, headerBar)
  }

  return {
    root,
    sync,
  }
}
