import { tick } from "./haptics.js"

/** A pause this long (ms) with no wheel events ends a gesture. */
export const GESTURE_GAP = 120

// Fingers lifting off a Mac trackpad leave a ~25 ms hole in the stream, and the first momentum
// event covers it: a spike 1.5–2.6× the last finger delta, though slower per ms, since the hole
// counts. After it, momentum runs faster per ms and fades by a steady 0.9–0.97 per event
// (recorded Safari, Chrome and Firefox traces in tests/fixtures).
/** The shortest pause (ms) that can hide a lift, and its size against the gesture's usual pace. */
const LIFT_GAP = 14
const LIFT_PACE = 1.4
/**
 * How much a lift's first momentum event outgrows the finger event before it, its least px, and
 * its most speed (px/ms) against the fingers' (0.54–0.83 recorded; a long finger interval is ~1).
 */
const LIFT_SPIKE = 1.25
const LIFT_SPIKE_MIN = 5
const LIFT_SLOWER = 0.9
/** The momentum event after the spike: its size against the spike's, and its speed (px/ms). */
const AFTER_SPIKE: readonly [number, number] = [0.25, 1.25]
const AFTER_SPIKE_SPEEDUP = 1.2
/** Event-to-event ratios of momentum once it's running (Chrome's and Firefox's first few rise). */
const COAST: readonly [number, number] = [0.8, 1.15]
/**
 * A steady fade, for streams with no lift pause: a run that never rises, never drops by more
 * than a quarter in one event, plateaus (whole px) at most one event at a time, and whose rate
 * per event since it began holds within `FADE_DRIFT`.
 */
const FADE_STEP = 0.75
const FADE_DRIFT = 0.05
/** Momentum events held back before a lift is certain; a finger event in between releases them. */
const CONFIRM = 4
/** A new touch can't land without a pause this long (ms); a coast broken sooner was a false alarm. */
const TOUCH_GAP = 24
/**
 * Momentum fades out over dozens of events, 10% every few. A coast still at this many px that
 * stops fading for `PLATEAU` events (Firefox's hovers for 9), or goes quiet before fading or
 * within `PLATEAU / 2`, was the fingers.
 */
const PLATEAU_PX = 3
const PLATEAU = 10

export interface WheelSample {
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaMode: number
  readonly shiftKey: boolean
  /** ms */
  readonly timeStamp: number
  /** Safari only: false when natural scrolling is off, so the deltas follow the fingers. */
  readonly webkitDirectionInvertedFromDevice?: boolean
  /**
   * Chromium 151+ (Chrome, Edge, Brave): true for the inertia the OS sends after the fingers lift
   * (the platform's own momentum phase). Where it exists the pan needs no guessing; where it
   * doesn't (Safari, Firefox), the lift is recognised from the stream's shape.
   */
  readonly momentum?: boolean
}

export interface PanHandlers {
  /** Asked at the start of each gesture or notch; false leaves it to the page. */
  accept?(): boolean
  /** Finger travel (px) since the last call: positive rightwards and downwards. */
  move(dx: number, dy: number): void
  /**
   * The fingers seem to have lifted: a cue to let go visually. It comes as soon as a lift is
   * suspected, before `end` (which waits for proof); a move after it means they hadn't.
   */
  lift?(): void
  /** After one or more moves: the fingers lifted (their momentum is ignored) or went still. */
  end(): void
  /** A mouse wheel notch (or ⇧ + wheel): one step, rightwards or down being +1. */
  step?(direction: -1 | 1): void
}

type Phase = "idle" | "pan" | "pass" | "coast"

/**
 * Turns wheel events into direct manipulation. A horizontal two-finger pan moves 1:1 with the
 * fingers from its first event; when they lift, the momentum macOS keeps sending is recognised
 * and ignored, so things stop where the fingers stopped. Vertical gestures are never claimed.
 *
 * A lift is spotted the moment it happens, by its pause and spike, or by a steady fade when a
 * stream has no pause. Suspect events are held back rather than applied: a finger event in their
 * place releases them, and so does one breaking the coast with no pause (a new touch always
 * pauses), so a false alarm costs a few ms, never distance. A push stronger than the momentum it
 * interrupts starts a new gesture at once.
 *
 * `feed` returns whether the event belongs to a claimed gesture, in which case the caller should
 * `preventDefault()` it (so the browser doesn't scroll or swipe back a page). `idle` ends the
 * gesture once the wheel has been quiet for `GESTURE_GAP`.
 */
