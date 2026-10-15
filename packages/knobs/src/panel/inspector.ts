// Inspector rows: vectors, ranges, angles, seeds, key combinations and toolbars. Each is an
// EditorRow (see editors.ts): it owns its DOM, its pointer and arrow keys, and hands the GPU
// overlay the elements and numbers it draws from, so both renderers place things identically.
import { comboFromEvent, comboLabel, heldMods, matchesCombo } from "../core/keys.js"
import {
  same,
  wrapAngle,
  type AngleField,
  type KeybindField,
  type Point,
  type RangeField,
  type SeedField,
  type ToolbarField,
  type ToolbarItem,
  type Value,
  type Vec3,
  type VecField,
} from "../core/schema.js"
import { createHeaderDie, GROUP_DIE } from "./die.js"
import type { EditorRow, RowContext } from "./editors.js"
import type {
  GpuAngleRow,
  GpuCell,
  GpuKeybindRow,
  GpuRangeRow,
  GpuSeedRow,
  GpuToolbarRow,
  GpuVecRow,
} from "./gpu/renderer.js"
import { iconSvg } from "./icons.js"
import { clamp } from "./motion.js"
import { arrowOf, bigOf, keyPrefs } from "./prefs.js"
import { decimals as stepDecimals } from "./slider.js"
import { onPan } from "./swipe.js"

const plainKey = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.isComposing
const reduced = (doc: Document) =>
  doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false

function make(doc: Document) {
  return <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const node = doc.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
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

/** A plain row: its label first (it takes the modified dot), the control on the right. */
function shell(c: RowContext<unknown>, kind: string) {
  const el = make(c.doc)
  const row = el("div", `knobs-row knobs-insp`)
  row.dataset.field = c.key
  row.dataset.kind = kind
  const label = el("span", undefined, c.display)
  row.append(label)
  return { row, label, el }
}

const fmt = (v: number, places: number) => (Object.is(v, -0) ? 0 : v).toFixed(places)

/**
 * The inline editor over a readout: a text field that commits on Enter or blur and cancels on
 * Esc. It sits above the GPU overlay, which stops drawing the readout while it's open.
 */
function inlineEdit(
  doc: Document,
  host: HTMLElement,
  label: string,
  commit: (value: number) => void,
  back: () => HTMLElement,
) {
  const input = doc.createElement("input")
  input.className = "knobs-cell-edit"
  input.type = "text"
  input.inputMode = "decimal"
  input.spellcheck = false
  input.hidden = true
  input.setAttribute("aria-label", label)
  host.append(input)
  let open = false
  const done = (keep: boolean) => {
    if (!open) return
    open = false
    const next = Number(input.value.trim().replace(/[^\d.eE+-]/g, ""))
    input.hidden = true
    host.classList.remove("knobs-editing")
    if (keep && input.value.trim() !== "" && Number.isFinite(next)) commit(next)
    const target = back()
    if (doc.activeElement === input || doc.activeElement === doc.body)
      target.focus({ preventScroll: true })
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      done(event.key === "Enter")
    } else event.stopPropagation()
  })
  input.addEventListener("blur", () => done(true))
  return {
    input,
    get open() {
      return open
    },
    start(text: string, select = true) {
      open = true
      input.value = text
      input.hidden = false
      host.classList.add("knobs-editing")
      input.focus({ preventScroll: true })
      if (select) input.select()
      else input.setSelectionRange(text.length, text.length)
    },
    done,
  }
}

/** Keys that open an inline editor with what was typed. */
const typed = (event: KeyboardEvent) =>
  plainKey(event) && !event.altKey && /^[0-9.\-]$/.test(event.key) ? event.key : undefined

interface ScrubOptions {
  /** Value change per px of travel (before ⌥ and ⇧). */
  perPx(): number
  start(): void
  /** dx in px since the press, with ⌥ (fine) and ⇧ (coarse) as held now. */
  move(dx: number, fine: boolean, coarse: boolean): void
  end(moved: boolean, event: PointerEvent): void
}
/** A horizontal drag: a press that moves 3 px becomes a scrub; one that doesn't is a click. */
function scrub(target: HTMLElement, row: HTMLElement, o: ScrubOptions) {
  let at: number | undefined
  let moved = false
  let base = 0
  let carried = 0
  let fine = false
  target.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.shiftKey || event.metaKey) return
    event.preventDefault()
    target.setPointerCapture(event.pointerId)
    target.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    at = base = event.clientX
    carried = 0
    fine = event.altKey
    moved = false
  })
  target.addEventListener("pointermove", (event) => {
    if (at === undefined) return
    if (!moved && Math.abs(event.clientX - at) < 3) return
    if (!moved) {
      moved = true
      base = event.clientX
      row.classList.add("knobs-active")
      o.start()
    }
    // ⌥ toggling mid-drag keeps the value where it is and changes the rate from there.
    if (event.altKey !== fine) {
      carried += (event.clientX - base) * (fine ? 0.1 : 1)
      base = event.clientX
      fine = event.altKey
    }
    o.move(carried + (event.clientX - base) * (fine ? 0.1 : 1), fine, event.shiftKey)
  })
  const release = (event: PointerEvent) => {
    if (at === undefined) return
    at = undefined
    row.classList.remove("knobs-active")
    o.end(moved, event)
  }
  target.addEventListener("pointerup", release)
  target.addEventListener("pointercancel", release)
  return { scrubbing: () => at !== undefined && moved }
}

