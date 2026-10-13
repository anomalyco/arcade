import type { DebugTab } from "../dev/debug-menu"
import type { JetAudio } from "./jet-audio"
import { JET_TUNE } from "./jet-audio"
import { BOOM_KINDS, type BoomKind } from "./jet-boom"
import { sfx } from "./sfx-bank"
import { COCKPIT_TUNE } from "./jet-cockpit"
import { ENGINE_TUNE } from "./jet-engine"
import { DEFAULT_LEVELS, type Level } from "./mixer"

const LEVELS: readonly (readonly [Level, string])[] = [
  ["master", "Master"],
  ["engines", "Engines"],
  ["flyby", "Flybys"],
  ["sfx", "Jet sfx"],
  ["weapons", "Weapons"],
  ["weather", "Weather & sea"],
  ["ui", "Interface"],
]

/** Live tuning knobs: [object, key, label, min, max]. */
const KNOBS: readonly (readonly [Record<string, number>, string, string, number, number])[] = [
  [JET_TUNE, "doppler", "Doppler", 0, 1],
  [JET_TUNE, "flybyDuck", "Pass duck", 0, 1],
  [ENGINE_TUNE, "whine", "Whine", 0, 2],
  [ENGINE_TUNE, "roar", "Roar", 0, 2],
  [ENGINE_TUNE, "burner", "Afterburner", 0, 2],
  [COCKPIT_TUNE, "wind", "Wind", 0, 2],
  [COCKPIT_TUNE, "breath", "Breathing", 0, 2],
  [COCKPIT_TUNE, "bed", "Cockpit bed", 0, 2],
]

const CSS = /* css */ `
.audio-lab .meter { height: 4px; margin: 8px 0 2px; background: rgba(255,255,255,0.1); position: relative; }
.audio-lab .meter i { position: absolute; left: 0; top: 0; bottom: 0; background: #e8eef4; }
.audio-lab .meter i.hot { background: #ff8a6a; }
.audio-lab .note { margin-top: 8px; opacity: 0.55; text-transform: none; letter-spacing: 0.04em; }
`

/**
 * AUDIO, the debug menu's sound tab: bus levels (persisted, like M for mute), live tuning of the jet engines, flybys and
 * cockpit, test buttons that fly a jet past the camera or fire the catapult, trap and crash sounds, and readouts (voices,
 * passes, loaded takes, output peak).
 */
export class MixerLab {
  readonly tab: DebugTab
  private el = document.createElement("div")
  private status: Record<string, HTMLElement> = {}
  private meter: HTMLElement
  private hold = 0
  private lastUi = 0
  private far = false

