import { colorHex, maxChroma, oklchToRgb, parseColor, type Oklch } from "../core/color.js"
import { bezierPoint, EASING_Y, EASINGS, easingName, type Bezier } from "../core/easing.js"
import {
  same,
  SPRING,
  type ColorField,
  type EasingField,
  type Knob,
  type Point,
  type PointField,
  type SpringField,
  type Value,
} from "../core/schema.js"
import { springMotion, springResponse, type SpringValue } from "../core/spring.js"
import type {
  GpuColorRow,
  GpuEasingRow,
  GpuExpander,
  GpuPointRow,
  GpuRowBinding,
  GpuSpringRow,
  GpuStrip,
  RowWave,
} from "./gpu/renderer.js"
import { arrowOf, bigOf } from "./prefs.js"
import { clamp } from "./motion.js"
import { reveal } from "./reveal.js"
import { createSlider, decimals, type Slider } from "./slider.js"
import { onPan } from "./swipe.js"

/** What a row needs from the panel. */
export interface RowContext<F> {
  readonly doc: Document
  readonly key: string
  readonly display: string
  readonly field: F
  readonly wave: RowWave
  get(): Value
  set(value: unknown, options?: { coalesce?: boolean }): void
  isModified(): boolean
  wake(): void
  /** Opens a disclosure row's editor at once, as it was before a reload. */
  readonly expanded?: boolean
  /** A flat spring's two number fields: their ranges, labels and units replace the defaults. */
  readonly parts?: { readonly duration: Knob; readonly bounce: Knob }
  onExpand?(open: boolean): void
}

/** A slider inside a compound row, adjusted by the panel's arrow keys like a knob row. */
export interface SubTrack {
  readonly slider: Slider
  readonly field: Knob
  get(): number
  set(value: number): void
}

export interface EditorRow {
  readonly row: HTMLElement
  readonly labelEl: HTMLElement
  /** Where the row's ↑↓ stop lands. */
  readonly input: HTMLElement
  /** Every ↑↓ stop in the row, in order (an open editor's parts follow its head). */
  stops(): HTMLElement[]
  /** `instant` places the value without motion (a different item arrived). */
  update(value: Value, delay: number, instant?: boolean): void
  /** A flat spring's halves changed range or label (see `RowContext.parts`). */
  retune?(parts: { readonly duration: Knob; readonly bounce: Knob }): void
  dispose(): void
  readonly tracks: readonly SubTrack[]
  readonly gpu: readonly GpuRowBinding[]
}

const reducedMotion = (doc: Document) =>
  doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false
const rgbCss = (rgb: readonly number[]) =>
  `rgb(${rgb.map((v) => Math.round(v * 2550) / 10).join(" ")})`
const pathOf = (pts: readonly number[]) => {
  let d = ""
  for (let i = 0; i < pts.length; i += 2)
    d += `${i ? "L" : "M"}${pts[i]!.toFixed(2)} ${pts[i + 1]!.toFixed(2)}`
  return d
}
const visible = (node: HTMLElement) => node.isConnected && !node.closest("[hidden]")

/** Applies a placement, skipping the transition when it's the first one or a resize. */
function place(nodes: readonly (HTMLElement | SVGElement)[], instant: boolean, apply: () => void) {
  if (instant) for (const n of nodes) n.style.transition = "none"
  apply()
  if (instant) {
    void nodes[0]?.getBoundingClientRect()
    for (const n of nodes) n.style.transition = ""
  }
}

function setPath(path: SVGPathElement, pts: readonly number[]) {
  path.style.setProperty("d", `path("${pathOf(pts)}")`)
}

/** One undo step per gesture: the first change that lands records history, the rest fold in. */
function gesture(c: RowContext<unknown>) {
  let committed = false
  return {
    start() {
      committed = false
    },
    set(value: unknown) {
      const before = c.get()
      c.set(value, { coalesce: committed })
      if (!same(before, c.get())) committed = true
    },
  }
}

function factory(doc: Document) {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const node = doc.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
  const svg = <K extends keyof SVGElementTagNameMap>(tag: K, cls?: string) => {
    const node = doc.createElementNS("http://www.w3.org/2000/svg", tag)
    if (cls) node.setAttribute("class", cls)
    return node
  }
  return { el, svg }
}

const arrow = arrowOf
const plainKey = (event: KeyboardEvent) => !event.metaKey && !event.ctrlKey && !event.isComposing

/** A size kept current by a ResizeObserver, so layout reads stay out of the frame loop. */
function measure(node: Element, onResize: () => void) {
  const size = { w: 0, h: 0, disconnect: () => ro.disconnect() }
  const ro = new ResizeObserver(() => {
    const w = (node as HTMLElement).clientWidth
    const h = (node as HTMLElement).clientHeight
    if (w === size.w && h === size.h) return
    size.w = w
    size.h = h
    if (w > 0) onResize()
  })
  ro.observe(node)
  return size
}

/**
 * The shared disclosure row: a head (label, summary, caret) that is the row's stop, and a body
 * revealed by Enter, Space or a click and folded away by Esc.
 */
