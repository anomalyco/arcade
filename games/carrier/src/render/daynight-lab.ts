import { clockText, elevation } from "../../shared/daycycle"
import type { DebugTab } from "../dev/debug-menu"
import type { DayNight } from "./daynight"

export type TimeLabHost = {
  daynight: DayNight
  /** Sets the room's clock for everyone (hour null: back to the timeline), or null while the room wiring is missing. */
  broadcast: ((hour: number | null, speed: number, fade: number) => void) | null
}

const PRESETS: readonly (readonly [label: string, hour: number])[] = [
  ["Dawn", 5.55],
  ["Sunrise", 6.15],
  ["Noon", 12],
  ["Golden", 17.3],
  ["Sunset", 18.03],
  ["Dusk", 18.4],
  ["Night", 23],
  ["3 am", 3],
]
const SPEEDS: readonly (readonly [label: string, speed: number])[] = [
  ["Freeze", 0],
  ["x1", 1],
  ["x10", 10],
  ["x60", 60],
]

const CSS = /* css */ `
.time-lab .slider { grid-template-columns: 60px 1fr 60px; }
.time-lab .dial { height: 10px; margin: 8px 0 2px; border: 1px solid rgba(255,255,255,0.14); position: relative; }
.time-lab .dial i { position: absolute; top: -3px; bottom: -3px; width: 2px; background: #e8eef4; }
.time-lab .ticks { display: flex; justify-content: space-between; opacity: 0.45; font-size: 9px; letter-spacing: 0.08em; }
.time-lab .note { margin-top: 8px; opacity: 0.55; text-transform: none; letter-spacing: 0.04em; }
`

/**
 * TIME, the debug menu's day-night tab: what the room shows (clock, sun, moon, key light), a local clock to scrub
 * (0-24 h), presets and a clock speed (local only), and BROADCAST to set the room's clock for everyone (or hand it back
 * to the seeded timeline). The cycle itself runs whether the tab is shown or not.
 */
export class TimeLab {
  readonly tab: DebugTab
  /** Fade (s) for a broadcast: the room's sky runs forward through the hours in between. */
  fade = 8
  private el = document.createElement("div")
  private status: Record<string, HTMLElement> = {}
  private slider: HTMLInputElement
  private dial: HTMLElement
  private note: HTMLElement
  private dragging = false
  private lastUi = 0
  private speed = 0

