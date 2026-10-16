// Readouts that roll: numbers and the text between them ("0.85, 0.19", "38–74 %", "90°"), each
// number rolling as a slider's readout does, and names that crossfade. The DOM rolls with
// rolling-number; the canvas draws the same motion from each number's places (see `syncPlaces`).
import { createRollingNumber, type RollingNumberController } from "@kitlangton/rolling-number"
import { Roll, rollTarget } from "./motion.js"
import type { DigitPlace } from "./slider.js"

/**
 * Brings a readout's places to `text` (a place per character, ones first), as rolling-number
 * does: each digit a wheel rolling through every face in the value's direction (98 → 108 rolls
 * the tens 9 → 0 forwards), new places rising in after a short hold, cascading outward, and
 * leaving places fading over ~65% of `ms`. `ms` 0 places it.
 */
export function syncPlaces(
  places: DigitPlace[],
  text: string,
  trend: number,
  ms: number,
  delay: number,
  entering = true,
) {
  const now = performance.now()
  const live = places.filter((p) => !p.exiting).length
  const step = Math.min(ms * 0.045, (ms * 0.3) / Math.max(1, text.length - live))
  for (let j = 0; j < Math.max(text.length, places.length); j++) {
    const ch = j < text.length ? text[text.length - 1 - j]! : undefined
    const place = places[j]
    if (ch === undefined) {
      if (place && !place.exiting) {
        place.exiting = true
        place.presence.set(0, ms * 0.65, now, delay)
      }
      continue
    }
    const digit = ch >= "0" && ch <= "9" ? Number(ch) : Number.NaN
    if (!place) {
      const rise = ms > 0 && entering
      const hold = ms > 0 ? delay + Math.max(0, j - live) * step : 0
      const presence = new Roll(rise ? 0 : 1)
      if (rise) presence.set(1, ms, now, hold)
      places[j] = {
        ch,
        wheel: new Roll(Number.isNaN(digit) ? 0 : digit),
        presence,
        enterAt: now + hold,
        enterMs: rise ? ms : 0,
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
    places.length > text.length &&
    places.at(-1)!.exiting &&
    (ms <= 0 || places.at(-1)!.presence.resting(now))
  )
    places.pop()
}

/** How long a readout rolls (ms): the panel's --k-roll, 320 by default. */
export function rollMs(el: Element) {
  const n = parseFloat(getComputedStyle(el).getPropertyValue("--k-roll"))
  return Number.isFinite(n) ? Math.max(0, n) : 320
}

const reducedMotion = (el: Element) =>
  el.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false
const onCanvas = (el: Element) => el.closest('[data-gpu-active="true"]') !== null

/** A readout's parts: text, or a number shown to `decimals` places. */
export type ReadoutPart = string | { readonly value: number; readonly decimals: number }

/** A part as laid out: its element, its text, and a number's places for the canvas. */
export interface ReelSegment {
  readonly el: HTMLElement
  text: string
  readonly places?: DigitPlace[]
}

export interface RollingReadout {
  readonly host: HTMLElement
  readonly segments: readonly ReelSegment[]
  /** Everything it shows, as one string. */
  readonly text: string
  /**
   * Shows `parts`. Numbers roll over `ms` (0 places them: the first paint, the user's own hand,
   * a landing), after `delay` ms for the row's turn in a cascade.
   */
  show(parts: readonly ReadoutPart[], ms: number, delay?: number): void
  dispose(): void
}

const readouts = new WeakMap<Element, RollingReadout>()
/** The rolling readout an element holds, if it holds one (the canvas draws its segments). */
export const rollingReadoutOf = (el: Element) => readouts.get(el)

/** A number as both renderers spell it: rounded to its places first, so −0.001 reads 0.00. */
const settle = (value: number, decimals: number) => {
  const v = Number(value.toFixed(decimals))
  return v === 0 ? 0 : v
}

/** Makes `host`'s content a rolling readout (its children are the readout's from now on). */
export function rollingReadout(host: HTMLElement): RollingReadout {
  const doc = host.ownerDocument
  let shape = ""
  let segments: (ReelSegment & { roller?: RollingNumberController; value?: number })[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    clearTimeout(timer)
    for (const s of segments) s.roller?.destroy()
  }
  const self: RollingReadout = {
    host,
    get segments() {
      return segments
    },
    get text() {
      return segments.map((s) => s.text).join("")
    },
    show(parts, ms, delay = 0) {
      if (ms > 0 && reducedMotion(host)) ms = 0
      const next = parts.map((p) => (typeof p === "string" ? "t" : `n${p.decimals}`)).join("|")
      if (next !== shape) {
        // A new shape (a different count of numbers, mixed "—") is placed, not rolled.
        clear()
        shape = next
        segments = parts.map((p) => {
          if (typeof p === "string") {
            const el = doc.createElement("span")
            el.textContent = p
            return { el, text: p }
          }
          const el = doc.createElement("span")
          el.className = "knobs-digits"
          const value = settle(p.value, p.decimals)
          const text = value.toFixed(p.decimals)
          const roller = createRollingNumber(el, {
            value,
            format: {
              minimumFractionDigits: p.decimals,
              maximumFractionDigits: p.decimals,
              useGrouping: false,
            },
            duration: 1,
            motionBlur: true,
          })
          const places: DigitPlace[] = []
          syncPlaces(places, text, 0, 0, 0)
          return { el, text, places, roller, value }
        })
        host.replaceChildren(...segments.map((s) => s.el))
        return
      }
      clearTimeout(timer)
      const dom = ms > 0 && !onCanvas(host)
      const rolls: (() => void)[] = []
      parts.forEach((p, i) => {
        const s = segments[i]!
        if (typeof p === "string") {
          if (s.text !== p) s.el.textContent = s.text = p
          return
        }
        const value = settle(p.value, p.decimals)
        if (value === s.value) return
        const trend = Math.sign(value - (s.value ?? value))
        s.value = value
        s.text = value.toFixed(p.decimals)
        syncPlaces(s.places!, s.text, trend, ms, ms > 0 ? delay : 0)
        // Never rolling-number's unanimated path (its finish() resets the reels, so the next
        // change would jump): a 1 ms roll is a snap that keeps it warm.
        rolls.push(() =>
          s.roller!.update({ value, animated: true, duration: dom ? ms : 1, motionBlur: dom }),
        )
      })
      const run = () => {
        for (const roll of rolls) roll()
      }
      if (dom && delay > 0) timer = setTimeout(run, delay)
      else run()
    },
    dispose() {
      clear()
      segments = []
      shape = ""
      readouts.delete(host)
    },
  }
  readouts.set(host, self)
  return self
}

/**
 * Sets a name-like readout (an easing's or curve's name, a hex colour). `fade` crossfades the old
 * text out over the new, where it was; without it (the user's own hand) the text just changes.
 * The canvas does the same, reading `data-text` and `data-fade`.
 */
export function fadeText(el: HTMLElement, text: string, fade: boolean) {
  const was = el.dataset.text ?? el.textContent ?? ""
  if (was === text) return
  el.dataset.text = text
  el.toggleAttribute("data-fade", fade)
  const now = el.ownerDocument.createElement("span")
  now.textContent = text
  el.replaceChildren(now)
  if (!fade || !was || !el.isConnected || onCanvas(el) || reducedMotion(el)) return
  const ghost = el.ownerDocument.createElement("span")
  ghost.className = "knobs-ghost"
  ghost.setAttribute("aria-hidden", "true")
  ghost.textContent = was
  el.append(ghost)
  now.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 160,
    easing: "cubic-bezier(.2,.8,.2,1)",
  })
  ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 130,
    easing: "cubic-bezier(.4,0,1,1)",
    fill: "forwards",
  }).onfinish = () => ghost.remove()
}