let summaries = 0
function expander(c: RowContext<unknown>, summary: Node[], body: Node[]) {
  const { el, svg } = factory(c.doc)
  const row = el("div", "knobs-x")
  row.dataset.field = c.key
  const head = el("div", "knobs-x-head")
  head.tabIndex = 0
  head.setAttribute("role", "button")
  head.setAttribute("aria-expanded", String(Boolean(c.expanded)))
  const label = el("span", "knobs-x-label", c.display)
  const sum = el("span", "knobs-x-sum")
  // The row takes its name from its label (the summary is hidden from the name) and is described
  // by its summary (hex, coordinates, curve name), so what's announced matches what's visible.
  sum.id = `knobs-x-sum-${++summaries}`
  sum.setAttribute("aria-hidden", "true")
  head.setAttribute("aria-describedby", sum.id)
  const caret = svg("svg", "knobs-caret")
  caret.setAttribute("viewBox", "0 0 10 10")
  caret.setAttribute("aria-hidden", "true")
  const chevron = svg("path")
  chevron.setAttribute("d", "M3.75 2.25 6.5 5 3.75 7.75")
  caret.append(chevron)
  sum.append(...summary, caret)
  head.append(label, sum)
  const bodyEl = el("div", "knobs-x-body")
  bodyEl.hidden = !c.expanded
  bodyEl.append(...body)
  row.append(head, bodyEl)
  const isOpen = () => head.getAttribute("aria-expanded") === "true"
  const open = (next = !isOpen()) => {
    head.setAttribute("aria-expanded", String(next))
    reveal(bodyEl, next)
    c.onExpand?.(next)
    c.wake()
  }
  head.onclick = () => open()
  head.addEventListener("keydown", (event) => {
    if (event.target !== head || !plainKey(event) || event.altKey) return
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      event.stopPropagation()
      open()
    }
  })
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen()) return
    event.preventDefault()
    event.stopPropagation()
    open(false)
    head.focus({ preventScroll: true })
  })
  const gpu: GpuExpander = { head, label, caret, body: bodyEl, isOpen }
  return { row, head, label, body: bodyEl, isOpen, gpu }
}

interface StripOptions {
  label: string
  aria: string
  min: number
  max: number
  step: number
  format(value: number): string
  set(value: number): void
  start(): void
}

/** A scrub strip: a capsule track (painted by its row) with a ring thumb and a readout. */
function strip(c: RowContext<unknown>, o: StripOptions) {
  const { el } = factory(c.doc)
  const line = el("div", "knobs-strip")
  const label = el("span", "knobs-strip-label", o.label)
  const track = el("div", "knobs-strip-track")
  track.tabIndex = 0
  track.setAttribute("role", "slider")
  track.setAttribute("aria-label", o.aria)
  track.setAttribute("aria-valuemin", String(o.min))
  track.setAttribute("aria-valuemax", String(o.max))
  const thumb = el("i", "knobs-strip-thumb")
  track.append(thumb)
  const read = el("span", "knobs-strip-read")
  line.append(label, track, read)
  const span = o.max - o.min
  let current = o.min
  let colorAt: ((ratio: number) => string) | undefined
  let paintKey = ""
  let paintedKey = ""
  let dragging = false
  let dragRect: DOMRect | undefined
  const ratio = (v: number) => clamp((v - o.min) / span, 0, 1)
  // The thumb's centre stays a radius inside the capsule, and so does the gradient.
  const xOf = (r: number) => size.h / 2 + (size.w - size.h) * r
  const paint = (force = false) => {
    if (!size.w || !colorAt) return
    const key = `${size.w}|${size.h}|${paintKey}`
    if (!force && key === paintedKey) return
    paintedKey = key
    if (track.closest('[data-gpu-active="true"]') !== null) return
    const stops = Array.from({ length: 25 }, (_, i) => `${colorAt!(i / 24)} ${xOf(i / 24)}px`)
    track.style.background = `linear-gradient(to right,${stops.join(",")})`
  }
  const placeThumb = (instant: boolean) => {
    if (size.w) place([thumb], instant, () => (thumb.style.left = `${xOf(ratio(current))}px`))
  }
  const size = measure(track, () => {
    paint(true)
    placeThumb(true)
  })
  const quantize = (v: number, fine: boolean) => {
    const step = fine ? o.step / 10 : o.step
    return clamp(
      Number((o.min + Math.round((v - o.min) / step) * step).toPrecision(12)),
      o.min,
      o.max,
    )
  }
  let anchorX = 0
  let anchorValue = 0
  let fine = false
  const valueAt = (clientX: number, r = dragRect ?? track.getBoundingClientRect()) => {
    if (fine)
      return anchorValue + ((clientX - anchorX) / Math.max(1, r.width - r.height)) * span * 0.1
    return (
      o.min +
      clamp((clientX - r.left - r.height / 2) / Math.max(1, r.width - r.height), 0, 1) * span
    )
  }
  track.onpointerdown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    track.setPointerCapture(event.pointerId)
    track.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    dragRect = track.getBoundingClientRect()
    dragging = true
    line.classList.add("knobs-active")
    fine = event.altKey
    anchorX = event.clientX
    anchorValue = current
    o.start()
    if (!fine) o.set(quantize(valueAt(event.clientX, dragRect), false))
    c.wake()
  }
  track.onpointermove = (event) => {
    if (!dragging) return
    if (event.altKey !== fine) {
      fine = event.altKey
      anchorX = event.clientX
      anchorValue = current
    }
    line.classList.add("knobs-active")
    o.set(quantize(valueAt(event.clientX, dragRect), fine))
  }
  const release = () => {
    if (!dragging) return
    dragging = false
    dragRect = undefined
    line.classList.remove("knobs-active")
    c.wake()
  }
  track.onpointerup = release
  track.onpointercancel = release
  // A sideways pan scrubs like a drag: 1:1 with the fingers, as one undo step.
  let panAt: number | undefined
  onPan(track, {
    accept: () => !dragging,
    move(dx) {
      // Read the box directly when a pan lands before the size has been measured.
      const w = size.w || track.clientWidth
      const h = size.h || track.clientHeight
      if (!w) return
      if (panAt === undefined) {
        panAt = current
        o.start()
        line.classList.add("knobs-active")
        c.wake()
      }
      panAt = clamp(panAt + (dx / Math.max(1, w - h)) * span, o.min, o.max)
      o.set(quantize(panAt, false))
    },
    end() {
      panAt = undefined
      line.classList.remove("knobs-active")
      c.wake()
    },
    step(direction) {
      o.start()
      o.set(quantize(current + direction * o.step, false))
    },
  })
  track.addEventListener("keydown", (event) => {
    if (!plainKey(event)) return
    const dir = arrow(event)
    const edge = event.key === "Home" ? o.min : event.key === "End" ? o.max : undefined
    if (!dir && edge === undefined) return
    event.preventDefault()
    event.stopPropagation()
    o.start()
    const by = o.step * (event.shiftKey ? bigOf(event) : event.altKey ? 0.1 : 1)
    o.set(edge ?? quantize(current + dir * by, event.altKey))
  })
  const gpu: GpuStrip = {
    line,
    label,
    track,
    read,
    mode: 0,
    thumbX: () => (size.w ? xOf(ratio(current)) : 0),
    dragging: () => line.classList.contains("knobs-active"),
  }
  return {
    line,
    track,
    thumb,
    gpu,
    update(value: number, text = o.format(value)) {
      const first = !thumb.style.left
      if (read.textContent !== text) {
        read.textContent = text
        track.setAttribute("aria-valuetext", text)
      }
      if (!first && current === value) return
      current = value
      track.setAttribute("aria-valuenow", String(Number(value.toFixed(4))))
      placeThumb(first)
    },
    paint(key: string, fn: (ratio: number) => string) {
      paintKey = key
      colorAt = fn
      paint()
    },
    dispose: () => size.disconnect(),
  }
}

