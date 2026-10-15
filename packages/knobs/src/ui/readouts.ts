// Readouts in the DOM: a live value, a sparkline, a graph, a meter, a table and a log. Panels put
// them in rows (knobs/panel) and knobs/ui offers them on their own. Every readout redraws at most
// once a frame on one shared clock, only while it's on screen and something changed, and sleeps
// otherwise. Graphics go to a 2D canvas (or, under the GPU overlay, nowhere: the overlay draws the
// same ops); text changes at a readable rate, in boxes that only grow, so nothing reflows per update.
import type { EntryLog, LogLevel, ReadoutState, Ring } from "../core/readout.js"
import { pushReadout, readoutState } from "../core/readout.js"
import type {
  GraphField,
  LogField,
  MeterField,
  ReadoutField,
  SparklineField,
  TableField,
  WatchField,
} from "../core/schema.js"
import { Spring } from "../core/spring.js"
import { applyLook, injectUiStyles, type UiLook } from "./look.js"
import {
  EasedRange,
  fitRange,
  formatNumber,
  graphScene,
  levelOf,
  meterScene,
  paintOps,
  type Palette,
  type PlotOp,
  SERIES,
  sampleAt,
  sparkScene,
} from "./readout-model.js"
import { parseCssColor, type Rgba, withAlpha } from "./rgba.js"
import { virtualWindow } from "./tree-model.js"

export type ReadoutFont = "value" | "mono" | "meta"
/** A piece of text the GPU overlay draws in place of the DOM's (which it hides). */
export interface TextItem {
  readonly el: HTMLElement
  /** Drawn left to right from the element's left edge, or right-aligned at its right edge. */
  readonly parts: readonly { readonly text: string; readonly color: Rgba }[]
  readonly font: ReadoutFont
  readonly align: "left" | "right"
  /** Clipped to this element (a scroller). */
  readonly clip?: HTMLElement
}
/** Ops in px from `el`'s top-left corner. */
export interface PlotLayer {
  readonly el: HTMLElement
  readonly ops: readonly PlotOp[]
}
export interface ButtonItem {
  readonly el: HTMLButtonElement
  /** `chip`: a filter chip (pressed shows a wash); `pill`: a filled pill (jump to latest). */
  readonly look: "chip" | "plain" | "pill"
  readonly alpha: number
}
export interface ReadoutView {
  readonly element: HTMLElement
  readonly field: ReadoutField
  /** Where the row's ↑↓ stop lands. */
  readonly focusTarget: HTMLElement
  /** Graphics, text and buttons as the last frame drew them (the GPU overlay draws these). */
  layers(): readonly PlotLayer[]
  texts(): readonly TextItem[]
  buttons(): readonly ButtonItem[]
  /** Something arrived in the readout's state. */
  notify(): void
  /** A new field of the same kind (a descriptor swap). */
  retune(field: ReadoutField): void
  /** Paints its canvas again (after a GPU overlay stopped drawing it). */
  refresh(): void
  dispose(): void
}
export interface ReadoutEnv {
  readonly doc: Document
  readonly field: ReadoutField
  readonly state: ReadoutState
  /** The row's label; block readouts (graph, table, log) put it in their head. */
  readonly label?: HTMLElement
  /** True while a GPU overlay draws this readout: the canvas stays blank. */
  gpu?(): boolean
  /** Called after a frame changed what the readout shows. */
  wake?(): void
}

// ——— one clock, one observer of each kind per document ———

interface Runner {
  frame(now: number, dt: number): boolean
}
const clocks = new WeakMap<Window, { add(r: Runner): void; delete(r: Runner): void }>()
function clockOf(win: Window) {
  let clock = clocks.get(win)
  if (clock) return clock
  const running = new Set<Runner>()
  let raf = 0
  let last = 0
  const tick = (now: number) => {
    const dt = last ? Math.min(0.064, (now - last) / 1000) : 1 / 60
    last = now
    raf = 0
    for (const r of [...running]) if (!r.frame(now, dt)) running.delete(r)
    if (running.size) raf = win.requestAnimationFrame(tick)
    else last = 0
  }
  clock = {
    add(r) {
      running.add(r)
      if (!raf) raf = win.requestAnimationFrame(tick)
    },
    delete(r) {
      running.delete(r)
    },
  }
  clocks.set(win, clock)
  return clock
}
const watchers = new WeakMap<
  Document,
  { io: IntersectionObserver; ro: ResizeObserver; on: Map<Element, (e: unknown) => void> }
>()
function observersOf(doc: Document) {
  let w = watchers.get(doc)
  if (w) return w
  const on = new Map<Element, (e: unknown) => void>()
  const win = doc.defaultView!
  w = {
    on,
    io: new win.IntersectionObserver((entries) => {
      for (const e of entries) on.get(e.target)?.({ visible: e.isIntersecting })
    }),
    ro: new win.ResizeObserver((entries) => {
      for (const e of entries)
        on.get(e.target)?.({ w: e.contentRect.width, h: e.contentRect.height })
    }),
  }
  watchers.set(doc, w)
  return w
}

/** Readout colours from the tokens on `el`, read at most once a frame per element. */
const palettes = new WeakMap<Element, { at: number; p: Palette }>()
export function paletteOf(el: HTMLElement, now = performance.now()): Palette {
  const hit = palettes.get(el)
  if (hit && now - hit.at < 8) return hit.p
  const s = getComputedStyle(el)
  const c = (name: string, fallback: Rgba) => parseCssColor(s.getPropertyValue(name), fallback)
  const p: Palette = {
    accent: c("--ku-accent", [1, 1, 1, 1]),
    text: c("--ku-text", [1, 1, 1, 0.92]),
    label: c("--ku-label", [1, 1, 1, 0.64]),
    dim: c("--ku-dim", [1, 1, 1, 0.42]),
    line: c("--ku-line", [1, 1, 1, 0.1]),
    surfaceHi: c("--ku-surface-hi", [1, 1, 1, 0.11]),
    warn: c("--ku-warn", [0.96, 0.68, 0.2, 1]),
    critical: c("--ku-critical", [1, 0.37, 0.34, 1]),
    radius: Number.parseFloat(s.getPropertyValue("--ku-radius")) || 0,
  }
  palettes.set(el, { at: now, p })
  return p
}

