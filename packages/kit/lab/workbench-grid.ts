import { applyLookPreset, resolveLookPresetId, type LookSettings } from "../gpu/look"
import type { LabValue } from "../lab-panel"
import { applyWeatherPreset, resolveWeatherPresetId, type WeatherSettings } from "../weather"
import type { createEffects } from "./effects"
import type { createSpawn } from "./spawn"
import type { Stage } from "./stage"
import type { LabContext, LabSection } from "./types"
import { computeVariationGridLayout, summarizeTileSettings, type VariationGridConfig, type VariationTileConfig } from "./variation-grid"

export function applyTileSettingsToSection(sec: LabSection, tile: VariationTileConfig, stage: Stage) {
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

export async function renderVariationGridPass(opts: {
  config: VariationGridConfig
  sec: LabSection
  stage: Stage
  context: LabContext
  spawn?: ReturnType<typeof createSpawn>
  effects?: ReturnType<typeof createEffects>
  width: number
  height: number
  debug: number
}): Promise<number> {
  const { config, sec, stage, context, spawn, effects, width, height, debug } = opts
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

      applyTileSettingsToSection(sec, tile, stage)

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
  }

  return performance.now() - t0
}

export function drawVariationGridOverlayToCanvas(
  target: HTMLCanvasElement,
  variationGrid: VariationGridConfig | null,
  focusedGridTile: number | null,
) {
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
