import { GpuPerf } from "@arcade/kit/gpu-perf"
import type { LabControl, LabPanel, LabSettings } from "@arcade/kit/lab-panel"
import { seaDisplace } from "../../shared/sea"
import {
  clampWeather,
  kindOf,
  makeWeather,
  mixWeather,
  WEATHER_KEYS,
  WEATHER_KINDS,
  WEATHER_PRESETS,
  WEATHER_RANGE,
  weatherEase,
  weatherSchedule,
  windKnots,
  type Weather,
  type WeatherKind,
} from "../../shared/weather"
import type { WeatherSystem } from "../render/weather-system"
import { copyText, pasteText, type DevSection } from "./dev-panel"

export type WeatherLabHost = {
  system: WeatherSystem
  device: GPUDevice
  /** Camera focus on the sea (plan x, z), for the wave-height readout. */
  focus(): readonly [number, number]
  /** Sends a room override (null: back to the timeline), or null while the room wiring does not exist. */
  broadcast: ((to: Weather | WeatherKind | null, fade: number) => void) | null
  /** The player's ship as drawn, for the motion readout. */
  ship?(): { pitch: number; roll: number; heave: number } | null
}

type Mode = "timeline" | "manual"

/** Every weather parameter on the panel: [key, label, group, step, unit]. Ranges are WEATHER_RANGE (also the wire's). */
const PARAMS: readonly (readonly [keyof Weather, string, string, number, string])[] = [
  ["rain", "Intensity", "Rain", 0.01, ""],
  ["density", "Density", "Rain", 0.01, "×"],
  ["streak", "Streak length", "Rain", 0.01, "×"],
  ["splash", "Splashes", "Rain", 0.01, "×"],
  ["wind", "Wind", "Wind and sea", 0.01, ""],
  ["windDir", "Rain and foam wind", "Wind and sea", 1, "°"],
  ["sea", "Sea state", "Wind and sea", 0.01, ""],
  ["swell", "Chop ← → swell", "Wind and sea", 0.01, ""],
  ["foam", "Whitecaps", "Wind and sea", 0.01, ""],
  ["cloud", "Cloud cover", "Sky", 0.01, ""],
  ["dark", "Cloud darkness", "Sky", 0.01, ""],
  ["fog", "Fog", "Sky", 0.01, ""],
  ["sun", "Sun", "Sky", 0.01, ""],
  ["lightning", "Lightning", "Sky", 0.01, ""],
  ["desat", "Desaturate", "Grade", 0.01, ""],
  ["darken", "Darken", "Grade", 0.01, ""],
]

const DEG = 180 / Math.PI
/** Minutes of schedule the Upcoming table covers. */
const AHEAD_MIN = 40
const PRESET_URL = "/__weather/presets"
const GROUP = "Weather"
const SHARE = "Share weather"
const SEA_TIME = "Sea time"
const READOUTS = "Weather readouts"

/**
 * WEATHER LAB, the dev panel's weather section. TIMELINE shows the room's synced weather (live values, the schedule
 * ahead); MANUAL drives every weather parameter locally (presets animate with the real transition curve; moving a value
 * switches to manual). BROADCAST sends the manual weather to the room as an override, so every client's visuals and
 * every ship's physics agree. Local sea-time controls (pause, x0.25, x4) and readouts (crest to trough near the camera,
 * wind, ship motion, GPU time).
 *
 * The weather logic (`frame`, `time`) runs every frame whether the section is shown or not; `section` is the UI.
 */
export class WeatherLab {
  mode: Mode = "timeline"
  /** Manual target, the start of the running preset transition, and its timing (performance.now ms, seconds). */
  readonly target: Weather = makeWeather()
  private from: Weather = makeWeather()
  private transStart = 0
  private transDur = 0
  /** Fading back from manual to the timeline. */
  private back: { from: Weather; start: number } | null = null
  private shown: Weather = makeWeather()

  /** The panel's own settings: transition (s), and local sea time (paused, speed). */
  readonly settings = { transition: 20, paused: false, speed: 1 }
  private local: number | null = null

  private panel: LabPanel | null = null
  private onScreen = false
  private gpu: GpuPerf | null = null
  private fps = 60
  private lastUi = 0
  private t = 0
  private note = ""