/** Px of travel per step: whole ranges span about 200 px, never less than a px a step. */
const rate = (min: number, max: number, step: number) => Math.max(step, (max - min) / 200)
const onGrid = (v: number, min: number, step: number) =>
  Number((min + Math.round((v - min) / step) * step).toPrecision(12))

// ——— vec2 / vec3 ———

type Vec = Point & { readonly z?: number }
const AXES = ["x", "y", "z"] as const

export function vecRow(c: RowContext<VecField>): EditorRow {
  const { row, label, el } = shell(c, "vec")
  const f = () => c.field
  const places = () => f().decimals ?? stepDecimals(f().step)
  const axes = AXES.slice(0, c.field.axes)
  const cells = el("span", "knobs-cells")
  let linked = Boolean(c.field.linked)
  let link: HTMLButtonElement | undefined
  if (c.field.link) {
    link = el("button", "knobs-link")
    link.type = "button"
    link.tabIndex = -1
    const paint = () => {
      link!.replaceChildren(iconSvg(c.doc, linked ? "link" : "unlink"))
      link!.setAttribute("aria-pressed", String(linked))
      link!.setAttribute("aria-label", linked ? "Unlink axes" : "Link axes")
    }
    paint()
    link.onclick = () => {
      linked = !linked
      paint()
      c.wake()
    }
    row.append(link)
  }
  row.append(cells)
  let shown: Vec = c.get() as Vec
  let mixed = false
  const g = gesture(c)
  let base: Vec = shown
  /** `axis` set to `v`; linked, the others scale with it (or shift, from 0). */
  const withAxis = (from: Vec, axis: (typeof AXES)[number], v: number): Vec => {
    const { min, max, step } = f()
    const next = clamp(onGrid(v, min, step), min, max)
    if (!linked) return { ...from, [axis]: next }
    const was = from[axis] ?? 0
    const k = Math.abs(was) > 1e-9 ? next / was : undefined
    const out: Record<string, number> = {}
    for (const a of axes) {
      const own = from[a] ?? 0
      out[a] =
        a === axis
          ? next
          : clamp(
              Number((k !== undefined ? own * k : own + (next - was)).toPrecision(12)),
              min,
              max,
            )
    }
    return out as unknown as Vec
  }
  const gpuCells: GpuCell[] = []
  const reads: HTMLElement[] = []
  const stops: HTMLElement[] = []
  for (const axis of axes) {
    const cell = el("span", "knobs-cell")
    cell.tabIndex = 0
    cell.dataset.axis = axis
    cell.setAttribute("role", "spinbutton")
    cell.setAttribute("aria-label", `${c.display} ${axis}`)
    const letter = el("i", "knobs-cell-axis", axis.toUpperCase())
    letter.setAttribute("aria-hidden", "true")
    const read = el("span", "knobs-cell-read")
    cell.append(letter, read)
    cells.append(cell)
    reads.push(read)
    stops.push(cell)
    const editor = inlineEdit(
      c.doc,
      cell,
      `${c.display} ${axis} value`,
      (v) => {
        g.start()
        g.set(withAxis(c.get() as Vec, axis, v))
      },
      () => cell,
    )
    const drag = scrub(cell, row, {
      perPx: () => rate(f().min, f().max, f().step),
      start() {
        g.start()
        base = c.get() as Vec
      },
      move(dx, _fine, coarse) {
        const by = dx * rate(f().min, f().max, f().step) * (coarse ? 10 : 1)
        g.set(withAxis(base, axis, (base[axis] ?? 0) + by))
      },
      end(moved) {
        if (!moved) editor.start(mixed ? "" : fmt(shown[axis] ?? 0, places()))
        c.wake()
      },
    })
    let panAt: number | undefined
    onPan(cell, {
      accept: () => !drag.scrubbing() && !editor.open,
      move(dx) {
        if (panAt === undefined) {
          g.start()
          base = c.get() as Vec
          panAt = 0
          row.classList.add("knobs-active")
        }
        panAt += dx
        g.set(withAxis(base, axis, (base[axis] ?? 0) + panAt * rate(f().min, f().max, f().step)))
      },
      end() {
        panAt = undefined
        row.classList.remove("knobs-active")
        c.wake()
      },
      step(direction) {
        g.start()
        g.set(withAxis(c.get() as Vec, axis, (shown[axis] ?? 0) + direction * f().step))
      },
    })
    cell.addEventListener("keydown", (event) => {
      if (event.target !== cell || !plainKey(event)) return
      const dir = arrowOf(event)
      const char = typed(event)
      if (dir) {
        event.preventDefault()
        event.stopPropagation()
        const by = f().step * (event.shiftKey ? bigOf(event) : event.altKey ? 0.1 : 1)
        g.start()
        g.set(withAxis(c.get() as Vec, axis, (shown[axis] ?? 0) + dir * by))
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault()
        g.start()
        g.set(withAxis(c.get() as Vec, axis, event.key === "Home" ? f().min : f().max))
      } else if (event.key === "Enter" && keyPrefs(cell).edit) {
        event.preventDefault()
        event.stopPropagation()
        editor.start(mixed ? "" : fmt(shown[axis] ?? 0, places()))
      } else if (char && keyPrefs(cell).edit) {
        event.preventDefault()
        event.stopPropagation()
        editor.start(char, false)
      }
    })
    gpuCells.push({
      el: cell,
      axis: letter,
      read,
      editing: () => editor.open,
      active: () => drag.scrubbing() || panAt !== undefined,
    })
  }
  const paint = () => {
    axes.forEach((axis, i) => {
      const text = mixed ? "—" : fmt(shown[axis] ?? 0, places())
      const unit = f().unit && !mixed ? ` ${f().unit}` : ""
      if (reads[i]!.textContent !== text) reads[i]!.textContent = text
      stops[i]!.setAttribute("aria-valuetext", `${text}${unit}`)
    })
  }
  paint()
  const gpu: GpuVecRow = {
    kind: "vec",
    key: c.key,
    display: c.display,
    row,
    labelEl: label,
    cells: gpuCells,
    ...(link ? { link } : {}),
    linked: () => linked,
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row,
    labelEl: label,
    input: stops[0]!,
    stops: () => stops,
    update(value: Value, _delay: number, _instant?: boolean, isMixed = false) {
      shown = value as Vec
      mixed = isMixed
      paint()
    },
    dispose() {},
    tracks: [],
    gpu: [gpu],
  }
}

