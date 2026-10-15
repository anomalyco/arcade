import { AudioRuntime, DEFAULT_CUES, DEFAULT_SAMPLE_MANIFEST, selectSfx, sfxCues, sfxManifest } from "@arcade/kit/audio"
import { SFX } from "./sfx-ids"

const STORAGE_KEY = "brawl.muted"

/**
 * The game's sound: library samples and the shared synth cues through one `AudioRuntime`, panned around the camera.
 * Silent until the first press (autoplay rules); `M` mutes. Automation starts muted.
 */
export class Sound {
  readonly runtime: AudioRuntime
  private unlocked = false
  /** Plays per id, for proofs. */
  readonly played: Record<string, number> = {}

  constructor() {
    const entries = selectSfx(SFX)
    this.runtime = new AudioRuntime({
      manifest: [...DEFAULT_SAMPLE_MANIFEST, ...sfxManifest(entries)],
      cues: [...DEFAULT_CUES, ...sfxCues(entries)],
      maxVoices: 40,
      reverbWet: 0.12,
      autoBindDom: false,
    })
    const saved = localStorage.getItem(STORAGE_KEY)
    this.runtime.muted = saved === null ? navigator.webdriver : saved === "1"
    const unlock = () => {
      if (this.unlocked) return
      this.unlocked = true
      void this.runtime.unlock()
    }
    for (const type of ["pointerdown", "keydown"]) addEventListener(type, unlock, { capture: true })
  }

  get muted(): boolean {
    return this.runtime.muted
  }

  setMuted(m: boolean): void {
    this.runtime.setMuted(m)
    localStorage.setItem(STORAGE_KEY, m ? "1" : "0")
  }

  /** The listener sits over the camera's focus. */
  listen(x: number, y: number): void {
    this.runtime.setListener({ x, z: y, y: 12 })
  }

  play(id: string, x?: number, y?: number, opts: { gain?: number; rate?: number; intensity?: number } = {}): void {
    this.played[id] = (this.played[id] ?? 0) + 1
    if (!this.runtime.ctx) return
    this.runtime.playCue(id, { ...opts, position: x === undefined ? undefined : { x, z: y ?? 0, y: 0, refDistance: 14, maxDistance: 70 } })
  }
}
