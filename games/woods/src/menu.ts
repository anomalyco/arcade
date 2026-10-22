import { keyCapHtml } from "@arcade/kit/client/key-cap"
import type { QualityMode, QualityTier } from "@arcade/kit/quality"

type Volumes = { volumeMaster: number; volumeEffects: number; volumeAmbience: number }
export type SettingsHost = {
  bank: { readonly volumes: Volumes; readonly muted: boolean; setMuted(muted: boolean): void; applyVolumes(): void }
  /** The chosen mode (the Lab's Quality knob shares it). */
  mode(): QualityMode
  setMode(mode: QualityMode): void
  /** The tier Auto settled on. */
  active(): QualityTier
}

const TIER: Record<QualityTier, string> = { high: "High", balanced: "Balanced", low: "Low" }

/**
 * The volume and graphics block the title screen and the Escape menu share: one element, moved into whichever card
 * shows. It edits the sound bank's saved volumes and the quality mode directly, so the Lab panel and M stay in step.
 */
export class SettingsMenu {
  readonly root = document.getElementById("settings")!
  private sliders: [HTMLInputElement, HTMLOutputElement, keyof Volumes][]
  private mute = document.getElementById("mute") as HTMLButtonElement
  private modes = [...document.querySelectorAll<HTMLButtonElement>("#quality-modes button")]
  private note = document.getElementById("quality-note")!

  constructor(private host: SettingsHost) {
    this.sliders = (["master", "effects", "ambience"] as const).map((k) => {
      const input = document.getElementById(`vol-${k}`) as HTMLInputElement
      const key = `volume${k[0]!.toUpperCase()}${k.slice(1)}` as keyof Volumes
      input.addEventListener("input", () => {
        host.bank.volumes[key] = Number(input.value)
        host.bank.applyVolumes()
        this.sync()
      })
      return [input, input.nextElementSibling as HTMLOutputElement, key]
    })
    this.mute.addEventListener("click", () => { host.bank.setMuted(!host.bank.muted); this.sync() })
    for (const b of this.modes) b.addEventListener("click", () => { host.setMode(b.dataset.mode as QualityMode); this.sync() })
    this.sync()
  }

  /** Into `card` (the title or the Escape menu), and showing current values. */
  mount(card: Element) {
    if (this.root.parentElement !== card) card.append(this.root)
    this.sync()
  }

  sync() {
    const { bank } = this.host
    for (const [input, out, key] of this.sliders) {
      const v = Math.round(bank.volumes[key])
      if (document.activeElement !== input) input.value = String(v)
      out.textContent = String(v)
    }
    this.mute.setAttribute("aria-pressed", String(bank.muted))
    this.mute.innerHTML = `${bank.muted ? "Muted" : "Mute"} ${keyCapHtml("KeyM")}`
    const mode = this.host.mode()
    for (const b of this.modes) b.setAttribute("aria-pressed", String(b.dataset.mode === mode))
    this.note.textContent = mode === "auto" ? `Auto is using ${TIER[this.host.active()]}` : ""
  }
}