const SPRING_WINDOW = 1.2
const SPRING_Y: readonly [number, number] = [-0.05, 1.6]

/** The step response over a fixed 1.2 s window in a w×h box, as x,y pairs (px). */
export function springCurve(value: SpringValue, w: number, h: number, pad = 6, padX = pad) {
  const { omega, zeta } = springMotion(value)
  const ys = springResponse(omega, zeta, SPRING_WINDOW, SPRING_WINDOW / 60)
  const out: number[] = []
  ys.forEach((y, i) => {
    out.push(
      padX + (i / (ys.length - 1)) * (w - padX * 2),
      pad + ((SPRING_Y[1] - y) / (SPRING_Y[1] - SPRING_Y[0])) * (h - pad * 2),
    )
  })
  return out
}
const springGuideY = (y: number, h: number, pad = 6) =>
  pad + ((SPRING_Y[1] - y) / (SPRING_Y[1] - SPRING_Y[0])) * (h - pad * 2)

/** Duration and bounce as two sliders beside the curve they make; a dot runs the curve on change. */
export function springRow(c: RowContext<SpringField>): EditorRow {
  const { el, svg } = factory(c.doc)
  const row = el("div", "knobs-spring")
  row.dataset.field = c.key
  const tracksEl = el("div", "knobs-spring-tracks")
  const current = () => c.get() as SpringValue
  const fieldFor = (part: "duration" | "bounce"): Knob =>
    c.parts?.[part] ?? {
      kind: "knob",
      ...SPRING[part],
      value: c.field.value[part],
      label: part === "duration" ? c.display : "Bounce",
      ...(part === "duration" ? { unit: "s" } : {}),
    }
  const parts = (["duration", "bounce"] as const).map((part) => {
    const set = (v: number, options?: { coalesce?: boolean }) =>
      c.set({ ...current(), [part]: v }, options)
    const slider = createSlider(c.doc, `${c.key}-${part}`, fieldFor(part), set, c.wake)
    slider.element.classList.add("knobs-sub")
    if (!c.parts) slider.track.setAttribute("aria-label", `${c.display} ${part}`)
    slider.element.ondblclick = (event) => {
      if (!(event.target as HTMLElement).closest(".knobs-value,.knobs-number"))
        set(slider.field.value)
    }
    tracksEl.append(slider.element)
    const track: SubTrack = {
      slider,
      get field() {
        return slider.field
      },
      get: () => current()[part],
      set: (v) => set(v),
    }
    return track
  })
  const box = el("div", "knobs-spring-curve")
  const plot = svg("svg")
  plot.setAttribute("aria-hidden", "true")
  const guides = svg("path", "knobs-guide")
  const curve = svg("path", "knobs-curve")
  plot.append(guides, curve)
  const dot = el("i", "knobs-spring-dot")
  box.append(plot, dot)
  row.append(tracksEl, box)

  let shown = c.field.value
  let dotRun: { at: number; frames: number[]; ms: number } | null = null
  let pending = false
  // --k-curve-inset and --k-curve-guide, read when the box resizes (never per frame).
  const look = { inset: 6, dashed: false }
  const readLook = () => {
    const cs = getComputedStyle(box)
    const inset = parseFloat(cs.getPropertyValue("--k-curve-inset"))
    look.inset = Number.isFinite(inset) ? inset : 6
    look.dashed = cs.getPropertyValue("--k-curve-guide").trim() === "dashed"
  }
  const guideYs = () => (look.dashed ? [1] : [0, 1]).map((y) => springGuideY(y, size.h))
  const points = () => (size.w ? springCurve(shown, size.w, size.h, 6, look.inset) : [])
  const draw = (instant: boolean) => {
    if (!size.w) return
    plot.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`)
    const i = look.inset
    guides.setAttribute(
      "d",
      guideYs()
        .map((y) => `M${i} ${y.toFixed(2)}H${size.w - i}`)
        .join(""),
    )
    if (look.dashed) guides.setAttribute("stroke-dasharray", "4 4")
    else guides.removeAttribute("stroke-dasharray")
    guides.classList.toggle("knobs-guide-dashed", look.dashed)
    place([curve], instant, () => setPath(curve, points()))
  }
  const size = measure(box, () => {
    readLook()
    draw(true)
  })
  const dragging = () => parts.some((p) => p.slider.isDragging())
  // The dot runs the curve in real time: x is time, y the spring's position.
  const play = (delay: number) => {
    if (!size.w || reducedMotion(c.doc)) return
    const frames = points()
    const ms = SPRING_WINDOW * 1000
    dotRun = { at: performance.now() + delay, frames, ms }
    const keys: Keyframe[] = []
    for (let i = 0; i < frames.length; i += 2) {
      const t = i / (frames.length - 2)
      keys.push({
        transform: `translate(${frames[i]!.toFixed(2)}px,${frames[i + 1]!.toFixed(2)}px)`,
        opacity: t < 0.06 ? t / 0.06 : t > 0.88 ? (1 - t) / 0.12 : 1,
        offset: t,
      })
    }
    dot.getAnimations().forEach((a) => a.cancel())
    dot.animate(keys, { duration: ms, delay, easing: "linear" })
    c.wake()
  }
  tracksEl.addEventListener("pointerup", () => {
    if (pending) play(0)
    pending = false
  })
  let initialized = false
  const gpu: GpuSpringRow = {
    kind: "spring",
    key: c.key,
    display: c.display,
    row,
    box,
    curve: points,
    guides: () => (size.w ? guideYs() : []),
    dot: () => dotRun,
    snap: dragging,
    wave: c.wave,
    isModified: c.isModified,
  }
  const knobRows: GpuRowBinding[] = parts.map((p, i) => ({
    kind: "knob" as const,
    key: `${c.key}-${i}`,
    display: p.field.label!,
    row: p.slider.element,
    slider: p.slider,
    wave: c.wave,
    isModified: () => c.isModified() && p.get() !== p.field.value,
  }))
  return {
    row,
    labelEl: parts[0]!.slider.label,
    input: parts[0]!.slider.track,
    stops: () => parts.map((p) => p.slider.track),
    tracks: parts,
    gpu: [...knobRows, gpu],
    retune(next) {
      parts[0]!.slider.retune(next.duration)
      parts[1]!.slider.retune(next.bounce)
      for (const [i, p] of parts.entries())
        p.slider.element.classList.toggle(
          "knobs-modified",
          shown[i === 0 ? "duration" : "bounce"] !== p.field.value && c.isModified(),
        )
    },
    update(value, delay, instant = false) {
      const v = value as SpringValue
      const prev = shown
      const changed = !same(v, prev)
      shown = v
      for (const [i, p] of parts.entries()) {
        const key = i === 0 ? "duration" : "bounce"
        if (!initialized || instant || v[key] !== prev[key]) {
          p.slider.update(v[key], delay, instant)
          p.slider.element.classList.toggle(
            "knobs-modified",
            v[key] !== p.field.value && c.isModified(),
          )
        }
      }
      if (!changed && initialized) return
      draw(!initialized || instant || dragging())
      if (initialized && !instant) {
        if (dragging()) pending = true
        else play(delay)
      }
      initialized = true
    },
    dispose() {
      size.disconnect()
      for (const p of parts) p.slider.dispose()
    },
  }
}

/** OKLCH: a swatch and hex in the head; hue, relative chroma (0…maxC) and lightness strips in the body. */
export function colorRow(c: RowContext<ColorField>): EditorRow {
  const { el } = factory(c.doc)
  const swatch = el("span", "knobs-swatch")
  const hex = el("span", "knobs-x-read")
  let shown: Oklch = parseColor(c.field.value)!
  // The C strip spans 0…maxChroma(l, h), so its thumb sits at C / maxC and stays put while H or L
  // are scrubbed (preserving relative vividness), and remembers its spot when L nears 0 or 1.
  const relOf = ({ l, c: ch, h }: Oklch, fallback: number) => {
    const max = maxChroma(l, h)
    return max > 1e-4 ? clamp(ch / max, 0, 1) : fallback
  }
  let rel = relOf(shown, 0)
  let sending = false
  const g = gesture(c)
  const send = (patch: { l?: number; r?: number; h?: number }) => {
    const l = patch.l ?? shown.l
    const h = patch.h ?? shown.h
    if (patch.r !== undefined) rel = clamp(patch.r, 0, 1)
    const ch = rel * maxChroma(l, h)
    sending = true
    try {
      g.set({ l, c: ch, h })
    } finally {
      sending = false
    }
    if (patch.r !== undefined) {
      strips[1]!.update(rel, shown.c.toFixed(3))
      c.wake()
    }
  }
  const strips = [
    strip(c, {
      label: "H",
      aria: `${c.display} hue`,
      min: 0,
      max: 360,
      step: 1,
      format: (v) => `${Math.round(v)}°`,
      set: (h) => send({ h: h % 360 }),
      start: g.start,
    }),
    strip(c, {
      label: "C",
      aria: `${c.display} chroma`,
      min: 0,
      max: 1,
      step: 0.01,
      format: () => shown.c.toFixed(3),
      set: (r) => send({ r }),
      start: g.start,
    }),
    strip(c, {
      label: "L",
      aria: `${c.display} lightness`,
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => `${Math.round(v * 100)}%`,
      set: (l) => send({ l }),
      start: g.start,
    }),
  ]
  strips.forEach((s, i) => (s.gpu.mode = i))
  const body = c.doc.createElement("div")
  body.className = "knobs-strips"
  body.append(...strips.map((s) => s.line))
  const x = expander(c, [hex, swatch], [body])
  x.head.addEventListener("keydown", (event) => {
    const dir = arrow(event)
    if (!dir || event.target !== x.head || !plainKey(event)) return
    event.preventDefault()
    event.stopPropagation()
    g.start()
    send({
      h:
        (((shown.h + dir * (event.shiftKey ? bigOf(event) : event.altKey ? 0.1 : 1)) % 360) + 360) %
        360,
    })
  })
  const gpu: GpuColorRow = {
    kind: "color",
    key: c.key,
    display: c.display,
    row: x.row,
    x: x.gpu,
    swatch,
    read: hex,
    strips: strips.map((s) => s.gpu),
    color: () => shown,
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row: x.row,
    labelEl: x.label,
    input: x.head,
    stops: () => [x.head, ...(x.isOpen() ? strips.map((s) => s.track) : [])].filter(visible),
    tracks: [],
    gpu: [gpu],
    update(value) {
      shown = parseColor(value)!
      const { l, c: ch, h } = shown
      const maxC = maxChroma(l, h)
      if (!sending && maxC > 1e-4 && Math.abs(rel * maxC - ch) > 5e-4) rel = clamp(ch / maxC, 0, 1)
      const rgb = rgbCss(oklchToRgb(shown))
      swatch.style.backgroundColor = rgb
      hex.textContent = colorHex(shown).toUpperCase()
      const [hs, cs, ls] = strips
      hs!.update(h)
      cs!.update(rel, ch.toFixed(3))
      ls!.update(l)
      const hc = Math.max(ch, 0.06)
      hs!.paint(`${l}|${hc}`, (r) => rgbCss(oklchToRgb({ l, c: hc, h: r * 360 })))
      cs!.paint(`${l}|${h}`, (r) => rgbCss(oklchToRgb({ l, c: r * maxC, h })))
      ls!.paint(`${ch}|${h}`, (r) => rgbCss(oklchToRgb({ l: r, c: ch, h })))
      for (const s of strips) s.thumb.style.backgroundColor = rgb
    },
    dispose() {
      for (const s of strips) s.dispose()
    },
  }
}

const PAD_INSET = 10

/** A 2D pad with crosshair guides, the default marked, and a puck that arrows and drags move. */
export function pointRow(c: RowContext<PointField>): EditorRow {
  const { el } = factory(c.doc)
  const f = c.field
  const read = el("span", "knobs-x-read")
  const pad = el("div", "knobs-pad")
  pad.tabIndex = 0
  pad.setAttribute("role", "slider")
  pad.setAttribute("aria-roledescription", "2D pad")
  pad.setAttribute("aria-label", c.display)
  const vLine = el("i", "knobs-pad-v")
  const hLine = el("i", "knobs-pad-h")
  const home = el("i", "knobs-pad-home")
  const puck = el("i", "knobs-pad-puck")
  pad.append(vLine, hLine, home, puck)
  const x = expander(c, [read], [pad])
  const fmt = (v: number, step: number) => v.toFixed(decimals(step))
  const format = (p: Point) => `${fmt(p.x, f.step.x)}, ${fmt(p.y, f.step.y)}`
  let shown = f.value
  let dragging = false
  // y grows downward, like CSS and UIKit.
  const ratio = (p: Point): [number, number] => [
    f.max.x === f.min.x ? 0.5 : (p.x - f.min.x) / (f.max.x - f.min.x),
    f.max.y === f.min.y ? 0.5 : (p.y - f.min.y) / (f.max.y - f.min.y),
  ]
  const at = (p: Point): [number, number] => {
    const [rx, ry] = ratio(p)
    return [PAD_INSET + (size.w - PAD_INSET * 2) * rx, PAD_INSET + (size.h - PAD_INSET * 2) * ry]
  }
  const layout = (instant: boolean) => {
    if (!size.w) return
    const [px, py] = at(shown)
    const [hx, hy] = at(f.value)
    place([puck, vLine, hLine], instant, () => {
      puck.style.translate = `${px}px ${py}px`
      vLine.style.translate = `${px}px 0`
      hLine.style.translate = `0 ${py}px`
    })
    home.style.translate = `${hx}px ${hy}px`
  }
  const size = measure(pad, () => layout(true))
  const g = gesture(c)
  let fine = false
  let dragRect: DOMRect | undefined
  let anchor: [number, number] = [0, 0]
  let anchorValue = shown
  const valueAt = (event: PointerEvent, r = dragRect ?? pad.getBoundingClientRect()): Point => {
    const spanX = f.max.x - f.min.x
    const spanY = f.max.y - f.min.y
    if (fine)
      return {
        x: anchorValue.x + ((event.clientX - anchor[0]) / (r.width - PAD_INSET * 2)) * spanX * 0.1,
        y: anchorValue.y + ((event.clientY - anchor[1]) / (r.height - PAD_INSET * 2)) * spanY * 0.1,
      }
    return {
      x:
        f.min.x +
        clamp((event.clientX - r.left - PAD_INSET) / (r.width - PAD_INSET * 2), 0, 1) * spanX,
      y:
        f.min.y +
        clamp((event.clientY - r.top - PAD_INSET) / (r.height - PAD_INSET * 2), 0, 1) * spanY,
    }
  }
  pad.onpointerdown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    pad.setPointerCapture(event.pointerId)
    pad.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    dragRect = pad.getBoundingClientRect()
    dragging = true
    fine = event.altKey
    anchor = [event.clientX, event.clientY]
    anchorValue = shown
    g.start()
    if (!fine) g.set(valueAt(event, dragRect))
    c.wake()
  }
  pad.onpointermove = (event) => {
    if (!dragging) return
    if (event.altKey !== fine) {
      fine = event.altKey
      anchor = [event.clientX, event.clientY]
      anchorValue = shown
    }
    pad.classList.add("knobs-active")
    g.set(valueAt(event, dragRect))
  }
  const release = () => {
    if (!dragging) return
    dragging = false
    dragRect = undefined
    pad.classList.remove("knobs-active")
    c.wake()
  }
  pad.onpointerup = release
  pad.onpointercancel = release
  // A pan that starts sideways moves the puck with the fingers in both axes, as one undo step.
  let panAt: Point | undefined
  onPan(
    pad,
    {
      accept: () => !dragging,
      move(dx, dy) {
        const w = size.w || pad.clientWidth
        const h = size.h || pad.clientHeight
        if (!w) return
        if (!panAt) {
          panAt = shown
          g.start()
          pad.classList.add("knobs-active")
          c.wake()
        }
        const spanX = f.max.x - f.min.x
        const spanY = f.max.y - f.min.y
        panAt = {
          x: clamp(panAt.x + (dx / (w - PAD_INSET * 2)) * spanX, f.min.x, f.max.x),
          y: clamp(panAt.y + (dy / (h - PAD_INSET * 2)) * spanY, f.min.y, f.max.y),
        }
        g.set(panAt)
      },
      end() {
        panAt = undefined
        pad.classList.remove("knobs-active")
        c.wake()
      },
      step(direction) {
        g.start()
        g.set({ x: shown.x + direction * f.step.x, y: shown.y })
      },
    },
    { axes: "xy" },
  )
  pad.ondblclick = () => c.set(f.value)
  // Arrows move the puck about 1% of the range (⇧ 10%, ⌥ one step); j and k still leave the pad.
  pad.addEventListener("keydown", (event) => {
    const dx = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0
    const dy = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0
    if ((!dx && !dy) || !plainKey(event)) return
    event.preventDefault()
    event.stopPropagation()
    const by = (axis: "x" | "y") => {
      const step = f.step[axis]
      if (event.altKey) return step
      const unit = Math.max(1, Math.round((f.max[axis] - f.min[axis]) / step / 100)) * step
      return unit * bigOf(event)
    }
    g.start()
    g.set({ x: shown.x + dx * by("x"), y: shown.y + dy * by("y") })
  })
  x.head.addEventListener("keydown", (event) => {
    const dir = arrow(event)
    if (!dir || event.target !== x.head || !plainKey(event)) return
    event.preventDefault()
    event.stopPropagation()
    g.start()
    g.set({ x: shown.x + dir * f.step.x * bigOf(event), y: shown.y })
  })
  const gpu: GpuPointRow = {
    kind: "point",
    key: c.key,
    display: c.display,
    row: x.row,
    x: x.gpu,
    read,
    pad,
    puck: () => (size.w ? at(shown) : [0, 0]),
    home: () => (size.w ? at(f.value) : [0, 0]),
    dragging: () => pad.classList.contains("knobs-active"),
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row: x.row,
    labelEl: x.label,
    input: x.head,
    stops: () => [x.head, ...(x.isOpen() ? [pad] : [])].filter(visible),
    tracks: [],
    gpu: [gpu],
    update(value) {
      const first = read.textContent === ""
      shown = value as Point
      read.textContent = format(shown)
      pad.setAttribute("aria-valuetext", format(shown))
      layout(first)
    },
    dispose: () => size.disconnect(),
  }
}

const EASE_PAD = { x: 12, y: 10 }
const MINI = { w: 30, y: [-0.3, 1.3] as const }

/** The curve's samples mapped into a box: x 0…1 across, y over `range` bottom to top. */
function bezierCurve(
  b: Bezier,
  w: number,
  h: number,
  padX: number,
  padY: number,
  range: readonly [number, number],
) {
  const map = mapper(w, h, padX, padY, range)
  const out: number[] = []
  for (let i = 0; i <= 48; i++) out.push(...map(...bezierPoint(b, i / 48)))
  return out
}
const mapper =
  (w: number, h: number, padX: number, padY: number, range: readonly [number, number]) =>
  (x: number, y: number): [number, number] => [
    padX + x * (w - padX * 2),
    padY + ((range[1] - clamp(y, range[0], range[1])) / (range[1] - range[0])) * (h - padY * 2),
  ]

/** A mini curve in the head; an editor with two handles and named chips in the body. */
export function easingRow(c: RowContext<EasingField>): EditorRow {
  const { el, svg } = factory(c.doc)
  const mini = svg("svg", "knobs-ease-mini")
  mini.setAttribute("aria-hidden", "true")
  const miniPath = svg("path", "knobs-curve")
  mini.append(miniPath)
  const name = el("span", "knobs-x-read")
  const box = el("div", "knobs-ease")
  const plot = svg("svg")
  plot.setAttribute("aria-hidden", "true")
  const guides = svg("path", "knobs-guide")
  const arms = svg("path", "knobs-arm")
  const curve = svg("path", "knobs-curve")
  plot.append(guides, arms, curve)
  const handles = (["Start", "End"] as const).map((which) => {
    const h = el("button", "knobs-ease-handle")
    h.type = "button"
    h.setAttribute("role", "slider")
    h.setAttribute("aria-label", `${c.display} ${which.toLowerCase()} handle`)
    return h
  })
  box.append(plot, ...handles)
  const chips = el("div", "knobs-ease-chips")
  chips.tabIndex = 0
  chips.setAttribute("role", "radiogroup")
  chips.setAttribute("aria-label", `${c.display} presets`)
  const names = Object.keys(EASINGS) as (keyof typeof EASINGS)[]
  const chipButtons = names.map((n) => {
    const b = el("button", "knobs-ease-chip", n)
    b.type = "button"
    b.tabIndex = -1
    b.setAttribute("role", "radio")
    b.onclick = () => {
      c.set(EASINGS[n])
      chips.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    }
    return b
  })
  chips.append(...chipButtons)
  const x = expander(c, [name, mini], [box, chips])
  let shown = c.field.value
  const range = EASING_Y
  const map = (px: number, py: number) =>
    mapper(size.w, size.h, EASE_PAD.x, EASE_PAD.y, range)(px, py)
  const curvePoints = () =>
    size.w ? bezierCurve(shown, size.w, size.h, EASE_PAD.x, EASE_PAD.y, range) : []
  const armPoints = () =>
    size.w
      ? [...map(0, 0), ...map(shown[0], shown[1]), ...map(1, 1), ...map(shown[2], shown[3])]
      : []
  const miniPoints = () => bezierCurve(shown, MINI.w, miniSize.h, 1.5, 1.5, MINI.y)
  const layout = (instant: boolean) => {
    if (!size.w) return
    plot.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`)
    const [x0, y0] = map(0, 0)
    const [x1, y1] = map(1, 1)
    guides.setAttribute(
      "d",
      `M${EASE_PAD.x} ${y0}H${size.w - EASE_PAD.x}M${EASE_PAD.x} ${y1}H${size.w - EASE_PAD.x}M${x0} ${y0}L${x1} ${y1}`,
    )
    const a = armPoints()
    place([curve, arms, ...handles], instant, () => {
      setPath(curve, curvePoints())
      arms.style.setProperty(
        "d",
        `path("M${a[0]} ${a[1]}L${a[2]} ${a[3]}M${a[4]} ${a[5]}L${a[6]} ${a[7]}")`,
      )
      handles[0]!.style.translate = `${a[2]}px ${a[3]}px`
      handles[1]!.style.translate = `${a[6]}px ${a[7]}px`
    })
  }
  const size = measure(box, () => layout(true))
  const miniSize = measure(mini, () => {
    mini.setAttribute("viewBox", `0 0 ${MINI.w} ${miniSize.h}`)
    place([miniPath], true, () => setPath(miniPath, miniPoints()))
  })
  const g = gesture(c)
  let dragging = -1
  let dragRect: DOMRect | undefined
  let grab: [number, number] = [0, 0]
  let fine = false
  let anchor: [number, number] = [0, 0]
  let anchorValue = shown
  const spanY = range[1] - range[0]
  const unit = () => [size.w - EASE_PAD.x * 2, size.h - EASE_PAD.y * 2] as const
  const move = (i: number, px: number, py: number) => {
    const next = [...shown] as [number, number, number, number]
    next[i * 2] = clamp(px, 0, 1)
    next[i * 2 + 1] = clamp(py, range[0], range[1])
    g.set(next)
  }
  handles.forEach((h, i) => {
    h.onpointerdown = (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      h.setPointerCapture(event.pointerId)
      h.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
      const r = box.getBoundingClientRect()
      dragRect = r
      const [hx, hy] = map(shown[i * 2]!, shown[i * 2 + 1]!)
      grab = [event.clientX - r.left - hx, event.clientY - r.top - hy]
      anchor = [event.clientX, event.clientY]
      anchorValue = shown
      fine = event.altKey
      dragging = i
      g.start()
      c.wake()
    }
    h.onpointermove = (event) => {
      if (dragging !== i) return
      if (event.altKey !== fine) {
        fine = event.altKey
        anchor = [event.clientX, event.clientY]
        anchorValue = shown
      }
      box.classList.add("knobs-active")
      const [uw, uh] = unit()
      if (fine)
        return move(
          i,
          anchorValue[i * 2]! + ((event.clientX - anchor[0]) / uw) * 0.1,
          anchorValue[i * 2 + 1]! - ((event.clientY - anchor[1]) / uh) * spanY * 0.1,
        )
      const r = dragRect ?? (dragRect = box.getBoundingClientRect())
      move(
        i,
        (event.clientX - r.left - grab[0] - EASE_PAD.x) / uw,
        range[1] - ((event.clientY - r.top - grab[1] - EASE_PAD.y) / uh) * spanY,
      )
    }
    const release = () => {
      if (dragging !== i) return
      dragging = -1
      dragRect = undefined
      box.classList.remove("knobs-active")
      c.wake()
    }
    h.onpointerup = release
    h.onpointercancel = release
    h.addEventListener("keydown", (event) => {
      const dx = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0
      const dy = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0
      if ((!dx && !dy) || !plainKey(event)) return
      event.preventDefault()
      event.stopPropagation()
      const by = event.shiftKey ? 0.1 : 0.01
      g.start()
      move(i, shown[i * 2]! + dx * by, shown[i * 2 + 1]! + dy * by)
    })
  })
  // A pan that starts sideways moves the hovered (or focused) handle with the fingers.
  let panned = -1
  let panAt: [number, number] = [0, 0]
  const panTarget = () => {
    const hovered = handles.findIndex((h) => h.matches(":hover"))
    return hovered >= 0 ? hovered : handles.findIndex((h) => h === c.doc.activeElement)
  }
  onPan(
    box,
    {
      accept: () => dragging < 0 && panTarget() >= 0,
      move(dx, dy) {
        const w = size.w || box.clientWidth
        const h = size.h || box.clientHeight
        if (!w) return
        if (panned < 0) {
          panned = panTarget()
          if (panned < 0) return
          panAt = [shown[panned * 2]!, shown[panned * 2 + 1]!]
          g.start()
          box.classList.add("knobs-active")
          c.wake()
        }
        panAt = [
          clamp(panAt[0] + dx / (w - EASE_PAD.x * 2), 0, 1),
          clamp(panAt[1] - (dy / (h - EASE_PAD.y * 2)) * spanY, range[0], range[1]),
        ]
        move(panned, ...panAt)
      },
      end() {
        panned = -1
        box.classList.remove("knobs-active")
        c.wake()
      },
      step(direction) {
        const i = panTarget()
        if (i < 0) return
        g.start()
        move(i, shown[i * 2]! + direction * 0.01, shown[i * 2 + 1]!)
      },
    },
    { axes: "xy" },
  )
  const cycle = (dir: number) => {
    const i = chipButtons.findIndex((b) => b.getAttribute("aria-checked") === "true")
    const next = i < 0 ? (dir > 0 ? 0 : names.length - 1) : (i + dir + names.length) % names.length
    c.set(EASINGS[names[next]!])
  }
  for (const target of [chips, x.head])
    target.addEventListener("keydown", (event) => {
      const dir = arrow(event)
      if (!dir || event.target !== target || !plainKey(event) || event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      cycle(dir)
    })
  const gpu: GpuEasingRow = {
    kind: "easing",
    key: c.key,
    display: c.display,
    row: x.row,
    x: x.gpu,
    read: name,
    mini,
    miniCurve: () => (miniSize.h ? miniPoints() : []),
    box,
    curve: curvePoints,
    arms: armPoints,
    guides: () => (size.w ? [...map(0, 0), ...map(1, 1)] : []),
    handles,
    chips: chipButtons,
    snap: () => box.classList.contains("knobs-active"),
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row: x.row,
    labelEl: x.label,
    input: x.head,
    stops: () => [x.head, ...(x.isOpen() ? [chips, ...handles] : [])].filter(visible),
    tracks: [],
    gpu: [gpu],
    update(value) {
      const first = name.dataset.placed === undefined
      name.dataset.placed = ""
      shown = value as Bezier
      const match = easingName(shown)
      name.textContent = match ?? ""
      for (const [i, b] of chipButtons.entries())
        b.setAttribute("aria-checked", String(names[i] === match))
      handles.forEach((h, i) =>
        h.setAttribute("aria-valuetext", `x ${shown[i * 2]}, y ${shown[i * 2 + 1]}`),
      )
      const held = dragging >= 0 || panned >= 0
      layout(first || held)
      if (miniSize.h) place([miniPath], first || held, () => setPath(miniPath, miniPoints()))
    },
    dispose() {
      size.disconnect()
      miniSize.disconnect()
    },
  }
}