  constructor(private h: WeatherLabHost) {}

  get transition(): number {
    return this.settings.transition
  }

  get visible(): boolean {
    return this.onScreen
  }

  readonly section: DevSection = {
    id: "weather",
    tab: "World",
    bind: (panel) => {
      this.panel = panel
      panel.addControls(this.weatherSettings(), this.controls(), { mode: "timeline", ...makeWeather() })
      panel.addControls(this.settings, this.ownControls(), { transition: 20, paused: false, speed: 1 })
      panel.addControls({}, this.readouts())
    },
    shown: (on) => {
      this.onScreen = on
      if (on) this.gpu ??= new GpuPerf(this.h.device)
      if (this.gpu) this.gpu.enabled = on
    },
    frame: () => {
      const now = performance.now()
      if (now - this.lastUi < 120) return
      this.lastUi = now
      this.panel?.refresh()
    },
  }

  /** The weather on show as settings: manual's target, else the live weather; writing one switches to manual. */
  private weatherSettings(): LabSettings {
    const s: LabSettings = {}
    Object.defineProperty(s, "mode", {
      enumerable: true,
      get: () => this.mode,
      set: (v) => (v === "manual" ? this.toManual() : this.toTimeline()),
    })
    for (const [key] of PARAMS)
      Object.defineProperty(s, key, {
        enumerable: true,
        get: () => (this.mode === "manual" ? this.target : this.current())[key],
        set: (v) => this.setParam(key, Number(v)),
      })
    return s
  }

  private controls(): LabControl[] {
    const params = PARAMS.map(([key, label, group, step, unit]): LabControl => {
      const [min, max] = WEATHER_RANGE[key]
      return { key: `weather.${key}`, label, group, min, max, step, unit }
    })
    return [
      { key: "weather.mode", label: "Mode", group: GROUP, options: [{ value: "timeline", label: "Timeline (room)" }, { value: "manual", label: "Manual (local)" }] },
      { key: "presets", label: "Presets", group: GROUP, type: "buttons", items: WEATHER_KINDS.map((k) => ({ key: `weather-${k}`, label: k[0]!.toUpperCase() + k.slice(1), run: () => this.preset(k) })) },
      ...params,
      { key: "weather-act", label: "Lightning", group: "Sky", type: "buttons", items: [{ key: "weather-strike", label: "Strike now", run: () => this.strike() }] },
    ]
  }

  private ownControls(): LabControl[] {
    return [
      { key: "weather.transition", label: "Preset transition", group: GROUP, min: 0, max: 180, step: 1, unit: "s" },
      { key: "weather.paused", label: "Pause sea time", group: SEA_TIME },
      { key: "weather.speed", label: "Sea time speed", group: SEA_TIME, options: [0.25, 1, 4].map((s) => ({ value: s, label: `x${s}` })) },
      { key: "sea-sync", label: "Sea time", group: SEA_TIME, type: "buttons", items: [{ key: "weather-sync", label: "Sync to room", run: () => this.syncTime() }] },
      {
        key: "weather-share",
        label: "Room",
        group: SHARE,
        type: "buttons",
        items: [
          { key: "weather-broadcast", label: "Broadcast to room", run: () => this.broadcast(), enabled: () => !!this.h.broadcast },
          { key: "weather-timeline", label: "Back to timeline", run: () => this.toTimeline() },
        ],
      },
      {
        key: "weather-json",
        label: "JSON",
        group: SHARE,
        type: "buttons",
        items: [
          { key: "weather-copy", label: "Copy", run: () => this.copy() },
          { key: "weather-paste", label: "Paste", run: () => this.paste() },
          { key: "weather-save", label: "Save preset", run: () => this.save() },
        ],
      },
      { key: "weather-note", label: "Note", group: SHARE, type: "readout", read: () => this.note || "—" },
    ]
  }