export function createPan(handlers: PanHandlers, options: { axes?: "x" | "xy" } = {}) {
  const both = options.axes === "xy"
  let phase: Phase = "idle"
  let at = Number.NEGATIVE_INFINITY
  let lastX = 0
  let lastY = 0
  let lastMag = 0
  let lastGap = 0
  /** The fade run: its length, where it began (px), its rate per event, and a plateau in it. */
  let fadeFrom = 0
  let fadeRate = 1
  let plateau = false
  let moved = false
  let travelX = 0
  let travelY = 0
  let gaps: number[] = []
  /** The fingers' last few speeds (px/ms). */
  let speeds: number[] = []
  let fade = 0
  let held: [number, number][] = []
  let heldBy: "lift" | "fade" = "lift"
  /** The spike's speed (px/ms). */
  let spikeSpeed = 0
  /** Momentum swallowed since the lift, in case it turns out to have been the fingers. */
  let swallowedX = 0
  let swallowedY = 0
  let certain = false
  let low = Number.POSITIVE_INFINITY
  /** Tail events since the lift, and since the tail last faded 10% (below `floor`). */
  let coasted = 0
  let level = 0
  let floor = 0
  let liftMag = 0
  /** Tail events in a row that didn't rise. */
  let falling = 0
  let flip = 1

  const apply = (x: number, y: number) => {
    moved = true
    handlers.move(-x * flip, both ? -y * flip : 0)
  }
  const release = () => {
    if (!held.length) return
    let x = 0
    let y = 0
    for (const [hx, hy] of held) {
      x += hx
      y += hy
    }
    held = []
    apply(x, y)
  }
  const finish = () => {
    if (phase === "coast" && fingers(coasted <= PLATEAU / 2 || level >= coasted))
      apply(swallowedX, swallowedY)
    release()
    if (moved) handlers.end()
    moved = false
    phase = "idle"
  }
  const hint = () => {
    if (moved) handlers.lift?.()
  }
  const settle = () => {
    if (moved) handlers.end()
    moved = false
  }
  /** Whether a coast was the fingers after all, given a sign it stopped like fingers do. */
  const fingers = (stopped: boolean) => !certain && stopped && floor >= PLATEAU_PX
  /**
   * The fingers lifted: set aside what was held back and coast through the momentum. Unless it's
   * certain, the gesture ends once the momentum has faded a little, so a false alarm can resume it.
   */
  const lift = (sure: boolean) => {
    swallowedX = swallowedY = 0
    for (const [hx, hy] of held) {
      swallowedX += hx
      swallowedY += hy
    }
    if (heldBy === "lift" || sure) hint()
    held = []
    certain = sure
    if (sure) settle()
    phase = "coast"
    low = sure ? Number.POSITIVE_INFINITY : lastMag
    coasted = level = falling = 0
    floor = liftMag = low
  }
  const remember = (t: number, x: number, y: number, mag: number) => {
    lastGap = t - at
    at = t
    lastX = x
    lastY = y
    lastMag = mag
  }
  const median = (values: readonly number[]) =>
    [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0
  const within = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi

  function feed(event: WheelSample): boolean {
    const t = event.timeStamp
    if (phase !== "idle" && t - at > GESTURE_GAP) finish()
    if (event.deltaMode !== 0 || event.shiftKey) {
      const d =
        event.shiftKey && event.deltaX === 0
          ? event.deltaY
          : Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : 0
      if (!d || !handlers.step) return false
      finish()
      at = t
      if (handlers.accept && !handlers.accept()) return false
      handlers.step(d > 0 ? 1 : -1)
      return true
    }
    const x = event.deltaX
    const y = event.deltaY
    if (typeof event.momentum === "boolean") return told(event, t, x, y)
    if (x === 0 && y === 0) {
      // Chrome on Windows marks the fingers lifting with a -0 event.
      if (Object.is(x, -0) && phase === "pan") {
        at = t
        release()
        lift(true)
      }
      return phase === "pan" || phase === "coast"
    }
    const mag = Math.hypot(x, y)
    const onward = x * lastX + y * lastY > 0
    const dt = t - at
    if (phase === "coast") {
      // Momentum only fades, smoothly (a frame it skips arrives doubled); anything else is a touch.
      const tail =
        onward &&
        mag <= (certain ? low : Math.min(low, lastMag / 1.02)) * 1.1 * Math.max(1, dt / 17) + 1.5 &&
        (certain || mag >= lastMag * (dt / Math.max(lastGap, 1)) * 0.7 - 1)
      if (tail) {
        if (mag < floor * 0.9 || floor === Number.POSITIVE_INFINITY) {
          floor = mag
          level = 0
        } else level++
        low = Math.min(low, mag)
        if (floor === mag && liftMag === Number.POSITIVE_INFINITY) liftMag = mag
        // Faded by a fifth, falling steadily: momentum, so the gesture is over.
        coasted++
        falling = mag <= lastMag ? falling + 1 : 0
        if (floor <= liftMag * 0.81 && liftMag - floor >= 2 && falling >= 3) settle()
        swallowedX += x
        swallowedY += y
        remember(t, x, y, mag)
        if (!fingers(level >= PLATEAU)) return true
      }
      if (tail || (!certain && dt < TOUCH_GAP)) {
        // No pause, so no new touch: those were the fingers all along. Give their travel back.
        phase = "pan"
        moved = true
        fade = 0
        apply(swallowedX + (tail ? 0 : x), swallowedY + (tail ? 0 : y))
        remember(t, x, y, mag)
        return true
      }
      settle()
      phase = "idle"
    } else if (phase === "pass") {
      // A sideways touch after a pause, much smaller than the scroll it stops, is a new gesture.
      if (Math.abs(x) > Math.abs(y) && mag < lastMag * 0.5 && dt >= TOUCH_GAP) phase = "idle"
      else {
        remember(t, x, y, mag)
        return false
      }
    }
    if (phase === "idle") {
      lastMag = 0
      remember(t, x, y, mag)
      if (Math.abs(x) <= Math.abs(y) || (handlers.accept && !handlers.accept())) {
        phase = "pass"
        return false
      }
      phase = "pan"
      flip = event.webkitDirectionInvertedFromDevice === false ? -1 : 1
      moved = false
      travelX = Math.abs(x)
      travelY = Math.abs(y)
      gaps = []
      speeds = []
      fade = 0
      held = []
      apply(x, y)
      return true
    }

    // Panning.
    travelX += Math.abs(x)
    travelY += Math.abs(y)
    if (!both && travelY > travelX * 2 + 24) {
      // It turned into a vertical scroll after all: hand it back to the page.
      finish()
      phase = "pass"
      remember(t, x, y, mag)
      return false
    }
    const ratio = mag / lastMag
    // Does this event carry on a steady fade?
    const flat = mag === lastMag
    const rate = fade > 0 ? (mag / fadeFrom) ** (1 / (fade + 1)) : ratio
    const fading =
      onward &&
      mag >= 3 &&
      ratio <= 1 &&
      ratio >= FADE_STEP &&
      !(flat && plateau) &&
      (fade === 0 || Math.abs(rate - fadeRate) <= FADE_DRIFT)
    if (held.length) {
      const momentum =
        heldBy === "fade"
          ? fading
          : held.length === 1
            ? within(ratio, AFTER_SPIKE) &&
              mag / Math.max(dt, 1) >= spikeSpeed * AFTER_SPIKE_SPEEDUP
            : within(ratio, COAST)
      if (onward && momentum && dt <= 40) {
        if (heldBy === "fade") {
          fade++
          fadeRate = rate
          plateau = flat
        }
        held.push([x, y])
        remember(t, x, y, mag)
        if (held.length >= CONFIRM) lift(false)
        return true
      }
      release()
      fade = 0
    }
    const speed = mag / Math.max(dt, 1)
    const spike =
      gaps.length > 0 &&
      onward &&
      dt >= Math.max(LIFT_GAP, median(gaps) * LIFT_PACE) &&
      mag >= Math.max(LIFT_SPIKE_MIN, lastMag * LIFT_SPIKE) &&
      speed <= median(speeds) * LIFT_SLOWER
    if (fading) {
      if (fade === 0) fadeFrom = lastMag
      fade++
      fadeRate = rate
      plateau = flat
    } else fade = 0
    gaps.push(dt)
    if (gaps.length > 4) gaps.shift()
    remember(t, x, y, mag)
    if (spike || fade >= 2) {
      held = [[x, y]]
      heldBy = spike ? "lift" : "fade"
      spikeSpeed = speed
      return true
    }
    speeds.push(speed)
    if (speeds.length > 3) speeds.shift()
    apply(x, y)
    return true
  }

  /**
   * The browser says which events are momentum: finger events move 1:1 from the first, the first
   * momentum event ends the gesture there and then, and the rest of the tail is swallowed (still
   * claimed, so the page doesn't scroll on with it). A finger event after it is a new touch.
   */
  function told(event: WheelSample, t: number, x: number, y: number): boolean {
    if (event.momentum) {
      if (phase === "pan") {
        hint()
        settle()
        phase = "coast"
        certain = true
      }
      at = t
      return phase === "coast"
    }
    if (phase === "coast") phase = "idle"
    if (x === 0 && y === 0) return phase === "pan"
    const mag = Math.hypot(x, y)
    if (phase === "pass") {
      remember(t, x, y, mag)
      return false
    }
    if (phase === "idle") {
      remember(t, x, y, mag)
      if (Math.abs(x) <= Math.abs(y) || (handlers.accept && !handlers.accept())) {
        phase = "pass"
        return false
      }
      phase = "pan"
      flip = event.webkitDirectionInvertedFromDevice === false ? -1 : 1
      moved = false
      travelX = travelY = 0
    }
    travelX += Math.abs(x)
    travelY += Math.abs(y)
    if (!both && travelY > travelX * 2 + 24) {
      finish()
      phase = "pass"
      remember(t, x, y, mag)
      return false
    }
    remember(t, x, y, mag)
    apply(x, y)
    return true
  }

  return {
    feed,
    /** The wheel went quiet: whatever was in hand is over. */
    idle() {
      finish()
    },
  }
}

/** Feeds `el`'s wheel events to a pan (see `createPan`), ending gestures after a quiet spell. */
export function onPan(el: HTMLElement, handlers: PanHandlers, options?: { axes?: "x" | "xy" }) {
  const pan = createPan(handlers, options)
  let quiet: ReturnType<typeof setTimeout> | undefined
  el.addEventListener(
    "wheel",
    (event) => {
      if (pan.feed(event)) event.preventDefault()
      clearTimeout(quiet)
      quiet = setTimeout(pan.idle, GESTURE_GAP)
    },
    { passive: false },
  )
  return pan
}

/** An option's box in its container (px): where the selection pill sits on it. */
export interface Slot {
  readonly left: number
  readonly right: number
  readonly top: number
}

/** A pill mid-pan: the option it belongs to, and how far (px) the fingers have pushed it off. */
export interface Slide {
  readonly index: number
  readonly offset: number
}

const centre = (s: Slot) => (s.left + s.right) / 2
/** Px from one option's centre to its neighbour's; a neighbour on the next row sits just past it. */
const reach = (slots: readonly Slot[], i: number, dir: number) => {
  const a = slots[i]
  const b = slots[i + dir]
  if (!a || !b) return undefined
  if (Math.abs(a.top - b.top) < 1) return Math.abs(centre(b) - centre(a))
  return (a.right - a.left + b.right - b.left) / 2 + 4
}

/** Pushes the pill `delta` px; it joins a neighbour once past halfway to it, and holds at the ends. */
export function slide(slots: readonly Slot[], from: Slide, delta: number): Slide {
  let { index, offset } = from
  offset += delta
  for (;;) {
    const dir = offset > 0 ? 1 : -1
    const d = reach(slots, index, dir)
    if (d === undefined) {
      const w = slots[index] ? slots[index]!.right - slots[index]!.left : 0
      offset = Math.max(-w, Math.min(w, offset))
      return { index, offset }
    }
    if (Math.abs(offset) <= d / 2) return { index, offset }
    index += dir
    offset -= dir * d
  }
}

/**
 * The pill's live edges: its centre is its option's plus the offset, and its width blends toward
 * the neighbour it heads for, so it's continuous as the selection changes hands. Past the ends it
 * gives way like a rubber band.
 */
export function pillAt(slots: readonly Slot[], { index, offset }: Slide): Slot {
  const a = slots[index]!
  const w = a.right - a.left
  const dir = offset > 0 ? 1 : -1
  const d = reach(slots, index, dir)
  if (d === undefined) {
    const o = offset / (1 + Math.abs(offset) / (w * 0.5))
    return { left: a.left + o, right: a.right + o, top: a.top }
  }
  const b = slots[index + dir]!
  const width = w + (b.right - b.left - w) * (Math.abs(offset) / d)
  const c = centre(a) + offset
  return { left: c - width / 2, right: c + width / 2, top: a.top }
}

const live = new WeakMap<Element, Slot>()
/** The selection pill's edges while a pan holds it (px in `box`), so the GPU can draw it there. */
export const livePill = (box: Element): Slot | undefined => live.get(box)

/**
 * Pans a row of options: the selection pill follows the fingers, the selection changes to
 * whichever option the pill passes halfway to (so one pan can cross several), and when the
 * gesture ends the pill springs back into its option's slot. A notch steps one option.
 */
export function panOptions(
  el: HTMLElement,
  o: {
    /** The pill's positioning box. */
    readonly box: HTMLElement
    readonly pill: HTMLElement
    buttons(): readonly HTMLElement[]
    /** The selected option's index, or -1. */
    selected(): number
    /** `coalesce`: a later change in the same gesture, folded into its undo step. */
    select(index: number, coalesce: boolean): void
    /** Puts the pill back on the selected option, with its transition. */
    rest(): void
    wake?(): void
    /** The pill's narrowest width (px). */
    readonly minWidth?: number
    /** Places the pill's top too, for options that wrap onto rows. */
    readonly rows?: boolean
  },
) {
  let slots: Slot[] = []
  let at: Slide | undefined
  let committed = false
  const rest = () => {
    live.delete(o.box)
    o.pill.style.transition = ""
    o.rest()
    o.wake?.()
  }
  const measure = () =>
    o.buttons().map((b) => {
      const left = b.offsetLeft
      return { left, right: left + Math.max(o.minWidth ?? 0, b.offsetWidth), top: b.offsetTop }
    })
  const paint = (edges: Slot) => {
    live.set(o.box, edges)
    const s = o.pill.style
    s.transition = "none"
    s.left = `${edges.left}px`
    s.right = `${o.box.clientWidth - edges.right}px`
    if (o.rows) s.top = `${edges.top}px`
    o.wake?.()
  }
  const choose = (index: number) => {
    o.select(index, committed)
    committed = true
    tick(o.box)
  }
  onPan(el, {
    accept: () => o.buttons().length > 0,
    move(dx) {
      const selected = o.selected()
      if (!at || selected !== at.index) {
        // A new gesture, or the selection changed under it (a key, an undo).
        if (!at) {
          slots = measure()
          committed = false
        }
        if (!slots.length) return
        at = { index: selected >= 0 ? selected : dx > 0 ? 0 : slots.length - 1, offset: 0 }
        if (selected < 0) choose(at.index)
      }
      const next = slide(slots, at, dx)
      if (next.index !== at.index) choose(next.index)
      at = next
      paint(pillAt(slots, at))
    },
    // The pill heads home as soon as the fingers seem to lift.
    lift: rest,
    end() {
      at = undefined
      rest()
    },
    step(direction) {
      const count = o.buttons().length
      const i = o.selected()
      const next =
        i < 0 ? (direction > 0 ? 0 : count - 1) : Math.max(0, Math.min(count - 1, i + direction))
      if (next !== i) o.select(next, false)
    },
  })
}
