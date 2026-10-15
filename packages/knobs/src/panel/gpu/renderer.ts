import { maxChroma, oklchToRgb } from "../../core/color.js"
import type { RendererMode } from "../../core/store.js"
import { DIE_LOOK, dieBox, type HeaderDie } from "../die.js"
import { ICONS, type IconName } from "../icons.js"
import {
  clamp,
  Edges,
  entranceOffset,
  FILL,
  LEAD,
  numeral,
  POP_MS,
  popScale,
  Spring,
  trailScale,
} from "../motion.js"
import type { MorphFrame } from "../morph.js"
import type { PresetStrip } from "../presets.js"
import { getRevealVersion, isAnyRevealing, isRevealing, isRevealingIn } from "../reveal.js"
import type { Slider } from "../slider.js"
import { livePill } from "../swipe.js"
import { ATLAS_SIZE, LabelAtlas } from "./atlas.js"
import {
  cssMix,
  mixColor,
  readPanelTokens,
  withAlpha,
  type PanelThemeTokens,
  type Rgba,
} from "./color.js"
import { FLOATS_PER_PRIM, panelWgsl } from "./shader.wgsl.js"

/** Tokens whose glide moves layout, so cached rects can't be trusted while they run. */
const LAYOUT_TOKENS = new Set(
  ["width", "pad", "inset", "row", "gap", "font-size", "label-weight"].map((t) => `--kt-${t}`),
)

const MAX_PRIMS = 4096
const MAX_POINTS = 16384
/** Shapes of panels morphing out of their chips this frame (see Mask in the shader). */
const MAX_MASKS = 16
/** An `ease` omega this high places the value at once (a 0 ms token). */
const SNAP_OMEGA = 1e4
type Clip = readonly [number, number, number, number]

/** When a row's motion starts (performance.now() ms), so a preset cascade reaches it in turn. */
export interface RowWave {
  readonly at: number
}
export interface GpuKnobRow {
  readonly kind: "knob"
  readonly key: string
  readonly display: string
  readonly row: HTMLElement
  readonly slider: Slider
  readonly wave: RowWave
  isModified(): boolean
}
export interface GpuChoiceRow {
  readonly kind: "choice"
  readonly key: string
  readonly display: string
  readonly row: HTMLElement
  readonly labelEl: HTMLElement
  readonly segEl: HTMLElement
  readonly buttons: readonly HTMLButtonElement[]
  /** The selected pill's edges (px from the tray's left). */
  readonly pill: Edges
  /** The drop-down button it becomes when the segments don't fit (`data-display="menu"`). */
  readonly menu?: { readonly button: HTMLButtonElement; readonly valueEl: HTMLElement }
  readonly wave: RowWave
  isModified(): boolean
}
export interface GpuToggleRow {
  readonly kind: "toggle"
  readonly key: string
  readonly display: string
  readonly row: HTMLElement
  readonly labelEl: HTMLElement
  readonly toggleEl: HTMLButtonElement
  /** The thumb's edges (px from the track's left). */
  readonly thumb: Edges
  readonly wave: RowWave
  isModified(): boolean
}
/** Geometry getters return element-relative px, the same numbers the DOM draws with. */
export interface GpuSpringRow {
  readonly kind: "spring"
  readonly key: string
  readonly display: string
  readonly row: HTMLElement
  readonly box: HTMLElement
  curve(): readonly number[]
  guides(): readonly number[]
  /** The running dot: start time, the x,y frames it visits evenly over `ms`. */
  dot(): { at: number; frames: readonly number[]; ms: number } | null
  snap(): boolean
  readonly wave: RowWave
  isModified(): boolean
}
export interface GpuExpander {
  readonly head: HTMLElement
  readonly label: HTMLElement
  readonly caret: SVGElement
  readonly body: HTMLElement
  isOpen(): boolean
}
export interface GpuStrip {
  readonly line: HTMLElement
  readonly label: HTMLElement
  readonly track: HTMLElement
  readonly read: HTMLElement
  /** 0 hue, 1 chroma, 2 lightness. */
  mode: number
  thumbX(): number
  dragging(): boolean
}
export interface GpuColorRow {
  readonly kind: "color"
  readonly key: string
  readonly display: string
  readonly row: HTMLElement
  readonly x: GpuExpander
  readonly swatch: HTMLElement
  readonly read: HTMLElement
  readonly strips: readonly GpuStrip[]
  color(): { l: number; c: number; h: number }
  readonly wave: RowWave
  isModified(): boolean
}
export interface GpuPointRow {
  readonly kind: "point"
  readonly key: string
  readonly display: string
  readonly row: HTMLElement
  readonly x: GpuExpander
  readonly read: HTMLElement
  readonly pad: HTMLElement
  puck(): readonly [number, number]
  home(): readonly [number, number]
  dragging(): boolean
  readonly wave: RowWave
  isModified(): boolean
}
export interface GpuEasingRow {
  readonly kind: "easing"
  readonly key: string
  readonly display: string
  readonly row: HTMLElement
  readonly x: GpuExpander
  readonly read: HTMLElement
  readonly mini: SVGElement
  miniCurve(): readonly number[]
  readonly box: HTMLElement
  curve(): readonly number[]
  /** P0, P1, P3, P2: the two arms from the ends to their handles. */
  arms(): readonly number[]
  /** (0,0) and (1,1) in the box. */
  guides(): readonly number[]
  readonly handles: readonly HTMLElement[]
  readonly chips: readonly HTMLButtonElement[]
  snap(): boolean
  readonly wave: RowWave
  isModified(): boolean
}
/** A button row (an action). */
export interface GpuActionRow {
  readonly kind: "action"
  readonly key: string
  readonly display: string
  readonly row: HTMLElement
  readonly button: HTMLButtonElement
  readonly wave: RowWave
  isModified(): boolean
}
export type GpuRowBinding =
  | GpuActionRow
  | GpuKnobRow
  | GpuChoiceRow
  | GpuToggleRow
  | GpuSpringRow
  | GpuColorRow
  | GpuPointRow
  | GpuEasingRow

export interface GpuGroupBinding {
  readonly element: HTMLElement
  readonly labelEl: HTMLElement
  readonly buttons: readonly HTMLButtonElement[]
  readonly reset: HTMLButtonElement
  /** The group's Random die. */
  readonly die?: { readonly button: HTMLButtonElement; readonly die: HeaderDie }
  /** On a page: the header reads as a card title rather than a small-caps label. */
  readonly title?: boolean
  /** On a page: a preset's name, shown in place of the title while its chip is hovered. */
  readonly peek?: HTMLElement
  /** On a page: the group's presets, as named or numbered segments, or a compact menu. */
  readonly presets?: {
    readonly seg: HTMLElement
    readonly buttons: readonly HTMLButtonElement[]
    readonly pill: Edges
    readonly menu?: HTMLButtonElement
    readonly menuValue?: HTMLElement
    readonly isMenu?: () => boolean
  }
}

export interface GpuPanelBinding {
  readonly id: string
  readonly root: HTMLElement
  readonly body: HTMLElement
  readonly inline: boolean
  readonly header: HTMLElement
  readonly titleEl: HTMLElement
  readonly headerButtons: readonly { button: HTMLButtonElement; icon: IconName }[]
  /** The Random button's die: drawn as its face's glyph at rest, ray-traced while it rolls. */
  readonly headerDie?: { readonly button: HTMLButtonElement; readonly die: HeaderDie }
  /** Each locked-capable row's lock icon, by its label element; `data-on` says it's locked. */
  readonly locks?: ReadonlyMap<HTMLElement, HTMLElement>
  readonly presetStrip: PresetStrip
  readonly groups: readonly GpuGroupBinding[]
  readonly cards: readonly HTMLElement[]
  readonly rows: readonly GpuRowBinding[]
  readonly actionButtons: readonly HTMLButtonElement[]
  isPopoverOpen(): boolean
  /** While the panel grows out of (or into) its chip: the shape at a frame time. */
  readonly morph?: (now: number) => MorphFrame | undefined
  /** True while rows, cards or group heads arrive or leave (a descriptor swap). */
  presence?(): boolean
  /** True while a different item lands: everything snaps instead of springing. */
  landing?(): boolean
  /** A full page (see `mountPage`): no panel card; a sticky header the body scrolls under. */
  readonly page?: {
    /** Group cards the overlay draws (custom cards stay in the DOM). */
    readonly tiles: readonly HTMLElement[]
    readonly sections: () => readonly {
      readonly element: HTMLElement
      readonly head: HTMLElement | null
    }[]
    /** Changes whenever cards move, so cached rects are dropped. */
    readonly layoutKey: () => number
    /** While cards glide or ease their heights: rects are read fresh and the loop stays awake. */
    readonly moving?: () => boolean
    /** Steps the page's motion at the start of the frame, before its rects are read. */
    readonly frame?: (now: number) => void
    /** A card's or heading's highlight: how far it's dimmed, and its dot (see `Page.highlight`). */
    readonly emphasis?: (
      node: HTMLElement,
    ) => { readonly dim: number; readonly mark: number; readonly dot?: HTMLElement } | undefined
  }
}

export interface KnobsGpuDiagnostics {
  readonly supported: boolean
  readonly active: boolean
  readonly backend: "webgpu" | "dom"
  readonly panelCount: number
  readonly frameCount: number
  readonly skippedFrames: number
  readonly sleeping: boolean
  readonly lastInstanceCount: number
  /** The text the last drawn frame drew (labels, values, titles), for parity checks. */
  readonly lastTexts: readonly string[]
  forceDeviceLoss(): void
  wake(): void
}

declare global {
  interface Window {
    __knobsGpu?: KnobsGpuDiagnostics
  }
}

export function resolveRendererMode(mode: RendererMode, doc: Document): "gpu" | "dom" {
  if (mode === "dom") return "dom"
  const rootMode = doc.documentElement.dataset.knobsRenderer
  if (rootMode === "dom" || rootMode === "gpu") return rootMode
  const search = doc.defaultView?.location?.search ?? ""
  if (search) {
    const p = new URLSearchParams(search)
    const r = p.get("renderer")
    if (r === "dom" || p.has("dom") || p.get("gpu") === "0" || p.get("gpu") === "false")
      return "dom"
    if (r === "gpu" || p.has("gpu")) return "gpu"
  }
  return mode === "gpu" ? "gpu" : "dom"
}

const clipAncestorsCache = new WeakMap<HTMLElement, { version: number; ancestors: HTMLElement[] }>()

function getEffectiveClipRect(
  el: HTMLElement,
  win: Window,
  version = -1,
): [number, number, number, number] {
  let minX = 0,
    minY = 0,
    maxX = win.innerWidth,
    maxY = win.innerHeight
  let cached = version >= 0 ? clipAncestorsCache.get(el) : undefined
  if (!cached || cached.version !== version) {
    const ancestors: HTMLElement[] = []
    let curr: HTMLElement | null = el.parentElement
    while (curr && curr !== el.ownerDocument.body && curr !== el.ownerDocument.documentElement) {
      const s = win.getComputedStyle(curr)
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) {
        ancestors.push(curr)
      }
      curr = curr.parentElement
    }
    cached = { version, ancestors }
    if (version >= 0) clipAncestorsCache.set(el, cached)
  }
  for (const curr of cached.ancestors) {
    const r = curr.getBoundingClientRect()
    minX = Math.max(minX, r.left)
    minY = Math.max(minY, r.top)
    maxX = Math.min(maxX, r.right)
    maxY = Math.min(maxY, r.bottom)
  }
  return [minX, minY, Math.max(minX, maxX), Math.max(minY, maxY)]
}

/** The nearest sibling a filter hasn't hidden, before (-1) or after (1). */
const shownSibling = (el: Element, dir: -1 | 1) => {
  let n = dir < 0 ? el.previousElementSibling : el.nextElementSibling
  while (n && (n as HTMLElement).hidden)
    n = dir < 0 ? n.previousElementSibling : n.nextElementSibling
  return n
}

/** Element-relative x,y pairs moved onto the viewport. */
const at = (pts: readonly number[], r: DOMRect) => pts.map((v, i) => v + (i % 2 ? r.top : r.left))

const intersectClip = (a: Clip, b: Clip): [number, number, number, number] => {
  const x0 = Math.max(a[0], b[0]),
    y0 = Math.max(a[1], b[1])
  return [x0, y0, Math.max(x0, Math.min(a[2], b[2])), Math.max(y0, Math.min(a[3], b[3]))]
}

interface TextOpts {
  px?: number
  weight?: number
  mono?: boolean
  /** A face other than the panel's (the readout's --k-value-font). */
  family?: string
  align?: "left" | "center" | "right"
  clip?: Clip
  blurY?: number
  track?: number
  /** Vertical feather (px) from the clip's top and bottom edges, for rolling digits. */
  feather?: number
  /** Skip device-pixel snapping (text in motion). */
  exact?: boolean
  /** Scales the drawn text about `origin` (the decile pop). */
  scale?: number
  origin?: readonly [number, number]
}

class GpuOverlayManager {
  private readonly panels = new Set<GpuPanelBinding>()
  private canvas: HTMLCanvasElement | null = null
  private device: any = null
  private context: any = null
  private format = "bgra8unorm"
  private pipeline: any = null
  private primBuffer: any = null
  private viewBuffer: any = null
  private labelTexture: any = null
  private bindGroup: any = null
  private readonly atlas: LabelAtlas

  private readonly data = new Float32Array(MAX_PRIMS * FLOATS_PER_PRIM)
  private readonly prevData = new Float32Array(MAX_PRIMS * FLOATS_PER_PRIM)
  private primCount = 0
  private prevPrimCount = -1
  /** Polyline vertices (viewport px) that line primitives index into. */
  private readonly points = new Float32Array(MAX_POINTS * 2)
  private readonly prevPoints = new Float32Array(MAX_POINTS * 2)
  private pointCount = 0
  private prevPointCount = -1
  private pointBuffer: any = null
  private maskBuffer: any = null
  private readonly masks = new Float32Array(MAX_MASKS * 8)
  private maskCount = 0
  /** Index + 1 of the mask clipping the current panel's content; 0 for none. */
  private curMask = 0
  /** This frame's time, so the overlay and the DOM sample a morph at the same moment. */
  private frameNow = 0
  /** Point lists easing from where they were toward new targets, like the DOM's `d` and transform transitions. */
  private readonly morphs = new WeakMap<
    object,
    { from: number[]; to: number[]; shown: number[]; p: Spring; w: number; h: number }
  >()
  private prevCanvasW = 0
  private prevCanvasH = 0

