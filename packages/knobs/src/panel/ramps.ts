// Ramp rows: a gradient (stops on a strip, the selected one's colour in the colour editor's
// strips) and a curve (points on a graph with a grid). Each is an EditorRow (see editors.ts): it
// owns its DOM, pointer and keys, and hands the GPU overlay the numbers it draws from, so both
// renderers place things identically. Strips and curves are drawn from a fixed number of samples,
// so a preset morphs them sample by sample (the DOM's transitions, the GPU's morph spring).
import { fitColor, formatColor, oklchToRgb, parseColor } from "../core/color.js"
import {
  curveSamples,
  CURVE_SHAPES,
  GRADIENT_SAMPLES,
  gradientSamples,
  inRange,
  sameRamp,
  sampleCurve,
  stopColorAt,
  type CurvePoint,
  type GradientStop,
} from "../core/ramp.js"
import type { CurveField, GradientField } from "../core/schema.js"
import {
  colorStrips,
  expander,
  factory,
  gesture,
  measure,
  place,
  plainKey,
  rgbCss,
  setPath,
  visible,
  type EditorRow,
  type RowContext,
} from "./editors.js"
import type { GpuCurveRow, GpuGradientRow, GpuRampHandle } from "./gpu/renderer.js"
import { clamp } from "./motion.js"
import { arrowOf, bigOf } from "./prefs.js"

/** The custom properties a gradient strip's samples ride on (registered, so they transition). */
export const GRADIENT_VARS = Array.from({ length: GRADIENT_SAMPLES }, (_, i) => `--kgrad-${i}`)
/** How far past its strip or graph a dragged handle comes off (and goes when let go). */
const LEAVE = 28
const locked = (row: HTMLElement) => row.closest("[data-disabled],[data-readonly]") !== null
const hinting = (row: HTMLElement) => row.closest(".knobs-hinting") !== null
const quiet = { preventScroll: true, focusVisible: false } as FocusOptions

/** A new handle fades and grows in (`data-born`), unless it arrived with the row. */
function born(node: HTMLElement) {
  node.dataset.born = ""
  node.addEventListener("animationend", () => delete node.dataset.born, { once: true })
  setTimeout(() => delete node.dataset.born, 400)
}

/** Keeps `list` at `n` nodes made by `make`, appended to `parent`; new ones are born unless `quietly`. */
function sync(
  list: HTMLElement[],
  n: number,
  parent: Element,
  make: () => HTMLElement,
  quietly: boolean,
) {
  while (list.length < n) {
    const node = make()
    if (!quietly) born(node)
    parent.append(node)
    list.push(node)
  }
  while (list.length > n) list.pop()!.remove()
}

/** Named presets as chips in a radiogroup (the easing editor's look); ←/→ cycle them. */
function presetChips(
  c: RowContext<unknown>,
  names: readonly string[],
  choose: (i: number) => void,
) {
  const { el } = factory(c.doc)
  const chips = el("div", "knobs-ease-chips knobs-ramp-chips")
  chips.tabIndex = 0
  chips.setAttribute("role", "radiogroup")
  chips.setAttribute("aria-label", `${c.display} presets`)
  const buttons = names.map((n, i) => {
    const b = el("button", "knobs-ease-chip", n)
    b.type = "button"
    b.tabIndex = -1
    b.setAttribute("role", "radio")
    b.onclick = () => {
      choose(i)
      chips.focus(quiet)
    }
    return b
  })
  chips.append(...buttons)
  const cycle = (dir: number) => {
    if (!names.length) return
    const i = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true")
    choose(i < 0 ? (dir > 0 ? 0 : names.length - 1) : (i + dir + names.length) % names.length)
  }
  return {
    el: chips,
    buttons,
    cycle,
    check(i: number) {
      for (const [j, b] of buttons.entries()) b.setAttribute("aria-checked", String(i === j))
    },
  }
}

