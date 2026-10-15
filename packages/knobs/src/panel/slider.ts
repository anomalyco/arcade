import { createRollingNumber } from "@kitlangton/rolling-number"
import type { Knob as KnobField } from "../core/schema.js"
import { springMotion } from "../core/spring.js"
import { tick } from "./haptics.js"
import { keyPrefs } from "./prefs.js"
import {
  clamp,
  FILL,
  POP_MS,
  popScale,
  Roll,
  rollTarget,
  Spring,
  VelocityTracker,
} from "./motion.js"
import { onPan } from "./swipe.js"

export interface DigitPlace {
  ch: string
  /** Unbounded wheel position for digits (… 9, 10, 11 …); face = position mod 10. */
  readonly wheel: Roll
  /** 1 while shown, 0 once gone: new places fade in and rise, leaving places fade out. */
  readonly presence: Roll
  /** When this place started entering, and how long the entrance lasts (ms). */
  enterAt: number
  enterMs: number
  exiting: boolean
}

export interface Slider {
  element: HTMLElement
  /** The focusable, keyboard-driven surface. */
  track: HTMLElement
  /** The visible label element. */
  label: HTMLElement
  /** The value button element. */
  valueButton: HTMLButtonElement
  /** The inline number editor (hidden until the value is clicked). */
  number: HTMLInputElement
  /**
   * Spring driving the fill's edge [0..1]: the value, or while a stepped slider is in hand, the
   * value pulled part way toward the pointer (--k-step-resist).
   */
  fillSpring: Spring
  /** Spring driving handle visibility/scale [0..1] (the GPU renderer sets its target). */
  handleSpring: Spring
  /** Per-character springs for GPU rolling number digits. */
  /** Readout characters keyed by place from the right, so 99 → 100 keeps the 9s in place. */
  digitPlaces: DigitPlace[]
  /** Velocity tracker on normalized fill ratio for drag motion blur. */
  velocity: VelocityTracker
  /** Number of tick marks along the track. */
  readonly tickCount: number
  /** Where the default value sits along the track [0..1]. */
  readonly notchRatio: number
  /** Whether a drag is currently held on the default by the notch's magnet. */
  isMagnetized(): boolean
  /** When the readout last popped (a click landing on a decile, or the default's magnet). */
  poppedAt: number
  /** Formatted numeric string without unit (e.g. "0.45" or "98"). */
  getDigitsText(): string
  /** Optional unit string (e.g. "px", "s"). */
  getUnitText(): string
  /** Whether pointer drag is currently active. */
  isDragging(): boolean
  /** Whether the inline number input is open. */
  isEditing(): boolean
  /**
   * `delay` (ms) holds this row's motion for its turn in a preset cascade; `instant` places the
   * value without springing or rolling (a different item arrived).
   */
  update(value: number, delay?: number, instant?: boolean): void
  /** Takes a new range, step, label or unit in place, keeping the DOM (see `RemoteControls.update`). */
  retune(field: KnobField): void
  /** The field it currently draws. */
  readonly field: KnobField
  /** Open the inline editor (used when a digit is typed on the track). */
  edit(): void
  dispose(): void
}

export const decimals = (step: number) => {
  const text = String(step)
  const i = text.indexOf(".")
  return i < 0 ? 0 : text.length - i - 1
}

/**
 * `steps` grid steps from `value` (negative goes down), on the slider's grid counted from `min`.
 * From a value between grid points (a declared default like 0.4 on a 0.02 grid from 0.15) the
 * first step lands on the next grid point that way, not past it.
 */
export function stepValue(
  field: { min: number; max: number; step: number },
  value: number,
  steps: number,
) {
  const at = (value - field.min) / field.step
  const on = Math.abs(at - Math.round(at)) < 1e-6
  const target = on
    ? Math.round(at) + steps
    : steps > 0
      ? Math.ceil(at) + steps - 1
      : Math.floor(at) + steps + 1
  const v = field.min + target * field.step
  return Number(Math.min(field.max, Math.max(field.min, v)).toPrecision(14))
}

