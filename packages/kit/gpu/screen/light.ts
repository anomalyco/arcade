import type { SceneLight } from "../scene-frame"
import type { ScreenDisplaySettings, ScreenLightShape } from "./settings"

/**
 * The screen as a light. The display copies a coarse mip of its signal (about 4×3 texels) into a ring of mappable
 * buffers each frame and reads whichever finished last, so the CPU never waits on the GPU: the light lags the picture
 * by one to three frames. `ScreenLightProbe` holds that average; `screenSceneLight` turns it, with the power state and
 * peak white, into a kit `SceneLight` the room is lit by.
 */
export class ScreenLightProbe {
  /** Average linear colour of the picture (signal units, 1 = full white), from the last finished readback. */
  readonly average: [number, number, number] = [0, 0, 0]
  /** The coarse mip's cells (rgb per cell, row-major), for a light that leans toward one side of the picture. */
  cells = new Float32Array(0)
  cols = 0
  rows = 0
  /** Readbacks finished so far. */
  samples = 0
  private readonly listeners = new Set<(probe: ScreenLightProbe) => void>()

  /** Takes one readback: `rgb` holds `cols × rows` cells of three floats. */
  push(rgb: Float32Array, cols: number, rows: number): void {
    if (this.cells.length !== rgb.length) this.cells = new Float32Array(rgb.length)
    this.cells.set(rgb)
    this.cols = cols
    this.rows = rows
    let r = 0, g = 0, b = 0
    const n = Math.max(1, cols * rows)
    for (let i = 0; i < n; i++) { r += rgb[i * 3]!; g += rgb[i * 3 + 1]!; b += rgb[i * 3 + 2]! }
    this.average[0] = r / n
    this.average[1] = g / n
    this.average[2] = b / n
    this.samples++
    for (const fn of this.listeners) fn(this)
  }

  /** Called after every readback; returns an unsubscribe. */
  subscribe(fn: (probe: ScreenLightProbe) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Luminance of the average picture (Rec. 709 weights). */
  luminance(): number {
    return 0.2126 * this.average[0] + 0.7152 * this.average[1] + 0.0722 * this.average[2]
  }

  /** Horizontal balance of the picture's light, −1 all on the left … 1 all on the right. */
  balance(): number {
    if (!this.cols) return 0
    let left = 0, right = 0
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
      const i = (y * this.cols + x) * 3
      const l = 0.2126 * this.cells[i]! + 0.7152 * this.cells[i + 1]! + 0.0722 * this.cells[i + 2]!
      const w = (x + 0.5) / this.cols * 2 - 1
      if (w < 0) left += l * -w
      else right += l * w
    }
    return left + right > 1e-6 ? (right - left) / (left + right) : 0
  }
}

/** Where a screen is in the world: the glass centre, the direction it faces (yaw in xz) and its visible size (m). */
export type ScreenPlacement = {
  center: readonly [number, number, number]
  /** The glass faces `(cos yaw, 0, sin yaw)`. */
  yaw: number
  width: number
  height: number
}

/** What a game's lighting needs from a display this frame. */
export type ScreenEmitter = {
  readonly settings: ScreenDisplaySettings
  /** Average emitted radiance now (linear rgb, scene units): the picture × peak white × power. */
  emission(): readonly [number, number, number]
}

/** The kit physical model's light gain (`GAIN` in `gpu/shaders.ts`): a light's intensity is `power × GAIN`. */
const GAIN = 5

export type ScreenLightOptions = {
  /** `physical`: an upright area panel (`physicalLightHooks({ panel: true })`) or a cosine spot; `today`: a plan cone. */
  model?: "physical" | "today"
  /** Overrides the display's `lightShape`. */
  shape?: ScreenLightShape
  id?: number
  /** × on top of the display's `light` knob. */
  gain?: number
  /** Shadow softness (fixture size, m). Default: half the screen's height. */
  size?: number
}

/**
 * The screen's practical light, or null while it's dark. Physically: a Lambertian panel of radiance L and area A has
 * on-axis intensity L·A, so a white wall 2 m in front of a 150-nit set is lit about 1/150 as bright as the picture, as
 * in a real room; `light` scales that. Plan coordinates are the kit's (`x`, `y` = world z, `h` = height).
 */
export function screenSceneLight(display: ScreenEmitter, at: ScreenPlacement, opts: ScreenLightOptions = {}): SceneLight | null {
  const s = display.settings
  const e = display.emission()
  const peak = Math.max(e[0], e[1], e[2])
  const k = s.light * (opts.gain ?? 1)
  if (!(peak > 1e-5) || !(k > 0)) return null
  const area = at.width * at.height
  const nx = Math.cos(at.yaw), nz = Math.sin(at.yaw)
  const model = opts.model ?? "physical"
  const shape = opts.shape ?? s.lightShape
  const base: SceneLight = {
    x: at.center[0], y: at.center[2], h: at.center[1], r: s.lightRange,
    color: [e[0] / peak, e[1] / peak, e[2] / peak],
    power: peak * area * k / GAIN,
    size: opts.size ?? at.height * 0.5,
    ...(opts.id !== undefined ? { id: opts.id } : {}),
  }
  if (model === "today") {
    // Today's plan cone: a wide fan in front of the screen, at the brightness a lamp of this size would have.
    return { ...base, x: base.x + nx * 0.05, y: base.y + nz * 0.05, power: peak * Math.sqrt(area) * k * 0.6, cone: [nx, nz, Math.cos(1.35)] }
  }
  if (shape === "panel") return { ...base, panel: { halfWidth: at.width / 2, halfHeight: at.height / 2, yaw: at.yaw } }
  // A level spot whose smooth cone falls from full on-axis to nothing at 90°: close to a Lambertian lobe.
  return { ...base, x: base.x + nx * 0.02, y: base.y + nz * 0.02, spot: { axis: [nx, 0, nz], cosOuter: 0, cosInner: 0.85 } }
}

/**
 * For baked lighting: the live scale of a light's baked bounce. A lightmap baker that baked a screen's indirect light
 * at `reference` (average emitted radiance, scene units) multiplies that light's baked contribution by `scale()` each
 * frame, so the room's bounce follows the picture as its direct light does. `id` is the `SceneLight.id` it baked.
 */
export type LiveBounceSource = { readonly id: number; scale(): number; color(): readonly [number, number, number] }

export function screenBounceSource(display: ScreenEmitter, id: number, reference = 1): LiveBounceSource {
  const lum = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
  return {
    id,
    scale: () => (lum(display.emission()) * display.settings.light) / Math.max(reference, 1e-6),
    color: () => {
      const e = display.emission(), m = Math.max(e[0], e[1], e[2], 1e-6)
      return [e[0] / m, e[1] / m, e[2] / m]
    },
  }
}

/** Decodes IEEE half floats (the readback of an rgba16float mip). */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + f / 1024)
}
