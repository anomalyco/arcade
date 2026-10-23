import { keyPromptHtml } from "../client/key-cap"
import { isTextEntry } from "../shell/flow"
import type { VoiceChat } from "./client"

/** Defaults are free in BARBARA. Other adopters choose bindings against their own gameplay inventory. */
export const VOICE_KEYS = { radio: "KeyV", proximity: "KeyB", mute: "KeyN" } as const

export function voicePrompts(voice: VoiceChat): string {
  if (!voice.enabled) return ""
  return [keyPromptHtml(VOICE_KEYS.radio, "Walkie-talkie", { hold: true, progress: voice.transmitting ? 1 : 0 }),
    voice.mode === "push" ? keyPromptHtml(VOICE_KEYS.proximity, "Talk nearby", { hold: true }) : "",
    keyPromptHtml(VOICE_KEYS.mute, voice.micMuted ? "Mic muted" : "Mute mic")].join(" ")
}

export function bindVoiceKeys(voice: VoiceChat, blocked: () => boolean, keys: { radio: string; proximity: string; mute: string } = VOICE_KEYS): () => void {
  const abort = new AbortController(), signal = abort.signal
  const release = () => voice.release()
  window.addEventListener("keydown", (e) => {
    if (!voice.enabled) return
    if (e.metaKey || e.ctrlKey || e.altKey || blocked() || isTextEntry(e.target)) { release(); return }
    if (e.code === keys.mute && !e.repeat) voice.toggleMic()
    if (e.code === keys.radio) voice.hold("radio", true)
    if (e.code === keys.proximity) voice.hold("proximity", true)
  }, { signal })
  window.addEventListener("keyup", (e) => {
    if (e.code === keys.radio) voice.hold("radio", false)
    if (e.code === keys.proximity) voice.hold("proximity", false)
    if (e.code === "MetaLeft" || e.code === "MetaRight") release()
  }, { signal })
  window.addEventListener("blur", release, { signal })
  document.addEventListener("visibilitychange", () => { if (document.hidden) release() }, { signal })
  return () => { release(); abort.abort() }
}