/** ←/→ on `target` itself cycle the presets (a row's head, the chips). */
function cycleKeys(
  targets: readonly HTMLElement[],
  row: HTMLElement,
  cycle: (dir: number) => void,
) {
  for (const target of targets)
    target.addEventListener("keydown", (event) => {
      const dir = arrowOf(event)
      if (!dir || event.target !== target || !plainKey(event) || event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      if (!locked(row)) cycle(dir)
    })
}

const stopRgb = (s: GradientStop) =>
  oklchToRgb(parseColor(s.color) ?? { l: 0, c: 0, h: 0 }) as [number, number, number]

/**
 * A gradient: a swatch strip with stop ticks in the head; a wide strip with a handle per stop, the
 * selected stop's colour strips and any presets in the body.
 */
export function gradientRow(c: RowContext<GradientField>): EditorRow {
  const { el } = factory(c.doc)
  const f = c.field
  const read = el("span", "knobs-x-read")
  const mini = el("span", "knobs-grad-mini")
  const strip = el("div", "knobs-grad")
  strip.tabIndex = 0
  strip.setAttribute("role", "slider")
  strip.setAttribute("aria-roledescription", "gradient")
  strip.setAttribute("aria-label", `${c.display} stops`)
  strip.setAttribute("aria-valuemin", "0")
  strip.setAttribute("aria-valuemax", "100")
  let shown: readonly GradientStop[] = f.value
  let rgbs = shown.map(stopRgb)
  let selected = 0
  let samples: number[] = []
  const handles: HTMLElement[] = []
  const ticks: HTMLElement[] = []
  let dragging = false
  let leaving = false
  let initialized = false
  const g = gesture(c)
  const withColor = (i: number, color: string) =>
    shown.map((s, j) => (j === i ? { at: s.at, color } : s))
  const editor = colorStrips(c, {
    aria: `${c.display} stop`,
    start: g.start,
    commit: (color) => g.set(withColor(selected, formatColor(fitColor(color)))),
  })
  const names = Object.keys(f.presets ?? {})
  const chips = names.length
    ? presetChips(c, names, (i) => c.set(f.presets![names[i]!]!))
    : undefined
  const x = expander(c, [read, mini], [strip, editor.body, ...(chips ? [chips.el] : [])])
  const size = measure(strip, () => layout(true))
  const miniSize = measure(mini, () => layout(true))
  const inset = () => size.h / 2
  const xOf = (t: number) => inset() + (size.w - inset() * 2) * t
  const tOf = (clientX: number, r: DOMRect) =>
    clamp((clientX - r.left - r.height / 2) / Math.max(1, r.width - r.height), 0, 1)
  const held = () => dragging || editor.dragging()

  const layout = (instant: boolean) => {
    sync(handles, shown.length, strip, () => el("i", "knobs-grad-stop"), instant || !initialized)
    sync(ticks, shown.length, mini, () => el("i"), instant || !initialized)
    place([...handles, ...ticks], instant, () => {
      for (const [i, s] of shown.entries()) {
        const h = handles[i]!
        if (size.w) h.style.left = `${xOf(s.at)}px`
        h.style.backgroundColor = rgbCss(rgbs[i]!)
        h.toggleAttribute("data-selected", i === selected)
        h.toggleAttribute("data-leaving", leaving && i === selected)
        ticks[i]!.style.left = `${s.at * 100}%`
      }
    })
  }
  const paint = (instant: boolean) => {
    samples = gradientSamples(shown, f.space)
    place([strip, mini], instant, () => {
      for (let i = 0; i < GRADIENT_SAMPLES; i++) {
        const v = rgbCss(samples.slice(i * 3, i * 3 + 3))
        strip.style.setProperty(GRADIENT_VARS[i]!, v)
        mini.style.setProperty(GRADIENT_VARS[i]!, v)
      }
    })
  }
  const describe = () => {
    const s = shown[selected]
    if (!s) return
    strip.setAttribute("aria-valuenow", String(Math.round(s.at * 100)))
    strip.setAttribute(
      "aria-valuetext",
      `Stop ${selected + 1} of ${shown.length} at ${Math.round(s.at * 100)}%`,
    )
  }
  /** Shows the selected stop's colour in the strips (a new selection starts their chroma afresh). */
  const showColor = (fresh: boolean, mixed = false) => {
    const s = shown[selected]
    if (s) editor.show(parseColor(s.color)!, mixed, fresh)
  }
  const select = (i: number) => {
    const next = clamp(i, 0, shown.length - 1)
    if (next === selected) return
    selected = next
    layout(false)
    showColor(true)
    describe()
    c.wake()
  }
  /** Moves the selected stop to `t`: it may pass its neighbours, and stays selected. */
  const moveTo = (t: number) => {
    const moved = shown[selected]!
    const rest = shown.filter((_, i) => i !== selected)
    const at = clamp(Math.round(t * 1e4) / 1e4, 0, 1)
    let i = 0
    while (i < rest.length && rest[i]!.at <= at) i++
    rest.splice(i, 0, { at, color: moved.color })
    selected = i
    g.set(rest)
  }
  /** Adds a stop at `t` in the colour the gradient has there, and selects it. */
  const addAt = (t: number) => {
    const color = stopColorAt(shown, f.space, t)
    let i = 0
    while (i < shown.length && shown[i]!.at <= t) i++
    selected = i
    g.set([...shown.slice(0, i), { at: Math.round(t * 1e4) / 1e4, color }, ...shown.slice(i)])
    showColor(true)
  }
  const remove = (i: number) => {
    if (shown.length <= 2) return
    selected = Math.min(i, shown.length - 2)
    g.set(shown.filter((_, j) => j !== i))
    showColor(true)
  }

  let dragRect: DOMRect | undefined
  let grab = 0
  strip.onpointerdown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    strip.setPointerCapture(event.pointerId)
    strip.focus(quiet)
    const r = (dragRect = strip.getBoundingClientRect())
    const px = event.clientX - r.left
    let hit = -1
    let best = Infinity
    for (const [i, s] of shown.entries()) {
      const d = Math.abs(xOf(s.at) - px)
      // Among stacked stops, the selected one first.
      if (d < best || (d === best && i === selected)) {
        best = d
        hit = i
      }
    }
    g.start()
    if (best <= r.height / 2) {
      grab = px - xOf(shown[hit]!.at)
      if (hit !== selected) select(hit)
    } else {
      grab = 0
      addAt(tOf(event.clientX, r))
    }
    dragging = true
    strip.classList.add("knobs-active")
    c.wake()
  }
  strip.onpointermove = (event) => {
    if (!dragging || !dragRect) return
    const r = dragRect
    const off =
      shown.length > 2 && Math.abs(event.clientY - (r.top + r.height / 2)) > r.height / 2 + LEAVE
    if (off !== leaving) {
      leaving = off
      layout(true)
      c.wake()
    }
    moveTo(tOf(event.clientX - grab, r))
  }
  const release = () => {
    if (!dragging) return
    dragging = false
    dragRect = undefined
    strip.classList.remove("knobs-active")
    if (leaving) {
      leaving = false
      remove(selected)
    }
    layout(true)
    c.wake()
  }
  strip.onpointerup = release
  strip.onpointercancel = release
  strip.addEventListener("keydown", (event) => {
    // Hint mode takes every key (Backspace and Enter too) until it ends.
    if (!plainKey(event) || hinting(x.row)) return
    const k = event.key
    const edit = (fn: () => void) => {
      event.preventDefault()
      event.stopPropagation()
      if (locked(x.row)) return
      g.start()
      fn()
    }
    const dir = arrowOf(event)
    if (dir) return edit(() => moveTo(shown[selected]!.at + dir * 0.01 * bigOf(event)))
    if (k === "Home" || k === "End") return edit(() => moveTo(k === "Home" ? 0 : 1))
    if (k === "Backspace" || k === "Delete") return edit(() => remove(selected))
    if (k === "Tab" && !event.altKey) {
      const next = selected + (event.shiftKey ? -1 : 1)
      // Past the last stop (or the first), Tab moves on as ever.
      if (next < 0 || next >= shown.length) return
      event.preventDefault()
      event.stopPropagation()
      return select(next)
    }
    if (event.altKey || event.shiftKey) return
    if (k === "[" || k === "]") {
      event.preventDefault()
      event.stopPropagation()
      return select((selected + (k === "]" ? 1 : -1) + shown.length) % shown.length)
    }
    if (k === "Enter" || k === " ") {
      event.preventDefault()
      event.stopPropagation()
      return editor.strips[0]!.track.focus()
    }
    if (k === "n") {
      const s = shown[selected]!
      const other = shown[selected + 1] ?? shown[selected - 1]!
      return edit(() => addAt((s.at + other.at) / 2))
    }
  })
  // Esc in the colour strips hands focus back to the stops.
  editor.body.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || hinting(x.row)) return
    event.preventDefault()
    event.stopPropagation()
    strip.focus()
  })
  if (chips) cycleKeys([x.head, chips.el], x.row, chips.cycle)

  const gpu: GpuGradientRow = {
    kind: "gradient",
    key: c.key,
    display: c.display,
    row: x.row,
    x: x.gpu,
    read,
    mini,
    ticks: () => ticks.map((node, i) => ({ el: node, x: (shown[i]?.at ?? 0) * miniSize.w })),
    samples: () => samples,
    strip,
    inset,
    handles: (): GpuRampHandle[] =>
      size.w
        ? shown.map((s, i) => ({
            el: handles[i]!,
            x: xOf(s.at),
            y: size.h / 2,
            rgb: rgbs[i],
            selected: i === selected,
            leaving: leaving && i === selected,
          }))
        : [],
    strips: editor.strips.map((s) => s.gpu),
    color: editor.color,
    chips: chips?.buttons ?? [],
    snap: held,
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row: x.row,
    labelEl: x.label,
    input: x.head,
    stops: () =>
      [
        x.head,
        ...(x.isOpen()
          ? [strip, ...editor.strips.map((s) => s.track), ...(chips ? [chips.el] : [])]
          : []),
      ].filter(visible),
    tracks: [],
    gpu: [gpu],
    update(value, _delay, instant = false, mixed = false) {
      const prev = shown
      shown = value as readonly GradientStop[]
      rgbs = shown.map(stopRgb)
      if (selected >= shown.length) selected = shown.length - 1
      read.textContent = mixed ? "—" : ""
      const still = !initialized || instant || held()
      if (!initialized || !sameRamp(prev, shown) || !samples.length) paint(still)
      layout(still)
      initialized = true
      showColor(false, mixed)
      describe()
      chips?.check(mixed ? -1 : names.findIndex((n) => sameRamp(f.presets![n]!, shown)))
    },
    dispose() {
      size.disconnect()
      miniSize.disconnect()
      editor.dispose()
    },
  }
}