const reduced = (doc: Document) =>
  doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

function make(doc: Document) {
  return <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const node = doc.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
}

/** A value's text and unit, as the field formats it. */
export function readoutText(field: ReadoutField, v: unknown): { num: string; unit: string } {
  if (v === null || v === undefined || v === "") return { num: "—", unit: "" }
  if (typeof v === "string") return { num: v, unit: "" }
  const n = Number(v)
  if (field.format) return { num: field.format(n), unit: "" }
  return {
    num: formatNumber(n, field.decimals),
    unit: Number.isFinite(n) ? (field.unit ?? "") : "",
  }
}

/** A canvas sized to its box (by a shared ResizeObserver), painted only when asked. */
function plot(doc: Document, cls: string, onSize: () => void) {
  const canvas = make(doc)("canvas", cls)
  canvas.setAttribute("aria-hidden", "true")
  let w = 0
  let h = 0
  let ctx: CanvasRenderingContext2D | null = null
  const obs = observersOf(doc)
  obs.on.set(canvas, (e) => {
    const size = e as { w?: number; h?: number }
    if (size.w === undefined) return
    w = size.w
    h = size.h!
    onSize()
  })
  obs.ro.observe(canvas)
  let blank = true
  let last: readonly PlotOp[] = []
  return {
    canvas,
    /** Paints the last ops again (or clears them under a GPU overlay). */
    repaint(skip: boolean) {
      this.paint(last, skip)
    },
    get w() {
      return w
    },
    get h() {
      return h
    },
    paint(ops: readonly PlotOp[], skip: boolean) {
      last = ops
      if (skip) {
        if (!blank && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
        blank = true
        return
      }
      const dpr = doc.defaultView?.devicePixelRatio || 1
      const bw = Math.max(1, Math.round(w * dpr))
      const bh = Math.max(1, Math.round(h * dpr))
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
      ctx ??= canvas.getContext("2d")
      if (!ctx) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, bw, bh)
      ctx.setTransform(bw / Math.max(1, w), 0, 0, bh / Math.max(1, h), 0, 0)
      paintOps(ctx, ops)
      blank = false
    },
    dispose() {
      obs.ro.unobserve(canvas)
      obs.on.delete(canvas)
    },
  }
}

/** Text that grows its box to the widest it has been (in ch), so new values never reflow the row. */
function growing(el: HTMLElement, min = 0) {
  let ch = min
  if (min) el.style.minWidth = `${min}ch`
  return (text: string) => {
    if (text.length > ch) {
      ch = text.length
      el.style.minWidth = `${ch}ch`
    }
  }
}

/** The machinery every readout shares: visibility, the clock, the getter, throttled text. */
function runtime(env: ReadoutEnv, root: HTMLElement, draw: (now: number, dt: number) => boolean) {
  const doc = env.doc
  const win = doc.defaultView!
  const clock = clockOf(win)
  const obs = observersOf(doc)
  let visible = false
  let field = env.field
  let disposed = false
  let lastPolled: unknown
  const runner: Runner = {
    frame(now, dt) {
      if (disposed || !visible) return false
      let polling = false
      if (field.get && field.kind !== "log") {
        polling = true
        const v = field.get()
        // A history takes every frame's sample; a value only what changed.
        if (field.kind === "sparkline" || field.kind === "graph" || v !== lastPolled) {
          lastPolled = v
          pushReadout(field, env.state, v)
        }
      }
      const moving = draw(now, dt)
      return polling || moving
    },
  }
  obs.on.set(root, (e) => {
    const v = (e as { visible?: boolean }).visible
    if (v === undefined) return
    visible = v
    if (v) clock.add(runner)
  })
  obs.io.observe(root)
  return {
    get visible() {
      return visible
    },
    request() {
      if (visible && !disposed) clock.add(runner)
    },
    retune(next: ReadoutField) {
      field = next
      this.request()
    },
    dispose() {
      disposed = true
      clock.delete(runner)
      obs.io.unobserve(root)
      obs.on.delete(root)
    },
  }
}

/** Throttles text to `hz` writes a second; the latest value always lands. */
function throttle(hz: () => number) {
  let at = -Infinity
  return {
    /** True when it may write now. */
    due(now: number) {
      if (now - at < 1000 / hz()) return false
      at = now
      return true
    },
  }
}

const fontClass: Record<ReadoutFont, string> = {
  value: "knobs-rd-v",
  mono: "knobs-rd-mono",
  meta: "knobs-rd-meta",
}

/** `[num][unit]`, right-aligned; the overlay draws the number at the unit's left. */
function valueBox(doc: Document) {
  const el = make(doc)
  const box = el("span", "knobs-rd-value")
  const num = el("span", `knobs-rd-num ${fontClass.value}`, "—")
  const unit = el("span", `knobs-rd-unit ${fontClass.value}`)
  box.append(num, unit)
  const grow = growing(box, 3)
  let shown = { num: "—", unit: "" }
  return {
    box,
    num,
    unit,
    set(next: { num: string; unit: string }) {
      if (next.num !== shown.num) num.textContent = next.num
      if (next.unit !== shown.unit) {
        unit.textContent = next.unit
        unit.hidden = !next.unit
      }
      shown = next
      grow(next.unit ? `${next.num} ${next.unit}` : next.num)
    },
    texts(p: Palette, color = p.text): TextItem[] {
      const items: TextItem[] = []
      if (shown.unit)
        items.push({
          el: unit,
          parts: [{ text: shown.unit, color: p.dim }],
          font: "value",
          align: "left",
        })
      items.push({ el: num, parts: [{ text: shown.num, color }], font: "value", align: "right" })
      return items
    },
  }
}

// ——— watch ———

