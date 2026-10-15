/**
 * Character rings: small BotW-style gauges drawn beside a survivor for the state that matters this second (stamina,
 * reload, health when hurt, battery when low). Each ring appears only while it has something to say and fades out
 * after, so a survivor walking around at full health shows nothing.
 *
 * Shape tells the rings apart (stamina is a bare ring, reload has the magazine count inside, health a cross, battery
 * a cell); colour tells the range: pale is fine, amber is low, red is spent and flashes.
 *
 * `VitalsModel` is DOM-free and unit-tested; `VitalsLayer` draws it with pooled elements.
 */

import { PISTOL_RELOAD_TIME } from "../../shared/combat"
import type { Survivor } from "../../shared/session"

export type MeterId = "stamina" | "reload" | "health" | "battery"
export type MeterState = "ok" | "low" | "critical"

/** What the rings read from an actor. `null` means the value is not known (remote survivors' private state). */
export type VitalsInput = {
  health: number
  maxHealth: number
  stamina: number | null
  sprinting: boolean
  exhausted: boolean
  /** 0..1 while a reload is in progress, otherwise null. */
  reload: number | null
  pistol: boolean
  magAmmo: number | null
  reserveAmmo: number | null
  flashlightOn: boolean
  battery: number | null
  batteryDepleted: boolean
  /** 0..1 light output; drives the low-battery flicker. */
  flashlightOutput: number
}

export type VitalsTuning = {
  /** Stamina fraction below which the stamina ring turns amber. */
  staminaLow: number
  /** Battery fraction below which the battery ring appears. */
  batteryLow: number
  /** Health at or below which the health ring stays up and turns red. */
  healthLow: number
}

export type Meter = {
  readonly id: MeterId
  fill: number
  state: MeterState
  /** Stamina is being spent right now. */
  draining: boolean
  text: string
  alpha: number
  /** Session time the meter last had a reason to show. */
  lastActive: number
  /** Light-output flicker multiplier, 1 when steady. */
  flicker: number
}

/** Order outward from the body: the most frequent ring sits nearest. */
export const METER_ORDER: readonly MeterId[] = ["stamina", "reload", "health", "battery"]

const FADE_IN = 0.12
const FADE_OUT = 0.35
/** Seconds a ring lingers after its reason to show ends. */
const HOLD: Record<MeterId, number> = { stamina: 0.6, reload: 0.9, health: 0.6, battery: 0.8 }
/** Seconds the health ring stays up after a hit. */
const HURT_SHOW = 3

export class ActorVitals {
  readonly meters: Meter[] = METER_ORDER.map((id) => ({
    id,
    fill: 1,
    state: "ok" as MeterState,
    draining: false,
    text: "",
    alpha: 0,
    lastActive: -Infinity,
    flicker: 1,
  }))
  private prevHealth = -1
  private hurtAt = -Infinity
  private prevReload: number | null = null

  meter(id: MeterId): Meter {
    return this.meters[METER_ORDER.indexOf(id)]!
  }

