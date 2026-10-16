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
import { fadeText, rollingReadout, rollMs } from "./reel.js"
import { reveal } from "./reveal.js"
import { createSlider, decimals, type Slider } from "./slider.js"
import { band, stepList, stretched, textGive, type Band, type Steps } from "./give.js"
import { tick } from "./haptics.js"
import {
  curveBlur,
  curveSmear,
  LINE_SMEAR,
  morphLoop,
  RampMorph,
  smearFilters,
} from "./ramp-morph.js"
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
  /**
   * `instant` places the value without motion (a different item arrived); `mixed` shows it as
   * indeterminate (a multi-selection whose items differ).
   */
  update(value: Value, delay: number, instant?: boolean, mixed?: boolean): void
  /** Reads what `update` will, ahead of a batch's writes (see `Slider.prime`). */
  prime?(): void
  /** A flat spring's halves changed range or label (see `RowContext.parts`). */
  retune?(parts: { readonly duration: Knob; readonly bounce: Knob }): void
  dispose(): void
  readonly tracks: readonly SubTrack[]
  readonly gpu: readonly GpuRowBinding[]
  /** Named options the digits pick while the row is focused (a ramp's or easing's presets). */
  readonly options?: RowOptions
}

/** A row's options as the digits 1–9 pick them (see scope.ts). */
export interface RowOptions {
  readonly count: number
  choose(i: number): void
  /** The options while they show (segments, chips), for a digit on each; empty while hidden. */
  shown(): readonly HTMLElement[]
  /** What stands for them while they're hidden (a menu's button, a head's mini curve). */
  readonly anchor: Element
}

export const reducedMotion = (doc: Document) =>
  doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false
export const rgbCss = (rgb: readonly number[]) =>
  `rgb(${rgb.map((v) => Math.round(v * 2550) / 10).join(" ")})`
export const pathOf = (pts: readonly number[]) => {
  let d = ""
  for (let i = 0; i < pts.length; i += 2)
    d += `${i ? "L" : "M"}${pts[i]!.toFixed(2)} ${pts[i + 1]!.toFixed(2)}`
  return d
}
export const visible = (node: HTMLElement) => node.isConnected && !node.closest("[hidden]")

/** Applies a placement, skipping the transition when it's the first one or a resize. */
export function place(
  nodes: readonly (HTMLElement | SVGElement)[],
  instant: boolean,
  apply: () => void,
) {
  if (instant) for (const n of nodes) n.style.transition = "none"
  apply()
  if (instant) {
    void nodes[0]?.getBoundingClientRect()
    for (const n of nodes) n.style.transition = ""
  }
}

export function setPath(path: SVGPathElement, pts: readonly number[]) {
  path.style.setProperty("d", `path("${pathOf(pts)}")`)
}