function createWatch(env: ReadoutEnv): ReadoutView {
  const el = make(env.doc)
  const root = el("span", "knobs-ui knobs-rd knobs-rd-watch")
  let field = env.field as WatchField
  const value = valueBox(env.doc)
  root.append(value.box)
  let seq = -1
  const text = throttle(() => field.hz ?? 4)
  const rt = runtime(env, root, (now) => {
    if (env.state.seq === seq) return false
    if (!text.due(now)) return true
    seq = env.state.seq
    value.set(readoutText(field, env.state.value))
    env.wake?.()
    return false
  })
  return {
    element: root,
    get field() {
      return field
    },
    focusTarget: root,
    layers: () => [],
    texts: () => value.texts(paletteOf(root)),
    buttons: () => [],
    notify: () => rt.request(),
    refresh() {},
    retune(next) {
      field = next as WatchField
      seq = -1
      rt.retune(next)
    },
    dispose: () => rt.dispose(),
  }
}

// ——— sparkline ———

function createSparkline(env: ReadoutEnv): ReadoutView {
  const el = make(env.doc)
  const root = el("span", "knobs-ui knobs-rd knobs-rd-spark")
  let field = env.field as SparklineField
  const canvas = plot(env.doc, "knobs-rd-plot", () => {
    dirty = true
    rt.request()
  })
  const value = valueBox(env.doc)
  root.append(canvas.canvas, value.box)
  const range = new EasedRange()
  const text = throttle(() => field.hz ?? 4)
  let seq = -1
  let dirty = true
  let hover = false
  let ops: PlotOp[] = []
  let textSeq = -1
  const ring = () => env.state.series!.get("")!
  const rt = runtime(env, root, (now, dt) => {
    const r = ring()
    const fresh = env.state.seq !== seq
    seq = env.state.seq
    const [lo, hi] = r.extent()
    const target = fitRange(lo, hi, field)
    const t = range.target
    if (target[0] !== t[0] || target[1] !== t[1]) range.to(target[0], target[1], reduced(env.doc))
    const moving = range.step(dt)
    let wrote = false
    if (fresh || moving || dirty) {
      const p = paletteOf(root, now)
      ops = sparkScene({
        ring: r,
        capacity: field.history,
        range: range.value,
        w: canvas.w,
        h: canvas.h,
        color: field.color ? parseCssColor(field.color, p.accent) : p.accent,
        palette: p,
        hover,
      })
      canvas.paint(ops, env.gpu?.() ?? false)
      dirty = false
      wrote = true
    }
    // Hovered, it reads the history's extent; otherwise the newest sample, at a readable rate.
    let pending = false
    if (hover) {
      if (textSeq !== -2 || fresh) {
        const [a, b] = r.extent()
        const f = (v: number) => readoutText(field, v)
        value.set({ num: `${f(a).num}–${f(b).num}`, unit: f(b).unit })
        textSeq = -2
        wrote = true
      }
    } else if (textSeq !== seq) {
      if (text.due(now)) {
        value.set(readoutText(field, r.length ? r.last() : null))
        textSeq = seq
        wrote = true
      } else pending = true
    }
    if (wrote) env.wake?.()
    return moving || pending
  })
  const setHover = (on: boolean) => {
    if (hover === on) return
    hover = on
    dirty = true
    textSeq = -1
    root.toggleAttribute("data-hover", on)
    rt.request()
  }
  root.addEventListener("pointerenter", () => setHover(true))
  root.addEventListener("pointerleave", () => setHover(false))
  return {
    element: root,
    get field() {
      return field
    },
    focusTarget: root,
    layers: () => [{ el: canvas.canvas, ops }],
    texts: () => value.texts(paletteOf(root), hover ? paletteOf(root).label : undefined),
    buttons: () => [],
    notify: () => rt.request(),
    /** Focus reads like hover: the extent. */
    hover: setHover,
    refresh: () => {
      canvas.repaint(env.gpu?.() ?? false)
      // A restyle's new colours: drawn afresh on the next frame.
      dirty = true
      rt.request()
    },
    retune(next) {
      field = next as SparklineField
      dirty = true
      textSeq = -1
      rt.retune(next)
    },
    dispose() {
      canvas.dispose()
      rt.dispose()
    },
  } as ReadoutView & { hover(on: boolean): void }
}

// ——— graph ———