const GRAPH_PAD = 8
const MINI_W = 36
/** Grid cells: ⇧ snaps to their corners. */
const GRID = { x: 8, y: 4 }

/**
 * A curve: its name (when it's a preset) and a mini curve in the head; a graph with a grid,
 * draggable points and a hover crosshair, and shape chips, in the body.
 */
export function curveRow(c: RowContext<CurveField>): EditorRow {
  const { el, svg } = factory(c.doc)
  const f = c.field
  const [lo, hi] = f.range
  const span = hi - lo
  const read = el("span", "knobs-x-read")
  const mini = svg("svg", "knobs-curve-mini")
  mini.setAttribute("aria-hidden", "true")
  const miniPath = svg("path", "knobs-curve")
  mini.append(miniPath)
  const graph = el("div", "knobs-graph")
  graph.tabIndex = 0
  graph.setAttribute("role", "slider")
  graph.setAttribute("aria-roledescription", "curve")
  graph.setAttribute("aria-label", `${c.display} points`)
  const plot = svg("svg")
  plot.setAttribute("aria-hidden", "true")
  const grid = svg("path", "knobs-guide")
  const path = svg("path", "knobs-curve")
  plot.append(grid, path)
  const vLine = el("i", "knobs-graph-v")
  const hLine = el("i", "knobs-graph-h")
  const dot = el("i", "knobs-graph-dot")
  const hoverRead = el("span", "knobs-graph-read")
  graph.append(plot, vLine, hLine, dot, hoverRead)
  const presets: [string, readonly CurvePoint[]][] = [
    ...(f.shapes
      ? Object.entries(CURVE_SHAPES).map(
          ([n, s]) => [n, inRange(s, f.range)] as [string, CurvePoint[]],
        )
      : []),
    ...Object.entries(f.presets ?? {}),
  ]
  const chips = presets.length
    ? presetChips(
        c,
        presets.map(([n]) => n),
        (i) => c.set(presets[i]![1]),
      )
    : undefined
  const x = expander(c, [read, mini], [graph, ...(chips ? [chips.el] : [])])
  let shown: readonly CurvePoint[] = f.value
  let selected = 0
  const handles: HTMLElement[] = []
  let dragging = false
  let leaving = false
  let initialized = false
  let hoverX: number | null = null
  const g = gesture(c)
  const size = measure(graph, () => layout(true))
  const miniSize = measure(mini, () => layout(true))
  const map = (px: number, py: number): [number, number] => [
    GRAPH_PAD + px * (size.w - GRAPH_PAD * 2),
    GRAPH_PAD + (1 - (py - lo) / span) * (size.h - GRAPH_PAD * 2),
  ]
  const unmap = (lx: number, ly: number): [number, number] => [
    clamp((lx - GRAPH_PAD) / Math.max(1, size.w - GRAPH_PAD * 2), 0, 1),
    clamp(lo + (1 - (ly - GRAPH_PAD) / Math.max(1, size.h - GRAPH_PAD * 2)) * span, lo, hi),
  ]
  let cached = curveSamples(shown, f.interp)
  const samples = () => cached
  const curvePoints = () => {
    if (!size.w) return []
    const s = samples()
    const out: number[] = []
    for (let i = 0; i < s.length; i += 2) out.push(...map(s[i]!, s[i + 1]!))
    return out
  }
  const miniPoints = () => {
    if (!miniSize.h) return []
    const s = samples()
    const out: number[] = []
    const h = miniSize.h
    for (let i = 0; i < s.length; i += 2)
      out.push(1.5 + s[i]! * (MINI_W - 3), 1.5 + (1 - (s[i + 1]! - lo) / span) * (h - 3))
    return out
  }
  const gridLines = () => {
    if (!size.w) return []
    const out: number[] = []
    const [x0, y0] = [GRAPH_PAD, GRAPH_PAD]
    const [x1, y1] = [size.w - GRAPH_PAD, size.h - GRAPH_PAD]
    // On half pixels, so the hairlines land crisp.
    const half = (v: number) => Math.round(v - 0.5) + 0.5
    for (let i = 0; i <= GRID.x; i++) {
      const gx = half(x0 + ((x1 - x0) * i) / GRID.x)
      out.push(gx, y0, gx, y1)
    }
    for (let j = 0; j <= GRID.y; j++) {
      const gy = half(y0 + ((y1 - y0) * j) / GRID.y)
      out.push(x0, gy, x1, gy)
    }
    return out
  }
  const yDigits = span <= 1 ? 3 : span <= 10 ? 2 : span <= 100 ? 1 : 0
  const fmt = (px: number, py: number) => `${px.toFixed(2)} → ${py.toFixed(yDigits)}`
  /** Where the crosshair sits: the dragged point, or the curve under the pointer. */
  const crosshair = (): [number, number] | null => {
    if (dragging && shown[selected]) return [shown[selected]!.x, shown[selected]!.y]
    if (hoverX === null) return null
    return [hoverX, sampleCurve(shown, hoverX, f)]
  }
  const drawHover = () => {
    const at = size.w ? crosshair() : null
    graph.toggleAttribute("data-hover", Boolean(at))
    if (!at) return
    const [px, py] = map(at[0], at[1])
    vLine.style.translate = `${px}px 0`
    hLine.style.translate = `0 ${py}px`
    dot.style.translate = `${px}px ${py}px`
    hoverRead.textContent = fmt(at[0], at[1])
  }
  const layout = (instant: boolean) => {
    if (size.w) {
      plot.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`)
      const lines = gridLines()
      let d = ""
      for (let i = 0; i < lines.length; i += 4)
        d += `M${lines[i]} ${lines[i + 1]}L${lines[i + 2]} ${lines[i + 3]}`
      grid.setAttribute("d", d)
    }
    if (miniSize.h) mini.setAttribute("viewBox", `0 0 ${MINI_W} ${miniSize.h}`)
    sync(handles, shown.length, graph, () => el("i", "knobs-graph-pt"), instant || !initialized)
    // Points sit under the crosshair's readout.
    graph.append(hoverRead)
    place([path, miniPath, ...handles], instant, () => {
      if (size.w) setPath(path, curvePoints())
      if (miniSize.h) setPath(miniPath, miniPoints())
      for (const [i, p] of shown.entries()) {
        const h = handles[i]!
        if (size.w) {
          const [px, py] = map(p.x, p.y)
          h.style.translate = `${px}px ${py}px`
        }
        h.toggleAttribute("data-selected", i === selected)
        h.toggleAttribute("data-leaving", leaving && i === selected)
      }
    })
    drawHover()
  }
  const describe = () => {
    const p = shown[selected]
    if (!p) return
    graph.setAttribute(
      "aria-valuetext",
      `Point ${selected + 1} of ${shown.length}: ${fmt(p.x, p.y).replace("→", "to")}`,
    )
  }
  const select = (i: number) => {
    const next = clamp(i, 0, shown.length - 1)
    if (next === selected) return
    selected = next
    layout(false)
    describe()
    c.wake()
  }
  const ends = (i: number) => i === 0 || i === shown.length - 1
  /** Moves the selected point; the ends keep their x, and the rest stay between their neighbours. */
  const moveTo = (px: number, py: number) => {
    const i = selected
    const nx = ends(i) ? shown[i]!.x : clamp(px, shown[i - 1]!.x + 0.001, shown[i + 1]!.x - 0.001)
    g.set(shown.map((p, j) => (j === i ? { x: nx, y: clamp(py, lo, hi) } : p)))
  }
  const addAt = (px: number, py: number) => {
    let i = 1
    while (i < shown.length - 1 && shown[i]!.x <= px) i++
    const lx = shown[i - 1]!.x
    const rx = shown[i]!.x
    if (rx - lx < 0.004) return
    selected = i
    g.set([
      ...shown.slice(0, i),
      { x: clamp(px, lx + 0.001, rx - 0.001), y: clamp(py, lo, hi) },
      ...shown.slice(i),
    ])
  }
  const remove = (i: number) => {
    if (shown.length <= 2 || ends(i)) return
    selected = Math.min(i, shown.length - 2)
    g.set(shown.filter((_, j) => j !== i))
  }
  const snapTo = (px: number, py: number): [number, number] => [
    Math.round(px * GRID.x) / GRID.x,
    lo + (Math.round(((py - lo) / span) * GRID.y) / GRID.y) * span,
  ]

  let dragRect: DOMRect | undefined
  let grab: [number, number] = [0, 0]
  const local = (event: MouseEvent, r: DOMRect): [number, number] => [
    event.clientX - r.left,
    event.clientY - r.top,
  ]
  const hitPoint = (lx: number, ly: number) => {
    let hit = -1
    let best = 10
    for (const [i, p] of shown.entries()) {
      const [px, py] = map(p.x, p.y)
      const d = Math.hypot(px - lx, py - ly)
      if (d <= best) {
        best = d
        hit = i
      }
    }
    return hit
  }
  graph.onpointerdown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    graph.focus(quiet)
    const r = (dragRect = graph.getBoundingClientRect())
    const [lx, ly] = local(event, r)
    let hit = hitPoint(lx, ly)
    g.start()
    if (hit < 0) {
      // On the curve, a press adds a point there and picks it up.
      const [px] = unmap(lx, ly)
      const cy = map(px, sampleCurve(shown, px, f))[1]
      if (Math.abs(cy - ly) > 8) return
      const before = shown.length
      addAt(px, sampleCurve(shown, px, f))
      if (shown.length === before) return
      hit = selected
    }
    graph.setPointerCapture(event.pointerId)
    const [px, py] = map(shown[hit]!.x, shown[hit]!.y)
    grab = [lx - px, ly - py]
    select(hit)
    dragging = true
    graph.classList.add("knobs-active")
    drawHover()
    c.wake()
  }
  graph.onpointermove = (event) => {
    if (!dragging || !dragRect) {
      if (!size.w || event.buttons) return
      const r = graph.getBoundingClientRect()
      hoverX = unmap(event.clientX - r.left, 0)[0]
      drawHover()
      c.wake()
      return
    }
    const r = dragRect
    const [lx, ly] = local(event, r)
    const off =
      !ends(selected) &&
      shown.length > 2 &&
      (lx < -LEAVE || ly < -LEAVE || lx > r.width + LEAVE || ly > r.height + LEAVE)
    if (off !== leaving) {
      leaving = off
      layout(true)
      c.wake()
    }
    let [px, py] = unmap(lx - grab[0], ly - grab[1])
    if (event.shiftKey) [px, py] = snapTo(px, py)
    moveTo(px, py)
  }
  graph.onpointerleave = () => {
    if (hoverX === null) return
    hoverX = null
    drawHover()
    c.wake()
  }
  const release = () => {
    if (!dragging) return
    dragging = false
    dragRect = undefined
    graph.classList.remove("knobs-active")
    if (leaving) {
      leaving = false
      remove(selected)
    }
    layout(true)
    c.wake()
  }
  graph.onpointerup = (event) => {
    release()
    // The crosshair picks up where the pointer was let go.
    const r = graph.getBoundingClientRect()
    if (
      event.clientX >= r.left &&
      event.clientX <= r.right &&
      event.clientY >= r.top &&
      event.clientY <= r.bottom
    ) {
      hoverX = unmap(event.clientX - r.left, 0)[0]
      drawHover()
    }
  }
  graph.onpointercancel = release
  // A double-click on empty space adds a point there (⇧ on the grid).
  graph.ondblclick = (event) => {
    const r = graph.getBoundingClientRect()
    const [lx, ly] = local(event, r)
    if (hitPoint(lx, ly) >= 0 || locked(x.row)) return
    let [px, py] = unmap(lx, ly)
    if (event.shiftKey) [px, py] = snapTo(px, py)
    g.start()
    addAt(px, py)
  }
  graph.addEventListener("keydown", (event) => {
    if (!plainKey(event) || hinting(x.row)) return
    const k = event.key
    const edit = (fn: () => void) => {
      event.preventDefault()
      event.stopPropagation()
      if (locked(x.row)) return
      g.start()
      fn()
    }
    const p = shown[selected]!
    const dx = arrowOf(event)
    const dy = k === "ArrowUp" ? 1 : k === "ArrowDown" ? -1 : 0
    // Arrows move about 1% of the graph (⇧ ten times that, ⌥ a tenth); j and k still leave.
    const unit = event.altKey ? 0.001 : 0.01 * bigOf(event)
    if (dx) return edit(() => moveTo(p.x + dx * unit, p.y))
    if (dy) {
      // Read-only, ↑ and ↓ move between rows as elsewhere.
      if (locked(x.row)) return
      return edit(() => moveTo(p.x, p.y + dy * unit * span))
    }
    if (k === "Backspace" || k === "Delete") return edit(() => remove(selected))
    if (k === "Tab" && !event.altKey) {
      const next = selected + (event.shiftKey ? -1 : 1)
      if (next < 0 || next >= shown.length) return
      event.preventDefault()
      event.stopPropagation()
      return select(next)
    }
    if (event.altKey || event.shiftKey) return
    if (k === "[" || k === "]") {
      event.preventDefault()
      event.stopPropagation()
      return select((selected + (k === "]" ? 1 : -1) + shown.length) % shown.length)
    }
    if (k === "n") {
      const next = shown[selected + 1] ? selected : selected - 1
      const a = shown[next]!
      const b = shown[next + 1]!
      const mx = (a.x + b.x) / 2
      return edit(() => addAt(mx, sampleCurve(shown, mx, f)))
    }
  })
  if (chips) cycleKeys([x.head, chips.el], x.row, chips.cycle)

  const gpu: GpuCurveRow = {
    kind: "curve",
    key: c.key,
    display: c.display,
    row: x.row,
    x: x.gpu,
    read,
    mini,
    miniCurve: miniPoints,
    graph,
    grid: gridLines,
    curve: curvePoints,
    handles: (): GpuRampHandle[] =>
      size.w
        ? shown.map((p, i) => {
            const [px, py] = map(p.x, p.y)
            return {
              el: handles[i]!,
              x: px,
              y: py,
              selected: i === selected,
              leaving: leaving && i === selected,
            }
          })
        : [],
    hover() {
      const at = size.w ? crosshair() : null
      if (!at) return null
      const [px, py] = map(at[0], at[1])
      return { x: px, y: py, read: hoverRead }
    },
    chips: chips?.buttons ?? [],
    snap: () => dragging,
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row: x.row,
    labelEl: x.label,
    input: x.head,
    stops: () =>
      [x.head, ...(x.isOpen() ? [graph, ...(chips ? [chips.el] : [])] : [])].filter(visible),
    tracks: [],
    gpu: [gpu],
    update(value, _delay, instant = false, mixed = false) {
      shown = value as readonly CurvePoint[]
      cached = curveSamples(shown, f.interp)
      if (selected >= shown.length) selected = shown.length - 1
      const match = presets.findIndex(([, p]) => sameRamp(p, shown))
      read.textContent = mixed ? "—" : (presets[match]?.[0] ?? "")
      chips?.check(mixed ? -1 : match)
      layout(!initialized || instant || dragging)
      initialized = true
      describe()
    },
    dispose() {
      size.disconnect()
      miniSize.disconnect()
    },
  }
}
