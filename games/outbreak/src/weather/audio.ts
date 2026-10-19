import { sfxEntry, type VoiceHandle } from "@arcade/kit/audio"
import type { OutbreakAudio } from "../audio"
import { thunderDelay } from "../../shared/weather/lightning"
import type { OutbreakWeatherController } from "./controller"
import type { OutbreakWeatherSettings } from "./settings"

const BEDS = ["ambience.rain.light", "ambience.rain.heavy", "ambience.rain.roof"] as const
type Bed = (typeof BEDS)[number]

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * The weather's sound (AR-71): a rain bed that follows the rainfall (light patter into a heavy downpour), heard through
 * the walls indoors with rain drumming on the roof over you instead, and thunder after each strike, late by its
 * distance over the speed of sound: a sharp crack for a near strike, a long roll for a far one. Plays through the
 * game's one `AudioRuntime`, so it obeys mute, the volume sliders and the voice cap.
 */
export class WeatherAudio {
  private beds: Partial<Record<Bed, VoiceHandle>> = {}
  private levels: Record<Bed, number> = { "ambience.rain.light": 0, "ambience.rain.heavy": 0, "ambience.rain.roof": 0 }
  /** Thunder played, for proofs. */
  thunder = 0

  update(
    audio: OutbreakAudio,
    dt: number,
    listener: { x: number; y: number },
    weather: OutbreakWeatherController,
    settings: Readonly<OutbreakWeatherSettings>,
  ): void {
    const live = audio.live
    const indoor = audio.indoorLevel
    const rain = Math.min(1, weather.shared.intensity * (1 + 0.3 * weather.sample.storm))
    const outside = 1 - indoor * 0.78
    const wanted: Record<Bed, number> = {
      "ambience.rain.light": smoothstep(0.02, 0.35, rain) * (1 - 0.55 * smoothstep(0.55, 1, rain)) * outside,
      "ambience.rain.heavy": smoothstep(0.4, 1, rain) * outside,
      "ambience.rain.roof": smoothstep(0.05, 0.6, rain) * indoor,
    }
    const cutoff = 14000 * Math.pow(800 / 14000, indoor)
    const ease = Math.min(1, dt * 1.2)
    for (const bed of BEDS) {
      this.levels[bed] += (wanted[bed] - this.levels[bed]) * ease
      const gain = this.levels[bed] * sfxEntry(bed).gain
      const voice = this.beds[bed]
      if (!live) {
        if (voice) delete this.beds[bed]
        continue
      }
      const bedCutoff = bed === "ambience.rain.roof" ? 3200 : cutoff
      if (voice?.active) {
        if (gain < 0.003 && wanted[bed] < 0.005) {
          voice.stop(0.6)
          delete this.beds[bed]
        } else {
          voice.setParams({ gain, cutoffHz: bedCutoff }, 0.25)
        }
      } else if (gain > 0.01) {
        const started = audio.runtime.playCue(bed, { gain: Math.max(0.01, gain), cutoffHz: bedCutoff, ownerKey: bed })
        if (started) this.beds[bed] = started
      }
    }
    if (!live) return
    for (const k of weather.strikes) {
      const near = k.dist < 450
      const id = near ? "weather.thunder.crack" : "weather.thunder.roll"
      // Heard from the strike's side; the level falls off with distance on its own curve, not the entry's range.
      const level = near ? 1 - 0.35 * (k.dist / 450) : Math.max(0.28, 0.95 - (k.dist - 450) / 3200)
      audio.play({
        id,
        x: listener.x + Math.cos(k.bearing) * 18,
        y: listener.y + Math.sin(k.bearing) * 18,
        delay: thunderDelay(k.dist, settings.weatherThunderDelay),
        gain: level * k.power,
        rate: near ? 1 : 0.92 + 0.12 * k.power,
        cutoffHz: (near ? 16000 : 5200) * Math.pow(900 / 16000, indoor * 0.7),
        source: "weather",
      })
      this.thunder++
    }
  }

  silence(): void {
    this.beds = {}
  }

  telemetry() {
    return { thunder: this.thunder, beds: Object.fromEntries(Object.entries(this.levels).map(([k, v]) => [k, Math.round(v * 100) / 100])) }
  }
}