  /** Reads one frame of state at session time `now` and eases each ring's opacity by `dt`. */
  observe(v: VitalsInput, tuning: VitalsTuning, now: number, dt: number): void {
    // Stamina: shown while not full or being spent. Remote survivors only report exhaustion.
    const st = this.meter("stamina")
    const stamina = v.stamina ?? (v.exhausted ? 0 : 1)
    st.fill = clamp01(stamina)
    st.draining = v.sprinting && !v.exhausted
    st.state = v.exhausted ? "critical" : stamina < tuning.staminaLow ? "low" : "ok"
    st.text = ""
    if (v.exhausted || (v.stamina !== null && (stamina < 0.999 || v.sprinting))) st.lastActive = now

    // Reload: a ring around the magazine count while reloading, briefly after, and when the magazine is empty.
    const rl = this.meter("reload")
    const empty = v.pistol && v.magAmmo === 0 && (v.reserveAmmo ?? 0) > 0
    if (v.reload !== null) {
      rl.fill = clamp01(v.reload)
      rl.state = "ok"
      rl.lastActive = now
    } else if (this.prevReload !== null) {
      rl.fill = 1
    }
    if (empty && v.reload === null) {
      rl.fill = 0
      rl.state = "critical"
      rl.lastActive = now
    } else if (v.reload === null && rl.state === "critical") {
      rl.state = "ok"
    }
    rl.draining = false
    rl.text = v.magAmmo === null ? "" : String(v.magAmmo)
    this.prevReload = v.reload

    // Health: after a hit, and for as long as it stays low.
    const hp = this.meter("health")
    if (this.prevHealth >= 0 && v.health < this.prevHealth - 1e-3) this.hurtAt = now
    this.prevHealth = v.health
    const frac = v.maxHealth > 0 ? v.health / v.maxHealth : 1
    hp.fill = clamp01(frac)
    hp.state = v.health <= tuning.healthLow ? "critical" : frac < 0.6 ? "low" : "ok"
    hp.draining = false
    hp.text = ""
    if (now - this.hurtAt < HURT_SHOW || (v.health < v.maxHealth && v.health <= tuning.healthLow)) hp.lastActive = now

    // Battery: only when it is running out or already dead.
    const bt = this.meter("battery")
    const battery = v.battery ?? 1
    bt.fill = clamp01(battery)
    bt.state = v.batteryDepleted ? "critical" : "low"
    bt.draining = false
    bt.text = ""
    bt.flicker = v.flashlightOn && !v.batteryDepleted ? 0.55 + 0.45 * clamp01(v.flashlightOutput) : 1
    if (v.batteryDepleted || (v.battery !== null && v.flashlightOn && battery < tuning.batteryLow)) bt.lastActive = now

    for (const m of this.meters) {
      const want = now - m.lastActive <= HOLD[m.id] ? 1 : 0
      const rate = want > m.alpha ? 1 / FADE_IN : 1 / FADE_OUT
      m.alpha = want > m.alpha ? Math.min(want, m.alpha + dt * rate) : Math.max(want, m.alpha - dt * rate)
    }
  }

  /** Sum of visible ring weights; 0 means nothing is drawn. */
  get presence(): number {
    let n = 0
    for (const m of this.meters) n += m.alpha
    return n
  }
}

export type VitalsPlacement = {
  /** Anchor point in CSS pixels. */
  x: number
  y: number
  /** Own-size alignment fractions of the ring row (see `Align`). */
  ax: number
  ay: number
  /** Row grows right-to-left (rings nearest the body sit at the right end). */
  reverse: boolean
  scale: number
}

/** Where an actor's meters go this frame. Each meter takes the first layout that accepts it. */
export type VitalsLayout = {
  /**
   * Stamina and health as two arcs of one ring on the ground around the feet. `points` is the projected ground circle,
   * GROUND_SEGMENTS points as flat [x0, y0, x1, y1, …], point i at plan angle 2πi/GROUND_SEGMENTS from +x (the
   * screen-bottom point is at index GROUND_SEGMENTS / 4).
   */
  ground?: { points: readonly number[]; scale: number }
  /** Every meter as a thin bar, stacked downward from (x, y) and centred on x. */
  bars?: { x: number; y: number; scale: number }
  /** Remaining meters as rings in a row. */
  row?: VitalsPlacement
}

type Mode = "row" | "bar" | "ground" | ""
type RingNode = {
  el: HTMLDivElement
  label: HTMLElement
  state: string
  fill: string
  text: string
  transform: string
  opacity: string
  drain: string
  mode: Mode
  size: string
}

const GROUND_METERS = new Set<MeterId>(["stamina", "health"])

