import { keyLabel, onKeyLayoutChange } from "@arcade/kit/client/controls"
import type { Player } from "../../player"
import type { WorldContext } from "../../world/context"
import { objectiveText } from "../objective"
import { HINT } from "./copy"

// Play-mode controls (picked in the controls lab): a quiet strip at the bottom-left with only the three keys worth
// teaching, `[C] crouch  [F] flashlight  [M] map`, in plain bracket text set like the objective's corner line (the HUD
// typewriter, small caps, its warm off-white). Always shown in explore (Settings → Show controls: Always / Off).
// With the strip off, the same three still get one-time contextual hints at the bottom centre, in the same style:
// F the first time the view gets dark, M with the first objective, C near the first low space (remembered in
// localStorage). The shell calls `update` every frame and `afterRender` after the world draws (the darkness check
// reads a 4×4 copy of the frame once a second until the F hint has been shown).

export type ControlsMode = "always" | "off"
type ContextHint = "flashlight" | "map" | "crouch"

const SEEN_KEY = "ashwood.hints.seen"
/** Mean frame luminance (0..1, display-referred) under which the view counts as dark (measured: lot 0.049, lobby 0.049, corridor 0.068, forest 0.037). */
const DARK_LUMA = 0.04
/** Seconds the view must stay dark before the F hint. */
const DARK_HOLD = 1.5
/** A low space: something overhead between these heights above the feet (m), within REACH (m) horizontally. */
const LOW_MIN = 0.9
const LOW_MAX = 1.6
const REACH = 1.2

export function createHints(ctx: WorldContext, player: Player) {
  const root = document.createElement("div")
  root.className = "hints"
  root.innerHTML = `<div class="hints-strip"></div><div class="hints-toast"></div>`
  document.body.append(root)
  const strip = root.firstElementChild as HTMLDivElement
  const toast = root.lastElementChild as HTMLDivElement
  /** Plain bracket text with the QWERTY name of the physical key (docs/controls.md). */
  const key = (code: string) => `<span class="hints-key">[${keyLabel(code)}]</span>`
  const item = (code: string, what: string) => `<span class="hints-item">${key(code)}<span>${what}</span></span>`
  const renderStrip = () => {
    strip.innerHTML = [item("KeyC", "crouch"), item("KeyF", "flashlight"), item("KeyM", "map")].join("")
  }
  renderStrip()
  onKeyLayoutChange(renderStrip)

  let seen: Set<string>
  try {
    seen = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[])
  } catch {
    seen = new Set()
  }
  const remember = (id: string) => {
    seen.add(id)
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]))
    } catch {}
  }

  let mode: ControlsMode = "always"
  let active = false
  /** Seconds of play this run (paces the low-space and darkness checks). */
  let played = 0
  let toastUntil = 0
  let toastQueue: ContextHint[] = []
  let darkFor = 0
  let lumaAt = 0
  let lowAt = 0
  let lastLuma = -1

  const TOASTS: Record<ContextHint, () => string> = {
    flashlight: () => `${key("KeyF")}<span>${HINT.context.flashlight}</span>`,
    map: () => `${key("KeyM")}<span>${HINT.context.map}</span>`,
    crouch: () => `${key("KeyC")}<span>${HINT.context.crouch}</span>`,
  }
  function offer(id: ContextHint) {
    if (seen.has(id) || toastQueue.includes(id)) return
    toastQueue.push(id)
  }

  const probe = document.createElement("canvas")
  probe.width = probe.height = 4
  const pg = probe.getContext("2d", { willReadFrequently: true })!

  /** Something overhead the body would hit standing (pipes, a crawl space), close by. */
  function lowSpaceNear() {
    const p = player.state.pos
    for (const c of ctx.colliders) {
      const above = c.min[1] - p.y
      if (above < LOW_MIN || above > LOW_MAX || c.max[1] - c.min[1] > 2.5) continue
      const dx = Math.max(c.min[0] - p.x, 0, p.x - c.max[0])
      const dz = Math.max(c.min[2] - p.z, 0, p.z - c.max[2])
      if (dx * dx + dz * dz < REACH * REACH) return true
    }
    return false
  }

  return {
    el: root,
    get lastLuma() {
      return lastLuma
    },
    setMode(m: ControlsMode) {
      mode = m
    },
    /** A run reached explore (`true`) or left it (`false`). */
    setActive(on: boolean) {
      if (on && !active) played = 0
      active = on
      if (!on) toastQueue = []
    },
    /** `visible`: explore and unpaused (hidden behind the menus, in the intro and other cutscenes). */
    update(dt: number, visible: boolean) {
      if (!active) {
        root.classList.remove("on")
        return
      }
      root.classList.toggle("on", visible)
      if (!visible) return
      played += dt
      strip.classList.toggle("on", mode === "always")
      // The strip already teaches the three keys; the one-time hints are for players who turned it off.
      if (mode === "always") return

      if (!seen.has("map") && objectiveText()) offer("map")
      if (!seen.has("crouch") && played - lowAt > 0.25) {
        lowAt = played
        if (lowSpaceNear()) offer("crouch")
      }
      if (!seen.has("flashlight")) {
        darkFor = !player.flashlight && lastLuma >= 0 && lastLuma < DARK_LUMA ? darkFor + dt : 0
        if (darkFor > DARK_HOLD) offer("flashlight")
        if (player.flashlight) remember("flashlight")
      }

      const now = performance.now()
      if (toast.classList.contains("on") && now > toastUntil) toast.classList.remove("on")
      if (!toast.classList.contains("on") && now > toastUntil + 900 && toastQueue.length) {
        const id = toastQueue.shift()!
        remember(id)
        toast.innerHTML = TOASTS[id]()
        toast.classList.add("on")
        toastUntil = now + HINT.contextSeconds * 1000
      }
    },
    /** After the world drew a frame (same task): the darkness check, once a second, until the F hint is done. */
    afterRender(source: HTMLCanvasElement) {
      if (!active || seen.has("flashlight") || played - lumaAt < 1) return
      lumaAt = played
      pg.drawImage(source, 0, 0, 4, 4)
      const d = pg.getImageData(0, 0, 4, 4).data
      let sum = 0
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!
      lastLuma = sum / 16 / 255
    },
  }
}