  private initializing: Promise<boolean> | null = null
  private supported = false
  private failed = false
  private rafId = 0
  private sleeping = true
  private dirty = true
  private settleFrames = 0
  private lastTick = 0
  private frameCount = 0
  private skippedFrames = 0
  private listenersAttached = false

  private styleVersion = 1
  private layoutVersion = 1
  /** Token transitions running on each panel, by property (`transitionrun` minus end/cancel). */
  private readonly tokenRuns = new Map<GpuPanelBinding, Map<string, number>>()
  private tokenEventAt = 0
  private readonly pillAnchors = new WeakMap<
    Edges,
    { el: Element; left: number; right: number; top: number }
  >()
  private readonly openUntil = new WeakMap<GpuPanelBinding, number>()
  private readonly rectCache = new WeakMap<
    Element,
    { ox: number; oy: number; w: number; h: number; key: number; subKey: number }
  >()
  private curActiveEl: Element | null = null
  private curFocusVisible = false
  private curPanelHovered = false
  private curSubHovered = false
  private readonly hotRows = new Set<Element>()
  private curPanelRect: DOMRect | null = null
  private curPanelScrollTop = 0
  private curLayoutKey = 0
  private curBypassRectCache = false
  private cachedCellFont = ""
  private cachedCellPx = 0
  private cachedCellWidth = 0

  private curClip: Clip = [0, 0, 0, 0]
  private curScale = 2
  private curTokens!: PanelThemeTokens
  /** Panel opacity (CSS open/close fades), applied to every primitive of the current panel. */
  private curAlpha = 1
  /** Text drawn this frame, and in the last one finished (see `KnobsGpuDiagnostics.lastTexts`). */
  private frameTexts: string[] = []
  lastTexts: readonly string[] = []
  private curDt = 0
  /** Small eased scalars keyed by an object and a slot (e.g. a row's "hover" or "focus"). */
  private readonly eased = new WeakMap<object, Map<string, Spring>>()
  private easeMoving = false
  private readonly backdrops = new Map<GpuPanelBinding, HTMLElement>()
  /** Last on-screen position of each readout character, measured from the right edge. */
  private readonly placeOffsets = new WeakMap<object, number>()

  constructor(private readonly doc: Document) {
    this.atlas = new LabelAtlas(doc)
    this.publishDiagnostics()
  }

  private get win(): Window {
    return this.doc.defaultView!
  }

  private publishDiagnostics() {
    if (!this.doc.defaultView) return
    const s = this
    const isActive = () => s.supported && !s.failed && s.panels.size > 0 && Boolean(s.device)
    this.doc.defaultView.__knobsGpu = {
      get supported() {
        return s.supported
      },
      get active() {
        return isActive()
      },
      get backend() {
        return isActive() ? "webgpu" : "dom"
      },
      get panelCount() {
        return s.panels.size
      },
      get frameCount() {
        return s.frameCount
      },
      get skippedFrames() {
        return s.skippedFrames
      },
      get sleeping() {
        return s.sleeping
      },
      get lastInstanceCount() {
        return s.primCount
      },
      get lastTexts() {
        return [...s.lastTexts]
      },
      forceDeviceLoss: () => {
        try {
          s.device?.destroy()
        } catch {}
      },
      wake: () => s.wake(),
    }
  }

  register(panel: GpuPanelBinding): () => void {
    this.panels.add(panel)
    if (!panel.inline && !("restored" in panel.root.dataset) && !("morphing" in panel.root.dataset))
      this.openUntil.set(panel, performance.now() + 220)
    panel.root.dataset.renderer = "gpu"
    this.attachGlobalListeners()
    const ro = new ResizeObserver(() => {
      this.wake()
    })
    ro.observe(panel.root)
    ro.observe(panel.body)
    ro.observe(panel.presetStrip.track)
    const mo = new MutationObserver(() => {
      this.styleVersion++
      this.wake()
    })
    mo.observe(panel.root, {
      attributes: true,
      attributeFilter: ["data-theme", "data-density", "style"],
    })
    // Token changes glide as CSS transitions on the panel; while any runs, every frame reads the
    // in-between tokens and fresh rects, then the loop can sleep again.
    const onTokenEvent = (event: TransitionEvent) => {
      const name = event.propertyName
      if (event.target !== panel.root || !name.startsWith("--kt-")) return
      this.tokenEventAt = performance.now()
      let runs = this.tokenRuns.get(panel)
      if (!runs) this.tokenRuns.set(panel, (runs = new Map()))
      const n = (runs.get(name) ?? 0) + (event.type === "transitionrun" ? 1 : -1)
      if (n > 0) runs.set(name, n)
      else runs.delete(name)
      if (runs.size === 0) {
        this.tokenRuns.delete(panel)
        this.styleVersion++
        if (LAYOUT_TOKENS.has(name)) this.layoutVersion++
      }
      this.wake()
    }
    const tokenEvents = ["transitionrun", "transitionend", "transitioncancel"] as const
    for (const type of tokenEvents) panel.root.addEventListener(type, onTokenEvent)
    void this.ensureInitialized().then((ok) => {
      if (!this.panels.has(panel)) return
      panel.root.dataset.gpuActive = ok ? "true" : "false"
      this.publishDiagnostics()
      if (ok) this.wake()
    })
    return () => {
      ro.disconnect()
      mo.disconnect()
      for (const type of tokenEvents) panel.root.removeEventListener(type, onTokenEvent)
      this.tokenRuns.delete(panel)
      this.panels.delete(panel)
      this.backdrops.get(panel)?.remove()
      this.backdrops.delete(panel)
      delete panel.root.dataset.gpuActive
      delete panel.root.dataset.renderer
      this.publishDiagnostics()
      if (this.panels.size === 0) {
        if (this.rafId) this.win.cancelAnimationFrame(this.rafId)
        this.rafId = 0
        this.sleeping = true
        this.canvas?.remove()
        this.atlas.detach()
        this.canvas = null
        this.context = null
      } else {
        this.wake()
      }
    }
  }

  wake = () => {
    this.dirty = true
    this.settleFrames = 0
    if (!this.rafId && this.panels.size > 0 && this.device && !this.failed) {
      this.sleeping = false
      this.lastTick = performance.now()
      this.rafId = this.win.requestAnimationFrame(this.tick)
    }
  }

  private attachGlobalListeners() {
    if (this.listenersAttached) return
    this.listenersAttached = true
    const win = this.win
    const bumpLayout = () => {
      this.layoutVersion++
      this.wake()
    }
    win.addEventListener("scroll", this.wake, { capture: true, passive: true })
    win.addEventListener("resize", bumpLayout, { passive: true })
    win.visualViewport?.addEventListener("resize", bumpLayout, { passive: true })
    win.visualViewport?.addEventListener("scroll", this.wake, { passive: true })
    this.doc.addEventListener("pointermove", this.onDocPointer, { passive: true })
    for (const ev of ["pointerdown", "pointerup", "focusin", "focusout", "keydown"] as const) {
      this.doc.addEventListener(ev, this.wake, { capture: true, passive: true })
    }
    const docMo = new MutationObserver(() => {
      this.styleVersion++
      this.wake()
    })
    docMo.observe(this.doc.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-knobs-theme", "style", "class"],
    })
    if (this.doc.head) {
      docMo.observe(this.doc.head, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }
  }

  private onDocPointer = (e: PointerEvent) => {
    if (!this.sleeping && this.rafId) {
      this.dirty = true
      this.settleFrames = 0
      return
    }
    for (const p of this.panels) {
      const r = p.root.getBoundingClientRect()
      if (
        e.clientX >= r.left - 24 &&
        e.clientX <= r.right + 24 &&
        e.clientY >= r.top - 24 &&
        e.clientY <= r.bottom + 24
      ) {
        this.wake()
        return
      }
    }
  }

  private async ensureInitialized(): Promise<boolean> {
    if (this.device && !this.failed) {
      this.ensureCanvas()
      return true
    }
    if (this.initializing) return this.initializing
    this.initializing = this.initWebGpu()
    const ok = await this.initializing
    this.initializing = null
    return ok
  }

  private ensureCanvas() {
    if (!this.canvas || !this.doc.body.contains(this.canvas)) {
      const c = this.doc.createElement("canvas")
      c.className = "knobs-gpu-canvas"
      c.dataset.knobsGpu = ""
      c.setAttribute("aria-hidden", "true")
      c.style.cssText =
        "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147480002;display:block;"
      this.doc.body.append(c)
      this.canvas = c
      this.context = null
    }
    // After a lost device the canvas stays, but its context must be configured for the new one.
    if (this.device && !this.context) {
      const ctx = (this.canvas as any).getContext("webgpu")
      ctx?.configure({ device: this.device, format: this.format, alphaMode: "premultiplied" })
      this.context = ctx
    }
  }

