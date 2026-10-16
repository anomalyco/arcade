// Inspector rows: vectors, ranges, angles, seeds, key combinations and toolbars. Each is an
// EditorRow (see editors.ts): it owns its DOM, its pointer and arrow keys, and hands the GPU
// overlay the elements and numbers it draws from, so both renderers place things identically.
import { comboFromEvent, comboLabel, heldMods, matchesCombo } from "../core/keys.js"
import {
  same,
  toolbarShortcut,
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
import { rangeSmear } from "./smear.js"
import type {
  GpuAngleRow,
  GpuCell,
  GpuKeybindRow,
  GpuRangeRow,
  GpuSeedRow,
  GpuToolbarRow,
  GpuVecRow,
} from "./gpu/renderer.js"
import { createRollingNumber } from "@kitlangton/rolling-number"
import { iconSvg } from "./icons.js"
import { clamp, Roll, rollTarget, springEasing } from "./motion.js"
import { arrowOf, bigOf, keyPrefs } from "./prefs.js"
import { decimals as stepDecimals, type DigitPlace } from "./slider.js"
import { rollingReadout, rollMs, type RollingReadout } from "./reel.js"
import {
  band as pushBand,
  carryAt,
  carrySteps,
  moves,
  stepBand,
  textGive,
  type Band,
  type Steps,
} from "./give.js"
import { tick } from "./haptics.js"
import { onPan } from "./swipe.js"
import { toolbarColumns } from "./toolbar-grid.js"

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
  if (axes.length > 2) cells.dataset.wide = ""
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
  const rolls: RollingReadout[] = []
  const stops: HTMLElement[] = []
  for (const axis of axes) {
    const cell = el("span", "knobs-cell")
    cell.tabIndex = 0
    cell.dataset.axis = axis
    cell.setAttribute("role", "spinbutton")
    const name = c.field.axisLabels?.[axes.indexOf(axis)] ?? axis
    cell.setAttribute("aria-label", `${c.display} ${name}`)
    const letter = el("i", "knobs-cell-axis", name.toUpperCase())
    letter.setAttribute("aria-hidden", "true")
    const read = el("span", "knobs-cell-read")
    cell.append(letter, read)
    cells.append(cell)
    reads.push(read)
    rolls.push(rollingReadout(read))
    stops.push(cell)
    const editor = inlineEdit(
      c.doc,
      cell,
      `${c.display} ${name} value`,
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
    // A pan scrubs the cell like a drag; past an end its number gives a little.
    let panAt: Band | undefined
    const give = textGive(read, () => c.wake())
    onPan(cell, {
      accept: () => !drag.scrubbing() && !editor.open,
      move(dx) {
        const perPx = rate(f().min, f().max, f().step)
        if (panAt === undefined) {
          g.start()
          base = c.get() as Vec
          panAt = { at: 0, give: 0 }
          row.classList.add("knobs-active")
          // In hand like a scrubbed cell, which a scrub's press also focuses.
          cell.setAttribute("data-panned", "")
        }
        const from = base[axis] ?? 0
        panAt = pushBand(panAt, dx, (f().min - from) / perPx, (f().max - from) / perPx)
        g.set(withAxis(base, axis, from + panAt.at * perPx))
        if (panAt.give !== give.give) give.hold(panAt.give)
      },
      lift: () => give.release(),
      end() {
        panAt = undefined
        give.release()
        row.classList.remove("knobs-active")
        cell.removeAttribute("data-panned")
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
  /** The cells' numbers roll (Random, presets, undo, keys), except under a scrub or pan. */
  const paint = (ms = 0, delay = 0) => {
    axes.forEach((axis, i) => {
      const text = mixed ? "—" : fmt(shown[axis] ?? 0, places())
      const unit = f().unit && !mixed ? ` ${f().unit}` : ""
      rolls[i]!.show(mixed ? ["—"] : [{ value: shown[axis] ?? 0, decimals: places() }], ms, delay)
      stops[i]!.setAttribute("aria-valuetext", `${text}${unit}`)
    })
  }
  paint()
  let placed = false
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
    update(value: Value, delay: number, instant?: boolean, isMixed = false) {
      shown = value as Vec
      mixed = isMixed
      const hand = row.classList.contains("knobs-active")
      paint(!placed || instant || hand ? 0 : rollMs(row), delay)
      placed = true
    },
    dispose() {
      for (const r of rolls) r.dispose()
    },
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
  // The label and readout fade around a thumb that shows, so a thumb never sits on their text.
  const words = el("span", "knobs-range-text")
  words.append(label, read)
  const band = el("i", "knobs-range-smear")
  track.append(fill, band, ...thumbs, words)
  row.append(track)
  let shown = c.get() as readonly [number, number]
  let mixed = false
  let dragging = false
  // Edge blur (--k-range-blur): while the ends glide on their transitions, each smears by its own
  // speed, sampled from the animating --kr-lo/--kr-hi each frame. A drag or pan doesn't smear (the
  // GPU's doesn't either), and nothing runs while the band rests.
  let smearFrame = 0
  let smearAt = 0
  let smearStrength = 0
  let lastEnds: readonly [number, number] = [0, 0]
  const smears: [number, number] = [0, 0]
  const ends = (): readonly [number, number] => {
    const cs = getComputedStyle(track)
    return [
      parseFloat(cs.getPropertyValue("--kr-lo")) || 0,
      parseFloat(cs.getPropertyValue("--kr-hi")) || 0,
    ]
  }
  const setSmears = (lo: number, hi: number) => {
    // Half toward the new width each frame, which keeps a frame's jitter out of the ramp.
    smears[0] = lo === 0 ? 0 : (smears[0] + lo) / 2
    smears[1] = hi === 0 ? 0 : (smears[1] + hi) / 2
    track.classList.toggle("knobs-range-smearing", smears[0] > 0 || smears[1] > 0)
    track.style.setProperty("--kr-smear-lo", smears[0].toFixed(2))
    track.style.setProperty("--kr-smear-hi", smears[1].toFixed(2))
  }
  const runSmear = (now: number) => {
    const at = ends()
    const dt = (now - smearAt) / 1000
    const w = track.clientWidth
    const speeds = ([0, 1] as const).map((i) =>
      dt > 0 ? (Math.abs(at[i] - lastEnds[i]) * w) / dt : 0,
    )
    lastEnds = at
    smearAt = now
    const gliding = !dragging && track.getAnimations().length > 0
    setSmears(
      gliding ? rangeSmear(speeds[0]!, smearStrength) : 0,
      gliding ? rangeSmear(speeds[1]!, smearStrength) : 0,
    )
    smearFrame = gliding ? requestAnimationFrame(runSmear) : 0
  }
  track.addEventListener("transitionrun", (event) => {
    if (event.target !== track || smearFrame || dragging) return
    if (track.closest('[data-gpu-active="true"]')) return
    smearStrength = clamp(
      parseFloat(getComputedStyle(track).getPropertyValue("--k-range-blur")) || 0,
      0,
      1,
    )
    const reduced = c.doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (smearStrength <= 0 || reduced) return
    lastEnds = ends()
    smearAt = performance.now()
    smearFrame = requestAnimationFrame(runSmear)
  })
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
  const rolling = rollingReadout(read)
  /** Its ends roll to new values (Random, presets, undo, keys); a drag or pan places them. */
  const showText = (ms: number, delay: number) =>
    rolling.show(
      mixed
        ? ["—"]
        : [
            { value: shown[0], decimals: places() },
            "–",
            { value: shown[1], decimals: places() },
            f().unit ? ` ${f().unit}` : "",
          ],
      ms,
      delay,
    )
  const place = (instant: boolean) => {
    const [a, b] = [ratio(shown[0]), ratio(shown[1])]
    const nodes = [fill, track]
    if (instant) for (const n of nodes) n.style.transition = "none"
    fill.style.transform = `translateX(${(a * 100).toFixed(4)}%) scaleX(${Math.max(0, b - a).toFixed(5)})`
    // The thumbs and the text's fades follow the ends through these.
    track.style.setProperty("--kr-lo", a.toFixed(6))
    track.style.setProperty("--kr-hi", b.toFixed(6))
    if (instant) {
      void fill.offsetWidth
      for (const n of nodes) n.style.transition = ""
    }
  }
  const paint = (instant: boolean, delay = 0) => {
    showText(instant ? 0 : rollMs(row), delay)
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
  // A pan moves the last-held end like a drag; past the track's ends the readout gives a little.
  let panAt: Band | undefined
  const give = textGive(read, () => c.wake())
  onPan(track, {
    accept: () => !dragging,
    move(dx) {
      const w = track.clientWidth
      if (!w) return
      if (panAt === undefined) {
        g.start()
        panAt = { at: ((shown[lastEnd] - f().min) / span()) * w, give: 0 }
        dragging = true
        row.classList.add("knobs-active")
      }
      panAt = pushBand(panAt, dx, 0, w)
      g.set(
        withEnd(c.get() as readonly [number, number], lastEnd, f().min + (panAt.at / w) * span()),
      )
      if (panAt.give !== give.give) give.hold(panAt.give)
    },
    lift: () => give.release(),
    end() {
      panAt = undefined
      give.release()
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
      // Which thumb holds focus, for the text fade (an attribute rather than a :has() rule).
      row.dataset.endFocus = th.dataset.end
      c.wake()
    })
    th.addEventListener("blur", () => {
      if (row.dataset.endFocus === th.dataset.end) delete row.dataset.endFocus
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
      paint(first || Boolean(instant) || dragging, delay)
      first = false
    },
    dispose() {
      cancelAnimationFrame(smearFrame)
      rolling.dispose()
    },
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
  const rolling = rollingReadout(read)
  /** The degrees roll (Random, presets, undo, keys); under the hand they're placed. */
  const paint = (instant: boolean, delay = 0) => {
    const t = mixed ? "—" : `${fmt(value, places())}°`
    rolling.show(
      mixed ? ["—"] : [{ value, decimals: places() }, "°"],
      instant || row.classList.contains("knobs-active") ? 0 : rollMs(row),
      delay,
    )
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
  // A pan turns the dial a step a px; unless it wraps, past an end its readout gives a little.
  let panAt: Band | undefined
  const give = textGive(read, () => c.wake())
  onPan(control, {
    accept: () => !dragging,
    move(dx) {
      const step = f().step
      if (panAt === undefined) {
        g.start()
        panAt = { at: value / step, give: 0 }
        row.classList.add("knobs-active")
      }
      panAt = f().wrap
        ? { at: panAt.at + dx, give: 0 }
        : pushBand(panAt, dx, f().min / step, f().max / step)
      g.set(snapTo(panAt.at * step, false))
      if (panAt.give !== give.give) give.hold(panAt.give)
    },
    lift: () => give.release(),
    end() {
      panAt = undefined
      give.release()
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
      paint(first || Boolean(instant) || dragging, delay)
      first = false
    },
    dispose() {
      rolling.dispose()
    },
    tracks: [],
    gpu: [gpu],
  }
}

// ——— seed ———

/** Px of pan per seed step. */
const SEED_STEP = 12
/** How long a rolled seed's digits spin: about as long as its die tumbles. */
const DICE_ROLL_MS = 620

export function seedRow(c: RowContext<SeedField>): EditorRow {
  const { row, label, el } = shell(c, "seed")
  const f = () => c.field
  const control = el("span", "knobs-seed")
  control.tabIndex = 0
  control.setAttribute("role", "spinbutton")
  control.setAttribute("aria-label", c.display)
  const read = el("span", "knobs-seed-read")
  control.append(read)
  // Its digits roll, upward and as long as the die tumbles when it's rolled: a reel per place in
  // the DOM (rolling-number) and on the GPU (`places`).
  const reel = el("span", "knobs-seed-digits")
  read.append(reel)
  const roller = createRollingNumber(reel, {
    value: c.get() as number,
    format: { useGrouping: false, maximumFractionDigits: 0 },
    duration: 1,
    motionBlur: true,
  })
  const places: DigitPlace[] = []
  let initialized = false
  let diced = false
  const syncPlaces = (text: string, trend: number, ms: number) => {
    const now = performance.now()
    for (let j = 0; j < Math.max(text.length, places.length); j++) {
      const ch = j < text.length ? text[text.length - 1 - j]! : undefined
      const place = places[j]
      if (ch === undefined) {
        if (place && !place.exiting) {
          place.exiting = true
          place.presence.set(0, ms * 0.65, now)
        }
        continue
      }
      const digit = Number(ch)
      if (!place) {
        const presence = new Roll(ms > 0 ? 0 : 1)
        if (ms > 0) presence.set(1, ms, now)
        places[j] = {
          ch,
          wheel: new Roll(digit),
          presence,
          enterAt: now,
          enterMs: ms,
          exiting: false,
        }
        continue
      }
      if (place.exiting) {
        place.exiting = false
        place.presence.set(1, ms, now)
      }
      place.ch = ch
      const target = rollTarget(place.wheel.target, digit, trend)
      if (ms > 0) place.wheel.set(target, ms, now)
      else place.wheel.snap(target)
    }
    while (places.length > text.length && places[places.length - 1]!.exiting && ms <= 0)
      places.pop()
  }
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
    stopCarry()
    g.start()
    g.set(Math.round(clamp(v, f().min, f().max)))
  }
  const reroll = () => {
    const { min, max } = f()
    let next = value
    for (let i = 0; i < 8 && next === value; i++)
      next = min + Math.floor(Math.random() * (max - min + 1))
    die.roll()
    diced = true
    set(next)
    diced = false
  }
  roll.onclick = () => reroll()
  const editor = inlineEdit(c.doc, row, `${c.display} value`, set, () => control)
  // A sideways pan anywhere on the row scrubs the seed a step every SEED_STEP px, the digits
  // rolling and the die turning with it, as one undo step. Past an end the number gives a little;
  // a flick carries on a few steps after the lift.
  const give = textGive(read, () => c.wake())
  const recent = moves()
  let panned: Steps | undefined
  let carry: ReturnType<typeof setTimeout>[] = []
  const stopCarry = () => {
    for (const t of carry) clearTimeout(t)
    carry = []
  }
  /** Takes `steps` (signed) from the pan, one tick and quarter turn each; false at an end. */
  const scrubBy = (steps: number) => {
    const { min, max } = f()
    const next = clamp(value + steps, min, max)
    if (next === value) return false
    const dir = next > value ? 1 : -1
    for (let i = 0; i < Math.min(3, Math.abs(next - value)); i++) die.turn(dir)
    g.set(next)
    tick(control)
    return true
  }
  const letGo = () => {
    panned = undefined
    give.release()
    row.classList.remove("knobs-active")
    c.wake()
  }
  onPan(row, {
    accept: () => !editor.open,
    move(dx) {
      if (!panned) {
        stopCarry()
        g.start()
        recent.reset()
        panned = { travel: 0, give: 0 }
        row.classList.add("knobs-active")
        c.wake()
      }
      recent.add(dx)
      const { min, max } = f()
      const { next, steps } = stepBand(panned, dx, SEED_STEP, [value - min, max - value])
      panned = next
      if (steps) scrubBy(steps)
      if (next.give !== give.give) give.hold(next.give)
    },
    lift() {
      if (!panned) return
      const n = carrySteps(recent.speed())
      const dir = Math.sign(recent.speed())
      letGo()
      for (let i = 0; i < n; i++)
        carry.push(
          setTimeout(() => {
            if (!scrubBy(dir)) stopCarry()
          }, carryAt(i)),
        )
    },
    end: letGo,
    step(direction) {
      stopCarry()
      set(value + direction)
    },
  })
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
  const paint = (previous: number, instant: boolean) => {
    read.toggleAttribute("data-mixed", mixed)
    control.setAttribute("aria-valuenow", String(value))
    const ms = !initialized || instant ? 0 : diced ? DICE_ROLL_MS : rollMs(row)
    initialized = true
    syncPlaces(String(value), diced ? 1 : Math.sign(value - previous), ms)
    // The canvas draws the reel when the GPU renders; the hidden DOM one only keeps its width.
    const dom = ms > 0 && row.closest('[data-gpu-active="true"]') === null
    roller.update({
      value,
      animated: true,
      duration: dom ? ms : 1,
      motionBlur: dom,
      direction: diced ? "up" : "auto",
    })
    if (ms > 0) c.wake()
  }
  const gpu: GpuSeedRow = {
    kind: "seed",
    key: c.key,
    display: c.display,
    row,
    labelEl: label,
    control,
    read,
    places,
    mixed: () => mixed,
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
    update(next: Value, _delay: number, instant?: boolean, isMixed = false) {
      const previous = value
      value = next as number
      mixed = isMixed
      paint(previous, Boolean(instant))
    },
    dispose: () => {
      stopCarry()
      die.dispose()
      roller.destroy()
    },
    tracks: [],
    gpu: [gpu],
  }
}

// ——— keybind ———

/** A key cap's width change: snappy, no bounce (.25 s). */
const CAP_MORPH = springEasing((2 * Math.PI) / 0.25, 1)

export interface KeyCap {
  readonly chip: HTMLButtonElement
  readonly text: HTMLElement
  capturing(): boolean
  /** The combination it shows: `""` for none, undefined for mixed ("—"). */
  show(combo: string | undefined): void
}

/**
 * A key cap that records a combination: a click, Enter or Space listens, the next combination is
 * the value, Esc cancels and ⌫ clears. While it listens its row takes the active wash and the cap
 * breathes, "Type keys…" (or the modifiers held so far) in its place; its width follows its text
 * on a spring, its right edge still. Keybind rows and rebindable action rows use it.
 */
export function keyCap(o: {
  readonly doc: Document
  readonly row: HTMLElement
  /** What the cap reads with no combination. */
  readonly empty: string
  name(): string
  set(combo: string): void
  wake(): void
}): KeyCap {
  const chip = o.doc.createElement("button")
  chip.className = "knobs-keys"
  chip.type = "button"
  const text = o.doc.createElement("span")
  text.className = "knobs-keys-text"
  chip.append(text)
  let value: string | undefined = ""
  let capturing = false
  let preview = ""
  let morph: Animation | undefined
  /** New text, the cap's width gliding to fit it (the canvas does the same when it draws). */
  const write = (shown: string) => {
    const glide =
      chip.isConnected &&
      chip.offsetWidth > 0 &&
      !chip.closest('[data-gpu-active="true"]') &&
      !reduced(o.doc)
    const from = glide ? chip.getBoundingClientRect().width : 0
    morph?.cancel()
    text.textContent = shown
    if (!glide) return
    const to = chip.getBoundingClientRect().width
    text.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease-out" })
    if (Math.abs(to - from) < 0.5) return
    chip.dataset.morph = ""
    morph = chip.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: CAP_MORPH.ms,
      easing: CAP_MORPH.easing,
    })
    morph.onfinish = () => delete chip.dataset.morph
    morph.oncancel = () => delete chip.dataset.morph
  }
  const paint = () => {
    const shown = capturing
      ? preview || "Type keys…"
      : value === undefined
        ? "—"
        : value
          ? comboLabel(value)
          : o.empty
    if (text.textContent !== shown) write(shown)
    chip.toggleAttribute("data-empty", !capturing && value === "")
    chip.setAttribute("aria-pressed", String(capturing))
    chip.setAttribute(
      "aria-label",
      `${o.name()}: ${capturing ? "press a key combination" : value ? comboLabel(value) : "none"}`,
    )
    o.wake()
  }
  const capture = (on: boolean) => {
    if (capturing === on) return
    if (on && o.row.closest("[data-disabled],[data-readonly]")) return
    capturing = on
    preview = ""
    o.row.classList.toggle("knobs-active", on)
    paint()
  }
  const held = (event: KeyboardEvent) => {
    const mods = heldMods(event)
    preview = mods.length ? comboLabel(`${mods.join("+")}+…`) : ""
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
    // The cap shows what it heard at once, so it glides straight there from "Type keys…".
    const take = (combo: string) => {
      value = combo
      capture(false)
      o.set(combo)
    }
    if ((event.key === "Backspace" || event.key === "Delete") && !mods.length) return take("")
    const combo = comboFromEvent(event)
    if (!combo) return held(event)
    take(combo)
  })
  chip.addEventListener("keyup", (event) => {
    if (capturing) held(event)
  })
  chip.addEventListener("blur", () => capture(false))
  paint()
  return {
    chip,
    text,
    capturing: () => capturing,
    show(combo) {
      value = combo
      paint()
    },
  }
}

export function keybindRow(c: RowContext<KeybindField>): EditorRow {
  const { row, label } = shell(c, "keybind")
  const cap = keyCap({
    doc: c.doc,
    row,
    empty: "None",
    name: () => c.display,
    set: (combo) => c.set(combo),
    wake: c.wake,
  })
  const { chip, text } = cap
  row.append(chip)
  cap.show(c.get() as string)
  const gpu: GpuKeybindRow = {
    kind: "keybind",
    key: c.key,
    display: c.display,
    row,
    labelEl: label,
    chip,
    text,
    capturing: cap.capturing,
    wave: c.wave,
    isModified: c.isModified,
  }
  return {
    row,
    labelEl: label,
    input: chip,
    stops: () => [chip],
    update(next: Value, _delay: number, _instant?: boolean, isMixed = false) {
      cap.show(isMixed ? undefined : (next as string))
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
  /** Shows the shortcuts as they are now (after a rebinding). */
  refresh(): void
}

type Shortcut = ReturnType<typeof toolbarShortcut>

/** A button's width at its content's own size, however wide its grid cell has stretched it. */
function naturalWidth(b: HTMLElement) {
  const cs = getComputedStyle(b)
  let w = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  const parts = [...b.children]
  for (const part of parts) {
    const ps = getComputedStyle(part)
    const margin = parseFloat(ps.marginRight) || 0
    w += part instanceof HTMLElement ? part.scrollWidth + margin : parseFloat(ps.width) || 0
  }
  return Math.ceil(w + (parseFloat(cs.columnGap) || 0) * Math.max(0, parts.length - 1))
}

/**
 * A toolbar: its buttons in equal columns, as many as fit and balanced across the rows (see
 * `toolbarColumns`), each with its icon and label at the start and its shortcut at the end.
 * `keyOf` is each item's shortcut as it is now (the store's rebinding, else its own).
 */
export function toolbarRow(
  c: RowContext<ToolbarField>,
  press: (item: ToolbarItem) => void,
  keyOf: (item: ToolbarItem) => Shortcut = toolbarShortcut,
): ToolbarRow {
  const el = make(c.doc)
  const row = el("div", "knobs-row knobs-toolbar")
  row.dataset.field = c.key
  row.setAttribute("role", "toolbar")
  row.setAttribute("aria-label", c.display)
  let field = c.field
  let buttons: HTMLButtonElement[] = []
  let last = 0
  let keys = ""
  const keysNow = () => field.items.map((item) => keyOf(item)?.key ?? "").join("\u0000")
  const layout = () => {
    const cs = getComputedStyle(row)
    const avail =
      row.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
    if (avail <= 0 || !buttons.length) return
    const widest = Math.max(...buttons.map(naturalWidth))
    const cols = String(
      toolbarColumns(buttons.length, widest, avail, parseFloat(cs.columnGap) || 0),
    )
    if (row.style.getPropertyValue("--k-tool-cols") !== cols) {
      row.style.setProperty("--k-tool-cols", cols)
      c.wake()
    }
  }
  const sizes = new ResizeObserver(layout)
  sizes.observe(row)
  // A web font arriving changes the labels' widths, not the row's.
  void c.doc.fonts?.ready.then(() => row.isConnected && layout())
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
      const key = keyOf(item)
      if (key) {
        chip = el("kbd", "knobs-tool-key", comboLabel(key.key))
        b.append(chip)
        // A chip only (`scope: "none"`) is the host's key, which the button doesn't answer to.
        if (key.scope !== "none") b.setAttribute("aria-keyshortcuts", key.key)
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
    keys = keysNow()
    if (row.isConnected) layout()
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
    refresh() {
      if (keysNow() === keys) return
      const focused = buttons.indexOf(c.doc.activeElement as HTMLButtonElement)
      build()
      if (focused >= 0) buttons[focused]?.focus({ preventScroll: true })
      c.wake()
    },
    match(event, global) {
      return field.items.find((item) => {
        const key = keyOf(item)
        return (
          key !== undefined &&
          !item.disabled &&
          key.scope === (global ? "page" : "panel") &&
          matchesCombo(key.key, event)
        )
      })
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
    dispose() {
      sizes.disconnect()
    },
    tracks: [],
    gpu: [gpu],
  }
}

/** The value a vector shows, as `{ x, y }` or `{ x, y, z }`. */
export type { Vec, Vec3 }