/** Points in a projected ground circle (see `VitalsLayout.ground`). */
export const GROUND_SEGMENTS = 48
/** Half-gap at the front of the ring, between the stamina and health arcs (radians of plan angle). */
const GROUND_FRONT_GAP = 0.09 * Math.PI
/** Length of each arc. What is left at the back (about 110°) is where the body stands, so nothing crosses the legs. */
const GROUND_ARC = 0.6 * Math.PI

/** Screen point of the projected ground circle at plan angle `theta`, interpolated between samples. */
function ringPoint(points: readonly number[], theta: number): [number, number] {
  const n = GROUND_SEGMENTS
  let f = ((theta / (2 * Math.PI)) * n) % n
  if (f < 0) f += n
  const i = Math.floor(f)
  const j = (i + 1) % n
  const t = f - i
  return [points[i * 2]! + (points[j * 2]! - points[i * 2]!) * t, points[i * 2 + 1]! + (points[j * 2 + 1]! - points[i * 2 + 1]!) * t]
}

/** SVG path along the ground circle from the front gap outward, toward the left (dir 1) or the right (dir -1). */
export function groundArc(points: readonly number[], dir: 1 | -1): string {
  const start = Math.PI / 2 + dir * GROUND_FRONT_GAP
  const steps = 18
  let d = ""
  for (let k = 0; k <= steps; k++) {
    const [x, y] = ringPoint(points, start + dir * GROUND_ARC * (k / steps))
    d += `${k ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`
  }
  return d
}

/** Lowest screen point of the ring (its front), for starting callouts below it. */
export function groundFront(points: readonly number[]): number {
  return ringPoint(points, Math.PI / 2)[1]
}

const SVG_NS = "http://www.w3.org/2000/svg"
type GroundArc = { g: SVGGElement; paths: SVGPathElement[]; fill: SVGPathElement; d: string; state: string; p: string; opacity: string }
type GroundRing = { svg: SVGSVGElement; arcs: Record<"stamina" | "health", GroundArc>; width: string }

/** Pooled DOM meters for any number of actors. Idle actors write nothing. */
export class VitalsLayer {
  readonly root: HTMLDivElement
  private nodes = new Map<string, RingNode[]>()
  private grounds = new Map<string, GroundRing>()
  private reduced = ""
  /** Device pixels per CSS pixel; ring positions snap to it. */
  pixelRatio = typeof devicePixelRatio === "number" ? devicePixelRatio : 1

  constructor(
    parent: HTMLElement,
    public size = 20,
  ) {
    this.root = document.createElement("div")
    this.root.className = "vitals"
    this.root.setAttribute("aria-hidden", "true")
    parent.append(this.root)
  }

  /** Row extent in pixels along y for an actor (how much room it takes under or over the body). */
  rowSize(scale: number): number {
    return this.size * scale
  }

  /** Height of the bar stack, weighted by opacity. */
  barsHeight(vitals: ActorVitals, scale: number, hidden?: ReadonlySet<MeterId>): number {
    const { h, gap } = this.bar(scale)
    let n = 0
    for (const m of vitals.meters) if (!hidden?.has(m.id)) n += m.alpha * (h + gap)
    return Math.max(0, n - gap)
  }

  /** Width of the visible row, with each ring weighted by its opacity so neighbours slide in and out smoothly. */
  rowWidth(vitals: ActorVitals, scale: number, skip?: ReadonlySet<MeterId>): number {
    const d = this.size * scale
    const gap = d * 0.28
    let w = 0
    for (const m of vitals.meters) if (!skip?.has(m.id)) w += m.alpha * (d + gap)
    return Math.max(0, w - gap)
  }