  private readouts(): LabControl[] {
    const sys = this.h.system
    return [
      { key: "weather-room", label: "Room", group: GROUP, type: "readout", read: () => {
        const room = sys.room.at(this.t, makeWeather())
        return `${kindOf(room)} ${room.rain.toFixed(2)}${sys.room.active(this.t) ? " · override" : ""}`
      } },
      { key: "weather-showing", label: "Showing", group: GROUP, type: "readout", read: () => {
        const cur = this.current()
        return `${this.mode === "manual" ? "manual" : this.back ? "returning" : "room"} · ${kindOf(cur)} ${cur.rain.toFixed(2)}`
      } },
      { key: "weather-ahead", label: "Upcoming", group: GROUP, type: "readout", display: "table", columns: ["Weather", "Starts", "Lasts"], read: () => {
        const t = this.t
        return weatherSchedule(sys.room.seed, t, 8)
          .filter((s) => s.end > t && s.start < t + AHEAD_MIN * 60)
          .map((s) => [s.kind, s.start <= t ? "now" : `in ${clock(s.start - t)}`, clock(s.end - Math.max(s.start, t))])
      } },
      { key: "weather-waves", label: "Crest to trough", group: READOUTS, type: "readout", read: () => this.crestToTrough() },
      { key: "weather-wind", label: "Wind", group: READOUTS, type: "readout", read: () => `${windKnots(this.current()).toFixed(0)} kn` },
      { key: "weather-ship", label: "Pitch · roll · heave", group: READOUTS, type: "readout", read: () => {
        const ship = this.h.ship?.()
        return ship ? `${(ship.pitch * DEG).toFixed(1)}° ${(ship.roll * DEG).toFixed(1)}° ${ship.heave.toFixed(1)} m` : "—"
      } },
      { key: "weather-fps", label: "Frame", group: READOUTS, type: "readout", read: () => `${this.fps.toFixed(0)} fps · ${(1000 / Math.max(1, this.fps)).toFixed(1)} ms` },
      { key: "weather-gpu", label: "GPU", group: READOUTS, type: "readout", read: () => {
        const g = this.gpu
        return g?.gpuMs != null ? `${g.gpuMs.toFixed(2)} ms ${g.gpuKind === "timestamp" ? "hw" : "queue"}` : "—"
      } },
      { key: "weather-time", label: "Sea time", group: READOUTS, type: "readout", read: () =>
        `${clock(this.t)}${this.local !== null || this.settings.paused ? ` local${this.settings.paused ? " ⏸" : ` x${this.settings.speed}`}` : ""}` },
    ]
  }

  /** Local sea time: the synced time unless paused or sped up (then it runs on its own until Sync to room). */
  time(synced: number, dt: number): number {
    const { paused, speed } = this.settings
    if (this.local === null && !paused && speed === 1) return synced
    this.local ??= synced
    if (!paused) this.local += dt * speed
    return this.local
  }

  /** Call every frame before `system.update`: sets the system's local manual weather (or clears it). */
  frame(dt: number, t: number): void {
    this.t = t
    if (dt > 0) this.fps += (1 / dt - this.fps) * Math.min(1, dt * 3)
    const now = performance.now()
    const sys = this.h.system
    if (this.mode === "manual") {
      const u = this.transDur > 0 ? weatherEase((now - this.transStart) / 1000 / this.transDur) : 1
      sys.manual = mixWeather(this.from, this.target, u, this.shown)
    } else if (this.back) {
      // Fade from the last manual weather to the live room weather.
      const u = this.transition > 0 ? weatherEase((now - this.back.start) / 1000 / this.transition) : 1
      if (u >= 1) {
        this.back = null
        sys.manual = null
      } else {
        sys.manual = null
        const room = sys.room.at(t, makeWeather())
        sys.manual = mixWeather(this.back.from, room, u, this.shown)
      }
    } else sys.manual = null
  }

  private current(): Weather {
    return this.h.system.current
  }

  private toManual(): void {
    if (this.mode === "manual") return
    Object.assign(this.target, this.current())
    Object.assign(this.from, this.current())
    this.transDur = 0
    this.back = null
    this.mode = "manual"
  }

  private toTimeline(): void {
    if (this.mode === "manual") this.back = { from: makeWeather(this.h.system.manual ?? this.current()), start: performance.now() }
    this.mode = "timeline"
    this.panel?.refresh()
  }

  /** Local manual weather: a preset, faded in over `fade` seconds (default: the transition setting). */
  force(kind: WeatherKind, fade = this.transition): void {
    this.preset(kind, fade)
  }

