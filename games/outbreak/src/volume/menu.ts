import { keyCapHtml } from "@arcade/kit/client/key-cap"
import "./volume.css"

/** The player's sound settings this menu edits: the `@arcade/kit/audio` volumes and mute that `OutbreakAudio` applies and saves each frame. */
export type VolumeTarget = {
  audioMuted: number
  volumeMaster: number
  volumeEffects: number
  volumeAmbience: number
  volumeVoice: number
}

export const VOLUME_ROWS: readonly { key: Exclude<keyof VolumeTarget, "audioMuted">; label: string }[] = [
  { key: "volumeMaster", label: "Master" },
  { key: "volumeEffects", label: "Effects" },
  { key: "volumeAmbience", label: "Ambience" },
  { key: "volumeVoice", label: "Zombies" },
]

/** Sets one channel from a slider (0–100, whole percent); moving any slider above zero unmutes. */
export function setVolume(target: VolumeTarget, key: Exclude<keyof VolumeTarget, "audioMuted">, value: number): void {
  target[key] = Math.max(0, Math.min(100, Math.round(value)))
  if (target[key] > 0) target.audioMuted = 0
}

const SPEAKER = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 9h4l5-4v14l-5-4H4z"/><path class="vm-wave" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"/><path class="vm-cross" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9l5 6M21 9l-5 6"/></svg>`

/**
 * A speaker button in the top-right corner (playtest, Oct 20: "I need to have a volume button too"): click it for
 * Master, Effects, Ambience and Zombies sliders and Mute, the same values as Backquote › Volume, saved per browser.
 * M mutes from anywhere only with Today's map key (Backquote › Controls); by default M is the map. Esc or a click
 * outside closes it.
 */
export class VolumeMenu {
  readonly root: HTMLDivElement
  private readonly button: HTMLButtonElement
  private readonly panel: HTMLDivElement
  private open = false
  private shownKey = ""

  constructor(
    private readonly target: () => VolumeTarget,
    private readonly muteKey: () => boolean = () => true,
    doc: Document = document,
  ) {
    this.root = doc.createElement("div")
    this.root.className = "vm"
    this.root.innerHTML = `<button type="button" class="vm-button" aria-label="Sound" aria-expanded="false">${SPEAKER}</button><div class="vm-panel hud-panel" role="dialog" aria-label="Sound" hidden></div>`
    doc.body.append(this.root)
    this.button = this.root.querySelector(".vm-button")!
    this.panel = this.root.querySelector(".vm-panel")!
    this.panel.innerHTML = `${VOLUME_ROWS.map((r) => `<label class="vm-row"><span>${r.label}</span><input type="range" min="0" max="100" step="5" data-key="${r.key}"><b data-out="${r.key}"></b></label>`).join("")}<label class="vm-row vm-mute"><span>Mute</span><input type="checkbox" data-key="audioMuted"><span class="vm-key">${keyCapHtml("KeyM")}</span></label>`
    this.button.addEventListener("click", () => this.toggle())
    this.panel.addEventListener("input", (e) => {
      const el = e.target as HTMLInputElement
      const key = el.dataset.key as keyof VolumeTarget | undefined
      if (!key) return
      const t = this.target()
      if (key === "audioMuted") t.audioMuted = el.checked ? 1 : 0
      else setVolume(t, key, Number(el.value))
      this.sync(true)
    })
    doc.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && this.open) this.toggle(false)
    })
    doc.addEventListener("pointerdown", (e) => {
      if (this.open && !this.root.contains(e.target as Node)) this.toggle(false)
    })
  }

  get isOpen(): boolean {
    return this.open
  }

  toggle(open = !this.open): void {
    this.open = open
    this.panel.hidden = !open
    this.button.setAttribute("aria-expanded", String(open))
    if (open) this.sync(true)
    else (document.activeElement as HTMLElement | null)?.blur?.()
  }

  /** Call every frame: keeps the icon (and an open panel) in step with M and the Lab. */
  sync(force = false): void {
    const t = this.target()
    const key = `${t.audioMuted}|${t.volumeMaster}|${t.volumeEffects}|${t.volumeAmbience}|${t.volumeVoice}|${this.open}|${this.muteKey()}`
    if (!force && key === this.shownKey) return
    this.shownKey = key
    const silent = Boolean(t.audioMuted) || t.volumeMaster <= 0
    this.root.dataset.muted = String(silent)
    if (!this.open) return
    for (const r of VOLUME_ROWS) {
      const input = this.panel.querySelector<HTMLInputElement>(`input[data-key="${r.key}"]`)!
      if (document.activeElement !== input) input.value = String(t[r.key])
      this.panel.querySelector<HTMLElement>(`[data-out="${r.key}"]`)!.textContent = `${t[r.key]}%`
    }
    this.panel.querySelector<HTMLInputElement>(`input[data-key="audioMuted"]`)!.checked = Boolean(t.audioMuted)
    this.panel.querySelector<HTMLElement>(".vm-key")!.hidden = !this.muteKey()
  }
}
