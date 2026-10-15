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

type RingNode = { el: HTMLDivElement; label: HTMLElement; state: string; fill: string; text: string; transform: string; opacity: string; drain: string }

/** Pooled DOM rings for any number of actors. Idle actors write nothing. */
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

  /** Width of the visible row, with each ring weighted by its opacity so neighbours slide in and out smoothly. */
  rowWidth(vitals: ActorVitals, scale: number): number {
    const d = this.size * scale
    const gap = d * 0.28
    let w = 0
    for (const m of vitals.meters) w += m.alpha * (d + gap)
    return Math.max(0, w - gap)
  }

  draw(actorId: string, vitals: ActorVitals, at: VitalsPlacement | null, reducedMotion: boolean): void {
    const reduced = String(reducedMotion)
    if (this.reduced !== reduced) {
      this.reduced = reduced
      this.root.dataset.reduced = reduced
    }
    let nodes = this.nodes.get(actorId)
    if (!at || vitals.presence <= 0.001) {
      if (nodes) for (const n of nodes) setOpacity(n, "0")
      return
    }
    if (!nodes) {
      nodes = METER_ORDER.map((id) => this.createNode(id))
      this.nodes.set(actorId, nodes)
    }
    const d = this.size * at.scale
    const gap = d * 0.28
    const width = this.rowWidth(vitals, at.scale)
    const left = at.x + at.ax * width
    const top = at.y + at.ay * d
    let offset = 0
    for (let i = 0; i < vitals.meters.length; i++) {
      const m = vitals.meters[i]!
      const n = nodes[i]!
      if (m.alpha <= 0.001) {
        setOpacity(n, "0")
        continue
      }
      const x = at.reverse ? left + width - offset - d : left + offset
      offset += m.alpha * (d + gap)
      const transform = `translate(${x.toFixed(1)}px,${top.toFixed(1)}px) scale(${(d / this.size).toFixed(3)})`
      if (n.transform !== transform) {
        n.transform = transform
        n.el.style.transform = transform
      }
      const flicker = reducedMotion ? 1 : m.flicker
      setOpacity(n, (m.alpha * flicker).toFixed(2))
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
  }

  /** Removes an actor's rings (a remote survivor left). */
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
    return { el, label, state: "ok", fill: "", text: "", transform: "", opacity: "0", drain: "" }
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