  draw(actorId: string, vitals: ActorVitals, layout: VitalsLayout | VitalsPlacement | null, reducedMotion: boolean, hidden?: ReadonlySet<MeterId>): void {
    const reduced = String(reducedMotion)
    if (this.reduced !== reduced) {
      this.reduced = reduced
      this.root.dataset.reduced = reduced
    }
    const at: VitalsLayout | null = layout && "ax" in layout ? { row: layout } : layout
    let nodes = this.nodes.get(actorId)
    if (!at?.ground) this.hideGround(actorId)
    if (!at || vitals.presence <= 0.001) {
      if (nodes) for (const n of nodes) setOpacity(n, "0")
      this.hideGround(actorId)
      return
    }
    if (!nodes) {
      nodes = METER_ORDER.map((id) => this.createNode(id))
      this.nodes.set(actorId, nodes)
    }
    const meters = vitals.meters
    const mode = (m: Meter): Mode =>
      hidden?.has(m.id) ? "" : at.ground && GROUND_METERS.has(m.id) ? "ground" : at.bars ? "bar" : at.row ? "row" : ""

    const snap = (v: number) => Math.round(v * this.pixelRatio) / this.pixelRatio
    // Rings in a row, each sized by its own width and font size (never a scale transform) and placed on whole device
    // pixels, so the ring edge and the magazine count stay crisp.
    if (at.row) {
      const row = at.row
      const d = Math.round(this.size * row.scale)
      const gap = d * 0.28
      const skip = new Set(meters.filter((m) => mode(m) !== "row").map((m) => m.id))
      const width = this.rowWidth(vitals, row.scale, skip)
      const left = row.x + row.ax * width
      const top = row.y + row.ay * d
      let offset = 0
      for (let i = 0; i < meters.length; i++) {
        const m = meters[i]!
        if (mode(m) !== "row" || m.alpha <= 0.001) continue
        const x = row.reverse ? left + width - offset - d : left + offset
        offset += m.alpha * (d + gap)
        this.place(nodes[i]!, m, "row", `translate(${snap(x)}px,${snap(top)}px)`, `${d}x${d}`, reducedMotion)
      }
    }
    // Thin bars stacked under the feet.
    if (at.bars) {
      const { w, h, gap } = this.bar(at.bars.scale)
      let y = at.bars.y
      for (let i = 0; i < meters.length; i++) {
        const m = meters[i]!
        if (mode(m) !== "bar" || m.alpha <= 0.001) continue
        this.place(nodes[i]!, m, "bar", `translate(${snap(at.bars.x - w / 2)}px,${snap(y)}px)`, `${w}x${h}`, reducedMotion)
        y += m.alpha * (h + gap)
      }
    }
    for (let i = 0; i < meters.length; i++) {
      const m = meters[i]!
      const md = mode(m)
      if (!md || md === "ground" || m.alpha <= 0.001) setOpacity(nodes[i]!, "0")
    }
    if (at.ground) this.drawGround(actorId, vitals, at.ground, hidden)
  }

  /** Stamina on the left arc and health on the right arc of one ring on the ground, filling from the front. */
  private drawGround(actorId: string, vitals: ActorVitals, g: NonNullable<VitalsLayout["ground"]>, hidden?: ReadonlySet<MeterId>): void {
    let ring = this.grounds.get(actorId)
    if (!ring) {
      ring = this.createGround()
      this.grounds.set(actorId, ring)
    }
    ring.svg.style.display = ""
    const width = (2.6 * g.scale).toFixed(2)
    if (ring.width !== width) {
      ring.width = width
      ring.svg.style.setProperty("--ground-w", width)
    }
    for (const id of ["stamina", "health"] as const) {
      const arc = ring.arcs[id]
      const m = vitals.meter(id)
      const alpha = hidden?.has(id) ? 0 : m.alpha
      const opacity = alpha.toFixed(2)
      if (arc.opacity !== opacity) {
        arc.opacity = opacity
        arc.g.style.opacity = opacity
      }
      if (alpha <= 0.001) continue
      const d = groundArc(g.points, id === "stamina" ? 1 : -1)
      if (arc.d !== d) {
        arc.d = d
        for (const path of arc.paths) path.setAttribute("d", d)
      }
      const state = m.draining ? `${m.state} draining` : m.state
      if (arc.state !== state) {
        arc.state = state
        arc.g.dataset.state = m.state
        if (m.draining) arc.g.dataset.draining = "true"
        else delete arc.g.dataset.draining
      }
      const p = m.fill.toFixed(3)
      if (arc.p !== p) {
        arc.p = p
        arc.fill.style.strokeDasharray = `${p} 1`
        // A zero-length dash still draws its round cap; hide the fill when there is nothing to show.
        arc.fill.style.opacity = m.fill < 0.01 ? "0" : ""
      }
    }
  }