// ——— range ———

export function rangeRow(c: RowContext<RangeField>): EditorRow {
  const el = make(c.doc)
  const f = () => c.field
  const places = () => f().decimals ?? stepDecimals(f().step)
  const row = el("div", "knobs-row knobs-range")
  row.dataset.field = c.key
  const track = el("div", "knobs-range-track")
  const fill = el("i", "knobs-range-fill")
  const label = el("span", "knobs-label", c.display)
  const read = el("span", "knobs-range-read")
  const thumbs = (["lo", "hi"] as const).map((end) => {
    const t = el("span", "knobs-range-thumb")
    t.dataset.end = end
    t.tabIndex = 0
    t.setAttribute("role", "slider")
    t.setAttribute("aria-label", `${c.display} ${end === "lo" ? "low" : "high"}`)
    return t
  }) as [HTMLElement, HTMLElement]
  track.append(fill, ...thumbs, label, read)
  row.append(track)
  let shown = c.get() as readonly [number, number]
  let mixed = false
  let dragging = false
  let lastEnd: 0 | 1 = 0
  const g = gesture(c)
  const span = () => f().max - f().min || 1
  const ratio = (v: number) => clamp((v - f().min) / span(), 0, 1)
  const quant = (v: number, fine: boolean) =>
    clamp(onGrid(v, f().min, fine ? f().step / 10 : f().step), f().min, f().max)
  /** Moves one end, which stops at the other (they can't cross). */
  const withEnd = (from: readonly [number, number], end: 0 | 1, v: number, fine = false) => {
    const q = quant(v, fine)
    return end === 0
      ? ([Math.min(q, from[1]), from[1]] as const)
      : ([from[0], Math.max(q, from[0])] as const)
  }
  const text = () => {
    if (mixed) return "—"
    const u = f().unit ? ` ${f().unit}` : ""
    return `${fmt(shown[0], places())}–${fmt(shown[1], places())}${u}`
  }
  const place = (instant: boolean) => {
    const [a, b] = [ratio(shown[0]), ratio(shown[1])]
    const nodes = [fill, ...thumbs]
    if (instant) for (const n of nodes) n.style.transition = "none"
    fill.style.transform = `translateX(${(a * 100).toFixed(4)}%) scaleX(${Math.max(0, b - a).toFixed(5)})`
    thumbs[0].style.left = `${(a * 100).toFixed(4)}%`
    thumbs[1].style.left = `${(b * 100).toFixed(4)}%`
    if (instant) {
      void fill.offsetWidth
      for (const n of nodes) n.style.transition = ""
    }
  }
  const paint = (instant: boolean) => {
    const t = text()
    if (read.textContent !== t) read.textContent = t
    thumbs.forEach((th, i) => {
      th.setAttribute("aria-valuenow", String(shown[i]))
      th.setAttribute("aria-valuemin", String(i === 0 ? f().min : shown[0]))
      th.setAttribute("aria-valuemax", String(i === 0 ? shown[1] : f().max))
    })
    place(instant)
  }
  // Pointer: the nearer thumb follows the pointer; a press well inside the band moves the band.
  let grab: 0 | 1 | 2 = 0
  let startX = 0
  let startValue: readonly [number, number] = shown
  let rect: DOMRect | undefined
  let fine = false
  let fineAt = 0
  let fineValue = 0
  const valueAt = (x: number) => f().min + clamp((x - rect!.left) / rect!.width, 0, 1) * span()
  track.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.shiftKey || event.metaKey) return
    if ((event.target as Element).closest(".knobs-cell-edit,.knobs-accessory")) return
    event.preventDefault()
    track.setPointerCapture(event.pointerId)
    rect = track.getBoundingClientRect()
    const x = event.clientX - rect.left
    const [ax, bx] = [ratio(shown[0]) * rect.width, ratio(shown[1]) * rect.width]
    const inside = x > ax + 8 && x < bx - 8 && bx - ax > 24
    grab = inside ? 2 : Math.abs(x - ax) <= Math.abs(x - bx) && !(x > bx) ? 0 : 1
    if (ax === bx) grab = x < ax ? 0 : 1
    if (grab !== 2) lastEnd = grab
    thumbs[grab === 2 ? lastEnd : grab].focus({
      preventScroll: true,
      focusVisible: false,
    } as FocusOptions)
    startX = event.clientX
    startValue = shown
    fine = event.altKey
    fineAt = event.clientX
    fineValue = grab === 2 ? 0 : shown[grab]
    dragging = true
    row.classList.add("knobs-active")
    g.start()
    if (grab !== 2 && !fine) g.set(withEnd(shown, grab, valueAt(event.clientX)))
    c.wake()
  })
  track.addEventListener("pointermove", (event) => {
    if (!dragging || !rect) return
    if (grab === 2) {
      const width = startValue[1] - startValue[0]
      const by = ((event.clientX - startX) / rect.width) * span() * (event.altKey ? 0.1 : 1)
      const lo = clamp(quant(startValue[0] + by, event.altKey), f().min, f().max - width)
      g.set([lo, Number((lo + width).toPrecision(12))])
      return
    }
    if (event.altKey !== fine) {
      fine = event.altKey
      fineAt = event.clientX
      fineValue = shown[grab]
    }
    const v = fine
      ? fineValue + ((event.clientX - fineAt) / rect.width) * span() * 0.1
      : valueAt(event.clientX)
    g.set(withEnd(c.get() as readonly [number, number], grab, v, fine))
  })
  const release = () => {
    if (!dragging) return
    dragging = false
    rect = undefined
    row.classList.remove("knobs-active")
    c.wake()
  }
  track.addEventListener("pointerup", release)
  track.addEventListener("pointercancel", release)
  let panAt: number | undefined
  onPan(track, {
    accept: () => !dragging,
    move(dx) {
      const w = track.clientWidth
      if (!w) return
      if (panAt === undefined) {
        g.start()
        panAt = shown[lastEnd]
        dragging = true
        row.classList.add("knobs-active")
      }
      panAt = clamp(panAt + (dx / w) * span(), f().min, f().max)
      g.set(withEnd(c.get() as readonly [number, number], lastEnd, panAt))
    },
    end() {
      panAt = undefined
      dragging = false
      row.classList.remove("knobs-active")
      c.wake()
    },
    step(direction) {
      g.start()
      g.set(withEnd(shown, lastEnd, shown[lastEnd] + direction * f().step))
    },
  })
  const editors = thumbs.map((th, i) =>
    inlineEdit(
      c.doc,
      row,
      `${c.display} ${i === 0 ? "low" : "high"} value`,
      (v) => {
        g.start()
        g.set(withEnd(c.get() as readonly [number, number], i as 0 | 1, v))
      },
      () => th,
    ),
  )
  thumbs.forEach((th, i) => {
    const end = i as 0 | 1
    th.addEventListener("focus", () => {
      lastEnd = end
      c.wake()
    })
    th.addEventListener("keydown", (event) => {
      if (!plainKey(event)) return
      const dir = arrowOf(event)
      const char = typed(event)
      if (dir) {
        event.preventDefault()
        event.stopPropagation()
        const by = f().step * (event.shiftKey ? bigOf(event) : event.altKey ? 0.1 : 1)
        g.start()
        g.set(withEnd(shown, end, shown[end] + dir * by, event.altKey))
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault()
        g.start()
        g.set(withEnd(shown, end, event.key === "Home" ? f().min : f().max))
      } else if (event.key === "Enter" && keyPrefs(th).edit) {
        event.preventDefault()
        event.stopPropagation()
        editors[end]!.start(mixed ? "" : fmt(shown[end], places()))
      } else if (char && keyPrefs(th).edit) {
        event.preventDefault()
        event.stopPropagation()
        editors[end]!.start(char, false)
      }
    })
  })
  let first = true
  const gpu: GpuRangeRow = {
    kind: "range",
    key: c.key,
    display: c.display,
    row,
    labelEl: label,
    track,
    read,
    thumbs,
    ratios: () => [ratio(shown[0]), ratio(shown[1])] as const,
    dragging: () => dragging,
    editing: () => editors.some((e) => e.open),
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row,
    labelEl: label,
    input: thumbs[0],
    stops: () => thumbs,
    update(value: Value, delay: number, instant?: boolean, isMixed = false) {
      shown = value as readonly [number, number]
      mixed = isMixed
      row.style.setProperty("--k-delay", `${Math.max(0, delay)}ms`)
      paint(first || Boolean(instant) || dragging)
      first = false
    },
    dispose() {},
    tracks: [],
    gpu: [gpu],
  }
}

