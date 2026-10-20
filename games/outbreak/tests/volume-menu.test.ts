import { expect, test } from "bun:test"
import { DEFAULT_AUDIO_SETTINGS } from "../src/audio/settings"
import { setVolume, VOLUME_ROWS, type VolumeTarget } from "../src/volume/menu"

// Playtest (Oct 20): "I need to have a volume button too."
test("the volume menu edits the audio settings the game saves, and a raised slider unmutes", () => {
  const audio: VolumeTarget = { ...DEFAULT_AUDIO_SETTINGS }
  for (const row of VOLUME_ROWS) expect(typeof audio[row.key]).toBe("number")
  audio.audioMuted = 1
  setVolume(audio, "volumeAmbience", 0)
  expect(audio).toMatchObject({ volumeAmbience: 0, audioMuted: 1 })
  setVolume(audio, "volumeVoice", 142.6)
  expect(audio).toMatchObject({ volumeVoice: 100, audioMuted: 0 })
  setVolume(audio, "volumeMaster", -3)
  expect(audio.volumeMaster).toBe(0)
})