  private hideGround(actorId: string): void {
    const ring = this.grounds.get(actorId)
    if (ring && ring.svg.style.display !== "none") ring.svg.style.display = "none"
  }

  private createGround(): GroundRing {
    const svg = document.createElementNS(SVG_NS, "svg")
    svg.setAttribute("class", "ground-ring")
    const arcs = {} as GroundRing["arcs"]
    for (const id of ["stamina", "health"] as const) {
      const g = document.createElementNS(SVG_NS, "g")
      g.dataset.meter = id
      g.style.opacity = "0"
      // A dark casing for contrast on lit ground, the empty track, and the fill drawn as a dash of the arc's length.
      const paths = ["casing", "track", "fill"].map((cls) => {
        const path = document.createElementNS(SVG_NS, "path")
        path.setAttribute("class", cls)
        path.setAttribute("pathLength", "1")
        g.append(path)
        return path
      })
      svg.append(g)
      arcs[id] = { g, paths, fill: paths[2]!, d: "", state: "", p: "", opacity: "0" }
    }
    this.root.append(svg)
    return { svg, arcs, width: "" }
  }

  /** Removes an actor's meters (a remote survivor left). */
  drop(actorId: string): void {
    this.grounds.get(actorId)?.svg.remove()
    this.grounds.delete(actorId)
    const nodes = this.nodes.get(actorId)
    if (!nodes) return
    for (const n of nodes) n.el.remove()
    this.nodes.delete(actorId)
  }

  setSize(px: number): void {
    this.size = px
    this.root.style.setProperty("--vital-size", `${px}px`)
  }

  private bar(scale: number) {
    return { w: Math.round(this.size * 2.3 * scale), h: Math.max(3, Math.round(this.size * 0.22 * scale)), gap: Math.max(2, Math.round(this.size * 0.14 * scale)) }
  }

  private place(n: RingNode, m: Meter, mode: Mode, transform: string, size: string, reducedMotion: boolean): void {
    if (n.mode !== mode) {
      n.mode = mode
      n.el.dataset.mode = mode
    }
    if (n.size !== size) {
      n.size = size
      const [w, h] = size ? size.split("x") : ["", ""]
      n.el.style.width = w ? `${w}px` : ""
      n.el.style.height = h ? `${h}px` : ""
      // Rings scale their stroke, glyph and count with the ring's own size, not with a transform.
      if (mode === "row" && w) n.el.style.setProperty("--vital-size", `${w}px`)
      else n.el.style.removeProperty("--vital-size")
    }
    if (n.transform !== transform) {
      n.transform = transform
      n.el.style.transform = transform
    }
    setOpacity(n, (m.alpha * (reducedMotion ? 1 : m.flicker)).toFixed(2))
    if (n.state !== m.state) {
      n.state = m.state
      n.el.dataset.state = m.state
    }
    const drain = m.draining ? "1" : ""
    if (n.drain !== drain) {
      n.drain = drain
      if (drain) n.el.dataset.draining = "true"
      else delete n.el.dataset.draining
    }
    const fill = m.fill.toFixed(3)
    if (n.fill !== fill) {
      n.fill = fill
      n.el.style.setProperty("--p", fill)
    }
    if (n.text !== m.text) {
      n.text = m.text
      n.label.textContent = m.text
    }
  }