// ——— angle ———

export function angleRow(c: RowContext<AngleField>): EditorRow {
  const { row, label, el } = shell(c, "angle")
  const f = () => c.field
  const control = el("span", "knobs-angle")
  control.tabIndex = 0
  control.setAttribute("role", "slider")
  control.setAttribute("aria-label", c.display)
  const read = el("span", "knobs-angle-read")
  const dial = el("span", "knobs-dial")
  const hand = el("i", "knobs-dial-hand")
  dial.append(hand)
  control.append(read, dial)
  row.append(control)
  let value = c.get() as number
  let turn = value
  let mixed = false
  let dragging = false
  const g = gesture(c)
  const places = () => stepDecimals(f().step)
  const snapTo = (v: number, coarse: boolean) => {
    const step = coarse ? Math.max(15, f().step) : f().step
    const q = Number((Math.round(v / step) * step).toPrecision(12))
    return f().wrap ? wrapAngle(q, f().min, f().max) : clamp(q, f().min, f().max)
  }
  const paint = (instant: boolean) => {
    const t = mixed ? "—" : `${fmt(value, places())}°`
    if (read.textContent !== t) read.textContent = t
    control.setAttribute("aria-valuenow", String(value))
    control.setAttribute("aria-valuetext", t)
    if (instant || reduced(c.doc)) hand.style.transition = "none"
    hand.style.rotate = `${turn.toFixed(3)}deg`
    if (instant) {
      void hand.offsetWidth
      hand.style.transition = ""
    }
  }
  /** Follows a value the short way round on a wrapping dial. */
  const follow = (next: number) => {
    let d = next - value
    if (f().wrap) {
      const s = f().max - f().min
      d = ((((d + s / 2) % s) + s) % s) - s / 2
    }
    turn += d
    value = next
  }
  // Scrub the readout sideways (a degree a px); on the dial, the hand follows the pointer round.
  let mode: "scrub" | "dial" = "scrub"
  let startX = 0
  let startValue = 0
  let carried = 0
  let fine = false
  let centre = [0, 0]
  let moved = false
  const angleAt = (x: number, y: number) =>
    (Math.atan2(x - centre[0]!, -(y - centre[1]!)) * 180) / Math.PI
  control.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.shiftKey || event.metaKey) return
    if ((event.target as Element).closest(".knobs-cell-edit")) return
    event.preventDefault()
    control.setPointerCapture(event.pointerId)
    control.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    const r = dial.getBoundingClientRect()
    centre = [r.left + r.width / 2, r.top + r.height / 2]
    mode = (event.target as Element).closest(".knobs-dial") ? "dial" : "scrub"
    startX = event.clientX
    startValue = value
    carried = 0
    fine = event.altKey
    moved = false
    dragging = true
    g.start()
    if (mode === "dial") {
      moved = true
      row.classList.add("knobs-active")
      g.set(snapTo(angleAt(event.clientX, event.clientY), false))
    }
    c.wake()
  })
  control.addEventListener("pointermove", (event) => {
    if (!dragging) return
    if (mode === "dial") {
      const a = angleAt(event.clientX, event.clientY)
      g.set(snapTo(f().wrap ? a : clamp(a, f().min, f().max), event.shiftKey))
      return
    }
    if (!moved && Math.abs(event.clientX - startX) < 3) return
    if (!moved) {
      moved = true
      startX = event.clientX
      row.classList.add("knobs-active")
    }
    if (event.altKey !== fine) {
      carried += (event.clientX - startX) * (fine ? 0.1 : 1)
      startX = event.clientX
      fine = event.altKey
    }
    const dx = carried + (event.clientX - startX) * (fine ? 0.1 : 1)
    g.set(snapTo(startValue + dx * f().step, event.shiftKey))
  })
  const editor = inlineEdit(
    c.doc,
    row,
    `${c.display} value`,
    (v) => {
      g.start()
      g.set(snapTo(v, false))
    },
    () => control,
  )
  const release = () => {
    if (!dragging) return
    dragging = false
    row.classList.remove("knobs-active")
    if (!moved) editor.start(mixed ? "" : fmt(value, places()))
    c.wake()
  }
  control.addEventListener("pointerup", release)
  control.addEventListener("pointercancel", release)
  let panAt: number | undefined
  onPan(control, {
    accept: () => !dragging,
    move(dx) {
      if (panAt === undefined) {
        g.start()
        panAt = value
        row.classList.add("knobs-active")
      }
      panAt += dx * f().step
      g.set(snapTo(f().wrap ? panAt : clamp(panAt, f().min, f().max), false))
    },
    end() {
      panAt = undefined
      row.classList.remove("knobs-active")
      c.wake()
    },
    step(direction) {
      g.start()
      g.set(snapTo(value + direction * f().step, false))
    },
  })
  control.addEventListener("keydown", (event) => {
    if (event.target !== control || !plainKey(event)) return
    const dir = arrowOf(event)
    const char = typed(event)
    if (dir) {
      event.preventDefault()
      event.stopPropagation()
      g.start()
      // ⇧ turns to the next 15° mark, as a ⇧-drag snaps.
      if (event.shiftKey) {
        const s = Math.max(15, f().step)
        const k = dir > 0 ? Math.floor(value / s + 1e-9) + 1 : Math.ceil(value / s - 1e-9) - 1
        g.set(snapTo(k * s, false))
      } else g.set(snapTo(value + dir * f().step * (event.altKey ? 0.1 : 1), false))
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      g.start()
      g.set(snapTo(event.key === "Home" ? f().min : f().max - (f().wrap ? f().step : 0), false))
    } else if (event.key === "Enter" && keyPrefs(control).edit) {
      event.preventDefault()
      event.stopPropagation()
      editor.start(mixed ? "" : fmt(value, places()))
    } else if (char && keyPrefs(control).edit) {
      event.preventDefault()
      event.stopPropagation()
      editor.start(char, false)
    }
  })
  let first = true
  const gpu: GpuAngleRow = {
    kind: "angle",
    key: c.key,
    display: c.display,
    row,
    labelEl: label,
    control,
    read,
    dial,
    turn: () => (mixed ? 0 : turn),
    dragging: () => dragging,
    editing: () => editor.open,
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row,
    labelEl: label,
    input: control,
    stops: () => [control],
    update(next: Value, delay: number, instant?: boolean, isMixed = false) {
      mixed = isMixed
      if (first || instant) {
        value = turn = next as number
      } else follow(next as number)
      row.style.setProperty("--k-delay", `${Math.max(0, delay)}ms`)
      paint(first || Boolean(instant) || dragging)
      first = false
    },
    dispose() {},
    tracks: [],
    gpu: [gpu],
  }
}

