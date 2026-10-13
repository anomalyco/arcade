import { type Mixer, mixer as sharedMixer } from "./mixer"
import { sfx } from "./sfx-bank"

/**
 * Interface sound, minimal on purpose: one very quiet tick when a button is clicked (menus, LAUNCH, the debug menu), at
 * most every 120 ms. Nothing on hover and nothing when a panel opens or closes; the kill confirm is played by
 * weapon-audio.ts. Silent until the "ui" slots load.
 */
export class UiAudio {
  private lastClick = 0

  constructor(
    private mixer: Mixer = sharedMixer(),
    /** Listen to the page (off: scripted renders call the methods). */
    listen = true,
  ) {
    if (!listen || typeof window === "undefined") return
    const button = (e: Event) => (e.composedPath()[0] as Element | undefined)?.closest?.("button, [role=button]") ?? null
    window.addEventListener("click", (e) => button(e) && this.clicked(), true)
  }

  /** A button was clicked. */
  clicked(): void {
    const now = performance.now()
    if (now - this.lastClick < 120) return
    this.lastClick = now
    if (this.mixer.ctx) sfx(this.mixer).play("ui-click", { bus: "ui", gain: 0.35, reverb: 0 })
  }

  /** The pointer moved onto a button: silent (kept so scripted renders can show it). */
  hover(): void {}

  /** A panel opened (E, Tab, `): silent. */
  opened(): void {}
}
