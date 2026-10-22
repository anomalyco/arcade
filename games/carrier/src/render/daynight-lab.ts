import type { LabControl, LabPanel, LabSettings } from "@arcade/kit/lab-panel"
import { clockText, elevation } from "../../shared/daycycle"
import type { DevSection } from "../dev/dev-panel"
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
/** Clock speeds; ROOM (-1) follows the room's clock instead of a local one. */
const ROOM = -1
const SPEEDS: readonly { value: number; label: string }[] = [
  { value: ROOM, label: "Room clock" },
  { value: 0, label: "Freeze" },
  { value: 1, label: "x1" },
  { value: 10, label: "x10" },
  { value: 60, label: "x60" },
]
const CLOCK = "Clock"
const SHARE = "Share time"

/**
 * TIME, the dev panel's day-night section: what the room shows (clock, sun, moon, key light), a local clock to scrub
 * (0-24 h), presets and a clock speed (local only), and BROADCAST to set the room's clock for everyone (or hand it back
 * to the seeded timeline). The cycle itself runs whether the section is shown or not.
 */
export class TimeLab {
  /** Fade (s) for a broadcast: the room's sky runs forward through the hours in between. */
  readonly settings = { fade: 8 }
  private panel: LabPanel | null = null
  private speed = 0
  private note = ""
  private lastUi = 0

  constructor(private h: TimeLabHost) {}

  get fade(): number {
    return this.settings.fade
  }

  readonly section: DevSection = {
    id: "time",
    tab: "World",
    bind: (panel) => {
      this.panel = panel
      panel.addControls(this.clockSettings(), this.controls())
      panel.addControls(this.settings, [{ key: "time.fade", label: "Broadcast fade", group: SHARE, min: 0, max: 30, step: 1, unit: "s" }], { fade: 8 })
      panel.addControls({}, this.share())
    },
    frame: () => {
      const now = performance.now()
      if (now - this.lastUi < 150) return
      this.lastUi = now
      this.panel?.refresh()
    },
  }

  /** The clock as settings: they mirror the day-night state (derived), and writing one sets the local clock. */
  private clockSettings(): LabSettings {
    const dn = this.h.daynight
    const s: LabSettings = {}
    Object.defineProperty(s, "hour", {
      enumerable: true,
      get: () => dn.sky.hour,
      set: (v) => dn.setManual(Number(v), this.speed),
    })
    Object.defineProperty(s, "clockSpeed", {
      enumerable: true,
      get: () => (dn.manual === null ? ROOM : dn.manualSpeed),
      set: (v) => {
        const speed = Number(v)
        if (speed === ROOM) return dn.setManual(null)
        this.speed = speed
        if (dn.manual === null) dn.setManual(dn.sky.hour, speed)
        dn.manualSpeed = speed
      },
    })
    return s
  }

  private controls(): LabControl[] {
    const dn = this.h.daynight
    const sky = () => dn.sky
    const readout = (key: string, label: string, read: () => string): LabControl => ({ key, label, group: CLOCK, type: "readout", read })
    return [
      readout("time-clock", "Clock", () => `${clockText(sky().hour)} · day ${sky().day}`),
      readout("time-source", "Showing", () =>
        dn.manual !== null ? `local ${dn.manualSpeed ? `x${dn.manualSpeed}` : "frozen"}` : dn.room.active(Number.POSITIVE_INFINITY) ? "room override" : "room timeline",
      ),
      readout("time-sun", "Sun", () => `${dn.sunElevation.toFixed(1)}°`),
      readout("time-moon", "Moon", () => `${elevation(sky().moon).toFixed(1)}° · ${(sky().moonLit * 100).toFixed(0)}% lit`),
      readout("time-key", "Key light", () => (dn.state.moonKey > 0 ? `moon ${(dn.state.moonKey * 100).toFixed(0)}%` : dn.atmosphere.sunIntensity > 0.01 ? "sun" : "twilight")),
      readout("time-night", "Night · lights", () => `${dn.state.night.toFixed(2)} · ${dn.state.lights.toFixed(2)}`),
      { key: "time.hour", label: "Local hour", group: CLOCK, min: 0, max: 24, step: 0.01, unit: "h", derived: true },
      { key: "time-presets", label: "Presets", group: CLOCK, type: "buttons", items: PRESETS.map(([label, hour]) => ({ key: `time-${label}`, label, run: () => dn.setManual(hour, this.speed) })) },
      { key: "time.clockSpeed", label: "Clock speed", group: CLOCK, options: SPEEDS, derived: true },
    ]
  }

  private share(): LabControl[] {
    return [
      {
        key: "time-share",
        label: "Room",
        group: SHARE,
        type: "buttons",
        items: [
          { key: "time-broadcast", label: "Broadcast to room", run: () => this.broadcast(), enabled: () => !!this.h.broadcast },
          { key: "time-auto", label: "Room to timeline", run: () => this.auto(), enabled: () => !!this.h.broadcast },
        ],
      },
      { key: "time-note", label: "Note", group: SHARE, type: "readout", read: () => this.note || "—" },
    ]
  }

  private broadcast(): void {
    const dn = this.h.daynight
    if (!this.h.broadcast) return
    this.h.broadcast(dn.sky.hour, dn.manual === null ? 1 : dn.manualSpeed, this.fade)
    this.note = `Room clock set to ${clockText(dn.sky.hour)}${dn.manualSpeed !== 1 && dn.manual !== null ? ` at x${dn.manualSpeed}` : ""}.`
    dn.setManual(null)
  }

  private auto(): void {
    if (!this.h.broadcast) return
    this.h.broadcast(null, 1, this.fade)
    this.h.daynight.setManual(null)
    this.note = "Room clock back on its seeded timeline."
  }
}
