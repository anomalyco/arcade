import { expect, test } from "bun:test"
import type { OutbreakAudio } from "../src/audio"
import { WeatherAudio } from "../src/weather/audio"
import { OutbreakWeatherController } from "../src/weather/controller"
import { DEFAULT_OUTBREAK_WEATHER } from "../src/weather/settings"

test("a new session stops the old rain beds and starts as dry as a fresh weather mixer", () => {
  const played: string[] = []
  const stopped: string[] = []
  const audio = {
    live: true,
    indoorLevel: 0,
    runtime: {
      playCue(id: string) {
        played.push(id)
        return { active: true, setParams() {}, stop() { stopped.push(id) } }
      },
    },
    play() {},
  } as unknown as OutbreakAudio
  const weather = new OutbreakWeatherController()
  weather.shared.intensity = 1
  const mixer = new WeatherAudio()
  const listener = { x: 0, y: 0 }
  mixer.update(audio, 1, listener, weather, DEFAULT_OUTBREAK_WEATHER)
  expect(played).toEqual(["ambience.rain.light", "ambience.rain.heavy"])

  mixer.reset()
  expect(stopped).toEqual(played)
  weather.shared.intensity = 0
  played.length = 0
  mixer.update(audio, 1 / 60, listener, weather, DEFAULT_OUTBREAK_WEATHER)
  const fresh = new WeatherAudio()
  fresh.update(audio, 1 / 60, listener, weather, DEFAULT_OUTBREAK_WEATHER)
  expect(mixer.telemetry()).toEqual(fresh.telemetry())
  expect(played).toEqual([])
})
