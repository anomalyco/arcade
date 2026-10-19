import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { moveClusterLabel, onKeyLayoutChange } from "@arcade/kit/client/controls"
import type { Player } from "../../player"
import type { WorldContext } from "../../world/context"
import { objectiveText } from "../objective"
import { HINT } from "./copy"

// Play-mode control hints: a quiet strip of minimal key caps at the bottom-left (full at the start of each run, faded to
// a low-opacity line after a few minutes, or always full / hidden per Settings; H brings it back up, or puts it back),
// and one-time contextual hints
// at the bottom centre: F the first time the view gets dark, M with the first objective, C near the first low space.
// Seen hints are remembered in localStorage. The shell calls `update` every frame and `afterRender` after the world
// draws (the darkness check reads a 4×4 copy of the frame once a second until the F hint has been shown).

export type ControlsMode = "always" | "auto" | "off"
type StripState = "on" | "dim" | "off"
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
  root.className = "hints akc-minimal"
  root.innerHTML = `<div class="hints-strip"></div><div class="hints-toast"></div>`
  document.body.append(root)
  const strip = root.firstElementChild as HTMLDivElement
  const toast = root.lastElementChild as HTMLDivElement
  const cap = (code: string, label?: string) => keyCapHtml(code, { minimal: true, ...(label ? { label } : {}) })
  const item = (keys: string, what: string) => `<span class="hints-item">${keys}<span>${what}</span></span>`
  const renderStrip = () => {
    strip.innerHTML = [
      item(cap("KeyW", moveClusterLabel()), "move"),
      item(cap("ShiftLeft"), "run"),
      item(cap("KeyC"), "crouch"),
      item(cap("Space"), "jump"),
      item(cap("KeyE"), "interact"),
      item(cap("KeyF"), "flashlight"),
      item(cap("KeyM"), "map"),
      item(cap("Escape"), "pause"),
    ].join("")
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

  let mode: ControlsMode = "auto"
  let active = false
  /** Seconds of play this run (the strip's countdown in "auto"). */
  let played = 0
  /** H: null follows the mode; otherwise overrides it until the next run. */
  let manual: StripState | null = null
  let shown: StripState = "off"
  const byMode = (): StripState => (mode === "always" ? "on" : mode === "off" ? "off" : played < HINT.stripSeconds ? "on" : "dim")
  let toastUntil = 0
  let toastQueue: ContextHint[] = []
  let darkFor = 0
  let lumaAt = 0
  let lowAt = 0
  let lastLuma = -1

  const TOASTS: Record<ContextHint, () => string> = {
    flashlight: () => `${cap("KeyF")}<span>${HINT.context.flashlight}</span>`,
    map: () => `${cap("KeyM")}<span>${HINT.context.map}</span>`,
    crouch: () => `${cap("KeyC")}<span>${HINT.context.crouch}</span>`,
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
    /** A run reached explore (`true`) or left it (`false`): the strip's countdown restarts each run. */
    setActive(on: boolean) {
      if (on && !active) {
        played = 0
        manual = null
      }
      active = on
      if (!on) toastQueue = []
    },
    /** Automation: adds seconds of play (to see the faded strip without waiting). */
    advance(seconds: number) {
      played += seconds
    },
    /** H: show or hide the strip. */
    toggle() {
      manual = shown === "on" ? (byMode() === "on" ? "off" : null) : "on"
    },
    /** `visible`: explore and unpaused (the strip and toasts hide behind the menus). */
    update(dt: number, visible: boolean) {
      if (!active) {
        root.classList.remove("on")
        return
      }
      root.classList.toggle("on", visible)
      if (!visible) return
      played += dt
      shown = manual ?? byMode()
      strip.classList.toggle("on", shown === "on")
      strip.classList.toggle("dim", shown === "dim")

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