// ——— seed ———

export function seedRow(c: RowContext<SeedField>): EditorRow {
  const { row, label, el } = shell(c, "seed")
  const f = () => c.field
  const control = el("span", "knobs-seed")
  control.tabIndex = 0
  control.setAttribute("role", "spinbutton")
  control.setAttribute("aria-label", c.display)
  const read = el("span", "knobs-seed-read")
  control.append(read)
  const roll = el("button", "knobs-seed-roll")
  roll.type = "button"
  roll.tabIndex = -1
  roll.setAttribute("aria-label", `Roll ${c.display}`)
  const die = createHeaderDie(c.doc, () => c.wake(), GROUP_DIE)
  roll.append(die.node)
  row.append(control, roll)
  let value = c.get() as number
  let mixed = false
  const g = gesture(c)
  const set = (v: number) => {
    g.start()
    g.set(Math.round(clamp(v, f().min, f().max)))
  }
  const reroll = () => {
    const { min, max } = f()
    let next = value
    for (let i = 0; i < 8 && next === value; i++)
      next = min + Math.floor(Math.random() * (max - min + 1))
    die.roll()
    set(next)
  }
  roll.onclick = () => reroll()
  const editor = inlineEdit(c.doc, row, `${c.display} value`, set, () => control)
  control.addEventListener("click", () => {
    if (!editor.open) editor.start(mixed ? "" : String(value))
  })
  control.addEventListener("keydown", (event) => {
    if (event.target !== control || !plainKey(event)) return
    const dir = arrowOf(event)
    const char = typed(event)
    if (dir) {
      event.preventDefault()
      event.stopPropagation()
      set(value + dir * bigOf(event))
    } else if (event.key === " ") {
      event.preventDefault()
      event.stopPropagation()
      reroll()
    } else if (event.key === "Enter" && keyPrefs(control).edit) {
      event.preventDefault()
      event.stopPropagation()
      editor.start(mixed ? "" : String(value))
    } else if (char && keyPrefs(control).edit) {
      event.preventDefault()
      event.stopPropagation()
      editor.start(char, false)
    }
  })
  const paint = () => {
    const t = mixed ? "—" : String(value)
    if (read.textContent !== t) read.textContent = t
    control.setAttribute("aria-valuenow", String(value))
  }
  const gpu: GpuSeedRow = {
    kind: "seed",
    key: c.key,
    display: c.display,
    row,
    labelEl: label,
    control,
    read,
    die: { button: roll, die },
    editing: () => editor.open,
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row,
    labelEl: label,
    input: control,
    stops: () => [control],
    update(next: Value, _delay: number, _instant?: boolean, isMixed = false) {
      value = next as number
      mixed = isMixed
      paint()
    },
    dispose: () => die.dispose(),
    tracks: [],
    gpu: [gpu],
  }
}

