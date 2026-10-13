import { GpuPerf } from "../../../../packages/kit/gpu-perf"
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
import type { DebugTab } from "./debug-menu"
import css from "./weather-lab.css?inline"

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

type SliderDef = { key: keyof Weather; label: string; step: number; fmt?: (v: number, w: Weather) => string }

const pct = (v: number) => v.toFixed(2)
const GROUPS: { title: string; sliders: SliderDef[] }[] = [
  {
    title: "Rain",
    sliders: [
      { key: "rain", label: "Intensity", step: 0.01 },
      { key: "density", label: "Density", step: 0.01, fmt: (v) => `x${v.toFixed(2)}` },
      { key: "streak", label: "Streak len", step: 0.01, fmt: (v) => `x${v.toFixed(2)}` },
      { key: "splash", label: "Splashes", step: 0.01, fmt: (v) => `x${v.toFixed(2)}` },
    ],
  },
  {
    title: "Wind and sea",
    sliders: [
      { key: "wind", label: "Wind", step: 0.01, fmt: (v, w) => `${pct(v)} ${windKnots(w).toFixed(0)}kn` },
      { key: "windDir", label: "Wind dir", step: 1, fmt: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}°` },
      { key: "sea", label: "Sea state", step: 0.01 },
      { key: "swell", label: "Swell/chop", step: 0.01, fmt: (v) => (Math.abs(v - 0.5) < 0.005 ? "both" : v < 0.5 ? `chop ${pct(v)}` : `swell ${pct(v)}`) },
      { key: "foam", label: "Whitecaps", step: 0.01 },
    ],
  },
  {
    title: "Sky",
    sliders: [
      { key: "cloud", label: "Cloud cover", step: 0.01 },
      { key: "dark", label: "Cloud dark", step: 0.01 },
      { key: "sun", label: "Sun", step: 0.01 },
      { key: "lightning", label: "Lightning", step: 0.01 },
    ],
  },
  {
    title: "Grade",
    sliders: [
      { key: "desat", label: "Desaturate", step: 0.01 },
      { key: "darken", label: "Darken", step: 0.01 },
    ],
  },
]

const SPEEDS = [0.25, 1, 4] as const
const DEG = 180 / Math.PI
/** Minutes of schedule shown in the strip. */
const STRIP_MIN = 40
const PRESET_URL = "/__weather/presets"

/**
 * WEATHER LAB, the debug menu's weather tab. TIMELINE shows the room's synced weather (read-only, live values and the
 * upcoming schedule); MANUAL drives every weather parameter locally (presets animate with the real transition curve).
 * BROADCAST sends the manual weather to the room as an override, so every client's visuals and every ship's physics
 * agree. Local sea-time controls (pause, x0.25, x4) and readouts (crest to trough near the camera, wind, GPU time).
 *
 * The weather logic (`frame`, `time`) runs every frame whether the tab is shown or not; `tab` is the UI.
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
  /** Transition time (s) for presets and for returning to the timeline. */
  transition = 20
  private shown: Weather = makeWeather()

  // Local sea-time control.
  paused = false
  speed: number = 1
  private local: number | null = null

  readonly tab: DebugTab
  private el = document.createElement("div")
  private shownTab = false
  private inputs = new Map<keyof Weather, { input: HTMLInputElement; value: HTMLElement; def: SliderDef }>()
  private status: Record<string, HTMLElement> = {}
  private strip: HTMLElement
  private ticks: HTMLElement
  private note: HTMLElement
  private paste: HTMLTextAreaElement
  private gpu: GpuPerf | null = null
  private fps = 60
  private lastUi = 0
  private t = 0

  constructor(private h: WeatherLabHost) {
    this.el.className = "weather-lab"
    this.el.innerHTML = `
          <div class="status">
            <span class="k">Room</span><span class="v" data-s="room"></span>
            <span class="k">Next</span><span class="v" data-s="next"></span>
            <span class="k">Showing</span><span class="v" data-s="showing"></span>
          </div>
          <div class="strip"></div>
          <div class="ticks"></div>
          <h2>Mode</h2>
          <div class="row"><button data-mode="timeline">Timeline</button><button data-mode="manual">Manual</button></div>
          <h2>Presets</h2>
          <div class="row">${WEATHER_KINDS.map((k) => `<button data-preset="${k}">${k}</button>`).join("")}</div>
          <div class="slider"><span>Transition</span><input type="range" data-trans min="0" max="180" step="1"><span class="v" data-s="trans"></span></div>
          <div data-sliders></div>
          <div class="row" style="margin-top:6px"><button data-act="strike">Strike now</button></div>
          <h2>Sea time</h2>
          <div class="row"><button data-act="pause">Pause</button>${SPEEDS.map((s) => `<button data-speed="${s}">x${s}</button>`).join("")}<button data-act="sync">Sync</button></div>
          <h2>Readouts</h2>
          <div class="status">
            <span class="k">Crest–trough</span><span class="v" data-s="waves"></span>
            <span class="k">Wind</span><span class="v" data-s="wind"></span>
            <span class="k">Pitch·roll·heave</span><span class="v" data-s="ship"></span>
            <span class="k">Frame</span><span class="v" data-s="fps"></span>
            <span class="k">GPU</span><span class="v" data-s="gpu"></span>
            <span class="k">Sea time</span><span class="v" data-s="time"></span>
          </div>
          <h2>Share</h2>
          <div class="row"><button data-act="reset">Reset to timeline</button><button data-act="broadcast">Broadcast to room</button></div>
          <div class="row" style="margin-top:4px"><button data-act="copy">Copy JSON</button><button data-act="paste">Paste JSON</button><button data-act="save">Save preset</button></div>
          <textarea hidden spellcheck="false" placeholder='{ "rain": 0.8, ... }'></textarea>
          <div class="row" data-paste-row hidden style="margin-top:4px"><button data-act="apply">Apply</button><button data-act="cancel">Cancel</button></div>
          <div class="note"></div>`
    const q = <T extends Element>(sel: string) => this.el.querySelector<T>(sel)!
    this.strip = q(".strip")
    this.ticks = q(".ticks")
    this.note = q(".note")
    this.paste = q("textarea")
    this.el.querySelectorAll<HTMLElement>("[data-s]").forEach((el) => (this.status[el.dataset.s!] = el))
    this.ticks.innerHTML = [0, 10, 20, 30, 40].map((m) => `<span>${m ? `+${m}m` : "now"}</span>`).join("")

    const sliders = q("[data-sliders]")
    for (const g of GROUPS) {
      const h2 = document.createElement("h2")
      h2.textContent = g.title
      sliders.append(h2)
      for (const def of g.sliders) {
        const row = document.createElement("div")
        row.className = "slider"
        const label = document.createElement("span")
        label.textContent = def.label
        const input = document.createElement("input")
        input.type = "range"
        const [lo, hi] = WEATHER_RANGE[def.key]
        input.min = String(lo)
        input.max = String(hi)
        input.step = String(def.step)
        const value = document.createElement("span")
        value.className = "v"
        input.oninput = () => this.setParam(def.key, Number(input.value))
        row.append(label, input, value)
        sliders.append(row)
        this.inputs.set(def.key, { input, value, def })
      }
    }
    const trans = q<HTMLInputElement>("[data-trans]")
    trans.value = String(this.transition)
    trans.oninput = () => (this.transition = Number(trans.value))

    this.el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => (b.onclick = () => (b.dataset.mode === "manual" ? this.toManual() : this.toTimeline())))
    this.el.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => (b.onclick = () => this.preset(b.dataset.preset as WeatherKind)))
    this.el.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach(
      (b) =>
        (b.onclick = () => {
          this.speed = Number(b.dataset.speed)
          this.sync()
        }),
    )
    const act: Record<string, () => void> = {
      strike: () => this.strike(),
      pause: () => {
        this.paused = !this.paused
        this.sync()
      },
      sync: () => {
        this.paused = false
        this.speed = 1
        this.local = null
        this.sync()
      },
      reset: () => this.toTimeline(),
      broadcast: () => this.broadcast(),
      copy: () => void this.copy(),
      paste: () => this.showPaste(true),
      apply: () => this.applyPaste(),
      cancel: () => this.showPaste(false),
      save: () => void this.save(),
    }
    this.el.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.onclick = () => act[b.dataset.act!]?.()))
    if (!h.broadcast) q<HTMLButtonElement>("[data-act=broadcast]").title = "Room weather wiring is not connected yet"
    if (!import.meta.env.DEV) q<HTMLButtonElement>("[data-act=save]").hidden = true

    this.tab = {
      id: "weather",
      label: "Weather",
      css,
      mount: (parent) => {
        parent.append(this.el)
        this.shownTab = true
        this.gpu ??= new GpuPerf(this.h.device)
        this.gpu.enabled = true
        this.sync()
      },
      unmount: () => {
        this.el.remove()
        this.shownTab = false
        if (this.gpu) this.gpu.enabled = false
      },
    }
  }

  get visible(): boolean {
    return this.shownTab
  }

  /** Local sea time: the synced time unless paused or sped up (then it runs on its own until SYNC). */
  time(synced: number, dt: number): number {
    if (this.local === null && !this.paused && this.speed === 1) return synced
    this.local ??= synced
    if (!this.paused) this.local += dt * this.speed
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
    if (this.visible && now - this.lastUi > 120) {
      this.lastUi = now
      this.refresh()
    }
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
    this.sync()
  }

  private toTimeline(): void {
    if (this.mode === "manual") this.back = { from: makeWeather(this.h.system.manual ?? this.current()), start: performance.now() }
    this.mode = "timeline"
    this.sync()
  }

  /** Local manual weather: a preset, faded in over `fade` seconds (default: the transition slider). */
  force(kind: WeatherKind, fade = this.transition): void {
    const keep = this.transition
    this.transition = fade
    this.preset(kind)
    this.transition = keep
  }

  private preset(kind: WeatherKind): void {
    this.toManual()
    Object.assign(this.from, this.h.system.manual ?? this.current())
    Object.assign(this.target, WEATHER_PRESETS[kind])
    this.transStart = performance.now()
    this.transDur = this.transition
    this.sync()
  }

  private setParam(key: keyof Weather, v: number): void {
    this.toManual()
    // A slider settles any running transition, then sets its field directly.
    Object.assign(this.from, this.h.system.manual ?? this.target)
    Object.assign(this.target, this.from)
    this.target[key] = v
    this.from[key] = v
    this.transDur = 0
    this.refresh()
  }

  private strike(): void {
    const sys = this.h.system
    sys.forced = { t: this.t, power: 1, bearing: Math.random() * Math.PI * 2, dist: 1200 + Math.random() * 3500, seed: Math.floor(Math.random() * 0xffffff) }
  }

  private broadcast(): void {
    if (!this.h.broadcast) return this.say("Room wiring not connected yet (phase B): the manual weather stays local.")
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
    const text = this.json()
    console.log(`[weather lab] preset:\n${text}`)
    try {
      await navigator.clipboard.writeText(text)
      this.say("Copied (also printed to the console).")
    } catch {
      this.say("Clipboard blocked: printed to the console.")
    }
  }

  private showPaste(on: boolean): void {
    this.paste.hidden = !on
    this.el.querySelector<HTMLElement>("[data-paste-row]")!.hidden = !on
    if (on) {
      this.paste.value = ""
      this.paste.focus()
    }
  }

  private applyPaste(): void {
    try {
      const raw = JSON.parse(this.paste.value) as Record<string, unknown>
      const src = (raw.weather && typeof raw.weather === "object" ? raw.weather : raw) as Record<string, unknown>
      this.toManual()
      const w = makeWeather(this.target)
      let n = 0
      for (const k of WEATHER_KEYS) {
        const v = src[k]
        if (typeof v === "number" && Number.isFinite(v)) {
          w[k] = v
          n++
        }
      }
      clampWeather(w)
      Object.assign(this.from, this.h.system.manual ?? this.target)
      Object.assign(this.target, w)
      this.transStart = performance.now()
      this.transDur = this.transition
      this.showPaste(false)
      this.say(`Applied ${n} fields.`)
      this.sync()
    } catch (e) {
      this.say(`Bad JSON: ${(e as Error).message}`)
    }
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
    this.note.textContent = msg
  }

  /** Mode, preset, speed highlights and slider positions. */
  private sync(): void {
    this.el.classList.toggle("timeline", this.mode === "timeline")
    this.el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === this.mode))
    this.el.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === this.speed))
    const pause = this.el.querySelector<HTMLButtonElement>("[data-act=pause]")!
    pause.textContent = this.paused ? "Resume" : "Pause"
    pause.classList.toggle("on", this.paused)
    this.el.querySelector<HTMLButtonElement>("[data-act=broadcast]")!.disabled = !this.h.broadcast
    this.refresh()
  }

  private refresh(): void {
    const sys = this.h.system
    const w = this.mode === "manual" ? this.target : this.current()
    for (const [key, { input, value, def }] of this.inputs) {
      if ((this.el.getRootNode() as Document | ShadowRoot).activeElement !== input) input.value = String(w[key])
      value.textContent = def.fmt ? def.fmt(w[key], w) : pct(w[key])
    }
    this.status.trans!.textContent = `${this.transition}s`
    this.el.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => {
      const p = WEATHER_PRESETS[b.dataset.preset as WeatherKind]
      b.classList.toggle("on", this.mode === "manual" && WEATHER_KEYS.every((k) => Math.abs(p[k] - this.target[k]) < 1e-6))
    })

    // Room: the synced weather (timeline plus any room override), and the seeded schedule ahead.
    const t = this.t
    const seed = sys.room.seed
    const room = sys.room.at(t, makeWeather())
    const o = sys.room.active(t)
    this.status.room!.textContent = `${kindOf(room)} ${pct(room.rain)}${o ? " · override" : ""}`
    const spans = weatherSchedule(seed, t, 8)
    const next = spans.find((s) => s.start > t)
    this.status.next!.textContent = next ? `${next.kind} in ${clock(next.start - t)}` : "—"
    const cur = this.current()
    this.status.showing!.textContent = `${this.mode === "manual" ? "manual" : this.back ? "returning" : "room"} · ${kindOf(cur)} ${pct(cur.rain)}`
    const win = STRIP_MIN * 60
    this.strip.innerHTML = spans
      .filter((s) => s.end > t && s.start < t + win)
      .map((s) => {
        const a = Math.max(s.start, t)
        const b = Math.min(s.end, t + win)
        return `<div class="${s.kind}" style="width:${((b - a) / win) * 100}%">${b - a > 240 ? s.kind : ""}</div>`
      })
      .join("")

    // Readouts.
    this.status.waves!.textContent = this.crestToTrough()
    this.status.wind!.textContent = `${windKnots(cur).toFixed(0)} kn`
    const ship = this.h.ship?.()
    this.status.ship!.textContent = ship ? `${(ship.pitch * DEG).toFixed(1)}° ${(ship.roll * DEG).toFixed(1)}° ${ship.heave.toFixed(1)}m` : "—"
    this.status.fps!.textContent = `${this.fps.toFixed(0)} fps · ${(1000 / Math.max(1, this.fps)).toFixed(1)} ms`
    const g = this.gpu
    this.status.gpu!.textContent = g?.gpuMs != null ? `${g.gpuMs.toFixed(2)} ms ${g.gpuKind === "timestamp" ? "hw" : "queue"}` : "—"
    this.status.time!.textContent = `${clock(t)}${this.local !== null || this.paused ? ` local${this.paused ? " ⏸" : ` x${this.speed}`}` : ""}`
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
