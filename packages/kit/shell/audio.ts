import { VOLUME_BUSES } from "../audio/volume"
import type { MixCategory } from "../audio/types"
import type { ShellSettings } from "./settings"

/** The part of `@arcade/kit/audio`'s `AudioRuntime` the shell drives. */
export type ShellAudioRuntime = {
  readonly muted: boolean
  /** The runtime's own M binding; the shell owns M, so the sync turns it off. */
  muteKey?: boolean
  readonly ctx?: unknown
  setMuted(muted: boolean): void
  setVolume(level: number): void
  setBusGain(category: MixCategory, level: number): void
}

/**
 * Keeps an `AudioRuntime` on the shell's settings: mute, master (× the game's designer `master`, default 1) and each
 * channel's buses. Call the returned function once a frame; it only touches the graph when something changed or the
 * context has just started (bus gains need a running context). It turns the runtime's own M off (`muteKey = false`) so
 * M isn't bound twice; keep `autoBindDom` on, which also unlocks audio on the first gesture.
 */
export function audioRuntimeSync(settings: ShellSettings, runtime: ShellAudioRuntime, master = 1): () => void {
  if ("muteKey" in runtime) runtime.muteKey = false
  let shown = ""
  return () => {
    const key = `${settings.muted}|${JSON.stringify(settings.volumes)}|${Boolean(runtime.ctx)}`
    if (key === shown) return
    shown = key
    if (runtime.muted !== settings.muted) runtime.setMuted(settings.muted)
    runtime.setVolume((master * settings.volume("master")) / 100)
    for (const channel of ["effects", "ambience", "voice", "music"] as const)
      for (const bus of VOLUME_BUSES[channel]) runtime.setBusGain(bus, settings.volume(channel) / 100)
  }
}
