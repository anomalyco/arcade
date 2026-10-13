import { type Mixer, mixer as sharedMixer } from "./mixer"
import { sfx } from "./sfx-bank"

/**
 * Sparse, quiet interface sounds from the sound bank, with no wiring in the menus: a click on any button (menus, the
 * debug menu, the load screen), a barely-there tick when the pointer moves onto one, and a soft open when E (ship
 * operations), Tab (players) or ` (debug) opens a panel. The kill confirm and the landing-capture cue are played by
 * weapon-audio.ts and jet-audio.ts. Silent until the "ui" slots load.
 */
export class UiAudio {
  private lastHover = 0
  private lastClick = 0
  private hovered: Element | null = null

  constructor(private mixer: Mixer = sharedMixer()) {
    if (typeof window === "undefined") return
    const target = (e: Event) => (e.composedPath()[0] as Element | undefined)?.closest?.("button, [role=button]") ?? null
    window.addEventListener(
      "click",
      (e) => {
        if (!target(e)) return
        const now = performance.now()
        if (now - this.lastClick < 40) return
        this.lastClick = now
        this.play("ui-click", 0.9)
      },
      true,
    )
    window.addEventListener(
      "pointerover",
      (e) => {
        const b = target(e)
        if (!b || b === this.hovered) return
        this.hovered = b
        const now = performance.now()
        if (now - this.lastHover < 90) return
        this.lastHover = now
        this.play("ui-hover", 0.45)
      },
      true,
    )
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
        if (e.code === "KeyE" || e.code === "Tab" || e.code === "Backquote" || e.code === "F2") this.play("ui-open", 0.7)
      },
      true,
    )
  }

  play(slot: string, gain = 1): void {
    if (!this.mixer.ctx) return
    sfx(this.mixer).play(slot, { bus: "ui", gain, reverb: 0 })
  }
}