/** One undo step per gesture: the first change that lands records history, the rest fold in. */
export function gesture(c: RowContext<unknown>) {
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

export function factory(doc: Document) {
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
export const plainKey = (event: KeyboardEvent) =>
  !event.metaKey && !event.ctrlKey && !event.isComposing

/** A size kept current by a ResizeObserver, so layout reads stay out of the frame loop. */
export function measure(node: Element, onResize: () => void) {
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
export function expander(c: RowContext<unknown>, summary: Node[], body: Node[]) {
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
  bodyEl.dataset.drift = ""
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
    // In hint mode Esc ends the hints (the panel's), not the editor.
    if (event.key !== "Escape" || !isOpen() || row.closest(".knobs-hinting")) return
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
export function strip(c: RowContext<unknown>, o: StripOptions) {
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
  /** How far (px) a pan holds the thumb past an end. */
  let give = 0
  const thumbX = () => xOf(ratio(current)) + give
  const placeThumb = (instant: boolean) => {
    if (size.w) place([thumb], instant, () => (thumb.style.left = `${thumbX()}px`))
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
  // A sideways pan scrubs like a drag: 1:1 with the fingers, as one undo step. Past an end the
  // thumb gives a little and springs back when it's let go.
  let panAt: Band | undefined
  onPan(track, {
    accept: () => !dragging,
    move(dx) {
      // Read the box directly when a pan lands before the size has been measured.
      const w = size.w || track.clientWidth
      const h = size.h || track.clientHeight
      if (!w) return
      const room = Math.max(1, w - h)
      if (panAt === undefined) {
        panAt = { at: ratio(current) * room, give: 0 }
        o.start()
        line.classList.add("knobs-active")
        c.wake()
      }
      const before = panAt.give
      panAt = band(panAt, dx, 0, room)
      if (stretched(before, panAt.give)) tick(track, "limit")
      const moved = give !== panAt.give
      give = panAt.give
      o.set(quantize(o.min + (panAt.at / room) * span, false))
      if (moved) {
        placeThumb(false)
        c.wake()
      }
    },
    end() {
      panAt = undefined
      line.classList.remove("knobs-active")
      if (give !== 0) {
        give = 0
        placeThumb(false)
      }
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
    thumbX: () => (size.w ? thumbX() : 0),
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
      if (!(event.target as HTMLElement).closest(".knobs-value,.knobs-number,.knobs-accessory"))
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
  let dotAnimation: Animation | undefined
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
    // The run it replaces, without getAnimations() (which would bring style up to date).
    dotAnimation?.cancel()
    dotAnimation = dot.animate(keys, { duration: ms, delay, easing: "linear" })
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
    prime() {
      for (const p of parts) p.slider.prime()
    },
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

/**
 * Hue, relative chroma (0…maxC) and lightness strips for one colour: a colour row's body, and a
 * gradient's editor for its selected stop. `commit` receives each change as OKLCH.
 */
export function colorStrips(
  c: RowContext<unknown>,
  o: { aria: string; start(): void; commit(color: Oklch): void },
) {
  let shown: Oklch = { l: 0.5, c: 0, h: 0 }
  // The C strip spans 0…maxChroma(l, h), so its thumb sits at C / maxC and stays put while H or L
  // are scrubbed (preserving relative vividness), and remembers its spot when L nears 0 or 1.
  let rel = 0
  let sending = false
  const send = (patch: { l?: number; r?: number; h?: number }) => {
    const l = patch.l ?? shown.l
    const h = patch.h ?? shown.h
    if (patch.r !== undefined) rel = clamp(patch.r, 0, 1)
    const ch = rel * maxChroma(l, h)
    sending = true
    try {
      o.commit({ l, c: ch, h })
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
      aria: `${o.aria} hue`,
      min: 0,
      max: 360,
      step: 1,
      format: (v) => `${Math.round(v)}°`,
      set: (h) => send({ h: h % 360 }),
      start: o.start,
    }),
    strip(c, {
      label: "C",
      aria: `${o.aria} chroma`,
      min: 0,
      max: 1,
      step: 0.01,
      format: () => shown.c.toFixed(3),
      set: (r) => send({ r }),
      start: o.start,
    }),
    strip(c, {
      label: "L",
      aria: `${o.aria} lightness`,
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => `${Math.round(v * 100)}%`,
      set: (l) => send({ l }),
      start: o.start,
    }),
  ]
  strips.forEach((s, i) => (s.gpu.mode = i))
  const body = c.doc.createElement("div")
  body.className = "knobs-strips"
  body.append(...strips.map((s) => s.line))
  return {
    body,
    strips,
    send,
    color: () => shown,
    dragging: () => strips.some((s) => s.gpu.dragging()),
    /** Shows `color` (a new colour, or the same one after an edit); `mixed` dashes the readouts. */
    show(color: Oklch, mixed = false, fresh = false) {
      shown = color
      const { l, c: ch, h } = shown
      const maxC = maxChroma(l, h)
      if (fresh) rel = maxC > 1e-4 ? clamp(ch / maxC, 0, 1) : 0
      else if (!sending && maxC > 1e-4 && Math.abs(rel * maxC - ch) > 5e-4)
        rel = clamp(ch / maxC, 0, 1)
      const rgb = rgbCss(oklchToRgb(shown))
      const [hs, cs, ls] = strips
      const dash = mixed ? "—" : undefined
      hs!.update(h, dash)
      cs!.update(rel, dash ?? ch.toFixed(3))
      ls!.update(l, dash)
      const hc = Math.max(ch, 0.06)
      hs!.paint(`${l}|${hc}`, (r) => rgbCss(oklchToRgb({ l, c: hc, h: r * 360 })))
      cs!.paint(`${l}|${h}`, (r) => rgbCss(oklchToRgb({ l, c: r * maxC, h })))
      ls!.paint(`${ch}|${h}`, (r) => rgbCss(oklchToRgb({ l: r, c: ch, h })))
      for (const s of strips) s.thumb.style.backgroundColor = rgb
      return rgb
    },
    dispose() {
      for (const s of strips) s.dispose()
    },
  }
}

/** OKLCH: a swatch and hex in the head; hue, relative chroma (0…maxC) and lightness strips in the body. */
export function colorRow(c: RowContext<ColorField>): EditorRow {
  const { el } = factory(c.doc)
  const swatch = el("span", "knobs-swatch")
  const hex = el("span", "knobs-x-read")
  const g = gesture(c)
  const editor = colorStrips(c, {
    aria: c.display,
    start: g.start,
    commit: (color) => g.set(color),
  })
  const strips = editor.strips
  const x = expander(c, [hex, swatch], [editor.body])
  let placed = false
  x.head.addEventListener("keydown", (event) => {
    const dir = arrow(event)
    if (!dir || event.target !== x.head || !plainKey(event)) return
    event.preventDefault()
    event.stopPropagation()
    g.start()
    const h = editor.color().h
    editor.send({
      h: (((h + dir * (event.shiftKey ? bigOf(event) : event.altKey ? 0.1 : 1)) % 360) + 360) % 360,
    })
  })
  // A sideways pan on the head turns the hue with the fingers (a degree a px, wrapping), as one
  // undo step, the swatch and hex following live.
  let hueAt: number | undefined
  onPan(x.head, {
    move(dx) {
      if (hueAt === undefined) {
        hueAt = editor.color().h
        g.start()
        x.head.setAttribute("data-panned", "")
        c.wake()
      }
      hueAt += dx
      editor.send({ h: ((hueAt % 360) + 360) % 360 })
    },
    end() {
      if (hueAt === undefined) return
      hueAt = undefined
      x.head.removeAttribute("data-panned")
      c.wake()
    },
    step(direction) {
      g.start()
      editor.send({ h: (((editor.color().h + direction) % 360) + 360) % 360 })
    },
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
    color: editor.color,
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
    update(value, _delay, instant = false, mixed = false) {
      const shown = parseColor(value)!
      const rgb = editor.show(shown, mixed)
      // Mixed leaves an empty well: no one colour stands for the selection.
      swatch.style.backgroundColor = mixed ? "transparent" : rgb
      // A new colour crossfades its hex, except under the user's own hand.
      const hand = x.row.querySelector(".knobs-active,[data-panned]") !== null
      fadeText(hex, mixed ? "—" : colorHex(shown).toUpperCase(), !hand && !instant && placed)
      placed = true
    },
    dispose: () => editor.dispose(),
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
  const rolling = rollingReadout(read)
  let placed = false
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
  /** How far (px) a pan holds the puck past the pad's edges. */
  let give: [number, number] = [0, 0]
  const puckAt = (): [number, number] => {
    const [px, py] = at(shown)
    return [px + give[0], py + give[1]]
  }
  const layout = (instant: boolean) => {
    if (!size.w) return
    const [px, py] = puckAt()
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
  // Past an edge the puck gives a little, and springs back when it's let go.
  let panAt: [Band, Band] | undefined
  onPan(
    pad,
    {
      accept: () => !dragging,
      move(dx, dy) {
        const w = (size.w || pad.clientWidth) - PAD_INSET * 2
        const h = (size.h || pad.clientHeight) - PAD_INSET * 2
        if (w <= 0) return
        if (!panAt) {
          const [rx, ry] = ratio(shown)
          panAt = [
            { at: rx * w, give: 0 },
            { at: ry * h, give: 0 },
          ]
          g.start()
          pad.classList.add("knobs-active")
          c.wake()
        }
        const before = panAt[0].give || panAt[1].give
        panAt = [band(panAt[0], dx, 0, w), band(panAt[1], dy, 0, Math.max(0, h))]
        if (stretched(before, panAt[0].give || panAt[1].give)) tick(pad, "limit")
        const moved = give[0] !== panAt[0].give || give[1] !== panAt[1].give
        give = [panAt[0].give, panAt[1].give]
        g.set({
          x: f.min.x + (panAt[0].at / w) * (f.max.x - f.min.x),
          y: f.min.y + (h > 0 ? panAt[1].at / h : 0.5) * (f.max.y - f.min.y),
        })
        if (moved) {
          layout(false)
          c.wake()
        }
      },
      end() {
        panAt = undefined
        pad.classList.remove("knobs-active")
        if (give[0] || give[1]) {
          give = [0, 0]
          layout(false)
        }
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
    puck: () => (size.w ? puckAt() : [0, 0]),
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
    update(value, delay, instant = false, mixed = false) {
      const first = !placed
      placed = true
      shown = value as Point
      // Random, presets, undo and keys roll the coordinates; a drag or pan (the hand) doesn't.
      const ms = first || instant || pad.classList.contains("knobs-active") ? 0 : rollMs(x.row)
      rolling.show(
        mixed
          ? ["—"]
          : [
              { value: shown.x, decimals: decimals(f.step.x) },
              ", ",
              { value: shown.y, decimals: decimals(f.step.y) },
            ],
        ms,
        delay,
      )
      pad.setAttribute("aria-valuetext", mixed ? "Mixed" : format(shown))
      layout(first)
    },
    dispose() {
      size.disconnect()
      rolling.dispose()
    },
  }
}

/**
 * A sideways pan on a row's head steps through its presets like a menu, a tick each, as one undo
 * step; past either end `nudged` (the head's mini strip or curve) gives a little.
 */
export function panPresets(
  c: RowContext<unknown>,
  head: HTMLElement,
  nudged: HTMLElement | SVGElement,
  o: {
    readonly count: number
    /** The preset showing, or -1. */
    at(): number
    choose(i: number, coalesce: boolean): void
  },
) {
  if (!o.count) return
  let travel: Steps | undefined
  let chosen = false
  const give = textGive(nudged, () => c.wake())
  const letGo = () => {
    give.release()
    if (!travel) return
    travel = undefined
    chosen = false
    head.removeAttribute("data-panned")
    c.wake()
  }
  const move = (dx: number, size?: number) => {
    if (!travel) {
      travel = { travel: 0, give: 0 }
      // In hand: the head's wash, however the pointer got there.
      head.setAttribute("data-panned", "")
      c.wake()
    }
    const at = o.at()
    const { next, index } = stepList(travel, dx, at, o.count, size)
    travel = next
    if (index !== undefined && index !== at) {
      o.choose(index, chosen)
      chosen = true
      tick(head)
    }
    if (next.give !== give.give) give.hold(next.give)
  }
  // A pointer dragged sideways on the head steps the same way, a step every `DRAG_STEP` px. Only
  // past a few px is it a drag: a click still opens the row, and a drag's own click is swallowed.
  let press: { id: number; x: number; y: number; last: number; dragging: boolean } | undefined
  head.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.pointerType === "touch") return
    if ((event.target as Element).closest("button,input")) return
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, last: 0, dragging: false }
  })
  head.addEventListener("pointermove", (event) => {
    if (!press || event.pointerId !== press.id) return
    const dx = event.clientX - press.x
    if (!press.dragging) {
      if (Math.abs(dx) < DRAG_START) {
        if (Math.abs(event.clientY - press.y) >= DRAG_START) press = undefined
        return
      }
      press.dragging = true
      press.last = Math.sign(dx) * DRAG_START
      head.setPointerCapture(event.pointerId)
    }
    move(dx - press.last, DRAG_STEP)
    press.last = dx
  })
  const drop = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return
    const dragged = press.dragging
    press = undefined
    if (!dragged) return
    letGo()
    // The click this release makes (in the same task) would open or fold the row: it was a drag.
    const swallow = (click: Event) => {
      click.preventDefault()
      click.stopImmediatePropagation()
    }
    head.addEventListener("click", swallow, { capture: true, once: true })
    setTimeout(() => head.removeEventListener("click", swallow, { capture: true }), 0)
  }
  head.addEventListener("pointerup", drop)
  head.addEventListener("pointercancel", drop)
  onPan(head, {
    move: (dx) => move(dx),
    lift: () => give.release(),
    end: letGo,
    step(direction) {
      const at = o.at()
      const next = at < 0 ? (direction > 0 ? 0 : o.count - 1) : at + direction
      if (next >= 0 && next < o.count && next !== at) o.choose(next, false)
    },
  })
}

/** How far (px) a pointer goes sideways on a head before it's a drag, and px per preset after. */
const DRAG_START = 4
const DRAG_STEP = 24

const EASE_PAD = { x: 12, y: 10 }
const MINI = { w: 30, y: [-0.3, 1.3] as const }

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
  /** Which handle a pan holds past the box's edges, and how far (px). */
  let give: [number, number, number] = [-1, 0, 0]
  // What's drawn: the curve's samples and both handles in the 0…1 box (y up, over EASING_Y),
  // moving between easings on one spring with the same morph a curve row uses (ramp-morph.ts).
  const spanY = range[1] - range[0]
  const norm = (y: number) => (clamp(y, range[0], range[1]) - range[0]) / spanY
  const morph = new RampMorph(2, 2)
  const unitSamples = () => {
    const out: number[] = []
    for (let i = 0; i <= 48; i++) {
      const [bx, by] = bezierPoint(shown, i / 48)
      out.push(bx, norm(by))
    }
    return out
  }
  const unitHandles = () => {
    const w = Math.max(1, size.w - EASE_PAD.x * 2)
    const h = Math.max(1, size.h - EASE_PAD.y * 2)
    return [0, 1].map((i) => {
      const [gx, gy] = give[0] === i ? [give[1] / w, give[2] / h] : [0, 0]
      return [clamp(shown[i * 2]!, 0, 1) + gx, norm(shown[i * 2 + 1]!) - gy]
    })
  }
  const toPx = (ux: number, uy: number): [number, number] => [
    EASE_PAD.x + ux * (size.w - EASE_PAD.x * 2),
    EASE_PAD.y + (1 - uy) * (size.h - EASE_PAD.y * 2),
  ]
  const handleAt = (i: number): [number, number] => {
    const d = morph.live[i]
    return d ? toPx(d.at[0]!, d.at[1]!) : map(shown[i * 2]!, shown[i * 2 + 1]!)
  }
  const curvePoints = () => {
    if (!size.w) return []
    const s = morph.samples
    const out: number[] = []
    for (let i = 0; i < s.length; i += 2) out.push(...toPx(s[i]!, s[i + 1]!))
    return out
  }
  const armPoints = () =>
    size.w ? [...map(0, 0), ...handleAt(0), ...map(1, 1), ...handleAt(1)] : []
  const miniPoints = () => {
    if (!miniSize.h) return []
    const s = morph.samples
    const [m0, m1] = MINI.y
    const out: number[] = []
    for (let i = 0; i < s.length; i += 2) {
      const y = clamp(range[0] + s[i + 1]! * spanY, m0, m1)
      out.push(1.5 + s[i]! * (MINI.w - 3), 1.5 + ((m1 - y) / (m1 - m0)) * (miniSize.h - 3))
    }
    return out
  }
  const plotSmears = smearFilters(c.doc, plot)
  const lineSmear = plotSmears.line(curve)
  let strength = 0
  /** A handle's smear (px, along its travel): 0 at rest and in hand. */
  const handleSmear = (i: number): [number, number] => {
    const d = morph.live[i]
    if (!d || !strength || !morph.moving) return [0, 0]
    const vx = d.vel[0]! * (size.w - EASE_PAD.x * 2)
    const vy = -d.vel[1]! * (size.h - EASE_PAD.y * 2)
    const speed = Math.hypot(vx, vy)
    const px = curveSmear(speed, strength)
    return px ? [(vx / speed) * px, (vy / speed) * px] : [0, 0]
  }
  const lineBlur = () =>
    strength && morph.moving
      ? curveSmear(
          morph.sampleSpeed(size.w - EASE_PAD.x * 2, size.h - EASE_PAD.y * 2),
          strength,
          LINE_SMEAR,
        )
      : 0
  /** Writes the morph's frame to the DOM (the GPU reads the same numbers through its binding). */
  const draw = () => {
    const a = armPoints()
    // The handles are what a pointer grabs, so they're placed for the GPU too.
    if (a.length === 8) {
      handles[0]!.style.translate = `${a[2]}px ${a[3]}px`
      handles[1]!.style.translate = `${a[6]}px ${a[7]}px`
    }
    if (x.row.closest('[data-gpu-active="true"]')) return
    if (miniSize.h) setPath(miniPath, miniPoints())
    if (!size.w) return
    setPath(curve, curvePoints())
    lineSmear(lineBlur())
    arms.style.setProperty(
      "d",
      `path("M${a[0]} ${a[1]}L${a[2]} ${a[3]}M${a[4]} ${a[5]}L${a[6]} ${a[7]}")`,
    )
    handles.forEach((h, i) => plotSmears.dot(h, ...handleSmear(i)))
  }
  const loop = morphLoop(c, morph, draw)
  let placed = false
  const layout = (instant: boolean, delay = 0) => {
    if (size.w) {
      plot.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`)
      const [x0, y0] = map(0, 0)
      const [x1, y1] = map(1, 1)
      guides.setAttribute(
        "d",
        `M${EASE_PAD.x} ${y0}H${size.w - EASE_PAD.x}M${EASE_PAD.x} ${y1}H${size.w - EASE_PAD.x}M${x0} ${y0}L${x1} ${y1}`,
      )
    }
    const still = instant || !placed || reducedMotion(c.doc)
    placed = true
    morph.set(unitSamples(), unitHandles(), { instant: still, delay, now: performance.now() })
    if (morph.moving) {
      strength = curveBlur(x.row)
      loop.kick()
    }
    draw()
  }
  const size = measure(box, () => layout(true))
  const miniSize = measure(mini, () => {
    mini.setAttribute("viewBox", `0 0 ${MINI.w} ${miniSize.h}`)
    layout(true)
  })
  const g = gesture(c)
  let dragging = -1
  let dragRect: DOMRect | undefined
  let grab: [number, number] = [0, 0]
  let fine = false
  let anchor: [number, number] = [0, 0]
  let anchorValue = shown
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
  // A pan that starts sideways moves the hovered (or focused) handle with the fingers; past the
  // box's edges it gives a little and springs back when it's let go.
  let panned = -1
  let panAt: [Band, Band] = [
    { at: 0, give: 0 },
    { at: 0, give: 0 },
  ]
  const panTarget = () => {
    const hovered = handles.findIndex((h) => h.matches(":hover"))
    return hovered >= 0 ? hovered : handles.findIndex((h) => h === c.doc.activeElement)
  }
  onPan(
    box,
    {
      accept: () => dragging < 0 && panTarget() >= 0,
      move(dx, dy) {
        const w = (size.w || box.clientWidth) - EASE_PAD.x * 2
        const h = (size.h || box.clientHeight) - EASE_PAD.y * 2
        if (w <= 0 || h <= 0) return
        if (panned < 0) {
          panned = panTarget()
          if (panned < 0) return
          panAt = [
            { at: shown[panned * 2]! * w, give: 0 },
            { at: ((range[1] - shown[panned * 2 + 1]!) / spanY) * h, give: 0 },
          ]
          g.start()
          box.classList.add("knobs-active")
          c.wake()
        }
        const before = panAt[0].give || panAt[1].give
        panAt = [band(panAt[0], dx, 0, w), band(panAt[1], dy, 0, h)]
        if (stretched(before, panAt[0].give || panAt[1].give)) tick(box, "limit")
        const moved = give[1] !== panAt[0].give || give[2] !== panAt[1].give
        give = [panned, panAt[0].give, panAt[1].give]
        move(panned, panAt[0].at / w, range[1] - (panAt[1].at / h) * spanY)
        if (moved) {
          layout(true)
          c.wake()
        }
      },
      end() {
        panned = -1
        box.classList.remove("knobs-active")
        if (give[1] || give[2]) {
          give = [-1, 0, 0]
          layout(false)
        }
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
  panPresets(c, x.head, mini, {
    count: names.length,
    at: () => names.findIndex((n) => n === easingName(shown)),
    choose: (i, coalesce) => c.set(EASINGS[names[i]!], { coalesce }),
  })
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
    advance: (now) => morph.step(now),
    blur: lineBlur,
    smear: handleSmear,
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
    options: {
      count: names.length,
      choose: (i) => c.set(EASINGS[names[i]!]),
      shown: () => (x.isOpen() && visible(chips) ? chipButtons : []),
      anchor: mini,
    },
    update(value, delay, instant = false, mixed = false) {
      const first = name.dataset.placed === undefined
      name.dataset.placed = ""
      shown = value as Bezier
      const match = mixed ? undefined : easingName(shown)
      const hand = box.classList.contains("knobs-active") || x.head.hasAttribute("data-panned")
      fadeText(name, mixed ? "—" : (match ?? ""), !first && !instant && !hand)
      for (const [i, b] of chipButtons.entries())
        b.setAttribute("aria-checked", String(names[i] === match))
      handles.forEach((h, i) =>
        h.setAttribute("aria-valuetext", `x ${shown[i * 2]}, y ${shown[i * 2 + 1]}`),
      )
      const held = dragging >= 0 || panned >= 0
      layout(first || held || instant, delay)
    },
    dispose() {
      size.disconnect()
      miniSize.disconnect()
      loop.dispose()
    },
  }
}
