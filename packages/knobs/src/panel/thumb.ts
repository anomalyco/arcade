import { band, moves, type Band } from "./give.js"
import { tick } from "./haptics.js"
import { onPan } from "./swipe.js"

// A switch panned like iOS's: anywhere on its row, a sideways pan takes the thumb in hand. It
// widens as a press does and follows the fingers 1:1, the switch flipping (with a tick) as the
// thumb crosses the middle; past an end its leading edge stretches a little. Let go, a flick
// decides by its direction, otherwise the thumb settles on the side it's on.

/** A switch's geometry (px): the thumb's free travel at rest, its size, its inset, and how much wider a press makes it. */
export interface SwitchBox {
  readonly travel: number
  readonly size: number
  readonly pad: number
  readonly press: number
}

/** How far a held thumb's leading edge stretches past an end (px): a switch is small. */
export const SWITCH_GIVE = 3
/** A lift faster than this (px/ms) is a flick: it decides by its direction. */
export const FLICK = 0.2

/** How far a pressed thumb can travel. */
const room = (box: SwitchBox) => Math.max(0, box.travel - box.press)
/** Where a pressed thumb sits for a value (px from its leftmost spot); mixed waits in the middle. */
export const heldAt = (box: SwitchBox, on: boolean | "mixed") =>
  on === "mixed" ? room(box) / 2 : on ? room(box) : 0
/** Whether a thumb at `at` reads as on: past the middle. */
export const onAt = (box: SwitchBox, at: number) => at > room(box) / 2
/** Moves a held thumb `d` px, giving at the ends. */
export const pushThumb = (box: SwitchBox, from: Band, d: number) =>
  band(from, d, 0, room(box), SWITCH_GIVE)
/** Finger travel (px) over which a held thumb widens to its pressed size, so it never jumps. */
export const PRESS_IN = 6
/**
 * A held thumb's edges (px from the switch's left): pressed wide by `pressed` (0…1) of its press,
 * toward the side it can go (so unpressed it's exactly the resting thumb), its leading edge
 * giving past an end.
 */
export function thumbEdges(box: SwitchBox, { at, give }: Band, pressed = 1): [number, number] {
  const missing = box.press * (1 - Math.max(0, Math.min(1, pressed)))
  const u = room(box) > 0 ? at / room(box) : 0
  return [
    box.pad + at + missing * u + Math.min(0, give),
    box.pad + at + box.size + box.press - missing * (1 - u) + Math.max(0, give),
  ]
}
/** How a pan lets go: a flick goes its way, anything slower stays on the side the thumb is on. */
export const settleOn = (box: SwitchBox, at: number, speed: number) =>
  Math.abs(speed) >= FLICK ? speed > 0 : onAt(box, at)

const live = new WeakMap<Element, readonly [number, number]>()
/** A held thumb's edges (px from the switch's left), so the GPU can draw it there too. */
export const liveThumb = (toggle: Element) => live.get(toggle)

/** Pans `toggle`'s thumb from anywhere on `row`; `set` changes the value (`coalesce`: a later change in one gesture). */
export function panSwitch(
  row: HTMLElement,
  toggle: HTMLElement,
  o: {
    value(): boolean | "mixed"
    set(on: boolean, coalesce: boolean): void
    wake(): void
  },
) {
  const thumb = toggle.firstElementChild as HTMLElement
  let box: SwitchBox | undefined
  let at: Band = { at: 0, give: 0 }
  let shown = false
  let changed = false
  /** Finger travel since the thumb was taken (px), for its press. */
  let travelled = 0
  const recent = moves()
  const measure = (): SwitchBox | undefined => {
    const w = toggle.clientWidth
    const h = toggle.clientHeight
    if (!w || !h) return undefined
    const pad = thumb.offsetTop
    const size = h - pad * 2
    // As much wider as its CSS press makes it (.knobs-toggle:active i).
    return {
      travel: w - pad * 2 - size,
      size,
      pad,
      press: Math.min(4, Math.max(0, w - pad * 2 - size)),
    }
  }
  const paint = () => {
    if (!box) return
    const edges = thumbEdges(box, at, travelled / PRESS_IN)
    live.set(toggle, edges)
    const s = thumb.style
    s.transition = "none"
    s.left = `${edges[0]}px`
    s.right = `${toggle.clientWidth - edges[1]}px`
    o.wake()
  }
  const choose = (on: boolean) => {
    if (o.value() === on) return
    o.set(on, changed)
    changed = true
    tick(toggle)
  }
  const letGo = (speed: number) => {
    if (!box) return
    const b = box
    box = undefined
    if (shown) choose(settleOn(b, at.at, speed))
    shown = false
    live.delete(toggle)
    // Back to the stylesheet: the thumb glides to its side on the switch's own transitions.
    thumb.style.transition = thumb.style.left = thumb.style.right = ""
    row.classList.remove("knobs-active")
    o.wake()
  }
  onPan(row, {
    move(dx) {
      if (!box) {
        box = measure()
        if (!box) return
        at = { at: heldAt(box, o.value()), give: 0 }
        changed = false
        shown = true
        travelled = 0
        recent.reset()
        row.classList.add("knobs-active")
      }
      recent.add(dx)
      travelled += Math.abs(dx)
      const before = at.give
      at = pushThumb(box, at, dx)
      if (before === 0 && at.give !== 0) tick(toggle, "limit")
      if (o.value() === "mixed" ? at.at !== heldAt(box, "mixed") : onAt(box, at.at) !== o.value())
        choose(onAt(box, at.at))
      paint()
    },
    lift: () => letGo(recent.speed()),
    end: () => letGo(0),
    step(direction) {
      const on = direction > 0
      if (o.value() !== on) {
        o.set(on, false)
        tick(toggle)
      }
    },
  })
}