  private preset(kind: WeatherKind, fade = this.transition): void {
    this.toManual()
    Object.assign(this.from, this.h.system.manual ?? this.current())
    Object.assign(this.target, WEATHER_PRESETS[kind])
    this.transStart = performance.now()
    this.transDur = fade
    this.panel?.refresh()
  }

  private setParam(key: keyof Weather, v: number): void {
    if (!Number.isFinite(v)) return
    this.toManual()
    // An edit settles any running transition, then sets its field directly.
    Object.assign(this.from, this.h.system.manual ?? this.target)
    Object.assign(this.target, this.from)
    this.target[key] = v
    this.from[key] = v
    this.transDur = 0
  }

  private syncTime(): void {
    this.settings.paused = false
    this.settings.speed = 1
    this.local = null
    this.panel?.refresh()
  }

  private strike(): void {
    const sys = this.h.system
    sys.forced = { t: this.t, power: 1, bearing: Math.random() * Math.PI * 2, dist: 1200 + Math.random() * 3500, seed: Math.floor(Math.random() * 0xffffff) }
  }

  private broadcast(): void {
    if (!this.h.broadcast) return this.say("Room weather wiring is not connected: the manual weather stays local.")
    const w = this.mode === "manual" ? makeWeather(this.target) : null
    this.h.broadcast(w, this.transition)
    this.say(w ? `Sent to the room: fades over ${this.transition}s.` : "Room returns to its timeline.")
  }

  private json(): string {
    const w = this.mode === "manual" ? this.target : this.current()
    const out: Record<string, number> = {}
    for (const k of WEATHER_KEYS) out[k] = Math.round(w[k] * 1000) / 1000
    return JSON.stringify(out, null, 2)
  }

  private async copy(): Promise<void> {
    this.say(await copyText(this.json(), "weather preset"))
  }

  /** Pasted JSON (a weather, or `{ weather }`): every known finite field, clamped, faded in like a preset. */
  private async paste(): Promise<void> {
    const text = await pasteText("weather JSON")
    if (!text) return
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return this.say(`Bad JSON: ${(e as Error).message}`)
    }
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
    const src = (obj.weather && typeof obj.weather === "object" ? obj.weather : obj) as Record<string, unknown>
    const w = makeWeather(this.mode === "manual" ? this.target : this.current())
    let n = 0
    for (const k of WEATHER_KEYS) {
      const v = src[k]
      if (typeof v === "number" && Number.isFinite(v)) {
        w[k] = v
        n++
      }
    }
    if (!n) return this.say("No weather fields in the pasted JSON.")
    clampWeather(w)
    this.toManual()
    Object.assign(this.from, this.h.system.manual ?? this.target)
    Object.assign(this.target, w)
    this.transStart = performance.now()
    this.transDur = this.transition
    this.say(`Applied ${n} fields.`)
  }

  private async save(): Promise<void> {
    const name = prompt("Preset name", kindOf(this.mode === "manual" ? this.target : this.current()))
    if (!name) return
    try {
      const res = await fetch(PRESET_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, weather: JSON.parse(this.json()) }) })
      this.say(res.ok ? `Saved "${name}" to feedback/weather-presets.json.` : `Save failed (${res.status}).`)
    } catch {
      this.say("Save failed: the dev endpoint is not running.")
    }
  }

  private say(msg: string): void {
    this.note = msg
    this.panel?.refresh()
  }

  /** Highest crest minus lowest trough within ±250 m of the camera focus along the primary swell. */
  private crestToTrough(): string {
    const v = this.h.system.view
    if (!v) return "—"
    const sea = v.sea
    const [fx, fz] = this.h.focus()
    const d = new Float64Array(3)
    let hi = -Infinity
    let lo = Infinity
    for (let s = -250; s <= 250; s += 2.5) {
      seaDisplace(sea, fx + sea.swell[0] * s, fz + sea.swell[1] * s, this.t, d)
      hi = Math.max(hi, d[1]!)
      lo = Math.min(lo, d[1]!)
    }
    return `${(hi - lo).toFixed(1)} m`
  }
}

function clock(s: number): string {
  const m = Math.floor(Math.abs(s) / 60)
  const sec = Math.floor(Math.abs(s) % 60)
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`
  return `${m}:${String(sec).padStart(2, "0")}`
}
