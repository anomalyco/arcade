export const ATLAS_SIZE = 2048

const quantizePx = (px: number) => Math.round(px * 4) / 4
const quantizeWeight = (weight: number) => Math.round(weight / 10) * 10

export interface AtlasEntry {
  readonly uv: readonly [number, number, number, number]
  readonly w: number
  readonly h: number
  readonly pad: number
  readonly textW: number
}

export class LabelAtlas {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly map = new Map<string, AtlasEntry>()
  private lx = 0
  private ly = 0
  private rowH = 0
  private dirty = false
  private dirtyY0 = ATLAS_SIZE
  private dirtyY1 = 0
  private currentScale = 0

  // A connected canvas element, because 2D text only honours `-webkit-font-smoothing` through the
  // element's style: an OffscreenCanvas draws with macOS font smoothing, visibly bolder than the DOM.
  constructor(private readonly doc: Document) {
    const c = doc.createElement("canvas")
    c.width = ATLAS_SIZE
    c.height = ATLAS_SIZE
    c.setAttribute("aria-hidden", "true")
    c.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;contain:strict;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;font-feature-settings:'tnum';"
    this.canvas = c
    this.ctx = c.getContext("2d")!
  }

  private attach() {
    if (!this.canvas.isConnected) this.doc.body.append(this.canvas)
  }

  detach() {
    this.canvas.remove()
  }