// ——— keybind ———

export function keybindRow(c: RowContext<KeybindField>): EditorRow {
  const { row, label, el } = shell(c, "keybind")
  const chip = el("button", "knobs-keys")
  chip.type = "button"
  const text = el("span", "knobs-keys-text")
  chip.append(text)
  row.append(chip)
  let value = c.get() as string
  let mixed = false
  let capturing = false
  let preview = ""
  const paint = () => {
    const shown = capturing
      ? preview || "Type keys…"
      : mixed
        ? "—"
        : value
          ? comboLabel(value)
          : "None"
    if (text.textContent !== shown) text.textContent = shown
    chip.toggleAttribute("data-empty", !capturing && !mixed && !value)
    chip.setAttribute("aria-pressed", String(capturing))
    chip.setAttribute(
      "aria-label",
      `${c.display}: ${capturing ? "press a key combination" : value ? comboLabel(value) : "none"}`,
    )
    c.wake()
  }
  const capture = (on: boolean) => {
    if (capturing === on) return
    capturing = on
    preview = ""
    row.classList.toggle("knobs-active", on)
    paint()
  }
  chip.onclick = () => capture(!capturing)
  // While capturing, every key is the combination's (Esc cancels, ⌫ clears); nothing else hears it.
  chip.addEventListener("keydown", (event) => {
    if (event.isComposing) return
    if (!capturing) {
      if ((event.key === "Enter" || event.key === " ") && plainKey(event) && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        capture(true)
      }
      return
    }
    if (event.key === "Tab") return capture(false)
    event.preventDefault()
    event.stopPropagation()
    const mods = heldMods(event)
    if (event.key === "Escape" && !mods.length) return capture(false)
    if ((event.key === "Backspace" || event.key === "Delete") && !mods.length) {
      capture(false)
      c.set("")
      return
    }
    const combo = comboFromEvent(event)
    if (!combo) {
      preview = mods.length ? comboLabel(`${mods.join("+")}+…`) : ""
      paint()
      return
    }
    capture(false)
    c.set(combo)
  })
  chip.addEventListener("keyup", (event) => {
    if (!capturing) return
    const mods = heldMods(event)
    preview = mods.length ? comboLabel(`${mods.join("+")}+…`) : ""
    paint()
  })
  chip.addEventListener("blur", () => capture(false))
  paint()
  const gpu: GpuKeybindRow = {
    kind: "keybind",
    key: c.key,
    display: c.display,
    row,
    labelEl: label,
    chip,
    text,
    capturing: () => capturing,
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row,
    labelEl: label,
    input: chip,
    stops: () => [chip],
    update(next: Value, _delay: number, _instant?: boolean, isMixed = false) {
      value = next as string
      mixed = isMixed
      paint()
    },
    dispose() {},
    tracks: [],
    gpu: [gpu],
  }
}