function createGraph(env: ReadoutEnv): ReadoutView {
  const el = make(env.doc)
  const root = el("div", "knobs-ui knobs-rd knobs-rd-graph knobs-rd-block")
  let field = env.field as GraphField
  const head = el("div", "knobs-rd-head")
  if (env.label) head.append(env.label)
  const legend = el("span", "knobs-rd-legend")
  head.append(legend)
  const box = el("div", "knobs-rd-plotbox")
  box.tabIndex = -1
  box.setAttribute("role", "img")
  const canvas = plot(env.doc, "knobs-rd-plot", () => {
    dirty = true
    rt.request()
  })
  const top = el("span", `knobs-rd-tick ${fontClass.mono}`)
  const bottom = el("span", `knobs-rd-tick ${fontClass.mono}`)
  top.dataset.at = "top"
  bottom.dataset.at = "bottom"
  box.append(canvas.canvas, top, bottom)
  root.append(head, box)
  let keys: {
    id: string
    swatch: HTMLElement
    name: HTMLElement
    value: ReturnType<typeof valueBox>
  }[] = []
  let marks: { el: HTMLElement; value: number; label: string; y: number }[] = []
  const build = () => {
    legend.replaceChildren()
    keys = field.series.map((s) => {
      const key = el("span", "knobs-rd-key")
      const swatch = el("i", "knobs-rd-swatch")
      const name = el("span", `knobs-rd-name ${fontClass.meta}`, s.label ?? s.id)
      const value = valueBox(env.doc)
      key.append(swatch, name, value.box)
      legend.append(key)
      return { id: s.id, swatch, name, value }
    })
    for (const m of marks) m.el.remove()
    marks = field.thresholds
      .filter((t) => t.label)
      .map((t) => {
        const m = el("span", `knobs-rd-mark ${fontClass.mono}`, t.label)
        box.append(m)
        return { el: m, value: t.value, label: t.label!, y: Number.NaN }
      })
    box.style.height = `${field.height}px`
    box.setAttribute("aria-label", `${env.label?.textContent ?? "Graph"}`)
  }
  build()
  const range = new EasedRange()
  const text = throttle(() => field.hz ?? 4)
  let seq = -1
  let dirty = true
  let hoverX = -1
  let hoverAt = -1
  let ops: PlotOp[] = []
  let ticks = { top: "", bottom: "" }
  let shownSeq = -1
  const rings = () => field.series.map((s) => env.state.series!.get(s.id)!)
  const colorOf = (p: Palette, i: number) => {
    const s = field.series[i]!
    return s.color
      ? parseCssColor(s.color, p.accent)
      : i === 0
        ? p.accent
        : parseCssColor(SERIES[(i - 1) % SERIES.length]!)
  }
  const rt = runtime(env, root, (now, dt) => {
    const rs = rings()
    const fresh = env.state.seq !== seq
    seq = env.state.seq
    let lo = Infinity
    let hi = -Infinity
    for (const r of rs) {
      const [a, b] = r.extent()
      if (a < lo) lo = a
      if (b > hi) hi = b
    }
    const target = fitRange(
      lo,
      hi,
      field,
      field.thresholds.map((t) => t.value),
    )
    const t = range.target
    if (target[0] !== t[0] || target[1] !== t[1]) range.to(target[0], target[1], reduced(env.doc))
    const moving = range.step(dt)
    const length = rs[0]?.length ?? 0
    const at = hoverX >= 0 ? sampleAt(hoverX, canvas.w, field.history, length) : -1
    const hoverMoved = at !== hoverAt
    hoverAt = at
    let wrote = false
    const p = paletteOf(root, now)
    if (fresh || moving || dirty || hoverMoved) {
      const [a, b] = range.value
      ops = graphScene({
        lines: rs.map((ring, i) => ({
          ring,
          color: colorOf(p, i),
          area: Boolean(field.series[i]!.area),
        })),
        capacity: field.history,
        range: [a, b],
        thresholds: field.thresholds.map((th) => ({
          value: th.value,
          color: th.color ? withAlpha(parseCssColor(th.color, p.dim), 0.8) : withAlpha(p.dim, 0.8),
        })),
        w: canvas.w,
        h: canvas.h,
        palette: p,
        hover: at,
      })
      canvas.paint(ops, env.gpu?.() ?? false)
      // Threshold labels ride their lines as the scale eases (transforms: no layout).
      const span = b - a || 1
      for (const m of marks) {
        const y = 3 + (1 - (m.value - a) / span) * (canvas.h - 4)
        if (Math.abs(y - m.y) > 0.05) {
          m.y = y
          m.el.style.transform = `translateY(${(y - 7).toFixed(2)}px)`
        }
        m.el.hidden = y < 6 || y > canvas.h - 2
      }
      const nextTicks = { top: readoutText(field, b).num, bottom: readoutText(field, a).num }
      if (nextTicks.top !== ticks.top) top.textContent = nextTicks.top
      if (nextTicks.bottom !== ticks.bottom) bottom.textContent = nextTicks.bottom
      ticks = nextTicks
      for (const k of keys)
        k.swatch.style.background = `rgb(${colorOf(p, keys.indexOf(k))
          .slice(0, 3)
          .map((c) => Math.round(c * 255))
          .join(",")})`
      dirty = false
      wrote = true
    }
    // The legend reads the hovered sample, or the newest one at a readable rate.
    let pending = false
    if (at >= 0 ? hoverMoved || fresh : shownSeq !== seq || hoverMoved) {
      if (at >= 0 || hoverMoved || text.due(now)) {
        keys.forEach((k, i) => {
          const r = rs[i]!
          k.value.set(readoutText(field, at >= 0 ? r.at(at) : r.length ? r.last() : null))
        })
        shownSeq = at >= 0 ? -1 : seq
        wrote = true
      } else pending = true
    }
    if (wrote) env.wake?.()
    return moving || pending
  })
  const local = (e: PointerEvent) => e.clientX - canvas.canvas.getBoundingClientRect().left
  box.addEventListener("pointermove", (e) => {
    hoverX = local(e)
    rt.request()
  })
  box.addEventListener("pointerleave", () => {
    hoverX = -1
    rt.request()
  })
  // Keys walk the crosshair along the samples while the plot has focus.
  box.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Escape") return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const length = rings()[0]?.length ?? 0
    if (!length) return
    if (e.key === "Escape") {
      if (hoverX < 0) return
      hoverX = -1
    } else {
      const dx = field.history > 1 ? canvas.w / (field.history - 1) : 0
      // From the crosshair as last placed (keys can outrun frames), or the newest sample.
      const cur = hoverX >= 0 ? sampleAt(hoverX, canvas.w, field.history, length) : -1
      const step = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1)
      const next = cur < 0 ? length - 1 : Math.max(0, Math.min(length - 1, cur + step))
      hoverX = canvas.w - (length - 1 - next) * dx
    }
    e.preventDefault()
    e.stopPropagation()
    rt.request()
  })
  box.addEventListener("blur", () => {
    hoverX = -1
    rt.request()
  })
  return {
    element: root,
    get field() {
      return field
    },
    focusTarget: box,
    layers: () => [
      { el: canvas.canvas, ops },
      ...keys.map((k, i) => ({
        el: k.swatch,
        ops: [{ t: "rect" as const, x: 0, y: 0, w: 8, h: 2, color: colorOf(paletteOf(root), i) }],
      })),
    ],
    texts() {
      const p = paletteOf(root)
      const items: TextItem[] = []
      for (const k of keys) {
        items.push({
          el: k.name,
          parts: [{ text: k.name.textContent ?? "", color: p.label }],
          font: "meta",
          align: "left",
        })
        items.push(...k.value.texts(p, hoverAt >= 0 ? p.text : p.text))
      }
      items.push({
        el: top,
        parts: [{ text: ticks.top, color: p.dim }],
        font: "mono",
        align: "left",
      })
      items.push({
        el: bottom,
        parts: [{ text: ticks.bottom, color: p.dim }],
        font: "mono",
        align: "left",
      })
      for (const m of marks)
        if (!m.el.hidden)
          items.push({
            el: m.el,
            parts: [{ text: m.label, color: p.dim }],
            font: "mono",
            align: "right",
          })
      return items
    },
    buttons: () => [],
    notify: () => rt.request(),
    refresh: () => {
      canvas.repaint(env.gpu?.() ?? false)
      // A restyle's new colours: drawn afresh on the next frame.
      dirty = true
      rt.request()
    },
    retune(next) {
      const before = field
      field = next as GraphField
      if (
        before.series.map((s) => `${s.id}${s.label}${s.color}`).join() !==
          field.series.map((s) => `${s.id}${s.label}${s.color}`).join() ||
        before.height !== field.height ||
        before.thresholds.map((t) => t.label).join() !== field.thresholds.map((t) => t.label).join()
      )
        build()
      dirty = true
      shownSeq = -1
      rt.retune(next)
    },
    dispose() {
      canvas.dispose()
      rt.dispose()
    },
  }
}

