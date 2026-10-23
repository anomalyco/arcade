import type { LabControl, LabPanel, LabSettings } from "@arcade/kit/lab-panel"
import type { DevSection } from "../dev/dev-panel"
import type { JetAudio } from "./jet-audio"
import { JET_TUNE } from "./jet-audio"
import { BOOM_KINDS } from "./jet-boom"
import { COCKPIT_TUNE } from "./jet-cockpit"
import { ENGINE_TUNE } from "./jet-engine"
import { DEFAULT_LEVELS, type Level } from "./mixer"
import { sfx } from "./sfx-bank"

const LEVELS: readonly (readonly [Level, string])[] = [
  ["master", "Master"],
  ["engines", "Engines"],
  ["flyby", "Flybys"],
  ["sfx", "Jet sfx"],
  ["weapons", "Weapons"],
  ["weather", "Weather & sea"],
  ["ui", "Interface"],
  ["radio", "Radio chatter"],
]

/** Live tuning: [object, field, label, max]. Every value is a gain multiplier (0 silences it), read each frame. */
const TUNING: readonly (readonly [Record<string, number>, string, string, number])[] = [
  [JET_TUNE, "doppler", "Doppler", 1],
  [JET_TUNE, "flybyDuck", "Pass duck", 1],
  [ENGINE_TUNE, "whine", "Whine", 2],
  [ENGINE_TUNE, "roar", "Roar", 2],
  [ENGINE_TUNE, "burner", "Afterburner", 2],
  [COCKPIT_TUNE, "wind", "Wind", 2],
  [COCKPIT_TUNE, "breath", "Breathing", 2],
  [COCKPIT_TUNE, "bed", "Cockpit bed", 2],
]

const STATUS = "Audio"
const LEVELS_GROUP = "Levels"
const TUNE_GROUP = "Jet tuning"
const TEST_GROUP = "Test sounds"

/**
 * AUDIO, the dev panel's mix section: bus levels (persisted, like M for mute), live tuning of the jet engines, flybys and
 * cockpit, test buttons that fly a jet past the camera or fire the catapult, trap, crash and explosion sounds (each an
 * explicit audition; flybys pass 40 m from the camera at 210-250 m/s, recorded sounds are the Sounds tab's picks), and readouts (context, voices, passes, loaded takes, output peak).
 */
export class MixerLab {
  /** Explosion tests at 2.5 km instead of close by. */
  readonly settings = { far: false }
  private hold = 0
  private panel: LabPanel | null = null
  private lastUi = 0

  constructor(private jets: JetAudio) {}

  readonly section: DevSection = {
    id: "audio",
    tab: "Audio",
    bind: (panel) => {
      this.panel = panel
      panel.addControls({}, this.readouts())
      panel.addControls(this.mixSettings(), this.mixControls(), this.mixDefaults())
      for (const [obj, field, label, max] of TUNING) {
        const defaults = { [field]: obj[field]! }
        panel.addControls(obj, [{ key: `tune.${field}`, field, label, group: TUNE_GROUP, min: 0, max, step: 0.01, unit: "×" }], defaults)
      }
      panel.addControls(this.settings, this.tests(), { far: false })
    },
    frame: () => {
      this.hold = Math.max(this.jets.mixer.peak(), this.hold * 0.95)
      const now = performance.now()
      if (now - this.lastUi < 200) return
      this.lastUi = now
      this.panel?.refresh()
    },
  }

  /** Levels and recorded samples as settings over the mixer (which persists the levels itself; Mute is on the Game tab). */
  private mixSettings(): LabSettings {
    const m = this.jets.mixer
    const s: LabSettings = {}
    for (const [level] of LEVELS) Object.defineProperty(s, level, { enumerable: true, get: () => m.levels[level], set: (v) => m.setLevel(level, Number(v)) })
    Object.defineProperty(s, "samplesOn", { enumerable: true, get: () => m.samplesOn, set: (v) => (m.samplesOn = !!v) })
    return s
  }

  private mixDefaults(): LabSettings {
    return { ...DEFAULT_LEVELS, samplesOn: true }
  }

  private mixControls(): LabControl[] {
    return [
      ...LEVELS.map(([level, label]): LabControl => ({ key: `level.${level}`, field: level, label, group: LEVELS_GROUP, min: 0, max: 1.5, step: 0.01, unit: "×" })),
      { key: "level.samplesOn", field: "samplesOn", label: "Recorded sounds (off: procedural placeholders)", group: LEVELS_GROUP },
    ]
  }

  private readouts(): LabControl[] {
    const m = this.jets.mixer
    return [
      { key: "audio-ctx", label: "Context", group: STATUS, type: "readout", read: () => (m.ctx ? `${m.ctx.state} ${m.ctx.sampleRate / 1000} kHz${m.muted ? " · MUTED" : ""}` : "waiting for a click") },
      { key: "audio-voices", label: "Engines · passes · jets", group: STATUS, type: "readout", read: () => `${this.jets.stats.voices} · ${this.jets.stats.flybys} · ${this.jets.stats.jets}` },
      { key: "audio-takes", label: "Recorded takes loaded", group: STATUS, type: "readout", read: () => sfx(m).loaded },
      { key: "audio-peak", label: "Peak", group: STATUS, type: "readout", display: "meter", scale: { min: 0, max: 1, warn: 0.8, critical: 0.95 }, hz: 15, read: () => Math.min(1, this.hold) },
      { key: "audio-peak-db", label: "Peak level", group: STATUS, type: "readout", read: () => `${(20 * Math.log10(this.hold + 1e-6)).toFixed(1)} dBFS` },
    ]
  }

  private tests(): LabControl[] {
    const jets = this.jets
    const play = (run: () => void) => () => {
      jets.mixer.start()
      run()
    }
    return [
      {
        key: "audio-test-flight",
        label: "Flight",
        group: TEST_GROUP,
        type: "buttons",
        items: [
          { key: "audio-flyby", label: "Flyby", run: play(() => jets.testFlyby(false)) },
          { key: "audio-flyby-ab", label: "Burner pass", run: play(() => jets.testFlyby(true)) },
          { key: "audio-boom", label: "Crack", run: play(() => jets.sfx.boom(0.9, { at: { x: 20, y: 10, z: -30 } })) },
        ],
      },
      {
        key: "audio-test-deck",
        label: "Deck",
        group: TEST_GROUP,
        type: "buttons",
        items: [
          { key: "audio-catapult", label: "Catapult", run: play(() => jets.testLaunch()) },
          { key: "audio-trap", label: "Trap", run: play(() => jets.testEvent("trap")) },
          { key: "audio-crash", label: "Crash", run: play(() => jets.testEvent("crash")) },
        ],
      },
      {
        key: "audio-test-booms",
        label: "Explosions",
        group: TEST_GROUP,
        type: "buttons",
        items: BOOM_KINDS.map((k) => ({ key: `audio-boom-${k}`, label: k.replace("-", " "), run: play(() => jets.testBoom(k, this.settings.far)) })),
      },
      { key: "audio.far", field: "far", label: "Explosions far away (2.5 km)", group: TEST_GROUP },
    ]
  }
}