  constructor(private h: TimeLabHost) {
    this.el.className = "time-lab"
    this.el.innerHTML = `
      <div class="status">
        <span class="k">Clock</span><span class="v" data-s="clock"></span>
        <span class="k">Showing</span><span class="v" data-s="source"></span>
        <span class="k">Sun</span><span class="v" data-s="sun"></span>
        <span class="k">Moon</span><span class="v" data-s="moon"></span>
        <span class="k">Key light</span><span class="v" data-s="key"></span>
        <span class="k">Night · lights</span><span class="v" data-s="night"></span>
      </div>
      <div class="dial"><i></i></div>
      <div class="ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
      <h2>Local clock</h2>
      <div class="slider"><span>Hour</span><input type="range" data-hour min="0" max="24" step="0.01"><span class="v" data-s="hour"></span></div>
      <div class="row">${PRESETS.map(([l, h]) => `<button data-preset="${h}">${l}</button>`).join("")}</div>
      <h2>Speed</h2>
      <div class="row">${SPEEDS.map(([l, s]) => `<button data-speed="${s}">${l}</button>`).join("")}<button data-act="room">Room clock</button></div>
      <h2>Share</h2>
      <div class="slider"><span>Fade</span><input type="range" data-fade min="0" max="30" step="1"><span class="v" data-s="fade"></span></div>
      <div class="row"><button data-act="broadcast">Broadcast to room</button><button data-act="auto">Room to timeline</button></div>
      <div class="note"></div>`
    const q = <T extends Element>(sel: string) => this.el.querySelector<T>(sel)!
    this.el.querySelectorAll<HTMLElement>("[data-s]").forEach((e) => (this.status[e.dataset.s!] = e))
    this.slider = q<HTMLInputElement>("[data-hour]")
    this.dial = q(".dial i")
    this.note = q(".note")
    this.slider.oninput = () => {
      this.dragging = true
      h.daynight.setManual(Number(this.slider.value), this.speed)
      this.render(true)
    }
    this.slider.onchange = () => (this.dragging = false)
    const fade = q<HTMLInputElement>("[data-fade]")
    fade.value = String(this.fade)
    fade.oninput = () => {
      this.fade = Number(fade.value)
      this.render(true)
    }
    this.el.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach(
      (b) =>
        (b.onclick = () => {
          h.daynight.setManual(Number(b.dataset.preset), this.speed)
          this.render(true)
        }),
    )
    this.el.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach(
      (b) =>
        (b.onclick = () => {
          this.speed = Number(b.dataset.speed)
          const dn = h.daynight
          if (dn.manual === null) dn.setManual(dn.sky.hour, this.speed)
          dn.manualSpeed = this.speed
          this.render(true)
        }),
    )
    const act: Record<string, () => void> = {
      room: () => {
        h.daynight.setManual(null)
        this.render(true)
      },
      broadcast: () => {
        const dn = h.daynight
        if (!h.broadcast) return this.say("Room time wiring is not connected yet.")
        h.broadcast(dn.sky.hour, dn.manual === null ? 1 : dn.manualSpeed, this.fade)
        this.say(`Room clock set to ${clockText(dn.sky.hour)}${dn.manualSpeed !== 1 && dn.manual !== null ? ` at x${dn.manualSpeed}` : ""}.`)
        dn.setManual(null)
      },
      auto: () => {
        if (!h.broadcast) return this.say("Room time wiring is not connected yet.")
        h.broadcast(null, 1, this.fade)
        h.daynight.setManual(null)
        this.say("Room clock back on its seeded timeline.")
      },
    }
    this.el.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.onclick = () => act[b.dataset.act!]?.()))

    this.tab = {
      id: "time",
      label: "Time",
      css: CSS,
      mount: (parent) => {
        parent.append(this.el)
        this.render(true)
      },
      unmount: () => this.el.remove(),
      frame: () => this.render(false),
    }
  }

  private say(text: string): void {
    this.note.textContent = text
    this.render(true)
  }

  private render(force: boolean): void {
    const now = performance.now()
    if (!force && now - this.lastUi < 150) return
    this.lastUi = now
    const dn = this.h.daynight
    const sky = dn.sky
    const s = this.status
    const local = dn.manual !== null
    s.clock!.textContent = `${clockText(sky.hour)} · day ${sky.day}`
    s.source!.textContent = local ? `local ${dn.manualSpeed ? `x${dn.manualSpeed}` : "frozen"}` : dn.room.active(Number.POSITIVE_INFINITY) ? "room override" : "room timeline"
    s.sun!.textContent = `${dn.sunElevation.toFixed(1)}°`
    s.moon!.textContent = `${elevation(sky.moon).toFixed(1)}° · ${(sky.moonLit * 100).toFixed(0)}% lit`
    s.key!.textContent = dn.state.moonKey > 0 ? `moon ${(dn.state.moonKey * 100).toFixed(0)}%` : dn.atmosphere.sunIntensity > 0.01 ? "sun" : "twilight"
    s.night!.textContent = `${dn.state.night.toFixed(2)} · ${dn.state.lights.toFixed(2)}`
    s.hour!.textContent = clockText(sky.hour)
    s.fade!.textContent = `${this.fade} s`
    if (!this.dragging) this.slider.value = String(sky.hour)
    this.dial.style.left = `calc(${(sky.hour / 24) * 100}% - 1px)`
    const speed = local ? dn.manualSpeed : -1
    this.el.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === speed))
    this.el.querySelector<HTMLButtonElement>("[data-act=room]")!.classList.toggle("on", !local)
    const bc = this.el.querySelector<HTMLButtonElement>("[data-act=broadcast]")!
    bc.title = this.h.broadcast ? "" : "Room time wiring is not connected yet"
  }
}
