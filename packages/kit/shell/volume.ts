import type { VolumeChannel } from "../audio/volume"
import type { ShellSettings } from "./settings"
import { SPEAKER_ICON as ICON, installShellStyles, volumeLevel } from "./view"

export { volumeLevel, type ShellVolumeLevel } from "./view"

export type ShellVolumeButtonOptions = {
  /** The channel the slider sets (default master). */
  channel?: VolumeChannel
  /** Whether M mutes, for the tooltip (default true). */
  muteKey?: boolean
}

/**
 * The sanctioned in-HUD volume control (docs/game-shell.md): a speaker icon whose click toggles the shell's mute and
 * whose hover (or keyboard focus) drops a slider for the master volume. It reads and writes the same `ShellSettings`
 * as Settings and M, so the level and mute are saved the same way. It never keeps keyboard focus: a click or a drag
 * gives it straight back, and a key pressed while it has focus leaves it, so the game's keys still work.
 * A game places `root` in a HUD corner; under pointer lock it is out of reach until the pointer is free.
 */
export class ShellVolumeButton {
  readonly root: HTMLDivElement
  private readonly button: HTMLButtonElement
  private readonly slider: HTMLInputElement
  private readonly out: HTMLOutputElement
  private readonly channel: VolumeChannel
  private readonly off: () => void

  constructor(
    parent: HTMLElement,
    private readonly settings: ShellSettings,
    o: ShellVolumeButtonOptions = {},
  ) {
    installShellStyles(parent.ownerDocument)
    this.channel = o.channel ?? "master"
    const doc = parent.ownerDocument
    this.root = doc.createElement("div")
    this.root.className = "arcade-shell as-volume"
    const tip = `Mute${o.muteKey === false ? "" : " (M)"}`
    this.root.innerHTML = `<div class="as-vol-pop"><input type="range" min="0" max="100" step="5" tabindex="-1" aria-label="${settings.labels[this.channel]} volume" /><output></output></div><button class="as-icon as-vol-btn" type="button" tabindex="-1" aria-label="${tip}" title="${tip}">${ICON}</button>`
    this.button = this.root.querySelector("button")!
    this.slider = this.root.querySelector("input")!
    this.out = this.root.querySelector("output")!
    parent.append(this.root)
    // Clicking mustn't focus the button (Space would toggle it again instead of reaching the game).
    this.button.addEventListener("mousedown", (e) => e.preventDefault())
    this.button.addEventListener("click", () => settings.toggleMute())
    this.slider.addEventListener("input", () => {
      settings.setVolume(this.channel, Number(this.slider.value))
      // Master unmutes itself (settings); another channel's slider turned up while muted is asking to hear it too.
      if (this.channel !== "master" && settings.muted && Number(this.slider.value) > 0) settings.setMuted(false)
    })
    const letGo = () => this.slider.blur()
    this.slider.addEventListener("change", letGo)
    this.slider.addEventListener("pointerup", letGo)
    // A key while the slider still has focus (arrows steer, Space fires) goes to the game, not the slider.
    this.root.addEventListener("keydown", (e) => {
      ;(doc.activeElement as HTMLElement | null)?.blur()
      if (e.code.startsWith("Arrow") || e.code === "Space" || e.code.startsWith("Page") || e.code === "Home" || e.code === "End") e.preventDefault()
    })
    // Pointer and mouse events stop here: a click on the control isn't a click on the game (it must not take the lock).
    for (const type of ["pointerdown", "mousedown", "click", "wheel", "contextmenu"] as const) this.root.addEventListener(type, (e) => e.stopPropagation())
    this.off = settings.subscribe(() => this.sync())
    this.sync()
  }

  private sync(): void {
    const s = this.settings
    const v = s.volume(this.channel)
    if (this.slider.ownerDocument.activeElement !== this.slider) this.slider.value = String(v)
    this.out.textContent = s.muted ? "Muted" : `${v}%`
    this.root.dataset.level = volumeLevel(s.muted, v)
    this.button.setAttribute("aria-pressed", String(s.muted))
  }

  dispose(): void {
    this.off()
    this.root.remove()
  }
}

/** Mounts a `ShellVolumeButton` in `parent` (a HUD corner). */
export const mountVolumeControl = (settings: ShellSettings, parent: HTMLElement, o?: ShellVolumeButtonOptions) => new ShellVolumeButton(parent, settings, o)
