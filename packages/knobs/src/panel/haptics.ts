// Light haptic ticks on phones: a stepped slider crossing a stop, the default's magnet catching, a
// choice changing hands mid-pan, a switch flipping. Android plays them through navigator.vibrate.
// Safari has no Vibration API; its one haptic is the system tick of <input type=checkbox switch>.
// iOS 17.4–26.4 plays it for a script click on the switch's label made during a user gesture;
// iOS 26.5 and later only for the user's own tap, so switches carry a label for a hidden switch
// under the finger (see `tapTick`). Panels mounted with `haptics: false` (data-haptics="off"), a
// reduced-motion preference and pointers that aren't touch get nothing.

import { cue, type SoundCue } from "./sound.js"

/** The shortest gap (ms) between two ticks: a quick flick across many stops doesn't buzz. */
const MIN_GAP = 45
/** How long (ms) Android's motor runs for a tick. */
const PULSE = 8

let last = Number.NEGATIVE_INFINITY
const switches = new WeakMap<Document, HTMLInputElement>()

const switchSupported = (doc: Document) => {
  const win = doc.defaultView as (Window & typeof globalThis) | null
  return Boolean(win && "switch" in win.HTMLInputElement.prototype)
}
const canVibrate = (doc: Document) =>
  typeof (doc.defaultView?.navigator as Navigator | undefined)?.vibrate === "function"

/** The document's hidden switch, kept rendered (not display:none) so WebKit plays its tick. */
function hiddenSwitch(doc: Document): HTMLInputElement {
  let input = switches.get(doc)
  if (input?.isConnected) return input
  input = doc.createElement("input")
  input.type = "checkbox"
  input.setAttribute("switch", "")
  input.id = `knobs-haptic-${Math.random().toString(36).slice(2, 8)}`
  input.tabIndex = -1
  input.setAttribute("aria-hidden", "true")
  input.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;margin:0;opacity:0;pointer-events:none"
  doc.body.append(input)
  switches.set(doc, input)
  return input
}

const wanted = (from: Element) => {
  const win = from.ownerDocument.defaultView
  if (!win || from.closest('[data-haptics="off"]')) return false
  return (
    win.matchMedia("(any-pointer: coarse)").matches &&
    !win.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/**
 * One light tick for a change made by `from`'s control, unless ticks are off or too close. With
 * `sound`, a panel that plays sounds plays that cue at the same moment (see sound.ts).
 */
export function tick(from: Element, sound?: SoundCue): void {
  if (sound) cue(from, sound)
  if (!wanted(from)) return
  const now = performance.now()
  if (now - last < MIN_GAP) return
  const doc = from.ownerDocument
  if (canVibrate(doc)) {
    last = now
    try {
      doc.defaultView!.navigator.vibrate(PULSE)
    } catch {}
    return
  }
  if (!switchSupported(doc)) return
  last = now
  const input = hiddenSwitch(doc)
  const label = doc.createElement("label")
  label.htmlFor = input.id
  label.hidden = true
  doc.body.append(label)
  label.click()
  label.remove()
}

/**
 * Lays a label for the hidden switch over `target` (a positioned button), so a tap on it is the
 * user's own tap on a switch: the only tick iOS 26.5+ plays. Only where Safari's switch exists and
 * there's no Vibration API (iPhone); returns whether it did, so the caller skips `tick` for taps.
 */
export function tapTick(target: HTMLElement): boolean {
  const doc = target.ownerDocument
  if (!switchSupported(doc) || canVibrate(doc) || !wanted(target)) return false
  const label = doc.createElement("label")
  label.className = "knobs-tap-tick"
  label.htmlFor = hiddenSwitch(doc).id
  label.setAttribute("aria-hidden", "true")
  target.append(label)
  return true
}