// ——— meter ———

function createMeter(env: ReadoutEnv): ReadoutView {
  const el = make(env.doc)
  const root = el("span", "knobs-ui knobs-rd knobs-rd-meter")
  let field = env.field as MeterField
  const canvas = plot(env.doc, "knobs-rd-plot", () => {
    dirty = true
    rt.request()
  })
  const value = valueBox(env.doc)
  root.append(canvas.canvas, value.box)
  root.setAttribute("role", "meter")
  const fill = new Spring(0, 22, 1, 1e-4)
  const level = new Spring(0, 28, 1, 1e-3)
  const text = throttle(() => field.hz ?? 4)
  let seq = -1
  let dirty = true
  let placed = false
  let ops: PlotOp[] = []
  let textSeq = -1
  const t0 = performance.now()
  const rt = runtime(env, root, (now, dt) => {
    const v = env.state.value
    const known = typeof v === "number" && Number.isFinite(v)
    if (env.state.seq !== seq) {
      seq = env.state.seq
      if (known) {
        const f = (v - field.min) / (field.max - field.min)
        const snap = !placed || reduced(env.doc)
        const band = (field.max - field.min) * 0.02
        const next = levelOf(v, field.warn, field.critical, level.target, band)
        if (snap) {
          fill.snap(f)
          level.snap(next)
        } else {
          fill.set(f)
          level.set(next)
        }
        placed = true
        root.setAttribute("aria-valuenow", String(v))
        root.removeAttribute("aria-busy")
      } else root.setAttribute("aria-busy", "true")
      dirty = true
    }
    fill.step(dt)
    level.step(dt)
    const moving = !fill.resting || !level.resting
    const sweeping = !known && env.state.seq > 0 && !reduced(env.doc)
    let wrote = false
    if (dirty || moving || sweeping) {
      ops = meterScene({
        fraction: fill.x,
        level: level.x,
        min: field.min,
        max: field.max,
        ...(field.warn !== undefined ? { warn: field.warn } : {}),
        ...(field.critical !== undefined ? { critical: field.critical } : {}),
        ...(field.segments !== undefined ? { segments: field.segments } : {}),
        ...(known || env.state.seq === 0 ? {} : { sweep: ((now - t0) / 1600) % 1 }),
        w: canvas.w,
        h: canvas.h,
        palette: paletteOf(root, now),
      })
      canvas.paint(ops, env.gpu?.() ?? false)
      dirty = false
      wrote = true
    }
    let pending = false
    if (textSeq !== seq) {
      if (text.due(now)) {
        textSeq = seq
        if (!known) value.set({ num: "—", unit: "" })
        else {
          const t = readoutText(field, v)
          const percent = field.min === 0 && field.max === 1 && !field.unit && !field.format
          value.set(
            percent
              ? { num: `${Math.round(v * 100)}%`, unit: "" }
              : {
                  num: t.num,
                  unit: `/ ${readoutText(field, field.max).num}${field.unit ? ` ${field.unit}` : ""}`,
                },
          )
        }
        wrote = true
      } else pending = true
    }
    if (wrote) env.wake?.()
    return moving || pending || sweeping
  })
  const aria = () => {
    root.setAttribute("aria-valuemin", String(field.min))
    root.setAttribute("aria-valuemax", String(field.max))
  }
  aria()
  return {
    element: root,
    get field() {
      return field
    },
    focusTarget: root,
    layers: () => [{ el: canvas.canvas, ops }],
    texts: () => value.texts(paletteOf(root)),
    buttons: () => [],
    notify: () => rt.request(),
    refresh: () => {
      canvas.repaint(env.gpu?.() ?? false)
      // A restyle's new colours: drawn afresh on the next frame.
      dirty = true
      rt.request()
    },
    retune(next) {
      field = next as MeterField
      seq = textSeq = -1
      aria()
      rt.retune(next)
    },
    dispose() {
      canvas.dispose()
      rt.dispose()
    },
  }
}

// ——— table ———

const isNumeric = (v: unknown) =>
  typeof v === "number" || (typeof v === "string" && /^[-+]?[\d.,]+\s*\S{0,3}$/.test(v))