  private createNode(id: MeterId): RingNode {
    const el = document.createElement("div")
    el.className = "vital"
    el.dataset.meter = id
    el.dataset.state = "ok"
    el.style.opacity = "0"
    const ring = document.createElement("i")
    ring.className = "vital-ring"
    const label = document.createElement("b")
    el.append(ring, label)
    this.root.append(el)
    return { el, label, state: "ok", fill: "", text: "", transform: "", opacity: "0", drain: "", mode: "", size: "" }
  }
}

const STATUS_TEXT: Record<MeterId, Partial<Record<MeterState, string>>> = {
  stamina: { ok: "Winded", low: "Winded", critical: "Exhausted" },
  reload: {},
  health: { ok: "Hurt", low: "Wounded", critical: "Bleeding" },
  battery: { low: "Battery low", critical: "Battery dead" },
}

/**
 * Project Zomboid-style status icons in the top-right corner, read from the same meters as the rings. Stamina only
 * shows once it is low; reload is an action and stays over the head.
 */
export class StatusIcons {
  readonly root: HTMLDivElement
  private chips = new Map<MeterId, { el: HTMLDivElement; label: HTMLElement; key: string; opacity: string }>()

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div")
    this.root.className = "status-icons"
    this.root.setAttribute("aria-live", "polite")
    parent.append(this.root)
  }

  draw(vitals: ActorVitals | null, hidden?: ReadonlySet<MeterId>): void {
    for (const m of vitals?.meters ?? []) {
      if (m.id === "reload") continue
      const relevant = !hidden?.has(m.id) && (m.id !== "stamina" || m.state !== "ok")
      const alpha = relevant ? m.alpha : 0
      let chip = this.chips.get(m.id)
      if (!chip && alpha <= 0.001) continue
      if (!chip) {
        const el = document.createElement("div")
        el.className = "status-icon"
        el.dataset.meter = m.id
        const icon = document.createElement("i")
        const label = document.createElement("span")
        el.append(icon, label)
        this.root.append(el)
        chip = { el, label, key: "", opacity: "" }
        this.chips.set(m.id, chip)
      }
      const text = STATUS_TEXT[m.id][m.state] ?? ""
      const key = `${m.state}|${text}`
      if (chip.key !== key) {
        chip.key = key
        chip.el.dataset.state = m.state
        chip.label.textContent = text
      }
      const opacity = alpha.toFixed(2)
      if (chip.opacity !== opacity) {
        chip.opacity = opacity
        chip.el.style.opacity = opacity
        chip.el.hidden = alpha <= 0.001
      }
    }
    if (!vitals) for (const chip of this.chips.values()) if (chip.opacity !== "0.00") {
      chip.opacity = "0.00"
      chip.el.hidden = true
    }
  }
}

function setOpacity(n: RingNode, value: string): void {
  if (n.opacity === value) return
  n.opacity = value
  n.el.style.opacity = value
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Meter inputs for the local survivor, whose full state is known. */
export function localVitals(
  p: Pick<Survivor, "health" | "maxHealth" | "stamina" | "sprinting" | "exhausted" | "reloadRemaining" | "equippedItem" | "magAmmo" | "reserveAmmo" | "flashlightOn" | "battery" | "batteryDepleted" | "flashlightOutput">,
): VitalsInput {
  return {
    health: p.health,
    maxHealth: p.maxHealth,
    stamina: p.stamina,
    sprinting: p.sprinting,
    exhausted: p.exhausted,
    reload: p.reloadRemaining > 0 ? 1 - p.reloadRemaining / PISTOL_RELOAD_TIME : null,
    pistol: p.equippedItem === "pistol",
    magAmmo: p.magAmmo,
    reserveAmmo: p.reserveAmmo,
    flashlightOn: p.flashlightOn,
    battery: p.battery,
    batteryDepleted: p.batteryDepleted,
    flashlightOutput: p.flashlightOutput,
  }
}
