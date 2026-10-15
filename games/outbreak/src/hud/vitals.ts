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
  /** Stamina and health as ellipses on the ground around the feet. */
  ground?: { x: number; y: number; w: number; h: number }
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

/** Pooled DOM meters for any number of actors. Idle actors write nothing. */
export class VitalsLayer {
  readonly root: HTMLDivElement
  private nodes = new Map<string, RingNode[]>()
  private reduced = ""

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
    if (!at || vitals.presence <= 0.001) {
      if (nodes) for (const n of nodes) setOpacity(n, "0")
      return
    }
    if (!nodes) {
      nodes = METER_ORDER.map((id) => this.createNode(id))
      this.nodes.set(actorId, nodes)
    }
    const meters = vitals.meters
    const mode = (m: Meter): Mode =>
      hidden?.has(m.id) ? "" : at.ground && GROUND_METERS.has(m.id) ? "ground" : at.bars ? "bar" : at.row ? "row" : ""

    // Rings in a row.
    if (at.row) {
      const row = at.row
      const d = this.size * row.scale
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
        this.place(nodes[i]!, m, "row", `translate(${x.toFixed(1)}px,${top.toFixed(1)}px) scale(${(d / this.size).toFixed(3)})`, "", reducedMotion)
      }
    }
    // Thin bars stacked under the feet.
    if (at.bars) {
      const { w, h, gap } = this.bar(at.bars.scale)
      let y = at.bars.y
      for (let i = 0; i < meters.length; i++) {
        const m = meters[i]!
        if (mode(m) !== "bar" || m.alpha <= 0.001) continue
        this.place(nodes[i]!, m, "bar", `translate(${(at.bars.x - w / 2).toFixed(1)}px,${y.toFixed(1)}px)`, `${w.toFixed(0)}x${h.toFixed(1)}`, reducedMotion)
        y += m.alpha * (h + gap)
      }
    }
    // Ellipses on the ground: stamina outside, health just inside it.
    if (at.ground) {
      const g = at.ground
      for (let i = 0; i < meters.length; i++) {
        const m = meters[i]!
        if (mode(m) !== "ground" || m.alpha <= 0.001) continue
        const k = m.id === "health" ? 0.74 : 1
        const w = g.w * k
        const h = g.h * k
        this.place(nodes[i]!, m, "ground", `translate(${(g.x - w / 2).toFixed(1)}px,${(g.y - h / 2).toFixed(1)}px)`, `${w.toFixed(0)}x${h.toFixed(0)}`, reducedMotion)
      }
    }
    for (let i = 0; i < meters.length; i++) {
      const m = meters[i]!
      if (!mode(m) || m.alpha <= 0.001) setOpacity(nodes[i]!, "0")
    }
  }

  /** Removes an actor's meters (a remote survivor left). */
  drop(actorId: string): void {
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
    return { w: Math.round(this.size * 2.3 * scale), h: Math.max(3, this.size * 0.2 * scale), gap: Math.max(2, this.size * 0.14 * scale) }
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
