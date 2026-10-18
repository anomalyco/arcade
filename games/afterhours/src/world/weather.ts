import type { WorldContext } from "./context"

// Weather state shared by rendering and audio. The default night is DRY (fog over the forest): `rain` is 0 and the rain
// beds stay silent; the code behind them is kept for real rain later. Lightning is a distant storm: strikes are
// scheduled at `frequency` per minute (exponential gaps, at least 12 s apart), mostly 3–15 km away (a faint flash and a
// low rumble), now and then within 0.8–3 km. Each strike is announced to `onLightning` listeners the moment it
// flashes; the lighting draws the flash from it, the audio plays its thunder `distanceM / 343` s later, muffled by
// distance and by the building.
//
//   import { weather } from "../world/weather"
//   const off = weather.onLightning((s) => { ... })   // s: Lightning (below)
//   weather.strike()                                    // a strike now (Lab: Weather → Strike now)
//
// Lab: Weather group (Lightning per minute, Strike now, Rain). Automatic strikes run only with player input (never in
// `?shot` mode, so captures stay deterministic); `strike()` works anywhere. `?lightning=<s>` (automation only) sets
// when the first automatic strike comes.

export type Lightning = {
  /** When the first flash happens: seconds on the `performance.now() / 1000` clock. */
  at: number
  /** Distance from the listener to the strike (m). */
  distanceM: number
  /** Direction from the listener: radians clockwise from north (−Z), so east (+X) is π/2. */
  bearingRad: number
  /** Unit direction on the ground plane matching `bearingRad`: [x, z]. */
  dir: readonly [number, number]
  /** Brightness/loudness 0..1 (distance already folded in: ~1 within a kilometre, ~0.2 at 15 km). */
  intensity: number
  /** Flash pulse start times, seconds after `at` (the first is 0): the flicker of the return strokes. */
  flashes: number[]
}

type Listener = (s: Lightning) => void

const SPEED_OF_SOUND = 343

class Weather {
  /** Rain 0..1 (0: dry, the default). */
  rain = 0
  /** Automatic strikes per minute (0 turns the storm off). */
  frequency = 1
  private listeners: Listener[] = []
  private next = 0
  private auto = false
  /** Strikes so far (automation/debug). */
  readonly log: Lightning[] = []

  onLightning(cb: Listener) {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }

  /** Seconds a strike's thunder takes to arrive. */
  delayOf(s: Lightning) {
    return s.distanceM / SPEED_OF_SOUND
  }

  /** Makes a strike now (optionally at a given distance/bearing) and tells every listener. */
  strike(opts: { distanceM?: number; bearingRad?: number } = {}): Lightning {
    const close = Math.random() < 0.1
    const distanceM = opts.distanceM ?? (close ? 800 + Math.random() * 2200 : 3000 * 5 ** Math.random())
    const bearingRad = opts.bearingRad ?? Math.random() * Math.PI * 2
    const km = distanceM / 1000
    const intensity = Math.min(1, 2.2 / Math.max(0.5, km) ** 0.8) * (0.75 + Math.random() * 0.25)
    const flashes = [0]
    const pulses = 1 + Math.floor(Math.random() * (km < 3 ? 4 : 3))
    for (let i = 1; i < pulses; i++) flashes.push(+(flashes[i - 1]! + 0.04 + Math.random() * 0.2).toFixed(3))
    const s: Lightning = {
      at: performance.now() / 1000,
      distanceM: Math.round(distanceM),
      bearingRad,
      dir: [Math.sin(bearingRad), -Math.cos(bearingRad)],
      intensity: +intensity.toFixed(3),
      flashes,
    }
    this.log.push(s)
    if (this.log.length > 50) this.log.shift()
    for (const l of this.listeners) l(s)
    return s
  }

  /** Adds the Lab controls and starts automatic strikes when `auto` (player input on). */
  install(ctx: WorldContext, auto: boolean) {
    this.auto = auto
    ctx.settings["weather.lightning"] ??= this.frequency
    ctx.settings["weather.rain"] ??= this.rain
    ctx.controls.push(
      { key: "weather.lightning", label: "Lightning", group: "Weather", unit: "per min", min: 0, max: 6, step: 0.1 },
      { key: "weather.strike", label: "Strike now", group: "Weather", type: "action", run: () => void this.strike() },
      { key: "weather.rain", label: "Rain", group: "Weather", min: 0, max: 1, step: 0.05 },
    )
    const first = Number(ctx.params.get("lightning"))
    this.next = ctx.params.has("lightning") && Number.isFinite(first) ? first : this.gap()
    this.settings = ctx.settings
  }

  private settings: Record<string, unknown> | null = null
  private time = 0

  private gap() {
    const f = Math.max(0.01, this.frequency)
    return Math.max(12, (-Math.log(1 - Math.random()) * 60) / f)
  }

  /** Per frame (the player drives it): settings and the automatic storm. */
  update(dt: number) {
    if (this.settings) {
      this.frequency = Number(this.settings["weather.lightning"] ?? this.frequency)
      this.rain = Number(this.settings["weather.rain"] ?? this.rain)
    }
    if (!this.auto || this.frequency <= 0) return
    this.time += dt
    if (this.time < this.next) return
    this.strike()
    this.next = this.time + this.gap()
  }
}

/** The one weather state. */
export const weather = new Weather()