function createTable(env: ReadoutEnv): ReadoutView {
  const el = make(env.doc)
  const root = el("div", "knobs-ui knobs-rd knobs-rd-table knobs-rd-block")
  let field = env.field as TableField
  const grid = el("div", "knobs-rd-grid")
  grid.tabIndex = -1
  grid.setAttribute("role", "table")
  root.append(grid)
  const text = throttle(() => field.hz ?? 4)
  let seq = -1
  let cols = 0
  /** The heading row: the label (or nothing) over the first column, then the column names. */
  let head: { row: HTMLElement; cells: HTMLElement[] } | undefined
  let body: {
    row: HTMLElement
    cells: HTMLElement[]
    shown: { text: string; numeric: boolean }[]
  }[] = []
  let grows: ((t: string) => void)[] = []
  const header = (n: number) => {
    const names = field.columns ?? []
    const key = `${n}\u0000${names.join("\u0000")}`
    if (head && head.row.dataset.key === key) return
    head?.row.remove()
    const row = el("div", "knobs-rd-tr knobs-rd-thead")
    row.dataset.key = key
    row.setAttribute("role", "row")
    const cells = Array.from({ length: n }, (_, c) => {
      if (c === 0 && env.label) {
        env.label.classList.add("knobs-rd-cap")
        return env.label
      }
      const h = el("span", `knobs-rd-th ${fontClass.meta}`, c === 0 ? "" : (names[c] ?? ""))
      h.setAttribute("role", "columnheader")
      return h
    })
    row.append(...cells)
    grid.prepend(row)
    grid.style.gridTemplateColumns = `minmax(0,1fr)${" auto".repeat(n - 1)}`
    grows = cells.map((h) => growing(h))
    cells.forEach((h, c) => c > 0 && grows[c]!(h.textContent ?? ""))
    head = { row, cells }
  }
  const rowsOf = (v: unknown): unknown[][] => {
    if (!v) return []
    if (Array.isArray(v)) return v.map((r) => (Array.isArray(r) ? [...r] : [r]))
    return Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, x])
  }
  const render = () => {
    const rows = rowsOf(env.state.value)
    cols = Math.max(cols, field.columns?.length ?? 0, ...rows.map((r) => r.length), 1)
    header(cols)
    while (body.length > rows.length) body.pop()!.row.remove()
    rows.forEach((r, i) => {
      let line = body[i]
      if (!line || line.cells.length !== cols) {
        line?.row.remove()
        const row = el("div", "knobs-rd-tr")
        row.setAttribute("role", "row")
        const cells = Array.from({ length: cols }, (_, c) => {
          const cell = el("span", `knobs-rd-td ${c === 0 ? fontClass.meta : fontClass.value}`)
          cell.setAttribute("role", "cell")
          return cell
        })
        row.append(...cells)
        grid.append(row)
        line = { row, cells, shown: [] }
        body[i] = line
      }
      for (let c = 0; c < cols; c++) {
        const v = r[c]
        const t =
          c > 0 && typeof v === "number"
            ? Number.isInteger(v)
              ? String(v)
              : readoutText(field, v).num
            : String(v ?? "")
        const numeric = c > 0 && isNumeric(v)
        const was = line.shown[c]
        if (was?.text === t && was.numeric === numeric) continue
        line.cells[c]!.textContent = t
        line.cells[c]!.toggleAttribute("data-num", numeric)
        line.shown[c] = { text: t, numeric }
        if (c > 0) grows[c]?.(t)
      }
    })
  }
  const rt = runtime(env, root, (now) => {
    if (env.state.seq === seq) return false
    if (seq !== -1 && !text.due(now)) return true
    seq = env.state.seq
    render()
    env.wake?.()
    return false
  })
  render()
  return {
    element: root,
    get field() {
      return field
    },
    focusTarget: grid,
    layers: () => [],
    texts() {
      const p = paletteOf(root)
      const items: TextItem[] = []
      head?.cells.forEach((h, c) => {
        if (c > 0 && h.textContent)
          items.push({
            el: h,
            parts: [{ text: h.textContent, color: p.dim }],
            font: "meta",
            align: "right",
          })
      })
      for (const line of body)
        line.cells.forEach((cell, c) => {
          const s = line.shown[c]
          if (!s?.text) return
          items.push({
            el: cell,
            parts: [{ text: s.text, color: c === 0 ? p.label : p.text }],
            font: c === 0 ? "meta" : "value",
            align: s.numeric ? "right" : "left",
          })
        })
      return items
    },
    buttons: () => [],
    notify: () => rt.request(),
    refresh() {},
    retune(next) {
      field = next as TableField
      seq = -1
      rt.retune(next)
    },
    dispose: () => rt.dispose(),
  }
}

// ——— log ———

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const CHIPS = [
  { id: "all", label: "All", min: 0 },
  { id: "warn", label: "Warn", min: 2 },
  { id: "error", label: "Error", min: 3 },
] as const
const two = (n: number) => String(Math.floor(n)).padStart(2, "0")
/** A time as the log shows it: a clock for epoch times, else seconds (a `performance.now()`). */
export function logTime(t: number) {
  if (t > 1e11) {
    const d = new Date(t)
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  }
  return `${(t / 1000).toFixed(2)}s`
}
const levelColor = (p: Palette, level: LogLevel | undefined) =>
  level === "error" ? p.critical : level === "warn" ? p.warn : level === "debug" ? p.dim : p.text