/**
 * A DialKit-style slider: the whole row is the track, the fill is a full-height block,
 * the handle is a hairline that only shows on hover, and the label + value sit on the
 * track itself. Dragging follows the pointer exactly (⌥ for 1/10 speed) and the default's notch
 * pulls it in from a few px away; a click snaps to the nearest step (or nearest 10% when there
 * are many steps) with a short spring-like ease. A sideways trackpad pan moves it like a drag.
 */
export function createSlider(
  doc: Document,
  key: string,
  initialField: KnobField,
  set: (value: number, options?: { coalesce?: boolean }) => void,
  onMotionWake?: () => void,
): Slider {
  let field = initialField
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
    const node = doc.createElement(tag)
    if (cls) node.className = cls
    return node
  }
  const root = el("div", "knobs-slider")
  const track = el("div", "knobs-track")
  track.tabIndex = 0
  track.setAttribute("role", "slider")
  const ratioOf = (v: number) =>
    field.max === field.min
      ? 0
      : Math.min(1, Math.max(0, (v - field.min) / (field.max - field.min)))
  let notchRatio = 0
  let steps = 0
  let count = 0
  let span = 0
  const marks = el("div", "knobs-marks")
  const notch = el("i", "knobs-notch")
  const fill = el("div", "knobs-fill")
  const handle = el("div", "knobs-handle")
  const label = el("span", "knobs-label")
  const value = el("button", "knobs-value")
  value.type = "button"
  value.tabIndex = -1
  // A pointer shortcut into the inline editor; the slider itself carries the value for assistive
  // tech (aria-valuetext), and typing a digit opens the same editor.
  value.setAttribute("aria-hidden", "true")
  const digits = el("span", "knobs-digits")
  value.append(digits)
  const unit = el("span", "knobs-unit")
  const number = el("input", "knobs-number")
  number.type = "number"
  number.name = `${key}-value`
  number.hidden = true
  /** Lays out everything that follows from the field: marks, notch, labels and limits. */
  const shape = () => {
    const display = field.label ?? key
    track.setAttribute("aria-label", display)
    track.setAttribute("aria-valuemin", String(field.min))
    track.setAttribute("aria-valuemax", String(field.max))
    notchRatio = ratioOf(field.value)
    span = field.max - field.min
    steps = span / field.step
    count = steps <= 10 ? Math.round(steps) + 1 : 11
    const ticks: HTMLElement[] = []
    for (let i = 0; i < count; i++) {
      const r = i / (count - 1)
      if (Math.abs(r - notchRatio) < 0.025) continue
      const mark = el("i")
      mark.style.left = `${r * 100}%`
      ticks.push(mark)
    }
    notch.style.left = `clamp(1px, ${notchRatio * 100}%, calc(100% - 1px))`
    marks.replaceChildren(...ticks, notch)
    if (label.textContent !== display) label.textContent = display
    unit.textContent = field.unit ?? ""
    if (field.unit) {
      if (!unit.isConnected) value.append(unit)
    } else unit.remove()
    number.min = String(field.min)
    number.max = String(field.max)
    number.step = String(field.step)
    number.setAttribute("aria-label", `${display} value`)
  }
  shape()
  // The handle rides a full-width layer translated by the fill (a transform, so it lands on the
  // fill's exact sub-pixel edge), inside a still layer that fades it where the text sits.
  const handleZone = el("div", "knobs-handle-zone")
  handleZone.append(handle)
  track.append(fill, marks, handleZone, label, value, number)
  root.append(track)
  // Hover ticks and the default notch stay clear of both the readout and the label.
  let trackWidth = 0
  const ro = new ResizeObserver(() => {
    trackWidth = track.offsetWidth
    if (value.offsetWidth) track.style.setProperty("--k-readout", `${value.offsetWidth}px`)
    track.style.setProperty("--k-label-end", `${label.offsetLeft + label.offsetWidth}px`)
  })
  ro.observe(value)
  ro.observe(track)
  ro.observe(label)

  let places = field.decimals ?? decimals(field.step)
  const fmtDigits = (v: number) => v.toFixed(places)
  const fmt = (v: number) => `${fmtDigits(v)}${field.unit ? ` ${field.unit}` : ""}`
  const makeRoller = (at: number) =>
    createRollingNumber(digits, {
      value: at,
      format: { minimumFractionDigits: places, maximumFractionDigits: places, useGrouping: false },
      duration: 320,
      motionBlur: true,
    })
  let roller = makeRoller(field.value)
  // Roll durations (ms), the stepped drag's resistance, the edge blur and the spring are design
  // tokens, so the meta page can tune them. Read once per press while dragging: a style read per
  // pointer move would force a restyle.
  const tokens = {
    stepRoll: 320,
    dragRoll: 0,
    resist: 0.25,
    blur: 0,
    omega: FILL.omega,
    zeta: FILL.zeta,
  }
  let tokensAt = Number.NEGATIVE_INFINITY
  const readTokens = () => {
    const now = performance.now()
    if (now - tokensAt <= 16 || dragging) return tokens
    tokensAt = now
    const cs = getComputedStyle(root)
    const num = (name: string, fallback: number) => {
      const n = parseFloat(cs.getPropertyValue(name))
      return Number.isFinite(n) ? n : fallback
    }
    tokens.stepRoll = Math.max(0, num("--k-roll", 320))
    tokens.dragRoll = Math.max(0, num("--k-drag-roll", 0))
    tokens.resist = clamp(num("--k-step-resist", 0.25), 0, 1)
    tokens.blur = clamp(num("--k-motion-blur", 0), 0, 1)
    const [duration, bounce] = cs.getPropertyValue("--k-spring").trim().split(/\s+/).map(Number)
    if (Number.isFinite(duration) && Number.isFinite(bounce)) {
      const m = springMotion({ duration: duration!, bounce: bounce! })
      tokens.omega = m.omega
      tokens.zeta = m.zeta
    }
    return tokens
  }
  const rollMs = (drag: boolean) => (drag ? readTokens().dragRoll : readTokens().stepRoll)
  /** Few enough stops that a drag glides from one to the next instead of tracking the pointer. */
  const stepped = () => steps <= 10
  const quantize = (v: number) =>
    Math.min(
      field.max,
      Math.max(field.min, field.min + Math.round((v - field.min) / field.step) * field.step),
    )

  const fillSpring = new Spring(notchRatio, FILL.omega, FILL.zeta)
  const handleSpring = new Spring(0, 28, 0.88)
  const digitPlaces: DigitPlace[] = []
  const velocity = new VelocityTracker()
  let initialized = false

  // Mirrors @kitlangton/rolling-number: each place is a wheel that rolls through every face in
  // the value's direction (98 → 108 rolls the tens 9 → 0 forwards), new places rise in after a
  // short hold, cascading outward, and leaving places fade over ~65% of the duration.
  function syncDigits(text: string, trend: number, ms: number, delay: number) {
    const now = performance.now()
    const live = digitPlaces.filter((p) => !p.exiting).length
    const step = Math.min(ms * 0.045, (ms * 0.3) / Math.max(1, text.length - live))
    for (let j = 0; j < Math.max(text.length, digitPlaces.length); j++) {
      const ch = j < text.length ? text[text.length - 1 - j]! : undefined
      const place = digitPlaces[j]
      if (ch === undefined) {
        if (place && !place.exiting) {
          place.exiting = true
          place.presence.set(0, ms * 0.65, now, delay)
        }
        continue
      }
      const digit = ch >= "0" && ch <= "9" ? Number(ch) : Number.NaN
      if (!place) {
        const hold = ms > 0 ? delay + Math.max(0, j - live) * step : 0
        const presence = new Roll(ms > 0 && initialized ? 0 : 1)
        if (ms > 0 && initialized) presence.set(1, ms, now, hold)
        digitPlaces[j] = {
          ch,
          wheel: new Roll(Number.isNaN(digit) ? 0 : digit),
          presence,
          enterAt: now + hold,
          enterMs: ms > 0 && initialized ? ms : 0,
          exiting: false,
        }
        continue
      }
      if (place.exiting) {
        place.exiting = false
        place.presence.set(1, ms, now, delay)
      }
      const wasDigit = place.ch >= "0" && place.ch <= "9"
      if (!Number.isNaN(digit)) {
        if (!wasDigit || ms <= 0) place.wheel.snap(digit)
        else {
          const at = place.wheel.sample(now).position
          if (((Math.round(at) % 10) + 10) % 10 !== digit || !place.wheel.resting(now))
            place.wheel.set(rollTarget(at, digit, trend), ms, now, delay)
        }
      }
      place.ch = ch
    }
    while (
      digitPlaces.length > text.length &&
      digitPlaces.at(-1)!.exiting &&
      digitPlaces.at(-1)!.presence.resting(now)
    )
      digitPlaces.pop()
  }

  let current = field.value
  let lastRollerLen = fmtDigits(field.value).length
  let rollerDirty = false
  // Entering or leaving the notch's magnet eases the last few px instead of jumping.
  let settleUntil = 0
  const settling = () => inHand() && performance.now() < settleUntil
  /** Where the fill's edge belongs: the value, pulled toward the pointer while a stepped drag holds it. */
  const aim = () => {
    const r = ratioOf(current)
    if (pulled === undefined || !stepped() || magnet) return r
    return r + (ratioOf(pulled) - r) * tokens.resist
  }
  const gpuActive = () => root.closest('[data-gpu-active="true"]') !== null
  const reduced = doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)")
  const writeFill = (ratio: number) => {
    const p = `${ratio * 100}%`
    fill.style.setProperty("--k-fill", p)
    handle.style.setProperty("--k-fill", p)
  }
  // The DOM moves the fill on CSS transitions, except where it needs the spring itself: a stepped
  // drag's resistance and snap, and edge blur (--k-motion-blur), which needs the edge's speed. Then
  // it steps `fillSpring` each frame, as the GPU renderer does, and stops once it rests.
  let frame = 0
  let frameAt = 0
  let smear = 0
  /** Whether `fillSpring` holds the edge on screen (not a CSS transition's). */
  let synced = true
  const springDriven = () => frame !== 0 || (inHand() && stepped()) || readTokens().blur > 0
  const setSmear = (px: number) => {
    const next = px < 0.25 ? 0 : px
    if (next === smear) return
    smear = next
    root.classList.toggle("knobs-smear", next > 0)
    root.style.setProperty("--k-smear", next.toFixed(2))
  }
  const run = (now: number) => {
    fillSpring.omega = tokens.omega
    fillSpring.zeta = tokens.zeta
    if (reduced?.matches) fillSpring.snap(fillSpring.target)
    else fillSpring.step((now - frameAt) / 1000)
    frameAt = now
    writeFill(fillSpring.x)
    // Edge blur: the same smear as the GPU's, from the edge's speed (px/s).
    const speed = Math.max(Math.abs(fillSpring.v), Math.abs(velocity.velocity[0])) * getTrackWidth()
    setSmear(reduced?.matches ? 0 : Math.min(28, speed * 0.022 * tokens.blur))
    const busy = !fillSpring.resting || smear > 0 || (inHand() && tokens.blur > 0)
    frame = busy ? requestAnimationFrame(run) : 0
    onMotionWake?.()
  }
  const drive = () => {
    if (frame) return
    // Pick up the edge where any CSS transition has it now (a style read, so only then).
    if (!synced) {
      const shown = parseFloat(getComputedStyle(fill).getPropertyValue("--k-fill"))
      if (Number.isFinite(shown)) {
        fillSpring.x = shown / 100
        fillSpring.v = 0
      }
      synced = true
    }
    root.classList.remove("knobs-animate", "knobs-settle")
    frameAt = performance.now()
    frame = requestAnimationFrame(run)
  }
  const halt = () => {
    cancelAnimationFrame(frame)
    frame = 0
    setSmear(0)
  }
  const paint = (v: number, animate: boolean) => {
    if (!gpuActive() && springDriven()) return drive()
    halt()
    synced = gpuActive()
    root.classList.toggle("knobs-animate", animate)
    root.classList.toggle("knobs-settle", settling())
    writeFill(ratioOf(v))
  }
  let rollTimer: ReturnType<typeof setTimeout> | undefined
  const slotX = (slot: HTMLElement) =>
    parseFloat(/translateX\(([-\d.]+)px\)/.exec(slot.style.transform)?.[1] ?? "0")
  const fastPatchDigits = (text: string): boolean => {
    // Slots are placed by transform, not DOM order: a place added mid-drag (99 → 100) is last.
    const slots = [...digits.querySelectorAll<HTMLElement>(".rn-slot")].sort(
      (a, b) => slotX(a) - slotX(b),
    )
    if (slots.length !== text.length) return false
    for (let i = 0; i < slots.length; i++) {
      const faces = slots[i]!.querySelectorAll<HTMLElement>(".rn-face")
      if (faces.length !== 1) return false
      faces[0]!.textContent = text[i]!
    }
    const sem = digits.querySelector<HTMLElement>(".rn-value")
    if (sem) sem.textContent = text
    return true
  }
  const update = (v: number, delay = 0, instant = false) => {
    const previous = current
    current = v
    const r = ratioOf(v)
    velocity.add(r, 0)
    const ms = !initialized || instant ? 0 : rollMs(inHand())
    if (!initialized || instant || (inHand() && !settling() && !stepped())) {
      fillSpring.snap(r)
      synced = true
    } else fillSpring.set(aim(), delay)
    const digitsStr = fmtDigits(v)
    syncDigits(digitsStr, Math.sign(v - previous), ms, ms > 0 ? delay : 0)
    initialized = true
    // Random, presets and keys roll at --k-roll; drags snap unless --k-drag-roll is set.
    // Never take rolling-number's unanimated path: its finish() resets the reels, so the next
    // change would jump instead of rolling. A 1 ms roll is a snap that keeps it warm.
    // In GPU mode the canvas draws the readout, so the hidden DOM reel only needs immediate updates
    // when the character count changes (for readout width).
    const gpu = root.closest('[data-gpu-active="true"]') !== null
    const animateDom = ms > 0 && !gpu
    if (instant) delay = 0
    const roll = () => {
      rollerDirty = false
      lastRollerLen = digitsStr.length
      roller.update({
        value: v,
        animated: true,
        duration: animateDom ? ms : 1,
        motionBlur: animateDom,
      })
    }
    clearTimeout(rollTimer)
    if (gpu && digitsStr.length === lastRollerLen) {
      rollerDirty = true
    } else if (
      inHand() &&
      !animateDom &&
      digitsStr.length === lastRollerLen &&
      fastPatchDigits(digitsStr)
    ) {
      rollerDirty = true
    } else if (delay > 0 && animateDom) {
      rollTimer = setTimeout(roll, delay)
    } else {
      roll()
    }
    track.setAttribute("aria-valuenow", String(v))
    track.setAttribute("aria-valuetext", fmt(v))
    if (number.hidden) paint(v, !instant && (!inHand() || stepped()))
    onMotionWake?.()
  }
  const retune = (next: KnobField) => {
    if (next === field) return
    const placesBefore = places
    field = next
    shape()
    places = field.decimals ?? decimals(field.step)
    if (places !== placesBefore) {
      digits.replaceChildren()
      roller = makeRoller(current)
      lastRollerLen = fmtDigits(current).length
    }
    onMotionWake?.()
  }

  const getTrackWidth = () => trackWidth || (trackWidth = track.offsetWidth)
  const valueAt = (clientX: number, rect = track.getBoundingClientRect()) => {
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return field.min + t * span
  }
  // A click's pop waits for the rolling digits to land (about a third of the roll); the
  // magnet's pops at once, since drags don't roll.
  let poppedAt = -Infinity
  const pop = (delay = 0) => {
    if (doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    poppedAt = performance.now() + delay
    const frames = Array.from({ length: 13 }, (_, i) => ({ scale: popScale((i / 12) * POP_MS) }))
    value.animate(frames, { duration: POP_MS, delay })
    onMotionWake?.()
  }

  // Within MAGNET px of the default (at the pointer's current speed), the value sits on it.
  const MAGNET = 4
  const nearDefault = (v: number, factor = 1) => {
    const w = getTrackWidth()
    return w > 0 && Math.abs(v - field.value) <= (MAGNET / w) * span * factor
  }
  // Clicks snap: to the step when steps are few, otherwise magnetically to deciles. Landing on
  // the default or a decile pops the readout.
  const snap = (v: number) => {
    if (nearDefault(v)) {
      pop(rollMs(false) * 0.35)
      return field.value
    }
    if (steps <= 10) return quantize(v)
    const decile = Math.round(((v - field.min) / span) * 10) / 10
    const near = Math.abs((v - field.min) / span - decile) < 0.03125
    if (near) pop(rollMs(false) * 0.35)
    return quantize(near ? field.min + decile * span : v)
  }

  let dragging = false
  // A trackpad pan holds the slider like a drag does.
  let panning = false
  const inHand = () => dragging || panning
  /** Where the pointer or fingers have the value (clamped to the range) while it's in hand. */
  let pulled: number | undefined
  /** Whether the drag or pan in hand has changed the value yet (its undo step exists). */
  let committed = false
  let dragRect: DOMRect | undefined
  let startX = 0
  let moved = false
  let fromValue = false
  let magnet = false
  // ⌥ switches to relative 1/10-speed dragging, re-anchored whenever ⌥ changes so nothing jumps.
  let relative = false
  let fine = false
  let anchorX = 0
  let anchorValue = 0
  let raw = 0

  track.onpointerdown = (event) => {
    const target = event.target as Node | null
    if (event.button !== 0 || (target && number.contains(target))) return
    event.preventDefault()
    fromValue = Boolean(target && value.contains(target))
    tokensAt = Number.NEGATIVE_INFINITY
    readTokens()
    track.setPointerCapture(event.pointerId)
    dragRect = track.getBoundingClientRect()
    trackWidth = dragRect.width
    dragging = true
    moved = false
    startX = event.clientX
    fine = relative = event.altKey
    anchorX = startX
    anchorValue = raw = current
    committed = false
    velocity.reset()
    root.classList.add("knobs-active")
    // A pointer focus isn't a keyboard one: no focus wash (Chromium would draw one, since the
    // pointerdown's default, which tells it a pointer did this, is prevented).
    track.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    onMotionWake?.()
  }
  /**
   * The pointer or fingers have the value at `at` (clamped to the range): it takes the nearest
   * step (or the default, held by its magnet), and the fill follows: exactly for a continuous
   * slider, pulled part way from its stop for a stepped one, which snaps to the next stop past
   * halfway. Each new stop or catch by the magnet ticks on a phone.
   */
  const pull = (at: number, factor = 1) => {
    pulled = at
    const before = current
    const caught = magnetize(at, factor)
    // The gesture's first change is a new undo step; the rest fold into it.
    set(caught ? field.value : quantize(at), { coalesce: committed })
    if (current !== before) {
      committed = true
      if (stepped() && !caught) tick(track)
    }
    if (stepped()) {
      fillSpring.set(aim())
      if (!gpuActive()) drive()
    } else if (frame === 0 && readTokens().blur > 0 && !gpuActive()) drive()
    onMotionWake?.()
  }
  track.onpointermove = (event) => {
    if (!dragging) return
    if (!moved && !relative && Math.abs(event.clientX - startX) < 3) return
    if (event.altKey !== fine) {
      fine = event.altKey
      relative = true
      anchorX = event.clientX
      anchorValue = raw
    }
    moved = true
    const rect = dragRect ?? (dragRect = track.getBoundingClientRect())
    const factor = fine ? 0.1 : 1
    if (relative) {
      raw = anchorValue + ((event.clientX - anchorX) / rect.width) * span * factor
      // The ends hold: pushing past one and back moves at once, with nothing banked.
      if (raw < field.min || raw > field.max) {
        raw = clamp(raw, field.min, field.max)
        anchorValue = raw
        anchorX = event.clientX
      }
    } else raw = valueAt(event.clientX, rect)
    pull(raw, factor)
  }
  /** Whether `raw` is close enough to the default for its magnet to hold it there. */
  const magnetize = (raw: number, factor = 1) => {
    const held = nearDefault(raw, factor)
    if (held !== magnet) {
      magnet = held
      settleUntil = held ? performance.now() + 80 : 0
      root.classList.toggle("knobs-magnet", held)
      if (held) {
        pop()
        tick(track)
      }
    }
    return held
  }
  /** The end of a drag or pan: a stepped fill springs home onto its stop. */
  const letGo = () => {
    magnet = false
    pulled = undefined
    root.classList.remove("knobs-magnet", "knobs-settle", "knobs-active")
    fillSpring.set(ratioOf(current))
    if (!gpuActive() && (frame !== 0 || stepped() || tokens.blur > 0)) drive()
  }
  const settleDigits = () => {
    if (rollerDirty && root.closest('[data-gpu-active="true"]') === null) {
      rollerDirty = false
      roller.update({ value: current, animated: true, duration: 1, motionBlur: false })
    }
  }
  const release = (event: PointerEvent) => {
    if (!dragging) return
    const rect = dragRect
    dragging = false
    dragRect = undefined
    letGo()
    if (!moved) {
      if (fromValue) edit()
      else set(snap(valueAt(event.clientX, rect)))
    } else settleDigits()
    onMotionWake?.()
  }
  track.onpointerup = release
  track.onpointercancel = release

  // A sideways trackpad pan is a drag by other means: the value follows the fingers 1:1 at the
  // fill's scale from the first event, holds at the ends, and lands as one undo step; the
  // momentum after the fingers lift is ignored. A wheel notch (or ⇧ + wheel) steps once.
  // Vertical scrolling is left alone so the page and panel still scroll.
  let panRaw = 0
  let panValue = 0
  /** Between a pan's first move and its end (`panning` lets go a little sooner, at the lift). */
  let panGesture = false
  const panLift = () => {
    if (!panning) return
    panning = false
    letGo()
    settleDigits()
    onMotionWake?.()
  }
  onPan(track, {
    accept: () => !dragging && number.hidden,
    move(dx) {
      const width = getTrackWidth()
      if (!width || span <= 0) return
      if (!panning) {
        panning = true
        velocity.reset()
        root.classList.add("knobs-active")
        readTokens()
      }
      // A new gesture, or any other change (an undo, a key), anchors the pan as a new undo step.
      if (!panGesture || current !== panValue) {
        panGesture = true
        panRaw = panValue = current
        committed = false
      }
      panRaw = clamp(panRaw + (dx / width) * span, field.min, field.max)
      pull(panRaw)
      panValue = current
    },
    lift: panLift,
    end() {
      panLift()
      panGesture = false
    },
    step(direction) {
      const next = stepValue(field, current, direction)
      if (next !== current) set(next)
    },
  })

  const edit = () => {
    number.value = String(current)
    number.hidden = false
    value.hidden = true
    number.focus()
    number.select()
    onMotionWake?.()
  }
  const done = (commit: boolean) => {
    if (number.hidden) return
    const next = number.valueAsNumber
    number.hidden = true
    value.hidden = false
    if (commit && Number.isFinite(next)) set(quantize(next))
    halt()
    fillSpring.snap(ratioOf(current))
    synced = true
    paint(current, false)
    track.focus({ preventScroll: true })
    onMotionWake?.()
  }
  value.onclick = (event) => {
    // Pointer clicks are handled on release; this covers keyboard/AT activation.
    if (event.detail === 0) edit()
  }
  number.onblur = () => done(true)
  number.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      done(true)
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      done(false)
    }
  }
  track.onkeydown = (event) => {
    if (event.target !== track) return
    if (event.key === "Enter" && number.hidden && keyPrefs(track).edit) {
      event.preventDefault()
      edit()
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      set(event.key === "Home" ? field.min : field.max)
    }
  }
  return {
    element: root,
    track,
    label,
    valueButton: value,
    number,
    fillSpring,
    handleSpring,
    digitPlaces,
    velocity,
    get tickCount() {
      return count
    },
    get notchRatio() {
      return notchRatio
    },
    get field() {
      return field
    },
    retune,
    isMagnetized: () => magnet,
    get poppedAt() {
      return poppedAt
    },
    getDigitsText: () => fmtDigits(current),
    getUnitText: () => field.unit ?? "",
    isDragging: inHand,
    isEditing: () => !number.hidden,
    update,
    edit,
    dispose() {
      ro.disconnect()
      clearTimeout(rollTimer)
      halt()
    },
  }
}