  clear() {
    this.lx = 0
    this.ly = 0
    this.rowH = 0
    this.map.clear()
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)
    this.dirty = true
    this.dirtyY0 = 0
    this.dirtyY1 = ATLAS_SIZE
  }

  /** Glyphs are rasterized at the canvas's own device-pixel ratio so they blit 1:1. */
  ensureScale(scale: number) {
    const quantized = Math.max(1, Math.min(4, Math.round(scale * 4) / 4))
    if (this.currentScale !== quantized) {
      this.currentScale = quantized
      this.clear()
    }
    return quantized
  }

  /**
   * Starts a frame: a nearly full atlas is cleared now rather than midway through a frame, which
   * would strand glyphs already placed. Gliding font sizes and weights fill it fastest.
   */
  beginFrame() {
    if (this.ly > ATLAS_SIZE * 0.7) this.clear()
  }

  get(
    text: string,
    rawPx: number,
    rawWeight: number,
    family: string,
    scaleFactor = 2,
    letterSpacingEm = 0,
  ): AtlasEntry {
    const scale = this.ensureScale(scaleFactor)
    // A gliding size or weight rasterizes at quarter-pixel and 10-unit steps, not every frame.
    const px = quantizePx(rawPx)
    const weight = quantizeWeight(rawWeight)
    const key = `${text}|${px}|${weight}|${family}|${scale}|${letterSpacingEm}`
    const hit = this.map.get(key)
    if (hit) return hit
    this.attach()

    // The font is set at its CSS size and scaled by the transform: a larger font size would pick
    // a different optical size (SF Pro Display instead of Text), which reads bolder and tighter.
    const ctx = this.ctx
    ctx.font = `${weight} ${px}px ${family}`
    if ("letterSpacing" in ctx) {
      ;(ctx as any).letterSpacing = `${letterSpacingEm * px}px`
    }
    if ("fontKerning" in ctx) {
      ;(ctx as any).fontKerning = "normal"
    }

    const pad = Math.ceil(4 * scale)
    const measuredW = ctx.measureText(text).width * scale
    const w = Math.min(ATLAS_SIZE - 8, Math.max(4, Math.ceil(measuredW) + pad * 2))
    // Even heights keep the text's middle on a whole device pixel.
    const h = Math.max(4, 2 * Math.ceil((px * scale * 1.35) / 2) + pad * 2)

    if (this.lx + w > ATLAS_SIZE) {
      this.lx = 0
      this.ly += this.rowH + 2
      this.rowH = 0
    }
    if (this.ly + h > ATLAS_SIZE) {
      this.clear()
    }
    this.rowH = Math.max(this.rowH, h)

    ctx.save()
    ctx.setTransform(scale, 0, 0, scale, this.lx + pad, this.ly + h * 0.5)
    ctx.fillStyle = "#ffffff"
    ctx.textBaseline = "middle"
    ctx.textAlign = "left"
    ctx.fillText(text, 0, 0)
    ctx.restore()

    const entry: AtlasEntry = {
      uv: [
        this.lx / ATLAS_SIZE,
        this.ly / ATLAS_SIZE,
        (this.lx + w) / ATLAS_SIZE,
        (this.ly + h) / ATLAS_SIZE,
      ],
      w: w / scale,
      h: h / scale,
      pad: pad / scale,
      textW: measuredW / scale,
    }

    this.dirtyY0 = Math.min(this.dirtyY0, this.ly)
    this.dirtyY1 = Math.max(this.dirtyY1, this.ly + h)
    this.lx += w + 2
    this.map.set(key, entry)
    this.dirty = true
    return entry
  }

  private readonly widths = new Map<string, number>()
  /** Advance width (CSS px) of `text`, measured with the browser's shaping, without rasterizing. */
  measure(text: string, rawPx: number, rawWeight: number, family: string): number {
    const px = quantizePx(rawPx)
    const weight = quantizeWeight(rawWeight)
    const key = `${text}|${px}|${weight}|${family}`
    const hit = this.widths.get(key)
    if (hit !== undefined) return hit
    this.attach()
    const ctx = this.ctx
    ctx.font = `${weight} ${px}px ${family}`
    if ("letterSpacing" in ctx) (ctx as any).letterSpacing = "0px"
    if ("fontKerning" in ctx) (ctx as any).fontKerning = "normal"
    const w = ctx.measureText(text).width
    if (this.widths.size > 4096) this.widths.clear()
    this.widths.set(key, w)
    return w
  }

  /** Rasterizes a 256×256 SVG path (Phosphor) at `px` CSS pixels into the atlas. */
  icon(path: string, px: number, scaleFactor = 3): AtlasEntry {
    const scale = this.ensureScale(scaleFactor)
    const key = `icon|${path.length}|${path.slice(0, 24)}|${px}|${scale}`
    const hit = this.map.get(key)
    if (hit) return hit
    this.attach()
    const pad = Math.ceil(2 * scale)
    const size = Math.ceil(px * scale)
    const w = size + pad * 2
    const h = w
    if (this.lx + w > ATLAS_SIZE) {
      this.lx = 0
      this.ly += this.rowH + 2
      this.rowH = 0
    }
    if (this.ly + h > ATLAS_SIZE) this.clear()
    this.rowH = Math.max(this.rowH, h)
    const ctx = this.ctx
    ctx.save()
    ctx.translate(this.lx + pad, this.ly + pad)
    ctx.scale(size / 256, size / 256)
    ctx.fillStyle = "#ffffff"
    ctx.fill(new Path2D(path))
    ctx.restore()
    const entry: AtlasEntry = {
      uv: [
        this.lx / ATLAS_SIZE,
        this.ly / ATLAS_SIZE,
        (this.lx + w) / ATLAS_SIZE,
        (this.ly + h) / ATLAS_SIZE,
      ],
      w: w / scale,
      h: h / scale,
      pad: pad / scale,
      textW: px,
    }
    this.dirtyY0 = Math.min(this.dirtyY0, this.ly)
    this.dirtyY1 = Math.max(this.dirtyY1, this.ly + h)
    this.lx += w + 2
    this.map.set(key, entry)
    this.dirty = true
    return entry
  }

  get isDirty() {
    return this.dirty
  }

  flush(device: any, texture: any) {
    if (!this.dirty) return
    const y0 = Math.max(0, Math.min(ATLAS_SIZE - 1, this.dirtyY0))
    const y1 = Math.max(y0 + 1, Math.min(ATLAS_SIZE, this.dirtyY1))
    device.queue.copyExternalImageToTexture(
      { source: this.canvas, origin: [0, y0] },
      { texture, origin: [0, y0] },
      [ATLAS_SIZE, y1 - y0],
    )
    this.dirty = false
    this.dirtyY0 = ATLAS_SIZE
    this.dirtyY1 = 0
  }
}