function createLog(env: ReadoutEnv): ReadoutView {
  const doc = env.doc
  const el = make(doc)
  const root = el("div", "knobs-ui knobs-rd knobs-rd-log knobs-rd-block")
  let field = env.field as LogField
  const head = el("div", "knobs-rd-head")
  if (env.label) head.append(env.label)
  const chips = el("span", "knobs-rd-chips")
  chips.setAttribute("role", "radiogroup")
  chips.setAttribute("aria-label", "Level")
  const chipButtons = CHIPS.map((c) => {
    const b = el("button", `knobs-rd-chip ${fontClass.meta}`, c.label)
    b.type = "button"
    b.tabIndex = -1
    b.setAttribute("role", "radio")
    b.dataset.level = c.id
    b.onclick = () => setLevel(c.min)
    chips.append(b)
    return b
  })
  const find = el("input", `knobs-rd-find ${fontClass.meta}`)
  find.type = "search"
  find.placeholder = "Filter"
  find.spellcheck = false
  find.setAttribute("aria-label", "Filter the log")
  const copy = el("button", `knobs-rd-copy ${fontClass.meta}`, "Copy")
  copy.type = "button"
  copy.tabIndex = -1
  copy.setAttribute("aria-label", "Copy the log")
  head.append(chips, find, copy)
  const scroller = el("div", "knobs-rd-scroll")
  scroller.tabIndex = -1
  scroller.setAttribute("role", "log")
  scroller.setAttribute("aria-live", "off")
  const space = el("div", "knobs-rd-space")
  scroller.append(space)
  const jump = el("button", `knobs-rd-jump ${fontClass.meta}`, "Latest")
  jump.type = "button"
  jump.tabIndex = -1
  const body = el("div", "knobs-rd-logbody")
  body.append(scroller, jump)
  root.append(head, body)

  let minLevel = 0
  let query = ""
  let follow = true
  let seq = -1
  let viewH = 0
  let lineH = 18
  let seenTotal = 0
  let unseen = 0
  let shown: EntryLog["entries"] = []
  let span: readonly [number, number] = [0, 0]
  let scrollTop = 0
  const jumpShown = new Spring(0, 30, 1, 1e-3)
  let jumpAt = 0
  const pool: {
    line: HTMLElement
    time: HTMLElement
    text: HTMLElement
    at: number
    key: string
  }[] = []

  const obs = observersOf(doc)
  obs.on.set(scroller, (e) => {
    const size = e as { h?: number }
    if (size.h === undefined) return
    viewH = size.h
    lineH = Number.parseFloat(getComputedStyle(root).getPropertyValue("--rd-lh")) || 18
    rt.request()
  })
  obs.ro.observe(scroller)

  const setLevel = (min: number) => {
    minLevel = min
    seq = -1
    rt.request()
  }
  const matches = (e: EntryLog["entries"][number]) =>
    RANK[e.level ?? "info"] >= minLevel && (!query || e.text.toLowerCase().includes(query))
  const toBottom = () => {
    const max = Math.max(0, shown.length * lineH - viewH)
    if (Math.abs(scroller.scrollTop - max) > 0.5) scroller.scrollTop = max
    scrollTop = max
  }
  const place = () => {
    span = virtualWindow(scrollTop, viewH, lineH, shown.length, 4)
    const [a, b] = span
    let used = 0
    for (let i = a; i < b; i++) {
      const e = shown[i]!
      let slot = pool[used]
      if (!slot) {
        const line = el("div", "knobs-rd-line")
        const time = el("span", `knobs-rd-time ${fontClass.mono}`)
        const text = el("span", `knobs-rd-text ${fontClass.mono}`)
        line.append(time, text)
        space.append(line)
        slot = { line, time, text, at: -1, key: "" }
        pool.push(slot)
      }
      used++
      const key = `${e.seq}\u0000${query}`
      if (slot.key !== key) {
        slot.key = key
        slot.time.textContent = logTime(e.time)
        slot.line.dataset.level = e.level ?? "info"
        const at = query ? e.text.toLowerCase().indexOf(query) : -1
        if (at >= 0) {
          const m = el("mark", "knobs-rd-match", e.text.slice(at, at + query.length))
          slot.text.replaceChildren(e.text.slice(0, at), m, e.text.slice(at + query.length))
        } else slot.text.textContent = e.text
      }
      if (slot.at !== i) {
        slot.at = i
        slot.line.style.transform = `translateY(${i * lineH}px)`
      }
      slot.line.hidden = false
    }
    for (let j = used; j < pool.length; j++) {
      pool[j]!.line.hidden = true
      pool[j]!.at = -1
    }
  }
  let counts = { warn: 0, error: 0 }
  const rt = runtime(env, root, (_now, dt) => {
    const log = env.state.log!
    let changed = false
    if (env.state.seq !== seq) {
      seq = env.state.seq
      const before = shown.length
      shown = log.entries.filter(matches)
      counts = { warn: 0, error: 0 }
      for (const e of log.entries)
        if (e.level === "warn") counts.warn++
        else if (e.level === "error") counts.error++
      chipButtons.forEach((b, i) => {
        const c = CHIPS[i]!
        const n = c.id === "warn" ? counts.warn : c.id === "error" ? counts.error : 0
        const label = n ? `${c.label} ${n}` : c.label
        if (b.textContent !== label) b.textContent = label
        b.setAttribute("aria-checked", String(c.min === minLevel))
      })
      space.style.height = `${shown.length * lineH}px`
      if (log.total > seenTotal && !follow) unseen += log.total - seenTotal
      seenTotal = log.total
      if (follow) {
        unseen = 0
        toBottom()
      } else if (shown.length < before)
        scrollTop = Math.min(scrollTop, Math.max(0, shown.length * lineH - viewH))
      changed = true
    }
    const s = scroller.scrollTop
    if (changed || Math.abs(s - scrollTop) > 0.5 || (span[1] === 0 && shown.length)) {
      if (!changed) scrollTop = s
      place()
      changed = true
    }
    const label = unseen ? `${unseen} new ↓` : "Latest ↓"
    if (jump.textContent !== label) jump.textContent = label
    jumpShown.set(follow || shown.length * lineH <= viewH ? 0 : 1)
    if (reduced(doc)) jumpShown.snap(jumpShown.target)
    jumpShown.step(dt)
    const a = jumpShown.x
    jump.style.opacity = a.toFixed(3)
    jump.style.transform = `translate(-50%, ${((1 - a) * 6).toFixed(2)}px)`
    jump.style.pointerEvents = a > 0.5 ? "auto" : "none"
    if (changed || !jumpShown.resting || a !== jumpAt) env.wake?.()
    jumpAt = a
    return !jumpShown.resting
  })
  scroller.addEventListener(
    "scroll",
    () => {
      const max = shown.length * lineH - viewH
      follow = scroller.scrollTop >= max - lineH / 2
      if (follow) unseen = 0
      rt.request()
    },
    { passive: true },
  )
  jump.onclick = () => {
    follow = true
    unseen = 0
    toBottom()
    place()
    scroller.focus({ preventScroll: true })
    rt.request()
  }
  find.addEventListener("input", () => {
    query = find.value.trim().toLowerCase()
    seq = -1
    rt.request()
  })
  find.addEventListener("keydown", (e) => {
    e.stopPropagation()
    if (e.key === "Escape" || e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault()
      if (e.key === "Escape" && find.value) {
        find.value = ""
        query = ""
        seq = -1
        rt.request()
      }
      scroller.focus({ preventScroll: true })
    }
  })
  const copyText = () =>
    shown
      .map((e) => `${logTime(e.time).trim()} ${(e.level ?? "info").toUpperCase()} ${e.text}`)
      .join("\n")
  const doCopy = async () => {
    try {
      await doc.defaultView!.navigator.clipboard.writeText(copyText())
      copy.textContent = "Copied"
      setTimeout(() => {
        copy.textContent = "Copy"
        env.wake?.()
      }, 1200)
      env.wake?.()
    } catch {}
  }
  copy.onclick = () => void doCopy()
  scroller.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key.toLowerCase() === "c" && !doc.getSelection()?.toString()) {
        e.preventDefault()
        e.stopPropagation()
        void doCopy()
      }
      return
    }
    const page = Math.max(lineH, viewH - lineH)
    const by: Record<string, number> = {
      PageDown: page,
      PageUp: -page,
      Home: -Infinity,
      End: Infinity,
    }
    if (e.key in by) {
      e.preventDefault()
      e.stopPropagation()
      const max = Math.max(0, shown.length * lineH - viewH)
      scroller.scrollTop = Math.max(0, Math.min(max, scroller.scrollTop + by[e.key]!))
      return
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      const i = CHIPS.findIndex((c) => c.min === minLevel)
      const next = CHIPS[(i + (e.key === "ArrowLeft" ? -1 : 1) + CHIPS.length) % CHIPS.length]!
      setLevel(next.min)
      return
    }
    if (e.key === "Enter" || (e.key === "f" && !e.shiftKey && !e.altKey)) {
      e.preventDefault()
      e.stopPropagation()
      find.focus()
    }
  })
  return {
    element: root,
    get field() {
      return field
    },
    focusTarget: scroller,
    layers() {
      const p = paletteOf(root)
      return [
        {
          el: scroller,
          ops: [
            {
              t: "rect",
              x: 0,
              y: 0,
              w: scroller.clientWidth,
              h: scroller.clientHeight,
              color: withAlpha(p.surfaceHi, 0.45),
              r: Math.min(p.radius, 6),
            },
          ],
        },
      ]
    },
    texts() {
      const p = paletteOf(root)
      const items: TextItem[] = []
      for (const slot of pool) {
        if (slot.line.hidden || slot.at < 0) continue
        const e = shown[slot.at]
        if (!e) continue
        items.push({
          el: slot.time,
          parts: [{ text: logTime(e.time), color: p.dim }],
          font: "mono",
          align: "left",
          clip: scroller,
        })
        const ink = levelColor(p, e.level)
        const at = query ? e.text.toLowerCase().indexOf(query) : -1
        const parts =
          at >= 0
            ? [
                { text: e.text.slice(0, at), color: ink },
                { text: e.text.slice(at, at + query.length), color: p.accent },
                { text: e.text.slice(at + query.length), color: ink },
              ].filter((x) => x.text)
            : [{ text: e.text, color: ink }]
        items.push({
          el: slot.text,
          parts,
          font: "mono",
          align: "left",
          clip: scroller,
        })
      }
      return items
    },
    buttons: () => [
      ...chipButtons.map((b) => ({ el: b, look: "chip" as const, alpha: 1 })),
      { el: copy, look: "plain" as const, alpha: 1 },
      { el: jump, look: "pill" as const, alpha: jumpShown.x },
    ],
    notify: () => rt.request(),
    refresh() {},
    retune(next) {
      field = next as LogField
      root.style.setProperty("--knobs-rd-lines", String(field.lines))
      seq = -1
      rt.retune(next)
    },
    dispose() {
      obs.ro.unobserve(scroller)
      obs.on.delete(scroller)
      rt.dispose()
    },
  }
}