// ——— toolbar ———

export interface ToolbarRow extends EditorRow {
  readonly field: ToolbarField
  /** The item a keydown presses, if any (`global` says whether it's a page-wide shortcut). */
  match(event: KeyboardEvent, global: boolean): ToolbarItem | undefined
  press(item: ToolbarItem): void
  swap(field: ToolbarField): void
}

export function toolbarRow(
  c: RowContext<ToolbarField>,
  press: (item: ToolbarItem) => void,
): ToolbarRow {
  const el = make(c.doc)
  const row = el("div", "knobs-row knobs-toolbar")
  row.dataset.field = c.key
  row.setAttribute("role", "toolbar")
  row.setAttribute("aria-label", c.display)
  let field = c.field
  let buttons: HTMLButtonElement[] = []
  let last = 0
  const gpu: GpuToolbarRow = {
    kind: "toolbar",
    key: c.key,
    display: c.display,
    row,
    items: [],
    wave: c.wave,
    isModified: () => false,
  }
  const build = () => {
    const items: GpuToolbarRow["items"][number][] = []
    buttons = field.items.map((item, i) => {
      const b = el("button", "knobs-tool")
      b.type = "button"
      b.tabIndex = -1
      b.disabled = Boolean(item.disabled)
      b.dataset.item = item.id ?? item.label
      let iconEl: Element | undefined
      if (item.icon) {
        iconEl = iconSvg(c.doc, item.icon)
        b.append(iconEl)
      }
      const name = el("span", "knobs-tool-label", item.label)
      b.append(name)
      let chip: HTMLElement | undefined
      if (item.shortcut) {
        chip = el("kbd", "knobs-tool-key", comboLabel(item.shortcut))
        b.append(chip)
        b.setAttribute("aria-keyshortcuts", item.shortcut)
      }
      b.onclick = () => {
        last = i
        press(item)
      }
      b.addEventListener("focus", () => (last = i))
      items.push({
        button: b,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(iconEl ? { iconEl } : {}),
        label: name,
        ...(chip ? { chip } : {}),
      })
      return b
    })
    row.replaceChildren(...buttons)
    ;(gpu as { items: GpuToolbarRow["items"] }).items = items
  }
  build()
  // ←/→ move along the buttons; Enter and Space press them (as buttons do).
  row.addEventListener("keydown", (event) => {
    const at = buttons.indexOf(event.target as HTMLButtonElement)
    const dir = arrowOf(event)
    if (at < 0 || !dir || !plainKey(event)) return
    event.preventDefault()
    event.stopPropagation()
    const live = buttons.filter((b) => !b.disabled)
    const i = live.indexOf(buttons[at]!)
    live[(i + dir + live.length) % live.length]?.focus()
  })
  const first = () => buttons.find((b) => !b.disabled) ?? buttons[0]!
  return {
    row,
    labelEl: row,
    get input() {
      const b = buttons[last]
      return b && !b.disabled ? b : first()
    },
    get field() {
      return field
    },
    stops() {
      const b = buttons[last]
      return [b && !b.disabled ? b : first()]
    },
    update() {},
    match(event, global) {
      return field.items.find(
        (item) =>
          item.shortcut &&
          !item.disabled &&
          Boolean(item.global) === global &&
          matchesCombo(item.shortcut, event),
      )
    },
    press(item) {
      const i = field.items.indexOf(item)
      const b = buttons[i]
      if (b && !reduced(c.doc)) {
        b.classList.add("knobs-pressed")
        setTimeout(() => b.classList.remove("knobs-pressed"), 140)
        c.wake()
      }
      press(item)
    },
    swap(next) {
      field = next
      build()
      c.wake()
    },
    dispose() {},
    tracks: [],
    gpu: [gpu],
  }
}

/** The value a vector shows, as `{ x, y }` or `{ x, y, z }`. */
export type { Vec, Vec3 }