  constructor(private jets: JetAudio) {
    const mixer = jets.mixer
    this.el.className = "audio-lab"
    const slider = (key: string, label: string, min: number, max: number, step = 0.01) =>
      `<div class="slider"><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}"><span class="v" data-v="${key}"></span></div>`
    this.el.innerHTML = `
      <div class="status">
        <span class="k">Context</span><span class="v" data-s="ctx"></span>
        <span class="k">Engines · passes · jets</span><span class="v" data-s="voices"></span>
        <span class="k">Recorded takes loaded</span><span class="v" data-s="takes"></span>
        <span class="k">Peak</span><span class="v" data-s="peak"></span>
      </div>
      <div class="meter"><i></i></div>
      <h2>Levels</h2>
      ${LEVELS.map(([k, l]) => slider(`level:${k}`, l, 0, 1.5)).join("")}
      <div class="row"><button data-act="mute">Mute (M)</button><button data-act="reset">Reset levels</button></div>
      <h2>Tuning</h2>
      ${KNOBS.map(([, k, l, a, b]) => slider(`tune:${k}`, l, a, b)).join("")}
      <div class="row"><button data-act="samples">Recorded sounds on</button></div>
      <h2>Test</h2>
      <div class="row"><button data-test="flyby">Flyby</button><button data-test="flyby-ab">Burner pass</button><button data-test="boom">Crack</button></div>
      <div class="row"><button data-test="catapult">Catapult</button><button data-test="trap">Trap</button><button data-test="gear-up">Gear</button><button data-test="crash">Crash</button></div>
      <h2>Explosions</h2>
      <div class="row">${BOOM_KINDS.map((k) => `<button data-boom="${k}">${k.replace("-", " ")}</button>`).join("")}</div>
      <div class="row"><button data-act="far">Far (2.5 km)</button></div>
      <div class="note">Flybys go 40 m past the camera at 210-250 m/s. Recorded sounds come from the SOUNDS tab's picks; switch them off to hear the procedural placeholders.</div>`
    this.el.querySelectorAll<HTMLElement>("[data-s]").forEach((e) => (this.status[e.dataset.s!] = e))
    this.meter = this.el.querySelector(".meter i")!
    const knob = (key: string) => KNOBS.find(([, k]) => `tune:${k}` === key)
    const value = (key: string): number => {
      if (key.startsWith("level:")) return mixer.levels[key.slice(6) as Level]
      const k = knob(key)
      return k ? k[0][k[1]]! : 0
    }
    const show = () => {
      this.el.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((i) => {
        const k = i.dataset.k!
        i.value = String(value(k))
        this.el.querySelector(`[data-v="${k}"]`)!.textContent = value(k).toFixed(2)
      })
      this.el.querySelector<HTMLButtonElement>('[data-act="mute"]')!.classList.toggle("on", mixer.muted)
      const s = this.el.querySelector<HTMLButtonElement>('[data-act="samples"]')!
      s.classList.toggle("on", mixer.samplesOn)
      s.textContent = mixer.samplesOn ? "Recorded sounds on" : "Procedural placeholders only"
      this.el.querySelector<HTMLButtonElement>('[data-act="far"]')!.classList.toggle("on", this.far)
    }
    this.el.addEventListener("input", (e) => {
      const i = e.target as HTMLInputElement
      const k = i.dataset.k
      if (!k) return
      const v = Number(i.value)
      if (k.startsWith("level:")) mixer.setLevel(k.slice(6) as Level, v)
      else {
        const kb = knob(k)
        if (kb) kb[0][kb[1]] = v
      }
      this.el.querySelector(`[data-v="${k}"]`)!.textContent = v.toFixed(2)
    })
    this.el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button")
      if (!b) return
      mixer.start()
      const act = b.dataset.act
      if (act === "mute") mixer.setMuted(!mixer.muted)
      if (act === "reset") for (const [k] of LEVELS) mixer.setLevel(k, DEFAULT_LEVELS[k])
      if (act === "far") this.far = !this.far
      if (b.dataset.boom) jets.testBoom(b.dataset.boom as BoomKind, this.far)
      if (act === "samples") {
        mixer.samplesOn = !mixer.samplesOn
      }
      const t = b.dataset.test
      if (t === "flyby") jets.testFlyby(false)
      if (t === "flyby-ab") jets.testFlyby(true)
      if (t === "boom") jets.sfx.boom(0.9, { at: { x: 20, y: 10, z: -30 } })
      if (t === "catapult") jets.testLaunch()
      if (t === "trap" || t === "gear-up" || t === "crash") jets.testEvent(t)
      show()
    })
    show()
    this.tab = { id: "audio", label: "Audio", css: CSS, mount: (el) => (el.append(this.el), show()), frame: () => this.frame() }
  }

  private frame(): void {
    const m = this.jets.mixer
    const peak = m.peak()
    this.hold = Math.max(peak, this.hold * 0.95)
    this.meter.style.width = `${Math.min(100, this.hold * 100)}%`
    this.meter.classList.toggle("hot", this.hold > 0.95)
    const now = performance.now()
    if (now - this.lastUi < 200) return
    this.lastUi = now
    const s = this.jets.stats
    this.status.ctx!.textContent = m.ctx ? `${m.ctx.state} ${m.ctx.sampleRate / 1000} kHz${m.muted ? " · MUTED" : ""}` : "waiting for a click"
    this.status.voices!.textContent = `${s.voices} · ${s.flybys} · ${s.jets}`
    this.status.takes!.textContent = `${sfx(m).loaded}`
    this.status.peak!.textContent = `${(20 * Math.log10(this.hold + 1e-6)).toFixed(1)} dBFS`
  }
}
