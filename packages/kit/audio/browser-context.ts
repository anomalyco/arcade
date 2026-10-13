/** Production offline rendering requires the browser's actual Web Audio implementation. */
export function getOfflineAudioContextConstructor(): typeof OfflineAudioContext {
  if (typeof OfflineAudioContext === "undefined") throw new Error("Offline Web Audio is unavailable")
  return OfflineAudioContext
}