/** Builds the view for a readout field. */
export function createReadout(env: ReadoutEnv): ReadoutView {
  const view =
    env.field.kind === "watch"
      ? createWatch(env)
      : env.field.kind === "sparkline"
        ? createSparkline(env)
        : env.field.kind === "graph"
          ? createGraph(env)
          : env.field.kind === "meter"
            ? createMeter(env)
            : env.field.kind === "table"
              ? createTable(env)
              : createLog(env)
  view.element.dataset.kind = env.field.kind
  // restyle() changed the tokens: canvases draw again in the new colours.
  view.element.addEventListener("knobs-restyle", () => view.refresh())
  if (env.field.kind === "log")
    view.element.style.setProperty("--knobs-rd-lines", String((env.field as LogField).lines))
  return view
}
export type { Ring }

export interface Readout {
  readonly element: HTMLElement
  /** A value, a sample or rows, as `controls.watch` takes them; `null` clears it. */
  push(value: unknown): void
  /** The latest value pushed. */
  readonly value: unknown
  dispose(): void
}

/**
 * A readout on its own, outside a panel: `readout(sparkline({ unit: "ms" }))`, put its element
 * anywhere and `push` values to it. It sleeps when nothing arrives, as it does in a panel.
 */
export function readout(
  field: ReadoutField,
  options: UiLook & { readonly doc?: Document; readonly label?: string } = {},
): Readout {
  const doc = options.doc ?? document
  injectUiStyles(doc)
  const state = readoutState(field)
  const label = options.label ?? field.label
  const labelEl = label
    ? Object.assign(doc.createElement("span"), { textContent: label })
    : undefined
  const view = createReadout({ doc, field, state, ...(labelEl ? { label: labelEl } : {}) })
  applyLook(view.element, options)
  return {
    element: view.element,
    push(value) {
      pushReadout(field, state, value)
      view.notify()
    },
    get value() {
      return state.value
    },
    dispose: () => view.dispose(),
  }
}