  private async initWebGpu(): Promise<boolean> {
    try {
      const nav = this.win.navigator as any
      const adapter = await nav?.gpu?.requestAdapter({ powerPreference: "high-performance" })
      if (!adapter) throw new Error("No WebGPU adapter")
      const device = await adapter.requestDevice()
      this.device = device
      this.supported = true
      this.failed = false

      device.lost.then(() => {
        if (this.device !== device) return
        this.device = null
        this.context = null
        this.setAllPanelsActive(false)
        if (this.rafId) this.win.cancelAnimationFrame(this.rafId)
        this.rafId = 0
        this.sleeping = true
        this.publishDiagnostics()
        if (this.panels.size > 0) {
          setTimeout(() => {
            if (this.panels.size > 0)
              void this.ensureInitialized().then((ok) => {
                this.setAllPanelsActive(ok)
                if (ok) this.wake()
              })
          }, 150)
        }
      })

      this.format = nav.gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm"
      const shaderModule = device.createShaderModule({ code: panelWgsl })
      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 1 | 2, buffer: { type: "read-only-storage" } },
          { binding: 1, visibility: 1 | 2, buffer: { type: "uniform" } },
          { binding: 2, visibility: 2, texture: { sampleType: "float" } },
          { binding: 3, visibility: 2, sampler: { type: "filtering" } },
          { binding: 4, visibility: 2, buffer: { type: "read-only-storage" } },
          { binding: 5, visibility: 2, buffer: { type: "read-only-storage" } },
        ],
      })
      this.pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        vertex: { module: shaderModule, entryPoint: "vs_main" },
        fragment: {
          module: shaderModule,
          entryPoint: "fs_main",
          targets: [
            {
              format: this.format,
              blend: {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      })

      this.primBuffer = device.createBuffer({
        size: MAX_PRIMS * FLOATS_PER_PRIM * 4,
        usage: 0x80 | 0x08,
      })
      this.viewBuffer = device.createBuffer({ size: 16, usage: 0x40 | 0x08 })
      this.pointBuffer = device.createBuffer({ size: MAX_POINTS * 8, usage: 0x80 | 0x08 })
      this.maskBuffer = device.createBuffer({ size: MAX_MASKS * 32, usage: 0x80 | 0x08 })
      this.labelTexture = device.createTexture({
        size: [ATLAS_SIZE, ATLAS_SIZE],
        format: "rgba8unorm",
        usage: 0x04 | 0x02 | 0x10,
      })
      const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })
      this.bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.primBuffer } },
          { binding: 1, resource: { buffer: this.viewBuffer } },
          { binding: 2, resource: this.labelTexture.createView() },
          { binding: 3, resource: sampler },
          { binding: 4, resource: { buffer: this.pointBuffer } },
          { binding: 5, resource: { buffer: this.maskBuffer } },
        ],
      })

      this.atlas.clear()
      this.dirty = true
      this.ensureCanvas()
      this.setAllPanelsActive(true)
      this.publishDiagnostics()
      this.wake()
      return true
    } catch {
      this.supported = false
      this.failed = true
      this.setAllPanelsActive(false)
      this.publishDiagnostics()
      return false
    }
  }

  private setAllPanelsActive(active: boolean) {
    for (const p of this.panels) p.root.dataset.gpuActive = active ? "true" : "false"
  }

  private pushPrim(o: {
    x: number
    y: number
    w: number
    h: number
    clip?: Clip
    uv?: readonly [number, number, number, number]
    color: Rgba
    color2?: Rgba
    /** Per-corner radii (tl, tr, br, bl) for track and slider shapes; overrides `radius`. */
    corners?: readonly [number, number, number, number]
    radius?: number
    strokeWidth?: number
    glowOrBlur?: number
    kind: number
    blurX?: number
    blurY?: number
    p0?: number
    p1?: number
    p2?: number
    p3?: number
    aux?: readonly [number, number, number, number]
    aux2?: Rgba
  }) {
    if (this.primCount >= MAX_PRIMS) return
    // Boxes land on whole device pixels, as Chrome snaps layout boxes when it paints them.
    if (o.kind <= 4 && o.w >= 1 && o.h >= 1) {
      const s = this.curScale
      const x0 = Math.round(o.x * s) / s
      const y0 = Math.round(o.y * s) / s
      o.w = Math.round((o.x + o.w) * s) / s - x0
      o.h = Math.round((o.y + o.h) * s) / s - y0
      o.x = x0
      o.y = y0
    }
    const clip = o.clip ?? this.curClip
    const uv = o.corners ?? o.uv
    const c2 = o.color2
    const c3 = o.aux2
    const aux = o.aux
    const d = this.data
    const b = this.primCount++ * FLOATS_PER_PRIM
    d[b] = o.x
    d[b + 1] = o.y
    d[b + 2] = o.w
    d[b + 3] = o.h
    d[b + 4] = clip[0]
    d[b + 5] = clip[1]
    d[b + 6] = clip[2]
    d[b + 7] = clip[3]
    d[b + 8] = uv ? uv[0] : 0
    d[b + 9] = uv ? uv[1] : 0
    d[b + 10] = uv ? uv[2] : 1
    d[b + 11] = uv ? uv[3] : 1
    d[b + 12] = o.color[0]
    d[b + 13] = o.color[1]
    d[b + 14] = o.color[2]
    d[b + 15] = o.color[3] * this.curAlpha
    d[b + 16] = c2 ? c2[0] : 1
    d[b + 17] = c2 ? c2[1] : 1
    d[b + 18] = c2 ? c2[2] : 1
    d[b + 19] = (c2 ? c2[3] : 0) * this.curAlpha
    d[b + 20] = o.radius ?? 0
    d[b + 21] = o.strokeWidth ?? 0
    d[b + 22] = o.glowOrBlur ?? 0
    d[b + 23] = o.kind
    d[b + 24] = o.blurX ?? 0
    d[b + 25] = o.blurY ?? 0
    d[b + 26] = 0
    d[b + 27] = (o.corners ? 1 : 0) + 2 * this.curMask
    d[b + 28] = o.p0 ?? 0
    d[b + 29] = o.p1 ?? 0
    d[b + 30] = o.p2 ?? 0
    d[b + 31] = o.p3 ?? 0
    d[b + 32] = aux ? aux[0] : 0
    d[b + 33] = aux ? aux[1] : 0
    d[b + 34] = aux ? aux[2] : 0
    d[b + 35] = aux ? aux[3] : 0
    d[b + 36] = c3 ? c3[0] : 1
    d[b + 37] = c3 ? c3[1] : 1
    d[b + 38] = c3 ? c3[2] : 1
    d[b + 39] = (c3 ? c3[3] : 0) * this.curAlpha
  }

  /**
   * The canvas can't sample the page, so each panel gets a backdrop-filter element just under the
   * canvas, kept on the panel's rect: the blur shows through the translucent card drawn above it.
   */
  private placeBackdrop(
    panel: GpuPanelBinding,
    rect?: DOMRect,
    clip?: Clip,
    radius = 0,
    glass = 0,
    tone = 1,
  ) {
    let el = this.backdrops.get(panel)
    if (!el) {
      if (!rect || glass <= 0.001) return
      el = this.doc.createElement("div")
      el.className = "knobs-gpu-backdrop"
      el.setAttribute("aria-hidden", "true")
      this.backdrops.set(panel, el)
    }
    if (!el.isConnected) {
      if (this.canvas?.isConnected) this.canvas.before(el)
      else this.doc.body.append(el)
    }
    let css = "display:none"
    if (rect && clip && glass > 0.001) {
      const inset = [
        clip[1] - rect.top,
        rect.right - clip[2],
        rect.bottom - clip[3],
        clip[0] - rect.left,
      ]
      const filter = `blur(${(glass * 24).toFixed(2)}px) saturate(${(1 + glass * 0.8).toFixed(3)}) brightness(${(1 + (tone - 1) * glass).toFixed(3)})`
      css =
        `position:fixed;left:0;top:0;z-index:2147480002;pointer-events:none;` +
        `width:${rect.width}px;height:${rect.height}px;transform:translate(${rect.left}px,${rect.top}px);` +
        `border-radius:${radius}px;opacity:${this.curAlpha.toFixed(3)};` +
        `clip-path:inset(${inset.map((v) => `${Math.max(0, v)}px`).join(" ")});` +
        `-webkit-backdrop-filter:${filter};backdrop-filter:${filter};`
    }
    if (el.dataset.css !== css) {
      el.dataset.css = css
      el.style.cssText = css
    }
  }

  private drawText(text: string, x: number, centerY: number, color: Rgba, opts: TextOpts = {}) {
    if (!text) return 0
    if (color[3] * this.curAlpha > 0.01) this.frameTexts.push(text)
    const t = this.curTokens
    const px = opts.px ?? t.fontSize
    const weight = opts.weight ?? t.labelWeight
    const family = opts.family ?? (opts.mono ? t.monoFamily : t.fontFamily)
    const entry = this.atlas.get(text, px, weight, family, this.curScale, opts.track ?? 0)
    const align = opts.align ?? "left"
    const drawX =
      align === "center"
        ? x - entry.w * 0.5
        : align === "right"
          ? x - entry.w + entry.pad
          : x - entry.pad
    // Whole device pixels, so the atlas blits 1:1 instead of being resampled (which reads bolder).
    const s = this.curScale
    const snap = (v: number) => (opts.exact ? v : Math.round(v * s) / s)
    let box = [snap(drawX), snap(centerY - entry.h * 0.5), entry.w, entry.h]
    const k = opts.scale ?? 1
    if (k !== 1 && opts.origin) {
      const [ox, oy] = opts.origin
      box = [ox + (box[0]! - ox) * k, oy + (box[1]! - oy) * k, entry.w * k, entry.h * k]
    }
    this.pushPrim({
      x: box[0]!,
      y: box[1]!,
      w: box[2]!,
      h: box[3]!,
      clip: opts.clip ?? this.curClip,
      uv: entry.uv,
      color,
      kind: 5,
      blurY: opts.blurY ?? 0,
      p0: opts.feather ?? 0,
    })
    return entry.textW
  }

  /** Springs a per-object scalar toward `target`; keeps the frame loop awake until it settles. */
  /** Omitting `target` keeps the current one. */
  private ease(
    key: object,
    slot: string,
    target?: number,
    omega = 28,
    zeta = 1,
    eps = 0.005,
  ): number {
    let slots = this.eased.get(key)
    if (!slots) this.eased.set(key, (slots = new Map()))
    let sp = slots.get(slot)
    if (!sp) {
      sp = new Spring(target ?? 0, omega, zeta, eps)
      slots.set(slot, sp)
    }
    target ??= sp.target
    if (omega >= SNAP_OMEGA) {
      sp.snap(target)
      return sp.x
    }
    sp.omega = omega
    sp.zeta = zeta
    sp.eps = eps
    sp.set(target).step(this.curDt)
    if (!sp.resting) this.easeMoving = true
    return sp.x
  }

  /**
   * Carries a pill along when layout moves its selected button (a token transition, a resize), so
   * only a change of selection animates, as in the DOM, which snaps its pills on resize.
   */
  private carry(pe: Edges, el: Element, left: number, right: number, y?: Spring, top = 0) {
    const prev = this.pillAnchors.get(pe)
    this.pillAnchors.set(pe, { el, left, right, top })
    if (!prev || prev.el !== el) return
    if (left !== prev.left || right !== prev.right) pe.shift(left - prev.left, right - prev.right)
    if (y && top !== prev.top) {
      y.x += top - prev.top
      y.target += top - prev.top
    }
  }

  private rectOf(el: HTMLElement | SVGElement, subKey = 0): DOMRect {
    const pRect = this.curPanelRect
    if (
      !pRect ||
      this.curBypassRectCache ||
      (el instanceof HTMLElement && el.style.transform !== "")
    ) {
      return el.getBoundingClientRect()
    }
    const key = this.curLayoutKey
    const hit = this.rectCache.get(el)
    if (hit && hit.key === key && hit.subKey === subKey) {
      const left = pRect.left + hit.ox
      const top = pRect.top + hit.oy - this.curPanelScrollTop
      return {
        left,
        top,
        right: left + hit.w,
        bottom: top + hit.h,
        width: hit.w,
        height: hit.h,
        x: left,
        y: top,
        toJSON() {},
      } as DOMRect
    }
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      this.rectCache.set(el, {
        ox: r.left - pRect.left,
        oy: r.top - pRect.top + this.curPanelScrollTop,
        w: r.width,
        h: r.height,
        key,
        subKey,
      })
    }
    return r
  }

  private isHovered(el: Element): boolean {
    return this.curSubHovered && el.matches(":hover")
  }

  private isFocused(el: Element): boolean {
    return this.curFocusVisible && this.curActiveEl === el
  }

  private hasFocusVisible(el: Element): boolean {
    return this.curFocusVisible && this.curActiveEl !== null && el.contains(this.curActiveEl)
  }

  /** From `from` (label) to `to` (text) as `el` turns hot, eased like the DOM's 0.15 s colour transitions. */
  private hot(el: object, on: boolean, from = this.curTokens.label, to = this.curTokens.text) {
    return cssMix(to, from, this.ease(el, "hot", on ? 1 : 0, 30))
  }

  /** Hint mode dims what the typed code no longer matches, over the DOM's 0.1 s. */
  private missed(el: Element, hinting: boolean) {
    return this.ease(
      el,
      "hint",
      hinting && el.classList.contains("knobs-hint-miss") ? this.curTokens.disabledOpacity : 1,
      40,
    )
  }

  /** How far an arriving or leaving node has revealed (its opacity while the reveal runs). */
  private presence(el: HTMLElement) {
    if (el.dataset.presence === undefined) return 1
    return Number(getComputedStyle(el).opacity) || 0
  }

  /** A control's hover/press wash, faded in and out over the DOM's 0.15 s. */
  private wash(el: object, on: boolean) {
    return this.ease(el, "wash", on ? 1 : 0, this.hoverOmega(on))
  }

  /** A spring as quick as the hover tokens: --k-hover-in on the way in, --k-hover-out out. */
  private hoverOmega(on: boolean) {
    const ms = on ? this.curTokens.hoverIn : this.curTokens.hoverOut
    return ms <= 1 ? SNAP_OMEGA : 4500 / ms
  }

  private drawRowLabel(
    labelEl: HTMLElement,
    text: string,
    modified: boolean,
    rowCenterY: number,
    rowAlpha: number,
    lRect = this.rectOf(labelEl),
  ) {
    const t = this.curTokens
    const w = this.drawText(text, lRect.left, rowCenterY, withAlpha(t.label, rowAlpha))
    const lock = this.curLocks?.get(labelEl)
    if (lock) this.drawLock(lock, rowCenterY, rowAlpha)
    const dot = this.ease(labelEl, "dot", modified ? 1 : 0)
    if (dot > 0.01) {
      const size = 4 * (0.4 + 0.6 * dot)
      this.pushPrim({
        x: lRect.left + w + 7 - size / 2,
        y: rowCenterY - size / 2,
        w: size,
        h: size,
        color: withAlpha(t.modified, rowAlpha * dot),
        glowOrBlur: 0.5,
        kind: 7,
      })
    }
  }

  /**
   * A locked row's lock, just left of its readout (or control): it fades and scales in on the
   * reset icon's spring, like .knobs-lock, at the right edge of the room the DOM leaves for it.
   */
  private drawLock(lock: HTMLElement, rowCenterY: number, rowAlpha: number) {
    const on = lock.dataset.on === "true" ? 1 : 0
    // A lock added just now enters from nothing; one there from the start is simply shown.
    if ("enter" in lock.dataset && !this.eased.has(lock)) this.ease(lock, "shown", 0)
    const shown = this.ease(lock, "shown", on, 20, 0.6)
    if (shown <= 0.005) return
    const r = this.rectOf(lock, on)
    // In a readout the icon keeps 6px from the digits (see .knobs-value>.knobs-lock>svg).
    const right = r.right - (lock.parentElement?.classList.contains("knobs-value") ? 6 : 0)
    const box = { left: right - 10, top: rowCenterY - 5, width: 10, height: 10 }
    this.drawIcon(
      "lock",
      10,
      box as DOMRect,
      withAlpha(this.curTokens.dim, rowAlpha * clamp(shown, 0, 1)),
      undefined,
      0.5 + 0.5 * shown,
    )
  }

  private drawButton(
    btn: HTMLButtonElement,
    _activeEl: Element | null,
    hinting: boolean,
    radius: number,
    px: number,
    alwaysBg: boolean,
  ) {
    const t = this.curTokens
    const br = this.rectOf(btn)
    if (br.width <= 0 || br.height <= 0 || br.bottom < this.curClip[1] || br.top > this.curClip[3])
      return
    const hovered = !btn.disabled && this.isHovered(btn)
    const focused = this.isFocused(btn)
    const expanded = btn.getAttribute("aria-expanded") === "true"
    const alpha =
      this.ease(btn, "dim", btn.disabled ? t.disabledOpacity : 1, 30) * this.missed(btn, hinting)
    const on = hovered || focused || expanded
    const wash = this.wash(btn, on)
    if (alwaysBg || wash > 0.005) {
      this.pushPrim({
        x: br.left,
        y: br.top,
        w: br.width,
        h: br.height,
        color: alwaysBg
          ? withAlpha(cssMix(t.surfaceHi, t.surface, wash), alpha)
          : withAlpha(t.surfaceHi, alpha * wash),
        color2: t.accent,
        radius,
        glowOrBlur: t.glowStrength * 7,
        kind: 1,
      })
    }
    this.drawText(
      btn.textContent ?? "",
      br.left + br.width * 0.5,
      br.top + br.height * 0.5,
      withAlpha(this.hot(btn, on), alpha),
      { px, align: "center" },
    )
  }

  private isHot(row: Element) {
    return this.hotRows.has(row)
  }

  /** Square inside its card, except the card's own rounded corners on the first and last rows. */
  private rowCorners(row: HTMLElement, open = false): [number, number, number, number] {
    const r = this.curTokens.radius
    if (this.curTokens.rowGap > 0) return open ? [r, r, 0, 0] : [r, r, r, r]
    // A spring's sliders sit inside its row, beside the curve: only their left corners can round.
    const item = row.parentElement?.classList.contains("knobs-card")
      ? row
      : row.closest<HTMLElement>(".knobs-card > *")
    if (!item) return [0, 0, 0, 0]
    const inner = item !== row
    const first = !shownSibling(item, -1) && !(inner && shownSibling(row, -1)) ? r : 0
    const last = !shownSibling(item, 1) && !(inner && shownSibling(row, 1)) && !open ? r : 0
    return inner ? [first, 0, 0, last] : [first, first, last, last]
  }

  /** A row's hover wash, drawn beneath its control like the DOM row background. */
  private drawRowHover(row: HTMLElement, rRect: DOMRect, hot: boolean) {
    const hover =
      this.ease(row, "hover", hot ? 1 : 0, this.hoverOmega(hot)) * (1 - this.curSelected)
    if (hover < 0.005) return
    this.pushPrim({
      x: rRect.left,
      y: rRect.top,
      w: rRect.width,
      h: rRect.height,
      color: withAlpha(this.curTokens.rowHover, hover),
      corners: this.rowCorners(row),
      kind: 1,
    })
  }

  /** The hairline above every row but a card's first, and the focus wash. */
  private drawRowOverlay(row: HTMLElement, rRect: DOMRect, cardClip: Clip) {
    this.drawSeparator(row, rRect, cardClip)
    this.drawFocus(row, this.hasFocusVisible(row), rRect, cardClip)
  }

  private drawSeparator(row: HTMLElement, rRect: DOMRect, cardClip: Clip) {
    const t = this.curTokens
    if (t.rowGap > 0) return
    // Hairlines beside a hovered, focused or dragged row fade out, as in iOS lists.
    const prev = shownSibling(row, -1)
    const joined =
      row.classList.contains("knobs-selected") && prev?.classList.contains("knobs-selected")
    const sep = this.ease(
      row,
      "sep",
      prev && !joined && !this.isHot(row) && !this.isHot(prev) ? 1 : 0,
      30,
    )
    if (prev && sep > 0.005)
      this.pushPrim({
        x: rRect.left,
        y: rRect.top,
        w: rRect.width,
        h: 0.5,
        clip: cardClip,
        color: withAlpha(t.line, sep),
        kind: 1,
      })
  }

  /** The focus wash, matching the row's corners inside its card. */
  private drawFocus(el: HTMLElement, on: boolean, rRect: DOMRect, cardClip: Clip) {
    const t = this.curTokens
    const focus = this.ease(el, "focus", on ? 1 : 0)
    if (focus < 0.005) return
    this.pushPrim({
      x: rRect.left,
      y: rRect.top,
      w: rRect.width,
      h: rRect.height,
      clip: cardClip,
      color: withAlpha(t.surface, focus),
      color2: t.accent,
      corners: this.rowCorners(el, el.getAttribute("aria-expanded") === "true"),
      glowOrBlur: t.glowStrength * 8,
      kind: 1,
    })
  }

  private drawIcon(icon: IconName, px: number, box: DOMRect, color: Rgba, clip?: Clip, scale = 1) {
    const entry = this.atlas.icon(ICONS[icon], px, this.curScale)
    const s = scale === 1 ? this.curScale : 0
    const snap = (v: number) => (s ? Math.round(v * s) / s : v)
    this.pushPrim({
      x: snap(box.left + (box.width - entry.w * scale) * 0.5),
      y: snap(box.top + (box.height - entry.h * scale) * 0.5),
      w: entry.w * scale,
      h: entry.h * scale,
      clip,
      uv: entry.uv,
      color,
      kind: 5,
    })
  }

  /** The die is always traced, at rest too, exactly as the DOM canvas does: nothing swaps. */
  private drawDie(die: HeaderDie, box: DOMRect, color: Rgba, clip?: Clip) {
    // Same box as the DOM canvas: room for the corners while it tumbles and lifts.
    const b = dieBox(die.size)
    const { rx, ry, energy } = die.view
    const d2r = Math.PI / 180
    this.pushPrim({
      x: box.left + (box.width - b) * 0.5,
      y: box.top + (box.height - b) * 0.5,
      w: b,
      h: b,
      clip,
      color,
      kind: 11,
      strokeWidth: DIE_LOOK.shade,
      p0: rx * d2r,
      p1: ry * d2r,
      p2: energy,
      p3: die.size,
      aux: [DIE_LOOK.perspective, DIE_LOOK.lift, Math.cos(DIE_LOOK.bevel * d2r), DIE_LOOK.fill],
    })
  }

  /** A circular icon button's hover/focus wash. */
  private drawRoundWash(r: DOMRect, alpha: number, wash: number, clip?: Clip) {
    if (wash <= 0.005) return
    const t = this.curTokens
    this.pushPrim({
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      clip,
      color: withAlpha(t.surfaceHi, alpha * wash),
      color2: t.accent,
      radius: r.height * 0.5,
      glowOrBlur: t.glowStrength * 8,
      kind: 1,
    })
  }

  /**
   * A segmented tray (`.knobs-seg`), its sliding pill, and its option labels: used for both choice
   * rows and a page group's numbered preset chips. Returns whether the pill is still moving.
   */
  private drawSeg(
    seg: HTMLElement,
    buttons: readonly HTMLButtonElement[],
    pill: Edges,
    opts: {
      delay?: number
      alpha?: number
      px?: number
      weight?: number
      hinting?: boolean
      canFadeOff?: boolean
      minPill?: number
      reducedMotion: boolean
    },
  ): boolean {
    const t = this.curTokens
    const sr = this.rectOf(seg)
    if (sr.width <= 0) return false
    const alpha = opts.alpha ?? 1
    const delay = opts.delay ?? 0
    const minPill = opts.minPill ?? 12
    const reduced = opts.reducedMotion
    this.pushPrim({
      x: sr.left,
      y: sr.top,
      w: sr.width,
      h: sr.height,
      color: withAlpha(t.segBg, alpha),
      color2: t.accent,
      radius: t.radiusMd,
      glowOrBlur: t.glowStrength * 8,
      kind: 1,
    })
    let moving = false
    const active = buttons.find((b) => b.getAttribute("aria-checked") === "true")
    const shown = opts.canFadeOff ? this.ease(seg, "pill", active ? 1 : 0, 30) : active ? 1 : 0
    if (active) {
      const ar = this.rectOf(active)
      const left = ar.left - sr.left
      const right = left + ar.width
      const panned = livePill(seg)
      this.carry(pill, active, left, right)
      if (panned) pill.snap(panned.left, panned.right)
      else if (reduced || shown < 0.05 || pill.end.x - pill.start.x <= 1) pill.snap(left, right)
      else {
        pill.to(left, right, delay, trailScale(t.blurStrength)).step(this.curDt)
        if (!pill.resting) moving = true
      }
    }
    if (shown > 0.005) {
      const pad = t.trayPad
      this.pushPrim({
        x: sr.left + pill.start.x,
        y: sr.top + pad,
        w: Math.max(minPill, pill.end.x - pill.start.x),
        h: Math.max(minPill, sr.height - pad * 2),
        color: withAlpha(t.pillBg, shown * alpha),
        color2: [0, 0, 0, 0],
        radius: t.radiusSm,
        glowOrBlur: t.glowStrength * 0.6,
        kind: 3,
        // Edge blur (--k-motion-blur): a smear as wide as the pill's speed, like the DOM's.
        blurX: reduced ? 0 : clamp(pill.velocity * 0.006 * t.motionBlur, -6, 6),
      })
    }
    for (const b of buttons) {
      const br = this.rectOf(b)
      const on =
        b.getAttribute("aria-checked") === "true" ||
        this.isHovered(b) ||
        (Boolean(opts.canFadeOff) && this.isFocused(b))
      const bAlpha = opts.hinting !== undefined ? alpha * this.missed(b, opts.hinting) : alpha
      this.drawText(
        b.textContent ?? "",
        br.left + br.width * 0.5,
        br.top + br.height * 0.5,
        withAlpha(this.hot(b, on), bAlpha),
        {
          px: opts.px ?? t.textControl,
          weight: opts.weight ?? t.labelWeight,
          align: "center",
        },
      )
    }
    return moving
  }

  /** A card header's compact preset menu: its tray, the selected name (or a dim "Custom") and caret. */
  private drawHeadMenu(b: HTMLButtonElement, valueEl: HTMLElement, hinting: boolean) {
    const t = this.curTokens
    const br = this.rectOf(b)
    if (br.width <= 0) return
    const open = b.getAttribute("aria-expanded") === "true"
    const on = this.isHovered(b) || this.isFocused(b) || open
    const wash = this.wash(b, on)
    const alpha = this.missed(b, hinting)
    this.pushPrim({
      x: br.left,
      y: br.top,
      w: br.width,
      h: br.height,
      color: withAlpha(cssMix(t.surfaceHi, t.segBg, wash), alpha),
      color2: t.accent,
      radius: t.radiusMd,
      glowOrBlur: t.glowStrength * 8,
      kind: 1,
    })
    const none = b.hasAttribute("data-none")
    const vr = this.rectOf(valueEl)
    this.drawText(
      this.fit(valueEl.textContent ?? "", vr.width + 1, t.textMeta, 500),
      vr.left,
      br.top + br.height * 0.5,
      withAlpha(none ? t.dim : this.hot(b, on), alpha),
      { px: t.textMeta, weight: 500 },
    )
    const caret = b.querySelector("svg")
    if (caret)
      this.drawIcon(
        "caret",
        t.iconSm - 3,
        this.rectOf(caret),
        withAlpha(this.hot(b, on, t.dim, t.label), alpha),
      )
  }

  /** A highlight's dot by a title, where (and as large) as the DOM's `.knobs-mark` is. */
  private drawMark(dot: HTMLElement, shown: number, clip?: Clip) {
    if (shown <= 0.002) return
    const r = dot.getBoundingClientRect()
    if (r.width <= 0) return
    this.pushPrim({
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      clip,
      color: withAlpha(this.curTokens.accent, this.curTokens.accent[3] * shown),
      radius: r.width / 2,
      kind: 1,
    })
  }

  /** Text that fits `maxW`, ellipsized like `text-overflow: ellipsis`. */
  private fit(text: string, maxW: number, px: number, weight: number): string {
    const m = (t: string) => this.atlas.measure(t, px, weight, this.curTokens.fontFamily)
    if (m(text) <= maxW + 0.5) return text
    let n = text.length
    while (n > 0 && m(`${text.slice(0, n).trimEnd()}…`) > maxW) n--
    return n > 0 ? `${text.slice(0, n).trimEnd()}…` : ""
  }

  private curReduced = false
  private curLocks: ReadonlyMap<HTMLElement, HTMLElement> | undefined
  /** The current row's selection wash (0…1), which its hover wash gives way to. */
  private curSelected = 0

  /** A stroke through `pts` (x,y pairs in viewport px), round-capped like SVG's. */
  private pushLine(pts: readonly number[], color: Rgba, width: number, clip?: Clip) {
    const n = pts.length >> 1
    if (n < 2 || this.pointCount + n > MAX_POINTS) return
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]!)
      x1 = Math.max(x1, pts[i]!)
      y0 = Math.min(y0, pts[i + 1]!)
      y1 = Math.max(y1, pts[i + 1]!)
    }
    this.points.set(pts, this.pointCount * 2)
    const pad = width + 1
    this.pushPrim({
      x: x0 - pad,
      y: y0 - pad,
      w: x1 - x0 + pad * 2,
      h: y1 - y0 + pad * 2,
      clip,
      color,
      strokeWidth: width,
      kind: 8,
      p0: this.pointCount,
      p1: n,
    })
    this.pointCount += n
  }

  /**
   * Eases a list of numbers toward `target` on the fill spring, the way the DOM transitions the
   * same geometry (`d`, `transform`, `left`); snaps on drags, resizes and reduced motion.
   */
  private morph(
    key: object,
    target: readonly number[],
    delay: number,
    snap: boolean,
    box: DOMRect,
  ) {
    let m = this.morphs.get(key)
    const resized = m && (Math.abs(m.w - box.width) > 0.5 || Math.abs(m.h - box.height) > 0.5)
    if (!m || snap || resized || this.curReduced || m.to.length !== target.length) {
      const fresh = [...target]
      m ??= {
        from: fresh,
        to: fresh,
        shown: fresh,
        p: new Spring(1, FILL.omega, FILL.zeta),
        w: 0,
        h: 0,
      }
      m.from = m.to = m.shown = fresh
      m.p.snap(1)
      m.w = box.width
      m.h = box.height
      this.morphs.set(key, m)
      return m.shown
    }
    if (target.some((v, i) => v !== m.to[i])) {
      m.from = m.shown
      m.to = [...target]
      m.p.snap(0).set(1, delay)
    }
    m.p.omega = this.curTokens.fillOmega / clamp(this.curTokens.blurStrength, 0.1, 2)
    m.p.zeta = this.curTokens.fillZeta
    m.p.step(this.curDt)
    if (!m.p.resting) this.easeMoving = true
    const k = m.p.x
    const { from, to } = m
    m.shown = to.map((v, i) => from[i]! + (v - from[i]!) * k)
    return m.shown
  }

  /** A shape with an outer (ring > 0) or inner (ring < 0) ring, drop shadow and glow. */
  private shape(o: {
    x: number
    y: number
    w: number
    h: number
    radius: number
    fill: Rgba
    ring?: number
    ringColor?: Rgba
    shadow?: readonly [number, number, number]
    glow?: number
    glowColor?: Rgba
    clip?: Clip
  }) {
    this.pushPrim({
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      clip: o.clip,
      color: o.fill,
      color2: o.ringColor ?? [0, 0, 0, 0],
      radius: o.radius,
      strokeWidth: o.ring ?? 0,
      glowOrBlur: o.glow ?? 0,
      kind: 10,
      p0: (o.shadow?.[0] ?? 0) * this.curAlpha,
      p1: o.shadow?.[1] ?? 0,
      p2: o.shadow?.[2] ?? 0,
      aux2: o.glowColor,
    })
  }

  /** An outline like CSS `outline: 1.5px` at `offset`, following `radius`; drawn while focus-visible. */
  private readout(el: HTMLElement, centerY: number, color: Rgba, clip?: Clip) {
    const text = el.textContent ?? ""
    const r = this.rectOf(el, text.length)
    this.drawText(text, r.right, centerY, color, {
      px: this.curTokens.textControl,
      weight: 400,
      align: "right",
      clip,
    })
  }

  /** A disclosure head (hover, label and changed dot, caret, focus); returns the body's clip, if open. */
  private drawHead(
    item: HTMLElement,
    x: GpuExpander,
    display: string,
    modified: boolean,
    cardClip: Clip,
    rowAlpha: number,
  ): { hRect: DOMRect; bodyClip: Clip | undefined } {
    const t = this.curTokens
    const open = x.isOpen()
    const hRect = this.rectOf(x.head)
    const centerY = hRect.top + hRect.height / 2
    const hot = this.isHovered(x.head)
    const hover = this.ease(x.head, "hover", hot ? 1 : 0)
    if (hover > 0.005)
      this.pushPrim({
        x: hRect.left,
        y: hRect.top,
        w: hRect.width,
        h: hRect.height,
        color: withAlpha(t.rowHover, hover),
        corners: this.rowCorners(item, open),
        kind: 1,
      })
    this.drawRowLabel(x.label, display, modified, centerY, rowAlpha)
    const cRect = this.rectOf(x.caret)
    const turn = (this.ease(x.caret, "turn", open ? 1 : 0, LEAD.omega, LEAD.zeta) * Math.PI) / 2
    const cx = cRect.left + cRect.width / 2
    const cy = cRect.top + cRect.height / 2
    const cos = Math.cos(turn)
    const sin = Math.sin(turn)
    const chevron = [-1.25, -2.75, 1.5, 0, -1.25, 2.75]
    const pts: number[] = []
    for (let i = 0; i < 6; i += 2)
      pts.push(
        cx + chevron[i]! * cos - chevron[i + 1]! * sin,
        cy + chevron[i]! * sin + chevron[i + 1]! * cos,
      )
    this.pushLine(pts, withAlpha(this.hot(x.caret, hot, t.dim, t.label), rowAlpha), 1.4)
    this.drawFocus(x.head, this.isFocused(x.head), hRect, cardClip)
    if (x.body.hidden) return { hRect, bodyClip: undefined }
    const bRect = this.rectOf(x.body)
    if (bRect.height < 0.5) return { hRect, bodyClip: undefined }
    return {
      hRect,
      bodyClip: intersectClip(cardClip, [bRect.left, bRect.top, bRect.right, bRect.bottom]),
    }
  }

  /** Draws an open body at its reveal's opacity. */
  private inBody(x: GpuExpander, draw: () => void) {
    const alpha = this.curAlpha
    if (this.curBypassRectCache) {
      this.curAlpha *= Number(getComputedStyle(x.body).opacity) || 0
    }
    draw()
    this.curAlpha = alpha
  }

  private drawSpring(
    row: GpuSpringRow,
    rRect: DOMRect,
    cardClip: Clip,
    rowAlpha: number,
    clock: number,
  ) {
    const t = this.curTokens
    this.drawSeparator(row.row, rRect, cardClip)
    const box = this.rectOf(row.box)
    const bar = t.rowGap > 0
    this.pushPrim({
      x: box.left,
      y: box.top,
      w: box.width,
      h: box.height,
      color: withAlpha(bar ? t.surface : t.segBg, rowAlpha),
      radius: bar ? t.radius : t.radiusSm,
      kind: 1,
    })
    const clip = intersectClip(cardClip, [box.left, box.top, box.right, box.bottom])
    const inset = t.curveInset
    for (const y of row.guides()) {
      if (!t.curveDashed) {
        this.pushLine(
          [box.left + inset, box.top + y, box.right - inset, box.top + y],
          withAlpha(t.line, rowAlpha),
          1,
          clip,
        )
        continue
      }
      // 4 px dashes, 4 px apart, as the DOM's stroke-dasharray draws them.
      for (let x = box.left + inset; x < box.right - inset; x += 8)
        this.pushLine(
          [x, box.top + y, Math.min(x + 4, box.right - inset), box.top + y],
          withAlpha(t.lineHi, rowAlpha),
          1,
          clip,
        )
    }
    const curve = this.morph(row.box, row.curve(), row.wave.at - clock, row.snap(), box)
    this.pushLine(at(curve, box), withAlpha(t.accent, rowAlpha), 1.5, clip)
    const run = row.dot()
    if (!run || this.curReduced || t.curveDot <= 0) return
    const p = (clock - run.at) / run.ms
    if (p > 1) return
    this.easeMoving = true
    if (p < 0) return
    const n = run.frames.length / 2 - 1
    const i = Math.min(n - 1, Math.floor(p * n))
    const f = p * n - i
    const dx = run.frames[i * 2]! + (run.frames[i * 2 + 2]! - run.frames[i * 2]!) * f
    const dy = run.frames[i * 2 + 1]! + (run.frames[i * 2 + 3]! - run.frames[i * 2 + 1]!) * f
    const fade = p < 0.06 ? p / 0.06 : p > 0.88 ? (1 - p) / 0.12 : 1
    this.shape({
      x: box.left + dx - 2.5,
      y: box.top + dy - 2.5,
      w: 5,
      h: 5,
      radius: 2.5,
      fill: withAlpha(t.accent, fade * rowAlpha * t.curveDot),
      glow: t.glowStrength * 8,
      glowColor: withAlpha(t.accent, fade * rowAlpha * t.curveDot),
      clip,
    })
  }

  private drawColor(
    row: GpuColorRow,
    rRect: DOMRect,
    cardClip: Clip,
    rowAlpha: number,
    clock: number,
  ) {
    const t = this.curTokens
    this.drawSeparator(row.row, rRect, cardClip)
    const { bodyClip: body } = this.drawHead(
      row.row,
      row.x,
      row.display,
      row.isModified(),
      cardClip,
      rowAlpha,
    )
    const col = row.color()
    const maxC = maxChroma(col.l, col.h)
    const target = oklchToRgb(col)
    const waiting = clock < row.wave.at
    if (waiting) this.easeMoving = true
    const rgb: Rgba = [
      this.ease(row.swatch, "r", waiting ? undefined : target[0], 30),
      this.ease(row.swatch, "g", waiting ? undefined : target[1], 30),
      this.ease(row.swatch, "b", waiting ? undefined : target[2], 30),
      rowAlpha,
    ]
    const sw = this.rectOf(row.swatch)
    const centerY = sw.top + sw.height / 2
    this.shape({
      x: sw.left,
      y: sw.top,
      w: sw.width,
      h: sw.height,
      radius: t.radiusSm,
      fill: rgb,
      ring: -1,
      ringColor: withAlpha(t.line, rowAlpha),
    })
    this.readout(row.read, centerY, withAlpha(t.label, rowAlpha))
    if (!body) return
    this.inBody(row.x, () => {
      for (const s of row.strips) {
        const tr = this.rectOf(s.track)
        if (tr.bottom < body[1] || tr.top > body[3]) continue
        const lineY = tr.top + tr.height / 2
        const lr = this.rectOf(s.label)
        this.drawText(s.label.textContent ?? "", lr.left, lineY, withAlpha(t.dim, rowAlpha), {
          px: t.textCap,
          weight: 600,
          align: "left",
          clip: body,
        })
        this.readout(s.read, lineY, withAlpha(t.label, rowAlpha), body)
        const h = tr.height
        this.pushPrim({
          x: tr.left,
          y: tr.top,
          w: tr.width,
          h,
          clip: body,
          color: [1, 1, 1, rowAlpha],
          color2: withAlpha(t.line, rowAlpha),
          kind: 9,
          p0: s.mode,
          p1: h / 2,
          aux: [col.l, s.mode === 0 ? Math.max(col.c, 0.06) : col.c, col.h, maxC],
        })
        const [x] = this.morph(s.track, [s.thumbX()], row.wave.at - clock, s.dragging(), tr)
        const lift = s.dragging() || this.isFocused(s.track)
        const d = (h + 2) * this.ease(s.track, "grab", lift ? 1.1 : 1, 30)
        this.shape({
          x: tr.left + x! - d / 2,
          y: lineY - d / 2,
          w: d,
          h: d,
          radius: d / 2,
          fill: rgb,
          ring: 2,
          ringColor: [1, 1, 1, rowAlpha],
          shadow: [0.4, 4, 1],
          clip: body,
        })
      }
    })
  }

  private drawPoint(
    row: GpuPointRow,
    rRect: DOMRect,
    cardClip: Clip,
    rowAlpha: number,
    clock: number,
  ) {
    const t = this.curTokens
    this.drawSeparator(row.row, rRect, cardClip)
    const { hRect, bodyClip: body } = this.drawHead(
      row.row,
      row.x,
      row.display,
      row.isModified(),
      cardClip,
      rowAlpha,
    )
    this.readout(row.read, hRect.top + hRect.height / 2, withAlpha(t.label, rowAlpha))
    if (!body) return
    this.inBody(row.x, () => {
      const pr = this.rectOf(row.pad)
      const radius = t.radiusMd
      const clip = intersectClip(body, [pr.left, pr.top, pr.right, pr.bottom])
      this.pushPrim({
        x: pr.left,
        y: pr.top,
        w: pr.width,
        h: pr.height,
        clip: body,
        color: withAlpha(t.segBg, rowAlpha),
        radius,
        kind: 1,
      })
      const active = row.dragging()
      const [px, py] = this.morph(row.pad, row.puck(), row.wave.at - clock, active, pr)
      const line = withAlpha(t.line, rowAlpha)
      this.pushPrim({
        x: pr.left + px! - 0.5,
        y: pr.top,
        w: 1,
        h: pr.height,
        clip,
        color: line,
        kind: 1,
      })
      this.pushPrim({
        x: pr.left,
        y: pr.top + py! - 0.5,
        w: pr.width,
        h: 1,
        clip,
        color: line,
        kind: 1,
      })
      const [hx, hy] = row.home()
      this.shape({
        x: pr.left + hx - 3.5,
        y: pr.top + hy - 3.5,
        w: 7,
        h: 7,
        radius: 3.5,
        fill: [0, 0, 0, 0],
        ring: -1,
        ringColor: withAlpha(t.dim, rowAlpha),
        clip,
      })
      const lift = active || this.isFocused(row.pad)
      const d = 12 * this.ease(row.pad, "grab", lift ? 1.2 : 1, 30)
      this.shape({
        x: pr.left + px! - d / 2,
        y: pr.top + py! - d / 2,
        w: d,
        h: d,
        radius: d / 2,
        fill: withAlpha(t.accent, rowAlpha),
        ring: 1.5,
        ringColor: withAlpha(t.bg, rowAlpha),
        glow: t.glowStrength * 10,
        glowColor: withAlpha(t.accent, 0.5 * rowAlpha),
        clip,
      })
    })
  }

  private drawEasing(
    row: GpuEasingRow,
    rRect: DOMRect,
    cardClip: Clip,
    rowAlpha: number,
    clock: number,
  ) {
    const t = this.curTokens
    this.drawSeparator(row.row, rRect, cardClip)
    const { bodyClip: body } = this.drawHead(
      row.row,
      row.x,
      row.display,
      row.isModified(),
      cardClip,
      rowAlpha,
    )
    const delay = row.wave.at - clock
    const snap = row.snap()
    const mRect = this.rectOf(row.mini)
    const accent = withAlpha(t.accent, rowAlpha)
    this.pushLine(at(this.morph(row.mini, row.miniCurve(), delay, snap, mRect), mRect), accent, 1.5)
    this.readout(row.read, mRect.top + mRect.height / 2, withAlpha(t.label, rowAlpha))
    if (!body) return
    this.inBody(row.x, () => {
      const br = this.rectOf(row.box)
      const radius = t.radiusMd
      this.pushPrim({
        x: br.left,
        y: br.top,
        w: br.width,
        h: br.height,
        clip: body,
        color: withAlpha(t.segBg, rowAlpha),
        radius,
        kind: 1,
      })
      const g = at(row.guides(), br)
      if (g.length === 4) {
        const line = withAlpha(t.line, rowAlpha)
        for (const y of [g[1]!, g[3]!])
          this.pushLine([br.left + 12, y, br.right - 12, y], line, 1, body)
        this.pushLine(g, line, 1, body)
      }
      const arms = at(this.morph(row.handles[0]!, row.arms(), delay, snap, br), br)
      if (arms.length === 8) {
        const dim = withAlpha(t.dim, rowAlpha)
        this.pushLine(arms.slice(0, 4), dim, 1, body)
        this.pushLine(arms.slice(4), dim, 1, body)
      }
      this.pushLine(at(this.morph(row.box, row.curve(), delay, snap, br), br), accent, 1.5, body)
      row.handles.forEach((h, i) => {
        if (arms.length !== 8) return
        const activeHandle = this.isFocused(h) || (this.curPanelHovered && h.matches(":active"))
        const d = 12 * this.ease(h, "grab", activeHandle ? 1.2 : 1, 30)
        const cx = arms[i * 4 + 2]!
        const cy = arms[i * 4 + 3]!
        this.shape({
          x: cx - d / 2,
          y: cy - d / 2,
          w: d,
          h: d,
          radius: d / 2,
          fill: withAlpha(t.bg, rowAlpha),
          ring: -2,
          ringColor: accent,
          shadow: [0.3, 3, 1],
          clip: body,
        })
      })
      const chipsEl = row.chips[0]?.parentElement
      if (!chipsEl) return
      const cr = this.rectOf(chipsEl)
      this.pushPrim({
        x: cr.left,
        y: cr.top,
        w: cr.width,
        h: cr.height,
        clip: body,
        color: withAlpha(t.segBg, rowAlpha),
        radius,
        kind: 1,
      })
      for (const chip of row.chips) {
        const r = this.rectOf(chip)
        const checked = chip.getAttribute("aria-checked") === "true"
        const on = this.ease(chip, "on", checked ? 1 : 0, 30)
        if (on > 0.005)
          this.pushPrim({
            x: r.left,
            y: r.top,
            w: r.width,
            h: r.height,
            clip: body,
            color: withAlpha(t.pillBg, on * rowAlpha),
            color2: [0, 0, 0, 0],
            radius: t.radiusSm,
            glowOrBlur: t.glowStrength * 0.6,
            kind: 3,
          })
        this.drawText(
          chip.textContent ?? "",
          r.left + r.width / 2,
          r.top + r.height / 2,
          withAlpha(
            this.hot(chip, checked || this.isHovered(chip) || this.isFocused(chip)),
            rowAlpha,
          ),
          { px: t.textControl, align: "center", clip: body },
        )
      }
    })
  }

  private getDigitCellWidth(valPx: number, fontFamily: string): number {
    if (
      this.cachedCellPx === valPx &&
      this.cachedCellFont === fontFamily &&
      this.cachedCellWidth > 0
    ) {
      return this.cachedCellWidth
    }
    let cell = 0
    for (let d = 0; d <= 9; d++) {
      cell = Math.max(cell, this.atlas.measure(String(d), valPx, 400, fontFamily))
    }
    this.cachedCellPx = valPx
    this.cachedCellFont = fontFamily
    this.cachedCellWidth = cell
    return cell
  }

  private buildScene(dt: number, scale: number, reducedGlobal: boolean): boolean {
    let reducedMotion = reducedGlobal
    this.primCount = 0
    this.pointCount = 0
    this.maskCount = 0
    this.curScale = scale
    this.hotRows.clear()
    this.atlas.beginFrame()
    let anyMoving = false
    const win = this.win
    const activeEl = this.doc.activeElement
    this.curActiveEl = activeEl
    this.curFocusVisible = activeEl !== null && activeEl.matches(":focus-visible")
    const clock = performance.now()
    const revealing = isAnyRevealing()
    const revealVer = getRevealVersion()
    // A lost end event can't keep the loop awake: no token spring runs this long.
    if (this.tokenRuns.size > 0 && clock - this.tokenEventAt > 4000) this.tokenRuns.clear()
    // Gliding tokens are re-read every frame; rects only while one that moves layout glides.
    let layoutGliding = false
    for (const runs of this.tokenRuns.values())
      for (const name of runs.keys()) if (LAYOUT_TOKENS.has(name)) layoutGliding = true
    if (this.tokenRuns.size > 0) {
      this.styleVersion++
      if (layoutGliding) this.layoutVersion++
      anyMoving = true
    }

    const drawn: DOMRect[] = []
    this.frameTexts = []
    const orderedPanels = [...this.panels].sort((a, b) => {
      if (a.inline !== b.inline) return a.inline ? -1 : 1
      return (
        (parseInt(a.root.style.zIndex || "0", 10) || 0) -
        (parseInt(b.root.style.zIndex || "0", 10) || 0)
      )
    })

    for (const panel of orderedPanels) {
      this.curMask = 0
      panel.page?.frame?.(this.frameNow)
      const pRect = panel.root.getBoundingClientRect()
      if (!panel.root.isConnected || panel.root.hidden || pRect.width <= 0 || pRect.height <= 0) {
        this.placeBackdrop(panel)
        continue
      }

      reducedMotion = reducedGlobal || (panel.landing?.() ?? false)
      const presenceRunning = panel.presence?.() ?? false
      if (presenceRunning) anyMoving = true
      const rawTokens = readPanelTokens(panel.root, this.styleVersion)
      const pageB = panel.page
      this.curPanelRect = pRect
      this.curPanelScrollTop = panel.root.scrollTop
      // Keys quiet hover until the pointer moves (data-keyboard), as in the DOM.
      this.curPanelHovered = panel.root.matches(":hover") && !("keyboard" in panel.root.dataset)
      this.curLayoutKey =
        ((this.layoutVersion * 31 +
          Math.round(pRect.width * 4) * 17 +
          Math.round(pRect.height * 4) * 13 +
          Math.round(rawTokens.fontSize * 10) * 7 +
          rawTokens.labelWeight * 3 +
          Math.round(rawTokens.inset * 4) +
          (pageB ? pageB.layoutKey() * 7919 : 0)) *
          100 +
          (revealVer % 100)) |
        0
      const opening = clock < (this.openUntil.get(panel) ?? 0)
      const leaving = panel.root.dataset.leaving === "true"
      const panelRevealing = revealing && isRevealingIn(panel.root)
      const bodyRevealing = panelRevealing && isRevealingIn(panel.body)
      const pageMoving = pageB?.moving?.() ?? false
      if (pageMoving) anyMoving = true
      this.curBypassRectCache =
        opening ||
        leaving ||
        (panelRevealing && !bodyRevealing) ||
        layoutGliding ||
        pageMoving ||
        presenceRunning

      const tokens = rawTokens
      this.curTokens = tokens
      this.curLocks = panel.locks
      this.curDt = reducedMotion ? 1 : dt
      this.curReduced = reducedMotion
      // Follow CSS open/close and reveal animations: fade with the panel, and keep drawing while they run.
      if (opening || leaving) {
        this.curAlpha = Number(getComputedStyle(panel.root).opacity) || 0
        anyMoving = true
      } else {
        this.curAlpha = 1
      }
      if (revealing) anyMoving = true
      const blurMul = reducedMotion ? 0 : tokens.blurStrength
      const outerClip = panel.inline
        ? getEffectiveClipRect(panel.root, win, this.styleVersion)
        : ([0, 0, win.innerWidth, win.innerHeight] as [number, number, number, number])
      // Growing out of its chip, the card takes the morph's shape and the content is clipped to it.
      const morph = panel.morph?.(this.frameNow)
      const shown = morph ? clamp(morph.progress, 0, 1) : 1
      const card = morph ? new DOMRect(morph.x, morph.y, morph.w, morph.h) : pRect
      const cardRadius = morph ? morph.radius : tokens.panelRadius
      if (morph) anyMoving = true
      let panelClip = intersectClip(outerClip, [pRect.left, pRect.top, pRect.right, pRect.bottom])
      if (morph)
        panelClip = intersectClip(panelClip, [card.left, card.top, card.right, card.bottom])
      const pillFill = tokens.pillBg

      // 1. Panel card. Glass thins it over the backdrop blur placed under the canvas; a panel
      // lying over another firms up, since the canvas can't blur what it drew below. A page has no
      // card: its background and glass header are the DOM's, under the canvas.
      if (pageB) this.placeBackdrop(panel)
      const covers = drawn.some(
        (r) =>
          r.left < card.right && r.right > card.left && r.top < card.bottom && r.bottom > card.top,
      )
      if (!pageB) drawn.push(card)
      const glass = tokens.glass * (1 - this.ease(panel.root, "solid", covers ? 1 : 0, 18))
      if (!pageB) this.placeBackdrop(panel, card, outerClip, cardRadius, glass, tokens.glassTone)
      // At the chip end the card wears the chip's look: opaque, with its 0 4px 16px shadow.
      const shadow = tokens.isLight ? 0.16 : 0.48
      const chrome = panel.inline ? tokens.chrome : 1
      if (!pageB && chrome > 0.005)
        this.pushPrim({
          x: card.left,
          y: card.top,
          w: card.width,
          h: card.height,
          clip: outerClip,
          color: withAlpha(tokens.bg, (1 - glass * 0.2 * shown) * chrome),
          color2: withAlpha(tokens.line, tokens.line[3] * chrome),
          radius: cardRadius,
          strokeWidth: 1,
          glowOrBlur: panel.inline ? 0 : 16 + 2 * shown,
          kind: 0,
          p0: panel.inline ? 0 : 0.35 + (shadow - 0.35) * shown,
          aux2: withAlpha(tokens.rim, (shown < 1 ? shown : tokens.rim[3]) * chrome),
        })
      if (morph && this.maskCount < MAX_MASKS) {
        this.masks.set(
          [morph.x, morph.y, morph.w, morph.h, morph.radius, morph.fadeTop, morph.fadeBottom, 0],
          this.maskCount * 8,
        )
        this.curMask = ++this.maskCount
      }

      let bodyClip: [number, number, number, number] = [
        panelClip[0] + 1,
        panelClip[1] + 1,
        panelClip[2] - 1,
        panelClip[3] - 1,
      ]
      if (panel.isPopoverOpen() && !pageB) {
        const pop = panel.root.querySelector<HTMLElement>(".knobs-popover:not([hidden])")
        if (pop)
          bodyClip = [
            bodyClip[0],
            Math.max(bodyClip[1], this.rectOf(pop).bottom + 2),
            bodyClip[2],
            bodyClip[3],
          ]
      }
      // A page's header sticks while the body scrolls under it: its rects are read fresh, and the
      // body is clipped to below it.
      const headClip = bodyClip
      const bypass = this.curBypassRectCache
      if (pageB) this.curBypassRectCache = true
      this.curClip = headClip

      // 2. Header (an embedded panel may have none)
      if (!panel.header.hidden) {
        this.curSubHovered = this.curPanelHovered && panel.header.matches(":hover")
        const tRect = this.rectOf(panel.titleEl)
        const px = pageB ? tokens.fontSize + 3 : tokens.textTitle
        const indent = pageB ? tokens.pad + tokens.inset + 1 : 0
        // Dims while compare is held, like the DOM's 0.2 s opacity transition.
        const comparing = panel.root.hasAttribute("data-comparing")
        this.drawText(
          this.fit(panel.titleEl.textContent ?? "", tRect.width - indent, px, 600),
          tRect.left + indent,
          tRect.top + tRect.height * 0.5,
          withAlpha(tokens.text, this.ease(panel.titleEl, "compare", comparing ? 0.4 : 1, 26)),
          { px, weight: 600, clip: panelClip, track: pageB ? -0.015 : -0.01 },
        )
        for (const hb of panel.headerButtons) {
          if (hb.button.hidden) continue
          const bRect = this.rectOf(hb.button)
          const hovered = !hb.button.disabled && this.isHovered(hb.button)
          if (hovered) this.curSubHovered = false
          const focused = this.isFocused(hb.button)
          const expanded = hb.button.getAttribute("aria-expanded") === "true"
          const alpha = this.ease(
            hb.button,
            "dim",
            hb.button.disabled ? tokens.disabledOpacity : 1,
            30,
          )
          const on = hovered || focused || expanded
          this.drawRoundWash(bRect, alpha, this.wash(hb.button, on), panelClip)
          const iconColor = withAlpha(this.hot(hb.button, on), alpha)
          const die = panel.headerDie?.button === hb.button ? panel.headerDie.die : undefined
          if (die) this.drawDie(die, bRect, iconColor, panelClip)
          else this.drawIcon(hb.icon, tokens.iconSize, bRect, iconColor, panelClip)
        }
      }

      // 3. Preset strip
      const ps = panel.presetStrip
      const hinting = panel.root.classList.contains("knobs-hinting")
      if (!ps.element.hidden) {
        const psHovered = this.curPanelHovered && ps.element.matches(":hover")
        this.curSubHovered = psHovered
        const psRect = this.rectOf(ps.element)
        const trackRect = this.rectOf(ps.track)
        this.pushPrim({
          x: psRect.left,
          y: psRect.top,
          w: psRect.width,
          h: psRect.height,
          color: tokens.segBg,
          color2: tokens.accent,
          radius: tokens.radius,
          glowOrBlur: tokens.glowStrength * 8,
          kind: 1,
          p0: psHovered || this.isFocused(ps.element) ? 0.4 : 0,
        })

        const stripClip = intersectClip(headClip, [
          psRect.left,
          psRect.top,
          psRect.right,
          psRect.bottom,
        ])
        const activeState = ps.getActiveState()
        const chipButtons = ps.getButtons()
        const activeBtn =
          activeState.activeIndex >= 0 ? chipButtons[activeState.activeIndex] : undefined
        const pe = ps.pillEdges
        const activeBtnRect = activeBtn ? this.rectOf(activeBtn) : undefined
        const panned = livePill(ps.track)
        if (activeBtn && activeBtnRect && !activeState.isCustom) {
          const left = activeBtnRect.left - trackRect.left
          const right = left + Math.max(20, activeBtnRect.width)
          const top = activeBtnRect.top - trackRect.top
          this.carry(pe, activeBtn, left, right, ps.pillY, top)
          // A pan holds the pill with the fingers, as a drag holds a slider's fill.
          if (panned) {
            pe.snap(panned.left, panned.right)
            ps.pillY.snap(panned.top)
          } else if (reducedMotion || pe.end.x - pe.start.x <= 1) {
            pe.snap(left, right)
            ps.pillY.snap(top)
          } else {
            pe.to(left, right, 0, trailScale(tokens.blurStrength))
            ps.pillY.set(top)
          }
          ps.pillAlpha.set(1)
        } else {
          ps.pillAlpha.set(0)
        }

        for (const sp of [pe.start, pe.end, ps.pillY, ps.pillAlpha]) {
          if (reducedMotion) sp.snap(sp.target)
          else {
            sp.step(dt)
            if (!sp.resting) anyMoving = true
          }
        }

        const pillAlpha = clamp(ps.pillAlpha.x, 0, 1)
        if (pillAlpha > 0.01) {
          this.pushPrim({
            x: trackRect.left + pe.start.x,
            y: trackRect.top + ps.pillY.x,
            w: Math.max(18, pe.end.x - pe.start.x),
            h: Math.max(16, activeBtnRect?.height ?? trackRect.height),
            clip: stripClip,
            color: withAlpha(pillFill, pillAlpha),
            color2: withAlpha(tokens.pillBorder, pillAlpha),
            radius: tokens.radiusMd,
            glowOrBlur: tokens.glowStrength,
            kind: 3,
            blurX: reducedMotion ? 0 : clamp(pe.velocity * 0.006 * tokens.motionBlur, -8, 8),
          })
        }

        for (let i = 0; i < chipButtons.length; i++) {
          const btn = chipButtons[i]!
          const br = this.rectOf(btn)
          if (br.right < stripClip[0] || br.left > stripClip[2]) continue
          const isActive = i === activeState.activeIndex
          const chipHovered = this.isHovered(btn)
          if (chipHovered) this.curSubHovered = false
          this.drawText(
            btn.textContent ?? "",
            br.left + br.width * 0.5,
            br.top + br.height * 0.5,
            withAlpha(this.hot(btn, isActive || chipHovered), this.missed(btn, hinting)),
            {
              px: tokens.textControl,
              weight: isActive ? 600 : tokens.labelWeight,
              align: "center",
              clip: stripClip,
            },
          )
        }

        if (ps.saveButton && !ps.saveButton.hidden) {
          const sr = this.rectOf(ps.saveButton)
          const hot = this.isHovered(ps.saveButton)
          this.drawText(
            "+",
            sr.left + sr.width * 0.5,
            sr.top + sr.height * 0.5,
            this.hot(ps.saveButton, hot, tokens.dim),
            {
              px: tokens.textTitle,
              weight: 400,
              align: "center",
            },
          )
        }
      }

      const tileClips = new Map<HTMLElement, Clip>()
      const clipToTile = (node: HTMLElement, clip: Clip) => {
        if (!tileClips.size) return clip
        const tile = node.closest<HTMLElement>(".knobs-tile")
        const tc = tile && tileClips.get(tile)
        return tc ? intersectClip(clip, tc) : clip
      }
      if (pageB) {
        // A page's own actions sit in its header, quiet until hovered.
        this.curSubHovered = this.curPanelHovered
        for (const btn of panel.actionButtons)
          if (!btn.hidden && btn.isConnected)
            this.drawButton(btn, activeEl, hinting, 999, tokens.textControl, false)
        this.curBypassRectCache = bypass
        const hr = this.rectOf(panel.header)
        if (hr.height > 0)
          bodyClip = intersectClip(bodyClip, [bodyClip[0], hr.bottom, bodyClip[2], bodyClip[3]])
        this.curClip = bodyClip

        // Section headings, then the group cards (custom cards are the DOM's).
        for (const section of pageB.sections()) {
          const head = section.head
          if (!head || section.element.hidden) continue
          const sr = this.rectOf(head)
          if (sr.width <= 0 || sr.bottom < bodyClip[1] || sr.top > bodyClip[3]) continue
          const indent = tokens.pad + tokens.inset + 1
          const px = tokens.fontSize + 3
          // A label fading in (its section just appeared) carries the DOM's opacity; one dimmed
          // by a highlight fades its text toward the page, as the DOM does.
          const lit = pageB.emphasis?.(head)
          const shown =
            (head.style.opacity ? Number(head.style.opacity) : 1) * (1 - (lit?.dim ?? 0))
          this.drawText(
            this.fit(head.textContent ?? "", sr.width - indent * 2, px, 600),
            sr.left + indent,
            sr.top + sr.height * 0.5,
            withAlpha(tokens.text, shown),
            { px, weight: 600, track: -0.015 },
          )
          if (lit?.dot) this.drawMark(lit.dot, lit.mark)
        }
        for (const tile of pageB.tiles) {
          const tr = this.rectOf(tile)
          // A card easing its height clips what's inside it, as the DOM's overflow does.
          if (tile.style.height && tr.width > 0)
            tileClips.set(tile, intersectClip(bodyClip, [tr.left, tr.top, tr.right, tr.bottom]))
          if (tr.width <= 0 || tr.bottom < bodyClip[1] || tr.top > bodyClip[3]) continue
          this.pushPrim({
            x: tr.left,
            y: tr.top,
            w: tr.width,
            h: tr.height,
            color: tokens.bg,
            color2: tokens.line,
            radius: tokens.panelRadius,
            strokeWidth: 1,
            glowOrBlur: 0,
            kind: 0,
            p0: 0,
            aux2: tokens.rim,
          })
        }
      }

      // 4. Group headers
      if (bodyRevealing || pageMoving) this.curBypassRectCache = true
      const bodyHovered = this.curPanelHovered && panel.body.matches(":hover")
      this.curSubHovered = bodyHovered
      const panelAlpha = this.curAlpha
      for (const g of panel.groups) {
        this.curAlpha = panelAlpha * this.presence(g.element)
        const gr = this.rectOf(g.element)
        if (gr.width <= 0 || gr.bottom < bodyClip[1] || gr.top > bodyClip[3]) continue
        this.curClip = clipToTile(g.element, bodyClip)
        const lr = this.rectOf(g.labelEl)
        if (g.title) {
          // A page card's title; a hovered (or just applied) preset's name crossfades over it.
          const peek = g.peek
            ? this.ease(g.element, "peek", "peek" in g.element.dataset ? 1 : 0, 30)
            : 0
          const px = tokens.textTitle
          const cy = lr.top + lr.height * 0.5
          if (peek < 0.995)
            this.drawText(
              this.fit(g.labelEl.textContent ?? "", lr.width, px, 600),
              lr.left,
              cy,
              withAlpha(tokens.text, 1 - peek),
              { px, weight: 600, track: -0.01 },
            )
          if (g.peek && peek > 0.005)
            this.drawText(
              this.fit(g.peek.textContent ?? "", lr.width, px, 600),
              lr.left,
              cy,
              withAlpha(tokens.text, peek),
              { px, weight: 600, track: -0.01 },
            )
        } else
          this.drawText(
            tokens.groupUpper
              ? (g.labelEl.textContent ?? "").toUpperCase()
              : (g.labelEl.textContent ?? ""),
            lr.left,
            lr.top + lr.height * 0.5,
            tokens.groupColor,
            { px: Math.max(9, tokens.groupSize), weight: 600, track: tokens.groupTracking },
          )
        // --k-group-divider: a hairline over every group but the first.
        if (!g.title && tokens.groupDivider[3] > 0 && g.element.previousElementSibling)
          this.pushPrim({
            x: gr.left,
            y: gr.top,
            w: gr.width,
            h: 1,
            color: tokens.groupDivider,
            kind: 1,
          })
        if (g.presets?.menu && g.presets.menuValue && g.presets.isMenu?.())
          this.drawHeadMenu(g.presets.menu, g.presets.menuValue, hinting)
        else if (g.presets)
          anyMoving =
            this.drawSeg(g.presets.seg, g.presets.buttons, g.presets.pill, {
              px: tokens.textMeta,
              weight: 500,
              hinting,
              canFadeOff: true,
              minPill: 8,
              reducedMotion,
            }) || anyMoving
        for (const gb of g.buttons) {
          this.drawButton(
            gb,
            activeEl,
            hinting,
            tokens.radiusSm,
            Math.max(10, tokens.textMeta),
            false,
          )
        }
        // The reset fades and scales on its GPU spring, matching the DOM transition.
        const reset = g.reset
        const resetShown = this.ease(reset, "shown", reset.dataset.shown === "true" ? 1 : 0, 28)
        const alpha = resetShown * this.missed(reset, hinting)
        if (alpha > 0.005) {
          const br = this.rectOf(reset)
          const hovered = !reset.disabled && this.isHovered(reset)
          const focused = this.isFocused(reset)
          this.drawRoundWash(br, alpha, this.wash(reset, hovered || focused))
          this.drawIcon(
            "reset",
            tokens.iconSm,
            br,
            withAlpha(this.hot(reset, hovered || focused), alpha),
            undefined,
            0.55 + 0.45 * resetShown,
          )
        }
        // The group's die: quiet (dim) until hovered or focused.
        if (g.die && !g.die.button.hidden) {
          const { button, die } = g.die
          const dr = this.rectOf(button)
          const on = !button.disabled && (this.isHovered(button) || this.isFocused(button))
          const dimmed =
            this.ease(button, "dim", button.disabled ? tokens.disabledOpacity : 1, 30) *
            this.missed(button, hinting)
          this.drawRoundWash(dr, dimmed, this.wash(button, on))
          this.drawDie(die, dr, withAlpha(this.hot(button, on, tokens.dim), dimmed))
        }
      }

      this.curAlpha = panelAlpha
      // 5. Grouped cards, then their rows. With --k-row-gap each row is its own bar instead.
      const separate = tokens.rowGap > 0
      const cardRects = new Map<HTMLElement, DOMRect>()
      for (const card of panel.cards) {
        const cr = this.rectOf(card)
        cardRects.set(card, cr)
        if (cr.width <= 0 || cr.bottom < bodyClip[1] || cr.top > bodyClip[3]) continue
        this.curClip = clipToTile(card, bodyClip)
        this.curAlpha = panelAlpha * this.presence(card)
        const bars = separate
          ? [...(card.children as HTMLCollectionOf<HTMLElement>)].flatMap((c) =>
              c.classList.contains("knobs-spring")
                ? [...c.querySelectorAll<HTMLElement>(".knobs-sub")]
                : [c],
            )
          : [card]
        for (const bar of bars) {
          if (bar.hidden) continue
          const br = bar === card ? cr : this.rectOf(bar)
          if (br.height < 0.5) continue
          const a = bar === card ? 1 : this.presence(bar)
          this.pushPrim({
            x: br.left,
            y: br.top,
            w: br.width,
            h: br.height,
            color: withAlpha(tokens.surface, a),
            radius: tokens.radius,
            kind: 1,
          })
        }
      }
      this.curClip = bodyClip
      this.curAlpha = panelAlpha
      const washed = new Set<HTMLElement>()
      const rowsAlpha = this.curAlpha
      for (const row of panel.rows) {
        this.curSubHovered = bodyHovered
        this.curAlpha = panelAlpha
        const rRect = this.rectOf(row.row)
        if (rRect.width <= 0 || rRect.bottom < bodyClip[1] || rRect.top > bodyClip[3]) continue
        // A row folding open or shut (the page's filter) fades with its DOM reveal.
        const folding = revealing && isRevealing(row.row)
        this.curAlpha = folding
          ? rowsAlpha * (Number(getComputedStyle(row.row).opacity) || 0)
          : rowsAlpha
        const rowAlpha = this.missed(row.row, hinting)
        const rowCenterY = rRect.top + rRect.height * 0.5
        const hovered = this.isHovered(row.row)
        this.curSubHovered = hovered
        const isX = row.kind === "color" || row.kind === "point" || row.kind === "easing"
        const hot = isX
          ? (hovered && row.x.head.matches(":hover")) || this.isFocused(row.x.head)
          : hovered || row.row.classList.contains("knobs-active") || this.hasFocusVisible(row.row)
        if (hot) {
          this.hotRows.add(row.row)
          const parent = row.row.parentElement
          if (parent && !parent.classList.contains("knobs-card")) {
            const outer = row.row.closest(".knobs-card > *")
            if (outer) this.hotRows.add(outer)
          }
        }
        const parentEl = row.row.parentElement!
        const card = cardRects.get(parentEl) ?? this.rectOf(parentEl)
        // The selection wash covers the whole item (a spring's sliders and curve, an open
        // editor), once, beneath everything the item draws, like its DOM background.
        const item = parentEl.classList.contains("knobs-card")
          ? row.row
          : row.row.closest<HTMLElement>(".knobs-card > *")
        let cardClip = clipToTile(
          row.row,
          intersectClip(bodyClip, [card.left, card.top, card.right, card.bottom]),
        )
        if (folding)
          cardClip = intersectClip(cardClip, [rRect.left, rRect.top, rRect.right, rRect.bottom])
        // Arriving or leaving: fade with the DOM's reveal, clipped to the folding height.
        if (item) {
          const shown = this.presence(item) * this.presence(item.parentElement!)
          if (shown < 1) {
            this.curAlpha = panelAlpha * shown
            const ir = item === row.row ? rRect : this.rectOf(item)
            cardClip = intersectClip(cardClip, [ir.left, ir.top, ir.right, ir.bottom])
          }
        }
        this.curClip = cardClip
        this.curSelected = 0
        if (item && !washed.has(item)) {
          washed.add(item)
          const sel = this.ease(item, "sel", item.classList.contains("knobs-selected") ? 1 : 0, 30)
          if (item === row.row) this.curSelected = sel
          if (sel > 0.005) {
            const ir = item === row.row ? rRect : this.rectOf(item)
            this.pushPrim({
              x: ir.left,
              y: ir.top,
              w: ir.width,
              h: ir.height,
              color: withAlpha(tokens.accent, 0.1 * sel),
              corners: this.rowCorners(item),
              kind: 1,
            })
          }
        }

        if (row.kind === "knob") {
          const sl = row.slider
          const rolling =
            !reducedMotion &&
            sl.digitPlaces.some(
              (d) =>
                !d.wheel.resting(clock) ||
                !d.presence.resting(clock) ||
                clock - d.enterAt < d.enterMs,
            )
          if (rolling) anyMoving = true
          const focused = this.isFocused(sl.track)
          const dragging = sl.isDragging()
          // The handle follows the same states as its CSS (hover, keyboard focus, drag).
          sl.handleSpring.set(
            dragging
              ? 1
              : hovered || focused
                ? Math.max(0.65, tokens.handleRest)
                : tokens.handleRest,
          )
          sl.fillSpring.omega = tokens.fillOmega
          sl.fillSpring.zeta = tokens.fillZeta
          for (const sp of [sl.fillSpring, sl.handleSpring]) {
            if (reducedMotion) sp.snap(sp.target)
            else {
              sp.step(dt)
              if (!sp.resting) anyMoving = true
            }
          }

          this.drawRowHover(row.row, rRect, hovered || dragging)

          // Edge blur (--k-motion-blur): a smear as wide as the edge's speed, like the DOM's.
          const edgeSpeed =
            Math.max(Math.abs(sl.fillSpring.v), Math.abs(sl.velocity.velocity[0])) * rRect.width
          const blurX = reducedMotion ? 0 : Math.min(28, edgeSpeed * 0.022 * tokens.motionBlur)
          if (blurX > 0) anyMoving = true
          const fillTint = mixColor(
            mixColor(
              tokens.fillRest,
              tokens.fillHover,
              this.ease(row.row, "fillHover", hovered ? 1 : 0, this.hoverOmega(hovered)),
            ),
            tokens.fillActive,
            this.ease(row.row, "fill", dragging ? 1 : 0),
          )
          // Ticks and the handle fade where the text sits: the zone follows the readout's width
          // (and the lock beside it).
          const digitsText = sl.getDigitsText()
          const lock = this.curLocks?.get(sl.label)
          const locked = lock?.dataset.on === "true"
          const vRect = this.rectOf(sl.valueButton, digitsText.length * 2 + (locked ? 1 : 0))
          const lRect = this.rectOf(sl.label)
          const zone = this.ease(
            row.row,
            "zone",
            vRect.width > 0 ? rRect.right - vRect.left : undefined,
            28,
            1,
            0.1,
          )
          const notch = this.ease(
            row.row,
            "notch",
            // Only while the slider is in hand: at rest a stray tick reads as an artifact.
            sl.isMagnetized()
              ? 0.95
              : !(hovered || focused || dragging)
                ? 0
                : row.isModified()
                  ? 0.55
                  : 0.38,
            22,
          )

          this.pushPrim({
            x: rRect.left,
            y: rRect.top,
            w: rRect.width,
            h: rRect.height,
            color: withAlpha(fillTint, rowAlpha),
            color2: withAlpha(tokens.handle, rowAlpha),
            corners: this.rowCorners(row.row),
            glowOrBlur: tokens.glowStrength,
            kind: 2,
            blurX,
            // Kind 2 has no vertical blur; the slot carries the handle's inset from the fill edge.
            blurY: tokens.handleInset,
            p0: sl.fillSpring.x,
            p1: sl.handleSpring.x,
            p2: sl.tickCount,
            p3: this.ease(row.row, "ticks", dragging ? 1 : hovered || focused ? 0.7 : 0),
            aux: [zone, sl.notchRatio, notch, lRect.right - rRect.left],
            aux2: withAlpha(tokens.accent, rowAlpha),
          })

          this.drawRowLabel(sl.label, row.display, false, rowCenterY, rowAlpha, lRect)

          if (!sl.isEditing()) {
            const unitText = sl.getUnitText()
            const valCol = withAlpha(this.hot(sl.valueButton, dragging || focused), rowAlpha)
            // --k-readout-mark: a modified value takes the modified colour behind a dot.
            const mark =
              tokens.readoutMark > 0
                ? this.ease(row.row, "mark", row.isModified() ? 1 : 0, 26, 0.6)
                : 0
            const ink = mark > 0.005 ? cssMix(tokens.modified, valCol, clamp(mark, 0, 1)) : valCol
            const unitInk = withAlpha(ink, rowAlpha)
            const valPx = tokens.textControl
            let rightEdge = vRect.right
            // The decile pop scales the whole readout about its right edge.
            const popAge = clock - sl.poppedAt
            const pop = reducedMotion ? 1 : popScale(popAge)
            if (popAge < POP_MS) anyMoving = true
            const zoom = { scale: pop, origin: [rightEdge, rowCenterY] as const }
            if (unitText) {
              rightEdge -=
                this.drawText(
                  unitText,
                  rightEdge,
                  rowCenterY,
                  tokens.unitColor ? withAlpha(tokens.unitColor, rowAlpha) : unitInk,
                  {
                    px: valPx,
                    weight: 400,
                    align: "right",
                    family: tokens.valueFamily,
                    ...zoom,
                  },
                ) + tokens.unitGap
            }

            {
              // A reel per place, read through a feathered slot: every face between the old and
              // new digit passes by, blurring with speed the way rolling-number's envelope does.
              // Same reel as the DOM readout: faces 2.1em apart, seen through a 2.1em window
              // whose top and bottom 0.5em feather out (.knobs-digits line-height / --rn-edge-fade).
              const faceH = valPx * 2.1
              const slotClip = intersectClip(bodyClip, [
                rRect.left,
                rowCenterY - faceH / 2,
                rRect.right,
                rowCenterY + faceH / 2,
              ])
              const feather = valPx * 0.5
              const text = {
                px: valPx,
                weight: 400,
                align: "right" as const,
                clip: slotClip,
                feather,
                family: tokens.valueFamily,
                ...zoom,
              }
              const maxBlur = faceH * 0.45 * blurMul
              const cell = this.getDigitCellWidth(valPx, tokens.valueFamily)
              const advance = (ch: string) =>
                ch >= "0" && ch <= "9"
                  ? cell
                  : this.atlas.measure(ch, valPx, 400, tokens.valueFamily)
              let digitsW = 0
              for (const ch of digitsText) digitsW += advance(ch)
              if (mark > 0.005) {
                const r = 2.5 * Math.max(0, Math.min(1.2, mark))
                const cx = rightEdge - digitsW - 6 - 2.5
                this.shape({
                  x: cx - r,
                  y: rowCenterY - r,
                  w: r * 2,
                  h: r * 2,
                  radius: r,
                  fill: withAlpha(tokens.modified, rowAlpha * clamp(mark, 0, 1)),
                  clip: bodyClip,
                })
              }
              sl.digitPlaces.forEach((place, j) => {
                const presence = clamp(place.presence.sample(clock).position, 0, 1)
                if (presence <= 0.005) return
                // Tabular figures: canvas can't turn on "tnum", so every digit gets the same cell
                // (the widest digit) with its glyph centred, at rest and mid-roll alike. Punctuation
                // keeps its own advance. Characters on their way out keep their last spot.
                let offset = this.placeOffsets.get(place)
                if (j < digitsText.length) {
                  let after = 0
                  for (let r = digitsText.length - 1; r > digitsText.length - 1 - j; r--)
                    after += advance(digitsText[r]!)
                  offset = after + advance(digitsText[digitsText.length - 1 - j]!) / 2
                  this.placeOffsets.set(place, offset)
                }
                const cx = rightEdge - (offset ?? 0)
                const rise = entranceOffset(clock - place.enterAt, place.enterMs) * faceH
                const col = withAlpha(ink, presence)
                const isDigit = place.ch >= "0" && place.ch <= "9"
                if (!isDigit) {
                  this.drawText(place.ch, cx, rowCenterY + rise, col, { ...text, align: "center" })
                  return
                }
                const { position, velocity } = place.wheel.sample(clock)
                // 4 faces/s starts the smear; 24 faces/s is full strength.
                const speed = Math.abs(velocity)
                const blurY = clamp((speed - 4) / 20, 0, 1) * maxBlur
                const [low, high] = place.wheel.span(clock)
                for (let k = Math.floor(low); k <= Math.ceil(high); k++) {
                  const y = rowCenterY + rise + (k - position) * faceH
                  if (Math.abs(y - rowCenterY) >= faceH) continue
                  this.drawText(numeral(k), cx, y, col, {
                    ...text,
                    align: "center",
                    blurY,
                    exact: position !== k || rise !== 0,
                  })
                }
              })
            }
          }
          this.drawRowOverlay(row.row, rRect, cardClip)
        } else if (row.kind === "choice" && row.menu && row.row.dataset.display === "menu") {
          // The same row as a compact drop-down button.
          this.drawRowHover(row.row, rRect, hovered)
          this.drawRowLabel(row.labelEl, row.display, row.isModified(), rowCenterY, rowAlpha)
          const b = row.menu.button
          const valueEl = row.menu.valueEl
          const br = this.rectOf(b)
          const open = b.getAttribute("aria-expanded") === "true"
          const on = this.isHovered(b) || this.isFocused(b) || open
          const wash = this.wash(b, on)
          this.pushPrim({
            x: br.left,
            y: br.top,
            w: br.width,
            h: br.height,
            color: withAlpha(cssMix(tokens.surfaceHi, tokens.segBg, wash), rowAlpha),
            color2: tokens.accent,
            radius: tokens.radiusMd,
            glowOrBlur: tokens.glowStrength * 8,
            kind: 1,
          })
          const vr = this.rectOf(valueEl)
          this.drawText(
            this.fit(
              valueEl.textContent ?? "",
              vr.width + 1,
              tokens.textControl,
              tokens.labelWeight,
            ),
            vr.left,
            rowCenterY,
            withAlpha(this.hot(b, on), rowAlpha),
            { px: tokens.textControl, weight: tokens.labelWeight, clip: cardClip },
          )
          const caret = b.querySelector("svg")
          if (caret)
            this.drawIcon(
              "caret",
              tokens.iconSm - 2,
              this.rectOf(caret),
              withAlpha(this.hot(b, on, tokens.dim, tokens.label), rowAlpha),
              cardClip,
            )
          this.drawRowOverlay(row.row, rRect, cardClip)
        } else if (row.kind === "choice") {
          this.drawRowHover(row.row, rRect, hovered)
          this.drawRowLabel(row.labelEl, row.display, row.isModified(), rowCenterY, rowAlpha)
          anyMoving =
            this.drawSeg(row.segEl, row.buttons, row.pill, {
              delay: row.wave.at - clock,
              alpha: rowAlpha,
              reducedMotion,
            }) || anyMoving
          this.drawRowOverlay(row.row, rRect, cardClip)
        } else if (row.kind === "action") {
          const b = row.button
          const on = hovered || this.isFocused(b)
          this.drawRowHover(row.row, rRect, hovered)
          const br = this.rectOf(b)
          this.drawText(
            b.textContent ?? "",
            br.left + tokens.inset,
            rowCenterY,
            withAlpha(this.hot(b, on, tokens.text, tokens.accent), rowAlpha),
            { px: tokens.textControl + 0.5, weight: tokens.labelWeight, clip: cardClip },
          )
          this.drawRowOverlay(row.row, rRect, cardClip)
        } else if (row.kind === "spring") {
          this.drawSpring(row, rRect, cardClip, rowAlpha, clock)
        } else if (row.kind === "color") {
          this.drawColor(row, rRect, cardClip, rowAlpha, clock)
        } else if (row.kind === "point") {
          this.drawPoint(row, rRect, cardClip, rowAlpha, clock)
        } else if (row.kind === "easing") {
          this.drawEasing(row, rRect, cardClip, rowAlpha, clock)
        } else if (row.kind === "toggle") {
          const tRect = this.rectOf(row.toggleEl)
          // The thumb is a span between two edges: the leading edge springs ahead and the trailing
          // one follows, so it stretches into a capsule while it travels; a press widens it toward
          // where it will go, like iOS.
          const on = row.toggleEl.getAttribute("aria-checked") === "true"
          const pressed = this.curPanelHovered && row.toggleEl.matches(":active")
          const pad = tokens.trayPad
          const d = tRect.height - pad * 2
          const travel = tRect.width - pad * 2 - d
          const from = pad + (on ? travel : 0) - (pressed && on ? 4 : 0)
          const to = pad + (on ? travel : 0) + d + (pressed && !on ? 4 : 0)
          const th = row.thumb
          if (reducedMotion || th.end.x - th.start.x <= 1) th.snap(from, to)
          else {
            th.to(from, to, row.wave.at - clock, trailScale(tokens.blurStrength)).step(dt)
            if (!th.resting) anyMoving = true
          }

          this.drawRowHover(row.row, rRect, hovered)
          this.drawRowLabel(row.labelEl, row.display, row.isModified(), rowCenterY, rowAlpha)

          // Colours follow the state over the DOM's 0.2 s (not the thumb, which a press moves),
          // starting with the row's turn in a cascade.
          const waiting = clock < row.wave.at
          if (waiting) anyMoving = true
          const prog = this.ease(row.toggleEl, "on", waiting ? undefined : on ? 1 : 0, 22)
          this.pushPrim({
            x: tRect.left,
            y: tRect.top,
            w: tRect.width,
            h: tRect.height,
            color: withAlpha(mixColor(tokens.toggleTrack, tokens.accent, prog), rowAlpha),
            color2: withAlpha(mixColor([1, 1, 1, 1], tokens.toggleThumb, prog), rowAlpha),
            glowOrBlur: tokens.glowStrength,
            kind: 4,
            p0: prog,
            p2: th.start.x,
            p3: th.end.x,
          })
          this.drawRowOverlay(row.row, rRect, cardClip)
        }
      }
      this.curAlpha = rowsAlpha
      this.curClip = bodyClip
      this.curSelected = 0
      this.curAlpha = panelAlpha

      // A highlight dims the other cards with a veil of the page's colour over all they drew
      // (the DOM lays the same veil over them), and dots the titles of those highlighted alone.
      if (pageB?.emphasis)
        for (const tile of pageB.tiles) {
          const lit = pageB.emphasis(tile)
          if (!lit) continue
          const tr = this.rectOf(tile)
          if (tr.width <= 0 || tr.bottom < bodyClip[1] || tr.top > bodyClip[3]) continue
          if (lit.dim > 0.0005)
            this.pushPrim({
              x: tr.left,
              y: tr.top,
              w: tr.width,
              h: tr.height,
              clip: clipToTile(tile, bodyClip),
              color: withAlpha(tokens.page, lit.dim),
              radius: tokens.panelRadius,
              kind: 1,
            })
          if (lit.dot) this.drawMark(lit.dot, lit.mark, clipToTile(tile, bodyClip))
        }

      // 6. Action buttons
      this.curSubHovered = this.curPanelHovered
      for (const btn of pageB ? [] : panel.actionButtons) {
        if (!btn.hidden && this.doc.body.contains(btn)) {
          this.drawButton(btn, activeEl, hinting, tokens.radius, tokens.textControl, true)
        }
      }

      // 7. Hint badges
      if (hinting) {
        for (const hintEl of panel.root.querySelectorAll<HTMLElement>(
          ".knobs-hint-layer .knobs-hint:not([hidden])",
        )) {
          const hr = hintEl.getBoundingClientRect()
          if (hr.width <= 0 || hr.height <= 0) continue
          this.pushPrim({
            x: hr.left,
            y: hr.top,
            w: hr.width,
            h: hr.height,
            clip: panelClip,
            color: tokens.accent,
            color2: tokens.accent,
            radius: tokens.radiusSm,
            glowOrBlur: tokens.glowStrength * 0.5,
            kind: 3,
          })
          const typedText =
            hintEl.querySelector(".knobs-hint-typed")?.textContent?.toUpperCase() ?? ""
          const restText =
            hintEl.querySelector(".knobs-hint-rest")?.textContent?.toUpperCase() ?? ""
          let hx = hr.left + 4
          for (const [text, color] of [
            [typedText, withAlpha(tokens.bg, tokens.hintTypedOpacity)],
            [restText, tokens.bg],
          ] as const) {
            if (!text) continue
            hx += this.drawText(text, hx, hr.top + hr.height * 0.5, color, {
              px: tokens.textCap,
              weight: 700,
              mono: true,
              clip: panelClip,
              track: 0.04,
            })
          }
        }
      }
    }

    this.curPanelRect = null
    this.curAlpha = 1
    this.curMask = 0
    const easing = this.easeMoving
    this.easeMoving = false
    this.lastTexts = this.frameTexts
    return anyMoving || easing
  }

  private isDataUnchanged(canvasW: number, canvasH: number): boolean {
    if (
      this.primCount !== this.prevPrimCount ||
      canvasW !== this.prevCanvasW ||
      canvasH !== this.prevCanvasH ||
      this.atlas.isDirty
    )
      return false
    const len = this.primCount * FLOATS_PER_PRIM
    for (let i = 0; i < len; i++) if (this.data[i] !== this.prevData[i]) return false
    if (this.pointCount !== this.prevPointCount) return false
    for (let i = 0; i < this.pointCount * 2; i++)
      if (this.points[i] !== this.prevPoints[i]) return false
    return true
  }

  private tick = (now: number) => {
    this.rafId = 0
    if (!this.device || !this.canvas || !this.context || this.panels.size === 0) {
      this.sleeping = true
      this.publishDiagnostics()
      return
    }

    const dt = Math.min(0.05, Math.max(1 / 240, (now - this.lastTick) / 1000))
    this.lastTick = now

    const win = this.win
    const dpr = Math.min(3, Math.max(1, win.devicePixelRatio || 1))
    const cssW = Math.max(1, win.innerWidth),
      cssH = Math.max(1, win.innerHeight)
    const pixelW = Math.max(1, Math.round(cssW * dpr)),
      pixelH = Math.max(1, Math.round(cssH * dpr))

    if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
      this.canvas.width = pixelW
      this.canvas.height = pixelH
    }

    const reducedMotion = win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
    this.frameNow = now
    const anyMoving = this.buildScene(dt, dpr, reducedMotion)

    if (!this.dirty && !anyMoving && this.isDataUnchanged(pixelW, pixelH)) {
      this.skippedFrames++
      if (++this.settleFrames < 2) this.rafId = win.requestAnimationFrame(this.tick)
      else this.sleeping = true
      this.publishDiagnostics()
      return
    }

    this.dirty = false
    this.settleFrames = 0
    this.frameCount++

    const floatLen = this.primCount * FLOATS_PER_PRIM
    this.prevData.set(this.data.subarray(0, floatLen))
    this.prevPrimCount = this.primCount
    this.prevPoints.set(this.points.subarray(0, this.pointCount * 2))
    this.prevPointCount = this.pointCount
    this.prevCanvasW = pixelW
    this.prevCanvasH = pixelH

    try {
      this.atlas.flush(this.device, this.labelTexture)
      if (floatLen > 0) {
        this.device.queue.writeBuffer(
          this.primBuffer,
          0,
          this.data.buffer,
          this.data.byteOffset,
          floatLen * 4,
        )
      }
      if (this.maskCount > 0)
        this.device.queue.writeBuffer(
          this.maskBuffer,
          0,
          this.masks.buffer,
          this.masks.byteOffset,
          this.maskCount * 32,
        )
      if (this.pointCount > 0)
        this.device.queue.writeBuffer(
          this.pointBuffer,
          0,
          this.points.buffer,
          this.points.byteOffset,
          this.pointCount * 8,
        )
      this.device.queue.writeBuffer(
        this.viewBuffer,
        0,
        new Float32Array([cssW, cssH, dpr, now / 1000]),
      )

      const encoder = this.device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      })
      if (this.primCount > 0) {
        pass.setPipeline(this.pipeline)
        pass.setBindGroup(0, this.bindGroup)
        pass.draw(6, this.primCount, 0, 0)
      }
      pass.end()
      this.device.queue.submit([encoder.finish()])
    } catch {}

    this.publishDiagnostics()
    this.rafId = win.requestAnimationFrame(this.tick)
  }
}

const managers = new WeakMap<Document, GpuOverlayManager>()
export function getGpuOverlayManager(doc: Document): GpuOverlayManager {
  let m = managers.get(doc)
  if (!m) {
    m = new GpuOverlayManager(doc)
    managers.set(doc, m)
  }
  return m
}
